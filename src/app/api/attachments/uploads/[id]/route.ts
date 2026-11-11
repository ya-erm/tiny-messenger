import { ApiError, ok, route } from "@/lib/api";
import { authenticate } from "@/lib/auth";
import { cancelAttachment } from "@/lib/attachments";
import { assertRateLimit } from "@/lib/rate-limit";
import { isUuid } from "@/lib/validation";

export const DELETE = route<{ params: Promise<{ id: string }> }>(async (request, { params }) => {
  assertRateLimit(request, true);
  const user = await authenticate(request);
  const { id } = await params;
  if (!isUuid(id)) throw new ApiError(400, "invalid_attachment_id", "Некорректный идентификатор файла");
  await cancelAttachment(user.id, id);
  return ok({ cancelled: true });
});
