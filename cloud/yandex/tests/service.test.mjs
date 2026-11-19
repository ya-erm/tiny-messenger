import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { memoryStore } from "./memory-store.mjs";
import { createService } from "../src/service.mjs";
import { createHandler } from "../src/handler.mjs";

async function fixture() {
  const database = memoryStore();
  const users = ["Автор", "Получатель", "Посторонний"].map((name) => ({ id: randomUUID(), name, createdAt: new Date().toISOString(), token: "msg_" + randomUUID() }));
  for (const user of users) {
    user.tokenHash = createHash("sha256").update(user.token).digest("hex");
    await database.transaction(async (tx) => {
      const { token, ...stored } = user; await tx.put("users", user.id, stored);
      await tx.put("tokens", user.tokenHash, { userId: user.id });
    });
  }
  const service = createService(database, "test-cloud");
  const handler = createHandler(async () => service, { TM_INSTALLATION_ID: "test-cloud", TM_ALLOWED_ORIGINS: "https://tm.example" });
  const call = async (method, path, body, user = users[0], headers = {}) => {
    const response = await handler({ httpMethod: method, url: path, headers: { authorization: `Bearer ${user.token}`, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.statusCode, headers: response.headers, ...response.body && JSON.parse(response.body) };
  };
  function create() {
    const occurredAt = new Date().toISOString();
    return { protocolVersion: 1, operationId: randomUUID(), actorId: users[0].id, deviceId: randomUUID(), occurredAt,
      type: "message.create", message: { id: randomUUID(), fromUserId: users[0].id, toUserId: users[1].id, kind: "text", text: "Облако", sentAt: occurredAt } };
  }
  return { database, users, service, call, create };
}

test("HTTP auth/CORS/body limits and public users never expose credential data", async () => {
  const { call, users, create } = await fixture();
  assert.equal((await call("OPTIONS", "/api/mutations", undefined, users[0], { origin: "https://tm.example" })).status, 204);
  assert.equal((await call("OPTIONS", "/api/mutations", undefined, users[0], { origin: "https://other.example" })).status, 403);
  assert.equal((await call("GET", "/api/me", undefined, users[0], { authorization: "" })).status, 401);
  const me = await call("GET", "/api/me");
  assert.equal(me.data.user.id, users[0].id);
  assert.equal(me.data.user.tokenHash, undefined);
  const restored = await call("POST", "/api/auth/session", { token: users[1].token });
  assert.equal(restored.data.user.id, users[1].id);
  assert.equal((await call("POST", "/api/mutations", { ...create(), garbage: "x".repeat(17000) })).status, 413);
});

test("snapshot plus cursor covers mutations, pagination and receipts without leaking another inbox", async () => {
  const { call, users, create, service } = await fixture();
  const before = (await call("POST", "/api/sync", {})).data;
  const operations = [create(), create()];
  for (const operation of operations) assert.equal((await call("POST", "/api/mutations", operation)).status, 201);
  const first = (await call("POST", "/api/changes", { cursor: before.cursor, limit: 1 })).data;
  assert.equal(first.changes.length, 1); assert.equal(first.hasMore, true);
  const second = (await call("POST", "/api/changes", { cursor: first.cursor })).data;
  assert.equal(second.changes.length, 1); assert.equal(second.hasMore, false);
  assert.deepEqual((await service.changes(users[2], before.cursor)).changes, []);
  assert.equal((await call("POST", "/api/changes", { cursor: "vps-1:0" })).status, 409);
  const seen = operations[0].message.id;
  assert.equal((await call("PATCH", `/api/messages/${seen}/status`, { status: "read" }, users[1])).status, 200);
  const received = (await call("POST", "/api/sync", {}, users[0])).data.messages;
  assert.equal(received.find((message) => message.id === seen).status, "read");
  const late = create(); late.occurredAt = late.message.sentAt = "2020-01-01T00:00:00.000Z";
  await call("POST", "/api/mutations", late);
  assert.equal((await service.message(users[0], late.message.id)).status, "sent");
});

test("dependency, replay, delete dominance, read-only history and participant checks", async () => {
  const { call, users, create, database, service } = await fixture();
  const creation = create();
  const edit = { ...creation, operationId: randomUUID(), type: "message.edit", message: { ...creation.message, text: "Исправлено" } };
  assert.equal((await call("POST", "/api/mutations", edit)).status, 202);
  assert.equal((await call("POST", "/api/mutations", creation)).status, 201);
  assert.equal((await service.message(users[1], creation.message.id)).text, "Исправлено");
  const duplicate = await call("POST", "/api/mutations", creation);
  assert.equal(duplicate.status, 200); assert.equal(duplicate.data.replayed, true);
  assert.equal((await call("POST", "/api/mutations", { ...creation, message: { ...creation.message, text: "Подмена" } })).status, 409);
  const deletion = { protocolVersion: 1, operationId: randomUUID(), actorId: users[2].id, deviceId: randomUUID(), occurredAt: new Date().toISOString(),
    type: "message.delete", deletion: { messageId: creation.message.id, scope: "everyone" } };
  assert.equal((await call("POST", "/api/mutations", deletion, users[2])).status, 403);
  deletion.actorId = users[0].id;
  assert.equal((await call("POST", "/api/mutations", deletion)).status, 201);
  assert.equal((await call("POST", "/api/mutations", { ...edit, operationId: randomUUID() })).status, 201);
  assert.equal((await call("GET", `/api/messages/${creation.message.id}`)).status, 404);
  const archived = { ...create().message, senderName: users[0].name, reactions: [], reply: { id: randomUUID(), available: true, text: "Скрытая цитата" } };
  await database.transaction(async (tx) => { await tx.put("states", archived.id, { archive: archived }); await tx.putView(users[0].id, archived); });
  assert.equal((await call("GET", `/api/messages/${archived.id}`, undefined, users[1])).status, 404);
  assert.equal((await call("GET", `/api/messages/${archived.id}`)).data.message.reply.text, "Скрытая цитата");
});

test("failed transaction does not leave a journal entry or partial feed", async () => {
  const { database, users, create, service } = await fixture();
  const operation = create();
  const failed = { transaction: (callback, options) => database.transaction(async (tx) => {
    const result = await callback(tx); if (!options?.readOnly) throw Error("crash before commit"); return result;
  }, options) };
  await assert.rejects(createService(failed).mutate(users[0], operation), /crash/);
  assert.deepEqual((await service.snapshot(users[0])).messages, []);
  assert.equal(await database.transaction((tx) => tx.get("operations", operation.operationId)), undefined);
});
