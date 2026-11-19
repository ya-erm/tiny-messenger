// A fresh process must deduplicate from SQLite, including a deleted message.
import assert from "node:assert/strict";
import { prisma, read, write } from "../src/lib/db";
import { acceptMutation } from "../src/lib/mutations/accept";
import { parseMutation } from "../src/lib/mutations/protocol";

try {
  const entries = await read((db) => db.mutationOperation.findMany());
  assert.ok(entries.length >= 3);
  const before = await read((db) => db.message.count());
  for (const entry of entries) {
    const operation = parseMutation(JSON.parse(entry.body));
    const actor = await read((db) => db.user.findUniqueOrThrow({ where: { id: operation.actorId } }));
    const receipt = await write((tx) => acceptMutation(tx, operation, actor));
    assert.equal(receipt.replayed, true);
    assert.equal(receipt.receivedAt, entry.receivedAt);
  }
  assert.equal(await read((db) => db.message.count()), before);
  assert.equal(await read((db) => db.mutationOperation.count()), entries.length);
  console.log("Restart replay checks passed in a fresh process.");
} finally {
  await prisma.$disconnect();
}
