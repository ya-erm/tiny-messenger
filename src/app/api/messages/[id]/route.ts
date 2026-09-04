import { ApiError, ok, readJson, route } from "@/lib/api";
import { authenticate } from "@/lib/auth";
import { canAccessMessage, canEditMessage, isMessageVisibleTo, publicMessage } from "@/lib/domain";
import { LIMITS } from "@/lib/constants";
import { assertRateLimit } from "@/lib/rate-limit";
import { readStore, updateStore } from "@/lib/store";
import { cleanString, isUuid, validLength } from "@/lib/validation";

type Context = { params: Promise<{ id: string }> };

export const GET = route<Context>(async (request, { params }) => {
  assertRateLimit(request, true);
  const authenticated = await authenticate(request);
  const { id } = await params;
  if (!isUuid(id)) throw new ApiError(400, "invalid_message_id", "Некорректный UUID сообщения");
  const store = await readStore();
  const message = store.messages.find((candidate) => candidate.id === id);
  if (!message || !canAccessMessage(authenticated, message) || !isMessageVisibleTo(message, authenticated.id)) {
    throw new ApiError(404, "message_not_found", "Сообщение не найдено");
  }
  return ok({ message: publicMessage(message) });
});

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
    const found = store.messages.find((candidate) => candidate.id === id);
    if (!found || !canAccessMessage(authenticated, found)) {
      throw new ApiError(404, "message_not_found", "Сообщение не найдено");
    }
    if (!canEditMessage(authenticated, found)) {
      throw new ApiError(403, "message_not_editable", "Можно менять только свои текстовые сообщения");
    }
    if (found.text === text) return found;
    found.text = text;
    found.editedAt = new Date().toISOString();
    return found;
  });

  return ok({ message: publicMessage(message) });
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
    const index = store.messages.findIndex((candidate) => candidate.id === id);
    const message = index >= 0 ? store.messages[index] : undefined;
    if (!message || !canAccessMessage(authenticated, message)) {
      throw new ApiError(404, "message_not_found", "Сообщение не найдено");
    }
    if (scope === "everyone") {
      store.messages.splice(index, 1);
      return;
    }
    message.deletedForUserIds ||= [];
    if (!message.deletedForUserIds.includes(authenticated.id)) {
      message.deletedForUserIds.push(authenticated.id);
    }
  });

  return ok({ deleted: true, id, scope });
});
