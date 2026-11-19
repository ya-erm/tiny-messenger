import "server-only";

// Restarting expires activity (fail open for push). No heartbeat writes to SQLite
// or Litestream/S3. Shared global also spans Next's server module chunks.
const scope = globalThis as typeof globalThis & { __tmPushActivity?: Map<string, Map<string, number>> };
const users = scope.__tmPushActivity ??= new Map<string, Map<string, number>>();
const rankingScope = globalThis as typeof globalThis & { __tmPushLatestDevice?: Map<string, { endpoint: string; at: number; seen: number }> };
const latest = rankingScope.__tmPushLatestDevice ??= new Map<string, { endpoint: string; at: number; seen: number }>();
export function recordPushActivity(userId: string, deviceId: string, active: boolean, now = Date.now(), endpoint?: string, activityAt = now) {
  for (const [id, devices] of users) {
    for (const [key, until] of devices) if (until <= now) devices.delete(key);
    if (!devices.size) users.delete(id);
  }
  for (const [id, entry] of latest) if (now - entry.seen > 86_400_000) latest.delete(id);
  if (!active) { users.get(userId)?.delete(deviceId); return false; }
  if (!users.has(userId) && users.size >= 1024) return false;
  const devices = users.get(userId) ?? new Map<string, number>();
  if (!devices.has(deviceId) && devices.size >= 10) devices.delete(devices.keys().next().value!);
  devices.set(deviceId, now + 15_000);
  users.set(userId, devices);
  const previous = latest.get(userId);
  if (!endpoint || (previous && activityAt <= previous.at)) return false;
  if (!previous && latest.size >= 1024) return false;
  latest.set(userId, { endpoint, at: activityAt, seen: now });
  // A heartbeat on the same leading device never writes SQLite. A new human
  // interaction on another device changes the persisted preference once.
  return previous?.endpoint !== endpoint;
}
export function hasPushActivity(userId: string, now = Date.now()) {
  return [...(users.get(userId)?.values() ?? [])].some((until) => until > now);
}
