import { createIdentityService } from "./identity.mjs";
import { applyIdentityOperation, reconcileIdentityNicknames } from "../shared/identity-protocol.mjs";
import { createRegistrationService } from "./registration.mjs";
import { createFileService } from "./row-files.mjs";
import { createRowService } from "./row-service.mjs";
import { appendReplication } from "./replication.mjs";
import { createHash } from "node:crypto";
import { parseMutation, serializeMutation, mutationMessageId, MutationValidationError } from "../shared/protocol.mjs";
import { reduceMessageOperations } from "../shared/reduce.mjs";

import { HttpError } from "./errors.mjs";
export { HttpError } from "./errors.mjs";
export function publicUser(user) {
  const { id, name, nickname, avatarUrl, avatarBackground, createdAt } = user;
  return { id, name, ...(nickname ? { nickname } : {}), ...(avatarUrl ? { avatarUrl } : {}),
    ...(avatarBackground ? { avatarBackground } : {}), createdAt };
}
const hash = (value) => createHash("sha256").update(value).digest("hex");
const visible = (message) => !message.deleted && !message.hidden;
const bare = (message) => { const { hidden, deleted, _row, ...record } = message; return record; };

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
  const service = {
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
          if (message._row) {
            const record = await service.rows.row(tx, "Message", [message.id]);
            if (record) messages.push(await service.rows.messageRecord(tx, record, user.id));
            continue;
          }
          messages.push({ ...bare(message), status: message.answer ? "answered" : receipt?.read?.includes(message.id) ? "read"
            : receipt?.delivered?.includes(message.id) ? "delivered" : message.status || "sent" });
        }
        const rich = await service.rows.snapshot(tx, user.id, limit);
        const knownGroups = new Set(rich.groups.map((entry) => entry.id));
        for (const group of state.groups || []) if (await service.rows.state(tx, "Group", [group.id])) knownGroups.add(group.id);
        return { user: publicUser(user), contacts: state.contacts || [], groups: [...(state.groups || []).filter((item) => !knownGroups.has(item.id)), ...rich.groups],
          groupMessages: [...(state.groupMessages || []).filter((item) => !knownGroups.has(item.groupId)), ...rich.groupMessages],
          hiddenPeerIds: state.hiddenPeerIds || [], readStates: state.readStates || [], messages,
          deletedMessageIds: (await tx.scan("deleted:" + user.id, 10000)).map((item) => item.id),
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
      if (await database.transaction((tx) => service.rows.state(tx, "Message", [id]), { readOnly: true })) return service.rows.getMessage(user.id, id);
      return database.transaction(async (tx) => {
        const state = await tx.get("states", id);
        const original = state?.operations?.find((op) => op.type === "message.create")?.message || state?.archive;
        if (!original || ![original.fromUserId, original.toUserId].includes(user.id)) throw new HttpError(404, "message_not_found", "Сообщение не найдено");
        const ownView = await tx.getView(user.id, original.sentAt, id);
        if (!ownView || !visible(ownView)) throw new HttpError(404, "message_not_found", "Сообщение не найдено");
        return withReceipt(tx, bare(ownView));
      }, { readOnly: true });
    },
    async changes(user, after, limit = 100, extended = false) {
      const sequence = sequenceFrom(after);
      return database.transaction(async (tx) => {
        const changes = await tx.feed(user.id, sequence, limit + 1);
        if (changes.some((change) => change.type === "snapshot.required" || !extended && ["group", "group.remove", "group.message", "group.message.delete", "conversation.hidden"].includes(change.type)))
          throw new HttpError(409, "snapshot_required", "Нужен новый снимок");
        const hasMore = changes.length > limit;
        if (hasMore) changes.pop();
        return { user: publicUser(user), installationId, cursor: cursor(changes.at(-1)?.sequence || sequence), changes, hasMore };
      }, { readOnly: true });
    },
    async mutate(user, value, sourceId) {
      const operation = parse(value);
      if (operation.actorId !== user.id) throw new HttpError(403, "mutation_actor_mismatch", "Нельзя изменить данные другого пользователя");
      const messageId = mutationMessageId(operation);
      if (!sourceId && operation.type !== "message.create" && await database.transaction(tx => service.rows.state(tx, "Message", [messageId]), { readOnly: true })) {
        const action = operation.type === "message.edit" ? "edit" : operation.type === "message.delete" ? "delete" : "reaction";
        const body = action === "edit" ? { text: operation.message.text } : action === "delete" ? { scope: operation.deletion.scope } : { emoji: operation.reaction.emoji };
        return service.rows.modifyMessage(user, messageId, body, action, false, operation);
      }
      return database.transaction(async (tx) => {
        if (await tx.get("row-requests", operation.operationId)) throw new HttpError(409, "mutation_conflict", "ID операции уже использован");
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
        if (status === "rejected" && !sourceId) throw new HttpError(403, "mutation_not_allowed", "Нет прав на изменение сообщения");
        const receivedAt = new Date().toISOString();
        await tx.put("operations", operation.operationId, { operation, receivedAt, ...(sourceId ? { sourceId } : {}) });
        if (!sourceId) await appendReplication(tx, "operation:" + operation.operationId, { type: "mutation", operation });
        await tx.put("states", messageId, { ...state, operations });
        if (projection.message) {
          const sequence = await tx.nextSequence();
          for (const viewer of [projection.message.fromUserId, projection.message.toUserId]) {
            const hidden = projection.deleted || projection.hiddenFor.includes(viewer);
            const message = hidden ? { id: messageId, sentAt: projection.message.sentAt,
              fromUserId: projection.message.fromUserId, toUserId: projection.message.toUserId, deleted: true }
              : await withReceipt(tx, { ...projection.message, senderName: state.senderName,
                ...(projection.editedAt ? { editedAt: projection.editedAt } : {}), reactions: projection.reactions });
            if (hidden) await tx.put("deleted:" + viewer, messageId, { id: messageId });
            await tx.putView(viewer, message);
            await tx.addFeed(viewer, sequence, hidden ? { type: "message.delete", id: messageId }
              : { type: "message", message });
            if (operation.type === "message.create") {
              const peerId = viewer === projection.message.fromUserId ? projection.message.toUserId : projection.message.fromUserId;
              await service.rows.clearConversation(tx, viewer, peerId);
            }
          }
        }
        return { operationId: operation.operationId, messageId, receivedAt, replayed: false, status };
      });
    },
    async importMutation(value, sourceId) {
      const operation = parse(value);
      const actor = await database.transaction((tx) => tx.get("users", operation.actorId), { readOnly: true });
      if (!actor) throw new HttpError(409, "peer_actor_missing", "Сначала передайте пользователя");
      return service.mutate(actor, operation, sourceId);
    },
    async importDirectory(directory) {
      if (!Array.isArray(directory.users) || directory.users.length > 500 || !Array.isArray(directory.contacts)
        || directory.contacts.length > 500 || !Array.isArray(directory.receipts) || directory.receipts.length > 500)
        throw new HttpError(422, "invalid_directory", "Некорректный справочник");
      for (const input of directory.users) {
        if (!/^[0-9a-f-]{36}$/.test(input.id) || typeof input.name !== "string" || !/^[0-9a-f]{64}$/.test(input.tokenHash))
          throw new HttpError(422, "invalid_directory_user", "Некорректный пользователь");
        const user = Object.fromEntries(["id", "name", "nickname", "avatarUrl", "avatarBackground", "tokenHash", "createdAt", "updatedAt"]
          .filter((key) => input[key] != null).map((key) => [key, input[key]]));
        await database.transaction(async (tx) => {
          if(input.nicknameClaim)await tx.put("nickname-claims",user.id,input.nicknameClaim);
          const previous = await tx.get("users", user.id);
          const identity=await tx.get("identity-state",user.id)||{};
          if(previous&&identity.token)user.tokenHash=previous.tokenHash;
          if(previous&&identity.profile)for(const key of ["name","nickname","avatarUrl","avatarBackground"]) {if(previous[key]!=null)user[key]=previous[key];else delete user[key];}
          if(previous&&previous.updatedAt>user.updatedAt)user.updatedAt=previous.updatedAt;
          if (JSON.stringify(previous) !== JSON.stringify(user)) await tx.put("users", user.id, user);
          if (!previous || previous.tokenHash !== user.tokenHash) await tx.put("tokens", user.tokenHash, { userId: user.id });
          for(const operation of Object.values(input.identity||{}))await applyIdentityOperation(tx,operation);
        });
      }
      await database.transaction(tx=>reconcileIdentityNicknames(tx));
      for (const state of directory.contacts) await database.transaction(async (tx) => {
        if (!await tx.get("users", state.userId) || !Array.isArray(state.contacts) || state.contacts.length > 500)
          throw new HttpError(422, "invalid_directory_contacts", "Некорректные контакты");
        const before = await tx.get("user-state", state.userId) || {};
        if (JSON.stringify(before.contacts || []) !== JSON.stringify(state.contacts)) {
          await tx.put("user-state", state.userId, { ...before, contacts: state.contacts });
          await tx.addFeed(state.userId, await tx.nextSequence(), { type: "snapshot.required" });
        }
      });
      for (const receipt of directory.receipts) await service.importReceipt(receipt);
    },
    async importReceipt(receipt) {
      if (!Array.isArray(receipt.delivered) || !Array.isArray(receipt.read)
        || receipt.delivered.length > 5000 || receipt.read.length > 5000)
        throw new HttpError(422, "invalid_peer_receipt", "Некорректное прочтение");
      await database.transaction(async (tx) => {
        const key = receipt.userId + ":" + receipt.peerId;
        const before = await tx.get("receipts", key) || { delivered: [], read: [] };
        // Unknown IDs are retained as receipt dependencies: the operation can
        // arrive in a later batch. They never acknowledge a different message.
        const read = [...new Set([...before.read, ...receipt.read])].sort();
        const delivered = [...new Set([...before.delivered, ...receipt.delivered, ...read])].sort();
        if (JSON.stringify(before) === JSON.stringify({ delivered, read })) return;
        await tx.put("receipts", key, { delivered, read });
        const sequence = await tx.nextSequence();
        for (const viewer of [receipt.userId, receipt.peerId])
          await tx.addFeed(viewer, sequence, { type: "receipts", delivered, read });
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
          await appendReplication(tx, "receipt:" + key + ":" + hash(JSON.stringify({ delivered, read })),
            { type: "receipt", userId: user.id, peerId: message.fromUserId, delivered, read });
          const sequence = await tx.nextSequence();
          for (const viewer of [user.id, message.fromUserId]) await tx.addFeed(viewer, sequence, { type: "receipts", delivered, read });
        }
        return { ...bare(message), status: read.includes(messageId) ? "read" : "delivered" };
      });
    },
  };
  service.rows = createRowService(database, service, installationId);
  service.files = createFileService(service.rows);
  service.identity = createIdentityService(database);
  service.registration = createRegistrationService(database,service,publicUser);
  return service;
}
