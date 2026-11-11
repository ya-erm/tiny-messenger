import { ok, route } from "@/lib/api";
import { authenticate } from "@/lib/auth";
import { attachmentLimits } from "@/lib/attachment-config";
import { assertRateLimit } from "@/lib/rate-limit";

export const GET = route(async (request) => {
  assertRateLimit(request, true);
  await authenticate(request);
  return ok({ limits: attachmentLimits() });
});
