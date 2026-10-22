import { createHash } from "node:crypto";

const isReplicationTable = (name) => name.startsWith("_litestream_");

export function createContentFingerprint(metadata) {
  const hash = createHash("sha256");
  // Export time, SQLite runtime version and replication bookkeeping do not
  // change application data. They remain present in the complete archive.
  hash.update(JSON.stringify({
    fingerprintVersion: 1,
    format: metadata.format, version: metadata.version,
    userVersion: metadata.userVersion, applicationId: metadata.applicationId,
    schema: metadata.schema.filter((entry) => !isReplicationTable(entry.tbl_name)),
  }));
  let included = false;
  return {
    table(name, columns) {
      included = !isReplicationTable(name);
      if (included) hash.update(`\n${JSON.stringify({ name, columns })}`);
    },
    row(serialized) {
      if (included) hash.update(`\n${serialized}`);
    },
    digest() { return hash.digest("hex"); },
  };
}

// Also used to initialize delivery state from a previously delivered archive.
export function fingerprintBackup(backup) {
  const fingerprint = createContentFingerprint(backup);
  for (const table of backup.tables) {
    fingerprint.table(table.name, table.columns);
    for (const row of table.rows) fingerprint.row(JSON.stringify(row));
  }
  return fingerprint.digest();
}
