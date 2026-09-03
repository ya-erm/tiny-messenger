import { ApiError, ok, readJson, route } from "@/lib/api";
import { authenticate } from "@/lib/auth";
import { hideConversation, isConversationMessage } from "@/lib/domain";
import { assertRateLimit } from "@/lib/rate-limit";
import { updateStore } from "@/lib/store";
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

  const result = await updateStore((store) => {
    if (!store.users.some((user) => user.id === peerId)) {
      throw new ApiError(404, "user_not_found", "Собеседник не найден");
    }

    const now = new Date().toISOString();
    hideConversation(store.hiddenConversations, authenticated.id, peerId, now);

    if (mode === "hide") return { hidden: true, deletedCount: 0 };

    const conversationMessages = store.messages.filter((message) =>
      isConversationMessage(message, authenticated.id, peerId));
    if (scope === "everyone") {
      const ids = new Set(conversationMessages.map((message) => message.id));
      store.messages = store.messages.filter((message) => !ids.has(message.id));
      hideConversation(store.hiddenConversations, peerId, authenticated.id, now);
    } else {
      for (const message of conversationMessages) {
        message.deletedForUserIds ||= [];
        if (!message.deletedForUserIds.includes(authenticated.id)) {
          message.deletedForUserIds.push(authenticated.id);
        }
      }
    }

    return { hidden: true, deletedCount: conversationMessages.length };
  });

  return ok({ ...result, mode, ...(mode === "delete_history" ? { scope } : {}) });
});
