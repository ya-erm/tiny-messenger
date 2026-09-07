import { ApiError, ok, readJson, route } from "@/lib/api";
import { authenticate } from "@/lib/auth";
import { advanceReadState, isGroupMember, isMessageVisibleTo, publicGroupMessage } from "@/lib/domain";
import { assertRateLimit } from "@/lib/rate-limit";
import { updateStore } from "@/lib/store";
import { isUuid } from "@/lib/validation";

type Context = { params: Promise<{ id: string }> };

// Moves the caller's watermark in the group up to this message.
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
  const message = await updateStore((store) => {
    const item = store.groupMessages.find((candidate) => candidate.id === id);
    const group = item ? store.groups.find((candidate) => candidate.id === item.groupId) : undefined;
    if (!item || !group || !isGroupMember(group, authenticated.id) || !isMessageVisibleTo(item, authenticated.id)) {
      throw new ApiError(404, "message_not_found", "Сообщение не найдено");
    }
    advanceReadState(store.readStates, authenticated.id, group.id, {
      deliveredAt: item.sentAt,
      ...(status === "read" ? { readAt: item.sentAt } : {}),
    });
    return publicGroupMessage(item, group, store.readStates);
  });
  return ok({ message });
});
