import path from "node:path";

const DEFAULT_DATABASE_URL = "file:./data/messenger.db";

// Shared by prisma.config.ts (CLI, migrations) and the runtime client so both
// open the same file regardless of the working directory they run from.
export function databaseFile() {
  const configured = process.env.DATABASE_URL?.trim() || DEFAULT_DATABASE_URL;
  if (!configured.startsWith("file:")) {
    throw new Error(`DATABASE_URL must be a SQLite file URL (file:...), got ${configured}`);
  }
  return path.resolve(process.cwd(), configured.slice("file:".length));
}

export function databaseUrl() {
  return `file:${databaseFile()}`;
}
