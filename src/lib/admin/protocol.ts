// Read-only administration, with an explicit projection of public account fields.
export function adminAllowed(userId: string, allowlist: string) {
  return allowlist.split(",").map(value => value.trim()).filter(Boolean).includes(userId);
}
export async function adminUsers(tx: any) {
  const rows = await tx.scan("users", 501);
  return {users: rows.slice(0, 500).map((user: any) => ({id: user.id, name: user.name, nickname: user.nickname || null, createdAt: user.createdAt})), truncated: rows.length > 500};
}
export async function adminDevices(tx: any, userId: unknown) {
  if (typeof userId !== "string" || !/^[0-9a-f-]{36}$/.test(userId)) throw Error("Invalid admin user ID");
  const rows = await tx.scanPrefix("device-telemetry", userId + ":", 257);
  return {devices: rows.slice(0, 256).map((device: any) => ({deviceId: device.deviceId, firstSeenAt: device.firstSeenAt, lastSeenAt: device.lastSeenAt,
    current: device.current, sessions: device.sessions, history: device.history})), truncated: rows.length > 256};
}
