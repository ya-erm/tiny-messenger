import { ok, readJson, route } from "@/lib/api";
import { authenticate, publicUser } from "@/lib/auth";
import { LIMITS } from "@/lib/constants";
import { read, write } from "@/lib/db";
import type { Db } from "@/lib/db";
import {
  findReadState,
  messageStatus,
  publicGroup,
  publicGroupMessage,
  publicMessage,
} from "@/lib/domain";
import { assertRateLimit } from "@/lib/rate-limit";
import {
  advanceReadState,
  groupInclude,
  involving,
  memberOf,
  messageInclude,
  readStatesAround,
  toGroupMessageRecord,
  toGroupRecord,
  toMessageRecord,
  toUserRecord,
  visibleTo,
} from "@/lib/store";
import type { PublicContact } from "@/lib/types";

export const POST = route(async (request) => {
  assertRateLimit(request, true);
  const authenticated = await authenticate(request);
  const body = await readJson(request);
  const requestedLimit = Number(body.limit ?? 100);
  const limit = Number.isInteger(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), LIMITS.pageSize)
    : 100;
  const now = new Date().toISOString();

  const load = async (db: Db) => {
    const groups = (await db.group.findMany({
      where: memberOf(authenticated.id),
      include: groupInclude,
    })).map(toGroupRecord);
    const groupIds = groups.map((group) => group.id);

    const [contacts, messages, groupMessages, hidden, readStates] = await Promise.all([
      db.contact.findMany({ where: { ownerId: authenticated.id }, include: { user: true } }),
      db.message.findMany({
        where: { ...involving(authenticated.id), ...visibleTo(authenticated.id) },
        include: messageInclude,
        orderBy: { sentAt: "desc" },
        take: limit,
      }),
      db.groupMessage.findMany({
        where: { groupId: { in: groupIds }, ...visibleTo(authenticated.id) },
        orderBy: { sentAt: "desc" },
        take: limit,
      }),
      db.hiddenConversation.findMany({ where: { ownerId: authenticated.id }, select: { peerId: true } }),
      readStatesAround(db, authenticated.id, groupIds),
    ]);

    return {
      groups,
      contacts,
      messages: messages.reverse().map(toMessageRecord),
      groupMessages: groupMessages.reverse().map(toGroupMessageRecord),
      hiddenPeerIds: hidden.map((item) => item.peerId),
      readStates,
    };
  };

  type Loaded = Awaited<ReturnType<typeof load>>;

  // Everything incoming that the reader has not yet been marked as having
  // received, keyed by chat and reduced to the newest sentAt per chat.
  const pendingDeliveries = (loaded: Loaded) => {
    const marks = new Map<string, string>();
    const note = (chatId: string, sentAt: string) => {
      const current = marks.get(chatId);
      if (!current || current < sentAt) marks.set(chatId, sentAt);
    };
    for (const message of loaded.messages) {
      if (message.toUserId === authenticated.id && messageStatus(message, loaded.readStates) === "sent") {
        note(message.fromUserId, message.sentAt);
      }
    }
    for (const message of loaded.groupMessages) {
      if (message.fromUserId === authenticated.id) continue;
      const state = findReadState(loaded.readStates, authenticated.id, message.groupId);
      if (!state?.lastDeliveredAt || state.lastDeliveredAt < message.sentAt) note(message.groupId, message.sentAt);
    }
    return marks;
  };

  const createPayload = (loaded: Loaded) => {
    const contacts = loaded.contacts
      .map((contact): PublicContact => ({
        userId: contact.userId,
        user: publicUser(toUserRecord(contact.user)),
        createdAt: contact.createdAt,
        updatedAt: contact.updatedAt,
      }))
      .sort((a, b) => a.user.name.localeCompare(b.user.name, "ru"));

    return {
      contacts,
      messages: loaded.messages.map((message) => publicMessage(message, loaded.readStates)),
      hiddenPeerIds: loaded.hiddenPeerIds,
      groups: loaded.groups.map(publicGroup),
      groupMessages: loaded.groupMessages.flatMap((message) => {
        const group = loaded.groups.find((candidate) => candidate.id === message.groupId);
        return group ? [publicGroupMessage(message, group, loaded.readStates)] : [];
      }),
      readStates: loaded.readStates
        .filter((state) => state.userId === authenticated.id)
        .map(({ chatId, lastDeliveredAt, lastReadAt }) => ({ chatId, lastDeliveredAt, lastReadAt })),
      syncedAt: now,
    };
  };

  const snapshot = await read(load);
  const payload = pendingDeliveries(snapshot).size > 0
    ? await write(async (tx) => {
      for (const [chatId, sentAt] of pendingDeliveries(await load(tx))) {
        await advanceReadState(tx, authenticated.id, chatId, { deliveredAt: sentAt });
      }
      return createPayload(await load(tx));
    })
    : createPayload(snapshot);

  return ok(payload);
});
