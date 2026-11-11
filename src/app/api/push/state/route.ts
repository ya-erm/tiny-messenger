import { ok, route } from "@/lib/api";
import { authenticate } from "@/lib/auth";
import { messagePushState } from "@/lib/message-push";
import { assertRateLimit } from "@/lib/rate-limit";
export const GET = route(async (request) => {
  assertRateLimit(request, true);
  const user = await authenticate(request);
  return ok({ state: await messagePushState(user.id) });
});
