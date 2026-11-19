import { createHash } from "node:crypto";
import { parseMutation, serializeMutation, mutationMessageId, MutationValidationError } from "../shared/protocol.mjs";
import { reduceMessageOperations } from "../shared/reduce.mjs";

export class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export function publicUser(user) {
  const { id, name, nickname, avatarUrl, avatarBackground, createdAt } = user;
  return { id, name, ...(nickname ? { nickname } : {}), ...(avatarUrl ? { avatarUrl } : {}),
    ...(avatarBackground ? { avatarBackground } : {}), createdAt };
}
const hash = (value) => createHash("sha256").update(value).digest("hex");
const visible = (message) => !message.deleted && !message.hidden;
const bare = (message) => { const { hidden, deleted, ...record } = message; return record; };

function parse(value) {
  try { return parseMutation(value); }
  catch (error) { if (error instanceof MutationValidationError) throw new HttpError(422, "invalid_mutation", error.message); throw error; }
}

export function createService(database, installationId = "yandex-1") {
  const cursor = (sequence) => `${installationId}:${sequence}`;
  function sequenceFrom(value) {
    if (typeof value !== "string" || !value.startsWith(installationId + ":")) throw new HttpError(409, "cursor_installation_mismatch", "Нужен снимок этого контура");
    const sequence = value.slice(installationId.length + 1);
    if (!/^\d{1,20}$/.test(sequence)) throw new HttpError(422, "invalid_cursor", "Некорректный курсор");
    return sequence;
  }
  async function withReceipt(tx, message) {
    const receipt = await tx.get("receipts", message.toUserId + ":" + message.fromUserId);
    return { ...message, status: message.answer ? "answered" : receipt?.read?.includes(message.id) ? "read"
      : receipt?.delivered?.includes(message.id) ? "delivered" : message.status || "sent" };
  }
  return {
    installationId,
    async authenticate(token) {
      if (!token) throw new HttpError(401, "missing_token", "Передайте токен Messenger");
      return database.transaction(async (tx) => {
        const index = await tx.get("tokens", hash(token));
        const user = index && await tx.get("users", index.userId);
        if (!user || user.tokenHash !== hash(token)) throw new HttpError(401, "invalid_token_in_channel", "Токен не найден в этом контуре; попробуйте основной канал");
        return user;
      }, { readOnly: true });
    },
    async snapshot(user, limit = 100) {
      return database.transaction(async (tx) => {
        const state = await tx.get("user-state", user.id) || {};
        const rows = (await tx.views(user.id, limit)).filter(visible).reverse();
        const messages = [];
        // One receipt read per conversation, rather than per message.
        const receipts = new Map();
        for (const message of rows) {
          const key = message.toUserId + ":" + message.fromUserId;
          if (!receipts.has(key)) receipts.set(key, await tx.get("receipts", key));
          const receipt = receipts.get(key);
          messages.push({ ...bare(message), status: message.answer ? "answered" : receipt?.read?.includes(message.id) ? "read"
            : receipt?.delivered?.includes(message.id) ? "delivered" : message.status || "sent" });
        }
        return { contacts: state.contacts || [], groups: state.groups || [], groupMessages: state.groupMessages || [],
          hiddenPeerIds: state.hiddenPeerIds || [], readStates: state.readStates || [], messages,
          installationId, cursor: cursor(await tx.sequence()), syncedAt: new Date().toISOString() };
      }, { readOnly: true });
    },
    async contacts(user) { return database.transaction(async (tx) => (await tx.get("user-state", user.id))?.contacts || [], { readOnly: true }); },
    async users(user, { query = "", nickname, id } = {}) {
      return database.transaction(async (tx) => (await tx.scan("users", 1000)).filter((candidate) => candidate.id !== user.id
        && (!id || candidate.id === id) && (!nickname || candidate.nickname === nickname)
        && (!query || [candidate.id, candidate.name, candidate.nickname].some((value) => value?.toLowerCase().includes(query.toLowerCase()))))
        .slice(0, 30).map(publicUser), { readOnly: true });
    },
    async message(user, id) {
      return database.transaction(async (tx) => {
        const state = await tx.get("states", id);
        const original = state?.operations?.find((op) => op.type === "message.create")?.message || state?.archive;
        if (!original || ![original.fromUserId, original.toUserId].includes(user.id)) throw new HttpError(404, "message_not_found", "Сообщение не найдено");
        const ownView = await tx.getView(user.id, original.sentAt, id);
        if (!ownView || !visible(ownView)) throw new HttpError(404, "message_not_found", "Сообщение не найдено");
        return withReceipt(tx, bare(ownView));
      }, { readOnly: true });
    },
    async changes(user, after, limit = 100) {
      const sequence = sequenceFrom(after);
      return database.transaction(async (tx) => {
        const changes = await tx.feed(user.id, sequence, limit + 1);
        const hasMore = changes.length > limit;
        if (hasMore) changes.pop();
        return { installationId, cursor: cursor(changes.at(-1)?.sequence || sequence), changes, hasMore };
      }, { readOnly: true });
    },
    async mutate(user, value) {
      const operation = parse(value);
      if (operation.actorId !== user.id) throw new HttpError(403, "mutation_actor_mismatch", "Нельзя изменить данные другого пользователя");
      return database.transaction(async (tx) => {
        const original = await tx.get("operations", operation.operationId);
        const messageId = mutationMessageId(operation);
        const state = await tx.get("states", messageId) || { operations: [] };
        if (original) {
          if (serializeMutation(original.operation) !== serializeMutation(operation)) throw new HttpError(409, "mutation_conflict", "ID операции уже использован");
          return { operationId: operation.operationId, messageId, receivedAt: original.receivedAt,
            replayed: true, status: reduceMessageOperations(state.operations).statuses.get(operation.operationId) || "pending" };
        }
        if (state.archive) throw new HttpError(409, "archived_message_read_only", "Эта часть истории пока доступна только для чтения");
        if (operation.type === "message.create") {
          if (state.operations.some((op) => op.type === "message.create")) throw new HttpError(409, "message_id_conflict", "Сообщение уже существует");
          if (!await tx.get("users", operation.message.toUserId)) throw new HttpError(404, "recipient_not_found", "Получатель не найден");
          state.senderName = user.name;
        }
        const operations = [...state.operations, operation];
        if (Buffer.byteLength(JSON.stringify(operations)) > 1024 * 1024) throw new HttpError(413, "message_journal_full", "Достигнут лимит истории изменений прототипа");
        const projection = reduceMessageOperations(operations);
        const status = projection.statuses.get(operation.operationId);
        if (status === "rejected") throw new HttpError(403, "mutation_not_allowed", "Нет прав на изменение сообщения");
        const receivedAt = new Date().toISOString();
        await tx.put("operations", operation.operationId, { operation, receivedAt });
        await tx.put("states", messageId, { ...state, operations });
        if (projection.message) {
          const sequence = await tx.nextSequence();
          for (const viewer of [projection.message.fromUserId, projection.message.toUserId]) {
            const hidden = projection.deleted || projection.hiddenFor.includes(viewer);
            const message = hidden ? { id: messageId, sentAt: projection.message.sentAt,
              fromUserId: projection.message.fromUserId, toUserId: projection.message.toUserId, deleted: true }
              : await withReceipt(tx, { ...projection.message, senderName: state.senderName,
                ...(projection.editedAt ? { editedAt: projection.editedAt } : {}), reactions: projection.reactions });
            await tx.putView(viewer, message);
            await tx.addFeed(viewer, sequence, hidden ? { type: "message.delete", id: messageId }
              : { type: "message", message });
            if (operation.type === "message.create") {
              const peerId = viewer === projection.message.fromUserId ? projection.message.toUserId : projection.message.fromUserId;
              const metadata = await tx.get("user-state", viewer);
              if (metadata?.hiddenPeerIds?.includes(peerId)) await tx.put("user-state", viewer,
                { ...metadata, hiddenPeerIds: metadata.hiddenPeerIds.filter((id) => id !== peerId) });
            }
          }
        }
        return { operationId: operation.operationId, messageId, receivedAt, replayed: false, status };
      });
    },
    async receipt(user, messageId, status) {
      if (!["delivered", "read"].includes(status)) throw new HttpError(422, "invalid_status", "Некорректный статус");
      return database.transaction(async (tx) => {
        const views = (await tx.views(user.id, 100)).filter(visible);
        const message = views.find((candidate) => candidate.id === messageId && candidate.toUserId === user.id);
        if (!message) throw new HttpError(404, "message_not_found", "Входящее сообщение не найдено");
        const key = user.id + ":" + message.fromUserId;
        const before = await tx.get("receipts", key) || { delivered: [], read: [] };
        // Acknowledge only known message IDs. A late old message is not read by a timestamp watermark.
        const known = views.filter((candidate) => candidate.fromUserId === message.fromUserId && candidate.sentAt <= message.sentAt).map((candidate) => candidate.id);
        const delivered = [...new Set([...before.delivered, ...known])].sort();
        const read = status === "read" ? [...new Set([...before.read, ...known])].sort() : before.read;
        if (JSON.stringify({ delivered, read }) !== JSON.stringify(before)) {
          await tx.put("receipts", key, { delivered, read });
          const sequence = await tx.nextSequence();
          for (const viewer of [user.id, message.fromUserId]) await tx.addFeed(viewer, sequence, { type: "receipts", delivered, read });
        }
        return { ...bare(message), status: read.includes(messageId) ? "read" : "delivered" };
      });
    },
  };
}
