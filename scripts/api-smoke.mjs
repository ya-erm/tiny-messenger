import assert from "node:assert/strict";

const baseUrl = process.env.TEST_BASE_URL || "http://127.0.0.1:3107";

async function api(path, { token, ...init } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`${response.status} ${path}: ${JSON.stringify(body)}`);
  return body.data;
}

const health = await api("/api/health");
assert.equal(health.status, "healthy");

const alice = await api("/api/auth/register", {
  method: "POST",
  body: JSON.stringify({ name: "Аня", nickname: "anya" }),
});
const bob = await api("/api/auth/register", {
  method: "POST",
  body: JSON.stringify({ name: "Боря", nickname: "borya" }),
});
const bobTeam = await api("/api/auth/register", {
  method: "POST",
  body: JSON.stringify({ name: "Команда Бори", nickname: "team.borya" }),
});
assert.equal(alice.user.nickname, "anya");
assert.equal(bob.user.nickname, "borya");

const duplicateNickname = await fetch(`${baseUrl}/api/auth/register`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "Другой Боря", nickname: "borya" }),
});
assert.equal(duplicateNickname.status, 409);

const invalidNickname = await fetch(`${baseUrl}/api/auth/register`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "Некорректный", nickname: "Bad Nick" }),
});
assert.equal(invalidNickname.status, 422);

const foundBob = await api("/api/users?nickname=borya", { token: alice.token });
assert.equal(foundBob.user.id, bob.user.id);

const matchingUsers = await api("/api/users?query=bor", { token: alice.token });
assert.deepEqual(
  matchingUsers.users.map((user) => user.id),
  [bob.user.id, bobTeam.user.id],
);
const selfSearch = await api("/api/users?query=anya", { token: alice.token });
assert.deepEqual(selfSearch.users, []);

const avatarUrl = "https://example.com/bob-avatar.jpg";
const updatedBob = await api("/api/me", {
  token: bob.token,
  method: "PATCH",
  body: JSON.stringify({ name: "Боря", avatarUrl }),
});
assert.equal(updatedBob.user.avatarUrl, avatarUrl);

const created = await api("/api/messages", {
  token: alice.token,
  method: "POST",
  body: JSON.stringify({
    toUserId: bob.user.id,
    text: "Будешь чай?",
    kind: "choice",
    options: [
      { id: "1", label: "Вариант8" },
      { id: "2", label: "Нет" },
    ],
  }),
});
assert.equal(created.message.status, "sent");

const polled = await api("/api/messages/poll", {
  token: bob.token,
  method: "POST",
  body: "{}",
});
assert.equal(polled.messages[0].status, "delivered");

const delivered = await api(`/api/messages/${created.message.id}`, { token: alice.token });
assert.equal(delivered.message.status, "delivered");

const read = await api(`/api/messages/${created.message.id}/status`, {
  token: bob.token,
  method: "PATCH",
  body: JSON.stringify({ status: "read" }),
});
assert.equal(read.message.status, "read");

const answered = await api(`/api/messages/${created.message.id}/answer`, {
  token: bob.token,
  method: "POST",
  body: JSON.stringify({ id: "2" }),
});
assert.equal(answered.message.status, "answered");
assert.equal(answered.message.answer.id, "2");
assert.equal(answered.message.answer.label, "Нет");

const contact = await api("/api/contacts", {
  token: alice.token,
  method: "POST",
  body: JSON.stringify({ identifier: "@borya" }),
});
assert.equal(contact.contact.user.name, "Боря");
assert.equal(contact.contact.user.avatarUrl, avatarUrl);

const legacyContact = await api("/api/contacts", {
  token: alice.token,
  method: "POST",
  body: JSON.stringify({ userId: bob.user.id }),
});
assert.equal(legacyContact.contact.user.id, bob.user.id);

const occupiedNicknameUpdate = await fetch(`${baseUrl}/api/me`, {
  method: "PATCH",
  headers: {
    Authorization: `Bearer ${bob.token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ name: "Боря", nickname: "anya", avatarUrl }),
});
assert.equal(occupiedNicknameUpdate.status, 409);

await api("/api/me", {
  token: bob.token,
  method: "PATCH",
  body: JSON.stringify({ name: "Борис", nickname: "boris", avatarUrl }),
});
const refreshedContacts = await api("/api/contacts", { token: alice.token });
assert.equal(refreshedContacts.contacts[0].user.name, "Борис");
assert.equal(refreshedContacts.contacts[0].user.nickname, "boris");

const oldNickname = await fetch(`${baseUrl}/api/users?nickname=borya`, {
  headers: { Authorization: `Bearer ${alice.token}` },
});
assert.equal(oldNickname.status, 404);
const renamedBob = await api("/api/users?nickname=boris", { token: alice.token });
assert.equal(renamedBob.user.id, bob.user.id);

const syncMessage = await api("/api/messages", {
  token: bob.token,
  method: "POST",
  body: JSON.stringify({
    toUserId: alice.user.id,
    text: "Проверка sync",
    kind: "text",
  }),
});
const synced = await api("/api/sync", {
  token: alice.token,
  method: "POST",
  body: JSON.stringify({ limit: 100 }),
});
assert.equal(synced.contacts[0].user.name, "Борис");
assert.equal(
  synced.messages.find((message) => message.id === syncMessage.message.id).status,
  "delivered",
);

const reset = await api("/api/me/token", {
  token: alice.token,
  method: "POST",
  body: JSON.stringify({ token: "custom-token-must-not-be-used" }),
});
assert.match(reset.token, /^msg_[A-Za-z0-9_-]+$/);
assert.notEqual(reset.token, "custom-token-must-not-be-used");

const oldTokenResponse = await fetch(`${baseUrl}/api/me`, {
  headers: { Authorization: `Bearer ${alice.token}` },
});
assert.equal(oldTokenResponse.status, 401);

const restored = await api("/api/me", { token: reset.token });
assert.equal(restored.user.id, alice.user.id);
assert.equal(restored.user.nickname, "anya");

console.log("API smoke test passed: profile → nickname search → messaging → contacts → sync → token reset");
