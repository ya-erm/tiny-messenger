import { randomUUID } from "node:crypto";
import { ApiError, ok, readJson, route } from "@/lib/api";
import { authenticate } from "@/lib/auth";
import { LIMITS } from "@/lib/constants";
import { publicMessage } from "@/lib/domain";
import { assertRateLimit } from "@/lib/rate-limit";
import { readStore, updateStore } from "@/lib/store";
import type { ChoiceOption, MessageRecord } from "@/lib/types";
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
  const store = await readStore();
  const messages = store.messages
    .filter((message) => {
      const inbox = message.toUserId === authenticated.id;
      const sent = message.fromUserId === authenticated.id;
      if (box === "inbox" && !inbox) return false;
      if (box === "sent" && !sent) return false;
      if (box === "all" && !inbox && !sent) return false;
      return !contactId || message.fromUserId === contactId || message.toUserId === contactId;
    })
    .sort((a, b) => b.sentAt.localeCompare(a.sentAt))
    .slice(0, limit)
    .reverse()
    .map(publicMessage);
  return ok({ messages });
});

export const POST = route(async (request) => {
  assertRateLimit(request, true);
  const authenticated = await authenticate(request);
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

  const message = await updateStore((store) => {
    if (!store.users.some((user) => user.id === toUserId)) {
      throw new ApiError(404, "recipient_not_found", "Получатель не найден");
    }
    const item: MessageRecord = {
      id: randomUUID(),
      fromUserId: authenticated.id,
      toUserId,
      senderName: authenticated.name,
      text,
      kind,
      ...(options ? { options } : {}),
      sentAt: new Date().toISOString(),
    };
    store.messages.push(item);
    return item;
  });
  return ok({ message: publicMessage(message) }, { status: 201 });
});
