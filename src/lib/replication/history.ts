import "server-only";
import { createHash } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { acceptMutation } from "@/lib/mutations/accept";
import { parseMutation, serializeMutation, mutationMessageId, type Mutation, type TextMessageEntity } from "@/lib/mutations/protocol";

export function historyId(value: string) {
  const bytes = createHash("sha256").update("tiny-messenger-bootstrap:" + value).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString("hex"); return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}
type Historical = TextMessageEntity & { editedAt?: string; attachments?: unknown[]; replyToId?: string; reactions: Array<{ userId: string; emoji: string }> };
export type Bootstrap = { formatVersion: number; createdAt: string; messages: Historical[];
  deletions: Array<{ messageId: string; userId: string }>; operations: Mutation[] };
export async function prepareHistory(tx: Prisma.TransactionClient, snapshot: Bootstrap, now: string) {
  if (snapshot.formatVersion !== 1 || !Array.isArray(snapshot.messages) || !Array.isArray(snapshot.operations)) throw Error("Invalid replication bootstrap");
  const current = await tx.message.findMany({ include: { attachments: true, reactions: true, deletions: true } });
  const existing = new Map(current.map((row) => [row.id, row]));
  const old = new Map(snapshot.messages.map((row) => [row.id, row]));
  const hasJournal = new Set((await tx.mutationOperation.findMany({ where: { type: "message.create" }, select: { entityId: true } })).map((entry) => entry.entityId));
  const base = (actorId: string, label: string, occurredAt: string) => ({ protocolVersion: 1 as const, actorId,
    operationId: historyId(label), deviceId: "00000000-0000-4000-8000-000000000000", occurredAt });
  const entity = (row: Historical): TextMessageEntity => Object.fromEntries(["id", "fromUserId", "toUserId", "kind", "text", "sentAt"].map((key) => [key, row[key as keyof Historical]])) as unknown as TextMessageEntity;
  let adopted = 0;
  for (const id of new Set([...old.keys(), ...existing.keys()])) {
    if (hasJournal.has(id)) continue;
    const row = existing.get(id), original = old.get(id);
    const source = original || row;
    if (!source || source.kind !== "text" || source.attachments?.length || source.replyToId) continue;
    const message = entity(source as Historical);
    const operations: Mutation[] = [{ ...base(source.fromUserId, "create:" + id, source.sentAt), type: "message.create", message }];
    for (const reaction of source.reactions) operations.push({ ...base(reaction.userId, "reaction:" + id + ":" + reaction.userId, original ? snapshot.createdAt : now),
      type: "reaction.set", reaction: { messageId: id, userId: reaction.userId, emoji: reaction.emoji } });
    for (const mark of snapshot.deletions.filter((item) => original && item.messageId === id)) operations.push({
      ...base(mark.userId, "delete-me:" + id + ":" + mark.userId, snapshot.createdAt), type: "message.delete", deletion: { messageId: id, scope: "me" } });
    // The seed script skipped this message too if it is outside protocol v1.
    // Reject explicitly rather than silently recording an unparseable journal.
    for (const operation of operations) parseMutation(operation);
    for (const operation of operations) await tx.mutationOperation.create({ data: {
      operationId: operation.operationId, protocolVersion: 1, actorId: operation.actorId, deviceId: operation.deviceId,
      occurredAt: operation.occurredAt, type: operation.type, entityId: mutationMessageId(operation), body: serializeMutation(operation), receivedAt: now, status: "applied",
    } });
    adopted++;
    const repair = async (operation: Mutation) => {
      const actor = await tx.user.findUniqueOrThrow({ where: { id: operation.actorId } });
      await acceptMutation(tx, operation, actor);
    };
    if (!row) {
      await repair({ ...base(source.fromUserId, "reconcile-delete:" + id, now), type: "message.delete", deletion: { messageId: id, scope: "everyone" } });
      continue;
    }
    if (row.text !== source.text || row.editedAt) await repair({ ...base(row.fromUserId, "reconcile-edit:" + id, row.editedAt || now), type: "message.edit", message: entity(row as Historical) });
    for (const userId of new Set([...source.reactions, ...row.reactions].map((item) => item.userId))) {
      const before = source.reactions.find((item) => item.userId === userId)?.emoji || null;
      const after = row.reactions.find((item) => item.userId === userId)?.emoji || null;
      if (before !== after) await repair({ ...base(userId, "reconcile-reaction:" + id + ":" + userId, now), type: "reaction.set", reaction: { messageId: id, userId, emoji: after } });
    }
    for (const mark of row.deletions) {
      if (!operations.some((op) => op.type === "message.delete" && op.actorId === mark.userId)) await repair({
        ...base(mark.userId, "reconcile-delete-me:" + id + ":" + mark.userId, now), type: "message.delete", deletion: { messageId: id, scope: "me" } });
    }
  }
  return { adopted };
}

// Reconcile deletions in the original read-only cloud bootstrap as well.
// Current rich rows are enrolled by the additive migration's seed statements.
export async function prepareRowHistory(tx: Prisma.TransactionClient, snapshot: Bootstrap & { userStates?: Array<{ groups?: Array<Record<string, unknown>>; groupMessages?: Array<Record<string, unknown>> }> }) {
  const { ROW_TABLES, rowKey } = await import("./rows");
  const key = "rows:history:v1";
  if (await tx.replicationState.findUnique({ where: { key } })) return;
  let tombstones = 0;
  const append = async (table: "Message" | "GroupMessage" | "Group", value: Record<string, unknown>) => {
    const full = Object.fromEntries(ROW_TABLES[table].fields.map((field) => [field, value[field] ?? null]));
    await tx.replicaChange.create({ data: { operationId: historyId("rich-deleted:" + table + ":" + value.id), tableName: table,
      rowKey: rowKey(table, full as never), payload: JSON.stringify(full), deleted: true, occurredAt: new Date().toISOString() } });
    tombstones++;
  };
  for (const item of snapshot.messages) {
    if (item.kind === "text" && !item.replyToId && !item.attachments?.length) continue;
    if (!await tx.message.findUnique({ where: { id: item.id }, select: { id: true } })) await append("Message", item as unknown as Record<string, unknown>);
  }
  const groups = new Map<string, Record<string, unknown>>(), messages = new Map<string, Record<string, unknown>>();
  for (const state of snapshot.userStates || []) {
    for (const group of state.groups || []) groups.set(String(group.id), group);
    for (const message of state.groupMessages || []) messages.set(String(message.id), message);
  }
  for (const [id, group] of groups) if (!await tx.group.findUnique({ where: { id }, select: { id: true } })) await append("Group", group);
  for (const [id, message] of messages) if (!await tx.groupMessage.findUnique({ where: { id }, select: { id: true } })) await append("GroupMessage", message);
  await tx.replicationState.create({ data: { key, body: JSON.stringify({ tombstones }) } });
}
