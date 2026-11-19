import { compareMutationVersions, mutationMessageId, serializeMutation, type Mutation, type TextMessageEntity } from "./protocol";

export type OperationStatus = "pending" | "applied" | "superseded" | "rejected";
export interface MessageProjection {
  message: TextMessageEntity | null;
  editedAt: string | null;
  deleted: boolean;
  hiddenFor: string[];
  reactions: { userId: string; emoji: string }[];
  statuses: Map<string, OperationStatus>;
}

// Pure, deterministic fold. Storage adapters and clients can use the same rules.
// Creation is the authority for immutable fields and participant permissions.
export function reduceMessageOperations(operations: readonly Mutation[]): MessageProjection {
  const unique = new Map<string, Mutation>();
  for (const operation of operations) {
    const previous = unique.get(operation.operationId);
    if (previous && serializeMutation(previous) !== serializeMutation(operation)) throw new Error("Conflicting operation ID");
    unique.set(operation.operationId, operation);
  }
  const ordered = [...unique.values()].sort(compareMutationVersions);
  const statuses = new Map<string, OperationStatus>(ordered.map((op) => [op.operationId, "pending"]));
  const creates = ordered.filter((op) => op.type === "message.create");
  const creation = creates[0];
  const result: MessageProjection = { message: null, editedAt: null, deleted: false, hiddenFor: [], reactions: [], statuses };
  if (!creation || creation.type !== "message.create") return result;
  const original = creation.message;
  let message = original;
  let lastEdit: Mutation | undefined;
  const reactions = new Map<string, Extract<Mutation, { type: "reaction.set" }>>();
  const hidden = new Set<string>();
  statuses.set(creation.operationId, "applied");
  for (const op of ordered) {
    if (op.operationId === creation.operationId) continue;
    const participant = op.actorId === original.fromUserId || op.actorId === original.toUserId;
    if (mutationMessageId(op) !== original.id || !participant || op.type === "message.create") {
      statuses.set(op.operationId, "rejected");
      continue;
    }
    if (op.type === "message.edit") {
      const next = op.message;
      if (op.actorId !== original.fromUserId || next.fromUserId !== original.fromUserId
        || next.toUserId !== original.toUserId || next.sentAt !== original.sentAt || next.kind !== original.kind) {
        statuses.set(op.operationId, "rejected");
        continue;
      }
      if (lastEdit) statuses.set(lastEdit.operationId, "superseded");
      message = next;
      lastEdit = op;
    } else if (op.type === "message.delete") {
      if (op.deletion.scope === "everyone") result.deleted = true;
      else hidden.add(op.actorId);
    } else if (op.type === "reaction.set") {
      if (op.reaction.userId !== op.actorId) { statuses.set(op.operationId, "rejected"); continue; }
      const previous = reactions.get(op.actorId);
      if (previous) statuses.set(previous.operationId, "superseded");
      reactions.set(op.actorId, op);
    }
    statuses.set(op.operationId, "applied");
  }
  result.message = message;
  result.editedAt = lastEdit?.occurredAt ?? null;
  result.hiddenFor = [...hidden].sort();
  result.reactions = [...reactions.values()]
    .filter((op) => op.reaction.emoji !== null)
    .map((op) => ({ userId: op.actorId, emoji: op.reaction.emoji! }))
    .sort((a, b) => a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0);
  return result;
}
