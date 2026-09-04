import { ApiError, ok, readJson, route } from "@/lib/api";
import { authenticate } from "@/lib/auth";
import { isMessageVisibleTo, publicMessage } from "@/lib/domain";
import { sendPushToUser } from "@/lib/push";
import { assertRateLimit } from "@/lib/rate-limit";
import { updateStore } from "@/lib/store";
import { isUuid } from "@/lib/validation";

type Context = { params: Promise<{ id: string }> };

export const POST = route<Context>(async (request, { params }) => {
  assertRateLimit(request, true);
  const authenticated = await authenticate(request);
  const { id } = await params;
  if (!isUuid(id)) throw new ApiError(400, "invalid_message_id", "Некорректный UUID сообщения");
  const body = await readJson(request);
  const optionId = body.id;
  if (typeof optionId !== "string" || !optionId) {
    throw new ApiError(422, "invalid_choice", "id должен быть непустым строковым идентификатором варианта");
  }
  const now = new Date().toISOString();
  const result = await updateStore((store) => {
    const item = store.messages.find((candidate) => candidate.id === id);
    if (!item || item.toUserId !== authenticated.id || !isMessageVisibleTo(item, authenticated.id)) {
      throw new ApiError(404, "message_not_found", "Входящее сообщение не найдено");
    }
    if (item.kind !== "choice" || !item.options) {
      throw new ApiError(409, "not_a_choice", "У этого сообщения нет вариантов ответа");
    }
    if (item.answer && item.answer.id !== optionId) {
      throw new ApiError(409, "already_answered", "Ответ уже был выбран и не может быть изменён");
    }
    const option = item.options.find((candidate) => candidate.id === optionId);
    if (!option) throw new ApiError(422, "invalid_choice", "Такого варианта нет");
    item.deliveredAt ||= now;
    item.readAt ||= now;
    const answeredNow = !item.answer;
    item.answer ||= { id: optionId, label: option.label, answeredAt: now };
    return { message: item, answeredNow };
  });
  if (result.answeredNow && result.message.answer) {
    await sendPushToUser(result.message.fromUserId, {
      title: `${authenticated.name} ответил`,
      body: `${result.message.text} — ${result.message.answer.label}`,
      tag: `answer-${result.message.id}`,
      url: `/id/${authenticated.id}`,
    }).catch((error) => console.error("Failed to notify question sender", error));
  }
  return ok({ message: publicMessage(result.message) });
});
