import { ApiError, ok, readJson, route } from "@/lib/api";
import { authenticate } from "@/lib/auth";
import { read, write } from "@/lib/db";
import { pushConfiguration } from "@/lib/push";
import { assertRateLimit } from "@/lib/rate-limit";

const MAX_SUBSCRIPTIONS_PER_USER = 10;

function subscriptionFromBody(body: Record<string, unknown>) {
  const raw = body.subscription;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ApiError(422, "invalid_push_subscription", "Передайте push-подписку браузера");
  }

  const subscription = raw as Record<string, unknown>;
  const rawKeys = subscription.keys;
  const keys = rawKeys && typeof rawKeys === "object" && !Array.isArray(rawKeys)
    ? rawKeys as Record<string, unknown>
    : {};
  const endpoint = typeof subscription.endpoint === "string" ? subscription.endpoint.trim() : "";
  const p256dh = typeof keys.p256dh === "string" ? keys.p256dh.trim() : "";
  const auth = typeof keys.auth === "string" ? keys.auth.trim() : "";
  const expirationTime = typeof subscription.expirationTime === "number"
    && Number.isFinite(subscription.expirationTime)
    ? subscription.expirationTime
    : undefined;

  let endpointUrl: URL;
  try {
    endpointUrl = new URL(endpoint);
  } catch {
    throw new ApiError(422, "invalid_push_subscription", "Некорректный адрес push-подписки");
  }
  if (
    endpointUrl.protocol !== "https:"
    || endpoint.length > 2048
    || !p256dh
    || p256dh.length > 256
    || !auth
    || auth.length > 128
  ) {
    throw new ApiError(422, "invalid_push_subscription", "Некорректные данные push-подписки");
  }

  return { endpoint, expirationTime, keys: { p256dh, auth } };
}

export const GET = route(async (request) => {
  assertRateLimit(request, true);
  const authenticated = await authenticate(request);
  const configuration = pushConfiguration();
  const subscriptionCount = await read((db) => db.pushSubscription.count({ where: { userId: authenticated.id } }));
  return ok({
    configured: configuration.configured,
    publicKey: configuration.configured ? configuration.publicKey : "",
    subscriptionCount,
  });
});

export const POST = route(async (request) => {
  assertRateLimit(request, true);
  const authenticated = await authenticate(request);
  const configuration = pushConfiguration();
  if (!configuration.configured) {
    throw new ApiError(503, "push_not_configured", "Push-уведомления пока не настроены на сервере");
  }
  const body = await readJson(request);
  const subscription = subscriptionFromBody(body);
  const now = new Date().toISOString();
  const expirationTime = subscription.expirationTime === undefined
    ? null
    : BigInt(Math.trunc(subscription.expirationTime));

  await write(async (tx) => {
    const existing = await tx.pushSubscription.findUnique({
      where: { endpoint: subscription.endpoint },
      select: { endpoint: true },
    });
    if (existing) {
      await tx.pushSubscription.update({
        where: { endpoint: subscription.endpoint },
        data: {
          userId: authenticated.id,
          expirationTime,
          p256dh: subscription.keys.p256dh,
          auth: subscription.keys.auth,
          updatedAt: now,
        },
      });
      return;
    }

    const count = await tx.pushSubscription.count({ where: { userId: authenticated.id } });
    if (count >= MAX_SUBSCRIPTIONS_PER_USER) {
      const oldest = await tx.pushSubscription.findFirst({
        where: { userId: authenticated.id },
        orderBy: { updatedAt: "asc" },
        select: { endpoint: true },
      });
      if (oldest) await tx.pushSubscription.delete({ where: { endpoint: oldest.endpoint } });
    }

    await tx.pushSubscription.create({
      data: {
        endpoint: subscription.endpoint,
        userId: authenticated.id,
        expirationTime,
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
        createdAt: now,
        updatedAt: now,
      },
    });
  });

  return ok({ subscribed: true });
});

export const DELETE = route(async (request) => {
  assertRateLimit(request, true);
  const authenticated = await authenticate(request);
  const body = await readJson(request);
  const endpoint = typeof body.endpoint === "string" ? body.endpoint.trim() : "";
  if (!endpoint || endpoint.length > 2048) {
    throw new ApiError(422, "invalid_push_endpoint", "Передайте адрес push-подписки");
  }

  await write((tx) => tx.pushSubscription.deleteMany({ where: { userId: authenticated.id, endpoint } }));
  return ok({ subscribed: false });
});
