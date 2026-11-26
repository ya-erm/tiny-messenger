import { randomUUID } from "node:crypto";
import { HttpError } from "./errors.mjs";
import { attachmentSettings, attachmentLimits, attachmentObjectKey } from "../shared/attachment-config.mjs";
import { signedUpload, signedDownload, headAttachment, freezeAttachment } from "../shared/attachment-storage.mjs";
import { attachmentPreview } from "../shared/attachment-types.mjs";
export function createFileService(rows, storage = { signedUpload, signedDownload, headAttachment, freezeAttachment }) {
  const { database, row, file, put, fileInfo, group, messageRecord } = rows;
  async function access(tx, userId, kind, chatId) {
    if (kind === "group") await group(tx, chatId, userId);
    else if (kind !== "peer" || chatId === userId || !await tx.get("users", chatId)) throw new HttpError(404, "chat_not_found", "Чат не найден");
  }
  return {
    limits: attachmentLimits,
    async create(actor, body) {
      const settings = attachmentSettings();
      if (!settings.enabled) throw new HttpError(503, "attachments_unconfigured", "Файлы пока не настроены");
      const chat = { kind: body.chatKind, id: body.chatId };
      const size = Number(body.size), name = typeof body.name === "string" ? body.name.replace(/[\\/\x00-\x1f\x7f]/g, "_").trim() : "";
      const requestId = body.clientRequestId;
      if (!Number.isSafeInteger(size) || size < 0 || size > settings.maxFileBytes || !name || Buffer.byteLength(name) > 255
        || !/^[0-9a-f-]{36}$/.test(requestId) || !/^[0-9a-f-]{36}$/.test(chat.id)) throw new HttpError(422, "invalid_attachment", "Некорректные параметры файла");
      const rawType = typeof body.contentType === "string" ? body.contentType.split(";")[0].trim().toLowerCase() : "";
      const contentType = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(rawType) ? rawType : "application/octet-stream";
      const item = await database.transaction(async (tx) => {
        await access(tx, actor.id, chat.kind, chat.id);
        const prior = await tx.get("file-request:" + actor.id, requestId);
        if (prior) {
          const old = await file(tx, prior.id);
          if (!old || old.chatKind !== chat.kind || old.chatId !== chat.id || old.originalName !== name || Number(old.requestedSize) !== size || old.contentType !== contentType)
            throw new HttpError(409, "upload_request_conflict", "Идентификатор уже использован");
          if (!["pending", "uploaded", "attached"].includes(old.status)) throw new HttpError(409, "upload_not_available", "Загрузка недоступна");
          return old;
        }
        // Per-uploader index avoids scanning other users' attachment metadata.
        const existing = [];
        for (const ref of await tx.scan("files-by:" + actor.id, 10000)) { const old = await file(tx, ref.id); if (old) existing.push(old); }
        if (existing.filter((item) => ["pending", "verifying", "uploaded"].includes(item.status)).length >= settings.maxPending) throw new HttpError(429, "too_many_uploads", "Слишком много незавершённых загрузок");
        if (existing.reduce((sum, item) => sum + Number(item.reservedBytes), 0) + size > settings.userQuotaBytes) throw new HttpError(413, "attachment_quota_exceeded", "Недостаточно места");
        const id = requestId, now = Date.now();
        if (await rows.state(tx, "Attachment", [id])) throw new HttpError(409, "upload_request_conflict", "Идентификатор уже использован");
        const data = { id, uploaderId: actor.id, clientRequestId: requestId, chatKind: chat.kind, chatId: chat.id,
          stagingKey: attachmentObjectKey("staging", id), objectKey: attachmentObjectKey("attachments", id), originalName: name, contentType,
          requestedSize: size, reservedBytes: size, status: "pending", createdAt: new Date(now).toISOString(), expiresAt: new Date(now + settings.uploadTTL * 1000).toISOString(), abandonAt: new Date(now + settings.unattachedTTL).toISOString() };
        const state = await put(tx, "Attachment", data);
        return state.data;
      });
      return { attachment: fileInfo(item), upload: item.status === "pending" ? await storage.signedUpload(item.id, item.stagingKey, Number(item.requestedSize), item.contentType, item.expiresAt) : null };
    },
    async complete(actor, id) {
      const leaseToken = randomUUID();
      const item = await database.transaction(async (tx) => {
        const old = await file(tx, id);
        if (!old || old.uploaderId !== actor.id) throw new HttpError(404, "attachment_not_found", "Файл не найден");
        await access(tx, actor.id, old.chatKind, old.chatId);
        if (["uploaded", "attached"].includes(old.status)) return old;
        if (!["pending", "verifying"].includes(old.status) || Date.parse(old.abandonAt) <= Date.now()) throw new HttpError(410, "upload_expired", "Загрузка истекла");
        if (old.status === "verifying" && Date.parse(old.leaseUntil) > Date.now()) throw new HttpError(409, "upload_verifying", "Файл уже проверяется");
        return (await put(tx, "Attachment", { id, status: "verifying", leaseToken, leaseUntil: new Date(Date.now() + 30000).toISOString() }, false, true)).data;
      });
      if (["uploaded", "attached"].includes(item.status)) return { attachment: fileInfo(item) };
      try {
        let final = await storage.headAttachment(id, item.objectKey), sourceEtag = item.sourceEtag;
        if (!final) {
          const source = await storage.headAttachment(id, item.stagingKey);
          if (!source) throw new HttpError(409, "upload_missing", "Файл ещё не загружен");
          if (source.ContentLength !== Number(item.requestedSize) || source.ContentType !== item.contentType || source.Metadata?.["upload-id"] !== id || !source.ETag) throw new HttpError(422, "attachment_mismatch", "Параметры файла не совпадают");
          sourceEtag = source.ETag;
          await database.transaction((tx) => put(tx, "Attachment", { id, sourceEtag }, false, true));
          await storage.freezeAttachment(id, item.stagingKey, item.objectKey, sourceEtag, item.contentType);
          final = await storage.headAttachment(id, item.objectKey);
        }
        if (!final || !final.ETag || !sourceEtag || final.ContentLength !== Number(item.requestedSize) || final.ContentType !== item.contentType
          || final.Metadata?.["upload-id"] !== id || final.Metadata?.["source-etag"] !== sourceEtag.replace(/^"|"$/g, "")) throw new HttpError(422, "attachment_mismatch", "Не удалось подтвердить файл");
        return database.transaction(async (tx) => {
          const current = await file(tx, id);
          if (current.leaseToken !== leaseToken || current.status !== "verifying") throw new HttpError(409, "upload_changed", "Загрузка изменилась");
          const value = await put(tx, "Attachment", { id, status: "uploaded", confirmedSize: Number(final.ContentLength), etag: final.ETag, leaseToken: null, leaseUntil: null }, false, true);
          return { attachment: fileInfo(value.data) };
        });
      } catch (error) {
        await database.transaction(async (tx) => { const current = await file(tx, id); if (current?.leaseToken === leaseToken) await put(tx, "Attachment", { id, status: "pending", leaseToken: null, leaseUntil: null }, false, true); });
        throw error;
      }
    },
    async cancel(actor, id) {
      await database.transaction(async (tx) => {
        const data = await file(tx, id);
        if (!data || data.uploaderId !== actor.id) throw new HttpError(404, "attachment_not_found", "Файл не найден");
        if (data.status === "attached" || data.messageId || data.groupMessageId) throw new HttpError(409, "attachment_attached", "Файл уже отправлен");
        await put(tx, "Attachment", { id, status: "failed", leaseToken: null, leaseUntil: null }, false, true);
      });
      return { cancelled: true };
    },
    async link(actor, id, preview) {
      const data = await database.transaction(async (tx) => {
        const item = await file(tx, id);
        if (!item || item.status !== "attached") throw new HttpError(404, "attachment_not_found", "Файл недоступен");
        const grouped = Boolean(item.groupMessageId), messageId = item.groupMessageId || item.messageId;
        if (!messageId) throw new HttpError(404, "attachment_not_found", "Файл недоступен");
        const message = await row(tx, grouped ? "GroupMessage" : "Message", [messageId]);
        await messageRecord(tx, message, actor.id, grouped);
        if (!grouped && await row(tx, "HiddenConversation", [actor.id, message.fromUserId === actor.id ? message.toUserId : message.fromUserId])) throw new HttpError(404, "attachment_not_found", "Файл недоступен");
        return item;
      }, { readOnly: true });
      if (preview && !attachmentPreview(data.contentType)) throw new HttpError(422, "preview_unavailable", "Для файла доступно только скачивание");
      return storage.signedDownload(id, data.objectKey, data.originalName, data.contentType, preview);
    },
  };
}
