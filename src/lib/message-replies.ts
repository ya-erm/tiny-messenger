import "server-only";
import { ApiError } from "@/lib/api";
import type { Db } from "@/lib/db";
import { conversationBetween, involving, memberOf, visibleTo } from "@/lib/store";
import type { GroupMessageRecord, MessageRecord, MessageReply } from "@/lib/types";
import { isUuid } from "@/lib/validation";

export function replyId(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isUuid(value)) throw new ApiError(422, "invalid_reply", "Некорректное сообщение для ответа");
  return value;
}
export async function assertReplyTarget(db: Db, userId: string, chat: { kind: "peer" | "group"; id: string }, id?: string) {
  if (!id) return;
  const found = chat.kind === "peer"
    ? await db.message.findFirst({ where: { id, ...conversationBetween(userId, chat.id), ...visibleTo(userId) }, select: { id: true } })
    : await db.groupMessage.findFirst({ where: { id, groupId: chat.id, group: memberOf(userId), ...visibleTo(userId) }, select: { id: true } });
  if (!found) throw new ApiError(404, "reply_not_found", "Сообщение для ответа удалено или недоступно");
}

// Resolve a bounded preview in batches for this reader, including originals
// outside the current sync page. Never store a copy of private quoted content.
export async function withReplies<T extends MessageRecord | GroupMessageRecord>(db: Db, userId: string, messages: T[]): Promise<T[]> {
  const directIds = messages.filter((m) => "toUserId" in m && m.replyToId).map((m) => m.replyToId!);
  const groupIds = messages.filter((m) => "groupId" in m && m.replyToId).map((m) => m.replyToId!);
  const select = { id: true, fromUserId: true, senderName: true, text: true, attachments: { select: { originalName: true }, take: 1 } } as const;
  const direct = directIds.length ? await db.message.findMany({ where: { id: { in: directIds }, ...involving(userId), ...visibleTo(userId) }, select: { ...select, toUserId: true } }) : [];
  const groups = groupIds.length ? await db.groupMessage.findMany({ where: { id: { in: groupIds }, group: memberOf(userId), ...visibleTo(userId) }, select: { ...select, groupId: true } }) : [];
  const targets = new Map([...direct, ...groups].map((row) => [row.id, row]));
  return messages.map((message) => {
    if (!message.replyToId) return message;
    const target = targets.get(message.replyToId);
    const sameChat = target && ("toUserId" in message && "toUserId" in target
      ? ((message.fromUserId === target.fromUserId && message.toUserId === target.toUserId)
        || (message.fromUserId === target.toUserId && message.toUserId === target.fromUserId))
      : "groupId" in message && "groupId" in target && message.groupId === target.groupId);
    const reply: MessageReply = sameChat && target
      ? { id: target.id, available: true, senderName: target.senderName,
        text: Array.from(target.text || target.attachments[0]?.originalName || "Вложение").slice(0, 180).join("") }
      : { id: message.replyToId, available: false };
    return { ...message, reply };
  });
}
