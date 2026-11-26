import {readTestConfiguration,testOrigin} from "../cloud/yandex/tests/config.mjs";
// Dedicated synthetic accounts only. Exercises the background worker through
// the same public APIs as clients; no service key or manual cursor changes.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const {directory:privateDirectory,deployment,users}=await readTestConfiguration();
const [a,b]=users;
const origins={vps:testOrigin('TM_TEST_PRIMARY_API_ORIGIN'),cloud:testOrigin('TM_CLOUD_TEST_ORIGIN')};
let requests = 0;
const delays = [];
async function call(channel, path, user, body, method = body === undefined ? "GET" : "POST", expected = [200, 201, 202]) {
  requests++;
  const response = await fetch(origins[channel] + path, { method, headers: { "content-type": "application/json", authorization: "Bearer " + user.token },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(25000) });
  const result = await response.json();
  if (!expected.includes(response.status)) throw Error(`Synthetic ${channel} check failed: HTTP ${response.status}, code ${result.error?.code || "unknown"}`);
  return { status: response.status, data: result.data };
}
async function eventually(channel, id, predicate, absent = false) {
  const started = Date.now();
  while (Date.now() - started < 180000) {
    const response = await call(channel, "/api/messages/" + id, b, undefined, "GET", [200, 404]);
    if (absent ? response.status === 404 : response.status === 200 && predicate(response.data.message)) {
      delays.push(Date.now() - started); return response.data?.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw Error(`Synthetic ${channel} replication timed out`);
}
function create(text) {
  const occurredAt = new Date().toISOString();
  return { protocolVersion: 1, operationId: randomUUID(), actorId: a.id, deviceId: randomUUID(), occurredAt, type: "message.create",
    message: { id: randomUUID(), fromUserId: a.id, toUserId: b.id, kind: "text", text, sentAt: occurredAt } };
}
function change(operation, type, fields, actor = a) {
  return { protocolVersion: 1, operationId: randomUUID(), deviceId: operation.deviceId, actorId: actor.id,
    occurredAt: new Date().toISOString(), type, ...fields };
}
const created = [];
try {
  for (const channel of Object.keys(origins)) for (const user of [a, b])
    assert.equal((await call(channel, "/api/auth/session", user, { token: user.token })).data.user.id, user.id);
  for (const source of ["vps", "cloud"]) {
    const target = source === "vps" ? "cloud" : "vps";
    const operation = create("Replication synthetic " + source);
    await call(source, "/api/mutations", a, operation); created.push(operation);
    await eventually(target, operation.message.id, (message) => message.text === operation.message.text);
    assert.equal((await call(source, "/api/mutations", a, operation)).data.replayed, true);
    const edit = change(operation, "message.edit", { message: { ...operation.message, text: "Edited synthetic " + target } });
    await call(target, "/api/mutations", a, edit);
    await eventually(source, operation.message.id, (message) => message.text === edit.message.text);
    await call(source, "/api/mutations", b, change(operation, "reaction.set", { reaction: { messageId: operation.message.id, userId: b.id, emoji: "👍" } }, b));
    await eventually(target, operation.message.id, (message) => message.reactions.some((item) => item.userId === b.id && item.emoji === "👍"));
    await call(target, "/api/messages/" + operation.message.id + "/status", b, { status: "read" }, "PATCH");
    await eventually(source, operation.message.id, (message) => message.status === "read");
    await call(target, "/api/mutations", b, change(operation, "message.delete", { deletion: { messageId: operation.message.id, scope: "everyone" } }, b));
    await eventually(source, operation.message.id, () => false, true);
    // A late edit and replay after deletion must not resurrect the message.
    await call(source, "/api/mutations", a, { ...edit, operationId: randomUUID() });
    await call(source, "/api/mutations", a, operation);
    await new Promise((resolve) => setTimeout(resolve, 6000));
    assert.equal((await call(target, "/api/messages/" + operation.message.id, b, undefined, "GET", [404])).status, 404);
  }
  const proof = { bidirectionalRealApis: true, edits: true, reactions: true, receipts: true, deletions: true,
    replayAfterDeletion: true, backgroundWorkerOnly: true, requests, maxObservedReplicationMs: Math.max(...delays), completedAt: new Date().toISOString() };
  await writeFile(new URL("replication-proof.json", privateDirectory), JSON.stringify(proof, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(proof));
} finally {
  for (const operation of created) for (const channel of Object.keys(origins)) {
    try { await call(channel, "/api/mutations", b, change(operation, "message.delete", { deletion: { messageId: operation.message.id, scope: "everyone" } }, b)); } catch {}
  }
}
