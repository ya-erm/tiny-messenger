import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fingerprintBackup } from "./backup-content.mjs";
import { shouldSendBackup, UNCHANGED_INTERVAL_MS, readDeliveryState, saveDeliveryState } from "./backup-delivery-state.mjs";

test("content fingerprint ignores export metadata and Litestream, but includes app rows and schema", () => {
  const backup = {
    format: "tiny-messenger-sqlite-json", version: 1, createdAt: "old", sqliteVersion: "old",
    userVersion: 1, applicationId: 2,
    schema: [
      { type: "table", name: "User", tbl_name: "User", sql: "CREATE TABLE User(id, name)" },
      { type: "table", name: "_litestream_seq", tbl_name: "_litestream_seq", sql: "CREATE TABLE _litestream_seq(id)" },
    ],
    tables: [
      { name: "User", columns: ["id", "name"], rows: [[1, "Alice"]] },
      { name: "_litestream_seq", columns: ["id"], rows: [[1]] },
    ],
  };
  const original = fingerprintBackup(backup);
  const volatile = structuredClone(backup);
  volatile.createdAt = "new";
  volatile.sqliteVersion = "new";
  volatile.tables[1].rows = [[999]];
  volatile.schema.push({ type: "table", name: "_litestream_lock", tbl_name: "_litestream_lock", sql: "CREATE TABLE _litestream_lock(id)" });
  volatile.tables.push({ name: "_litestream_lock", columns: ["id"], rows: [] });
  assert.equal(fingerprintBackup(volatile), original);
  for (const mutate of [
    (b) => { b.tables[0].rows[0][1] = "Betty"; },
    (b) => { b.tables[0].rows.push([2, "Alice"]); },
    (b) => { b.tables[0].rows = []; },
    (b) => { b.schema[0].sql += " STRICT"; },
    (b) => { b.userVersion++; },
  ]) {
    const changed = structuredClone(backup);
    mutate(changed);
    assert.notEqual(fingerprintBackup(changed), original);
  }
});

test("same content is due exactly seven days after successful delivery", () => {
  const now = Date.parse("2026-10-22T00:00:00Z");
  const previous = { contentHash: "a", lastSentAt: new Date(now).toISOString() };
  assert.equal(shouldSendBackup(null, "a", now), true);
  assert.equal(shouldSendBackup(previous, "b", now), true);
  assert.equal(shouldSendBackup(previous, "a", now + UNCHANGED_INTERVAL_MS - 1), false);
  assert.equal(shouldSendBackup(previous, "a", now + UNCHANGED_INTERVAL_MS), true);
  assert.equal(shouldSendBackup(previous, "a", now - 1), true);
});

test("scheduled backups skip repeats, retain failed-delivery state, and allow manual backups", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tm-delivery-"));
  const originalDate = globalThis.Date;
  const originalFetch = globalThis.fetch;
  const originalArgv = process.argv;
  const originalEnv = { ...process.env };
  const originalExitCode = process.exitCode;
  let now = originalDate.parse("2026-10-14T22:00:00Z");
  globalThis.Date = class extends originalDate {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  };
  const database = new Database(path.join(directory, "source.db"));
  database.exec("CREATE TABLE User(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO User VALUES (1,'Alice'); CREATE TABLE _litestream_seq(id INTEGER PRIMARY KEY, seq INTEGER); INSERT INTO _litestream_seq VALUES (1,1)");
  const stateFile = path.join(directory, "last-delivery.json");
  let delivered = 0;
  let failureNotifications = 0;
  let failDocument = false;
  let runId = 0;
  try {
    Object.assign(process.env, {
      TELEGRAM_BOT_TOKEN: "12345678:test_fixture", TELEGRAM_ADMIN_CHAT_ID: "123",
      BACKUP_DIRECTORY: directory, BACKUP_DATABASE: path.join(directory, "source.db"),
    });
    globalThis.fetch = async (url, options) => {
      if (url.endsWith("/sendMessage")) {
        assert.equal(JSON.parse(options.body).disable_notification, true);
        failureNotifications++;
        return { ok: true, json: async () => ({ ok: true, result: {} }) };
      }
      assert.ok(url.endsWith("/sendDocument"));
      let body = "";
      for await (const chunk of options.body) body += Buffer.from(chunk).toString("utf8");
      assert.match(body, /name="disable_notification"\r\n\r\ntrue/);
      const name = body.match(/filename="([^"]+)"/)[1];
      if (failDocument) return { ok: false, status: 503, json: async () => ({ ok: false }) };
      delivered++;
      return { ok: true, json: async () => ({ ok: true, result: {
        chat: { id: 123 }, message_id: delivered,
        document: { file_size: (await stat(path.join(directory, name))).size },
      } }) };
    };
    async function run(scheduled = true) {
      process.argv = ["node", "telegram-backup.mjs", ...(scheduled ? ["--scheduled"] : [])];
      process.exitCode = undefined;
      await import(`./telegram-backup.mjs?test=${runId++}`);
    }
    assert.equal(await readDeliveryState(stateFile), null);
    await run();
    assert.equal(delivered, 1);
    const first = await readDeliveryState(stateFile);
    assert.equal((await stat(stateFile)).mode & 0o777, 0o600);
    now += 86400_000;
    database.exec("UPDATE _litestream_seq SET seq=999");
    await run();
    assert.equal(delivered, 1);
    assert.deepEqual(await readDeliveryState(stateFile), first);
    now += UNCHANGED_INTERVAL_MS - 86400_000;
    await run();
    assert.equal(delivered, 2);
    now += 60_000;
    database.exec("UPDATE User SET name='Betty'");
    await run();
    assert.equal(delivered, 3);
    const beforeFailure = await readFile(stateFile, "utf8");
    now += 60_000;
    database.exec("UPDATE User SET name='Carol'");
    failDocument = true;
    await run();
    assert.equal(process.exitCode, 1);
    assert.equal(await readFile(stateFile, "utf8"), beforeFailure);
    assert.equal(failureNotifications, 1);
    now += 60_000;
    failDocument = false;
    // A temporary file left by a crash must not block successful state updates.
    await writeFile(`${stateFile}.next`, "interrupted", { mode: 0o600 });
    await run();
    assert.equal(delivered, 4);
    assert.notEqual(await readFile(stateFile, "utf8"), beforeFailure);
    now += 60_000;
    await run(false);
    assert.equal(delivered, 5);
    assert.equal((await readDeliveryState(stateFile)).lastSentAt, new Date(now).toISOString());
    assert.ok((await readdir(directory)).some((name) => name.endsWith(".json.gz")));
    await assert.rejects(readDeliveryState(path.join(directory, "source.db")), /Cannot read/);
    await writeFile(path.join(directory, "invalid.json"), "{}");
    await assert.rejects(readDeliveryState(path.join(directory, "invalid.json")), /Invalid/);
    // Saving in a missing directory fails without replacing the valid state.
    await assert.rejects(saveDeliveryState(path.join(directory, "missing", "state"), first.contentHash));
  } finally {
    database.close();
    globalThis.Date = originalDate;
    globalThis.fetch = originalFetch;
    process.argv = originalArgv;
    process.env = originalEnv;
    process.exitCode = originalExitCode;
    await rm(directory, { recursive: true, force: true });
  }
});
