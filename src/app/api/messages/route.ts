import { randomUUID } from "node:crypto";
import { ApiError, ok, readJson, route } from "@/lib/api";
import { authenticate } from "@/lib/auth";
import { LIMITS } from "@/lib/constants";
import { read, write } from "@/lib/db";
import { publicMessage } from "@/lib/domain";
import { sendPushToUser } from "@/lib/push";
import { assertMessageRateLimit, assertRateLimit } from "@/lib/rate-limit";
import {
  deleteMessagesForUser,
  involving,
  messageInclude,
  readStatesAround,
  readStatesForChat,
  showConversation,
  toMessageRecord,
  visibleTo,
} from "@/lib/store";
import type { ChoiceOption } from "@/lib/types";
import { cleanString, isMessageKind, isUuid, validLength } from "@/lib/validation";

export const GET = route(async (request) => {
  assertRateLimit(request, true);
  const authenticated = await authenticate(request);
  const url = new URL(request.url);
  const box = url.searchParams.get("box") || "all";
  const contactId = url.searchParams.get("contactId");
  const requestedLimit = Number(url.searchParams.get("limit") || 50);
  const limit = Number.isInteger(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), LIMITS.pageSize)
    : 50;
  if (!['all', 'inbox', 'sent'].includes(box)) {
    throw new ApiError(400, "invalid_box", "box должен быть all, inbox или sent");
  }
  if (contactId && !isUuid(contactId)) {
    throw new ApiError(400, "invalid_contact_id", "Некорректный UUID собеседника");
  }
  const boxFilter = box === "inbox"
    ? { toUserId: authenticated.id }
    : box === "sent"
      ? { fromUserId: authenticated.id }
      : involving(authenticated.id);
  const messages = await read(async (db) => {
    const rows = await db.message.findMany({
      where: {
        AND: [
          boxFilter,
          visibleTo(authenticated.id),
          ...(contactId ? [{ OR: [{ fromUserId: contactId }, { toUserId: contactId }] }] : []),
        ],
      },
      include: messageInclude,
      orderBy: { sentAt: "desc" },
      take: limit,
    });
    const readStates = await readStatesAround(db, authenticated.id);
    return rows.reverse().map((row) => publicMessage(toMessageRecord(row), readStates));
  });
  return ok({ messages });
});

export const POST = route(async (request) => {
  assertRateLimit(request, true);
  const authenticated = await authenticate(request);
  assertMessageRateLimit(request, authenticated.id);
  const body = await readJson(request);
  const toUserId = cleanString(body.toUserId);
  const text = cleanString(body.text);
  const kind = body.kind ?? "text";

  if (!isUuid(toUserId)) throw new ApiError(422, "invalid_recipient", "Укажите UUID получателя");
  if (toUserId === authenticated.id) throw new ApiError(422, "self_message", "Отправка самому себе отключена");
  if (!validLength(text, 1, LIMITS.message)) {
    throw new ApiError(422, "invalid_text", `Сообщение: от 1 до ${LIMITS.message} символов`);
  }
  if (!isMessageKind(kind)) throw new ApiError(422, "invalid_kind", "kind должен быть text или choice");

  let options: ChoiceOption[] | undefined;
  if (kind === "choice") {
    const rawOptions = body.options;
    if (
      !Array.isArray(rawOptions) ||
      rawOptions.length < LIMITS.choiceOptionsMin ||
      rawOptions.length > LIMITS.choiceOptionsMax
    ) {
      throw new ApiError(
        422,
        "invalid_options",
        `options должен содержать от ${LIMITS.choiceOptionsMin} до ${LIMITS.choiceOptionsMax} вариантов`,
      );
    }
    options = rawOptions.map((option) => {
      const item = option && typeof option === "object" && !Array.isArray(option)
        ? option as Record<string, unknown>
        : {};
      return { id: cleanString(item.id), label: cleanString(item.label) };
    });
    if (options.some((option) => !validLength(option.label, 1, LIMITS.option))) {
      throw new ApiError(
        422,
        "invalid_options",
        `Каждый вариант обязателен и должен быть не длиннее ${LIMITS.option} символов`,
      );
    }
    if (options.some((option) => !validLength(option.id, 1, LIMITS.optionId) || !/^[A-Za-z0-9._~-]+$/.test(option.id))) {
      throw new ApiError(
        422,
        "invalid_option_id",
        `ID варианта: до ${LIMITS.optionId} латинских букв, цифр или символов . _ ~ -`,
      );
    }
    if (new Set(options.map((option) => option.id)).size !== options.length) {
      throw new ApiError(422, "duplicate_option_id", "ID вариантов внутри вопроса должны быть уникальны");
    }
  }

  const message = await write(async (tx) => {
    const recipient = await tx.user.findUnique({ where: { id: toUserId }, select: { id: true } });
    if (!recipient) throw new ApiError(404, "recipient_not_found", "Получатель не найден");
    const row = await tx.message.create({
      data: {
        id: randomUUID(),
        fromUserId: authenticated.id,
        toUserId,
        senderName: authenticated.name,
        text,
        kind,
        sentAt: new Date().toISOString(),
        ...(options
          ? { options: { create: options.map((option, position) => ({ optionId: option.id, label: option.label, position })) } }
          : {}),
      },
      include: messageInclude,
    });
    await showConversation(tx, authenticated.id, toUserId);
    const readStates = await readStatesForChat(tx, authenticated.id);
    return publicMessage(toMessageRecord(row), readStates);
  });
  await sendPushToUser(message.toUserId, {
    title: message.senderName,
    body: message.kind === "choice" && message.options
      ? `${message.text} · ${message.options.map((option) => option.label).join(" / ")}`
      : message.text,
    tag: `message-${message.id}`,
    url: `/id/${message.fromUserId}`,
  }).catch((error) => console.error("Failed to notify message recipient", error));
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
    const accessible = await tx.message.findMany({
      where: { id: { in: uniqueIds }, ...involving(authenticated.id) },
      select: { id: true },
    });
    if (accessible.length !== uniqueIds.length) {
      throw new ApiError(404, "message_not_found", "Одно или несколько сообщений не найдены");
    }

    if (scope === "everyone") {
      await tx.message.deleteMany({ where: { id: { in: uniqueIds } } });
    } else {
      await deleteMessagesForUser(tx, uniqueIds, authenticated.id);
    }
    return uniqueIds;
  });

  return ok({ deletedIds, scope });
});
