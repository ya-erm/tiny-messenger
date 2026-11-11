import "server-only";

// Restarting expires activity (fail open for push). No heartbeat writes to SQLite
// or Litestream/S3. Shared global also spans Next's server module chunks.
const scope = globalThis as typeof globalThis & { __tmPushActivity?: Map<string, Map<string, number>> };
const users = scope.__tmPushActivity ??= new Map<string, Map<string, number>>();
export function recordPushActivity(userId: string, deviceId: string, active: boolean, now = Date.now()) {
  for (const [id, devices] of users) {
    for (const [key, until] of devices) if (until <= now) devices.delete(key);
    if (!devices.size) users.delete(id);
  }
  if (!active) { users.get(userId)?.delete(deviceId); return; }
  if (!users.has(userId) && users.size >= 1024) return;
  const devices = users.get(userId) ?? new Map<string, number>();
  if (!devices.has(deviceId) && devices.size >= 10) devices.delete(devices.keys().next().value!);
  devices.set(deviceId, now + 15_000);
  users.set(userId, devices);
}
export function hasPushActivity(userId: string, now = Date.now()) {
  return [...(users.get(userId)?.values() ?? [])].some((until) => until > now);
}
