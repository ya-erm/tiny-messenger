import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { acceptMutation } from "@/lib/mutations/accept";
import { parseMutation, mutationMessageId } from "@/lib/mutations/protocol";
import { materializeRows, storeRow, ingestLocalRows } from "./row-store";
import { queueMessagePush } from "@/lib/push-queue";
export async function applyPeerEvents(tx: Prisma.TransactionClient, peerId: string, events: any[], users: any[] = [], selfId = process.env.TM_INSTALLATION_ID || "vps-1") {
  if (!await ingestLocalRows(tx, selfId)) throw Error("Local journal needs preparation");
      // Peer users are only inserted if absent. Current profile/token/contact
      // edits still use VPS APIs, so a stale cloud copy cannot roll them back.
      for (const user of users) {
        if (!/^[0-9a-f-]{36}$/.test(user.id) || !/^[0-9a-f]{64}$/.test(user.tokenHash)) throw Error("Invalid peer user");
        const fields = { id: user.id, name: user.name, nickname: user.nickname || null, avatarUrl: user.avatarUrl || null,
          avatarBackground: user.avatarBackground || null, tokenHash: user.tokenHash, createdAt: user.createdAt, updatedAt: user.updatedAt || user.createdAt };
        await tx.user.upsert({ where: { id: user.id }, create: fields, update: {} });
      }
      for (const event of events) {
        if (event.type === "mutation") {
          const operation = parseMutation(event.operation);
          const actor = await tx.user.findUniqueOrThrow({ where: { id: operation.actorId } });
          await acceptMutation(tx, operation, actor, { peerImport: true, sourceId: peerId });
          const messageId = mutationMessageId(operation);
          const message = await tx.message.findUnique({ where: { id: messageId } });
          if (message) {
            const receipt = await tx.replicationState.findUnique({ where: { key: "receipts:" + message.toUserId + ":" + message.fromUserId } });
            if (receipt) {
              const value = JSON.parse(receipt.body);
              const status = value.read.includes(messageId) ? "read" : value.delivered.includes(messageId) ? "delivered" : undefined;
              if (status) await tx.message.update({ where: { id: messageId }, data: { receiptStatus: status } });
            }
          }
        } else if (event.type === "row") {
          if (event.operation.origin !== peerId) throw Error("Wrong peer row origin");
          await storeRow(tx, event.operation);
        } else if (event.type === "receipt") {
          if (!Array.isArray(event.delivered) || !Array.isArray(event.read) || event.delivered.length + event.read.length > 10000)
            throw Error("Invalid peer receipt");
          if (![...event.delivered, ...event.read].every((id) => typeof id === "string" && /^[0-9a-f-]{36}$/.test(id))) throw Error("Invalid peer receipt IDs");
          const receiptKey = "receipts:" + event.userId + ":" + event.peerId;
          const old = await tx.replicationState.findUnique({ where: { key: receiptKey } });
          const before = old ? JSON.parse(old.body) : { delivered: [], read: [] };
          const readIds = [...new Set<string>([...before.read, ...event.read])].sort();
          const delivered = [...new Set<string>([...before.delivered, ...event.delivered, ...readIds])].sort();
          const body = JSON.stringify({ delivered, read: readIds });
          await tx.replicationState.upsert({ where: { key: receiptKey }, create: { key: receiptKey, body }, update: { body } });
          const where = { toUserId: event.userId, fromUserId: event.peerId };
          await tx.message.updateMany({ where: { ...where, id: { in: delivered }, OR: [{ receiptStatus: null }, { receiptStatus: "sent" }] }, data: { receiptStatus: "delivered" } });
          await tx.message.updateMany({ where: { ...where, id: { in: readIds } }, data: { receiptStatus: "read" } });
          await queueMessagePush(tx, event.userId);
        } else throw Error("Unknown peer event");
      }
  await materializeRows(tx);
}
