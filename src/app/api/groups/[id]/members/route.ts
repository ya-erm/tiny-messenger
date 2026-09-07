import { ApiError, ok, readJson, route } from "@/lib/api";
import { authenticate } from "@/lib/auth";
import { LIMITS } from "@/lib/constants";
import { advanceReadState, isGroupMember, publicGroup } from "@/lib/domain";
import { assertRateLimit } from "@/lib/rate-limit";
import { updateStore } from "@/lib/store";
import { cleanString, isUuid } from "@/lib/validation";

type Context = { params: Promise<{ id: string }> };

export const POST = route<Context>(async (request, { params }) => {
  assertRateLimit(request, true);
  const authenticated = await authenticate(request);
  const { id } = await params;
  if (!isUuid(id)) throw new ApiError(400, "invalid_group_id", "Некорректный UUID группы");
  const body = await readJson(request);
  const userId = cleanString(body.userId);
  if (!isUuid(userId)) throw new ApiError(422, "invalid_user_id", "Укажите UUID участника");

  const group = await updateStore((store) => {
    const item = store.groups.find((candidate) => candidate.id === id);
    if (!item || !isGroupMember(item, authenticated.id)) {
      throw new ApiError(404, "group_not_found", "Группа не найдена");
    }
    if (!store.users.some((user) => user.id === userId)) {
      throw new ApiError(404, "user_not_found", "Пользователь не найден");
    }
    if (!isGroupMember(item, userId)) {
      if (item.memberIds.length >= LIMITS.groupMembersMax) {
        throw new ApiError(422, "too_many_members", `В группе не может быть больше ${LIMITS.groupMembersMax} участников`);
      }
      const now = new Date().toISOString();
      item.memberIds.push(userId);
      item.updatedAt = now;
      // The newcomer has not read the history, but it should not hold every
      // older message at "unread" for its author either.
      advanceReadState(store.readStates, userId, item.id, { readAt: now });
    }
    return publicGroup(item, store.users);
  });
  return ok({ group });
});

export const DELETE = route<Context>(async (request, { params }) => {
  assertRateLimit(request, true);
  const authenticated = await authenticate(request);
  const { id } = await params;
  if (!isUuid(id)) throw new ApiError(400, "invalid_group_id", "Некорректный UUID группы");
  const body = await readJson(request);
  const userId = cleanString(body.userId);
  if (!isUuid(userId)) throw new ApiError(422, "invalid_user_id", "Укажите UUID участника");
  if (userId === authenticated.id) {
    throw new ApiError(422, "cannot_remove_self", "Чтобы выйти из группы, используйте выход из группы");
  }

  const group = await updateStore((store) => {
    const item = store.groups.find((candidate) => candidate.id === id);
    if (!item || !isGroupMember(item, authenticated.id)) {
      throw new ApiError(404, "group_not_found", "Группа не найдена");
    }
    if (item.ownerId !== authenticated.id) {
      throw new ApiError(403, "not_group_owner", "Исключать участников может только владелец группы");
    }
    if (!isGroupMember(item, userId)) {
      throw new ApiError(404, "member_not_found", "Такого участника в группе нет");
    }
    item.memberIds = item.memberIds.filter((memberId) => memberId !== userId);
    item.updatedAt = new Date().toISOString();
    return publicGroup(item, store.users);
  });
  return ok({ group });
});
