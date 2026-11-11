import "server-only";
import type { Prisma } from "@/generated/prisma/client";

// Coalesce in the same transaction as the message/read cursor. No detached
// in-memory timer can lose a message between acknowledgement and process exit.
export async function queueMessagePush(tx: Prisma.TransactionClient, userId: string, sentAt?: string) {
  const previous = await tx.pushNotificationState.findUnique({ where: { userId } });
  const now = new Date().toISOString();
  const due = new Date(Date.now() + (sentAt ? 6000 : 1000)).toISOString();
  const data = {
    dueAt: previous?.dueAt && previous.dueAt < due ? previous.dueAt : due,
    firstPendingAt: previous?.firstPendingAt ?? now,
    alertAfter: sentAt && (!previous?.alertAfter || sentAt < previous.alertAfter) ? sentAt : previous?.alertAfter ?? null,
    attempts: 0,
  };
  await tx.pushNotificationState.upsert({ where: { userId }, create: { userId, revision: 1, ...data }, update: { ...data, revision: { increment: 1 } } });
}

