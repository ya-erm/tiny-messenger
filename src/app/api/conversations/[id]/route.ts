import { ApiError, ok, readJson, route } from "@/lib/api";
import { authenticate } from "@/lib/auth";
import { write } from "@/lib/db";
import { assertRateLimit } from "@/lib/rate-limit";
import { conversationBetween, deleteMessagesForUser, hideConversation } from "@/lib/store";
import { isUuid } from "@/lib/validation";

type Context = { params: Promise<{ id: string }> };

export const DELETE = route<Context>(async (request, { params }) => {
  assertRateLimit(request, true);
  const authenticated = await authenticate(request);
  const { id: peerId } = await params;
  if (!isUuid(peerId)) throw new ApiError(400, "invalid_user_id", "Некорректный UUID собеседника");

  const body = await readJson(request);
  const mode = body.mode;
  const scope = body.scope;
  if (mode !== "hide" && mode !== "delete_history") {
    throw new ApiError(422, "invalid_delete_mode", "mode должен быть hide или delete_history");
  }
  if (mode === "delete_history" && scope !== "me" && scope !== "everyone") {
    throw new ApiError(422, "invalid_delete_scope", "scope должен быть me или everyone");
  }

  const result = await write(async (tx) => {
    const peer = await tx.user.findUnique({ where: { id: peerId }, select: { id: true } });
    if (!peer) throw new ApiError(404, "user_not_found", "Собеседник не найден");

    const now = new Date().toISOString();
    await hideConversation(tx, authenticated.id, peerId, now);

    if (mode === "hide") return { hidden: true, deletedCount: 0 };

    const conversation = await tx.message.findMany({
      where: conversationBetween(authenticated.id, peerId),
      select: { id: true },
    });
    const ids = conversation.map((message) => message.id);
    if (scope === "everyone") {
      await tx.message.deleteMany({ where: { id: { in: ids } } });
      await hideConversation(tx, peerId, authenticated.id, now);
    } else {
      await deleteMessagesForUser(tx, ids, authenticated.id);
    }

    return { hidden: true, deletedCount: ids.length };
  });

  return ok({ ...result, mode, ...(mode === "delete_history" ? { scope } : {}) });
});
