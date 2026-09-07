import type {
  GroupMessageRecord,
  GroupRecord,
  MessageRecord,
  MessageStatus,
  PublicGroup,
  PublicGroupMessage,
  PublicMessage,
  PublicUser,
  ReadStateRecord,
  StoreData,
  UserRecord,
} from "@/lib/types";

export function publicUser(user: UserRecord): PublicUser {
  return {
    id: user.id,
    name: user.name,
    ...(user.nickname ? { nickname: user.nickname } : {}),
    ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
    ...(user.avatarBackground ? { avatarBackground: user.avatarBackground } : {}),
    createdAt: user.createdAt,
  };
}

export function findReadState(readStates: ReadStateRecord[], userId: string, chatId: string) {
  return readStates.find((item) => item.userId === userId && item.chatId === chatId);
}

// Cursors only move forward: marking an older message read must not un-read the
// newer ones already covered. ISO timestamps compare correctly as strings.
export function advanceReadState(
  readStates: ReadStateRecord[],
  userId: string,
  chatId: string,
  marks: { deliveredAt?: string; readAt?: string },
) {
  let state = findReadState(readStates, userId, chatId);
  if (!state) {
    state = { userId, chatId };
    readStates.push(state);
  }
  const deliveredAt = [marks.deliveredAt, marks.readAt].filter((value): value is string => Boolean(value)).sort().at(-1);
  if (deliveredAt && (!state.lastDeliveredAt || state.lastDeliveredAt < deliveredAt)) {
    state.lastDeliveredAt = deliveredAt;
  }
  if (marks.readAt && (!state.lastReadAt || state.lastReadAt < marks.readAt)) {
    state.lastReadAt = marks.readAt;
  }
  return state;
}

function receiptFor(state: ReadStateRecord | undefined, sentAt: string): MessageStatus {
  if (state?.lastReadAt && state.lastReadAt >= sentAt) return "read";
  if (state?.lastDeliveredAt && state.lastDeliveredAt >= sentAt) return "delivered";
  return "sent";
}

export function messageStatus(message: MessageRecord, readStates: ReadStateRecord[]): MessageStatus {
  if (message.answer) return "answered";
  return receiptFor(findReadState(readStates, message.toUserId, message.fromUserId), message.sentAt);
}

export function isUnread(status: MessageStatus) {
  return status === "sent" || status === "delivered";
}

export function publicMessage(message: MessageRecord, readStates: ReadStateRecord[]): PublicMessage {
  const { deletedForUserIds: _deletedForUserIds, ...visibleFields } = message;
  return { ...visibleFields, status: messageStatus(message, readStates) };
}

export function isMessageVisibleTo(message: { deletedForUserIds?: string[] }, userId: string) {
  return !message.deletedForUserIds?.includes(userId);
}

export function isConversationMessage(message: MessageRecord, firstUserId: string, secondUserId: string) {
  return (
    (message.fromUserId === firstUserId && message.toUserId === secondUserId)
    || (message.fromUserId === secondUserId && message.toUserId === firstUserId)
  );
}

export function hideConversation(
  hiddenConversations: StoreData["hiddenConversations"],
  ownerId: string,
  peerId: string,
  hiddenAt: string,
) {
  const existing = hiddenConversations.find(
    (item) => item.ownerId === ownerId && item.peerId === peerId,
  );
  if (existing) existing.hiddenAt = hiddenAt;
  else hiddenConversations.push({ ownerId, peerId, hiddenAt });
}

export function showConversation(
  hiddenConversations: StoreData["hiddenConversations"],
  firstUserId: string,
  secondUserId: string,
) {
  showConversationForUser(hiddenConversations, firstUserId, secondUserId);
  showConversationForUser(hiddenConversations, secondUserId, firstUserId);
}

export function showConversationForUser(
  hiddenConversations: StoreData["hiddenConversations"],
  ownerId: string,
  peerId: string,
) {
  for (let index = hiddenConversations.length - 1; index >= 0; index -= 1) {
    const item = hiddenConversations[index];
    if (item.ownerId === ownerId && item.peerId === peerId) {
      hiddenConversations.splice(index, 1);
    }
  }
}

export function canAccessMessage(user: UserRecord, message: MessageRecord) {
  return message.fromUserId === user.id || message.toUserId === user.id;
}

// Only the author edits, and only plain text: a question carries the options the
// recipient chose from, so rewriting one would leave an answer to a prompt that
// no longer exists.
export function canEditMessage(user: UserRecord, message: MessageRecord) {
  return message.fromUserId === user.id && message.kind === "text" && !message.answer;
}

export function isGroupMember(group: GroupRecord, userId: string) {
  return group.memberIds.includes(userId);
}

export function publicGroup(group: GroupRecord, users: UserRecord[]): PublicGroup {
  const members = group.memberIds.flatMap((id) => {
    const user = users.find((candidate) => candidate.id === id);
    return user ? [publicUser(user)] : [];
  });
  return {
    id: group.id,
    name: group.name,
    ...(group.avatarUrl ? { avatarUrl: group.avatarUrl } : {}),
    ...(group.avatarBackground ? { avatarBackground: group.avatarBackground } : {}),
    ownerId: group.ownerId,
    members,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
  };
}

export function canEditGroupMessage(user: UserRecord, message: GroupMessageRecord) {
  return message.fromUserId === user.id;
}

// The sender sees the weakest receipt among the other members: "read" only once
// everyone has read it, "delivered" once everyone has at least received it.
export function groupMessageStatus(
  message: GroupMessageRecord,
  group: GroupRecord,
  readStates: ReadStateRecord[],
): MessageStatus {
  const recipients = group.memberIds.filter((id) => id !== message.fromUserId);
  if (recipients.length === 0) return "sent";
  const receipts = recipients.map((id) => receiptFor(findReadState(readStates, id, group.id), message.sentAt));
  if (receipts.every((receipt) => receipt === "read")) return "read";
  if (receipts.every((receipt) => receipt !== "sent")) return "delivered";
  return "sent";
}

export function publicGroupMessage(
  message: GroupMessageRecord,
  group: GroupRecord,
  readStates: ReadStateRecord[],
): PublicGroupMessage {
  const { deletedForUserIds: _deletedForUserIds, ...visibleFields } = message;
  return { ...visibleFields, status: groupMessageStatus(message, group, readStates) };
}
