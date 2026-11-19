import { createHash } from "node:crypto";

// Only opaque endpoint hashes enter the durable delivery cursor.
export type DeliveryCursor = Record<string, { sent?: true; retryAt?: number }>;
export const PUSH_DEVICE_DELAY_MS = 10_000;
export const endpointId = (endpoint: string) => createHash("sha256").update(endpoint).digest("hex");
export function parseDeliveryCursor(value: string): DeliveryCursor {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([id, state]) => /^[a-f0-9]{64}$/.test(id)
      && state && typeof state === "object" && ((state as { sent?: unknown }).sent === true
        || Number.isFinite((state as { retryAt?: number }).retryAt)))) as DeliveryCursor;
  } catch { return {}; }
}
