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

const pushConfiguration = await api("/api/push", { token: alice.token });
assert.equal(typeof pushConfiguration.configured, "boolean");
assert.equal(typeof pushConfiguration.publicKey, "string");
assert.equal(pushConfiguration.subscriptionCount, 0);
const rtcConfiguration = await api("/api/rtc/config", { token: alice.token });
assert.equal(Array.isArray(rtcConfiguration.iceServers), true);
assert.equal(rtcConfiguration.iceCandidatePoolSize, 1);
if (pushConfiguration.configured) {
  const testSubscription = {
    endpoint: "https://push.example.test/subscriptions/api-smoke",
    expirationTime: null,
    keys: { p256dh: "test-p256dh", auth: "test-auth" },
  };
  const subscribed = await api("/api/push", {
    token: alice.token,
    method: "POST",
    body: JSON.stringify({ subscription: testSubscription }),
  });
  assert.equal(subscribed.subscribed, true);
  const pushConfigurationAfterSubscribe = await api("/api/push", { token: alice.token });
  assert.equal(pushConfigurationAfterSubscribe.subscriptionCount, 1);
  const unsubscribed = await api("/api/push", {
    token: alice.token,
    method: "DELETE",
    body: JSON.stringify({ endpoint: testSubscription.endpoint }),
  });
  assert.equal(unsubscribed.subscribed, false);
}

const suggestedUsers = await api("/api/users?query=", { token: alice.token });
assert.equal(suggestedUsers.users.length, 2);
assert.ok(suggestedUsers.users.every((user) => user.id !== alice.user.id && user.nickname));

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
const matchingByName = await api("/api/users?query=%D0%9A%D0%BE%D0%BC%D0%B0%D0%BD%D0%B4%D0%B0", { token: alice.token });
assert.deepEqual(matchingByName.users.map((user) => user.id), [bobTeam.user.id]);
const matchingByUuid = await api(`/api/users?query=${bob.user.id}`, { token: alice.token });
assert.deepEqual(matchingByUuid.users.map((user) => user.id), [bob.user.id]);
const selfSearch = await api("/api/users?query=anya", { token: alice.token });
assert.deepEqual(selfSearch.users, []);

const avatarUrl = "https://example.com/bob-avatar.jpg";
const avatarBackground = "#DCEBFA";
const updatedBob = await api("/api/me", {
  token: bob.token,
  method: "PATCH",
  body: JSON.stringify({ name: "Боря", avatarUrl, avatarBackground }),
});
assert.equal(updatedBob.user.avatarUrl, avatarUrl);
assert.equal(updatedBob.user.avatarBackground, avatarBackground);

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

// Receipts are a watermark: reading the newer message reads the older one too.
const olderText = await api("/api/messages", {
  token: alice.token,
  method: "POST",
  body: JSON.stringify({ toUserId: bob.user.id, text: "Первое", kind: "text" }),
});
const newerText = await api("/api/messages", {
  token: alice.token,
  method: "POST",
  body: JSON.stringify({ toUserId: bob.user.id, text: "Второе", kind: "text" }),
});
await api(`/api/messages/${newerText.message.id}/status`, {
  token: bob.token,
  method: "PATCH",
  body: JSON.stringify({ status: "read" }),
});
const olderAfterWatermark = await api(`/api/messages/${olderText.message.id}`, { token: alice.token });
assert.equal(olderAfterWatermark.message.status, "read");
const bobPending = await api("/api/messages/poll", { token: bob.token, method: "POST", body: "{}" });
assert.ok(!bobPending.messages.some((message) => message.id === olderText.message.id));

const contact = await api("/api/contacts", {
  token: alice.token,
  method: "POST",
  body: JSON.stringify({ identifier: "@borya" }),
});
assert.equal(contact.contact.user.name, "Боря");
assert.equal(contact.contact.user.avatarUrl, avatarUrl);
assert.equal(contact.contact.user.avatarBackground, avatarBackground);

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
assert.equal(refreshedContacts.contacts[0].user.avatarBackground, avatarBackground);

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
assert.ok(synced.readStates.some((state) => state.chatId === bob.user.id && state.lastDeliveredAt));
assert.deepEqual(synced.groups, []);
assert.deepEqual(synced.groupMessages, []);

const grace = await api("/api/auth/register", { method: "POST", body: JSON.stringify({ name: "Грейс", nickname: "grace" }) });
const henry = await api("/api/auth/register", { method: "POST", body: JSON.stringify({ name: "Генри", nickname: "henry" }) });
const ivan = await api("/api/auth/register", { method: "POST", body: JSON.stringify({ name: "Иван", nickname: "ivan" }) });
const judy = await api("/api/auth/register", { method: "POST", body: JSON.stringify({ name: "Джуди", nickname: "judy" }) });

const lonelyGroup = await fetch(`${baseUrl}/api/groups`, {
  method: "POST",
  headers: { Authorization: `Bearer ${grace.token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ name: "Одна", memberIds: [grace.user.id] }),
});
assert.equal(lonelyGroup.status, 422);

const createdGroup = await api("/api/groups", {
  token: grace.token,
  method: "POST",
  body: JSON.stringify({ name: "Проект", memberIds: [henry.user.id, ivan.user.id, henry.user.id] }),
});
const group = createdGroup.group;
assert.equal(group.ownerId, grace.user.id);
assert.deepEqual(group.members.map((member) => member.id), [grace.user.id, henry.user.id, ivan.user.id]);
const henryGroups = await api("/api/groups", { token: henry.token });
assert.deepEqual(henryGroups.groups.map((item) => item.id), [group.id]);
const outsiderGroup = await fetch(`${baseUrl}/api/groups/${group.id}`, {
  headers: { Authorization: `Bearer ${judy.token}` },
});
assert.equal(outsiderGroup.status, 404);

const groupHello = await api("/api/group-messages", {
  token: grace.token,
  method: "POST",
  body: JSON.stringify({ groupId: group.id, text: "Привет всем" }),
});
assert.equal(groupHello.message.status, "sent");
const outsiderSend = await fetch(`${baseUrl}/api/group-messages`, {
  method: "POST",
  headers: { Authorization: `Bearer ${judy.token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ groupId: group.id, text: "Я не в группе" }),
});
assert.equal(outsiderSend.status, 404);

// Sync is the delivery receipt; the sender sees the weakest receipt of the members.
const henrySync = await api("/api/sync", { token: henry.token, method: "POST", body: JSON.stringify({ limit: 100 }) });
assert.equal(henrySync.groups[0].id, group.id);
assert.equal(henrySync.groupMessages[0].id, groupHello.message.id);
assert.ok(henrySync.readStates.some((state) => state.chatId === group.id && state.lastDeliveredAt));
const afterHenry = await api(`/api/group-messages?groupId=${group.id}`, { token: grace.token });
assert.equal(afterHenry.messages[0].status, "sent");
await api("/api/sync", { token: ivan.token, method: "POST", body: JSON.stringify({ limit: 100 }) });
const afterIvan = await api(`/api/group-messages?groupId=${group.id}`, { token: grace.token });
assert.equal(afterIvan.messages[0].status, "delivered");
await api(`/api/group-messages/${groupHello.message.id}/status`, {
  token: henry.token,
  method: "PATCH",
  body: JSON.stringify({ status: "read" }),
});
const afterHenryRead = await api(`/api/group-messages?groupId=${group.id}`, { token: grace.token });
assert.equal(afterHenryRead.messages[0].status, "delivered");
const ivanRead = await api(`/api/group-messages/${groupHello.message.id}/status`, {
  token: ivan.token,
  method: "PATCH",
  body: JSON.stringify({ status: "read" }),
});
assert.equal(ivanRead.message.status, "read");

const henryReply = await api("/api/group-messages", {
  token: henry.token,
  method: "POST",
  body: JSON.stringify({ groupId: group.id, text: "Ответ" }),
});
const foreignEdit = await fetch(`${baseUrl}/api/group-messages/${henryReply.message.id}`, {
  method: "PATCH",
  headers: { Authorization: `Bearer ${grace.token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ text: "Чужая правка" }),
});
assert.equal(foreignEdit.status, 403);
const ownEdit = await api(`/api/group-messages/${henryReply.message.id}`, {
  token: henry.token,
  method: "PATCH",
  body: JSON.stringify({ text: "Ответ!" }),
});
assert.equal(ownEdit.message.text, "Ответ!");
assert.ok(ownEdit.message.editedAt);
const foreignDelete = await fetch(`${baseUrl}/api/group-messages`, {
  method: "DELETE",
  headers: { Authorization: `Bearer ${grace.token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ ids: [henryReply.message.id], scope: "everyone" }),
});
assert.equal(foreignDelete.status, 403);
await api(`/api/group-messages/${henryReply.message.id}`, {
  token: grace.token,
  method: "DELETE",
  body: JSON.stringify({ scope: "me" }),
});
const graceWithoutReply = await api(`/api/group-messages?groupId=${group.id}`, { token: grace.token });
assert.ok(!graceWithoutReply.messages.some((message) => message.id === henryReply.message.id));
const ivanKeepsReply = await api(`/api/group-messages?groupId=${group.id}`, { token: ivan.token });
assert.ok(ivanKeepsReply.messages.some((message) => message.id === henryReply.message.id));
await api("/api/group-messages", {
  token: henry.token,
  method: "DELETE",
  body: JSON.stringify({ ids: [henryReply.message.id], scope: "everyone" }),
});
const ivanAfterAuthorDelete = await api(`/api/group-messages?groupId=${group.id}`, { token: ivan.token });
assert.ok(!ivanAfterAuthorDelete.messages.some((message) => message.id === henryReply.message.id));

// Any member may invite; a newcomer's cursor starts at the join, so older
// messages do not fall back to "unread" for their authors.
const joined = await api(`/api/groups/${group.id}/members`, {
  token: henry.token,
  method: "POST",
  body: JSON.stringify({ userId: judy.user.id }),
});
assert.equal(joined.group.members.length, 4);
const afterJoin = await api(`/api/group-messages?groupId=${group.id}`, { token: grace.token });
assert.equal(afterJoin.messages.find((message) => message.id === groupHello.message.id).status, "read");
const nonOwnerKick = await fetch(`${baseUrl}/api/groups/${group.id}/members`, {
  method: "DELETE",
  headers: { Authorization: `Bearer ${henry.token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ userId: judy.user.id }),
});
assert.equal(nonOwnerKick.status, 403);
const nonOwnerRename = await fetch(`${baseUrl}/api/groups/${group.id}`, {
  method: "PATCH",
  headers: { Authorization: `Bearer ${henry.token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ name: "Чужое имя" }),
});
assert.equal(nonOwnerRename.status, 403);
const renamed = await api(`/api/groups/${group.id}`, {
  token: grace.token,
  method: "PATCH",
  body: JSON.stringify({ name: "Проект X" }),
});
assert.equal(renamed.group.name, "Проект X");
const kicked = await api(`/api/groups/${group.id}/members`, {
  token: grace.token,
  method: "DELETE",
  body: JSON.stringify({ userId: judy.user.id }),
});
assert.equal(kicked.group.members.length, 3);
const selfKick = await fetch(`${baseUrl}/api/groups/${group.id}/members`, {
  method: "DELETE",
  headers: { Authorization: `Bearer ${grace.token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ userId: grace.user.id }),
});
assert.equal(selfKick.status, 422);

// Leaving: ownership passes to the next member, the last one out deletes the group.
const ivanLeft = await api(`/api/groups/${group.id}`, { token: ivan.token, method: "DELETE" });
assert.equal(ivanLeft.deleted, false);
const ivanGone = await fetch(`${baseUrl}/api/groups/${group.id}`, { headers: { Authorization: `Bearer ${ivan.token}` } });
assert.equal(ivanGone.status, 404);
await api(`/api/groups/${group.id}`, { token: grace.token, method: "DELETE" });
const inherited = await api(`/api/groups/${group.id}`, { token: henry.token });
assert.equal(inherited.group.ownerId, henry.user.id);
assert.deepEqual(inherited.group.members.map((member) => member.id), [henry.user.id]);
const henryLeft = await api(`/api/groups/${group.id}`, { token: henry.token, method: "DELETE" });
assert.equal(henryLeft.deleted, true);
const henryAfterGroup = await api("/api/sync", { token: henry.token, method: "POST", body: JSON.stringify({ limit: 100 }) });
assert.deepEqual(henryAfterGroup.groups, []);
assert.deepEqual(henryAfterGroup.groupMessages, []);

const deletionOwner = await api("/api/auth/register", {
  method: "POST",
  body: JSON.stringify({ name: "Удалятор", nickname: "deleter" }),
});
const deletionPeer = await api("/api/auth/register", {
  method: "POST",
  body: JSON.stringify({ name: "Собеседник", nickname: "delete-peer" }),
});
const deletionMessages = [];
for (const text of ["Первое", "Второе", "Третье", "Четвёрто"]) {
  const result = await api("/api/messages", {
    token: deletionOwner.token,
    method: "POST",
    body: JSON.stringify({ toUserId: deletionPeer.user.id, text, kind: "text" }),
  });
  deletionMessages.push(result.message);
}

await api(`/api/conversations/${deletionPeer.user.id}`, {
  token: deletionOwner.token,
  method: "DELETE",
  body: JSON.stringify({ mode: "hide" }),
});
const hiddenConversation = await api("/api/sync", {
  token: deletionOwner.token,
  method: "POST",
  body: JSON.stringify({ limit: 100 }),
});
assert.ok(hiddenConversation.hiddenPeerIds.includes(deletionPeer.user.id));
assert.ok(hiddenConversation.messages.some((message) => message.id === deletionMessages[0].id));

await api("/api/messages", {
  token: deletionPeer.token,
  method: "POST",
  body: JSON.stringify({ toUserId: deletionOwner.user.id, text: "Диалог вернулся", kind: "text" }),
});
const restoredConversation = await api("/api/sync", {
  token: deletionOwner.token,
  method: "POST",
  body: JSON.stringify({ limit: 100 }),
});
assert.ok(!restoredConversation.hiddenPeerIds.includes(deletionPeer.user.id));

await api(`/api/messages/${deletionMessages[0].id}`, {
  token: deletionOwner.token,
  method: "DELETE",
  body: JSON.stringify({ scope: "me" }),
});
const deletedOnlyForOwner = await fetch(`${baseUrl}/api/messages/${deletionMessages[0].id}`, {
  headers: { Authorization: `Bearer ${deletionOwner.token}` },
});
assert.equal(deletedOnlyForOwner.status, 404);
const stillVisibleForPeer = await api(`/api/messages/${deletionMessages[0].id}`, {
  token: deletionPeer.token,
});
assert.equal(stillVisibleForPeer.message.id, deletionMessages[0].id);

await api(`/api/messages/${deletionMessages[1].id}`, {
  token: deletionPeer.token,
  method: "DELETE",
  body: JSON.stringify({ scope: "everyone" }),
});
for (const participantToken of [deletionOwner.token, deletionPeer.token]) {
  const deletedForEveryone = await fetch(`${baseUrl}/api/messages/${deletionMessages[1].id}`, {
    headers: { Authorization: `Bearer ${participantToken}` },
  });
  assert.equal(deletedForEveryone.status, 404);
}

await api("/api/messages", {
  token: deletionPeer.token,
  method: "DELETE",
  body: JSON.stringify({
    ids: [deletionMessages[2].id, deletionMessages[3].id],
    scope: "me",
  }),
});
const peerAfterBulkDelete = await api("/api/sync", {
  token: deletionPeer.token,
  method: "POST",
  body: JSON.stringify({ limit: 100 }),
});
assert.ok(!peerAfterBulkDelete.messages.some((message) =>
  [deletionMessages[2].id, deletionMessages[3].id].includes(message.id)));
const ownerAfterBulkDelete = await api("/api/sync", {
  token: deletionOwner.token,
  method: "POST",
  body: JSON.stringify({ limit: 100 }),
});
assert.ok(ownerAfterBulkDelete.messages.some((message) => message.id === deletionMessages[2].id));

await api(`/api/conversations/${deletionPeer.user.id}`, {
  token: deletionOwner.token,
  method: "DELETE",
  body: JSON.stringify({ mode: "delete_history", scope: "me" }),
});
const ownerWithoutHistory = await api("/api/sync", {
  token: deletionOwner.token,
  method: "POST",
  body: JSON.stringify({ limit: 100 }),
});
assert.ok(ownerWithoutHistory.hiddenPeerIds.includes(deletionPeer.user.id));
assert.ok(!ownerWithoutHistory.messages.some((message) =>
  message.fromUserId === deletionPeer.user.id || message.toUserId === deletionPeer.user.id));
const peerKeepsHistory = await api("/api/sync", {
  token: deletionPeer.token,
  method: "POST",
  body: JSON.stringify({ limit: 100 }),
});
assert.ok(peerKeepsHistory.messages.some((message) => message.id === deletionMessages[0].id));

await api("/api/messages", {
  token: deletionPeer.token,
  method: "POST",
  body: JSON.stringify({ toUserId: deletionOwner.user.id, text: "Снова привет", kind: "text" }),
});
await api("/api/messages", {
  token: deletionOwner.token,
  method: "POST",
  body: JSON.stringify({ toUserId: deletionPeer.user.id, text: "Удалим всё", kind: "text" }),
});
await api(`/api/conversations/${deletionPeer.user.id}`, {
  token: deletionOwner.token,
  method: "DELETE",
  body: JSON.stringify({ mode: "delete_history", scope: "everyone" }),
});
for (const [participant, counterpart] of [
  [deletionOwner, deletionPeer],
  [deletionPeer, deletionOwner],
]) {
  const afterDeleteForEveryone = await api("/api/sync", {
    token: participant.token,
    method: "POST",
    body: JSON.stringify({ limit: 100 }),
  });
  assert.ok(afterDeleteForEveryone.hiddenPeerIds.includes(counterpart.user.id));
  assert.ok(!afterDeleteForEveryone.messages.some((message) =>
    message.fromUserId === counterpart.user.id || message.toUserId === counterpart.user.id));
}
await api("/api/contacts", {
  token: deletionOwner.token,
  method: "POST",
  body: JSON.stringify({ identifier: deletionPeer.user.id }),
});
const reopenedByOwner = await api("/api/sync", {
  token: deletionOwner.token,
  method: "POST",
  body: JSON.stringify({ limit: 100 }),
});
const stillHiddenForPeer = await api("/api/sync", {
  token: deletionPeer.token,
  method: "POST",
  body: JSON.stringify({ limit: 100 }),
});
assert.ok(!reopenedByOwner.hiddenPeerIds.includes(deletionPeer.user.id));
assert.ok(stillHiddenForPeer.hiddenPeerIds.includes(deletionOwner.user.id));

const speedy = await api("/api/auth/register", {
  method: "POST",
  body: JSON.stringify({ name: "Торопыга", nickname: "speedy" }),
});
for (let index = 1; index <= 6; index += 1) {
  const rapidMessage = await api("/api/messages", {
    token: speedy.token,
    method: "POST",
    body: JSON.stringify({
      toUserId: bob.user.id,
      text: String(index),
      kind: "text",
    }),
  });
  assert.equal(rapidMessage.message.status, "sent");
}
const limitedMessage = await fetch(`${baseUrl}/api/messages`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${speedy.token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    toUserId: bob.user.id,
    text: "7",
    kind: "text",
  }),
});
const limitedPayload = await limitedMessage.json();
assert.equal(limitedMessage.status, 429);
assert.equal(limitedPayload.error.code, "message_rate_limited");
assert.ok(Number(limitedMessage.headers.get("Retry-After")) >= 1);

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

console.log("API smoke test passed: profile → push config → user search → messaging → contacts → sync → groups → deletion → message rate limit → token reset");
