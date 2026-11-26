import "server-only";
import { Prisma } from "@/generated/prisma/client";
import { rowDeleted, type RowState } from "./rows";
import type { Db } from "@/lib/db";
// Tombstones are authoritative even if a browser has only cached the other
// contour. Absence from a truncated message page is not enough to infer this.
export async function deletionIdsForUser(db: Db, userId: string) {
  const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT DISTINCT d.entityId AS id FROM MutationOperation d
    JOIN MutationOperation c ON c.entityId = d.entityId AND c.type = 'message.create'
    WHERE d.type = 'message.delete' AND d.status IN ('applied', 'superseded') AND c.status != 'rejected'
      AND (json_extract(c.body, '$.message.fromUserId') = ${userId} OR json_extract(c.body, '$.message.toUserId') = ${userId})
      AND (json_extract(d.body, '$.deletion.scope') = 'everyone' OR d.actorId = ${userId})
  `);
  const hidden = new Set(rows.map((row) => row.id));
  const members = new Set((await db.groupMember.findMany({ where: { userId }, select: { groupId: true } })).map((member) => member.groupId));
  const entries = await db.replicaRow.findMany({ where: { tableName: { in: ["Message", "GroupMessage", "MessageDeletion", "GroupMessageDeletion"] } } });
  const states = entries.map((entry) => JSON.parse(entry.body) as RowState);
  const messages = new Map(states.filter((state) => state.table === "Message" || state.table === "GroupMessage").map((state) => [String(state.data.id), state]));
  for (const state of states) {
    if ((state.table === "Message" || state.table === "GroupMessage") && rowDeleted(state)) {
      if (state.table === "Message" ? [state.data.fromUserId, state.data.toUserId].includes(userId) : members.has(String(state.data.groupId))) hidden.add(String(state.data.id));
    } else if (state.table.endsWith("Deletion") && state.data.userId === userId && !rowDeleted(state)) {
      const original = messages.get(String(state.data.messageId));
      if (original && (original.table === "Message" ? [original.data.fromUserId, original.data.toUserId].includes(userId) : members.has(String(original.data.groupId)))) hidden.add(String(state.data.messageId));
    }
  }
  return [...hidden];
}
