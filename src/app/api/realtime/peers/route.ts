import { ok, route } from "@/lib/api";
import { authenticate } from "@/lib/auth";
import { isMessageVisibleTo } from "@/lib/domain";
import { assertRateLimit } from "@/lib/rate-limit";
import { readStore } from "@/lib/store";

export const GET = route(async (request) => {
  assertRateLimit(request, true);
  const authenticated = await authenticate(request);
  const store = await readStore();
  const userIds = new Set(
    store.contacts
      .filter((contact) => contact.ownerId === authenticated.id)
      .map((contact) => contact.userId),
  );

  for (const message of store.messages) {
    if (!isMessageVisibleTo(message, authenticated.id)) continue;
    if (message.fromUserId === authenticated.id) userIds.add(message.toUserId);
    if (message.toUserId === authenticated.id) userIds.add(message.fromUserId);
  }

  return ok({ userIds: [...userIds].sort() });
});
