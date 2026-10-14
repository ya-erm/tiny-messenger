import Database from "better-sqlite3";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, open, rename, rm, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip, createGunzip } from "node:zlib";
import path from "node:path";

const quote = (name) => `"${name.replaceAll('"', '""')}"`;
const encode = (_, value) => typeof value === "bigint"
  ? { $sqliteInteger: value.toString() }
  : Buffer.isBuffer(value) ? { $sqliteBlob: value.toString("base64") } : value;
// Buffer.toJSON runs before a JSON replacer; encode values before stringify.
const encodeCell = (value) => Buffer.isBuffer(value)
  ? { $sqliteBlob: value.toString("base64") } : value;
const decodeCell = (value) => value && typeof value === "object"
  ? "$sqliteInteger" in value ? BigInt(value.$sqliteInteger)
    : "$sqliteBlob" in value ? Buffer.from(value.$sqliteBlob, "base64")
      : (() => { throw new Error("Invalid SQLite value"); })()
  : value;

export async function exportDatabase(databaseFile, outputFile) {
  const db = new Database(databaseFile, { readonly: true, fileMustExist: true, timeout: 5000 });
  db.defaultSafeIntegers(true);
  db.pragma("query_only = ON");
  db.pragma("cache_size = -2048");
  const partial = `${outputFile}.partial`;
  const counts = {};
  try {
    db.exec("BEGIN");
    // The first read establishes one WAL snapshot for schema and every table.
    const schema = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY rowid").all();
    if (db.pragma("quick_check", { simple: true }) !== "ok" || db.pragma("foreign_key_check").length) {
      throw new Error("Database integrity check failed");
    }
    const metadata = {
      format: "tiny-messenger-sqlite-json", version: 1,
      createdAt: new Date().toISOString(),
      sqliteVersion: db.prepare("SELECT sqlite_version() AS version").get().version,
      userVersion: db.pragma("user_version", { simple: true }),
      applicationId: db.pragma("application_id", { simple: true }),
      schema,
    };
    async function* json() {
      yield `${JSON.stringify(metadata, encode).slice(0, -1)},"tables":[`;
      let firstTable = true;
      for (const table of schema.filter((entry) => entry.type === "table")) {
        const columns = db.pragma(`table_xinfo(${quote(table.name)})`).filter((column) => column.hidden === 0n);
        yield `${firstTable ? "" : ","}${JSON.stringify({ name: table.name, columns: columns.map((c) => c.name) }).slice(0, -1)},"rows":[`;
        firstTable = false;
        let count = 0;
        for (const row of db.prepare(`SELECT ${columns.map((c) => quote(c.name)).join(",")} FROM ${quote(table.name)}`).raw().iterate()) {
          yield `${count++ ? "," : ""}${JSON.stringify(row.map(encodeCell), encode)}`;
        }
        counts[table.name] = count;
        yield "]}";
      }
      yield "]}\n";
    }
    await mkdir(path.dirname(outputFile), { recursive: true, mode: 0o700 });
    await pipeline(Readable.from(json()), createGzip({ level: 6 }), createWriteStream(partial, { flags: "wx", mode: 0o600 }));
    db.exec("COMMIT");
    await rename(partial, outputFile);
    return { createdAt: metadata.createdAt, counts, bytes: (await stat(outputFile)).size };
  } finally {
    if (db.inTransaction) db.exec("ROLLBACK");
    db.close();
    await rm(partial, { force: true });
  }
}

export async function exportDatabasePair(databaseFile, outputPrefix) {
  await mkdir(path.dirname(outputPrefix), { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(path.join(path.dirname(outputPrefix), ".sqlite-snapshot-"));
  const snapshotFile = path.join(temporary, "snapshot.db");
  const jsonFile = `${outputPrefix}.json.gz`;
  const sqliteFile = `${outputPrefix}.db.gz`;
  let source;
  try {
    const handle = await open(snapshotFile, "wx", 0o600);
    await handle.close();
    source = new Database(databaseFile, { readonly: true, fileMustExist: true, timeout: 5000 });
    source.pragma("cache_size = -2048");
    // SQLite's online backup API includes committed WAL data without copying
    // the live .db file or pausing Messenger/Litestream.
    await source.backup(snapshotFile);
    source.close();
    source = undefined;
    const summary = await exportDatabase(snapshotFile, jsonFile);
    await pipeline(createReadStream(snapshotFile), createGzip({ level: 6 }),
      createWriteStream(`${sqliteFile}.partial`, { flags: "wx", mode: 0o600 }));
    await rename(`${sqliteFile}.partial`, sqliteFile);
    return {
      summary, jsonFile, sqliteFile,
      sqliteBytes: (await stat(sqliteFile)).size,
      databaseBytes: (await stat(snapshotFile)).size,
    };
  } finally {
    source?.close();
    await rm(`${sqliteFile}.partial`, { force: true });
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function restoreDatabase(archiveFile, targetFile) {
  // Offline recovery only. Never replace an existing database.
  const chunks = [];
  await pipeline(createReadStream(archiveFile), createGunzip(), async (source) => {
    for await (const chunk of source) chunks.push(chunk);
  });
  const backup = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (backup.format !== "tiny-messenger-sqlite-json" || backup.version !== 1) throw new Error("Unsupported backup format");
  const handle = await open(targetFile, "wx", 0o600);
  await handle.close();
  let db;
  let complete = false;
  try {
    db = new Database(targetFile);
    db.pragma("foreign_keys = OFF");
    db.exec("BEGIN");
    for (const entry of backup.schema.filter((entry) => entry.type === "table" && !entry.name.startsWith("sqlite_"))) db.exec(entry.sql);
    for (const entry of backup.schema.filter((entry) => entry.type === "index" && entry.sql)) db.exec(entry.sql);
    if (backup.tables.some((table) => table.name.startsWith("sqlite_stat"))) db.exec("ANALYZE");
    for (const table of backup.tables) {
      if (table.name.startsWith("sqlite_")) db.exec(`DELETE FROM ${quote(table.name)}`);
      const insert = db.prepare(`INSERT INTO ${quote(table.name)} (${table.columns.map(quote).join(",")}) VALUES (${table.columns.map(() => "?").join(",")})`);
      for (const row of table.rows) insert.run(...row.map(decodeCell));
    }
    for (const entry of backup.schema.filter((entry) => ["view", "trigger"].includes(entry.type) && entry.sql)) db.exec(entry.sql);
    db.pragma(`user_version = ${Number(decodeCell(backup.userVersion))}`);
    db.pragma(`application_id = ${Number(decodeCell(backup.applicationId))}`);
    if (db.pragma("integrity_check", { simple: true }) !== "ok" || db.pragma("foreign_key_check").length) throw new Error("Restored database integrity check failed");
    db.exec("COMMIT");
    complete = true;
  } finally {
    db?.close();
    if (!complete) await rm(targetFile, { force: true });
  }
}
