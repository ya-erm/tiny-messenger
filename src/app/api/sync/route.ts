import { ok, readJson, route } from "@/lib/api";
import { authenticate, publicUser } from "@/lib/auth";
import { LIMITS } from "@/lib/constants";
import { publicMessage } from "@/lib/domain";
import { assertRateLimit } from "@/lib/rate-limit";
import { readStore, updateStore } from "@/lib/store";
import type { PublicContact, StoreData } from "@/lib/types";

export const POST = route(async (request) => {
  assertRateLimit(request, true);
  const authenticated = await authenticate(request);
  const body = await readJson(request);
  const requestedLimit = Number(body.limit ?? 100);
  const limit = Number.isInteger(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), LIMITS.pageSize)
    : 100;
  const now = new Date().toISOString();

  const selectMessages = (store: StoreData) => store.messages
    .filter(
      (message) =>
        message.fromUserId === authenticated.id || message.toUserId === authenticated.id,
    )
    .sort((a, b) => b.sentAt.localeCompare(a.sentAt))
    .slice(0, limit)
    .reverse();

  const createPayload = (store: StoreData) => {
    const contacts = store.contacts
      .filter((contact) => contact.ownerId === authenticated.id)
      .flatMap((contact): PublicContact[] => {
        const user = store.users.find((candidate) => candidate.id === contact.userId);
        return user ? [{ ...contact, user: publicUser(user) }] : [];
      })
      .sort((a, b) => a.user.name.localeCompare(b.user.name, "ru"));

    return {
      contacts,
      messages: selectMessages(store).map(publicMessage),
      syncedAt: now,
    };
  };

  const snapshot = await readStore();
  const needsDeliveryWrite = selectMessages(snapshot).some(
    (message) => message.toUserId === authenticated.id && !message.deliveredAt,
  );

  const payload = needsDeliveryWrite
    ? await updateStore((store) => {
      for (const message of selectMessages(store)) {
        if (message.toUserId === authenticated.id) message.deliveredAt ||= now;
      }
      return createPayload(store);
    })
    : createPayload(snapshot);

  return ok(payload);
});
