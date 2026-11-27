import {withExternalProfile} from "./external-protocol";
import {acknowledgeObservations} from "./telemetry-protocol";
import {identityStore} from "./identity";
import "server-only";
import { isBusHealthy } from "../../../scripts/replication-bus/format.mjs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { read, write } from "@/lib/db";
import { ingestLocalRows, materializeRows, storeRow, operationFromChange } from "./row-store";
import { prepareHistory, prepareRowHistory, type Bootstrap } from "./history";
import { applyPeerEvents } from "./apply";
import { publicUser } from "@/lib/auth";
import { toUserRecord } from "@/lib/store";
import { REPLICATION_BATCH, REPLICATION_MAX_BYTES, REPLICATION_VERSION, replicationCursor } from "./protocol";

type State = { telemetryAcks?:any[]; rowSeq?: number; sentSeq: number; cursor: string; hashes: Record<string, string>; nextPoll: number;
  activeUntil: number; retryAt: number; failures: number; caughtUp?: boolean; lastSuccess?: string; lastError?: string };
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
let running: Promise<unknown> | undefined;
export function synchronizeInstallations() {
  if (running) return running;
  running = synchronize().finally(() => { running = undefined; });
  return running;
}
async function synchronize() {
  const configFile = process.env.TM_REPLICATION_CONFIG;
  if (!configFile) return { enabled: false };
  const config = JSON.parse(await readFile(configFile, "utf8")) as { url: string; secret: string; peerId: string; installationId: string; bootstrapFile: string };
  const endpoint = new URL(config.url);
  if (endpoint.protocol !== "https:" || config.secret.length < 32 || config.peerId === config.installationId)
    throw Error("Invalid replication configuration");
  if (!await read((db) => db.replicationState.findUnique({ where: { key: "history:v1" } }))) {
    const bootstrap = JSON.parse(await readFile(config.bootstrapFile, "utf8")) as Bootstrap;
    await write(async (tx) => {
      if (await tx.replicationState.findUnique({ where: { key: "history:v1" } })) return;
      const result = await prepareHistory(tx, bootstrap, new Date().toISOString());
      await tx.replicationState.create({ data: { key: "history:v1", body: JSON.stringify(result) } });
    }, { timeout: 30_000 });
  }
  if (!await read((db) => db.replicationState.findUnique({ where: { key: "rows:history:v1" } }))) {
    const bootstrap = JSON.parse(await readFile(config.bootstrapFile, "utf8")) as Bootstrap;
    await write((tx) => prepareRowHistory(tx, bootstrap));
  }
  const key = "peer:" + config.peerId;
  const stored = await read((db) => db.replicationState.findUnique({ where: { key } }));
  const state: State = stored ? JSON.parse(stored.body) : { sentSeq: 0, cursor: "0", hashes: {}, nextPoll: 0, activeUntil: 0, retryAt: 0, failures: 0 };
  const now = Date.now();
  if (!isBusHealthy(now) && state.nextPoll > now + 60_000) state.nextPoll = now;
  if (state.retryAt > now) return { enabled: true, retryAfterMs: state.retryAt - now };
  // One consistent snapshot of directory and receipts. It stays on the VPS;
  // only changed items travel to YDB, five at a time.
  const local = await write(async (tx) => {
    const rowsIngested = await ingestLocalRows(tx, config.installationId);
    await materializeRows(tx);
    const users = await tx.user.findMany({ orderBy: { id: "asc" } });
    const contacts = await tx.contact.findMany({ orderBy: [{ ownerId: "asc" }, { userId: "asc" }] });
    const marks = await tx.readState.findMany();
    const messages = await tx.message.findMany({ select: { id: true, fromUserId: true, toUserId: true, sentAt: true, receiptStatus: true } });
    const operations = await tx.mutationOperation.findMany({ where: { seq: { gt: state.sentSeq } }, orderBy: { seq: "asc" }, take: REPLICATION_BATCH + 1 });
    const rowChanges = await tx.replicaChange.findMany({ where: { seq: { gt: state.rowSeq || 0 } }, orderBy: { seq: "asc" }, take: REPLICATION_BATCH + 1 });
    const identities=await tx.replicationState.findMany({where:{OR:[{key:{startsWith:"identity-state:"}},{key:{startsWith:"nickname-claim:"}},{key:{startsWith:"external-users:"}},{key:{startsWith:"external-profile:"}}]}});
    const outboxes=await tx.replicationState.findMany({where:{key:{startsWith:"telemetry-outbox:"}},take:5});
    const telemetry=outboxes.flatMap(item=>JSON.parse(item.body).items).slice(0,5);
    return { users, telemetry, identities, contacts, marks, messages, operations, rowChanges, rowsIngested };
  });
  if (!local.rowsIngested) return { enabled: true, preparingRows: true };
  const usersById = new Map(local.users.map((user) => [user.id, user]));
  const entries: Array<{ key: string; kind: "users" | "contacts" | "receipts"; value: unknown; hash: string }> = [];
  const note = (kind: "users" | "contacts" | "receipts", id: string, value: unknown) => {
    const key = kind + ":" + id, hash = digest(value);
    if (state.hashes[key] !== hash) entries.push({ key, kind, value, hash });
  };
  for (const user of local.users) {const state=local.identities.find(item=>item.key==="identity-state:"+user.id); const claim=local.identities.find(item=>item.key==="nickname-claim:"+user.id),external=local.identities.find(item=>item.key==="external-users:"+user.id); note("users",user.id,{...user,...(state?{identity:JSON.parse(state.body)}:{}),...(claim?{nicknameClaim:JSON.parse(claim.body)}:{}),...(external?{externalIdentity:withExternalProfile(JSON.parse(external.body),JSON.parse(local.identities.find(item=>item.key==="external-profile:"+user.id)?.body||"null"))}:{})});}
  for (const user of local.users) note("contacts", user.id, { userId: user.id, contacts: local.contacts.filter((item) => item.ownerId === user.id)
    .map((item) => ({ userId: item.userId, createdAt: item.createdAt, updatedAt: item.updatedAt, user: publicUser(toUserRecord(usersById.get(item.userId)!)) })) });
  const marks = new Map(local.marks.map((mark) => [mark.userId + ":" + mark.chatId, mark]));
  const receipts = new Map<string, { userId: string; peerId: string; delivered: string[]; read: string[] }>();
  for (const message of local.messages) {
    const key = message.toUserId + ":" + message.fromUserId, mark = marks.get(key);
    const wasRead = message.receiptStatus ? message.receiptStatus === "read" : (mark?.lastReadAt || "") >= message.sentAt;
    const delivered = message.receiptStatus ? message.receiptStatus !== "sent" : wasRead || (mark?.lastDeliveredAt || "") >= message.sentAt;
    if (!delivered) continue;
    if (!receipts.has(key)) receipts.set(key, { userId: message.toUserId, peerId: message.fromUserId, delivered: [], read: [] });
    const receipt = receipts.get(key)!; receipt.delivered.push(message.id); if (wasRead) receipt.read.push(message.id);
  }
  for (const [key, receipt] of receipts) { receipt.delivered.sort(); receipt.read.sort(); note("receipts", key, receipt); }
  const busReady = Boolean((config as any).bus?.enabled && isBusHealthy(now));
  if (!state.telemetryAcks?.length && !local.telemetry.length && !entries.length && (busReady || !local.operations.length && !local.rowChanges.length) && state.nextPoll > now) return { enabled: true, idle: true, lastSuccess: state.lastSuccess };
  const changed = entries.slice(0, REPLICATION_BATCH);
  // New actors/recipients must exist before their operations are accepted.
  const canSendOperations = !entries.slice(REPLICATION_BATCH).some((entry) => entry.kind === "users");
  const operations = canSendOperations ? local.operations.slice(0, local.rowChanges.length ? Math.ceil(REPLICATION_BATCH / 2) : REPLICATION_BATCH) : [];
  const rowChanges = canSendOperations ? local.rowChanges.slice(0, REPLICATION_BATCH - operations.length) : [];
  const directory: Record<string, unknown[]> = { users: [], contacts: [], receipts: [] };
  for (const entry of changed) directory[entry.kind].push(entry.value);
  const body = JSON.stringify({ protocolVersion: REPLICATION_VERSION, rowProtocolVersion: 1, userProtocolVersion: 4, sourceId: config.installationId, targetId: config.peerId,
    after: state.cursor, telemetry:local.telemetry,telemetryAcks:state.telemetryAcks||[], rows: rowChanges.map((entry) => operationFromChange(entry, config.installationId)), operations: operations.map((entry) => JSON.parse(entry.body)), ...(changed.length ? { directory } : {}) });
  if (Buffer.byteLength(body) > REPLICATION_MAX_BYTES) throw Error("Replication batch exceeds byte limit");
  try {
    const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", "x-tm-replication-key": config.secret },
      body, cache: "no-store", signal: AbortSignal.timeout(25_000), redirect: "error" });
    if (!response.ok) throw Error("peer_http_" + response.status);
    const text = await response.text();
    if (Buffer.byteLength(text) > 2 * REPLICATION_MAX_BYTES) throw Error("Peer response too large");
    const result = JSON.parse(text);
    const data = result.data;
    if (!result.ok || data?.protocolVersion !== REPLICATION_VERSION || data.sourceId !== config.peerId || data.targetId !== config.installationId
      || !Array.isArray(data.events) || data.events.length > REPLICATION_BATCH || !Array.isArray(data.users) || data.users.length > REPLICATION_BATCH * 5)
      throw Error("Invalid peer response");
    if ((rowChanges.length || data.events.some((event: { type: string }) => event.type === "row")) && data.rowProtocolVersion !== 1) throw Error("Peer row protocol unavailable");
    if((local.telemetry.length||data.telemetry?.length)&&![3,4].includes(data.userProtocolVersion))throw Error("Peer telemetry protocol unavailable");
    if(data.events.some((event:{type:string})=>["user","contact","identity","telemetry","external"].includes(event.type))&&![1,2,3,4].includes(data.userProtocolVersion))throw Error("Peer user protocol unavailable");
    const cursor = replicationCursor(data.cursor);
    let previous = BigInt(state.cursor);
    for (const event of data.events) {
      const sequence = BigInt(replicationCursor(event.sequence));
      if (sequence <= previous || sequence > BigInt(cursor)) throw Error("Invalid peer event order");
      previous = sequence;
    }
    if (BigInt(cursor) !== previous) throw Error("Invalid peer acknowledgement");
    await write(async (tx) => {
      if(data.telemetry!==undefined&&(!Array.isArray(data.telemetry)||data.telemetry.length>5))throw Error("Invalid peer telemetry");
      await applyPeerEvents(tx, config.peerId, [...data.events,...(data.telemetry||[]).map((observation:any)=>({type:"telemetry",observation}))], data.users, config.installationId);
      await acknowledgeObservations(identityStore(tx),local.telemetry);
      state.telemetryAcks=data.telemetry||[];
      if (rowChanges.length) state.rowSeq = rowChanges.at(-1)!.seq;
      if (operations.length) state.sentSeq = operations.at(-1)!.seq;
      state.cursor = cursor;
      for (const entry of changed) state.hashes[entry.key] = entry.hash;
      const active = data.telemetry?.length || local.telemetry.length || rowChanges.length || operations.length || data.events.length || changed.length;
      if (active) state.activeUntil = now + 120_000;
      const more = data.hasMore || local.rowChanges.length > rowChanges.length || local.operations.length > operations.length || entries.length > changed.length;
      state.caughtUp = await tx.replicaRow.count({ where: { pending: true } }) === 0 && !data.hasMore && local.rowChanges.length <= rowChanges.length && local.operations.length <= operations.length;
      state.nextPoll = now + (more ? 2000 : busReady ? 1800_000 : now < state.activeUntil ? 5000 : 60_000);
      state.retryAt = 0; state.failures = 0; state.lastError = undefined; state.lastSuccess = new Date().toISOString();
      await tx.replicationState.upsert({ where: { key }, create: { key, body: JSON.stringify(state) }, update: { body: JSON.stringify(state) } });
    });
    return { enabled: true, sent: operations.length, sentRows: rowChanges.length, received: data.events.length+(data.telemetry?.length||0), sentTelemetry:local.telemetry.length, directoryItems: changed.length, lastSuccess: state.lastSuccess };
  } catch (error) {
    // Don't log response bodies, message content, credential paths or headers.
    state.failures++; state.retryAt = now + Math.min(300_000, 5000 * 2 ** Math.min(6, state.failures - 1));
    state.lastError = error instanceof Error && /^peer_http_\d+$/.test(error.message) ? error.message : "exchange_failed";
    // Reload the persisted acknowledgement: a failed local commit must never
    // accidentally persist the optimistic cursors modified above.
    const previous = stored ? JSON.parse(stored.body) : { sentSeq: 0, cursor: "0", hashes: {} };
    const failed = { ...state, sentSeq: previous.sentSeq, cursor: previous.cursor, hashes: previous.hashes, rowSeq: previous.rowSeq || 0, telemetryAcks:previous.telemetryAcks||[] };
    await write((tx) => tx.replicationState.upsert({ where: { key }, create: { key, body: JSON.stringify(failed) }, update: { body: JSON.stringify(failed) } }));
    console.error(JSON.stringify({ event: "replication", status: state.lastError, failures: state.failures }));
    return { enabled: true, error: state.lastError, failures: state.failures };
  }
}
