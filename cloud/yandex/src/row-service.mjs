import { serializeMutation } from "../shared/protocol.mjs";
import { randomUUID, createHash } from "node:crypto";
import { ROW_TABLES, effectiveRowData, rowBucket, rowKey, rowIdentity, parseRowOperation, mergeRow, rowDeleted } from "../shared/rows.mjs";
import { appendReplication } from "./replication.mjs";
import { HttpError } from "./errors.mjs";
import { attachmentPreview } from "../shared/attachment-types.mjs";
const uuid = (value) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const clean = (value) => typeof value === "string" ? value.trim() : "";
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const full = (table, data) => Object.fromEntries(ROW_TABLES[table].fields.map((key) => [key, data[key] ?? null]));
const publicUser = ({ id, name, nickname, avatarUrl, avatarBackground, createdAt }) => ({ id, name, ...(nickname ? { nickname } : {}), ...(avatarUrl ? { avatarUrl } : {}), ...(avatarBackground ? { avatarBackground } : {}), createdAt });
export function createRowService(baseDatabase, native, installationId) {
  const caches = new WeakMap(), effects = new WeakMap();
  function cache(tx) { let value = caches.get(tx); if (!value) { value = { groups: new Map(), messages: new Map(), receipts: new Map(), marks: new Map() }; caches.set(tx, value); } return value; }
  const database = { transaction: (callback, options) => baseDatabase.transaction(async (tx) => {
    const result = await callback(tx); if (!options?.readOnly) await flush(tx); return result;
  }, options) };
  async function membership(tx, id) {
    const known = cache(tx).groups;
    if (!known.has(id)) known.set(id, { data: await row(tx, "Group", [id]), members: await members(tx, id) });
    return known.get(id);
  }
  async function checkGroup(tx, id, viewer) {
    const value = await membership(tx, id);
    if (!value.data || viewer && !value.members.some((member) => member.userId === viewer)) throw new HttpError(404, "group_not_found", "Группа не найдена");
    return value;
  }
  async function state(tx, table, keys) { return tx.get(rowBucket(table), JSON.stringify(keys)); }
  async function row(tx, table, keys) { const item = await state(tx, table, keys); return item && !rowDeleted(item) && ROW_TABLES[table].fields.every((key) => Object.hasOwn(effectiveRowData(item), key)) ? effectiveRowData(item) : undefined; }
  async function children(tx, table, parent) { return (await tx.scanPrefix(rowBucket(table), JSON.stringify([parent]).slice(0, -1) + ",", 1000)).filter((item) => !rowDeleted(item)).map((item) => item.data); }
  async function user(tx, id) { return tx.get("users", id); }
  async function members(tx, groupId) { return (await tx.scanPrefix(rowBucket("GroupMember"), JSON.stringify([groupId]).slice(0,-1)+",", 1000)).filter(item=>!rowDeleted(item)).sort((a,b)=>a.aliveVersion.localeCompare(b.aliveVersion)).map(item=>item.data); }
  async function group(tx, id, userId) {
    const value = await checkGroup(tx, id, userId);
    if (value.public) return value.public;
    const data = value.data, people = [];
    for (const member of value.members) { const found = await user(tx, member.userId); if (found) people.push(publicUser(found)); }
    return value.public = { ...Object.fromEntries(["id", "name", "ownerId", "createdAt", "updatedAt", "avatarUrl", "avatarBackground"].filter((key) => data[key] != null).map((key) => [key, data[key]])), members: people };
  }
  async function file(tx, id) { return row(tx, "Attachment", [id]); }
  function fileInfo(data) { return { hasThumbnail:Boolean(data.thumbnailKey), id: data.id, originalName: data.originalName, contentType: data.contentType,
    size: Number(data.confirmedSize ?? data.requestedSize), preview: attachmentPreview(data.contentType) }; }
  async function messageRecord(tx, data, viewer, groupMessage = false, resolveReply = true) {
    if (!data) throw new HttpError(404, "message_not_found", "Сообщение не найдено");
    const table = groupMessage ? "GroupMessage" : "Message";
    if (groupMessage) await checkGroup(tx, data.groupId, viewer);
    else if (![data.fromUserId, data.toUserId].includes(viewer)) throw new HttpError(404, "message_not_found", "Сообщение не найдено");
    if (await row(tx, table + "Deletion", [data.id, viewer])) throw new HttpError(404, "message_not_found", "Сообщение не найдено");
    const messageCache = cache(tx).messages;
    const cacheKey = table + ":" + data.id;
    let result = messageCache.get(cacheKey);
    if (!result) {
    const reactions = (await children(tx, table + "Reaction", data.id)).map(({ userId, emoji }) => ({ userId, emoji })).sort((a, b) => a.userId.localeCompare(b.userId));
    const attachments = [];
    for (const item of await tx.scan("files-of:" + data.id, 10)) {
      const attachment = await file(tx, item.id);
      if (attachment?.status === "attached" && (attachment.messageId === data.id || attachment.groupMessageId === data.id)) attachments.push(fileInfo(attachment));
    }
    let status = "sent";
    if (groupMessage) {
      const groupMarks = cache(tx).marks;
      if (!groupMarks.has(data.groupId)) {
        const value = new Map();
        for (const member of (await membership(tx, data.groupId)).members) value.set(member.userId, await row(tx, "ReadState", [member.userId, data.groupId]));
        groupMarks.set(data.groupId, value);
      }
      const marks = [...groupMarks.get(data.groupId)].filter(([id]) => id !== data.fromUserId).map(([, mark]) => mark);
      if (marks.length && marks.every((mark) => mark?.lastReadAt >= data.sentAt)) status = "read";
      else if (marks.length && marks.every((mark) => mark?.lastDeliveredAt >= data.sentAt)) status = "delivered";
    } else {
      const receiptKey = data.toUserId + ":" + data.fromUserId;
      if (!cache(tx).receipts.has(receiptKey)) cache(tx).receipts.set(receiptKey, await tx.get("receipts", receiptKey));
      const receipt = cache(tx).receipts.get(receiptKey);
      status = receipt?.read?.includes(data.id) ? "read" : receipt?.delivered?.includes(data.id) ? "delivered" : "sent";
    }
    result = { id: data.id, fromUserId: data.fromUserId, senderName: data.senderName, text: data.text, sentAt: data.sentAt,
      ...(groupMessage ? { groupId: data.groupId } : { toUserId: data.toUserId, kind: data.kind }),
      ...(data.editedAt ? { editedAt: data.editedAt } : {}), ...(data.replyToId ? { replyToId: data.replyToId } : {}),
      ...(attachments.length ? { attachments } : {}), reactions, status };
    if (!groupMessage && data.kind === "choice") {
      result.options = (await children(tx, "ChoiceOption", data.id)).sort((a, b) => a.position - b.position).map(({ optionId, label }) => ({ id: optionId, label }));
      if (result.options.length !== 2) throw new HttpError(425, "message_pending", "Варианты ответа ещё синхронизируются");
      if (data.answerId) { result.answer = { id: data.answerId, label: data.answerLabel, answeredAt: data.answeredAt }; result.status = "answered"; }
    }
    messageCache.set(cacheKey, result);
    }
    result = { ...result };
    if (data.replyToId && resolveReply) {
      let target;
      try {
        const original = await row(tx, table, [data.replyToId]);
        if (original && (groupMessage ? original.groupId === data.groupId : [original.fromUserId, original.toUserId].sort().join() === [data.fromUserId, data.toUserId].sort().join()))
          target = await messageRecord(tx, original, viewer, groupMessage, false);
        else if (!groupMessage) {
          const originalState = await tx.get("states", data.replyToId);
          const original = originalState?.operations?.find((op) => op.type === "message.create")?.message;
          if (original && [original.fromUserId, original.toUserId].sort().join() === [data.fromUserId, data.toUserId].sort().join()) {
            const own = await tx.getView(viewer, original.sentAt, original.id);
            if (own && !own.deleted && !own.hidden) target = own;
          }
        }
      } catch (error) { if (!(error instanceof HttpError)) throw error; }
      result.reply = target ? { id: data.replyToId, available: true, senderName: target.senderName,
        text: Array.from(target.text || target.attachments?.[0]?.originalName || "Вложение").slice(0, 180).join("") } : { id: data.replyToId, available: false };
    }
    return result;
  }
  async function refreshMessage(tx, id, grouped) {
    const table = grouped ? "GroupMessage" : "Message", item = await state(tx, table, [id]);
    if (!item) return;
    const data = item.data;
    if (!data.sentAt || !data.fromUserId || !(grouped ? data.groupId : data.toUserId)) return;
    const audience = grouped ? (await members(tx, data.groupId)).map((member) => member.userId) : [data.fromUserId, data.toUserId];
    if (grouped) await tx.putView("@group:" + data.groupId, { id, sentAt: data.sentAt, groupId: data.groupId, deleted: rowDeleted(item) });
    if (!grouped) await tx.put("states", id, { archive: { id, sentAt: data.sentAt, fromUserId: data.fromUserId, toUserId: data.toUserId }, rich: true });
    for (const viewer of audience) {
      let message;
      if (!rowDeleted(item)) try { message = await messageRecord(tx, data, viewer, grouped); } catch (error) { if (!(error instanceof HttpError)) throw error; if (error.status === 425) continue; }
      const sequence = await tx.nextSequence();
      if (message) {
        if (!grouped) await tx.putView(viewer, { ...message, _row: true });
        await tx.addFeed(viewer, sequence, { type: grouped ? "group.message" : "message", message });
      } else {
        await tx.put("deleted:" + viewer, id, { id });
        if (!grouped) await tx.putView(viewer, { id, sentAt: data.sentAt, fromUserId: data.fromUserId, toUserId: data.toUserId, deleted: true });
        await tx.addFeed(viewer, sequence, { type: grouped ? "group.message.delete" : "message.delete", id });
      }
    }
  }
  async function refreshGroup(tx, id, extra = []) {
    const current = await membership(tx, id);
    const ids = new Set(current.members.map((member) => member.userId));
    const people = new Set([...extra, ...ids]);
    const value = current.data ? await group(tx, id) : undefined;
    for (const viewer of people) await tx.addFeed(viewer, await tx.nextSequence(), value && ids.has(viewer)
      ? { type: "group", group: value } : { type: "group.remove", id });
  }
  function dirty(tx) {
    let value = effects.get(tx);
    if (!value) { value = { messages: new Map(), groups: new Map(), snapshots: new Set() }; effects.set(tx, value); }
    return value;
  }
  async function flush(tx) {
    const value = effects.get(tx); if (!value) return;
    effects.delete(tx);
    for (const [id, people] of value.groups) await refreshGroup(tx, id, [...people]);
    for (const [key, grouped] of value.messages) await refreshMessage(tx, key.slice(2), grouped);
    for (const viewer of value.snapshots) await tx.addFeed(viewer, await tx.nextSequence(), { type: "snapshot.required" });
  }
  async function apply(tx, input, local = false) {
    const operation = parseRowOperation(input), bucket = rowBucket(operation.table);
    const old = await tx.get(bucket, operation.key);
    const next = mergeRow(old, operation);
    if (JSON.stringify(old) === JSON.stringify(next)) return next;
    await tx.put(bucket, operation.key, next);
    if (local) await appendReplication(tx, "row:" + operation.origin + ":" + operation.id, { type: "row", operation });
    const data = next.data;
    if (["Message", "GroupMessage"].includes(operation.table) && data.clientRequestId)
      await tx.put("requests:" + operation.table + ":" + data.fromUserId, data.clientRequestId, { id: data.id });
    caches.delete(tx);
    const changed = dirty(tx);
    const message = (id, grouped) => { if (id) changed.messages.set((grouped ? "g:" : "m:") + id, grouped); };
    const groupChanged = (id, viewer) => {
      if (!changed.groups.has(id)) changed.groups.set(id, new Set());
      if (viewer) changed.groups.get(id).add(viewer);
    };
    if (operation.table === "Attachment") {
      await tx.put("files-by:" + data.uploaderId, data.id, { id: data.id });
      if (data.clientRequestId) await tx.put("file-request:" + data.uploaderId, data.clientRequestId, { id: data.id });
      for (const id of new Set([old?.data.messageId, old?.data.groupMessageId, data.messageId, data.groupMessageId].filter(Boolean))) await tx.put("files-of:" + id, data.id, { id: data.id });
      for (const id of [old?.data.messageId, data.messageId]) message(id, false);
      for (const id of [old?.data.groupMessageId, data.groupMessageId]) message(id, true);
    } else if (operation.table === "HiddenConversation") {
      const metadata = await tx.get("user-state", data.ownerId) || {};
      const hidden = new Set(metadata.hiddenPeerIds || []);
      if (rowDeleted(next)) hidden.delete(data.peerId); else hidden.add(data.peerId);
      await tx.put("user-state", data.ownerId, { ...metadata, hiddenPeerIds: [...hidden] });
      await tx.addFeed(data.ownerId, await tx.nextSequence(), { type: "conversation.hidden", id: data.peerId, hidden: !rowDeleted(next) });
    } else if (operation.table === "Group") groupChanged(data.id);
    else if (operation.table === "GroupMember") {
      await tx.put("groups-of:" + data.userId, data.groupId, { groupId: data.groupId, deleted: rowDeleted(next) });
      groupChanged(data.groupId, data.userId);
      if (!rowDeleted(next) && (!old || rowDeleted(old))) changed.snapshots.add(data.userId);
    } else if (["Message", "GroupMessage"].includes(operation.table)) message(data.id, operation.table === "GroupMessage");
    else if (["ChoiceOption", "MessageReaction", "MessageDeletion", "GroupMessageReaction", "GroupMessageDeletion"].includes(operation.table)) message(data.messageId, operation.table.startsWith("GroupMessage"));
    else if (operation.table === "ReadState") for (const member of await members(tx, data.chatId)) changed.snapshots.add(member.userId);

    return next;
  }
  async function detachFiles(tx, messageId) {
    for (const index of await tx.scan("files-of:" + messageId, 10)) {
      const item = await file(tx, index.id);
      if (item && (item.messageId === messageId || item.groupMessageId === messageId))
        await put(tx, "Attachment", { id: item.id, messageId: null, groupMessageId: null }, false, true);
    }
  }
  async function put(tx, table, data, deleted = false, patch = false) {
    const sequence = await tx.nextSequence();
    const operation = { version: 1, id: randomUUID(), origin: installationId, sequence, at: new Date().toISOString(), table,
      key: rowKey(table, data), patch: patch ? data : full(table, data), deleted };
    return apply(tx, operation, true);
  }
  const service = {
    database, row, state, children, group, file, fileInfo, messageRecord, put, apply,
    async clearConversation(tx, ownerId, peerId) {
      const previous = await state(tx, "HiddenConversation", [ownerId, peerId]);
      const metadata = await tx.get("user-state", ownerId) || {};
      if (previous && !rowDeleted(previous) || metadata.hiddenPeerIds?.includes(peerId))
        await put(tx, "HiddenConversation", { ownerId, peerId, hiddenAt: new Date().toISOString() }, true);
    },
    async import(operation) { return database.transaction((tx) => apply(tx, operation)); },
    async importMany(operations) { return database.transaction(async (tx) => { for (const operation of operations) await apply(tx, operation); }); },
    async snapshot(tx, viewer, limit) {
      const groups = [], groupMessages = [];
      for (const item of await tx.scan("groups-of:" + viewer, 1000)) if (!item.deleted) {
        let value; try { value = await group(tx, item.groupId, viewer); } catch (error) { if (!(error instanceof HttpError)) throw error; continue; }
        groups.push(value);
        for (const index of (await tx.views("@group:" + item.groupId, limit)).filter((index) => !index.deleted).reverse()) {
          const data = await row(tx, "GroupMessage", [index.id]);
          try { groupMessages.push(await messageRecord(tx, data, viewer, true)); } catch (error) { if (!(error instanceof HttpError)) throw error; }
        }
      }
      groupMessages.sort((a,b)=>a.sentAt.localeCompare(b.sentAt)||a.id.localeCompare(b.id));
      return { groups, groupMessages: groupMessages.slice(-limit) };
    },
    async getMessage(viewer, id, grouped = false) {
      return database.transaction(async (tx) => messageRecord(tx, await row(tx, grouped ? "GroupMessage" : "Message", [id]), viewer, grouped), { readOnly: true });
    },
    async createMessage(actor, body, grouped = false) {
      const table = grouped ? "GroupMessage" : "Message", text = clean(body.text), kind = grouped ? "text" : body.kind || "text";
      const recipient = grouped ? body.groupId : body.toUserId;
      const files = body.attachmentIds || [];
      if (!uuid(recipient) || !["text", "choice"].includes(kind) || !Array.isArray(files) || files.length > 4 || files.some((id) => !uuid(id))
        || (!text && !files.length) || text.length > 16384 || body.replyToId && !uuid(body.replyToId)) throw new HttpError(422, "invalid_message", "Некорректное сообщение");
      const options = kind === "choice" ? body.options : undefined;
      if (options && (!Array.isArray(options) || options.length !== 2 || options.some((item) => !/^[A-Za-z0-9._~-]{1,64}$/.test(item.id) || !clean(item.label) || Array.from(item.label).length > 8)
        || new Set(options.map((item) => item.id)).size !== 2)) throw new HttpError(422, "invalid_options", "Некорректные варианты ответа");
      if (kind === "choice" && !options) throw new HttpError(422, "invalid_options", "Нужны варианты ответа");
      const requestId = body.clientRequestId;
      if (requestId && !uuid(requestId)) throw new HttpError(422, "invalid_request_id", "Некорректный ID отправки");
      const requestHash = hash({ recipient, text, kind, files: [...files].sort(), options, replyToId: body.replyToId });
      return database.transaction(async (tx) => {
        if (grouped) await group(tx, recipient, actor.id);
        else if (!await user(tx, recipient)) throw new HttpError(404, "recipient_not_found", "Получатель не найден");
        const index = requestId && await tx.get("requests:" + table + ":" + actor.id, requestId);
        if (index) {
          const original = await row(tx, table, [index.id]);
          if (!original || original.requestHash !== requestHash) throw new HttpError(409, "message_request_conflict", "Идентификатор уже использован");
          return messageRecord(tx, original, actor.id, grouped);
        }
        if (body.replyToId) {
          let original = await row(tx, table, [body.replyToId]);
          if (!original && !grouped) {
            original = (await tx.get("states", body.replyToId))?.operations?.find((op) => op.type === "message.create")?.message;
            const own = original && await tx.getView(actor.id, original.sentAt, original.id);
            if (!own || own.deleted || own.hidden) original = undefined;
          }
          if (!original || (grouped ? original.groupId !== recipient : ![original.fromUserId, original.toUserId].includes(actor.id) || ![original.fromUserId, original.toUserId].includes(recipient))) throw new HttpError(404, "reply_not_found", "Сообщение для ответа недоступно");
          if (await row(tx, table + "Deletion", [body.replyToId, actor.id])) throw new HttpError(404, "reply_not_found", "Сообщение для ответа недоступно");
        }
        const attachments = [];
        for (const id of files) {
          const item = await file(tx, id);
          if (!item || item.uploaderId !== actor.id || item.chatKind !== (grouped ? "group" : "peer") || item.chatId !== recipient || item.status !== "uploaded" || item.messageId || item.groupMessageId || item.abandonAt <= new Date().toISOString())
            throw new HttpError(409, "attachment_not_ready", "Файл ещё не готов или относится к другому чату");
          attachments.push(item);
        }
        if (body.clientSentAt !== undefined && (typeof body.clientSentAt !== "string" || !Number.isFinite(Date.parse(body.clientSentAt)) || new Date(body.clientSentAt).toISOString() !== body.clientSentAt)) throw new HttpError(422, "invalid_timestamp", "Некорректное время отправки");
        const id = requestId || randomUUID(), sentAt = body.clientSentAt || new Date().toISOString();
        const data = full(table, { id, fromUserId: actor.id, senderName: actor.name, text, sentAt, ...(grouped ? { groupId: recipient } : { toUserId: recipient, kind }), clientRequestId: requestId, requestHash, replyToId: body.replyToId });
        await put(tx, table, data);
        if (!grouped) { await service.clearConversation(tx, actor.id, recipient); await service.clearConversation(tx, recipient, actor.id); }
        for (let position = 0; position < (options || []).length; position++) await put(tx, "ChoiceOption", { messageId: id, optionId: options[position].id, label: clean(options[position].label), position });
        for (const attachment of attachments) await put(tx, "Attachment", { id: attachment.id, status: "attached", [grouped ? "groupMessageId" : "messageId"]: id }, false, true);
        return messageRecord(tx, data, actor.id, grouped);
      });
    },
    async modifyMessage(actor, id, body, action, grouped = false, mutation) {
      const table = grouped ? "GroupMessage" : "Message";
      const modify = async (tx) => {
        const data = await row(tx, table, [id]);
        await messageRecord(tx, data, actor.id, grouped);
        if (action === "edit") {
          const text = clean(body.text);
          if (data.fromUserId !== actor.id || data.kind === "choice" || !text || text.length > 16384) throw new HttpError(403, "message_not_editable", "Можно менять только своё текстовое сообщение");
          await put(tx, table, { id, text, editedAt: new Date().toISOString() }, false, true);
        } else if (action === "delete") {
          if (!["me", "everyone"].includes(body.scope)) throw new HttpError(422, "invalid_delete_scope", "Некорректный вид удаления");
          if (body.scope === "everyone") {
            if (grouped && data.fromUserId !== actor.id) throw new HttpError(403, "not_message_author", "Удалить у всех можно только своё сообщение");
            await detachFiles(tx, id);
            await put(tx, table, data, true);
          } else await put(tx, table + "Deletion", { messageId: id, userId: actor.id });
          return { deleted: true, id, scope: body.scope };
        } else if (action === "reaction") {
          const { isReactionEmoji } = await import("../shared/reactions.mjs");
          if (body.emoji !== null && !isReactionEmoji(body.emoji)) throw new HttpError(422, "invalid_reaction", "Некорректная реакция");
          await put(tx, table + "Reaction", { messageId: id, userId: actor.id, emoji: body.emoji }, body.emoji === null);
          return { reactions: (await messageRecord(tx, data, actor.id, grouped)).reactions };
        } else if (action === "answer") {
          if (grouped || data.toUserId !== actor.id || data.kind !== "choice") throw new HttpError(403, "not_a_choice", "Нет права ответа");
          if (data.answerId && data.answerId !== body.id) throw new HttpError(409, "already_answered", "Ответ уже выбран");
          const option = await row(tx, "ChoiceOption", [id, body.id]);
          if (!option) throw new HttpError(422, "invalid_choice", "Такого варианта нет");
          if (!data.answerId) await put(tx, table, { id, answerId: option.optionId, answerLabel: option.label, answeredAt: new Date().toISOString() }, false, true);
        }
        return { message: await messageRecord(tx, await row(tx, table, [id]), actor.id, grouped) };
      };
      return database.transaction(async (tx) => {
        if (!mutation) return modify(tx);
        const key = mutation.operationId, serialized = serializeMutation(mutation), previous = await tx.get("row-requests", key);
        if (previous) {
          if (previous.hash !== hash(serialized)) throw new HttpError(409, "mutation_conflict", "ID операции уже использован");
          return { ...previous.receipt, replayed: true };
        }
        if (await tx.get("operations", key)) throw new HttpError(409, "mutation_conflict", "ID операции уже использован");
        if (mutation.type === "message.edit") {
          const original = await row(tx, table, [id]);
          if (original && ["id", "fromUserId", "toUserId", "sentAt"].some(field => original[field] !== mutation.message[field]))
            throw new HttpError(409, "message_identity_conflict", "Нельзя менять участников или время сообщения");
        }
        if (mutation.type === "reaction.set" && mutation.reaction.userId !== actor.id) throw new HttpError(403, "mutation_not_allowed", "Нельзя менять чужую реакцию");
        await modify(tx);
        const receipt = { operationId: key, messageId: id, receivedAt: new Date().toISOString(), replayed: false, status: "applied" };
        await tx.put("row-requests", key, { hash: hash(serialized), receipt });
        return receipt;
      });
    },
    async groupReceipt(actor, id, status) {
      if (!["read", "delivered"].includes(status)) throw new HttpError(422, "invalid_status", "Некорректный статус");
      return database.transaction(async (tx) => {
        const data = await row(tx, "GroupMessage", [id]);
        await messageRecord(tx, data, actor.id, true);
        const before = await row(tx, "ReadState", [actor.id, data.groupId]);
        const patch = { userId: actor.id, chatId: data.groupId, lastDeliveredAt: data.sentAt,
          ...(status === "read" ? { lastReadAt: data.sentAt } : {}) };
        await put(tx, "ReadState", before ? patch : { ...patch, lastReadAt: patch.lastReadAt || null }, false, Boolean(before));
        return { message: await messageRecord(tx, data, actor.id, true) };
      });
    },
    async modifyGroup(actor, id, body, action) {
      return database.transaction(async (tx) => {
        if (action === "create") {
          const ids = [...new Set([actor.id, ...(Array.isArray(body.memberIds) ? body.memberIds : [])])];
          if (!clean(body.name) || Array.from(clean(body.name)).length > 40 || ids.length < 2 || ids.length > 50 || ids.some((id) => !uuid(id))) throw new HttpError(422, "invalid_group", "Некорректная группа");
          for (const id of ids) if (!await user(tx, id)) throw new HttpError(404, "user_not_found", "Участник не найден");
          id = uuid(id) ? id : randomUUID();
          const existing = await row(tx, "Group", [id]);
          if (existing) {
            const current = await group(tx, id, actor.id);
            if (current.ownerId !== actor.id || current.name !== clean(body.name) || [...current.members.map((member) => member.id)].sort().join() !== [...ids].sort().join()) throw new HttpError(409, "group_id_conflict", "Идентификатор уже использован");
            return { group: current };
          }
          if (await state(tx, "Group", [id])) throw new HttpError(409, "group_id_conflict", "Группа удалена");
          const now = new Date().toISOString();
          await put(tx, "Group", { id, name: clean(body.name), ownerId: actor.id, createdAt: now, updatedAt: now });
          for (const userId of ids) await put(tx, "GroupMember", { groupId: id, userId });
        } else {
          const current = await group(tx, id, actor.id);
          if (action === "edit") {
            if (current.ownerId !== actor.id) throw new HttpError(403, "not_group_owner", "Изменять группу может только владелец");
            const patch = { id, updatedAt: new Date().toISOString() };
            for (const key of ["name", "avatarUrl", "avatarBackground"]) if (Object.hasOwn(body, key)) patch[key] = clean(body[key]) || null;
            if (Object.hasOwn(patch, "name") && (!patch.name || Array.from(patch.name).length > 40)) throw new HttpError(422, "invalid_name", "Некорректное название");
            if (patch.avatarUrl && (!/^https?:\/\//.test(patch.avatarUrl) || patch.avatarUrl.length > 500) || patch.avatarBackground && !/^#[0-9a-f]{6}$/i.test(patch.avatarBackground)) throw new HttpError(422, "invalid_avatar", "Некорректная аватарка");
            await put(tx, "Group", patch, false, true);
          } else {
            const target = action === "leave" ? actor.id : body.userId;
            if (!uuid(target) || !await user(tx, target)) throw new HttpError(422, "invalid_user_id", "Некорректный участник");
            if (action === "remove" && (current.ownerId !== actor.id || target === actor.id)) throw new HttpError(403, "not_group_owner", "Исключать участника может владелец");
            const has = current.members.some((member) => member.id === target);
            if (action === "add") {
              if (!has && current.members.length >= 50) throw new HttpError(422, "too_many_members", "Слишком много участников");
              if (!has) await put(tx, "GroupMember", { groupId: id, userId: target });
            } else {
              if (!has) throw new HttpError(404, "member_not_found", "Участник не найден");
              await put(tx, "GroupMember", { groupId: id, userId: target }, true);
              const remaining = current.members.filter((member) => member.id !== target);
              if (!remaining.length) {
                for (const index of await tx.views("@group:" + id, 10000)) {
                  const message = await row(tx, "GroupMessage", [index.id]);
                  if (message) { await detachFiles(tx, message.id); await put(tx, "GroupMessage", message, true); }
                }
                await put(tx, "Group", await row(tx, "Group", [id]), true); return { left: true, deleted: true };
              }
              if (current.ownerId === target) await put(tx, "Group", { id, ownerId: remaining[0].id, updatedAt: new Date().toISOString() }, false, true);
            }
          }
        }
        return action === "leave" ? { left: true, deleted: false } : { group: await group(tx, id, actor.id) };
      });
    },
  };
  return service;
}
