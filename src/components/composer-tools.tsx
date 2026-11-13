"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ReactionPicker } from "@/components/reaction-picker";
import { formatFileSize, type AttachmentLimits } from "@/lib/attachment-types";
import type { AttachmentMode } from "@/lib/prepare-attachment";

export function ComposerTools({ limits, fileCount, disabled, editing, allowChoice, onFiles, onPoll, onEmoji }: {
  limits: AttachmentLimits | null;
  fileCount: number;
  disabled: boolean;
  editing: boolean;
  allowChoice: boolean;
  onFiles: (files: File[], mode: AttachmentMode) => void;
  onPoll: () => void;
  onEmoji: (emoji: string) => boolean;
}) {
  const [open, setOpen] = useState<"attachments" | "emoji" | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const attachmentButton = useRef<HTMLButtonElement>(null);
  const emojiButton = useRef<HTMLButtonElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const mediaInput = useRef<HTMLInputElement>(null);
  const popupId = useId();
  const [popupHeight, setPopupHeight] = useState(340);
  const filesDisabled = disabled || !limits?.enabled || fileCount >= limits.maxFilesPerMessage;

  useLayoutEffect(() => {
    if (!open) return;
    const fit = () => setPopupHeight(Math.min(340, Math.max(80, (root.current?.getBoundingClientRect().top ?? 352) - (window.visualViewport?.offsetTop || 0) - 12)));
    fit();
    window.addEventListener("resize", fit);
    window.visualViewport?.addEventListener("resize", fit);
    window.visualViewport?.addEventListener("scroll", fit);
    return () => {
      window.removeEventListener("resize", fit);
      window.visualViewport?.removeEventListener("resize", fit);
      window.visualViewport?.removeEventListener("scroll", fit);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLElement>(open === "emoji" ? ".reaction-search" : '[role="menuitem"]:not(:disabled)')?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(null);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  useEffect(() => { if (disabled) setOpen(null); }, [disabled]);

  function closeWithFocus() {
    (open === "emoji" ? emojiButton : attachmentButton).current?.focus();
    setOpen(null);
  }
  function choose(mode: AttachmentMode) {
    setOpen(null);
    attachmentButton.current?.focus();
    (mode === "media" ? mediaInput : fileInput).current?.click();
  }
  return <div className="composer-tools" ref={root} onBlur={(event) => {
    if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setOpen(null);
  }} onKeyDown={(event) => {
    if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); closeWithFocus(); }
  }}>
    {!editing ? <button ref={attachmentButton} type="button" className="composer-tool" aria-label="Прикрепить" aria-haspopup="menu" aria-expanded={open === "attachments"} aria-controls={open === "attachments" ? popupId : undefined} disabled={disabled} onClick={() => setOpen(open === "attachments" ? null : "attachments")}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 13 7.5-7.5a3 3 0 0 1 4.2 4.2L9.4 20a5 5 0 0 1-7.1-7.1L13 2.2" /><path d="m5 15 9-9" /></svg>
    </button> : null}
    <button ref={emojiButton} type="button" className="composer-tool" aria-label="Смайлики" aria-haspopup="dialog" aria-expanded={open === "emoji"} aria-controls={open === "emoji" ? popupId : undefined} disabled={disabled} onClick={() => setOpen(open === "emoji" ? null : "emoji")}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M8 14a4.5 4.5 0 0 0 8 0M8.5 9h.01M15.5 9h.01" /></svg>
    </button>
    {open === "attachments" && !editing ? <div id={popupId} className="composer-popover composer-attachment-menu" style={{ maxHeight: popupHeight }} role="menu" aria-label="Прикрепить к сообщению" onKeyDown={(event) => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'));
      if (!buttons.length) return;
      event.preventDefault();
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next].focus();
    }}>
      <button type="button" role="menuitem" disabled={filesDisabled} onClick={() => choose("media")}><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4" /><circle cx="8" cy="8" r="1" /><path d="m3 17 6-6 5 5 3-3 4 4" /></svg><span>Фото или видео<small>Фото сжимаются в WebP</small></span></button>
      <button type="button" role="menuitem" disabled={filesDisabled} onClick={() => choose("file")}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H5v18h14V8Zm0 0v5h5" /></svg><span>Файл<small>Оригинал без сжатия</small></span></button>
      <button type="button" role="menuitem" disabled={disabled || !allowChoice} onClick={() => { setOpen(null); onPoll(); }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 20V10m7 10V4m7 16v-7" /></svg><span>Опрос<small>{allowChoice ? "Два варианта ответа" : "Доступен в личном чате"}</small></span></button>
      <small className="composer-file-limit">{limits?.enabled ? `До ${formatFileSize(limits.maxFileBytes)} · ${limits.maxFilesPerMessage} файла` : "Прикрепление файлов недоступно"}</small>
    </div> : null}
    {open === "emoji" ? <div id={popupId} className="composer-popover composer-emoji" style={{ maxHeight: popupHeight }} role="dialog" aria-label="Выбрать смайлик"><ReactionPicker mode="insert" disabled={disabled} onSelect={(emoji) => { if (onEmoji(emoji)) setOpen(null); }} /></div> : null}
    {!editing && limits?.enabled ? <>
      <input ref={mediaInput} type="file" accept="image/jpeg,image/png,image/webp,image/avif,image/gif,video/*" multiple hidden aria-label="Выбрать фото или видео" disabled={filesDisabled} onChange={(event) => { const files = Array.from(event.target.files || []); event.target.value = ""; onFiles(files, "media"); }} />
      <input ref={fileInput} type="file" multiple hidden aria-label="Выбрать файлы" disabled={filesDisabled} onChange={(event) => { const files = Array.from(event.target.files || []); event.target.value = ""; onFiles(files, "file"); }} />
    </> : null}
  </div>;
}
