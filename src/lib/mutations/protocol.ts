// Shared by browsers, SQLite and future cloud adapters. No server dependencies.
import { isReactionEmoji } from "../reactions";
export const MUTATION_PROTOCOL_VERSION = 1 as const;

export interface MutationBase {
  protocolVersion: typeof MUTATION_PROTOCOL_VERSION;
  operationId: string;
  actorId: string;
  deviceId: string;
  occurredAt: string;
}

export interface TextMessageEntity {
  id: string;
  fromUserId: string;
  toUserId: string;
  kind: "text";
  text: string;
  sentAt: string;
}

// Each independently editable entity has its own operation and version.
export type Mutation = MutationBase & (
  | { type: "message.create" | "message.edit"; message: TextMessageEntity }
  | { type: "message.delete"; deletion: { messageId: string; scope: "me" | "everyone" } }
  | { type: "reaction.set"; reaction: { messageId: string; userId: string; emoji: string | null } }
);

export class MutationValidationError extends Error {}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MutationValidationError("Ожидался объект мутации");
  }
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, expected: string[]) {
  if (Object.keys(value).length !== expected.length || expected.some((key) => !Object.hasOwn(value, key))) {
    throw new MutationValidationError("Некорректные поля мутации");
  }
}
function id(value: unknown): string {
  // Require canonical lowercase IDs so every store has the same identity rules.
  if (typeof value !== "string" || !uuid.test(value)) throw new MutationValidationError("Некорректный UUID мутации");
  return value;
}
export function utcTimestamp(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new MutationValidationError("Ожидалось UTC-время с миллисекундами");
  }
  return value;
}

export function parseMutation(value: unknown): Mutation {
  const operation = record(value);
  if (operation.protocolVersion !== MUTATION_PROTOCOL_VERSION) throw new MutationValidationError("Неподдерживаемая версия протокола мутаций");
  const base: MutationBase = { protocolVersion: MUTATION_PROTOCOL_VERSION,
    operationId: id(operation.operationId), actorId: id(operation.actorId),
    deviceId: id(operation.deviceId), occurredAt: utcTimestamp(operation.occurredAt) };
  const common = ["protocolVersion", "operationId", "actorId", "deviceId", "occurredAt", "type"];
  if (operation.type === "message.delete") {
    keys(operation, [...common, "deletion"]);
    const deletion = record(operation.deletion);
    keys(deletion, ["messageId", "scope"]);
    if (deletion.scope !== "me" && deletion.scope !== "everyone") throw new MutationValidationError("Некорректная область удаления");
    return { ...base, type: operation.type, deletion: { messageId: id(deletion.messageId), scope: deletion.scope } };
  }
  if (operation.type === "reaction.set") {
    keys(operation, [...common, "reaction"]);
    const reaction = record(operation.reaction);
    keys(reaction, ["messageId", "userId", "emoji"]);
    // Exact emoji validation is shared with the existing UI and HTTP API.
    if (reaction.emoji !== null && !isReactionEmoji(reaction.emoji)) throw new MutationValidationError("Некорректная реакция");
    if (reaction.userId !== base.actorId) throw new MutationValidationError("Реакция принадлежит другому пользователю");
    return { ...base, type: operation.type, reaction: { messageId: id(reaction.messageId), userId: id(reaction.userId), emoji: reaction.emoji as string | null } };
  }
  if (operation.type !== "message.create" && operation.type !== "message.edit") throw new MutationValidationError("Неподдерживаемый тип мутации");
  keys(operation, [...common, "message"]);
  const message = record(operation.message);
  keys(message, ["id", "fromUserId", "toUserId", "kind", "text", "sentAt"]);
  if (message.kind !== "text" || typeof message.text !== "string" || !message.text.trim()
    || new TextEncoder().encode(message.text).byteLength > 16_384) {
    throw new MutationValidationError("Некорректное текстовое сообщение");
  }
  const result: Mutation = {
    ...base,
    type: operation.type,
    message: {
      id: id(message.id), fromUserId: id(message.fromUserId), toUserId: id(message.toUserId),
      kind: "text", text: message.text, sentAt: utcTimestamp(message.sentAt),
    },
  };
  if (result.actorId !== result.message.fromUserId || result.actorId === result.message.toUserId
    || (result.type === "message.create" && result.occurredAt !== result.message.sentAt)) {
    throw new MutationValidationError("Автор, получатель или время сообщения не согласованы");
  }
  return result;
}

export function mutationMessageId(operation: Mutation): string {
  if (operation.type === "reaction.set") return operation.reaction.messageId;
  if (operation.type === "message.delete") return operation.deletion.messageId;
  return operation.message.id;
}

// parseMutation reconstructs fields in a fixed order, including nested entities.
// This serialization is transport independent and never includes server receipts.
export function serializeMutation(value: unknown): string {
  return JSON.stringify(parseMutation(value));
}

export interface MutationVersion { occurredAt: string; operationId: string }
export function compareMutationVersions(a: MutationVersion, b: MutationVersion): number {
  const left = utcTimestamp(a.occurredAt);
  const right = utcTimestamp(b.occurredAt);
  if (left !== right) return left < right ? -1 : 1;
  const leftId = id(a.operationId);
  const rightId = id(b.operationId);
  return leftId === rightId ? 0 : leftId < rightId ? -1 : 1;
}
