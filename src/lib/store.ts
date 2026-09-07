import "server-only";

import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { advanceReadState } from "@/lib/domain";
import type { MessageRecord, StoreData } from "@/lib/types";

const initialStore: StoreData = {
  version: 1,
  users: [],
  contacts: [],
  messages: [],
  hiddenConversations: [],
  pushSubscriptions: [],
  groups: [],
  groupMessages: [],
  readStates: [],
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
    !Array.isArray((value as StoreData).messages) ||
    ("hiddenConversations" in value
      && !Array.isArray((value as StoreData).hiddenConversations)) ||
    ("pushSubscriptions" in value
      && !Array.isArray((value as StoreData).pushSubscriptions)) ||
    ("groups" in value && !Array.isArray((value as StoreData).groups)) ||
    ("groupMessages" in value && !Array.isArray((value as StoreData).groupMessages)) ||
    ("readStates" in value && !Array.isArray((value as StoreData).readStates))
  ) {
    throw new Error("Messenger data file has an unsupported format");
  }

  const store = value as StoreData;
  // Added after the initial JSON format shipped. Existing stores are upgraded
  // in memory and persisted by the next mutation.
  store.hiddenConversations ||= [];
  store.pushSubscriptions ||= [];
  store.groups ||= [];
  store.groupMessages ||= [];
  store.readStates ||= [];
  migrateReadMarks(store);
  return store;
}

type LegacyMessageRecord = MessageRecord & { deliveredAt?: string; readAt?: string };

// Messages used to carry their own deliveredAt/readAt. Fold those into the
// recipient's watermark, keyed by the message's own sentAt so exactly the marked
// message and everything before it count as read.
function migrateReadMarks(store: StoreData) {
  for (const message of store.messages as LegacyMessageRecord[]) {
    if (!("deliveredAt" in message) && !("readAt" in message)) continue;
    const readAt = message.readAt || message.answer?.answeredAt;
    advanceReadState(store.readStates, message.toUserId, message.fromUserId, {
      ...(message.deliveredAt ? { deliveredAt: message.sentAt } : {}),
      ...(readAt ? { readAt: message.sentAt } : {}),
    });
    delete message.deliveredAt;
    delete message.readAt;
  }
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
