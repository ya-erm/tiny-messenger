import { ApiError, ok, readJson, route } from "@/lib/api";
import { authenticate } from "@/lib/auth";
import { LIMITS } from "@/lib/constants";
import { write } from "@/lib/db";
import { canEditGroupMessage, publicGroupMessage } from "@/lib/domain";
import { assertRateLimit } from "@/lib/rate-limit";
import type { Prisma } from "@/generated/prisma/client";
import {
  deleteGroupMessagesForUser,
  groupInclude,
  readStatesForChat,
  toGroupMessageRecord,
  toGroupRecord,
} from "@/lib/store";
import { cleanString, isUuid, validLength } from "@/lib/validation";

type Context = { params: Promise<{ id: string }> };

async function findAccessible(tx: Prisma.TransactionClient, id: string, userId: string) {
  const row = await tx.groupMessage.findFirst({
    where: { id, group: { members: { some: { userId } } } },
    include: { group: { include: groupInclude } },
  });
  if (!row) throw new ApiError(404, "message_not_found", "Сообщение не найдено");
  return { message: toGroupMessageRecord(row), group: toGroupRecord(row.group) };
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

  const message = await write(async (tx) => {
    const { message: found, group } = await findAccessible(tx, id, authenticated.id);
    if (!canEditGroupMessage(authenticated, found)) {
      throw new ApiError(403, "message_not_editable", "Можно менять только свои сообщения");
    }
    const row = found.text !== text
      ? toGroupMessageRecord(await tx.groupMessage.update({
        where: { id },
        data: { text, editedAt: new Date().toISOString() },
      }))
      : found;
    const readStates = await readStatesForChat(tx, group.id);
    return publicGroupMessage(row, group, readStates);
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
    const { message } = await findAccessible(tx, id, authenticated.id);
    if (scope === "everyone") {
      if (message.fromUserId !== authenticated.id) {
        throw new ApiError(403, "not_message_author", "Удалить у всех можно только свои сообщения");
      }
      await tx.groupMessage.delete({ where: { id } });
      return;
    }
    await deleteGroupMessagesForUser(tx, [id], authenticated.id);
  });

  return ok({ deleted: true, id, scope });
});
