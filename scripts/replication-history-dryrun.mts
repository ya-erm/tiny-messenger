// Run only against a separately copied database. Verifies that adopting the
// old journal leaves every existing message, reaction and visibility intact.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { prisma, write } from "../src/lib/db";
import { prepareHistory } from "../src/lib/replication/history";
const path = process.env.TM_HISTORY_SNAPSHOT;
if (!path || !process.env.DATABASE_URL?.includes("replication-dryrun")) throw Error("A disposable replication-dryrun database is required");
try {
  const snapshot = JSON.parse(await readFile(path, "utf8"));
  const result = await write(async (tx) => {
    const load = async () => ({ messages: await tx.message.findMany({ orderBy: { id: "asc" } }),
      reactions: await tx.messageReaction.findMany({ orderBy: [{ messageId: "asc" }, { userId: "asc" }] }),
      deletions: await tx.messageDeletion.findMany({ orderBy: [{ messageId: "asc" }, { userId: "asc" }] }) });
    const before = await load();
    const result = await prepareHistory(tx, snapshot, new Date().toISOString());
    assert.deepEqual(await load(), before, "Preparing journals must preserve existing user data");
    return result;
  }, { timeout: 60_000 });
  console.log(JSON.stringify({ ...result, projectionsUnchanged: true }));
} finally { await prisma.$disconnect(); }
