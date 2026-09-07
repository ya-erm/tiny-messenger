import "server-only";

import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { databaseFile } from "@/lib/database-url";
import { PrismaClient } from "@/generated/prisma/client";
import type { Prisma } from "@/generated/prisma/client";

export type Db = PrismaClient | Prisma.TransactionClient;

function createClient() {
  const file = databaseFile();
  mkdirSync(path.dirname(file), { recursive: true });
  const adapter = new PrismaBetterSqlite3({ url: `file:${file}`, timeout: 5000 });
  return new PrismaClient({ adapter });
}

// The adapter opens one better-sqlite3 handle per client, so a single client
// per process is the whole "pool". Dev re-evaluates modules on every edit;
// the globalThis slot keeps it from leaking handles.
const globalScope = globalThis as typeof globalThis & {
  __messengerPrisma?: PrismaClient;
  __messengerPrismaReady?: Promise<void>;
};

export const prisma = globalScope.__messengerPrisma ??= createClient();

// WAL lets readers proceed while a write is in flight and gives Litestream a
// journal to replicate; foreign keys are off by default in SQLite.
export function ready() {
  return globalScope.__messengerPrismaReady ??= (async () => {
    await prisma.$queryRawUnsafe("PRAGMA journal_mode = WAL");
    await prisma.$queryRawUnsafe("PRAGMA foreign_keys = ON");
    await prisma.$queryRawUnsafe("PRAGMA synchronous = NORMAL");
  })();
}

// Every mutation goes through here. The better-sqlite3 adapter runs plain
// queries on the same connection without taking the transaction mutex, so a
// write outside a transaction could land inside (and roll back with) someone
// else's. Reads may use `prisma` directly.
export async function write<T>(mutate: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  await ready();
  return prisma.$transaction(mutate);
}

export async function read<T>(query: (db: PrismaClient) => Promise<T>): Promise<T> {
  await ready();
  return query(prisma);
}
