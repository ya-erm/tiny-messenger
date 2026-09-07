import { ok, readJson, route } from "@/lib/api";
import { authenticate } from "@/lib/auth";
import { LIMITS } from "@/lib/constants";
import { read, write } from "@/lib/db";
import { messageStatus, publicMessage } from "@/lib/domain";
import { assertRateLimit } from "@/lib/rate-limit";
import {
  advanceReadState,
  messageInclude,
  notCoveredBy,
  toMessageRecord,
  toReadStateRecord,
} from "@/lib/store";
import type { Db } from "@/lib/db";

export const POST = route(async (request) => {
  assertRateLimit(request, true);
  const authenticated = await authenticate(request);
  const body = await readJson(request);
  const requestedLimit = Number(body.limit ?? 20);
  const limit = Number.isInteger(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), LIMITS.pageSize)
    : 20;
  const includeDeliveredUnread = body.includeDeliveredUnread !== false;
  const now = new Date().toISOString();

  const selectPending = async (db: Db) => {
    const readStates = (await db.readState.findMany({ where: { userId: authenticated.id } })).map(toReadStateRecord);
    const rows = await db.message.findMany({
      where: notCoveredBy(authenticated.id, readStates, includeDeliveredUnread ? "lastReadAt" : "lastDeliveredAt"),
      include: messageInclude,
      orderBy: { sentAt: "asc" },
      take: limit,
    });
    return { readStates, pending: rows.map(toMessageRecord) };
  };

  const snapshot = await read(selectPending);
  const needsDeliveryWrite = snapshot.pending.some(
    (message) => messageStatus(message, snapshot.readStates) === "sent",
  );

  const messages = needsDeliveryWrite ? await write(async (tx) => {
    const { pending } = await selectPending(tx);
    // One watermark move per sender: the newest pending message covers the rest.
    const newest = new Map<string, string>();
    for (const message of pending) {
      const current = newest.get(message.fromUserId);
      if (!current || current < message.sentAt) newest.set(message.fromUserId, message.sentAt);
    }
    for (const [fromUserId, sentAt] of newest) {
      await advanceReadState(tx, authenticated.id, fromUserId, { deliveredAt: sentAt });
    }
    const readStates = (await tx.readState.findMany({ where: { userId: authenticated.id } })).map(toReadStateRecord);
    return pending.map((message) => publicMessage(message, readStates));
  }) : snapshot.pending.map((message) => publicMessage(message, snapshot.readStates));

  return ok({ messages, polledAt: now });
});
