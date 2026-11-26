import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { memoryStore } from "./memory-store.mjs";
import { createService } from "../src/service.mjs";
import { createReplication } from "../src/replication.mjs";
import { createHandler } from "../src/handler.mjs";
const secret = "s".repeat(64);
async function fixture() {
  const database = memoryStore(), service = createService(database, "cloud");
  service.exchange = createReplication(database, service, { TM_REPLICATION_PEER: "vps" });
  let initialized = 0;
  const handler = createHandler(async () => { initialized++; return service; }, {
    TM_INSTALLATION_ID: "cloud", TM_REPLICATION_PEER: "vps", TM_REPLICATION_SECRET: secret });
  const call = async (body, headers = { "x-tm-replication-key": secret }) => {
    const response = await handler({ httpMethod: "POST", path: "/api/internal/replication/exchange", headers, body: JSON.stringify(body) });
    return { status: response.statusCode, ...JSON.parse(response.body) };
  };
  const body = { protocolVersion: 1, sourceId: "vps", targetId: "cloud", after: "0", operations: [] };
  return { database, service, call, body, initialized: () => initialized };
}
test("peer authentication happens before storage; no user token can export journals", async () => {
  const { call, body, initialized } = await fixture();
  for (const headers of [{}, { authorization: "Bearer msg_user" }, { "x-tm-replication-key": "wrong" }])
    assert.equal((await call(body, headers)).status, 401);
  assert.equal(initialized(), 0);
});
test("source/target/version, batch/byte bounds and future cursors fail closed", async () => {
  const { call, body } = await fixture();
  for (const change of [{ protocolVersion: 2 }, { sourceId: "other" }, { targetId: "other" },
    { after: "01" }, { after: "18446744073709551616" }, { operations: Array(6).fill({}) }])
    assert.equal((await call({ ...body, ...change })).status, 422);
  assert.equal((await call({ ...body, after: "1" })).status, 409);
  assert.equal((await call({ ...body, extra: "x".repeat(512 * 1024) })).status, 413);
});
test("partially accepted batches replay safely without echoing imports", async () => {
  const { call, body, database, service } = await fixture();
  const now = new Date().toISOString();
  const users = [1, 2].map((id) => ({ id: randomUUID(), name: "Test " + id, tokenHash: String(id).repeat(64), createdAt: now }));
  const create = { protocolVersion: 1, operationId: randomUUID(), deviceId: randomUUID(), actorId: users[0].id,
    occurredAt: now, type: "message.create", message: { id: randomUUID(), fromUserId: users[0].id, toUserId: users[1].id, kind: "text", text: "first", sentAt: now } };
  const directory = { users, contacts: [], receipts: [] };
  const invalid = { ...create, operationId: randomUUID(), message: { ...create.message, id: randomUUID(), toUserId: randomUUID() } };
  assert.equal((await call({ ...body, directory, operations: [create, invalid] })).status, 404);
  assert.equal((await service.message(users[1], create.message.id)).text, "first");
  const replay = await call({ ...body, directory, operations: [create] });
  assert.equal(replay.status, 200); assert.deepEqual(replay.data.events, []);
  assert.equal((await database.transaction((tx) => tx.scan("operations", 20))).length, 1);
});
