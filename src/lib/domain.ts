import type { MessageRecord, MessageStatus, PublicMessage, UserRecord } from "@/lib/types";

export function messageStatus(message: MessageRecord): MessageStatus {
  if (message.answer) return "answered";
  if (message.readAt) return "read";
  if (message.deliveredAt) return "delivered";
  return "sent";
}

export function publicMessage(message: MessageRecord): PublicMessage {
  return { ...message, status: messageStatus(message) };
}

export function canAccessMessage(user: UserRecord, message: MessageRecord) {
  return message.fromUserId === user.id || message.toUserId === user.id;
}
