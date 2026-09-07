import { ApiError, ok, readJson, route } from "@/lib/api";
import { authenticate } from "@/lib/auth";
import { write } from "@/lib/db";
import { publicGroupMessage } from "@/lib/domain";
import { assertRateLimit } from "@/lib/rate-limit";
import {
  advanceReadState,
  groupInclude,
  readStatesForChat,
  toGroupMessageRecord,
  toGroupRecord,
  visibleTo,
} from "@/lib/store";
import { isUuid } from "@/lib/validation";

type Context = { params: Promise<{ id: string }> };

// Moves the caller's watermark in the group up to this message.
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
    const row = await tx.groupMessage.findFirst({
      where: { id, group: { members: { some: { userId: authenticated.id } } }, ...visibleTo(authenticated.id) },
      include: { group: { include: groupInclude } },
    });
    if (!row) throw new ApiError(404, "message_not_found", "Сообщение не найдено");
    await advanceReadState(tx, authenticated.id, row.groupId, {
      deliveredAt: row.sentAt,
      ...(status === "read" ? { readAt: row.sentAt } : {}),
    });
    const readStates = await readStatesForChat(tx, row.groupId);
    return publicGroupMessage(toGroupMessageRecord(row), toGroupRecord(row.group), readStates);
  });
  return ok({ message });
});
