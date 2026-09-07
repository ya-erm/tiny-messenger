import { ApiError, ok, readJson, route } from "@/lib/api";
import { authenticate } from "@/lib/auth";
import { write } from "@/lib/db";
import { publicMessage } from "@/lib/domain";
import { assertRateLimit } from "@/lib/rate-limit";
import { advanceReadState, messageInclude, readStatesForChat, toMessageRecord, visibleTo } from "@/lib/store";
import { isUuid } from "@/lib/validation";

type Context = { params: Promise<{ id: string }> };

// Marks the message and everything the same sender wrote before it: the receipt
// is a watermark on the conversation, not a flag on the message.
export const PATCH = route<Context>(async (request, { params }) => {
  assertRateLimit(request, true);
  const authenticated = await authenticate(request);
  const { id } = await params;
  if (!isUuid(id)) throw new ApiError(400, "invalid_message_id", "Некорректный UUID сообщения");
  const body = await readJson(request);
  const status = body.status;
  if (status !== "delivered" && status !== "read") {
    throw new ApiError(422, "invalid_status", "Статус должен быть delivered или read");
  }
  const message = await write(async (tx) => {
    const row = await tx.message.findFirst({
      where: { id, toUserId: authenticated.id, ...visibleTo(authenticated.id) },
      include: messageInclude,
    });
    if (!row) throw new ApiError(404, "message_not_found", "Входящее сообщение не найдено");
    await advanceReadState(tx, authenticated.id, row.fromUserId, {
      deliveredAt: row.sentAt,
      ...(status === "read" ? { readAt: row.sentAt } : {}),
    });
    const readStates = await readStatesForChat(tx, row.fromUserId);
    return publicMessage(toMessageRecord(row), readStates);
  });
  return ok({ message });
});
