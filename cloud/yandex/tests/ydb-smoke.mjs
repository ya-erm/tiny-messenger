import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { connectYdb } from "../src/store-ydb.mjs";
import { createService } from "../src/service.mjs";
import { serviceAccountCredentials } from "../../../scripts/yandex-auth.mjs";

const directory = new URL("../../../.secrets/yandex-cloud/", import.meta.url);
const deployment = JSON.parse(await readFile(new URL("deployment.json", directory), "utf8"));
const [a, b] = JSON.parse(await readFile(new URL("test-users.json", directory), "utf8"));
const credentials = serviceAccountCredentials(new URL("service-account.json", directory));
let database = await connectYdb(deployment.databaseConnectionString, credentials);
const occurredAt = new Date().toISOString();
const message = { id: randomUUID(), fromUserId: a.id, toUserId: b.id, kind: "text", text: "Synthetic Uint64 and durability check", sentAt: occurredAt };
const operation = { protocolVersion: 1, operationId: randomUUID(), actorId: a.id, deviceId: randomUUID(), occurredAt, type: "message.create", message };
try {
  const service = createService(database);
  const before = await service.snapshot(b);
  assert.equal((await service.authenticate(a.token)).id, a.id);
  assert.equal((await service.mutate(a, operation)).status, "applied");
  const changes = await service.changes(b, before.cursor);
  assert.ok(changes.changes.some((change) => change.message?.id === message.id));
  assert.equal((await service.receipt(b, message.id, "read")).status, "read");
  assert.equal((await service.message(a, message.id)).status, "read");
  database.close();
  database = await connectYdb(deployment.databaseConnectionString, credentials);
  const restarted = createService(database);
  assert.equal((await restarted.message(b, message.id)).text, message.text);
  assert.equal((await restarted.mutate(a, operation)).replayed, true);
  console.log(JSON.stringify({ realYdbTransaction: true, uint64Feed: true, explicitReadReceipts: true, newConnectionDurability: true }));
} finally { database.close(); }
