import { randomUUID } from "node:crypto";
import { ApiError, ok, readJson, route } from "@/lib/api";
import { authenticate } from "@/lib/auth";
import { attachFiles, attachmentIds, messageRequestId, messageRequestHash } from "@/lib/attachments";
import { LIMITS } from "@/lib/constants";
import { read, write } from "@/lib/db";
import { publicGroupMessage } from "@/lib/domain";
import { queueMessagePush } from "@/lib/push-queue";
import { assertMessageRateLimit, assertRateLimit } from "@/lib/rate-limit";
import {
  deleteGroupMessagesForUser,
  findGroupForMember,
  groupMessageInclude,
  memberOf,
  readStatesForChat,
  toGroupMessageRecord,
  visibleTo,
} from "@/lib/store";
import { cleanString, isUuid, validLength } from "@/lib/validation";

export const GET = route(async (request) => {
  assertRateLimit(request, true);
  const authenticated = await authenticate(request);
  const url = new URL(request.url);
  const groupId = url.searchParams.get("groupId");
  const requestedLimit = Number(url.searchParams.get("limit") || 50);
  const limit = Number.isInteger(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), LIMITS.pageSize)
    : 50;
  if (!isUuid(groupId)) throw new ApiError(400, "invalid_group_id", "Некорректный UUID группы");

  const messages = await read(async (db) => {
    const group = await findGroupForMember(db, groupId, authenticated.id);
    if (!group) throw new ApiError(404, "group_not_found", "Группа не найдена");
    const rows = await db.groupMessage.findMany({
      where: { groupId, ...visibleTo(authenticated.id) },
      include: groupMessageInclude,
      orderBy: { sentAt: "desc" },
      take: limit,
    });
    const readStates = await readStatesForChat(db, groupId);
    return rows.reverse().map((row) => publicGroupMessage(toGroupMessageRecord(row), group, readStates));
  });
  return ok({ messages });
});

export const POST = route(async (request) => {
  assertRateLimit(request, true);
  const authenticated = await authenticate(request);
  assertMessageRateLimit(request, authenticated.id);
  const body = await readJson(request);
  const groupId = cleanString(body.groupId);
  const text = cleanString(body.text);
  const files = attachmentIds(body.attachmentIds);
  const clientRequestId = messageRequestId(body.clientRequestId);

  if (!isUuid(groupId)) throw new ApiError(422, "invalid_group_id", "Укажите UUID группы");
  if (!validLength(text, files.length ? 0 : 1, LIMITS.message)) {
    throw new ApiError(422, "invalid_text", "Сообщение не должно быть пустым");
  }

  const requestHash = messageRequestHash({ groupId, text, files: [...files].sort() });
  const { message } = await write(async (tx) => {
    const found = await findGroupForMember(tx, groupId, authenticated.id);
    if (!found) throw new ApiError(404, "group_not_found", "Группа не найдена");
    if (clientRequestId) {
      const existing = await tx.groupMessage.findUnique({ where: { fromUserId_clientRequestId: { fromUserId: authenticated.id, clientRequestId } }, include: groupMessageInclude });
      if (existing) {
        if (existing.requestHash !== requestHash) throw new ApiError(409, "message_request_conflict", "Идентификатор отправки уже использован для другого сообщения");
        return { message: publicGroupMessage(toGroupMessageRecord(existing), found, await readStatesForChat(tx, groupId)), group: found, replayed: true };
      }
    }
    const row = await tx.groupMessage.create({
      include: groupMessageInclude,
      data: {
        id: randomUUID(),
        groupId,
        fromUserId: authenticated.id,
        senderName: authenticated.name,
        text,
        sentAt: new Date().toISOString(),
        clientRequestId, requestHash,
      },
    });
    await attachFiles(tx, authenticated.id, { kind: "group", id: groupId }, files, row.id);
    const readStates = await readStatesForChat(tx, groupId);
    const saved = files.length ? (await tx.groupMessage.findUnique({ where: { id: row.id }, include: groupMessageInclude }))! : row;
    for (const userId of found.memberIds) if (userId !== authenticated.id) await queueMessagePush(tx, userId, row.sentAt);
    return { message: publicGroupMessage(toGroupMessageRecord(saved), found, readStates), group: found, replayed: false };
  });

  return ok({ message }, { status: 201 });
});

export const DELETE = route(async (request) => {
  assertRateLimit(request, true);
  const authenticated = await authenticate(request);
  const body = await readJson(request);
  const ids = Array.isArray(body.ids) ? body.ids : [];
  const scope = body.scope;

  if (
    ids.length < 1
    || ids.length > LIMITS.pageSize
    || ids.some((id) => typeof id !== "string" || !isUuid(id))
  ) {
    throw new ApiError(
      422,
      "invalid_message_ids",
      `ids должен содержать от 1 до ${LIMITS.pageSize} UUID сообщений`,
    );
  }
  if (scope !== "me" && scope !== "everyone") {
    throw new ApiError(422, "invalid_delete_scope", "scope должен быть me или everyone");
  }

  const uniqueIds = [...new Set(ids as string[])];
  const deletedIds = await write(async (tx) => {
    const accessible = await tx.groupMessage.findMany({
      where: { id: { in: uniqueIds }, group: memberOf(authenticated.id) },
      select: { id: true, fromUserId: true },
    });
    if (accessible.length !== uniqueIds.length) {
      throw new ApiError(404, "message_not_found", "Одно или несколько сообщений не найдены");
    }

    if (scope === "everyone") {
      // Unlike a two-party chat, a group has bystanders: only the author may
      // take a message away from everyone.
      if (accessible.some((message) => message.fromUserId !== authenticated.id)) {
        throw new ApiError(403, "not_message_author", "Удалить у всех можно только свои сообщения");
      }
      await tx.groupMessage.deleteMany({ where: { id: { in: uniqueIds } } });
    } else {
      await deleteGroupMessagesForUser(tx, uniqueIds, authenticated.id);
    }
    return uniqueIds;
  });

  return ok({ deletedIds, scope });
});
