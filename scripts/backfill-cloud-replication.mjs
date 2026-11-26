// One-time, resumable enrollment of the existing prototype journals. No user
// data is exported to logs. New function versions enroll local writes inline.
import { readFile } from "node:fs/promises";
import { connectYdb } from "../cloud/yandex/src/store-ydb.mjs";
import { reduceMessageOperations } from "../cloud/yandex/shared/reduce.mjs";
import { appendReplication } from "../cloud/yandex/src/replication.mjs";
import { serviceAccountCredentials } from "./yandex-auth.mjs";
const deployment = JSON.parse(await readFile(new URL("../.secrets/yandex-cloud/deployment.json", import.meta.url), "utf8"));
const database = await connectYdb(deployment.databaseConnectionString,
  serviceAccountCredentials(new URL("../.secrets/yandex-cloud/service-account.json", import.meta.url)));
try {
  // This is a bounded bootstrap, not a repeated production table scan.
  const operations = await database.transaction((tx) => tx.scan("operations", 10001), { readOnly: true });
  const receipts = await database.transaction((tx) => tx.scanEntries("receipts", 10001), { readOnly: true });
  if (operations.length > 10000 || receipts.length > 10000) throw Error("Backfill requires pagination for this dataset");
  let enrolled = 0;
  for (const entry of operations) if (!entry.sourceId) await database.transaction(async (tx) => {
    await appendReplication(tx, "operation:" + entry.operation.operationId, { type: "mutation", operation: entry.operation }); enrolled++;
  });
  for (const { key, value } of receipts) await database.transaction((tx) => appendReplication(tx, "initial-receipt:" + key,
    { type: "receipt", userId: key.split(":")[0], peerId: key.split(":")[1], ...value }));
  const states = await database.transaction((tx) => tx.scan("states", 10001), { readOnly: true });
  if (states.length > 10000) throw Error("Tombstone backfill requires pagination");
  let tombstones = 0;
  for (const state of states) if (state.operations) {
    const projection = reduceMessageOperations(state.operations);
    if (projection.message) for (const userId of [projection.message.fromUserId, projection.message.toUserId])
      if (projection.deleted || projection.hiddenFor.includes(userId)) await database.transaction(async (tx) => {
        const bucket = "deleted:" + userId, id = projection.message.id;
        if (!await tx.get(bucket, id)) await tx.put(bucket, id, { id }); tombstones++;
      });
  }
  console.log(JSON.stringify({ enrolledOperations: enrolled, receipts: receipts.length, tombstones }));
} finally { database.close(); }
