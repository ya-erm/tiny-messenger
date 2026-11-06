import http from "node:http";
import WebSocket from "ws";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { RealtimeService } from "./realtime-service.mjs";
import { attachWebSocketTransport } from "./ws-gateway.mjs";
import { signProof, verifyProof } from "../src/lib/messenger-protocol.mjs";

// Check isolation BEFORE importing anything which opens a database.
const directory = process.env.TASKS_TEST_DIR;
assert.ok(directory && path.basename(directory).startsWith("tiny-messenger-tasks-test-"), "Use pnpm test:tasks (disposable data only)");
assert.equal(process.env.DATABASE_URL, `file:${path.join(directory, "messenger.db")}`);
const { read, write, prisma } = await import("@/lib/db");
const { authenticateToken } = await import("@/lib/auth");
const { integrationEnabled, connectionPreview, approveConnection, exchangeSession, unlinkAccount } = await import("@/lib/tasks-integration");
const { toUserRecord } = await import("@/lib/store");
const origin = process.env.TASKS_ORIGIN!;
const usedAssertion = path.join(directory, "used-assertion");
const rejected = (error: unknown) => (error as { status: number }).status === 409;

function child(mode: string, overrides = {}) {
  const result = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), mode], {
    env: { ...process.env, ...overrides }, encoding: "utf8", timeout: 20_000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

try {
  if (process.argv[2] === "replay") {
    await assert.rejects(() => exchangeSession(readFileSync(usedAssertion, "utf8")), rejected);
  } else if (process.argv[2] === "disabled-integration") {
    assert.equal(integrationEnabled, false);
    assert.ok((await authenticateToken(process.env.TASKS_TEST_NATIVE_TOKEN!)).id);
    await assert.rejects(() => authenticateToken("tms_invalid"));
  } else {
    const key = readFileSync(process.env.TASKS_INTEGRATION_SECRET_FILE!, "utf8").trim();
    const id = randomUUID(), otherId = randomUUID(), sub = randomUUID();
    const native = "msg_" + randomUUID(), now = new Date().toISOString();
    const tokenHash = createHash("sha256").update(native).digest("hex");
    await write(async db => {
      await db.user.create({ data: { id, name: "Анна", tokenHash, createdAt: now, updatedAt: now } });
      await db.user.create({ data: { id: otherId, name: "Борис", tokenHash: createHash("sha256").update("other-token").digest("hex"), createdAt: now, updatedAt: now } });
    });
    const user = await read(db => db.user.findUniqueOrThrow({ where: { id } }));
    const state = signProof(key, "connect", { sub, origin, name: "Аккаунт задач" }, 300);
    assert.equal(connectionPreview(state).name, "Аккаунт задач");
    assert.throws(() => connectionPreview(state + "x"));
    assert.throws(() => connectionPreview(signProof(key, "connect", { sub, origin: "https://wrong.example.test" }, 60)));
    assert.throws(() => connectionPreview(signProof(key, "connect", { sub, origin }, 60, Date.now() - 120_000)));
    assert.throws(() => verifyProof(key, "login", state));
    const { proof } = await approveConnection(state, toUserRecord(user));
    const linked = verifyProof(key, "linked", proof);
    await assert.rejects(() => approveConnection(state, toUserRecord(user)), rejected);
    const bad = signProof(key, "login", { sub, origin, tmUserId: otherId, linkId: linked.linkId }, 30);
    await assert.rejects(() => exchangeSession(bad), rejected);
    const assertion = signProof(key, "login", { sub, origin, tmUserId: id, linkId: linked.linkId }, 30);
    const session = await exchangeSession(assertion);
    assert.equal((await authenticateToken(session.token)).id, id);
    assert.ok(session.token.length > 256);

    const httpServer = http.createServer(async (req, res) => {
      try {
        const bearer = String(req.headers.authorization || req.headers["x-api-key"] || "").replace(/^Bearer /i, "");
        const authenticated = await authenticateToken(bearer);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true, data: { user: { id: authenticated.id, name: authenticated.name }, contacts: [], messages: [] } }));
      } catch { res.writeHead(401); res.end('{"ok":false}'); }
    });
    await new Promise<void>(resolve => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address() as { port: number };
    const upstream = `http://127.0.0.1:${address.port}`;
    const realtime = new RealtimeService({ upstream, dataFile: path.join(directory, "realtime.json") });
    const transport = attachWebSocketTransport(httpServer, { upstream, onConnection: connection => realtime.claimConnection(connection) });
    await realtime.ready;
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
    try {
      const ready = await new Promise<{ userId: string }>((resolve, reject) => {
        const timer = setTimeout(() => reject(Error("Realtime login timed out")), 5000);
        ws.once("open", () => ws.send(JSON.stringify({ type: "authenticate", client: "web", token: session.token, instanceId: "integration-test", capabilities: ["voice"] })));
        ws.on("message", raw => { const frame = JSON.parse(raw.toString()); if (frame.type === "ready") { clearTimeout(timer); resolve(frame); } });
        ws.once("error", error => { clearTimeout(timer); reject(error); });
        ws.once("close", (code, reason) => { clearTimeout(timer); if (code !== 1000) reject(Error("Realtime denied: " + reason)); });
      });
      assert.equal(ready.userId, id);
    } finally {
      ws.terminate();
      await realtime.shutdown();
      await transport.close();
      await new Promise<void>(resolve => httpServer.close(() => resolve()));
    }

    assert.equal((await authenticateToken(native)).id, id);
    await assert.rejects(() => exchangeSession(assertion), rejected);
    writeFileSync(usedAssertion, assertion, { mode: 0o600 });
    child("replay");
    child("disabled-integration", { TASKS_INTEGRATION_SECRET_FILE: path.join(directory, "missing.key"), TASKS_TEST_NATIVE_TOKEN: native });
    child("disabled-integration", { TASKS_INTEGRATION_SECRET_FILE: "", TASKS_TEST_NATIVE_TOKEN: native });
    child("disabled-integration", { TASKS_ORIGIN: "invalid-origin", TASKS_TEST_NATIVE_TOKEN: native });
    await unlinkAccount(signProof(key, "unlink", { sub, origin, tmUserId: id, linkId: linked.linkId }, 30));
    assert.equal((await authenticateToken(session.token)).id, id, "Unlink should retain the independent TM session");
    await assert.rejects(() => exchangeSession(signProof(key, "login", { sub, origin, tmUserId: id, linkId: linked.linkId }, 30)), rejected);
    await write(db => db.user.update({ where: { id }, data: { tokenHash: createHash("sha256").update("rotated-native").digest("hex") } }));
    await assert.rejects(() => authenticateToken(session.token));
    await assert.rejects(() => authenticateToken(native));
    assert.equal((await authenticateToken("rotated-native")).id, id);
    console.log("PASS: SQLite migrations, link confirmation, signature/expiry/origin checks, wrong-account rejection, WebSocket login, replay after restart, missing key, unlink independence and rotation revocation");
  }
} finally {
  await prisma.$disconnect();
}
