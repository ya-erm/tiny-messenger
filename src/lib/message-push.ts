import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { read, write, type Db } from "@/lib/db";
import { hasPushActivity } from "@/lib/push-activity";
import { pushConfiguration, sendPushToUser } from "@/lib/push";


async function snapshot(db: Db, userId: string, alertAfter: string | null) {
  // COUNT runs in SQLite, not over a truncated /sync page or loaded history.
  const rows = await db.$queryRaw<Array<{ unread: bigint; alerts: bigint; latestChat: string | null; latestKind: string | null; latestText: string | null; latestName: string | null }>>(Prisma.sql`
    WITH unread AS (
      SELECT m.sentAt, m.fromUserId AS chat, 'peer' AS kind, m.text, m.senderName AS name
      FROM Message m LEFT JOIN ReadState r ON r.userId = ${userId} AND r.chatId = m.fromUserId
      WHERE m.toUserId = ${userId} AND m.sentAt > COALESCE(r.lastReadAt, '')
        AND NOT EXISTS (SELECT 1 FROM MessageDeletion d WHERE d.messageId = m.id AND d.userId = ${userId})
        AND NOT EXISTS (SELECT 1 FROM HiddenConversation h WHERE h.ownerId = ${userId} AND h.peerId = m.fromUserId AND m.sentAt <= h.hiddenAt)
      UNION ALL
      SELECT m.sentAt, m.groupId, 'group', m.text, m.senderName
      FROM GroupMessage m JOIN GroupMember gm ON gm.groupId = m.groupId AND gm.userId = ${userId}
      LEFT JOIN ReadState r ON r.userId = ${userId} AND r.chatId = m.groupId
      WHERE m.fromUserId != ${userId} AND m.sentAt > COALESCE(r.lastReadAt, '')
        AND NOT EXISTS (SELECT 1 FROM GroupMessageDeletion d WHERE d.messageId = m.id AND d.userId = ${userId})
    ) SELECT COUNT(*) AS unread,
      COALESCE(SUM(CASE WHEN ${alertAfter} IS NOT NULL AND sentAt >= ${alertAfter} THEN 1 ELSE 0 END),0) AS alerts,
      (SELECT chat FROM unread ORDER BY sentAt DESC, chat DESC LIMIT 1) AS latestChat,
      (SELECT kind FROM unread ORDER BY sentAt DESC, chat DESC LIMIT 1) AS latestKind,
      (SELECT text FROM unread ORDER BY sentAt DESC, chat DESC LIMIT 1) AS latestText,
      (SELECT name FROM unread ORDER BY sentAt DESC, chat DESC LIMIT 1) AS latestName
    FROM unread
  `);
  return rows[0];
}

export async function messagePushState(userId: string) {
  return write(async (tx) => {
    const state = await tx.pushNotificationState.findUnique({ where: { userId } });
    const count = await snapshot(tx, userId, state?.alertAfter ?? null);
    const unreadCount = Number(count.unread);
    return {
      kind: "message_summary" as const, userId, revision: state?.revision ?? 0, unreadCount,
      title: "Tiny Messenger", tag: `tm-messages-${userId}`,
      body: unreadCount ? `Непрочитанных сообщений: ${unreadCount}\n${count.latestName}: ${count.latestText || "Вложение"}` : "Все сообщения прочитаны",
      url: count.latestKind === "peer" ? `/id/${count.latestChat}` : "/",
      hasAlerts: Number(count.alerts) > 0,
    };
  });
}

let dispatching = false;
export async function dispatchMessagePushes() {
  if (dispatching || !pushConfiguration().configured) return { processed: 0 };
  dispatching = true;
  let processed = 0;
  try {
    const now = new Date().toISOString();
    const jobs = await read((db) => db.pushNotificationState.findMany({ where: { dueAt: { lte: now }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] }, orderBy: { dueAt: "asc" }, take: 20 }));
    for (const job of jobs) {
      const leaseUntil = new Date(Date.now() + 30_000).toISOString();
      const claimed = await write((tx) => tx.pushNotificationState.updateMany({ where: { userId: job.userId, revision: job.revision, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] }, data: { leaseUntil } }));
      if (!claimed.count) continue;
      try {
        const payload = await messagePushState(job.userId);
        // A concurrent read/new message owns the next dispatch, never clear it.
        if (payload.revision !== job.revision) continue;
        if (payload.hasAlerts && hasPushActivity(job.userId) && Date.now() < Date.parse(job.firstPendingAt!) + 30_000) {
          await write((tx) => tx.pushNotificationState.updateMany({ where: { userId: job.userId, revision: job.revision }, data: { dueAt: new Date(Math.min(Date.now() + 3000, Date.parse(job.firstPendingAt!) + 30_000)).toISOString() } }));
          continue;
        }
        // Avoid "all read" pushes when a message was read before any push, and
        // avoid alerting old unread messages after only the new one was read.
        const shouldSend = payload.hasAlerts || job.hasNotification;
        if (shouldSend) {
          // Mark before network I/O: if a read races an in-flight push, its
          // newer job must send a correction even if this revision cannot commit.
          const marked = await write((tx) => tx.pushNotificationState.updateMany({ where: { userId: job.userId, revision: job.revision }, data: { hasNotification: true } }));
          if (!marked.count) continue;
          const result = await sendPushToUser(job.userId, { ...payload, silent: !payload.hasAlerts }, { topic: "tm-message-state" });
          if (result.failed) throw new Error("push_delivery_failed");
        }
        await write((tx) => tx.pushNotificationState.updateMany({ where: { userId: job.userId, revision: job.revision }, data: { dueAt: null, firstPendingAt: null, alertAfter: null, attempts: 0, hasNotification: shouldSend && payload.unreadCount > 0 } }));
        processed++;
      } catch {
        await write((tx) => tx.pushNotificationState.updateMany({ where: { userId: job.userId, revision: job.revision }, data: { dueAt: new Date(Date.now() + Math.min(300_000, 15_000 * 2 ** Math.min(job.attempts, 4))).toISOString(), attempts: { increment: 1 } } }));
        console.error(JSON.stringify({ event: "message-push-dispatch", status: "retry" }));
      } finally {
        await write((tx) => tx.pushNotificationState.updateMany({ where: { userId: job.userId, leaseUntil }, data: { leaseUntil: null } }));
      }
    }
    return { processed };
  } finally { dispatching = false; }
}
