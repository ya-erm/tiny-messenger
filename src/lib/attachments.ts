import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { Attachment, Prisma } from "@/generated/prisma/client";
import { ApiError } from "@/lib/api";
import { read, write, type Db } from "@/lib/db";
import { attachmentSettings, attachmentObjectKey } from "@/lib/attachment-config";
import { attachmentPreview, type AttachmentInfo } from "@/lib/attachment-types";
import { deleteAttachmentObject, freezeAttachment, headAttachment, listAttachmentObjects, signedDownload, signedUpload } from "@/lib/attachment-storage";
import { isUuid } from "@/lib/validation";

export interface AttachmentChat { kind: "peer" | "group"; id: string }
const leaseDuration = 120_000;
const stagingGrace = 3600_000;

export function attachmentInfo(row: Pick<Attachment, "id" | "originalName" | "requestedSize" | "confirmedSize" | "contentType">): AttachmentInfo {
  return { id: row.id, originalName: row.originalName, size: Number(row.confirmedSize ?? row.requestedSize), contentType: row.contentType, preview: attachmentPreview(row.contentType) };
}

export function attachmentIds(value: unknown) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > attachmentSettings().maxFilesPerMessage || value.some((id) => !isUuid(id)) || new Set(value).size !== value.length) {
    throw new ApiError(422, "invalid_attachments", "Некорректный список вложений или превышен лимит файлов");
  }
  return value as string[];
}

export function messageRequestId(value: unknown) {
  if (value === undefined) return undefined;
  if (!isUuid(value)) throw new ApiError(422, "invalid_request_id", "Некорректный идентификатор отправки");
  return value as string;
}

export function messageRequestHash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function chatAccess(db: Db, userId: string, chat: AttachmentChat) {
  if (!isUuid(chat.id) || !["peer", "group"].includes(chat.kind)) throw new ApiError(422, "invalid_chat", "Укажите чат для файла");
  const allowed = chat.kind === "peer"
    ? chat.id !== userId && await db.user.findUnique({ where: { id: chat.id }, select: { id: true } })
    : await db.groupMember.findUnique({ where: { groupId_userId: { groupId: chat.id, userId } } });
  if (!allowed) throw new ApiError(404, "chat_not_found", "Чат недоступен");
}

export async function beginAttachment(userId: string, body: Record<string, unknown>) {
  const settings = attachmentSettings();
  if (!settings.enabled) throw new ApiError(503, "attachments_unconfigured", "Отправка файлов пока не настроена");
  const chat = { kind: body.chatKind, id: body.chatId } as AttachmentChat;
  const size = body.size;
  const requestId = messageRequestId(body.clientRequestId);
  if (!requestId) throw new ApiError(422, "invalid_request_id", "Укажите идентификатор загрузки");
  if (!Number.isSafeInteger(size) || Number(size) < 0 || Number(size) > settings.maxFileBytes) throw new ApiError(413, "attachment_too_large", "Файл превышает допустимый размер");
  const name = typeof body.name === "string" ? body.name.replace(/[\\/\x00-\x1f\x7f]/g, "_").trim() : "";
  if (!name || Buffer.byteLength(name) > 255) throw new ApiError(422, "invalid_filename", "Имя файла должно занимать от 1 до 255 байт");
  const rawType = typeof body.contentType === "string" ? body.contentType.split(";")[0].trim().toLowerCase() : "";
  const contentType = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(rawType) ? rawType : "application/octet-stream";
  const now = new Date();
  const row = await write(async (tx) => {
    await chatAccess(tx, userId, chat);
    const existing = await tx.attachment.findUnique({ where: { uploaderId_clientRequestId: { uploaderId: userId, clientRequestId: requestId } } });
    if (existing) {
      if (existing.chatKind !== chat.kind || existing.chatId !== chat.id || existing.originalName !== name || existing.requestedSize !== BigInt(Number(size)) || existing.contentType !== contentType) throw new ApiError(409, "upload_request_conflict", "Идентификатор уже использован для другого файла");
      if (!["pending", "uploaded", "attached"].includes(existing.status)) throw new ApiError(409, "upload_not_available", "Загрузка недоступна. Выберите файл заново.");
      return existing;
    }
    const pending = await tx.attachment.count({ where: { uploaderId: userId, status: { in: ["pending", "verifying", "uploaded"] } } });
    const used = await tx.attachment.aggregate({ where: { uploaderId: userId }, _sum: { reservedBytes: true } });
    if (pending >= settings.maxPending) throw new ApiError(429, "too_many_uploads", "Слишком много незавершённых загрузок. Удалите лишние файлы или дождитесь очистки.");
    if ((used._sum.reservedBytes ?? 0n) + BigInt(Number(size)) > BigInt(settings.userQuotaBytes)) throw new ApiError(413, "attachment_quota_exceeded", "Недостаточно места для файлов в вашем профиле");
    const id = randomUUID();
    return tx.attachment.create({ data: {
      id, uploaderId: userId, clientRequestId: requestId, chatKind: chat.kind, chatId: chat.id,
      originalName: name, requestedSize: BigInt(Number(size)), reservedBytes: BigInt(Number(size)), contentType,
      stagingKey: attachmentObjectKey("staging", id), objectKey: attachmentObjectKey("attachments", id), status: "pending",
      createdAt: now.toISOString(), expiresAt: new Date(+now + settings.uploadTTL * 1000).toISOString(), abandonAt: new Date(+now + settings.unattachedTTL).toISOString(),
    } });
  });
  return { attachment: attachmentInfo(row), upload: row.status === "pending" ? await signedUpload(row.id, row.stagingKey, Number(row.requestedSize), row.contentType, row.expiresAt) : null };
}

export async function completeAttachment(userId: string, id: string) {
  const token = randomUUID();
  const row = await write(async (tx) => {
    const row = await tx.attachment.findUnique({ where: { id } });
    if (!row || row.uploaderId !== userId) throw new ApiError(404, "attachment_not_found", "Файл не найден");
    await chatAccess(tx, userId, { kind: row.chatKind as AttachmentChat["kind"], id: row.chatId });
    if (["uploaded", "attached"].includes(row.status)) return row;
    if (!["pending", "verifying"].includes(row.status) || Date.parse(row.abandonAt) <= Date.now()) throw new ApiError(410, "upload_expired", "Загрузка истекла или отменена");
    if (row.status === "verifying" && Date.parse(row.leaseUntil || "") > Date.now()) throw new ApiError(409, "upload_verifying", "Файл уже проверяется. Повторите через несколько секунд.");
    return tx.attachment.update({ where: { id }, data: { status: "verifying", leaseToken: token, leaseUntil: new Date(Date.now() + leaseDuration).toISOString() } });
  });
  if (["uploaded", "attached"].includes(row.status)) return attachmentInfo(row);
  try {
    let final = await headAttachment(id, row.objectKey);
    if (!final) {
      const source = await headAttachment(id, row.stagingKey);
      if (!source) throw new ApiError(409, "upload_missing", "Загрузка файла ещё не завершена");
      if (source.ContentLength !== Number(row.requestedSize) || source.ContentType !== row.contentType || source.Metadata?.["upload-id"] !== id || !source.ETag) {
        await write((tx) => tx.attachment.updateMany({ where: { id, leaseToken: token }, data: { status: "failed", leaseToken: null, leaseUntil: null } }));
        throw new ApiError(422, "attachment_mismatch", "Размер или параметры загруженного файла не совпадают");
      }
      const claimed = await write((tx) => tx.attachment.updateMany({ where: { id, status: "verifying", leaseToken: token }, data: { sourceEtag: source.ETag } }));
      if (!claimed.count) throw new ApiError(409, "upload_changed", "Состояние загрузки изменилось");
      row.sourceEtag = source.ETag;
      await freezeAttachment(id, row.stagingKey, row.objectKey, source.ETag, row.contentType);
      final = await headAttachment(id, row.objectKey);
    }
    if (!final || !final.ETag || final.ContentLength !== Number(row.requestedSize) || final.ContentType !== row.contentType || final.Metadata?.["upload-id"] !== id || !row.sourceEtag || final.Metadata?.["source-etag"] !== row.sourceEtag.replace(/^"|"$/g, "")) {
      throw new ApiError(422, "attachment_mismatch", "Не удалось подтвердить неизменяемую копию файла");
    }
    return await write(async (tx) => {
      const count = await tx.attachment.updateMany({ where: { id, status: "verifying", leaseToken: token }, data: { status: "uploaded", confirmedSize: BigInt(final.ContentLength!), etag: final.ETag, leaseUntil: null, leaseToken: null } });
      if (!count.count) throw new ApiError(409, "upload_changed", "Состояние загрузки изменилось");
      return attachmentInfo((await tx.attachment.findUnique({ where: { id } }))!);
    });
  } catch (error) {
    await write((tx) => tx.attachment.updateMany({ where: { id, status: "verifying", leaseToken: token }, data: { status: "pending", leaseToken: null, leaseUntil: null } }));
    throw error;
  }
}

export async function cancelAttachment(userId: string, id: string) {
  await write(async (tx) => {
    const row = await tx.attachment.findUnique({ where: { id } });
    if (!row || row.uploaderId !== userId) throw new ApiError(404, "attachment_not_found", "Файл не найден");
    if (row.status === "attached" || row.messageId || row.groupMessageId) throw new ApiError(409, "attachment_attached", "Отправленный файл нельзя отменить отдельно от сообщения");
    if (!["deleted", "deleting"].includes(row.status)) await tx.attachment.update({ where: { id }, data: { status: "failed", leaseUntil: null, leaseToken: null } });
  });
}

export async function attachFiles(tx: Prisma.TransactionClient, userId: string, chat: AttachmentChat, ids: string[], messageId: string) {
  if (!ids.length) return;
  const rows = await tx.attachment.findMany({ where: { id: { in: ids } } });
  if (rows.length !== ids.length || rows.some((row) => row.uploaderId !== userId || row.chatKind !== chat.kind || row.chatId !== chat.id || row.status !== "uploaded" || row.messageId || row.groupMessageId || Date.parse(row.abandonAt) <= Date.now())) {
    throw new ApiError(409, "attachment_not_ready", "Можно отправить только свои проверенные файлы из этого чата");
  }
  const changed = await tx.attachment.updateMany({ where: { id: { in: ids }, status: "uploaded", messageId: null, groupMessageId: null }, data: { status: "attached", ...(chat.kind === "peer" ? { messageId } : { groupMessageId: messageId }) } });
  if (changed.count !== ids.length) throw new ApiError(409, "attachment_changed", "Вложения уже использованы или изменились");
}

export async function attachmentLink(userId: string, id: string, preview: boolean) {
  const row = await read(async (db) => {
    const row = await db.attachment.findUnique({ where: { id } });
    if (!row || row.status !== "attached") throw new ApiError(404, "attachment_not_found", "Файл недоступен");
    if (row.messageId) {
      const m = await db.message.findFirst({ where: { id: row.messageId, OR: [{ fromUserId: userId }, { toUserId: userId }], deletions: { none: { userId } } } });
      if (!m) throw new ApiError(404, "attachment_not_found", "Файл недоступен");
      const peerId = m.fromUserId === userId ? m.toUserId : m.fromUserId;
      if (await db.hiddenConversation.findUnique({ where: { ownerId_peerId: { ownerId: userId, peerId } } })) throw new ApiError(404, "attachment_not_found", "Файл недоступен");
    } else if (row.groupMessageId) {
      const m = await db.groupMessage.findFirst({ where: { id: row.groupMessageId, group: { members: { some: { userId } } }, deletions: { none: { userId } } } });
      if (!m) throw new ApiError(404, "attachment_not_found", "Файл недоступен");
    } else throw new ApiError(404, "attachment_not_found", "Файл недоступен");
    return row;
  });
  if (preview && !attachmentPreview(row.contentType)) throw new ApiError(422, "preview_unavailable", "Для этого типа файла доступно только скачивание");
  return signedDownload(row.id, row.objectKey, row.originalName, row.contentType, preview);
}

let cleanupRunning = false;
let sweepAt = 0;
let sweepKind: "staging" | "attachments" = "staging";
let sweepCursor: string | undefined;

export async function cleanupAttachments() {
  if (cleanupRunning || !attachmentSettings().enabled) return { processed: 0 };
  cleanupRunning = true;
  const settings = attachmentSettings();
  const now = new Date().toISOString();
  const stagingCutoff = new Date(Date.now() - stagingGrace).toISOString();
  let processed = 0;
  try {
    const candidates = await read((db) => db.attachment.findMany({
      where: { OR: [
        { status: { in: ["pending", "failed"] }, expiresAt: { lt: stagingCutoff } },
        { status: "verifying", expiresAt: { lt: stagingCutoff }, leaseUntil: { lt: now } },
        { status: "uploaded", abandonAt: { lt: now } },
        { status: "attached", messageId: null, groupMessageId: null },
      ] }, orderBy: { createdAt: "asc" }, take: settings.cleanupBatch,
    }));
    for (const row of candidates) {
      await write(async (tx) => {
        await tx.attachment.updateMany({ where: { id: row.id, status: row.status, messageId: null, groupMessageId: null, leaseToken: row.leaseToken }, data: {
          status: "deleting", leaseToken: null, leaseUntil: null,
          deleteAfter: new Date(Date.now() + (row.status === "attached" ? settings.deleteGrace : 0)).toISOString(),
        } });
      });
    }
    const deleting = await read((db) => db.attachment.findMany({ where: { status: "deleting", deleteAfter: { lte: now }, messageId: null, groupMessageId: null }, orderBy: { deleteAfter: "asc" }, take: settings.cleanupBatch }));
    for (const row of deleting) {
      await deleteAttachmentObject(row.id, row.stagingKey);
      await deleteAttachmentObject(row.id, row.objectKey);
      await write((tx) => tx.attachment.updateMany({ where: { id: row.id, status: "deleting", messageId: null, groupMessageId: null }, data: { status: "deleted", reservedBytes: 0n, stagingDeletedAt: now, originalName: "", contentType: "application/octet-stream" } }));
      processed++;
    }
    if (processed < settings.cleanupBatch) {
      const staging = await read((db) => db.attachment.findMany({ where: { status: { in: ["uploaded", "attached"] }, stagingDeletedAt: null, expiresAt: { lt: stagingCutoff } }, orderBy: { expiresAt: "asc" }, take: settings.cleanupBatch - processed }));
      for (const row of staging) {
        await deleteAttachmentObject(row.id, row.stagingKey);
        await write((tx) => tx.attachment.updateMany({ where: { id: row.id }, data: { stagingDeletedAt: now } }));
        processed++;
      }
    }
    // A late PUT can recreate staging after cancellation, and a restored DB can
    // lose newer upload rows. A bounded hourly sweep handles both cases. It
    // never removes a final object that has an Attachment record.
    if (processed < settings.cleanupBatch && Date.now() >= sweepAt) {
      const prefix = (settings.prefix ? settings.prefix + "/" : "") + sweepKind + "/";
      const objects = await listAttachmentObjects(prefix, sweepCursor);
      let stopped = false;
      for (const object of objects.Contents || []) {
        if (processed >= settings.cleanupBatch) { stopped = true; break; }
        sweepCursor = object.Key;
        if (!object.Key?.startsWith(prefix) || !isUuid(object.Key.slice(prefix.length)) || !object.LastModified) continue;
        const cutoff = Date.now() - (sweepKind === "staging" ? stagingGrace : settings.deleteGrace);
        if (+object.LastModified > cutoff) continue;
        const id = object.Key.slice(prefix.length);
        const row = await read((db) => db.attachment.findUnique({ where: { id } }));
        if (sweepKind === "attachments") {
          if (row && row.status !== "deleted") continue;
        } else if (row && (Date.parse(row.expiresAt) > Date.now() - stagingGrace || (row.status === "verifying" && Date.parse(row.leaseUntil || "") > Date.now()))) continue;
        await deleteAttachmentObject(id, object.Key);
        processed++;
      }
      if (!stopped && !objects.IsTruncated) {
        sweepCursor = undefined;
        if (sweepKind === "staging") sweepKind = "attachments";
        else { sweepKind = "staging"; sweepAt = Date.now() + 3600_000; }
      }
    }
    return { processed };
  } finally {
    cleanupRunning = false;
  }
}
