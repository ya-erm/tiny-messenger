import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { prisma, read, write } from "../src/lib/db";
import { acceptMutation } from "../src/lib/mutations/accept";
import { compareMutationVersions, parseMutation, serializeMutation, type Mutation } from "../src/lib/mutations/protocol";
import { POST } from "../src/app/api/mutations/route";
import { GET as getMessages, POST as legacyPost } from "../src/app/api/messages/route";
import { DELETE as deleteMessage } from "../src/app/api/messages/[id]/route";

const now = new Date().toISOString();
const actor = { id: randomUUID(), name: "Автор" };
const recipient = { id: randomUUID(), name: "Получатель" };
const token = "msg_" + randomUUID();
const otherToken = "msg_" + randomUUID();
function mutation(): Mutation & { type: "message.create" } {
  return { protocolVersion: 1, operationId: randomUUID(), actorId: actor.id, deviceId: randomUUID(),
    occurredAt: now, type: "message.create", message: { id: randomUUID(), fromUserId: actor.id,
      toUserId: recipient.id, kind: "text", text: "Текст\n  с пробелами 👋", sentAt: now } };
}
function request(body: unknown, bearer = token, method = "POST") {
  return new Request("http://localhost/api/mutations", { method,
    headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(body) });
}
async function counts() {
  return read(async (db) => ({ messages: await db.message.count(), operations: await db.mutationOperation.count() }));
}
try {
  await write(async (db) => {
    for (const [user, secret] of [[actor, token], [recipient, otherToken]] as const) {
      await db.user.create({ data: { ...user, tokenHash: createHash("sha256").update(secret).digest("hex"), createdAt: now, updatedAt: now } });
    }
  });

  const operation = mutation();
  operation.occurredAt = operation.message.sentAt = new Date(Date.now() - 86_400_000).toISOString();
  assert.deepEqual(parseMutation(operation), operation);
  const reversed = Object.fromEntries(Object.entries(operation).reverse());
  reversed.message = Object.fromEntries(Object.entries(operation.message).reverse());
  assert.equal(serializeMutation(operation), serializeMutation(reversed));
  for (const invalid of [
    { ...operation, protocolVersion: 2 }, { ...operation, type: "message.delete" },
    { ...operation, extra: true }, { ...operation, actorId: recipient.id },
    { ...operation, occurredAt: "2026-02-30T00:00:00.000Z" },
    { ...operation, occurredAt: "2026-11-19T16:00:00+00:00" },
    { ...operation, message: { ...operation.message, text: " " } },
    { ...operation, message: { ...operation.message, text: "я".repeat(8193) } },
    { ...operation, message: { ...operation.message, senderName: "Подмена" } },
  ]) assert.throws(() => parseMutation(invalid));
  const low = { occurredAt: now, operationId: "00000000-0000-4000-8000-000000000001" };
  const high = { ...low, operationId: "00000000-0000-4000-8000-000000000002" };
  assert.equal(compareMutationVersions(low, high), -1);
  assert.equal(compareMutationVersions(high, low), 1);
  assert.equal(compareMutationVersions(low, low), 0);
  assert.equal(compareMutationVersions({ ...high, occurredAt: "2020-01-01T00:00:00.000Z" }, low), -1);

  assert.equal((await POST(request(operation, ""))).status, 401);
  assert.equal((await POST(request(operation, otherToken))).status, 403);
  assert.equal((await POST(request({ ...operation, protocolVersion: 2 }))).status, 422);
  assert.equal((await POST(request({ ...operation, message: { ...operation.message, text: "x".repeat(17000) } }))).status, 413);
  assert.deepEqual(await counts(), { messages: 0, operations: 0 });

  const beforeArrival = Date.now();
  const first = await POST(request(operation));
  assert.equal(first.status, 201);
  const receipt = (await first.json()).data;
  assert.equal(receipt.messageId, operation.message.id);
  assert.equal(receipt.replayed, false);
  const replay = await POST(request(reversed));
  assert.equal(replay.status, 200);
  assert.deepEqual((await replay.json()).data, { ...receipt, replayed: true });
  const stored = await read((db) => db.message.findUniqueOrThrow({ where: { id: operation.message.id } }));
  assert.equal(stored.text, operation.message.text);
  assert.equal(stored.senderName, actor.name);
  assert.equal(await read((db) => db.pushNotificationState.count()), 1);
  const revision = await read((db) => db.pushNotificationState.findUniqueOrThrow({ where: { userId: recipient.id } }));
  assert.equal(revision.revision, 1);
  assert.equal(revision.alertAfter, operation.message.sentAt);
  assert.ok(Date.parse(revision.dueAt!) >= beforeArrival + 6000);
  assert.equal((await POST(request({ ...operation, message: { ...operation.message, text: "Другой текст" } }))).status, 409);
  assert.equal((await POST(request({ ...operation, operationId: randomUUID() }))).status, 409);
  assert.deepEqual(await counts(), { messages: 1, operations: 1 });

  // Legacy readers see the new message, and legacy sends still work.
  const inbox = await getMessages(new Request("http://localhost/api/messages", { headers: { authorization: `Bearer ${otherToken}` } }));
  assert.equal((await inbox.json()).data.messages[0].id, operation.message.id);
  const legacy = await legacyPost(request({ toUserId: recipient.id, text: "Старый API", kind: "text" }));
  assert.equal(legacy.status, 201);

  const aborted = mutation();
  await assert.rejects(() => write(async (tx) => {
    await acceptMutation(tx, aborted, actor);
    throw Error("simulated crash before commit");
  }), /simulated crash/);
  assert.deepEqual(await counts(), { messages: 2, operations: 2 });
  assert.equal((await read((db) => db.pushNotificationState.findUniqueOrThrow({ where: { userId: recipient.id } }))).revision, 2);
  const missingRecipient = mutation();
  missingRecipient.message.toUserId = randomUUID();
  assert.equal((await POST(request(missingRecipient))).status, 404);
  assert.deepEqual(await counts(), { messages: 2, operations: 2 });

  const independent = [mutation(), mutation()];
  for (const event of independent) await write((tx) => acceptMutation(tx, event, actor));
  const beforeRetry = await counts();
  for (const event of [...independent].reverse()) {
    assert.equal((await write((tx) => acceptMutation(tx, event, actor))).replayed, true);
  }
  assert.deepEqual(await counts(), beforeRetry);

  const deleted = await deleteMessage(request({ scope: "everyone" }, token, "DELETE"), { params: Promise.resolve({ id: operation.message.id }) });
  assert.equal(deleted.status, 200);
  assert.equal((await POST(request(operation))).status, 200);
  assert.equal(await read((db) => db.message.count({ where: { id: operation.message.id } })), 0);
  assert.equal((await POST(request({ ...operation, operationId: randomUUID() }))).status, 409);
  console.log("Mutation checks passed: validation, authorization, atomicity, replay, legacy compatibility and deletion replay protection.");
} finally {
  await prisma.$disconnect();
}
