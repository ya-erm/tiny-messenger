import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

const baseUrl = process.env.TEST_BASE_URL || "http://127.0.0.1:3107";
const wsUrl = process.env.TEST_WS_URL || `${baseUrl.replace(/^http/, "ws")}/ws`;

async function api(path, { token, expectedStatus = 200, ...init } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(token ? { "X-API-Key": token } : {}) },
  });
  const body = await response.json();
  assert.equal(response.status, expectedStatus, `${path}: ${JSON.stringify(body)}`);
  if (expectedStatus >= 400) {
    assert.equal(body.ok, false);
    return body.error;
  }
  assert.equal(body.ok, true);
  return body.data;
}

async function register(name) {
  return api("/api/auth/register", { method: "POST", expectedStatus: 201, body: JSON.stringify({ name }) });
}

const alice = await register("Реакции Аня");
const bob = await register("Реакции Боря");
const outsider = await register("Реакции Гость");
const { message } = await api("/api/messages", {
  token: alice.token, method: "POST", expectedStatus: 201,
  body: JSON.stringify({ toUserId: bob.user.id, kind: "text", text: "Привет!" }),
});
assert.deepEqual(message.reactions, []);
const directPath = `/api/messages/${message.id}/reaction`;

async function react(path, account, emoji, expectedStatus = 200) {
  return api(path, { token: account?.token, method: "PUT", expectedStatus, body: JSON.stringify({ emoji }) });
}

assert.equal((await react(directPath, null, "👍", 401)).code, "missing_token");
assert.equal((await react(directPath, outsider, "👍", 404)).code, "message_not_found");
for (const emoji of ["", "invalid", "👍👍", "x👍", "👍x", "👍 ", "1", "🇷", "👨‍invalid", "a".repeat(100), 7, {}, undefined]) {
  assert.equal((await react(directPath, bob, emoji, 422)).code, "invalid_reaction");
}
for (const emoji of ["💩", "🫩", "🐈", "👍🏽", "🧑🏽‍💻", "👨‍👩‍👧‍👦", "🇷🇸", "1️⃣", "🏳️‍🌈"]) {
  assert.deepEqual((await react(directPath, bob, emoji)).reactions, [{ userId: bob.user.id, emoji }]);
}
await react(directPath, bob, "👍");
const repeated = await react(directPath, bob, "👍");
assert.deepEqual(repeated.reactions, [{ userId: bob.user.id, emoji: "👍" }]);
const beforeRead = await api(`/api/messages/${message.id}`, { token: alice.token });
assert.equal(beforeRead.message.status, "sent", "a reaction must not advance read/delivery watermarks");
assert.deepEqual(beforeRead.message.reactions, repeated.reactions);
const replaced = await react(directPath, bob, "❤️");
assert.deepEqual(replaced.reactions, [{ userId: bob.user.id, emoji: "❤️" }]);
const shared = await react(directPath, alice, "❤️");
assert.equal(shared.reactions.length, 2);
assert.ok(shared.reactions.every((reaction) => reaction.emoji === "❤️"));
const poll = await api("/api/messages/poll", { token: bob.token, method: "POST", body: "{}" });
assert.deepEqual(poll.messages.find((item) => item.id === message.id).reactions, shared.reactions);
const sync = await api("/api/sync", { token: alice.token, method: "POST", body: "{}" });
assert.deepEqual(sync.messages.find((item) => item.id === message.id).reactions, shared.reactions);
const cleared = await react(directPath, bob, null);
assert.deepEqual(cleared.reactions, [{ userId: alice.user.id, emoji: "❤️" }]);
assert.deepEqual((await react(directPath, bob, null)).reactions, cleared.reactions);
await Promise.all([react(directPath, bob, "😂"), react(directPath, bob, "🔥")]);
const concurrent = await api(`/api/messages/${message.id}`, { token: bob.token });
assert.equal(concurrent.message.reactions.filter((reaction) => reaction.userId === bob.user.id).length, 1);

// The device adapter uses the same authorized, idempotent REST mutation.
const socket = new WebSocket(wsUrl, { headers: { "X-API-Key": bob.token } });
function waitFor(predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("WebSocket event timeout")); }, 10_000);
    const onMessage = (raw) => {
      const frame = JSON.parse(raw.toString());
      if (predicate(frame)) { cleanup(); resolve(frame); }
    };
    const onError = (error) => { cleanup(); reject(error); };
    function cleanup() {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("error", onError);
    }
    socket.on("message", onMessage);
    socket.on("error", onError);
  });
}
try {
  await waitFor((frame) => frame.type === "ready");
  for (const emoji of ["😮", null]) {
    const requestId = randomUUID();
    const ack = waitFor((frame) => frame.type === "ack" && frame.requestId === requestId);
    socket.send(JSON.stringify({ type: "reaction", requestId, messageId: message.id, emoji }));
    assert.equal((await ack).ok, true);
    const saved = await api(`/api/messages/${message.id}`, { token: alice.token });
    assert.equal(saved.message.reactions.find((reaction) => reaction.userId === bob.user.id)?.emoji ?? null, emoji);
  }
} finally {
  socket.close();
}

const { message: question } = await api("/api/messages", {
  token: alice.token, method: "POST", expectedStatus: 201,
  body: JSON.stringify({
    toUserId: bob.user.id, kind: "choice", text: "Чай?",
    options: [{ id: "yes", label: "Да" }, { id: "no", label: "Нет" }],
  }),
});
await react(`/api/messages/${question.id}/reaction`, bob, "👍");
const answered = await api(`/api/messages/${question.id}/answer`, {
  token: bob.token, method: "POST", body: JSON.stringify({ id: "yes" }),
});
assert.equal(answered.message.answer.id, "yes");
assert.equal(answered.message.reactions[0].emoji, "👍");

const { group } = await api("/api/groups", {
  token: alice.token, method: "POST", expectedStatus: 201,
  body: JSON.stringify({ name: "Проверка реакций", memberIds: [bob.user.id] }),
});
const { message: groupMessage } = await api("/api/group-messages", {
  token: alice.token, method: "POST", expectedStatus: 201,
  body: JSON.stringify({ groupId: group.id, text: "Всем привет!" }),
});
assert.deepEqual(groupMessage.reactions, []);
const groupPath = `/api/group-messages/${groupMessage.id}/reaction`;
await react(groupPath, outsider, "👍", 404);
await react(groupPath, bob, "invalid", 422);
await react(groupPath, bob, "🧑🏽‍💻");
await react(groupPath, bob, "👍");
assert.equal((await react(groupPath, bob, "👍")).reactions.length, 1);
await react(groupPath, bob, "🔥");
const groupReactions = (await react(groupPath, alice, "🔥")).reactions;
assert.equal(groupReactions.length, 2);
const history = await api(`/api/group-messages?groupId=${group.id}`, { token: bob.token });
assert.deepEqual(history.messages[0].reactions, groupReactions);
const groupSync = await api("/api/sync", { token: bob.token, method: "POST", body: "{}" });
assert.deepEqual(groupSync.groupMessages.find((item) => item.id === groupMessage.id).reactions, groupReactions);
const edited = await api(`/api/group-messages/${groupMessage.id}`, {
  token: alice.token, method: "PATCH", body: JSON.stringify({ text: "Привет всем!" }),
});
assert.deepEqual(edited.message.reactions, groupReactions);
const read = await api(`/api/group-messages/${groupMessage.id}/status`, {
  token: bob.token, method: "PATCH", body: JSON.stringify({ status: "read" }),
});
assert.deepEqual(read.message.reactions, groupReactions);
const { message: hiddenGroupMessage } = await api("/api/group-messages", {
  token: alice.token, method: "POST", expectedStatus: 201,
  body: JSON.stringify({ groupId: group.id, text: "Скрытое сообщение" }),
});
await api(`/api/group-messages/${hiddenGroupMessage.id}`, {
  token: bob.token, method: "DELETE", body: JSON.stringify({ scope: "me" }),
});
await react(`/api/group-messages/${hiddenGroupMessage.id}/reaction`, bob, "👍", 404);
assert.equal((await react(groupPath, bob, null)).reactions.length, 1);
await api(`/api/groups/${group.id}`, { token: bob.token, method: "DELETE" });
await react(groupPath, bob, "👍", 404);

await api(`/api/messages/${message.id}`, {
  token: bob.token, method: "DELETE", body: JSON.stringify({ scope: "me" }),
});
await react(directPath, bob, "👍", 404);
await react(directPath, alice, "😢");
await api(`/api/messages/${message.id}`, {
  token: alice.token, method: "DELETE", body: JSON.stringify({ scope: "everyone" }),
});
await react(directPath, alice, "👍", 404);
await api(`/api/group-messages/${groupMessage.id}`, {
  token: alice.token, method: "DELETE", body: JSON.stringify({ scope: "everyone" }),
});
await react(groupPath, alice, "👍", 404);
await react(`/api/messages/${randomUUID()}/reaction`, alice, "👍", 404);
await react("/api/messages/not-a-uuid/reaction", alice, "👍", 400);

console.log("Reactions smoke test passed: arbitrary Unicode emoji + skin tones/ZWJ/flags, direct + choice + group, replace/remove, sync/poll, permissions, deletion, concurrency, device WebSocket");
