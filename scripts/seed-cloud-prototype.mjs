import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { connectYdb } from "../cloud/yandex/src/store-ydb.mjs";
import { serviceAccountCredentials } from "./yandex-auth.mjs";
import { reduceMessageOperations } from "../cloud/yandex/shared/reduce.mjs";
import { mutationMessageId } from "../cloud/yandex/shared/protocol.mjs";

const snapshot = JSON.parse(await readFile(new URL("../.secrets/yandex-cloud/bootstrap.json", import.meta.url), "utf8"));
const deployment = JSON.parse(await readFile(new URL("../.secrets/yandex-cloud/deployment.json", import.meta.url), "utf8"));
const database = await connectYdb(deployment.databaseConnectionString,
  serviceAccountCredentials(new URL("../.secrets/yandex-cloud/service-account.json", import.meta.url)));
const users = new Map(snapshot.users.map((user) => [user.id, user]));
const streams = new Map();
function stableId(value) {
  const bytes = createHash("sha256").update("tiny-messenger-bootstrap:" + value).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString("hex"); return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}
function envelope(actorId, label, occurredAt) {
  return { protocolVersion: 1, actorId, operationId: stableId(label), deviceId: "00000000-0000-4000-8000-000000000000", occurredAt };
}
for (const operation of snapshot.operations) {
  const id = mutationMessageId(operation); if (!streams.has(id)) streams.set(id, []); streams.get(id).push(operation);
}
for (const row of snapshot.messages) {
  if (streams.has(row.id) || row.kind !== "text" || row.attachments?.length || row.replyToId) continue;
  const message = Object.fromEntries(["id", "fromUserId", "toUserId", "kind", "text", "sentAt"].map((key) => [key, row[key]]));
  const operations = [{ ...envelope(row.fromUserId, "create:" + row.id, row.sentAt), type: "message.create", message }];
  for (const reaction of row.reactions) operations.push({ ...envelope(reaction.userId, "reaction:" + row.id + ":" + reaction.userId, snapshot.createdAt),
    type: "reaction.set", reaction: { messageId: row.id, ...reaction } });
  for (const mark of snapshot.deletions.filter((item) => item.messageId === row.id)) operations.push({ ...envelope(mark.userId, "delete-me:" + row.id + ":" + mark.userId, snapshot.createdAt),
    type: "message.delete", deletion: { messageId: row.id, scope: "me" } });
  streams.set(row.id, operations);
}
try {
  for (const user of snapshot.users) await database.transaction(async (tx) => {
    if (await tx.get("users", user.id)) return;
    await tx.put("users", user.id, user); await tx.put("tokens", user.tokenHash, { userId: user.id });
  });
  for (const state of snapshot.userStates) await database.transaction(async (tx) => {
    if (await tx.get("user-state", state.userId)) return;
    const { messages, userId, ...metadata } = state;
    await tx.put("user-state", userId, metadata);
  });
  // Import every visible historical record, including read-only questions/files/replies.
  const receipts = new Map();
  for (const state of snapshot.userStates) {
    for (const message of state.messages) {
      await database.transaction(async (tx) => {
        const key = message.id + ":" + state.userId;
        if (await tx.get("seeded-view", key)) return;
        await tx.putView(state.userId, message); await tx.put("seeded-view", key, true);
        if (!streams.has(message.id) && !await tx.get("states", message.id)) await tx.put("states", message.id, { archive: message });
      });
      const key = message.toUserId + ":" + message.fromUserId;
      if (!receipts.has(key)) receipts.set(key, { delivered: new Set(), read: new Set() });
      if (["read", "answered"].includes(message.status)) receipts.get(key).read.add(message.id);
      if (["delivered", "read", "answered"].includes(message.status)) receipts.get(key).delivered.add(message.id);
    }
  }
  for (const [key, value] of receipts) await database.transaction(async (tx) => {
    if (!await tx.get("receipts", key)) await tx.put("receipts", key, { delivered: [...value.delivered], read: [...value.read] });
  });
  let imported = 0;
  for (const [messageId, operations] of streams) await database.transaction(async (tx) => {
    if (await tx.get("states", messageId)) return;
    const projection = reduceMessageOperations(operations);
    const author = projection.message?.fromUserId;
    await tx.put("states", messageId, { operations, senderName: users.get(author)?.name || "" });
    for (const operation of operations) await tx.put("operations", operation.operationId, { operation, receivedAt: snapshot.createdAt });
    if (projection.message) for (const viewer of [projection.message.fromUserId, projection.message.toUserId]) {
      if (projection.deleted || projection.hiddenFor.includes(viewer)) await tx.putView(viewer,
        { id: messageId, sentAt: projection.message.sentAt, fromUserId: projection.message.fromUserId, toUserId: projection.message.toUserId, deleted: true });
    }
    imported++;
  });
  await database.transaction(async (tx) => { if (!await tx.get("meta", "bootstrap")) await tx.put("meta", "bootstrap", { createdAt: snapshot.createdAt }); });
  console.log(JSON.stringify({ users: snapshot.users.length, historicalMessages: snapshot.messages.length, messageJournals: imported, bootstrapComplete: true }));
} finally { database.close(); }
