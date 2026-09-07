import { ok, readJson, route } from "@/lib/api";
import { authenticate } from "@/lib/auth";
import { LIMITS } from "@/lib/constants";
import { advanceReadState, isMessageVisibleTo, isUnread, messageStatus, publicMessage } from "@/lib/domain";
import { assertRateLimit } from "@/lib/rate-limit";
import { readStore, updateStore } from "@/lib/store";
import type { StoreData } from "@/lib/types";

export const POST = route(async (request) => {
  assertRateLimit(request, true);
  const authenticated = await authenticate(request);
  const body = await readJson(request);
  const requestedLimit = Number(body.limit ?? 20);
  const limit = Number.isInteger(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), LIMITS.pageSize)
    : 20;
  const includeDeliveredUnread = body.includeDeliveredUnread !== false;
  const now = new Date().toISOString();

  const selectPending = (store: StoreData) =>
    store.messages
      .filter((message) => {
        if (message.toUserId !== authenticated.id || !isMessageVisibleTo(message, authenticated.id)) return false;
        const status = messageStatus(message, store.readStates);
        return isUnread(status) && (includeDeliveredUnread || status === "sent");
      })
      .sort((a, b) => a.sentAt.localeCompare(b.sentAt))
      .slice(0, limit);

  const snapshot = await readStore();
  const snapshotPending = selectPending(snapshot);
  const needsDeliveryWrite = snapshotPending.some(
    (message) => messageStatus(message, snapshot.readStates) === "sent",
  );

  const messages = needsDeliveryWrite ? await updateStore((store) => {
    const pending = selectPending(store);
    for (const message of pending) {
      advanceReadState(store.readStates, authenticated.id, message.fromUserId, { deliveredAt: message.sentAt });
    }
    return pending.map((message) => publicMessage(message, store.readStates));
  }) : snapshotPending.map((message) => publicMessage(message, snapshot.readStates));

  return ok({ messages, polledAt: now });
});
