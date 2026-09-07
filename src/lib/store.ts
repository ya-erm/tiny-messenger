import "server-only";

import type {
  GroupMessage,
  Prisma,
  PushSubscription,
  ReadState,
  User,
} from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { nextReadState, type ReadMarks } from "@/lib/domain";
import type {
  GroupMessageRecord,
  GroupRecord,
  MessageKind,
  MessageRecord,
  PushSubscriptionRecord,
  ReadStateRecord,
  UserRecord,
} from "@/lib/types";

// Row → record mappers. Prisma returns `null` for optional columns; the API and
// domain code treat "absent" as `undefined` and never emit nulls.

export function toUserRecord(row: User): UserRecord {
  return {
    id: row.id,
    name: row.name,
    ...(row.nickname ? { nickname: row.nickname } : {}),
    ...(row.avatarUrl ? { avatarUrl: row.avatarUrl } : {}),
    ...(row.avatarBackground ? { avatarBackground: row.avatarBackground } : {}),
    tokenHash: row.tokenHash,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export const messageInclude = {
  options: { orderBy: { position: "asc" } },
} satisfies Prisma.MessageInclude;

export type MessageRow = Prisma.MessageGetPayload<{ include: typeof messageInclude }>;

export function toMessageRecord(row: MessageRow): MessageRecord {
  return {
    id: row.id,
    fromUserId: row.fromUserId,
    toUserId: row.toUserId,
    senderName: row.senderName,
    text: row.text,
    kind: row.kind as MessageKind,
    ...(row.kind === "choice"
      ? { options: row.options.map((option) => ({ id: option.optionId, label: option.label })) }
      : {}),
    sentAt: row.sentAt,
    ...(row.editedAt ? { editedAt: row.editedAt } : {}),
    ...(row.answerId && row.answerLabel && row.answeredAt
      ? { answer: { id: row.answerId, label: row.answerLabel, answeredAt: row.answeredAt } }
      : {}),
  };
}

export const groupInclude = {
  members: { orderBy: { seq: "asc" }, include: { user: true } },
} satisfies Prisma.GroupInclude;

export type GroupRow = Prisma.GroupGetPayload<{ include: typeof groupInclude }>;

export function toGroupRecord(row: GroupRow): GroupRecord {
  const members = row.members.map((member) => toUserRecord(member.user));
  return {
    id: row.id,
    name: row.name,
    ...(row.avatarUrl ? { avatarUrl: row.avatarUrl } : {}),
    ...(row.avatarBackground ? { avatarBackground: row.avatarBackground } : {}),
    ownerId: row.ownerId,
    memberIds: members.map((member) => member.id),
    members,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toGroupMessageRecord(row: GroupMessage): GroupMessageRecord {
  return {
    id: row.id,
    groupId: row.groupId,
    fromUserId: row.fromUserId,
    senderName: row.senderName,
    text: row.text,
    sentAt: row.sentAt,
    ...(row.editedAt ? { editedAt: row.editedAt } : {}),
  };
}

export function toReadStateRecord(row: ReadState): ReadStateRecord {
  return {
    userId: row.userId,
    chatId: row.chatId,
    ...(row.lastDeliveredAt ? { lastDeliveredAt: row.lastDeliveredAt } : {}),
    ...(row.lastReadAt ? { lastReadAt: row.lastReadAt } : {}),
  };
}

export function toPushSubscriptionRecord(row: PushSubscription): PushSubscriptionRecord {
  return {
    userId: row.userId,
    endpoint: row.endpoint,
    ...(row.expirationTime !== null ? { expirationTime: Number(row.expirationTime) } : {}),
    keys: { p256dh: row.p256dh, auth: row.auth },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// Query fragments.

// "Deleted for me" hides a message from one party only. Shaped to fit both
// Message and GroupMessage filters.
export function visibleTo(userId: string) {
  return { deletions: { none: { userId } } };
}

export function involving(userId: string): Prisma.MessageWhereInput {
  return { OR: [{ fromUserId: userId }, { toUserId: userId }] };
}

export function conversationBetween(firstUserId: string, secondUserId: string): Prisma.MessageWhereInput {
  return {
    OR: [
      { fromUserId: firstUserId, toUserId: secondUserId },
      { fromUserId: secondUserId, toUserId: firstUserId },
    ],
  };
}

export function memberOf(userId: string): Prisma.GroupWhereInput {
  return { members: { some: { userId } } };
}

// Incoming, unanswered messages the reader's watermark of the given kind has
// not reached yet: everything from senders without a mark, plus anything newer
// than the mark for senders that have one.
export function notCoveredBy(
  userId: string,
  readStates: ReadStateRecord[],
  mark: "lastDeliveredAt" | "lastReadAt",
): Prisma.MessageWhereInput {
  const marks = readStates.filter((state) => state.userId === userId && state[mark]);
  return {
    toUserId: userId,
    answerId: null,
    ...visibleTo(userId),
    OR: [
      { fromUserId: { notIn: marks.map((state) => state.chatId) } },
      ...marks.map((state) => ({ fromUserId: state.chatId, sentAt: { gt: state[mark] } })),
    ],
  };
}

// Read states.

// Everything needed to compute receipts for a user's 1:1 chats: the marks they
// set as a reader, and the marks their peers set on messages they sent.
export async function readStatesAround(db: Db, userId: string, groupIds: string[] = []) {
  const rows = await db.readState.findMany({
    where: { OR: [{ userId }, { chatId: userId }, ...(groupIds.length ? [{ chatId: { in: groupIds } }] : [])] },
  });
  return rows.map(toReadStateRecord);
}

export async function readStatesForChat(db: Db, chatId: string) {
  const rows = await db.readState.findMany({ where: { chatId } });
  return rows.map(toReadStateRecord);
}

export async function advanceReadState(
  tx: Prisma.TransactionClient,
  userId: string,
  chatId: string,
  marks: ReadMarks,
) {
  const current = await tx.readState.findUnique({ where: { userId_chatId: { userId, chatId } } });
  const next = nextReadState(current ? toReadStateRecord(current) : undefined, marks);
  if (current && current.lastDeliveredAt === (next.lastDeliveredAt ?? null) && current.lastReadAt === (next.lastReadAt ?? null)) {
    return toReadStateRecord(current);
  }
  const row = await tx.readState.upsert({
    where: { userId_chatId: { userId, chatId } },
    create: { userId, chatId, lastDeliveredAt: next.lastDeliveredAt, lastReadAt: next.lastReadAt },
    update: { lastDeliveredAt: next.lastDeliveredAt, lastReadAt: next.lastReadAt },
  });
  return toReadStateRecord(row);
}

// Hidden conversations.

export async function hideConversation(
  tx: Prisma.TransactionClient,
  ownerId: string,
  peerId: string,
  hiddenAt: string,
) {
  await tx.hiddenConversation.upsert({
    where: { ownerId_peerId: { ownerId, peerId } },
    create: { ownerId, peerId, hiddenAt },
    update: { hiddenAt },
  });
}

export async function showConversationForUser(tx: Prisma.TransactionClient, ownerId: string, peerId: string) {
  await tx.hiddenConversation.deleteMany({ where: { ownerId, peerId } });
}

export async function showConversation(tx: Prisma.TransactionClient, firstUserId: string, secondUserId: string) {
  await tx.hiddenConversation.deleteMany({
    where: {
      OR: [
        { ownerId: firstUserId, peerId: secondUserId },
        { ownerId: secondUserId, peerId: firstUserId },
      ],
    },
  });
}

// "Delete for me" marks.

export async function deleteMessagesForUser(tx: Prisma.TransactionClient, messageIds: string[], userId: string) {
  const existing = await tx.messageDeletion.findMany({
    where: { userId, messageId: { in: messageIds } },
    select: { messageId: true },
  });
  const marked = new Set(existing.map((item) => item.messageId));
  const fresh = messageIds.filter((id) => !marked.has(id));
  if (fresh.length) {
    await tx.messageDeletion.createMany({ data: fresh.map((messageId) => ({ messageId, userId })) });
  }
}

export async function deleteGroupMessagesForUser(tx: Prisma.TransactionClient, messageIds: string[], userId: string) {
  const existing = await tx.groupMessageDeletion.findMany({
    where: { userId, messageId: { in: messageIds } },
    select: { messageId: true },
  });
  const marked = new Set(existing.map((item) => item.messageId));
  const fresh = messageIds.filter((id) => !marked.has(id));
  if (fresh.length) {
    await tx.groupMessageDeletion.createMany({ data: fresh.map((messageId) => ({ messageId, userId })) });
  }
}

// Groups.

export async function findGroupForMember(db: Db, groupId: string, userId: string) {
  const row = await db.group.findFirst({ where: { id: groupId, ...memberOf(userId) }, include: groupInclude });
  return row ? toGroupRecord(row) : undefined;
}
