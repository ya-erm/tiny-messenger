import { timingSafeEqual } from "node:crypto";
import { ApiError, ok, route } from "@/lib/api";
import { cleanupAttachments } from "@/lib/attachments";

export const POST = route(async (request) => {
  const expected = process.env.MESSENGER_INTERNAL_TOKEN || "";
  const actual = request.headers.get("x-messenger-internal-token") || "";
  const provided = Buffer.from(actual);
  const configured = Buffer.from(expected);
  if (!expected || provided.length !== configured.length || !timingSafeEqual(provided, configured)) throw new ApiError(401, "unauthorized", "Недоступно");
  return ok(await cleanupAttachments());
});
