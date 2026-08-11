import { ok, readJson, route } from "@/lib/api";
import { authenticate } from "@/lib/auth";
import { LIMITS } from "@/lib/constants";
import { publicMessage } from "@/lib/domain";
import { assertRateLimit } from "@/lib/rate-limit";
import { readStore, updateStore } from "@/lib/store";

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

  const selectPending = (store: Awaited<ReturnType<typeof readStore>>) =>
    store.messages
      .filter(
        (message) =>
          message.toUserId === authenticated.id &&
          !message.readAt &&
          !message.answer &&
          (includeDeliveredUnread || !message.deliveredAt),
      )
      .sort((a, b) => a.sentAt.localeCompare(b.sentAt))
      .slice(0, limit);

  const snapshot = await readStore();
  const snapshotPending = selectPending(snapshot);
  const needsDeliveryWrite = snapshotPending.some((message) => !message.deliveredAt);

  const messages = needsDeliveryWrite ? await updateStore((store) => {
    const pending = selectPending(store);
    for (const message of pending) {
      message.deliveredAt ||= now;
    }
    return pending.map(publicMessage);
  }) : snapshotPending.map(publicMessage);

  return ok({ messages, polledAt: now });
});
