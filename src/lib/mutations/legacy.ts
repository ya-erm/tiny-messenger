import "server-only";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { acceptMutation } from "./accept";
import { parseMutation, serializeMutation, type Mutation, type TextMessageEntity } from "./protocol";

// Adapter-authored operations for old clients without a device ID/envelope.
const LEGACY_DEVICE_ID = "00000000-0000-4000-8000-000000000000";
function envelope(actorId: string) {
  return { protocolVersion: 1 as const, operationId: randomUUID(), actorId,
    deviceId: LEGACY_DEVICE_ID, occurredAt: new Date().toISOString() };
}

// The existing handler has already created the row and schedules its own push.
export async function journalLegacyCreation(tx: Prisma.TransactionClient, message: TextMessageEntity) {
  const operation: Mutation = { ...envelope(message.fromUserId), occurredAt: message.sentAt, type: "message.create", message };
  await tx.mutationOperation.create({ data: {
    operationId: operation.operationId, protocolVersion: operation.protocolVersion,
    actorId: operation.actorId, originId: process.env.TM_INSTALLATION_ID || "vps-1", deviceId: operation.deviceId, occurredAt: operation.occurredAt,
    type: operation.type, entityId: message.id, body: serializeMutation(operation),
    receivedAt: new Date().toISOString(), status: "applied",
  } });
}

type LegacyChange = { type: "message.edit"; text: string }
  | { type: "message.delete"; scope: "me" | "everyone" }
  | { type: "reaction.set"; emoji: string | null };

export async function applyLegacyChange(tx: Prisma.TransactionClient, messageId: string,
  actor: { id: string; name: string }, change: LegacyChange): Promise<boolean> {
  const entry = await tx.mutationOperation.findFirst({ where: { entityId: messageId, type: "message.create" } });
  if (!entry) return false;
  const creation = parseMutation(JSON.parse(entry.body));
  if (creation.type !== "message.create") return false;
  const base = envelope(actor.id);
  let operation: Mutation;
  if (change.type === "message.edit") operation = { ...base, type: change.type, message: { ...creation.message, text: change.text } };
  else if (change.type === "message.delete") operation = { ...base, type: change.type, deletion: { messageId, scope: change.scope } };
  else operation = { ...base, type: change.type, reaction: { messageId, userId: actor.id, emoji: change.emoji } };
  await acceptMutation(tx, operation, actor);
  return true;
}
