import {summarizeAdmin,projectAdminRow} from "./data";
// Read-only administration, with an explicit projection of public account fields.
export function adminAllowed(userId: string, allowlist: string) {
  return allowlist.split(",").map(value => value.trim()).filter(Boolean).includes(userId);
}
export async function adminUsers(tx: any) {
  const users = await tx.scan("users", 501);
  const records=tx.adminRows?await tx.adminRows():[];
  if(!tx.adminRows){for(const bucket of ["rows:Message","rows:GroupMessage","operations","states","rows:GroupMember","rows:Attachment","device-telemetry","user-state"]){for(const entry of await tx.scanEntries(bucket,20001))records.push(projectAdminRow(bucket,entry.value,entry.key));}}
  return {...summarizeAdmin(users.slice(0,500),records),truncated:users.length>500||records.length>=20001};
}
export async function adminDevices(tx: any, userId: unknown) {
  if (typeof userId !== "string" || !/^[0-9a-f-]{36}$/.test(userId)) throw Error("Invalid admin user ID");
  const rows = await tx.scanPrefix("device-telemetry", userId + ":", 257);
  return {devices: rows.slice(0, 256).map((device: any) => ({deviceId: device.deviceId, firstSeenAt: device.firstSeenAt, lastSeenAt: device.lastSeenAt,
    current: device.current, sessions: device.sessions, history: device.history})), truncated: rows.length > 256};
}
