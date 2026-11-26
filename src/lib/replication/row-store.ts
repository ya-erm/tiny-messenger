import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { ROW_TABLES, effectiveRowData, mergeRow, parseRowOperation, rowIdentity, rowDeleted, type RowOperation, type RowState, type RowTable, type RowData } from "./rows";
import { queueMessagePush } from "@/lib/push-queue";

export function operationFromChange(change: { seq: number; operationId: string; tableName: string; rowKey: string; payload: string; deleted: boolean; occurredAt: string }, origin: string): RowOperation {
  return parseRowOperation({ version: 1, id: change.operationId, origin, sequence: String(change.seq), at: change.occurredAt,
    table: change.tableName, key: change.rowKey, patch: JSON.parse(change.payload), deleted: change.deleted });
}
export async function storeRow(tx: Prisma.TransactionClient, input: RowOperation) {
  const operation = parseRowOperation(input), id = rowIdentity(operation.table, operation.key);
  const previous = await tx.replicaRow.findUnique({ where: { id } });
  const state = mergeRow(previous ? JSON.parse(previous.body) : undefined, operation);
  const body = JSON.stringify(state);
  if (previous?.body === body) return state;
  await tx.replicaRow.upsert({ where: { id }, create: { id, tableName: state.table, body, pending: true }, update: { body, pending: true } });
  return state;
}
export async function ingestLocalRows(tx: Prisma.TransactionClient, origin: string) {
  const key = "rows:ingested";
  const before = await tx.replicationState.findUnique({ where: { key } });
  const after = before ? JSON.parse(before.body).sequence : 0;
  const changes = await tx.replicaChange.findMany({ where: { seq: { gt: after } }, orderBy: { seq: "asc" }, take: 1000 });
  for (const change of changes) {
    await storeRow(tx, operationFromChange(change, origin));
    // Materialization also reconciles any peer fields received before this
    // local transaction. Unchanged SQL rows are detected below.
  }
  if (changes.length) {
    const body = JSON.stringify({ sequence: changes.at(-1)!.seq });
    await tx.replicationState.upsert({ where: { key }, create: { key, body }, update: { body } });
  }
  return changes.length < 1000;
}
const exists = async (tx: Prisma.TransactionClient, table: string, id: string) => (await tx.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id FROM "${table}" WHERE id=? LIMIT 1`, id)).length > 0;
async function dependencies(tx: Prisma.TransactionClient, table: RowTable, data: RowData) {
  const user = async (key: string) => typeof data[key] === "string" && exists(tx, "User", String(data[key]));
  if (table === "Group") return user("ownerId");
  if (table === "GroupMember") return await user("userId") && exists(tx, "Group", String(data.groupId));
  if (table === "Message") return await user("fromUserId") && await user("toUserId");
  if (table === "GroupMessage") return await user("fromUserId") && exists(tx, "Group", String(data.groupId));
  if (table === "HiddenConversation") return await user("ownerId") && await user("peerId");
  if (table === "ReadState") return user("userId");
  if (table === "Attachment") return await user("uploaderId")
    && (!data.messageId || await exists(tx, "Message", String(data.messageId)))
    && (!data.groupMessageId || await exists(tx, "GroupMessage", String(data.groupMessageId)));
  return (!data.userId || await user("userId")) && exists(tx, table.startsWith("GroupMessage") ? "GroupMessage" : "Message", String(data.messageId));
}
export async function materializeRows(tx: Prisma.TransactionClient) {
  if (!await tx.replicaRow.findFirst({ where: { pending: true }, select: { id: true } })) return;
  const priority: RowTable[] = ["Group", "GroupMember", "Message", "GroupMessage", "ChoiceOption", "MessageReaction", "MessageDeletion", "GroupMessageReaction", "GroupMessageDeletion", "ReadState", "HiddenConversation", "Attachment"];
  const pending = [];
  for (const tableName of priority) pending.push(...await tx.replicaRow.findMany({ where: { pending: true, tableName }, take: 100 }));
  const memberGroups = new Set<string>();
  await tx.replicaControl.update({ where: { id: 1 }, data: { suppress: 1 } });
  try {
    for (const entry of pending) {
      const state: RowState = JSON.parse(entry.body), definition = ROW_TABLES[state.table], data = effectiveRowData(state);
      if (!Object.hasOwn(ROW_TABLES, state.table)) throw Error("Unknown replica table");
      if (state.table === "GroupMember") memberGroups.add(String(data.groupId));
      const keys = definition.keys as readonly string[], keyValues = keys.map((key) => data[key]);
      const where = keys.map((key) => `"${key}"=?`).join(" AND ");
      const nativeId = ["Message", "MessageReaction", "MessageDeletion"].includes(state.table) ? String(data.id || data.messageId) : undefined;
      const native = nativeId && await tx.mutationOperation.findFirst({ where: { entityId: nativeId, type: "message.create" }, select: { seq: true } });
      if (native) { await tx.replicaRow.update({ where: { id: entry.id }, data: { pending: false } }); continue; }
      const before = await tx.$queryRawUnsafe<Array<RowData>>(`SELECT * FROM "${state.table}" WHERE ${where} LIMIT 1`, ...keyValues);
      const parentTable = state.table === "GroupMember" || state.table === "GroupMessage" ? "Group"
        : ["ChoiceOption", "MessageReaction", "MessageDeletion"].includes(state.table) ? "Message"
        : ["GroupMessageReaction", "GroupMessageDeletion"].includes(state.table) ? "GroupMessage" : undefined;
      const parentId = parentTable === "Group" ? data.groupId : data.messageId;
      if (parentTable && parentId) {
        const parent = await tx.replicaRow.findUnique({ where: { id: rowIdentity(parentTable, JSON.stringify([parentId])) } });
        if (parent && rowDeleted(JSON.parse(parent.body))) {
          await tx.replicaRow.update({ where: { id: entry.id }, data: { pending: false } }); continue;
        }
      }
      if (rowDeleted(state)) {
        await tx.$executeRawUnsafe(`DELETE FROM "${state.table}" WHERE ${where}`, ...keyValues);
      } else {
        const fields = (definition.fields as readonly string[]).filter((key) => Object.hasOwn(data, key));
        // A patch can arrive before its initial row or referenced users/chat.
        if (!definition.fields.every((key) => Object.hasOwn(data, key)) || !await dependencies(tx, state.table, data)) continue;
        if (before[0] && fields.every((key) => before[0][key] === data[key] || before[0][key] != null && data[key] != null && String(before[0][key]) === String(data[key]))) {
          await tx.replicaRow.update({ where: { id: entry.id }, data: { pending: false } }); continue;
        }
        const updates = fields.filter((key) => !keys.includes(key));
        await tx.$executeRawUnsafe(`INSERT INTO "${state.table}" (${fields.map((key) => `"${key}"`).join(",")}) VALUES (${fields.map(() => "?").join(",")}) ON CONFLICT (${keys.map((key) => `"${key}"`).join(",")}) ${updates.length ? "DO UPDATE SET " + updates.map((key) => `"${key}"=excluded."${key}"`).join(",") : "DO NOTHING"}`,
          ...fields.map((key) => data[key]));
        if (!before.length && (state.table === "Message" || state.table === "GroupMessage")) {
          // Messages arriving from a peer were not acknowledged by an older
          // local watermark. Direct imported receipts remain explicit.
          if (state.table === "Message") await tx.message.updateMany({ where: { id: String(data.id), receiptStatus: null }, data: { receiptStatus: "sent" } });
          if (state.table === "Message") await queueMessagePush(tx, String(data.toUserId), String(data.sentAt));
          else for (const member of await tx.groupMember.findMany({ where: { groupId: String(data.groupId), userId: { not: String(data.fromUserId) } } }))
            await queueMessagePush(tx, member.userId, String(data.sentAt));
        }
      }
      await tx.replicaRow.update({ where: { id: entry.id }, data: { pending: false } });
    }
    for (const groupId of memberGroups) {
      const entries = await tx.replicaRow.findMany({ where: { tableName: "GroupMember" } });
      const members = entries.map(entry=>JSON.parse(entry.body) as RowState).filter(state=>state.data.groupId===groupId&&!rowDeleted(state)).sort((a,b)=>a.aliveVersion.localeCompare(b.aliveVersion)).map(state=>String(state.data.userId));
      const current = (await tx.groupMember.findMany({ where: { groupId }, orderBy: { seq: "asc" } })).map(member=>member.userId);
      if (members.length===current.length && [...members].sort().join() === [...current].sort().join() && members.join()!==current.join()) {
        await tx.groupMember.deleteMany({ where: { groupId } });
        for (const userId of members) await tx.groupMember.create({ data: { groupId, userId } });
      }
    }
  } finally { await tx.replicaControl.update({ where: { id: 1 }, data: { suppress: 0 } }); }
}
