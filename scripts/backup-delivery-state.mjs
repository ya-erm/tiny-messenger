import { readFile, rename, rm, writeFile } from "node:fs/promises";

export const UNCHANGED_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

export async function readDeliveryState(file) {
  let state;
  try {
    state = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error("Cannot read backup delivery state");
  }
  if (state.version !== 1 || !/^[a-f0-9]{64}$/.test(state.contentHash ?? "")
      || !Number.isFinite(Date.parse(state.lastSentAt))) {
    throw new Error("Invalid backup delivery state");
  }
  return state;
}

export function shouldSendBackup(previous, contentHash, now = Date.now()) {
  if (!previous || previous.contentHash !== contentHash) return true;
  const age = now - Date.parse(previous.lastSentAt);
  return age < 0 || age >= UNCHANGED_INTERVAL_MS;
}

export async function saveDeliveryState(file, contentHash, lastSentAt = new Date().toISOString()) {
  const temporary = `${file}.next`;
  try {
    await writeFile(temporary, `${JSON.stringify({ version: 1, contentHash, lastSentAt })}\n`, {
      // The wrapper's flock serializes writers. Replace a stale temporary file
      // left by an interrupted run instead of preventing every future backup.
      mode: 0o600,
    });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}
