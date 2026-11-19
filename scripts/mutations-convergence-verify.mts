import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { prisma, read, write } from "../src/lib/db";
import { acceptMutation } from "../src/lib/mutations/accept";
import { reduceMessageOperations } from "../src/lib/mutations/reduce";
import { type Mutation, mutationMessageId } from "../src/lib/mutations/protocol";
import { POST } from "../src/app/api/mutations/route";
import { PATCH, DELETE } from "../src/app/api/messages/[id]/route";
import { DELETE as bulkDelete, POST as legacySend } from "../src/app/api/messages/route";
import { messageReactionHandler } from "../src/lib/message-reaction-api";

const actor = { id: randomUUID(), name: "Автор изменений" };
const recipient = { id: randomUUID(), name: "Получатель изменений" };
const outsider = { id: randomUUID(), name: "Посторонний" };
const secrets = new Map([actor, recipient, outsider].map((user) => [user.id, "msg_" + randomUUID()]));
const time = "2026-11-19T10:00:00.000Z";
function base(user = actor, occurredAt = time) {
  return { protocolVersion: 1 as const, operationId: randomUUID(), actorId: user.id, deviceId: randomUUID(), occurredAt };
}
function events(messageId = randomUUID()): Mutation[] {
  const message = { id: messageId, fromUserId: actor.id, toUserId: recipient.id, kind: "text" as const, text: "Исходный текст", sentAt: time };
  return [
    { ...base(), type: "message.create", message },
    { ...base(actor, "2026-11-19T10:01:00.000Z"), operationId: "00000000-0000-4000-8000-000000000001", type: "message.edit", message: { ...message, text: "Первая правка" } },
    { ...base(actor, "2026-11-19T10:01:00.000Z"), operationId: "00000000-0000-4000-8000-000000000002", type: "message.edit", message: { ...message, text: "Вторая правка" } },
    { ...base(recipient), type: "reaction.set", reaction: { messageId, userId: recipient.id, emoji: "👍" } },
    { ...base(recipient, "2026-11-19T10:02:00.000Z"), type: "reaction.set", reaction: { messageId, userId: recipient.id, emoji: null } },
    { ...base(recipient), type: "message.delete", deletion: { messageId, scope: "me" } },
  ];
}
function* permutations<T>(items: T[]): Generator<T[]> {
  if (!items.length) { yield []; return; }
  for (let i = 0; i < items.length; i++) {
    for (const rest of permutations(items.filter((_, index) => index !== i))) yield [items[i], ...rest];
  }
}
function snapshot(operations: Mutation[]) {
  const projection = reduceMessageOperations(operations);
  return { ...projection, statuses: [...projection.statuses.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0) };
}
function request(body: unknown, user = actor, method = "POST") {
  return new Request("http://localhost/api/mutations", { method, headers: { "content-type": "application/json", authorization: `Bearer ${secrets.get(user.id)}` }, body: JSON.stringify(body) });
}
const context = (id: string) => ({ params: Promise.resolve({ id }) });
try {
  const pure = events();
  const expected = snapshot(pure);
  assert.equal(expected.message?.text, "Вторая правка");
  assert.deepEqual(expected.reactions, []);
  assert.deepEqual(expected.hiddenFor, [recipient.id]);
  let orders = 0;
  for (const order of permutations(pure)) {
    assert.deepEqual(snapshot([...order, ...order].reverse()), expected);
    orders++;
  }
  const deletion: Mutation = { ...base(recipient), type: "message.delete", deletion: { messageId: mutationMessageId(pure[0]), scope: "everyone" } };
  const withDelete = snapshot([...pure, deletion]);
  assert.equal(withDelete.deleted, true);
  for (const order of permutations([...pure, deletion])) assert.deepEqual(snapshot(order), withDelete);
  const tampered = structuredClone(pure[0]);
  if (tampered.type === "message.create") tampered.message.text = "Подмена";
  assert.throws(() => reduceMessageOperations([pure[0], tampered]), /Conflicting/);

  await write(async (db) => {
    for (const user of [actor, recipient, outsider]) await db.user.create({ data: { ...user,
      tokenHash: createHash("sha256").update(secrets.get(user.id)!).digest("hex"), createdAt: time, updatedAt: time } });
  });
  // Exercise both delivery orders through SQLite, not only the pure reducer.
  for (const reverse of [false, true]) {
    const sequence = events();
    // Global operation IDs must be fresh for another independent entity.
    for (const event of sequence) event.operationId = randomUUID();
    const expectedProjection = snapshot(sequence);
    for (const event of reverse ? [...sequence].reverse() : sequence) {
      const user = event.actorId === actor.id ? actor : recipient;
      const response = await POST(request(event, user));
      assert.ok([201, 202].includes(response.status), await response.text());
    }
    const id = mutationMessageId(sequence[0]);
    const row = await read((db) => db.message.findUniqueOrThrow({ where: { id }, include: { reactions: true, deletions: true } }));
    assert.equal(row.text, expectedProjection.message!.text);
    assert.equal(row.editedAt, expectedProjection.editedAt);
    assert.equal(row.reactions.length, 0);
    assert.deepEqual(row.deletions.map((mark) => mark.userId), [recipient.id]);
    assert.equal(await read((db) => db.mutationOperation.count({ where: { entityId: id, status: "pending" } })), 0);
  }

  const delayed = events();
  for (const event of delayed) event.operationId = randomUUID();
  const id = mutationMessageId(delayed[0]);
  const forbidden: Mutation = { ...base(outsider), type: "message.delete", deletion: { messageId: id, scope: "everyone" } };
  assert.equal((await POST(request(forbidden, outsider))).status, 202);
  await POST(request(delayed[0]));
  assert.equal(await read((db) => db.mutationOperation.findUniqueOrThrow({ where: { operationId: forbidden.operationId } })).then((row) => row.status), "rejected");
  assert.equal(await read((db) => db.message.count({ where: { id } })), 1);
  assert.equal((await POST(request({ ...forbidden, operationId: randomUUID() }, outsider))).status, 403);
  const wrongEdit = { ...delayed[1], actorId: recipient.id, message: { ...(delayed[1] as any).message, fromUserId: recipient.id, toUserId: actor.id } };
  assert.equal((await POST(request(wrongEdit, recipient))).status, 403);

  const tombstone: Mutation = { ...base(recipient), type: "message.delete", deletion: { messageId: id, scope: "everyone" } };
  assert.equal((await POST(request(tombstone, recipient))).status, 201);
  assert.equal((await POST(request(delayed[1]))).status, 201);
  assert.equal(await read((db) => db.message.count({ where: { id } })), 0);
  const beforeCreation = events();
  const absentId = mutationMessageId(beforeCreation[0]);
  const earlyDelete: Mutation = { ...base(), type: "message.delete", deletion: { messageId: absentId, scope: "everyone" } };
  assert.equal((await POST(request(earlyDelete))).status, 202);
  assert.equal((await POST(request(beforeCreation[0]))).status, 201);
  assert.equal(await read((db) => db.message.count({ where: { id: absentId } })), 0);

  // Old client handlers must journal the same mutations after deployment.
  const sent = await legacySend(request({ toUserId: recipient.id, text: "Старый клиент", clientRequestId: randomUUID() }));
  assert.equal(sent.status, 201);
  const legacyId = (await sent.json()).data.message.id;
  assert.equal((await PATCH(request({ text: "Правка старого клиента" }, actor, "PATCH"), context(legacyId))).status, 200);
  assert.equal((await messageReactionHandler("direct")(request({ emoji: "🔥" }, recipient, "POST"), context(legacyId))).status, 200);
  assert.equal((await DELETE(request({ scope: "me" }, recipient, "DELETE"), context(legacyId))).status, 200);
  assert.equal((await bulkDelete(request({ ids: [legacyId], scope: "everyone" }, actor, "DELETE"))).status, 200);
  const logged = await read((db) => db.mutationOperation.findMany({ where: { entityId: legacyId } }));
  assert.deepEqual(logged.map((entry) => entry.type).sort(), ["message.create", "message.edit", "reaction.set", "message.delete", "message.delete"].sort());
  assert.equal(await read((db) => db.message.count({ where: { id: legacyId } })), 0);
  console.log(`Convergence checks passed: ${orders} edit/reaction permutations, 5040 deletion permutations, out-of-order SQLite delivery, authorization and legacy API bridge.`);
} finally {
  await prisma.$disconnect();
}
