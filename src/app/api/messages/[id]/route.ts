import { ApiError, ok, route } from "@/lib/api";
import { authenticate } from "@/lib/auth";
import { canAccessMessage, publicMessage } from "@/lib/domain";
import { assertRateLimit } from "@/lib/rate-limit";
import { readStore } from "@/lib/store";
import { isUuid } from "@/lib/validation";

type Context = { params: Promise<{ id: string }> };

export const GET = route<Context>(async (request, { params }) => {
  assertRateLimit(request, true);
  const authenticated = await authenticate(request);
  const { id } = await params;
  if (!isUuid(id)) throw new ApiError(400, "invalid_message_id", "Некорректный UUID сообщения");
  const store = await readStore();
  const message = store.messages.find((candidate) => candidate.id === id);
  if (!message || !canAccessMessage(authenticated, message)) {
    throw new ApiError(404, "message_not_found", "Сообщение не найдено");
  }
  return ok({ message: publicMessage(message) });
});
