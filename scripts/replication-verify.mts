import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { PATCH as markStatus } from "../src/app/api/messages/[id]/status/route";
import { POST as pollMessages } from "../src/app/api/messages/poll/route";
import { prisma, read, write } from "../src/lib/db";
import { acceptMutation } from "../src/lib/mutations/accept";
import { synchronizeInstallations } from "../src/lib/replication/synchronize";
import { prepareHistory, historyId } from "../src/lib/replication/history";
import { publicMessage } from "../src/lib/domain";
import { messageInclude, toMessageRecord, readStatesForChat, advanceReadState } from "../src/lib/store";
import { memoryStore } from "../cloud/yandex/tests/memory-store.mjs";
import { createService } from "../cloud/yandex/src/service.mjs";
import { createReplication } from "../cloud/yandex/src/replication.mjs";
import { createHandler } from "../cloud/yandex/src/handler.mjs";

const directory = await mkdtemp(tmpdir() + "/tm-replication-");
const nativeFetch = globalThis.fetch;
let requests = 0, loseReply = false, fail = false;
const now = new Date().toISOString();
const tokens = [randomUUID(), randomUUID(), randomUUID()];
const users = ["Автор", "Получатель", "Третий"].map((name, index) => ({ id: randomUUID(), name, createdAt: now, updatedAt: now,
  tokenHash: createHash("sha256").update(tokens[index]).digest("hex") }));
const database = memoryStore(), cloud = createService(database, "test-cloud");
cloud.exchange = createReplication(database, cloud, { TM_REPLICATION_PEER: "test-vps" });
const secret = "k".repeat(64);
const handler = createHandler(async () => cloud, { TM_INSTALLATION_ID: "test-cloud", TM_REPLICATION_SECRET: secret, TM_REPLICATION_PEER: "test-vps" });
const envelope = (actorId = users[0].id, occurredAt = now) => ({ protocolVersion: 1 as const, operationId: randomUUID(), actorId, deviceId: randomUUID(), occurredAt });
const creation = (text: string, at = now) => ({ ...envelope(users[0].id, at), type: "message.create" as const,
  message: { id: randomUUID(), fromUserId: users[0].id, toUserId: users[1].id, kind: "text" as const, text, sentAt: at } });
const checkpoint = () => read(async (db) => { const row = await db.replicationState.findUnique({ where: { key: "peer:test-cloud" } }); return row ? JSON.parse(row.body) : undefined; });
async function force() {
  await write(async (tx) => {
    const row = await tx.replicationState.findUnique({ where: { key: "peer:test-cloud" } });
    if (row) { const state = JSON.parse(row.body); state.nextPoll = 0; state.retryAt = 0; await tx.replicationState.update({ where: { key: row.key }, data: { body: JSON.stringify(state) } }); }
  });
  const result = await synchronizeInstallations() as any;
  assert.equal(result.error, undefined, JSON.stringify(result)); return result;
}
async function drain() { for (let index = 0; index < 30; index++) { const result = await force(); if (!result.sent && !result.received && !result.directoryItems) return; } throw Error("Replication did not converge"); }
async function localMessage(id: string) {
  return read(async (db) => { const row = await db.message.findUnique({ where: { id }, include: messageInclude });
    return row && publicMessage(toMessageRecord(row), await readStatesForChat(db, row.fromUserId)); });
}
try {
  await writeFile(directory + "/bootstrap.json", JSON.stringify({ formatVersion: 1, createdAt: now, messages: [], operations: [], deletions: [] }));
  await writeFile(directory + "/config.json", JSON.stringify({ url: "https://cloud.example/api/internal/replication/exchange", secret,
    peerId: "test-cloud", installationId: "test-vps", bootstrapFile: directory + "/bootstrap.json" }));
  process.env.TM_REPLICATION_CONFIG = directory + "/config.json";
  await write(async (tx) => {
    for (const user of users) await tx.user.create({ data: user });
    await tx.contact.create({ data: { ownerId: users[0].id, userId: users[1].id, createdAt: now, updatedAt: now } });
  });
  globalThis.fetch = (async (url, init) => {
    assert.equal(String(url), "https://cloud.example/api/internal/replication/exchange"); requests++;
    if (fail) throw Error("Network unavailable");
    const response = await handler({ httpMethod: "POST", path: "/api/internal/replication/exchange", headers: init?.headers, body: init?.body });
    if (loseReply) { loseReply = false; throw Error("Reply lost after commit"); }
    return new Response(response.body, { status: response.statusCode, headers: response.headers });
  }) as typeof fetch;
  // Service credentials are required before touching the storage provider.
  for (const headers of [{}, { authorization: "Bearer user-token" }, { "x-tm-replication-key": "wrong" }])
    assert.equal((await handler({ httpMethod: "POST", path: "/api/internal/replication/exchange", headers, body: "{}" })).statusCode, 401);
  await drain();
  assert.equal((await cloud.contacts(users[0])).length, 1);
  assert.equal((await cloud.snapshot(users[0])).messages.length, 0);
  const beforeIdle = requests;
  await synchronizeInstallations(); await synchronizeInstallations();
  assert.equal(requests, beforeIdle, "Idle checks must not wake the cloud");

  const a = creation("VPS → облако"), b = creation("Облако → VPS");
  await write((tx) => acceptMutation(tx, a, users[0]));
  await cloud.mutate(users[0], b);
  await drain();
  assert.equal((await cloud.message(users[1], a.message.id)).text, a.message.text);
  assert.equal((await localMessage(b.message.id))?.text, b.message.text);
  const count = await read((db) => db.mutationOperation.count());
  await drain(); assert.equal(await read((db) => db.mutationOperation.count()), count, "No echo duplication");

  const early = { ...a, ...envelope(users[0].id, "2026-11-26T08:00:01.000Z"), type: "message.edit" as const, message: { ...a.message, text: "Ранняя" } };
  const late = { ...early, ...envelope(users[0].id, "2026-11-26T08:00:02.000Z"), message: { ...a.message, text: "Поздняя" } };
  await write((tx) => acceptMutation(tx, late, users[0])); await cloud.mutate(users[0], early); await drain();
  assert.equal((await localMessage(a.message.id))?.text, "Поздняя"); assert.equal((await cloud.message(users[1], a.message.id)).text, "Поздняя");
  const reaction = { ...envelope(users[1].id), type: "reaction.set" as const, reaction: { messageId: a.message.id, userId: users[1].id, emoji: "👍" } };
  await cloud.mutate(users[1], reaction); await drain();
  assert.deepEqual((await localMessage(a.message.id))?.reactions, [{ userId: users[1].id, emoji: "👍" }]);
  const deletion = { ...envelope(users[1].id), type: "message.delete" as const, deletion: { messageId: a.message.id, scope: "everyone" as const } };
  await write((tx) => acceptMutation(tx, deletion, users[1])); await cloud.mutate(users[0], { ...late, operationId: randomUUID() }); await drain();
  assert.equal(await localMessage(a.message.id), null); await assert.rejects(cloud.message(users[0], a.message.id), (error: any) => error.status === 404);

  await cloud.receipt(users[1], b.message.id, "read"); await drain();
  assert.equal((await localMessage(b.message.id))?.status, "read");
  const old = creation("Старое, но новое для получателя", "2020-01-01T00:00:00.000Z");
  await cloud.mutate(users[0], old); await drain();
  assert.equal((await localMessage(old.message.id))?.status, "sent", "Explicit receipts must not read late history");
  await write((tx) => advanceReadState(tx, users[1].id, users[0].id, { readAt: old.message.sentAt, deliveredAt: old.message.sentAt })); await drain();
  assert.equal((await cloud.message(users[0], old.message.id)).status, "read");

  // A pre-existing VPS watermark must not read a late imported message.
  await write((tx) => advanceReadState(tx, users[1].id, users[0].id, { readAt: now, deliveredAt: now }));
  const lateHistory = creation("Поздняя история после watermark", "1999-01-01T00:00:00.000Z");
  await cloud.mutate(users[0], lateHistory); await drain();
  assert.equal((await localMessage(lateHistory.message.id))?.status, "sent");
  assert.equal((await cloud.message(users[0], lateHistory.message.id)).status, "sent");
  await write((tx) => advanceReadState(tx, users[1].id, users[0].id, { deliveredAt: lateHistory.message.sentAt }));
  assert.equal((await localMessage(lateHistory.message.id))?.status, "delivered");
  await write((tx) => advanceReadState(tx, users[1].id, users[0].id, { readAt: lateHistory.message.sentAt })); await drain();
  assert.equal((await localMessage(lateHistory.message.id))?.status, "read");
  assert.equal((await cloud.message(users[0], lateHistory.message.id)).status, "read");

  const throughApi = creation("Через старые HTTP API", "1998-01-01T00:00:00.000Z");
  await cloud.mutate(users[0], throughApi); await drain();
  const polled = await pollMessages(new Request("https://vps.example/api/messages/poll", { method: "POST",
    headers: { authorization: "Bearer " + tokens[1], "content-type": "application/json" }, body: JSON.stringify({ limit: 100, includeDeliveredUnread: false }) }));
  assert.equal(polled.status, 200);
  const received = (await polled.json()).data.messages.find((message: any) => message.id === throughApi.message.id);
  assert.equal(received?.status, "delivered"); assert.equal(received?.receiptStatus, undefined);
  const marked = await markStatus(new Request("https://vps.example/api/messages/" + throughApi.message.id + "/status", { method: "PATCH",
    headers: { authorization: "Bearer " + tokens[1], "content-type": "application/json" }, body: JSON.stringify({ status: "read" }) }),
    { params: Promise.resolve({ id: throughApi.message.id }) });
  assert.equal(marked.status, 200); assert.equal((await marked.json()).data.message.status, "read"); await drain();
  assert.equal((await cloud.message(users[0], throughApi.message.id)).status, "read");

  const lost = creation("Ответ потерялся"); await write((tx) => acceptMutation(tx, lost, users[0]));
  const beforeLost = await checkpoint(); loseReply = true;
  const failed = await synchronizeInstallations() as any;
  assert.equal(failed.error, "exchange_failed"); assert.equal((await checkpoint()).sentSeq, beforeLost.sentSeq);
  const afterFailure = requests; await synchronizeInstallations(); assert.equal(requests, afterFailure, "Backoff respected despite pending sends");
  await drain(); assert.equal((await cloud.message(users[1], lost.message.id)).text, lost.message.text);

  await write(async (tx) => {
    await tx.user.update({ where: { id: users[0].id }, data: { name: "Новое имя", tokenHash: "a".repeat(64) } });
    await tx.contact.deleteMany({ where: { ownerId: users[0].id } });
  }); await drain();
  assert.equal((await database.transaction((tx) => tx.get("users", users[0].id))).name, "Новое имя");
  assert.equal((await database.transaction((tx) => tx.get("users", users[0].id))).tokenHash, "a".repeat(64));
  assert.equal((await cloud.contacts(users[0])).length, 0);

  // Pending invalid changes can later become rejected. Trusted replicas keep
  // that fact in the journal instead of blocking every following batch.
  const pending = creation("Основа после правки");
  const invalid = { ...pending, ...envelope(users[2].id), type: "message.delete" as const, deletion: { messageId: pending.message.id, scope: "everyone" as const } };
  delete (invalid as any).message;
  await cloud.mutate(users[2], invalid); await cloud.mutate(users[0], pending); await drain();
  assert.equal((await localMessage(pending.message.id))?.text, pending.message.text);

  // Recover after complete network outage; VPS stays usable throughout.
  fail = true; const disconnected = creation("Без облака"); await write((tx) => acceptMutation(tx, disconnected, users[0]));
  assert.equal((await synchronizeInstallations() as any).error, "exchange_failed");
  assert.equal((await localMessage(disconnected.message.id))?.text, disconnected.message.text);
  fail = false; await drain(); assert.equal((await cloud.message(users[1], disconnected.message.id)).text, disconnected.message.text);

  // Existing bootstrap IDs must match the original seed exactly; reconcile a
  // VPS deletion rather than bringing an old message back to life.
  const removed = creation("Удалено до включения обмена");
  const historical = { ...removed.message, reactions: [] };
  await write(async (tx) => {
    const result = await prepareHistory(tx, { formatVersion: 1, createdAt: now, messages: [historical], deletions: [], operations: [] }, now);
    assert.equal(result.adopted, 1);
    assert.equal(await tx.message.count({ where: { id: removed.message.id } }), 0);
    assert.ok(await tx.mutationOperation.findUnique({ where: { operationId: historyId("create:" + removed.message.id) } }));
  }); await drain(); await assert.rejects(cloud.message(users[0], removed.message.id), (error: any) => error.status === 404);
  console.log(JSON.stringify({ bidirectional: true, conflictConvergence: true, reactions: true, deletionDominance: true,
    explicitReceipts: true, directoryUpdates: true, lostAcknowledgement: true, offlineRecovery: true,
    rejectedDependencies: true, historyDeletion: true, idleNoCloudCalls: true, serviceAuth: true, requests }));
} finally {
  globalThis.fetch = nativeFetch;
  await prisma.$disconnect(); await rm(directory, { recursive: true, force: true });
}
