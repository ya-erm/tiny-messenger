import { ApiError, ok, readJson, route } from "@/lib/api";
import { authenticate } from "@/lib/auth";
import { LIMITS } from "@/lib/constants";
import { canEditGroupMessage, isGroupMember, publicGroupMessage } from "@/lib/domain";
import { assertRateLimit } from "@/lib/rate-limit";
import { updateStore } from "@/lib/store";
import type { StoreData } from "@/lib/types";
import { cleanString, isUuid, validLength } from "@/lib/validation";

type Context = { params: Promise<{ id: string }> };

function findAccessible(store: StoreData, id: string, userId: string) {
  const index = store.groupMessages.findIndex((candidate) => candidate.id === id);
  const message = index >= 0 ? store.groupMessages[index] : undefined;
  const group = message ? store.groups.find((candidate) => candidate.id === message.groupId) : undefined;
  if (!message || !group || !isGroupMember(group, userId)) {
    throw new ApiError(404, "message_not_found", "Сообщение не найдено");
  }
  return { index, message, group };
}

export const PATCH = route<Context>(async (request, { params }) => {
  assertRateLimit(request, true);
  const authenticated = await authenticate(request);
  const { id } = await params;
  if (!isUuid(id)) throw new ApiError(400, "invalid_message_id", "Некорректный UUID сообщения");
  const body = await readJson(request);
  const text = cleanString(body.text);
  if (!validLength(text, 1, LIMITS.message)) {
    throw new ApiError(422, "invalid_text", `Сообщение: от 1 до ${LIMITS.message} символов`);
  }

  const message = await updateStore((store) => {
    const { message: found, group } = findAccessible(store, id, authenticated.id);
    if (!canEditGroupMessage(authenticated, found)) {
      throw new ApiError(403, "message_not_editable", "Можно менять только свои сообщения");
    }
    if (found.text !== text) {
      found.text = text;
      found.editedAt = new Date().toISOString();
    }
    return publicGroupMessage(found, group, store.readStates);
  });

  return ok({ message });
});

export const DELETE = route<Context>(async (request, { params }) => {
  assertRateLimit(request, true);
  const authenticated = await authenticate(request);
  const { id } = await params;
  if (!isUuid(id)) throw new ApiError(400, "invalid_message_id", "Некорректный UUID сообщения");
  const body = await readJson(request);
  const scope = body.scope;
  if (scope !== "me" && scope !== "everyone") {
    throw new ApiError(422, "invalid_delete_scope", "scope должен быть me или everyone");
  }

  await updateStore((store) => {
    const { index, message } = findAccessible(store, id, authenticated.id);
    if (scope === "everyone") {
      if (message.fromUserId !== authenticated.id) {
        throw new ApiError(403, "not_message_author", "Удалить у всех можно только свои сообщения");
      }
      store.groupMessages.splice(index, 1);
      return;
    }
    message.deletedForUserIds ||= [];
    if (!message.deletedForUserIds.includes(authenticated.id)) {
      message.deletedForUserIds.push(authenticated.id);
    }
  });

  return ok({ deleted: true, id, scope });
});
