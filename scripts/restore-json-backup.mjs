import { restoreDatabase } from "./sqlite-json-backup.mjs";

const [archive, target] = process.argv.slice(2);
if (!archive || !target) {
  console.error("Usage: node scripts/restore-json-backup.mjs ARCHIVE.json.gz NEW_DATABASE.db");
  process.exit(1);
}
await restoreDatabase(archive, target);
console.log("Restored database; integrity and foreign keys verified.");
