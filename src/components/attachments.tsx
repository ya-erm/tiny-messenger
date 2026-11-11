"use client";

import { useEffect, useRef, useState } from "react";
import { formatFileSize, type AttachmentInfo, type AttachmentLimits } from "@/lib/attachment-types";

export type AttachmentRequest = <T>(path: string, init?: RequestInit) => Promise<T>;
type Upload = { url: string; headers: Record<string, string>; expiresAt: string };
type DraftFile = { localId: string; file: File; requestId: string; id?: string; uploaded?: boolean; progress: number; state: "uploading" | "ready" | "error"; error?: string };
type Job = { item: DraftFile; canceled: boolean; xhr?: XMLHttpRequest };

export function useAttachmentDraft(chat: { kind: "peer" | "group"; id: string }, request: AttachmentRequest) {
  const [files, setFiles] = useState<DraftFile[]>([]);
  const jobs = useRef(new Map<string, Job>());
  const scope = `${chat.kind}:${chat.id}`;
  useEffect(() => {
    const current = jobs.current;
    setFiles([]);
    return () => {
      for (const job of current.values()) {
        job.canceled = true; job.xhr?.abort();
        if (job.item.id) void request(`/api/attachments/uploads/${job.item.id}`, { method: "DELETE" }).catch(() => {});
      }
      current.clear();
    };
  }, [scope, request]);

  function update(job: Job, patch: Partial<DraftFile>) {
    Object.assign(job.item, patch);
    if (!job.canceled) setFiles((old) => old.map((item) => item.localId === job.item.localId ? { ...job.item } : item));
  }
  async function run(job: Job) {
    update(job, { state: "uploading", error: undefined });
    try {
      if (!job.item.uploaded) {
        const response = await request<{ attachment: AttachmentInfo; upload: Upload | null }>("/api/attachments/uploads", {
          method: "POST", body: JSON.stringify({ chatKind: chat.kind, chatId: chat.id, name: job.item.file.name, size: job.item.file.size, contentType: job.item.file.type, clientRequestId: job.item.requestId }),
        });
        job.item.id = response.attachment.id;
        if (job.canceled) {
          void request(`/api/attachments/uploads/${job.item.id}`, { method: "DELETE" }).catch(() => {});
          return;
        }
        if (response.upload) {
          await new Promise<void>((resolve, reject) => {
            const xhr = new XMLHttpRequest(); job.xhr = xhr;
            // This is a separate S3 origin. Never use the authenticated TM
            // request helper or add its Authorization header here.
            xhr.open("PUT", response.upload!.url);
            xhr.timeout = Math.max(1000, Date.parse(response.upload!.expiresAt) - Date.now());
            for (const [name, value] of Object.entries(response.upload!.headers)) xhr.setRequestHeader(name, value);
            xhr.upload.onprogress = (event) => { if (event.lengthComputable) update(job, { progress: Math.round(event.loaded / Math.max(1, event.total) * 100) }); };
            xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error("Хранилище отклонило загрузку. Повторите попытку."));
            xhr.onerror = () => reject(new Error("Не удалось загрузить файл. Проверьте соединение."));
            xhr.ontimeout = () => reject(new Error("Время загрузки истекло. Выберите файл заново."));
            xhr.onabort = () => reject(new Error("Загрузка отменена"));
            xhr.send(job.item.file);
          });
        }
        job.item.uploaded = true;
      }
      if (job.canceled) return;
      await request(`/api/attachments/uploads/${job.item.id}/complete`, { method: "POST" });
      update(job, { state: "ready", progress: 100 });
    } catch (error) { update(job, { state: "error", error: (error as Error).message }); }
    finally { job.xhr = undefined; }
  }
  function add(selected: File[], maximum: number) {
    const free = Math.max(0, maximum - jobs.current.size);
    for (const file of selected.slice(0, free)) {
      const item: DraftFile = { localId: crypto.randomUUID(), requestId: crypto.randomUUID(), file, progress: 0, state: "uploading" };
      const job: Job = { item, canceled: false };
      jobs.current.set(item.localId, job);
      setFiles((old) => [...old, item]);
      void run(job);
    }
  }
  function remove(localId: string) {
    const job = jobs.current.get(localId);
    if (!job) return;
    job.canceled = true; job.xhr?.abort();
    if (job.item.id) void request(`/api/attachments/uploads/${job.item.id}`, { method: "DELETE" }).catch(() => {});
    jobs.current.delete(localId);
    setFiles((old) => old.filter((item) => item.localId !== localId));
  }
  async function retry(localId: string) {
    const job = jobs.current.get(localId);
    if (!job || job.item.state !== "error") return;
    update(job, { state: "uploading" });
    // A successful PUT followed by an API/network failure retries only
    // complete; its idempotency also recovers a lost complete response.
    if (!job.item.uploaded && job.item.id) {
      try { await request(`/api/attachments/uploads/${job.item.id}`, { method: "DELETE" }); }
      catch (error) { update(job, { state: "error", error: (error as Error).message }); return; }
      job.item.id = undefined; job.item.requestId = crypto.randomUUID();
    }
    if (job.canceled) return;
    void run(job);
  }
  function clearSent() { jobs.current.clear(); setFiles([]); }
  return { files, add, remove, retry, clearSent, ids: files.filter((item) => item.state === "ready" && item.id).map((item) => item.id!), blocked: files.some((item) => item.state !== "ready") };
}

export function AttachmentPicker({ draft, limits, disabled }: { draft: ReturnType<typeof useAttachmentDraft>; limits: AttachmentLimits | null; disabled: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  if (!limits?.enabled) return null;
  return <div className="attachment-picker">
    <div className="attachment-picker-heading"><button type="button" className="attachment-add" disabled={disabled || draft.files.length >= limits.maxFilesPerMessage} onClick={() => input.current?.click()}>＋ Файл</button><small>До {formatFileSize(limits.maxFileBytes)} · {limits.maxFilesPerMessage} файла</small></div>
    <input ref={input} type="file" multiple hidden aria-label="Выбрать файлы" onChange={(event) => {
      const selected = Array.from(event.target.files || []);
      event.target.value = "";
      if (selected.some((file) => file.size > limits.maxFileBytes)) { setError(`Файл превышает ${formatFileSize(limits.maxFileBytes)}`); return; }
      if (selected.length + draft.files.length > limits.maxFilesPerMessage) { setError(`Можно прикрепить до ${limits.maxFilesPerMessage} файлов`); return; }
      setError(""); draft.add(selected, limits.maxFilesPerMessage);
    }} />
    {error ? <p className="attachment-error" role="alert">{error}</p> : null}
    {draft.files.map((item) => <div className="attachment-draft" key={item.localId}>
      <div className="attachment-copy"><strong title={item.file.name}>{item.file.name}</strong><small>{formatFileSize(item.file.size)} · {item.state === "ready" ? "Готов к отправке" : item.state === "error" ? item.error : item.progress === 100 ? "Проверяем файл…" : `Загрузка ${item.progress}%`}</small>{item.state === "uploading" ? <progress value={item.progress} max={100} aria-label={`Загрузка ${item.file.name}`} /> : null}</div>
      {item.state === "error" ? <button type="button" disabled={disabled} onClick={() => void draft.retry(item.localId)}>Повторить</button> : null}
      <button type="button" disabled={disabled} onClick={() => draft.remove(item.localId)} aria-label={`Убрать ${item.file.name}`}>×</button>
    </div>)}
  </div>;
}

export function AttachmentCard({ file, request, disabled }: { file: AttachmentInfo; request: AttachmentRequest; disabled: boolean }) {
  const card = useRef<HTMLDivElement>(null);
  const [thumbnail, setThumbnail] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const resumeAt = useRef(0);
  const retried = useRef(false);
  useEffect(() => {
    if (file.preview !== "image" || disabled || !card.current) return;
    const controller = new AbortController();
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      void request<{ url: string }>(`/api/attachments/${file.id}/url?mode=preview`, { signal: controller.signal })
        .then((result) => { if (!controller.signal.aborted) setThumbnail(result.url); }).catch(() => {});
    }, { rootMargin: "80px" });
    observer.observe(card.current);
    return () => { observer.disconnect(); controller.abort(); };
  }, [file.id, file.preview, disabled, request]);
  async function link(preview: boolean) {
    return request<{ url: string; expiresAt: string }>(`/api/attachments/${file.id}/url?mode=${preview ? "preview" : "download"}`);
  }
  async function download() {
    setError(""); setBusy(true);
    try {
      const { url: downloadUrl } = await link(false);
      const anchor = document.createElement("a"); anchor.href = downloadUrl; anchor.rel = "noreferrer"; anchor.referrerPolicy = "no-referrer";
      document.body.append(anchor); anchor.click(); anchor.remove();
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }
  async function preview(refresh = false) {
    setError(""); setBusy(true);
    if (!refresh) { retried.current = false; resumeAt.current = 0; }
    try {
      const response = await link(true); setUrl(response.url);
      if (!dialog.current?.open) dialog.current?.showModal();
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }
  function mediaError() {
    if (retried.current) { setError("Не удалось открыть предпросмотр. Файл можно скачать."); return; }
    retried.current = true; resumeAt.current = video.current?.currentTime || 0; void preview(true);
  }
  function close() { video.current?.pause(); dialog.current?.close(); setUrl(""); }
  return <div ref={card} className="attachment-card" onClick={(event) => { if (!disabled) event.stopPropagation(); }} onContextMenu={(event) => event.stopPropagation()} onPointerDown={(event) => { if (!disabled) event.stopPropagation(); }}>
    {thumbnail ? <button type="button" className="attachment-thumbnail" disabled={disabled || busy} aria-label={`Открыть ${file.originalName}`} onClick={() => void preview()}><img src={thumbnail} alt="" referrerPolicy="no-referrer" onError={() => setThumbnail("")} /></button> : <span className="attachment-symbol" aria-hidden="true">{file.preview === "image" ? "▧" : file.preview === "video" ? "▷" : "↧"}</span>}
    <div className="attachment-copy"><strong title={file.originalName}>{file.originalName}</strong><small>{formatFileSize(file.size)}</small><div className="attachment-actions">
      {file.preview ? <button type="button" disabled={disabled || busy} onClick={() => void preview()}>{file.preview === "image" ? "Открыть изображение" : "Смотреть видео"}</button> : null}
      <button type="button" disabled={disabled || busy} onClick={() => void download()}>Скачать</button>
    </div>{error ? <p className="attachment-error" role="alert">{error}</p> : null}</div>
    <dialog ref={dialog} className="attachment-viewer" aria-label={file.originalName} onCancel={close} onClose={() => { video.current?.pause(); setUrl(""); }} onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
      <div className="attachment-viewer-bar"><strong>{file.originalName}</strong><button type="button" onClick={close} aria-label="Закрыть предпросмотр">×</button></div>
      {url && file.preview === "image" ? /* Native image: the bytes stay between browser and S3. */ <img src={url} alt={file.originalName} referrerPolicy="no-referrer" onError={mediaError} /> : null}
      {url && file.preview === "video" ? <video ref={video} src={url} controls playsInline preload="metadata" onError={mediaError} onLoadedMetadata={() => { if (resumeAt.current && video.current) video.current.currentTime = resumeAt.current; }} /> : null}
      {error ? <p role="alert">{error}</p> : null}
    </dialog>
  </div>;
}
