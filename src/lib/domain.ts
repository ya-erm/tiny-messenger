import type { MessageRecord, MessageStatus, PublicMessage, StoreData, UserRecord } from "@/lib/types";

export function messageStatus(message: MessageRecord): MessageStatus {
  if (message.answer) return "answered";
  if (message.readAt) return "read";
  if (message.deliveredAt) return "delivered";
  return "sent";
}

export function publicMessage(message: MessageRecord): PublicMessage {
  const { deletedForUserIds: _deletedForUserIds, ...visibleFields } = message;
  return { ...visibleFields, status: messageStatus(message) };
}

export function isMessageVisibleTo(message: MessageRecord, userId: string) {
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
