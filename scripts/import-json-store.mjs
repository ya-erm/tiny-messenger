// One-off import of the legacy JSON store (data/store.json) into the SQLite
// database. Run `prisma migrate deploy` first so the tables exist. Refuses to
// touch a database that already has users.
//
//   MESSENGER_DATA_FILE=./data/store.json DATABASE_URL=file:./data/messenger.db \
//     node scripts/import-json-store.mjs

import { readFile } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";

const sourceFile = path.resolve(
  process.env.MESSENGER_DATA_FILE || path.join(process.cwd(), "data", "store.json"),
);

function databaseFile() {
  const configured = process.env.DATABASE_URL?.trim() || "file:./data/messenger.db";
  if (!configured.startsWith("file:")) {
    throw new Error(`DATABASE_URL must be a SQLite file URL (file:...), got ${configured}`);
  }
  return path.resolve(process.cwd(), configured.slice("file:".length));
}

const store = JSON.parse(await readFile(sourceFile, "utf8"));
if (!store || store.version !== 1 || !Array.isArray(store.users)) {
  throw new Error(`${sourceFile} is not a version 1 messenger store`);
}
const lists = {
  users: store.users,
  contacts: store.contacts || [],
  messages: store.messages || [],
  hiddenConversations: store.hiddenConversations || [],
  pushSubscriptions: store.pushSubscriptions || [],
  groups: store.groups || [],
  groupMessages: store.groupMessages || [],
  readStates: store.readStates || [],
};
for (const [name, list] of Object.entries(lists)) {
  if (!Array.isArray(list)) throw new Error(`Store field ${name} must be an array`);
}

// Very old stores kept deliveredAt/readAt on each message. Fold those into the
// recipient's watermark the same way the JSON store did on load.
function findReadState(userId, chatId) {
  return lists.readStates.find((item) => item.userId === userId && item.chatId === chatId);
}
function advanceReadState(userId, chatId, marks) {
  let state = findReadState(userId, chatId);
  if (!state) {
    state = { userId, chatId };
    lists.readStates.push(state);
  }
  const deliveredAt = [marks.deliveredAt, marks.readAt].filter(Boolean).sort().at(-1);
  if (deliveredAt && (!state.lastDeliveredAt || state.lastDeliveredAt < deliveredAt)) {
    state.lastDeliveredAt = deliveredAt;
  }
  if (marks.readAt && (!state.lastReadAt || state.lastReadAt < marks.readAt)) {
    state.lastReadAt = marks.readAt;
  }
}
for (const message of lists.messages) {
  if (!("deliveredAt" in message) && !("readAt" in message)) continue;
  const readAt = message.readAt || message.answer?.answeredAt;
  advanceReadState(message.toUserId, message.fromUserId, {
    ...(message.deliveredAt ? { deliveredAt: message.sentAt } : {}),
    ...(readAt ? { readAt: message.sentAt } : {}),
  });
}

const target = databaseFile();
const db = new Database(target);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

const existingUsers = db.prepare('SELECT COUNT(*) AS count FROM "User"').get().count;
if (existingUsers > 0) {
  db.close();
  throw new Error(`${target} already has ${existingUsers} user(s); refusing to import on top`);
}

const knownUsers = new Set(lists.users.map((user) => user.id));
const skipped = [];

const insert = {
  user: db.prepare(`INSERT INTO "User" (id, name, nickname, avatarUrl, avatarBackground, tokenHash, createdAt, updatedAt)
    VALUES (@id, @name, @nickname, @avatarUrl, @avatarBackground, @tokenHash, @createdAt, @updatedAt)`),
  contact: db.prepare(`INSERT OR IGNORE INTO "Contact" (ownerId, userId, createdAt, updatedAt)
    VALUES (@ownerId, @userId, @createdAt, @updatedAt)`),
  message: db.prepare(`INSERT INTO "Message" (id, fromUserId, toUserId, senderName, text, kind, sentAt, editedAt, answerId, answerLabel, answeredAt)
    VALUES (@id, @fromUserId, @toUserId, @senderName, @text, @kind, @sentAt, @editedAt, @answerId, @answerLabel, @answeredAt)`),
  option: db.prepare(`INSERT INTO "ChoiceOption" (messageId, optionId, label, position)
    VALUES (@messageId, @optionId, @label, @position)`),
  messageDeletion: db.prepare(`INSERT OR IGNORE INTO "MessageDeletion" (messageId, userId) VALUES (@messageId, @userId)`),
  group: db.prepare(`INSERT INTO "Group" (id, name, avatarUrl, avatarBackground, ownerId, createdAt, updatedAt)
    VALUES (@id, @name, @avatarUrl, @avatarBackground, @ownerId, @createdAt, @updatedAt)`),
  groupMember: db.prepare(`INSERT OR IGNORE INTO "GroupMember" (groupId, userId) VALUES (@groupId, @userId)`),
  groupMessage: db.prepare(`INSERT INTO "GroupMessage" (id, groupId, fromUserId, senderName, text, sentAt, editedAt)
    VALUES (@id, @groupId, @fromUserId, @senderName, @text, @sentAt, @editedAt)`),
  groupMessageDeletion: db.prepare(`INSERT OR IGNORE INTO "GroupMessageDeletion" (messageId, userId) VALUES (@messageId, @userId)`),
  readState: db.prepare(`INSERT OR REPLACE INTO "ReadState" (userId, chatId, lastDeliveredAt, lastReadAt)
    VALUES (@userId, @chatId, @lastDeliveredAt, @lastReadAt)`),
  hidden: db.prepare(`INSERT OR REPLACE INTO "HiddenConversation" (ownerId, peerId, hiddenAt)
    VALUES (@ownerId, @peerId, @hiddenAt)`),
  push: db.prepare(`INSERT OR REPLACE INTO "PushSubscription" (endpoint, userId, expirationTime, p256dh, auth, createdAt, updatedAt)
    VALUES (@endpoint, @userId, @expirationTime, @p256dh, @auth, @createdAt, @updatedAt)`),
};

const counts = {};
function count(name) {
  counts[name] = (counts[name] || 0) + 1;
}

const importAll = db.transaction(() => {
  for (const user of lists.users) {
    insert.user.run({
      id: user.id,
      name: user.name,
      nickname: user.nickname || null,
      avatarUrl: user.avatarUrl || null,
      avatarBackground: user.avatarBackground || null,
      tokenHash: user.tokenHash,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    });
    count("users");
  }

  for (const contact of lists.contacts) {
    if (!knownUsers.has(contact.ownerId) || !knownUsers.has(contact.userId)) {
      skipped.push(`contact ${contact.ownerId} -> ${contact.userId}: unknown user`);
      continue;
    }
    insert.contact.run(contact);
    count("contacts");
  }

  for (const message of lists.messages) {
    if (!knownUsers.has(message.fromUserId) || !knownUsers.has(message.toUserId)) {
      skipped.push(`message ${message.id}: unknown user`);
      continue;
    }
    if (message.kind === "choice" && !Array.isArray(message.options)) {
      throw new Error(`Message ${message.id} is a choice without options; run migrate-choice-options first`);
    }
    insert.message.run({
      id: message.id,
      fromUserId: message.fromUserId,
      toUserId: message.toUserId,
      senderName: message.senderName,
      text: message.text,
      kind: message.kind,
      sentAt: message.sentAt,
      editedAt: message.editedAt || null,
      answerId: message.answer?.id ?? null,
      answerLabel: message.answer?.label ?? null,
      answeredAt: message.answer?.answeredAt ?? null,
    });
    count("messages");
    (message.options || []).forEach((option, position) => {
      insert.option.run({ messageId: message.id, optionId: option.id, label: option.label, position });
    });
    for (const userId of message.deletedForUserIds || []) {
      if (!knownUsers.has(userId)) continue;
      insert.messageDeletion.run({ messageId: message.id, userId });
    }
  }

  for (const group of lists.groups) {
    const memberIds = (group.memberIds || []).filter((id) => knownUsers.has(id));
    if (memberIds.length === 0) {
      skipped.push(`group ${group.id}: no known members`);
      continue;
    }
    const ownerId = knownUsers.has(group.ownerId) ? group.ownerId : memberIds[0];
    insert.group.run({
      id: group.id,
      name: group.name,
      avatarUrl: group.avatarUrl || null,
      avatarBackground: group.avatarBackground || null,
      ownerId,
      createdAt: group.createdAt,
      updatedAt: group.updatedAt,
    });
    count("groups");
    // Insertion order becomes `seq`, which is the member order the app shows.
    for (const userId of memberIds) insert.groupMember.run({ groupId: group.id, userId });
  }
  const knownGroups = new Set(lists.groups.map((group) => group.id));

  for (const message of lists.groupMessages) {
    if (!knownGroups.has(message.groupId) || !knownUsers.has(message.fromUserId)) {
      skipped.push(`group message ${message.id}: unknown group or user`);
      continue;
    }
    insert.groupMessage.run({
      id: message.id,
      groupId: message.groupId,
      fromUserId: message.fromUserId,
      senderName: message.senderName,
      text: message.text,
      sentAt: message.sentAt,
      editedAt: message.editedAt || null,
    });
    count("groupMessages");
    for (const userId of message.deletedForUserIds || []) {
      if (!knownUsers.has(userId)) continue;
      insert.groupMessageDeletion.run({ messageId: message.id, userId });
    }
  }

  for (const state of lists.readStates) {
    if (!knownUsers.has(state.userId)) continue;
    insert.readState.run({
      userId: state.userId,
      chatId: state.chatId,
      lastDeliveredAt: state.lastDeliveredAt || null,
      lastReadAt: state.lastReadAt || null,
    });
    count("readStates");
  }

  for (const item of lists.hiddenConversations) {
    if (!knownUsers.has(item.ownerId) || !knownUsers.has(item.peerId)) continue;
    insert.hidden.run(item);
    count("hiddenConversations");
  }

  for (const subscription of lists.pushSubscriptions) {
    if (!knownUsers.has(subscription.userId)) continue;
    insert.push.run({
      endpoint: subscription.endpoint,
      userId: subscription.userId,
      expirationTime: typeof subscription.expirationTime === "number"
        ? BigInt(Math.trunc(subscription.expirationTime))
        : null,
      p256dh: subscription.keys?.p256dh,
      auth: subscription.keys?.auth,
      createdAt: subscription.createdAt,
      updatedAt: subscription.updatedAt,
    });
    count("pushSubscriptions");
  }
});

importAll();
db.close();

console.log(`Imported ${sourceFile} into ${target}`);
for (const [name, value] of Object.entries(counts)) console.log(`  ${name}: ${value}`);
if (skipped.length) {
  console.log(`Skipped ${skipped.length} record(s):`);
  for (const reason of skipped) console.log(`  ${reason}`);
}
