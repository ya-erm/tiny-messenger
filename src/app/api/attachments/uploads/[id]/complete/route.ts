import { ApiError, ok, route } from "@/lib/api";
import { authenticate } from "@/lib/auth";
import { completeAttachment } from "@/lib/attachments";
import { assertRateLimit } from "@/lib/rate-limit";
import { isUuid } from "@/lib/validation";

export const POST = route<{ params: Promise<{ id: string }> }>(async (request, { params }) => {
  assertRateLimit(request, true);
  const user = await authenticate(request);
  const { id } = await params;
  if (!isUuid(id)) throw new ApiError(400, "invalid_attachment_id", "Некорректный идентификатор файла");
  return ok({ attachment: await completeAttachment(user.id, id) });
});
