import { createHash } from "node:crypto";
import { ApiError } from "@/lib/api";

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();
const WINDOW_MS = 60_000;
const MESSAGE_BURST_WINDOW_MS = 10_000;

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

function consumeRateLimit({
  request,
  scope,
  limit,
  windowMs,
  identity,
  code = "rate_limited",
  message = "Слишком много запросов. Повторите через минуту.",
}: {
  request: Request;
  scope: string;
  limit: number;
  windowMs: number;
  identity?: string;
  code?: string;
  message?: string;
}) {
  const now = Date.now();
  const key = `${scope}:${identity || `${clientAddress(request)}:${authFingerprint(request)}`}`;
  const current = buckets.get(key);

  if (!current || current.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
  } else {
    current.count += 1;
    if (current.count > limit) {
      throw new ApiError(429, code, message, {
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

export function assertRateLimit(request: Request, authenticated = false) {
  const limit = positiveInteger(
    authenticated ? process.env.RATE_LIMIT_AUTH : process.env.RATE_LIMIT_PUBLIC,
    authenticated ? 480 : 120,
  );
  consumeRateLimit({
    request,
    scope: authenticated ? "auth" : "public",
    limit,
    windowMs: WINDOW_MS,
  });
}

export function assertMessageRateLimit(request: Request, userId: string) {
  const burstLimit = positiveInteger(process.env.RATE_LIMIT_MESSAGES_BURST, 6);
  const burstWindowSeconds = positiveInteger(
    process.env.RATE_LIMIT_MESSAGES_BURST_WINDOW_SECONDS,
    MESSAGE_BURST_WINDOW_MS / 1000,
  );
  const minuteLimit = positiveInteger(process.env.RATE_LIMIT_MESSAGES_PER_MINUTE, 30);
  const error = {
    request,
    identity: userId,
    code: "message_rate_limited",
    message: "Вы отправляете сообщения слишком быстро. Притормозите.",
  };

  consumeRateLimit({
    ...error,
    scope: "message-burst",
    limit: burstLimit,
    windowMs: burstWindowSeconds * 1000,
  });
  consumeRateLimit({
    ...error,
    scope: "message-minute",
    limit: minuteLimit,
    windowMs: WINDOW_MS,
  });
}
