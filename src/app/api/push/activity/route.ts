import { ApiError, ok, readJson, route } from "@/lib/api";
import { authenticate } from "@/lib/auth";
import { read, write } from "@/lib/db";
import { recordPushActivity } from "@/lib/push-activity";
import { assertRateLimit } from "@/lib/rate-limit";
import { isUuid } from "@/lib/validation";
export const POST = route(async (request) => {
  assertRateLimit(request, true);
  const user = await authenticate(request);
  const body = await readJson(request);
  if (!isUuid(body.deviceId) || typeof body.active !== "boolean") throw new ApiError(422, "invalid_activity", "Некорректная активность");
  const endpoint = body.endpoint;
  if (endpoint !== undefined && (typeof endpoint !== "string" || endpoint.length > 2048)) throw new ApiError(422, "invalid_activity", "Некорректное устройство");
  const now = Date.now();
  const activityAt = typeof body.activityAt === "number" && Number.isFinite(body.activityAt)
    ? Math.max(now - 60_000, Math.min(now, body.activityAt)) : now;
  const owned = body.active && typeof endpoint === "string" && endpoint
    ? await read((db) => db.pushSubscription.findFirst({ where: { userId: user.id, endpoint }, select: { endpoint: true } })) : null;
  const changed = recordPushActivity(user.id, body.deviceId, body.active, now, owned?.endpoint, activityAt);
  if (changed && owned) {
    await write((tx) => tx.pushSubscription.updateMany({ where: { userId: user.id, endpoint: owned.endpoint }, data: { lastActiveAt: new Date(activityAt).toISOString() } }));
  }
  return ok({ expiresInSeconds: body.active ? 15 : 0 });
});
