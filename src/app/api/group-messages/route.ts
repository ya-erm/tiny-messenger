import { randomUUID } from "node:crypto";
import { ApiError, ok, readJson, route } from "@/lib/api";
import { authenticate } from "@/lib/auth";
import { LIMITS } from "@/lib/constants";
import { isGroupMember, isMessageVisibleTo, publicGroupMessage } from "@/lib/domain";
import { sendPushToUser } from "@/lib/push";
import { assertMessageRateLimit, assertRateLimit } from "@/lib/rate-limit";
import { readStore, updateStore } from "@/lib/store";
import type { GroupMessageRecord } from "@/lib/types";
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

  const store = await readStore();
  const group = store.groups.find((candidate) => candidate.id === groupId);
  if (!group || !isGroupMember(group, authenticated.id)) {
    throw new ApiError(404, "group_not_found", "Группа не найдена");
  }
  const messages = store.groupMessages
    .filter((message) => message.groupId === groupId && isMessageVisibleTo(message, authenticated.id))
    .sort((a, b) => b.sentAt.localeCompare(a.sentAt))
    .slice(0, limit)
    .reverse()
    .map((message) => publicGroupMessage(message, group, store.readStates));
  return ok({ messages });
});

export const POST = route(async (request) => {
  assertRateLimit(request, true);
  const authenticated = await authenticate(request);
  assertMessageRateLimit(request, authenticated.id);
  const body = await readJson(request);
  const groupId = cleanString(body.groupId);
  const text = cleanString(body.text);

  if (!isUuid(groupId)) throw new ApiError(422, "invalid_group_id", "Укажите UUID группы");
  if (!validLength(text, 1, LIMITS.message)) {
    throw new ApiError(422, "invalid_text", `Сообщение: от 1 до ${LIMITS.message} символов`);
  }

  const { message, group } = await updateStore((store) => {
    const found = store.groups.find((candidate) => candidate.id === groupId);
    if (!found || !isGroupMember(found, authenticated.id)) {
      throw new ApiError(404, "group_not_found", "Группа не найдена");
    }
    const item: GroupMessageRecord = {
      id: randomUUID(),
      groupId,
      fromUserId: authenticated.id,
      senderName: authenticated.name,
      text,
      sentAt: new Date().toISOString(),
    };
    store.groupMessages.push(item);
    return { message: publicGroupMessage(item, found, store.readStates), group: found };
  });

  const recipients = group.memberIds.filter((id) => id !== authenticated.id);
  await Promise.allSettled(recipients.map((userId) => sendPushToUser(userId, {
    title: group.name,
    body: `${message.senderName}: ${message.text}`,
    tag: `group-message-${message.id}`,
    url: "/",
  }).catch((error) => console.error("Failed to notify group member", error))));

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
  const deletedIds = await updateStore((store) => {
    const requested = new Set(uniqueIds);
    const memberOf = new Set(
      store.groups.filter((group) => isGroupMember(group, authenticated.id)).map((group) => group.id),
    );
    const accessible = store.groupMessages.filter(
      (message) => requested.has(message.id) && memberOf.has(message.groupId),
    );
    if (accessible.length !== uniqueIds.length) {
      throw new ApiError(404, "message_not_found", "Одно или несколько сообщений не найдены");
    }

    if (scope === "everyone") {
      // Unlike a two-party chat, a group has bystanders: only the author may
      // take a message away from everyone.
      if (accessible.some((message) => message.fromUserId !== authenticated.id)) {
        throw new ApiError(403, "not_message_author", "Удалить у всех можно только свои сообщения");
      }
      store.groupMessages = store.groupMessages.filter((message) => !requested.has(message.id));
    } else {
      for (const message of accessible) {
        message.deletedForUserIds ||= [];
        if (!message.deletedForUserIds.includes(authenticated.id)) {
          message.deletedForUserIds.push(authenticated.id);
        }
      }
    }
    return uniqueIds;
  });

  return ok({ deletedIds, scope });
});
