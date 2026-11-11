import { ApiError, ok, route } from "@/lib/api";
import { authenticate } from "@/lib/auth";
import { attachmentLink } from "@/lib/attachments";
import { assertRateLimit } from "@/lib/rate-limit";
import { isUuid } from "@/lib/validation";

export const GET = route<{ params: Promise<{ id: string }> }>(async (request, { params }) => {
  assertRateLimit(request, true);
  const user = await authenticate(request);
  const { id } = await params;
  if (!isUuid(id)) throw new ApiError(400, "invalid_attachment_id", "Некорректный идентификатор файла");
  const mode = new URL(request.url).searchParams.get("mode") || "download";
  if (!["download", "preview"].includes(mode)) throw new ApiError(422, "invalid_attachment_mode", "Неизвестный режим открытия файла");
  return ok(await attachmentLink(user.id, id, mode === "preview"));
});
