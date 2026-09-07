import { ApiError, ok, readJson, route } from "@/lib/api";
import { authenticate } from "@/lib/auth";
import { LIMITS } from "@/lib/constants";
import { read, write } from "@/lib/db";
import { canEditMessage, publicMessage } from "@/lib/domain";
import { assertRateLimit } from "@/lib/rate-limit";
import {
  deleteMessagesForUser,
  involving,
  messageInclude,
  readStatesForChat,
  toMessageRecord,
  visibleTo,
} from "@/lib/store";
import { cleanString, isUuid, validLength } from "@/lib/validation";

type Context = { params: Promise<{ id: string }> };

export const GET = route<Context>(async (request, { params }) => {
  assertRateLimit(request, true);
  const authenticated = await authenticate(request);
  const { id } = await params;
  if (!isUuid(id)) throw new ApiError(400, "invalid_message_id", "Некорректный UUID сообщения");
  const message = await read(async (db) => {
    const row = await db.message.findFirst({
      where: { id, ...involving(authenticated.id), ...visibleTo(authenticated.id) },
      include: messageInclude,
    });
    if (!row) return undefined;
    const readStates = await readStatesForChat(db, row.fromUserId);
    return publicMessage(toMessageRecord(row), readStates);
  });
  if (!message) throw new ApiError(404, "message_not_found", "Сообщение не найдено");
  return ok({ message });
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

  const message = await write(async (tx) => {
    const found = await tx.message.findFirst({
      where: { id, ...involving(authenticated.id) },
      include: messageInclude,
    });
    if (!found) throw new ApiError(404, "message_not_found", "Сообщение не найдено");
    if (!canEditMessage(authenticated, toMessageRecord(found))) {
      throw new ApiError(403, "message_not_editable", "Можно менять только свои текстовые сообщения");
    }
    const row = found.text !== text
      ? await tx.message.update({
        where: { id },
        data: { text, editedAt: new Date().toISOString() },
        include: messageInclude,
      })
      : found;
    const readStates = await readStatesForChat(tx, row.fromUserId);
    return publicMessage(toMessageRecord(row), readStates);
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

  await write(async (tx) => {
    const message = await tx.message.findFirst({
      where: { id, ...involving(authenticated.id) },
      select: { id: true },
    });
    if (!message) throw new ApiError(404, "message_not_found", "Сообщение не найдено");
    if (scope === "everyone") {
      await tx.message.delete({ where: { id } });
      return;
    }
    await deleteMessagesForUser(tx, [id], authenticated.id);
  });

  return ok({ deleted: true, id, scope });
});
