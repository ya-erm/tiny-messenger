import { ApiError, ok, readJson, route } from "@/lib/api";
import { authenticate } from "@/lib/auth";
import { write } from "@/lib/db";
import { publicMessage } from "@/lib/domain";
import { sendPushToUser } from "@/lib/push";
import { assertRateLimit } from "@/lib/rate-limit";
import { advanceReadState, messageInclude, readStatesForChat, toMessageRecord, visibleTo } from "@/lib/store";
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
  const result = await write(async (tx) => {
    const found = await tx.message.findFirst({
      where: { id, toUserId: authenticated.id, ...visibleTo(authenticated.id) },
      include: messageInclude,
    });
    if (!found) throw new ApiError(404, "message_not_found", "Входящее сообщение не найдено");
    const item = toMessageRecord(found);
    if (item.kind !== "choice" || !item.options) {
      throw new ApiError(409, "not_a_choice", "У этого сообщения нет вариантов ответа");
    }
    if (item.answer && item.answer.id !== optionId) {
      throw new ApiError(409, "already_answered", "Ответ уже был выбран и не может быть изменён");
    }
    const option = item.options.find((candidate) => candidate.id === optionId);
    if (!option) throw new ApiError(422, "invalid_choice", "Такого варианта нет");
    await advanceReadState(tx, authenticated.id, item.fromUserId, { readAt: item.sentAt });
    const answeredNow = !item.answer;
    const row = answeredNow
      ? await tx.message.update({
        where: { id },
        data: { answerId: optionId, answerLabel: option.label, answeredAt: now },
        include: messageInclude,
      })
      : found;
    const readStates = await readStatesForChat(tx, row.fromUserId);
    return { message: publicMessage(toMessageRecord(row), readStates), answeredNow };
  });
  if (result.answeredNow && result.message.answer) {
    await sendPushToUser(result.message.fromUserId, {
      title: `${authenticated.name} ответил`,
      body: `${result.message.text} — ${result.message.answer.label}`,
      tag: `answer-${result.message.id}`,
      url: `/id/${authenticated.id}`,
    }).catch((error) => console.error("Failed to notify question sender", error));
  }
  return ok({ message: result.message });
});
