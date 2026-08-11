import { createHash } from "node:crypto";
import { ApiError } from "@/lib/api";

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();
const WINDOW_MS = 60_000;

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function clientAddress(request: Request) {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

function authFingerprint(request: Request) {
  const token = request.headers.get("authorization") || request.headers.get("x-api-key") || "";
  return token ? createHash("sha256").update(token).digest("hex").slice(0, 16) : "anonymous";
}

export function assertRateLimit(request: Request, authenticated = false) {
  const now = Date.now();
  const limit = positiveInteger(
    authenticated ? process.env.RATE_LIMIT_AUTH : process.env.RATE_LIMIT_PUBLIC,
    authenticated ? 480 : 120,
  );
  const key = `${authenticated ? "auth" : "public"}:${clientAddress(request)}:${authFingerprint(request)}`;
  const current = buckets.get(key);

  if (!current || current.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
  } else {
    current.count += 1;
    if (current.count > limit) {
      throw new ApiError(429, "rate_limited", "Слишком много запросов. Повторите через минуту.", {
        retryAfterSeconds: Math.ceil((current.resetAt - now) / 1000),
      });
    }
  }

  if (buckets.size > 10_000) {
    for (const [bucketKey, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(bucketKey);
    }
  }
}
