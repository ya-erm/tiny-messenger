import { ok, readJson, route } from "@/lib/api";
import { authenticate } from "@/lib/auth";
import { beginAttachment } from "@/lib/attachments";
import { assertAttachmentUploadRateLimit, assertRateLimit } from "@/lib/rate-limit";

export const POST = route(async (request) => {
  assertRateLimit(request, true);
  const user = await authenticate(request);
  assertAttachmentUploadRateLimit(request, user.id);
  return ok(await beginAttachment(user.id, await readJson(request)), { status: 201 });
});
