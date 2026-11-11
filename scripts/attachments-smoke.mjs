import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import dns from "node:dns";

// Deliberately no production URL fallback. The harness starts a fresh test
// database and an HTTPS S3 double with fake credentials.
const base = new URL(process.env.ATTACHMENT_TEST_ORIGIN || "");
assert.equal(base.hostname, "127.0.0.1");
assert.notEqual(base.port, "3000");
const lookup = dns.lookup;
dns.lookup = function (host, options, callback) {
  return lookup.call(this, host === "s3.attachments.test" ? "127.0.0.1" : host, options, callback);
};
const results = [];
async function api(path, token, body, method = body === undefined ? "GET" : "POST", expected = 200) {
  const response = await fetch(new URL(path, base), { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const json = await response.json();
  assert.equal(response.status, expected, `${method} ${path}: ${json.error?.code || response.status}`);
  return json.data;
}
const alice = await api("/api/auth/register", "", { name: "Анна Файлова" }, "POST", 201);
const bob = await api("/api/auth/register", "", { name: "Борис Тестовый" }, "POST", 201);
const eve = await api("/api/auth/register", "", { name: "Ева Тестовая" }, "POST", 201);
await api("/api/attachments/config", "", undefined, "GET", 401);
const { limits } = await api("/api/attachments/config", alice.token);
assert.equal(limits.enabled, true);
results.push("authenticated public configuration");

async function begin(user, chat, name = "Документ.txt", size = 4, clientRequestId = randomUUID(), contentType = "text/plain") {
  return api("/api/attachments/uploads", user.token, { chatKind: chat.kind, chatId: chat.id, name, size, contentType, clientRequestId }, "POST", 201);
}
async function put(upload, bytes, status = 200) {
  const target = new URL(upload.url);
  assert.equal(target.hostname, "s3.attachments.test", "This test must never write to real S3");
  const response = await fetch(target, { method: "PUT", headers: upload.headers, body: bytes });
  assert.equal(response.status, status);
}
async function complete(user, id, expected = 200) { return api(`/api/attachments/uploads/${id}/complete`, user.token, {}, "POST", expected); }
const chat = { kind: "peer", id: bob.user.id };
const requestId = randomUUID();
const started = await begin(alice, chat, "План недели.txt", 4, requestId);
assert.match(new URL(started.upload.url).pathname, /\/staging\/[0-9a-f-]{36}$/);
assert.ok(!started.upload.url.includes(encodeURIComponent("План")));
const signedHeaders = new URL(started.upload.url).searchParams.get("X-Amz-SignedHeaders");
assert.ok(signedHeaders.includes("content-length"));
assert.ok(signedHeaders.includes("content-type"));
assert.equal((await begin(alice, chat, "План недели.txt", 4, requestId)).attachment.id, started.attachment.id);
await complete(eve, started.attachment.id, 404);
await complete(alice, started.attachment.id, 409);
await put(started.upload, Buffer.from("too-long"), 403);
const modifiedMethod = await fetch(started.upload.url, { method: "GET", headers: started.upload.headers });
assert.equal(modifiedMethod.status, 403);
const modifiedKey = new URL(started.upload.url); modifiedKey.pathname += "-other";
assert.equal((await fetch(modifiedKey, { method: "PUT", headers: started.upload.headers, body: "test" })).status, 403);
assert.equal((await fetch(new URL(new URL(started.upload.url).pathname, "https://s3.attachments.test:3112"))).status, 403);
await put(started.upload, Buffer.from("test"));
const completeResponses = await Promise.all([0, 1].map(async () => {
  const response = await fetch(new URL(`/api/attachments/uploads/${started.attachment.id}/complete`, base), { method: "POST", headers: { Authorization: `Bearer ${alice.token}` } });
  assert.ok([200, 409].includes(response.status)); return response.status;
}));
assert.ok(completeResponses.includes(200));
assert.equal((await complete(alice, started.attachment.id)).attachment.id, started.attachment.id);
results.push("UUID keys, signed length, idempotent begin and concurrent complete");

const payload = { toUserId: bob.user.id, text: "", attachmentIds: [started.attachment.id], clientRequestId: randomUUID() };
await api("/api/messages", eve.token, payload, "POST", 409);
const { message } = await api("/api/messages", alice.token, payload, "POST", 201);
assert.equal(message.attachments[0].originalName, "План недели.txt");
const repeated = await Promise.all([1, 2].map(() => api("/api/messages", alice.token, payload, "POST", 201)));
assert.ok(repeated.every((result) => result.message.id === message.id));
await api("/api/messages", alice.token, { ...payload, text: "changed" }, "POST", 409);
await api("/api/messages", alice.token, { ...payload, clientRequestId: randomUUID() }, "POST", 409);
await api(`/api/attachments/${started.attachment.id}/url`, eve.token, undefined, "GET", 404);
const readable = await api(`/api/attachments/${started.attachment.id}/url`, bob.token);
assert.equal(new URL(readable.url).hostname, "s3.attachments.test");
assert.ok(new URL(readable.url).searchParams.get("response-content-disposition").includes(encodeURIComponent("План недели.txt")));
assert.equal(await (await fetch(readable.url)).text(), "test");
await put(started.upload, Buffer.from("evil"));
assert.equal(await (await fetch(readable.url)).text(), "test");
await api(`/api/attachments/uploads/${started.attachment.id}`, alice.token, undefined, "DELETE", 409);
results.push("atomic file-only send, send retries, foreign access and immutable final copy");

await api("/api/messages", bob.token, { ids: [message.id], scope: "me" }, "DELETE");
await api(`/api/attachments/${started.attachment.id}/url`, bob.token, undefined, "GET", 404);
await api(`/api/attachments/${started.attachment.id}/url`, alice.token);
results.push("delete for me revokes only that reader");

const { group } = await api("/api/groups", alice.token, { name: "Файлы команды", memberIds: [bob.user.id] }, "POST", 201);
const groupUpload = await begin(alice, { kind: "group", id: group.id });
await put(groupUpload.upload, Buffer.from("team")); await complete(alice, groupUpload.attachment.id);
await api("/api/messages", alice.token, { toUserId: bob.user.id, text: "", attachmentIds: [groupUpload.attachment.id] }, "POST", 409);
const groupPayload = { groupId: group.id, text: "", attachmentIds: [groupUpload.attachment.id], clientRequestId: randomUUID() };
const groupSent = await api("/api/group-messages", alice.token, groupPayload, "POST", 201);
assert.equal((await api("/api/group-messages", alice.token, groupPayload, "POST", 201)).message.id, groupSent.message.id);
await api(`/api/attachments/${groupUpload.attachment.id}/url`, bob.token);
await api(`/api/groups/${group.id}`, bob.token, undefined, "DELETE");
await api(`/api/attachments/${groupUpload.attachment.id}/url`, bob.token, undefined, "GET", 404);
await api(`/api/attachments/${groupUpload.attachment.id}/url`, alice.token);
results.push("group files, chat binding and removed group member");

const canceled = await begin(alice, chat);
await api(`/api/attachments/uploads/${canceled.attachment.id}`, eve.token, undefined, "DELETE", 404);
await api(`/api/attachments/uploads/${canceled.attachment.id}`, alice.token, undefined, "DELETE");
await complete(alice, canceled.attachment.id, 410);
await api("/api/attachments/uploads", alice.token, { chatKind: "peer", chatId: bob.user.id, name: "large", size: limits.maxFileBytes + 1, clientRequestId: randomUUID() }, "POST", 413);
results.push("cancellation and server-side size limit");
const plain = await api("/api/messages", alice.token, { toUserId: bob.user.id, text: "Обычное сообщение" }, "POST", 201);
assert.equal(plain.message.text, "Обычное сообщение");
results.push("existing text API");
console.log(JSON.stringify({ passed: true, checks: results }));
