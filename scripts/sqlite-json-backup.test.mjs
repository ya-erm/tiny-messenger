import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import Database from "better-sqlite3";
import { exportDatabase, restoreDatabase } from "./sqlite-json-backup.mjs";

test("whole WAL snapshot restores schema, rows, exact integers, blobs and sequences", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tm-json-backup-"));
  const original = path.join(directory, "source.db");
  const archive = path.join(directory, "backup.json.gz");
  const target = path.join(directory, "restored.db");
  const db = new Database(original);
  try {
    db.pragma("journal_mode = WAL");
    db.exec(`CREATE TABLE parent(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, big INTEGER, data BLOB);
      CREATE TABLE child(id INTEGER PRIMARY KEY, parentId INTEGER REFERENCES parent(id), text TEXT,
        size INTEGER GENERATED ALWAYS AS (length(text)) STORED);
      CREATE TABLE audit(text TEXT);
      CREATE TABLE _prisma_migrations(id TEXT PRIMARY KEY, checksum TEXT);
      CREATE INDEX child_parent ON child(parentId);
      CREATE VIEW messages AS SELECT text FROM child;
      CREATE TRIGGER child_audit AFTER INSERT ON child BEGIN INSERT INTO audit VALUES (NEW.text); END;
      PRAGMA user_version = 42; PRAGMA application_id = 123;`);
    db.prepare("INSERT INTO parent(name,big,data) VALUES (?,?,?)").run("🤷 Unicode", 9223372036854775807n, Buffer.from([0, 255, 1]));
    db.prepare("INSERT INTO parent(id,name) VALUES (99,'deleted')").run();
    db.prepare("DELETE FROM parent WHERE id=99").run();
    db.prepare("INSERT INTO _prisma_migrations VALUES ('migration','checksum')").run();
    db.transaction(() => {
      const insert = db.prepare("INSERT INTO child(parentId,text) VALUES (1,?)");
      for (let i = 0; i < 5000; i++) insert.run(`message ${i} 😊`);
    })();
    db.exec("ANALYZE");
    const exporting = exportDatabase(original, archive);
    // Write while the exporter is streaming: neither table may contain this row.
    await new Promise((resolve) => setImmediate(resolve));
    db.prepare("INSERT INTO child(parentId,text) VALUES (1,'after snapshot')").run();
    const result = await exporting;
    assert.equal(result.counts.child, 5000);
    assert.equal(result.counts.audit, 5000);
    assert.equal((await stat(archive)).mode & 0o777, 0o600);
    const json = JSON.parse(gunzipSync(await readFile(archive)));
    assert.equal(json.format, "tiny-messenger-sqlite-json");
    assert.deepEqual(Object.keys(result.counts).sort(), db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name).sort());
    await restoreDatabase(archive, target);
    const restored = new Database(target);
    try {
      restored.defaultSafeIntegers(true);
      assert.equal(restored.prepare("SELECT count(*) AS count FROM messages").get().count, 5000n);
      assert.equal(restored.prepare("SELECT count(*) AS count FROM audit").get().count, 5000n);
      const row = restored.prepare("SELECT * FROM parent").get();
      assert.equal(row.big, 9223372036854775807n);
      assert.deepEqual(row.data, Buffer.from([0, 255, 1]));
      assert.equal(restored.prepare("INSERT INTO parent(name) VALUES ('next')").run().lastInsertRowid, 100n);
      assert.equal(restored.pragma("user_version", { simple: true }), 42n);
      assert.equal(restored.pragma("application_id", { simple: true }), 123n);
      restored.prepare("INSERT INTO child(parentId,text) VALUES (1,'new')").run();
      assert.equal(restored.prepare("SELECT count(*) AS count FROM audit").get().count, 5001n);
      assert.equal(restored.pragma("integrity_check", { simple: true }), "ok");
      assert.deepEqual(restored.pragma("foreign_key_check"), []);
    } finally { restored.close(); }
    await assert.rejects(restoreDatabase(archive, target), { code: "EEXIST" });
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});
