import "server-only";

import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import type { StoreData } from "@/lib/types";

const initialStore: StoreData = {
  version: 1,
  users: [],
  contacts: [],
  messages: [],
};

let writeQueue: Promise<void> = Promise.resolve();

function dataFilePath() {
  const configured = process.env.MESSENGER_DATA_FILE;
  return path.resolve(
    /* turbopackIgnore: true */ configured || path.join(process.cwd(), "data", "store.json"),
  );
}

async function ensureStore() {
  const file = dataFilePath();
  await mkdir(path.dirname(file), { recursive: true });

  try {
    const handle = await open(/* turbopackIgnore: true */ file, "wx");
    await handle.writeFile(`${JSON.stringify(initialStore, null, 2)}\n`, "utf8");
    await handle.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
}

function validateStore(value: unknown): StoreData {
  if (
    !value ||
    typeof value !== "object" ||
    (value as StoreData).version !== 1 ||
    !Array.isArray((value as StoreData).users) ||
    !Array.isArray((value as StoreData).contacts) ||
    !Array.isArray((value as StoreData).messages)
  ) {
    throw new Error("Messenger data file has an unsupported format");
  }

  return value as StoreData;
}

export async function readStore(): Promise<StoreData> {
  await ensureStore();
  const raw = await readFile(/* turbopackIgnore: true */ dataFilePath(), "utf8");
  return validateStore(JSON.parse(raw) as unknown);
}

async function writeStore(data: StoreData) {
  const target = dataFilePath();
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(target), { recursive: true });
  try {
    const handle = await open(/* turbopackIgnore: true */ temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function updateStore<T>(
  mutate: (store: StoreData) => T | Promise<T>,
): Promise<T> {
  let result!: T;
  let failure: unknown;

  writeQueue = writeQueue.then(async () => {
    try {
      const store = await readStore();
      result = await mutate(store);
      await writeStore(store);
    } catch (error) {
      failure = error;
    }
  });

  await writeQueue;
  if (failure) throw failure;
  return result;
}
