import { ApiError, ok, readJson, route } from "@/lib/api";
import { authenticate } from "@/lib/auth";
import { recordPushActivity } from "@/lib/push-activity";
import { assertRateLimit } from "@/lib/rate-limit";
import { isUuid } from "@/lib/validation";
export const POST = route(async (request) => {
  assertRateLimit(request, true);
  const user = await authenticate(request);
  const body = await readJson(request);
  if (!isUuid(body.deviceId) || typeof body.active !== "boolean") throw new ApiError(422, "invalid_activity", "Некорректная активность");
  recordPushActivity(user.id, body.deviceId, body.active);
  return ok({ expiresInSeconds: body.active ? 15 : 0 });
});
