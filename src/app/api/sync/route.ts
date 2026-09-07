import { ok, readJson, route } from "@/lib/api";
import { authenticate, publicUser } from "@/lib/auth";
import { LIMITS } from "@/lib/constants";
import {
  advanceReadState,
  findReadState,
  isGroupMember,
  isMessageVisibleTo,
  messageStatus,
  publicGroup,
  publicGroupMessage,
  publicMessage,
} from "@/lib/domain";
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
        (message.fromUserId === authenticated.id || message.toUserId === authenticated.id)
        && isMessageVisibleTo(message, authenticated.id),
    )
    .sort((a, b) => b.sentAt.localeCompare(a.sentAt))
    .slice(0, limit)
    .reverse();

  const selectGroups = (store: StoreData) => store.groups
    .filter((group) => isGroupMember(group, authenticated.id));

  const selectGroupMessages = (store: StoreData) => {
    const groupIds = new Set(selectGroups(store).map((group) => group.id));
    return store.groupMessages
      .filter((message) => groupIds.has(message.groupId) && isMessageVisibleTo(message, authenticated.id))
      .sort((a, b) => b.sentAt.localeCompare(a.sentAt))
      .slice(0, limit)
      .reverse();
  };

  // Everything incoming that the reader has not yet been marked as having
  // received, keyed by chat and reduced to the newest sentAt per chat.
  const pendingDeliveries = (store: StoreData) => {
    const marks = new Map<string, string>();
    const note = (chatId: string, sentAt: string) => {
      const current = marks.get(chatId);
      if (!current || current < sentAt) marks.set(chatId, sentAt);
    };
    for (const message of selectMessages(store)) {
      if (message.toUserId === authenticated.id && messageStatus(message, store.readStates) === "sent") {
        note(message.fromUserId, message.sentAt);
      }
    }
    for (const message of selectGroupMessages(store)) {
      if (message.fromUserId === authenticated.id) continue;
      const state = findReadState(store.readStates, authenticated.id, message.groupId);
      if (!state?.lastDeliveredAt || state.lastDeliveredAt < message.sentAt) note(message.groupId, message.sentAt);
    }
    return marks;
  };

  const createPayload = (store: StoreData) => {
    const contacts = store.contacts
      .filter((contact) => contact.ownerId === authenticated.id)
      .flatMap((contact): PublicContact[] => {
        const user = store.users.find((candidate) => candidate.id === contact.userId);
        return user ? [{ ...contact, user: publicUser(user) }] : [];
      })
      .sort((a, b) => a.user.name.localeCompare(b.user.name, "ru"));
    const groups = selectGroups(store);

    return {
      contacts,
      messages: selectMessages(store).map((message) => publicMessage(message, store.readStates)),
      hiddenPeerIds: store.hiddenConversations
        .filter((item) => item.ownerId === authenticated.id)
        .map((item) => item.peerId),
      groups: groups.map((group) => publicGroup(group, store.users)),
      groupMessages: selectGroupMessages(store).flatMap((message) => {
        const group = groups.find((candidate) => candidate.id === message.groupId);
        return group ? [publicGroupMessage(message, group, store.readStates)] : [];
      }),
      readStates: store.readStates
        .filter((state) => state.userId === authenticated.id)
        .map(({ chatId, lastDeliveredAt, lastReadAt }) => ({ chatId, lastDeliveredAt, lastReadAt })),
      syncedAt: now,
    };
  };

  const snapshot = await readStore();
  const payload = pendingDeliveries(snapshot).size > 0
    ? await updateStore((store) => {
      for (const [chatId, sentAt] of pendingDeliveries(store)) {
        advanceReadState(store.readStates, authenticated.id, chatId, { deliveredAt: sentAt });
      }
      return createPayload(store);
    })
    : createPayload(snapshot);

  return ok(payload);
});
