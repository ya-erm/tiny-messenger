import { ApiError, ok, readJson, route } from "@/lib/api";
import { authenticate } from "@/lib/auth";
import { publicMessage } from "@/lib/domain";
import { assertRateLimit } from "@/lib/rate-limit";
import { updateStore } from "@/lib/store";
import { isUuid } from "@/lib/validation";

type Context = { params: Promise<{ id: string }> };

export const PATCH = route<Context>(async (request, { params }) => {
  assertRateLimit(request, true);
  const authenticated = await authenticate(request);
  const { id } = await params;
  if (!isUuid(id)) throw new ApiError(400, "invalid_message_id", "Некорректный UUID сообщения");
  const body = await readJson(request);
  const status = body.status;
  if (status !== "delivered" && status !== "read") {
    throw new ApiError(422, "invalid_status", "Статус должен быть delivered или read");
  }
  const now = new Date().toISOString();
  const message = await updateStore((store) => {
    const item = store.messages.find((candidate) => candidate.id === id);
    if (!item || item.toUserId !== authenticated.id) {
      throw new ApiError(404, "message_not_found", "Входящее сообщение не найдено");
    }
    item.deliveredAt ||= now;
    if (status === "read") item.readAt ||= now;
    return item;
  });
  return ok({ message: publicMessage(message) });
});
