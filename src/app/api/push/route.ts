import { ApiError, ok, readJson, route } from "@/lib/api";
import { authenticate } from "@/lib/auth";
import { pushConfiguration } from "@/lib/push";
import { assertRateLimit } from "@/lib/rate-limit";
import { readStore, updateStore } from "@/lib/store";
import type { PushSubscriptionRecord } from "@/lib/types";

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
  const store = await readStore();
  return ok({
    configured: configuration.configured,
    publicKey: configuration.configured ? configuration.publicKey : "",
    subscriptionCount: store.pushSubscriptions.filter(
      (subscription) => subscription.userId === authenticated.id,
    ).length,
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

  await updateStore((store) => {
    const existing = store.pushSubscriptions.find(
      (item) => item.endpoint === subscription.endpoint,
    );
    if (existing) {
      existing.userId = authenticated.id;
      existing.expirationTime = subscription.expirationTime;
      existing.keys = subscription.keys;
      existing.updatedAt = now;
      return;
    }

    const userSubscriptions = store.pushSubscriptions.filter(
      (item) => item.userId === authenticated.id,
    );
    if (userSubscriptions.length >= MAX_SUBSCRIPTIONS_PER_USER) {
      const oldest = userSubscriptions.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))[0];
      store.pushSubscriptions = store.pushSubscriptions.filter(
        (item) => item.endpoint !== oldest.endpoint,
      );
    }

    const item: PushSubscriptionRecord = {
      userId: authenticated.id,
      ...subscription,
      createdAt: now,
      updatedAt: now,
    };
    store.pushSubscriptions.push(item);
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

  await updateStore((store) => {
    store.pushSubscriptions = store.pushSubscriptions.filter(
      (item) => item.userId !== authenticated.id || item.endpoint !== endpoint,
    );
  });
  return ok({ subscribed: false });
});
