import type { Mutation } from "./mutations/protocol";
import { serializeMutation } from "./mutations/protocol";
import type { PublicUser, PublicMessage, PublicContact, PublicGroup, PublicGroupMessage, ReadStateRecord } from "./types";
import type { ChannelId } from "./client-transport";

export const STORAGE_EVENT = "tiny-messenger:storage";
export interface CachedSnapshot {
  user?: PublicUser;
  deletedMessageIds?: string[];
  contacts: PublicContact[]; messages: PublicMessage[]; groups: PublicGroup[];
  groupMessages: PublicGroupMessage[]; hiddenPeerIds: string[];
  readStates: Array<Pick<ReadStateRecord, "chatId" | "lastDeliveredAt" | "lastReadAt">>; syncedAt: string; cursor?: string; installationId?: string;
}
export interface QueuedMutation {
  operationId: string; userId: string; channel: ChannelId; operation: Mutation;
  senderName: string; state: "queued" | "waiting" | "accepted" | "failed";
  nextAttemptAt: number; attempts: number; error?: string;
}
interface SnapshotRow { key: string; userId: string; channel: ChannelId; snapshot: CachedSnapshot; receivedAt?: number }
let databasePromise: Promise<IDBDatabase> | undefined;
function openDatabase() {
  databasePromise ||= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("tiny-messenger-client-v2", 1);
    request.onupgradeneeded = () => {
      for (const [name, keyPath] of [["profiles", "fingerprint"], ["snapshots", "key"], ["operations", "operationId"], ["deletions", "key"]]) {
        const store = request.result.createObjectStore(name, { keyPath });
        if (name !== "profiles") store.createIndex("userId", "userId");
      }
    };
    request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); databasePromise = undefined; }; resolve(request.result); };
    request.onerror = () => { databasePromise = undefined; reject(request.error); };
    request.onblocked = () => { databasePromise = undefined; reject(new Error("Локальное хранилище занято другой вкладкой")); };
  });
  return databasePromise;
}
function result<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}
async function transaction<T>(storeName: string, mode: IDBTransactionMode, callback: (store: IDBObjectStore) => Promise<T>): Promise<T> {
  const database = await openDatabase();
  const tx = database.transaction(storeName, mode);
  const completion = new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error || new Error("Не удалось сохранить данные")); });
  try { const value = await callback(tx.objectStore(storeName)); await completion; return value; }
  catch (error) { try { tx.abort(); } catch {} await completion.catch(() => {}); throw error; }
}
function changed() { if (typeof window !== "undefined") window.dispatchEvent(new Event(STORAGE_EVENT)); }
async function fingerprint(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
export async function cacheProfile(token: string, user: PublicUser) {
  const key = await fingerprint(token);
  await transaction("profiles", "readwrite", async (store) => { await result(store.put({ fingerprint: key, user })); });
}
export async function cachedProfile(token: string): Promise<PublicUser | undefined> {
  const key = await fingerprint(token);
  return transaction("profiles", "readonly", async (store) => (await result(store.get(key)))?.user);
}
export async function saveSnapshot(userId: string, channel: ChannelId, snapshot: CachedSnapshot) {
  if (snapshot.deletedMessageIds?.length) await hideCachedMessages(userId, snapshot.deletedMessageIds);
  await transaction("snapshots", "readwrite", async (store) => {
    const rows = await result(store.index("userId").getAll(userId)) as SnapshotRow[];
    const receivedAt = Math.max(Date.now(), ...rows.map((row) => (row.receivedAt || 0) + 1));
    await result(store.put({ key: `${userId}:${channel}:${snapshot.installationId || channel}`, userId, channel, snapshot, receivedAt }));
  });
  changed();
}
export async function channelSnapshot(userId: string, channel: ChannelId): Promise<CachedSnapshot | undefined> {
  const rows = await transaction<SnapshotRow[]>("snapshots", "readonly", (store) => result(store.index("userId").getAll(userId)));
  return rows.filter((row) => row.channel === channel).sort((a, b) => (b.receivedAt || 0) - (a.receivedAt || 0))[0]?.snapshot;
}
export function applyCloudChanges(snapshot: CachedSnapshot, batch: {
  cursor: string; installationId: string; user?: PublicUser; changes: Array<{ type: string; message?: PublicMessage | PublicGroupMessage; group?: PublicGroup; id?: string; hidden?: boolean; delivered?: string[]; read?: string[] }>;
}) {
  const messages = new Map(snapshot.messages.map((message) => [message.id, message]));
  const groups = new Map(snapshot.groups.map((group) => [group.id, group]));
  const groupMessages = new Map(snapshot.groupMessages.map((message) => [message.id, message]));
  const hiddenPeers = new Set(snapshot.hiddenPeerIds);
  const deletedIds: string[] = [];
  for (const change of batch.changes) {
    if (change.type === "conversation.hidden" && change.id) { if (change.hidden) hiddenPeers.add(change.id); else hiddenPeers.delete(change.id); }
    if (change.type === "message" && change.message && "toUserId" in change.message) messages.set(change.message.id, change.message);
    if (change.type === "group" && change.group) groups.set(change.group.id, change.group);
    if (change.type === "group.remove" && change.id) {
      groups.delete(change.id);
      for (const [id, message] of groupMessages) if (message.groupId === change.id) groupMessages.delete(id);
    }
    if (change.type === "group.message" && change.message && "groupId" in change.message) groupMessages.set(change.message.id, change.message);
    if (change.type === "group.message.delete" && change.id) { groupMessages.delete(change.id); deletedIds.push(change.id); }
    if (change.type === "message.delete" && change.id) { messages.delete(change.id); deletedIds.push(change.id); }
    if (change.type === "receipts") {
      const read = new Set(change.read); const delivered = new Set(change.delivered);
      for (const [id, message] of messages) if (message.status !== "answered") {
        if (read.has(id)) messages.set(id, { ...message, status: "read" });
        else if (delivered.has(id) && message.status !== "read") messages.set(id, { ...message, status: "delivered" });
      }
    }
  }
  // Resolve quote changes without retaining content from a deleted original.
  for (const collection of [messages, groupMessages]) for (const [id, message] of collection) if (message.replyToId) {
    const target = collection.get(message.replyToId);
    if (deletedIds.includes(message.replyToId)) collection.set(id, { ...message, reply: { id: message.replyToId, available: false } } as never);
    else if (target) collection.set(id, { ...message, reply: { id: target.id, available: true, senderName: target.senderName,
      text: Array.from(target.text || target.attachments?.[0]?.originalName || "Вложение").slice(0, 180).join("") } } as never);
  }
  return { snapshot: { ...snapshot, user: batch.user || snapshot.user, hiddenPeerIds: [...hiddenPeers], groups: [...groups.values()], groupMessages: [...groupMessages.values()], messages: [...messages.values()], cursor: batch.cursor, installationId: batch.installationId,
    syncedAt: new Date().toISOString() }, deletedIds };
}
export async function queueMutation(userId: string, channel: ChannelId, operation: Mutation, senderName: string) {
  const body = serializeMutation(operation);
  if (new TextEncoder().encode(body).byteLength > 16384) throw new Error("Сообщение вместе со служебными полями превышает 16 КиБ");
  await transaction("operations", "readwrite", async (store) => {
    const existing = await result(store.get(operation.operationId)) as QueuedMutation | undefined;
    if (existing) { if (serializeMutation(existing.operation) !== body) throw new Error("Идентификатор отправки уже использован"); return; }
    await result(store.put({ operationId: operation.operationId, userId, channel, operation, senderName,
      state: "queued", attempts: 0, nextAttemptAt: 0 } satisfies QueuedMutation));
  });
  changed();
}
export async function storedMutation(id: string): Promise<QueuedMutation | undefined> {
  return transaction("operations", "readonly", (store) => result(store.get(id)));
}
export async function queuedMutations(userId: string): Promise<QueuedMutation[]> {
  return transaction("operations", "readonly", (store) => result(store.index("userId").getAll(userId)));
}
export async function hideCachedMessages(userId: string, ids: string[]) {
  await transaction("deletions", "readwrite", async (store) => {
    for (const messageId of ids) await result(store.put({ key: `${userId}:${messageId}`, userId, messageId }));
  }); changed();
}
export async function readCachedSnapshot(userId: string, channel: ChannelId): Promise<CachedSnapshot | undefined> {
  const [rows, operations, deletions] = await Promise.all([
    transaction<SnapshotRow[]>("snapshots", "readonly", (store) => result(store.index("userId").getAll(userId))),
    queuedMutations(userId), transaction<Array<{ messageId: string }>>("deletions", "readonly", (store) => result(store.index("userId").getAll(userId))),
  ]);
  rows.sort((a, b) => (a.receivedAt || 0) - (b.receivedAt || 0));
  const preferredRow = rows.findLast((row) => row.channel === channel);
  const preferred = preferredRow?.snapshot;
  if (!rows.length && !operations.length) return undefined;
  const contacts = new Map<string, PublicContact>(); const groups = new Map<string, PublicGroup>();
  const messages = new Map<string, PublicMessage>(); const groupMessages = new Map<string, PublicGroupMessage>();
  // Prefer the active contour's version, retaining messages absent from it.
  for (const row of [...rows.filter((row) => row !== preferredRow), ...(preferredRow ? [preferredRow] : [])]) {
    row.snapshot.contacts.forEach((item) => contacts.set(item.userId, item));
    row.snapshot.groups.forEach((item) => groups.set(item.id, item));
    row.snapshot.messages.forEach((item) => messages.set(item.id, item));
    row.snapshot.groupMessages.forEach((item) => groupMessages.set(item.id, item));
  }
  const hidden = new Set(deletions.map((item) => item.messageId));
  for (const item of operations.sort((a, b) => a.operation.occurredAt.localeCompare(b.operation.occurredAt) || a.operationId.localeCompare(b.operationId))) {
    const operation = item.operation;
    if (operation.type === "message.create" && (!messages.has(operation.message.id) || item.state !== "accepted")) messages.set(operation.message.id,
      { ...operation.message, senderName: item.senderName, reactions: [], status: "sent",
        ...(item.state !== "accepted" ? { localState: item.state === "failed" ? "failed" as const : "queued" as const } : {}) });
    if (operation.type === "message.edit" && item.state !== "accepted") {
      const old = messages.get(operation.message.id);
      if (old) messages.set(old.id, { ...old, text: operation.message.text, editedAt: operation.occurredAt,
        localState: item.state === "failed" ? "failed" : "queued" });
    }
    if (operation.type === "reaction.set" && item.state !== "accepted") {
      const old = messages.get(operation.reaction.messageId);
      if (old) messages.set(old.id, { ...old, reactions: [
        ...old.reactions.filter((reaction) => reaction.userId !== operation.reaction.userId),
        ...(operation.reaction.emoji ? [{ userId: operation.reaction.userId, emoji: operation.reaction.emoji }] : []),
      ] });
    }
    if (operation.type === "message.delete" && item.state !== "failed") hidden.add(operation.deletion.messageId);
  }
  for (const collection of [messages, groupMessages]) for (const [id, message] of collection) if (message.replyToId && hidden.has(message.replyToId))
    collection.set(id, { ...message, reply: { id: message.replyToId, available: false } } as never);
  return { user: preferred?.user, contacts: preferred ? preferred.contacts : [...contacts.values()], groups: preferred ? preferred.groups : [...groups.values()], messages: [...messages.values()].filter((item) => !hidden.has(item.id))
    .sort((a, b) => a.sentAt.localeCompare(b.sentAt) || a.id.localeCompare(b.id)), groupMessages: [...groupMessages.values()].filter((item) => !hidden.has(item.id) && (!preferred || preferred.groups.some((group) => group.id === item.groupId))),
    hiddenPeerIds: preferred?.hiddenPeerIds || [], readStates: preferred?.readStates || [], syncedAt: preferred?.syncedAt || new Date().toISOString(),
    cursor: preferred?.cursor, installationId: preferred?.installationId };
}
const flushing = new Set<string>();
export async function flushMutations(userId: string,
  send: (operation: Mutation, channel: ChannelId) => Promise<{ status?: string }>) {
  if (flushing.has(userId)) return false;
  flushing.add(userId);
  try {
    const operations = (await queuedMutations(userId)).filter((item) => ["queued", "waiting"].includes(item.state) && item.nextAttemptAt <= Date.now())
      .sort((a, b) => a.operation.occurredAt.localeCompare(b.operation.occurredAt) || a.operationId.localeCompare(b.operationId));
    for (const item of operations) {
      let update: Partial<QueuedMutation>;
      try { const receipt = await send(item.operation, item.channel);
        if (!["pending", "rejected", "applied", "superseded"].includes(receipt.status || "")) throw Error("Сервер не подтвердил операцию");
        update = { state: receipt.status === "pending" ? "waiting" : receipt.status === "rejected" ? "failed" : "accepted", nextAttemptAt: Date.now() + 5000, error: undefined };
      } catch (error) {
        const failure = error as Error & { status?: number; retryAfterSeconds?: number };
        const permanent = failure.status && failure.status >= 400 && failure.status < 500 && ![408, 429].includes(failure.status);
        update = { state: permanent ? "failed" : "queued", error: failure.message, attempts: item.attempts + 1,
          nextAttemptAt: Date.now() + Math.max(1000, (failure.retryAfterSeconds || 0) * 1000, Math.min(30000, 1000 * 2 ** item.attempts)) };
      }
      await transaction("operations", "readwrite", async (store) => {
        const current = await result(store.get(item.operationId)) as QueuedMutation;
        if (current.state !== "accepted") await result(store.put({ ...current, ...update }));
      }); changed();
    }
    return operations.length > 0;
  } finally { flushing.delete(userId); }
}
export async function retryQueuedMutations(userId: string) {
  await transaction("operations", "readwrite", async (store) => {
    const rows = await result(store.index("userId").getAll(userId)) as QueuedMutation[];
    for (const row of rows) if (row.state !== "accepted") await result(store.put({ ...row, state: "queued", nextAttemptAt: 0 }));
  }); changed();
}
