import { timingSafeEqual } from "node:crypto";
import { ApiError, ok, route } from "@/lib/api";
import { dispatchMessagePushes } from "@/lib/message-push";
export const POST = route(async (request) => {
  const expected = Buffer.from(process.env.MESSENGER_INTERNAL_TOKEN || "");
  const actual = Buffer.from(request.headers.get("x-messenger-internal-token") || "");
  if (!expected.length || expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new ApiError(401, "unauthorized", "Недоступно");
  return ok(await dispatchMessagePushes());
});
