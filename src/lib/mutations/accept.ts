import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { ApiError } from "@/lib/api";
import { showConversation, deleteMessagesForUser } from "@/lib/store";
import { queueMessagePush } from "@/lib/push-queue";
import { serializeMutation, parseMutation, mutationMessageId, type Mutation } from "./protocol";
import { reduceMessageOperations } from "./reduce";

// Peer imports may retain an operation rejected after dependency resolution.
// Only the separately authenticated replication service may set peerImport.
// Caller owns the transaction: journal, projection and push commit together.
export async function acceptMutation(tx: Prisma.TransactionClient, input: Mutation, actor: { id: string; name: string }, options: { peerImport?: boolean } = {}) {
  const operation = parseMutation(input);
  if (operation.actorId !== actor.id) throw new ApiError(403, "mutation_actor_mismatch", "Нельзя отправить мутацию другого пользователя");
  const body = serializeMutation(operation);
  const previous = await tx.mutationOperation.findUnique({ where: { operationId: operation.operationId } });
  if (previous) {
    if (previous.body !== body) throw new ApiError(409, "mutation_conflict", "Идентификатор мутации уже использован для другого действия");
    return { operationId: previous.operationId, messageId: previous.entityId, receivedAt: previous.receivedAt, replayed: true, status: previous.status };
  }
  const messageId = mutationMessageId(operation);
  const entries = await tx.mutationOperation.findMany({ where: { entityId: messageId } });
  const operations = entries.map((entry) => parseMutation(JSON.parse(entry.body)));
  const hasCreation = operations.some((op) => op.type === "message.create");
  const existing = await tx.message.findUnique({ where: { id: messageId } });
  if (operation.type === "message.create") {
    if (hasCreation || existing) throw new ApiError(409, "message_id_conflict", "Сообщение с таким идентификатором уже существует");
    if (!await tx.user.findUnique({ where: { id: operation.message.toUserId }, select: { id: true } })) {
      throw new ApiError(404, "recipient_not_found", "Получатель не найден");
    }
  } else if (!hasCreation && existing) {
    throw new ApiError(409, "legacy_message_not_managed", "Это сообщение ещё не включено в журнал мутаций");
  }
  const projection = reduceMessageOperations([...operations, operation]);
  const status = projection.statuses.get(operation.operationId)!;
  if (status === "rejected" && !options.peerImport) throw new ApiError(403, "mutation_not_allowed", "Нет прав на изменение сообщения или изменены неизменяемые поля");
  const receivedAt = new Date().toISOString();
  await tx.mutationOperation.create({ data: {
    operationId: operation.operationId, protocolVersion: operation.protocolVersion,
    actorId: operation.actorId, deviceId: operation.deviceId, occurredAt: operation.occurredAt,
    type: operation.type, entityId: messageId, body, receivedAt, status,
  } });
  for (const entry of entries) {
    const nextStatus = projection.statuses.get(entry.operationId)!;
    if (nextStatus !== entry.status) await tx.mutationOperation.update({ where: { operationId: entry.operationId }, data: { status: nextStatus } });
  }
  const message = projection.message;
  if (message) {
    if (projection.deleted) {
      await tx.message.deleteMany({ where: { id: messageId } });
      if (existing) await queueMessagePush(tx, message.toUserId);
    } else {
      if (!existing) {
        const author = await tx.user.findUniqueOrThrow({ where: { id: message.fromUserId }, select: { name: true } });
        await tx.message.create({ data: { ...message, senderName: author.name, editedAt: projection.editedAt, ...(options.peerImport ? { receiptStatus: "sent" } : {}) } });
        await showConversation(tx, message.fromUserId, message.toUserId);
        // queueMessagePush schedules from Date.now(); sentAt is its unread
        // alert boundary and must match the message, including offline sends.
        await queueMessagePush(tx, message.toUserId, message.sentAt);
      } else if (existing.text !== message.text || existing.editedAt !== projection.editedAt) {
        await tx.message.update({ where: { id: messageId }, data: { text: message.text, editedAt: projection.editedAt } });
      }
      await tx.messageReaction.deleteMany({ where: { messageId } });
      if (projection.reactions.length) await tx.messageReaction.createMany({ data: projection.reactions.map((reaction) => ({ ...reaction, messageId })) });
      for (const userId of projection.hiddenFor) await deleteMessagesForUser(tx, [messageId], userId);
    }
  }
  return { operationId: operation.operationId, messageId, receivedAt, replayed: false, status };
}
