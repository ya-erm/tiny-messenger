// The service channel is separate from the user mutation API. Never accept a
// peer envelope using a user's token. Request sizes and work are bounded.
export const REPLICATION_VERSION = 1;
export const REPLICATION_BATCH = 5;
export const REPLICATION_MAX_BYTES = 512 * 1024;
export const REPLICATION_FEED = "@tm-replication-v1";
export function replicationCursor(value: unknown): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value)
    || BigInt(value) > 18446744073709551615n) throw new Error("Invalid replication cursor");
  return value;
}
