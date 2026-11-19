// Uses synthetic YDB-only accounts. Never mutates a real user's messages.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const directory = new URL("../../../.secrets/yandex-cloud/", import.meta.url);
const deployment = JSON.parse(await readFile(new URL("deployment.json", directory), "utf8"));
const users = JSON.parse(await readFile(new URL("test-users.json", directory), "utf8"));
const origin = process.env.TM_CLOUD_TEST_ORIGIN || deployment.gatewayUrl;
assert.ok(origin.startsWith("https://") && !origin.includes("tm.ya-erm.ru") || origin === "https://ch-2.api.tm.ya-erm.ru");
const timings = [];
async function api(path, user, body, expected = 200, method = body === undefined ? "GET" : "POST") {
  const start = performance.now();
  const response = await fetch(origin + path, { method, headers: { "content-type": "application/json", origin: "https://tm.ya-erm.ru",
    ...(user ? { authorization: "Bearer " + user.token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(25_000) });
  timings.push(Math.round(performance.now() - start));
  const result = await response.json();
  assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(result.error || {})}`);
  assert.equal(response.headers.get("access-control-allow-origin"), "https://tm.ya-erm.ru");
  return result.data;
}
const [a, b] = users;
assert.equal((await api("/api/auth/session", a, { token: a.token })).user.id, a.id);
assert.equal((await api("/api/transport")).installationId, "yandex-1");
const before = await api("/api/sync", b, {});
const occurredAt = new Date().toISOString();
const message = { id: randomUUID(), fromUserId: a.id, toUserId: b.id, kind: "text", text: "Автономный контур: проверка", sentAt: occurredAt };
const creation = { protocolVersion: 1, operationId: randomUUID(), actorId: a.id, deviceId: randomUUID(), occurredAt, type: "message.create", message };
await api("/api/mutations", a, creation, 201);
assert.equal((await api("/api/mutations", a, creation)).replayed, true);
const changes = await api("/api/changes", b, { cursor: before.cursor });
assert.ok(changes.changes.some((change) => change.message?.id === message.id));
assert.equal((await api("/api/messages/" + message.id, b)).message.text, message.text);
await api("/api/messages/" + message.id + "/status", b, { status: "read" }, 200, "PATCH");
assert.equal((await api("/api/messages/" + message.id, a)).message.status, "read");
const edit = { ...creation, operationId: randomUUID(), occurredAt: new Date().toISOString(), type: "message.edit", message: { ...message, text: "Обновлённый текст" } };
await api("/api/mutations", a, edit, 201);
await api("/api/mutations", b, { protocolVersion: 1, operationId: randomUUID(), actorId: b.id, deviceId: randomUUID(), occurredAt: new Date().toISOString(),
  type: "reaction.set", reaction: { messageId: message.id, userId: b.id, emoji: "👍" } }, 201);
const updated = (await api("/api/messages/" + message.id, a)).message;
assert.equal(updated.text, edit.message.text); assert.equal(updated.reactions[0].emoji, "👍");
// Leave one message for the next-version/cold-start persistence check.
await writeFile(new URL("remote-proof.json", directory), JSON.stringify({ messageId: message.id, text: edit.message.text, origin }), { mode: 0o600 });
const deletedId = randomUUID();
const second = { ...creation, operationId: randomUUID(), message: { ...message, id: deletedId } };
await api("/api/mutations", a, second, 201);
await api("/api/mutations", b, { protocolVersion: 1, operationId: randomUUID(), actorId: b.id, deviceId: randomUUID(), occurredAt: new Date().toISOString(),
  type: "message.delete", deletion: { messageId: deletedId, scope: "everyone" } }, 201);
await api("/api/mutations", a, { ...edit, operationId: randomUUID(), message: { ...edit.message, id: deletedId } }, 201);
await api("/api/messages/" + deletedId, a, undefined, 404);
await api("/api/mutations", undefined, creation, 401);
const sorted = [...timings].sort((x, y) => x - y);
const result = { independentCloudHttpPassed: true, requests: timings.length, p50Ms: sorted[Math.floor(sorted.length * .5)], p95Ms: sorted[Math.floor(sorted.length * .95)] };
await writeFile(new URL("remote-test-result.json", directory), JSON.stringify(result, null, 2), { mode: 0o600 });
console.log(JSON.stringify(result));
