// A separate, versioned replication format for the existing relational APIs.
// Field versions keep a reaction, poll answer or membership independent of
// message text. Native text operations continue using their original reducer.
export const ROW_TABLES = {
  Group: { keys: ["id"], fields: ["id", "name", "avatarUrl", "avatarBackground", "ownerId", "createdAt", "updatedAt"] },
  GroupMember: { keys: ["groupId", "userId"], fields: ["groupId", "userId"] },
  Message: { keys: ["id"], fields: ["id", "fromUserId", "toUserId", "senderName", "text", "kind", "sentAt", "editedAt", "answerId", "answerLabel", "answeredAt", "clientRequestId", "requestHash", "replyToId"] },
  GroupMessage: { keys: ["id"], fields: ["id", "groupId", "fromUserId", "senderName", "text", "sentAt", "editedAt", "clientRequestId", "requestHash", "replyToId"] },
  ChoiceOption: { keys: ["messageId", "optionId"], fields: ["messageId", "optionId", "label", "position"] },
  MessageReaction: { keys: ["messageId", "userId"], fields: ["messageId", "userId", "emoji"] },
  MessageDeletion: { keys: ["messageId", "userId"], fields: ["messageId", "userId"] },
  GroupMessageReaction: { keys: ["messageId", "userId"], fields: ["messageId", "userId", "emoji"] },
  GroupMessageDeletion: { keys: ["messageId", "userId"], fields: ["messageId", "userId"] },
  ReadState: { keys: ["userId", "chatId"], fields: ["userId", "chatId", "lastDeliveredAt", "lastReadAt"] },
  HiddenConversation: { keys: ["ownerId", "peerId"], fields: ["ownerId", "peerId", "hiddenAt"] },
  Attachment: { keys: ["id"], fields: ["id", "uploaderId", "clientRequestId", "chatKind", "chatId", "stagingKey", "objectKey", "originalName", "contentType", "requestedSize", "confirmedSize", "thumbnailSize", "thumbnailKey", "reservedBytes", "etag", "sourceEtag", "status", "createdAt", "expiresAt", "abandonAt", "leaseUntil", "leaseToken", "stagingDeletedAt", "deleteAfter", "messageId", "groupMessageId"] },
} as const;
export type RowTable = keyof typeof ROW_TABLES;
export type RowData = Record<string, string | number | null>;
export interface RowOperation { version: 1; id: string; origin: string; sequence: string; at: string; table: RowTable; key: string; patch: RowData; deleted: boolean }
export interface RowState { table: RowTable; key: string; data: RowData; versions: Record<string, string>; aliveVersion: string; deletedVersion?: string; createdVersion: string }
export function rowKey(table: RowTable, data: RowData) { return JSON.stringify(ROW_TABLES[table].keys.map((key) => data[key])); }
export function rowIdentity(table: RowTable, key: string) { return table + ":" + key; }
export function rowVersion(operation: RowOperation) { return operation.at + "|" + operation.origin + "|" + operation.sequence.padStart(20, "0") + "|" + operation.id; }
export function parseRowOperation(input: unknown): RowOperation {
  const value = input as RowOperation;
  if (!value || value.version !== 1 || !Object.hasOwn(ROW_TABLES, value.table) || !/^[0-9a-f-]{32,36}$/.test(value.id)
    || !/^[a-z0-9-]{1,64}$/.test(value.origin) || !/^(0|[1-9][0-9]{0,19})$/.test(value.sequence)
    || typeof value.at !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.at)
    || !Number.isFinite(Date.parse(value.at)) || typeof value.deleted !== "boolean" || !value.patch || Array.isArray(value.patch)) throw Error("Invalid row operation");
  const fields = ROW_TABLES[value.table].fields as readonly string[];
  if (Object.entries(value.patch).some(([key, item]) => !fields.includes(key) || !(item === null || typeof item === "string" || typeof item === "number" && Number.isSafeInteger(item)))
    || typeof value.key !== "string" || rowKey(value.table, value.patch) !== value.key
    || BufferByteLength(JSON.stringify(value)) > 48 * 1024) throw Error("Invalid row fields");
  const keys = JSON.parse(value.key);
  if (keys.some((key: unknown) => typeof key !== "string" || key.length > 128)) throw Error("Invalid row key");
  return value;
}
function BufferByteLength(value: string) { return new TextEncoder().encode(value).byteLength; }
export function rowDeleted(state: RowState) {
  if (!state.deletedVersion) return false;
  return ["Message", "GroupMessage", "Group"].includes(state.table) || state.deletedVersion >= state.aliveVersion;
}
export function mergeRow(previous: RowState | undefined, operation: RowOperation): RowState {
  const version = rowVersion(operation);
  const state: RowState = previous ? structuredClone(previous) : { table: operation.table, key: operation.key, data: {}, versions: {}, aliveVersion: "", createdVersion: version };
  if (operation.table !== state.table || operation.key !== state.key) throw Error("Mismatched row identity");
  if (operation.deleted) {
    if (!state.deletedVersion || version > state.deletedVersion) state.deletedVersion = version;
    // Preserve identity/dependencies even when a deletion arrives first.
    for (const [key, value] of Object.entries(operation.patch)) if (!(key in state.data)) state.data[key] = value;
    return state;
  }
  if (version > state.aliveVersion) state.aliveVersion = version;
  if (version < state.createdVersion) state.createdVersion = version;
  const patch = { ...operation.patch };
  // Both isolated servers may accept a choice. The earliest acknowledged
  // answer wins deterministically; text updates cannot clear or replace it.
  if (state.table === "Message" && state.data.answerId) {
    const incoming = patch.answerId && typeof patch.answeredAt === "string" ? patch.answeredAt + "|" + version : undefined;
    const old = String(state.data.answeredAt) + "|" + (state.versions.answerId || "");
    if (!incoming || incoming >= old) { delete patch.answerId; delete patch.answerLabel; delete patch.answeredAt; }
    else for (const key of ["answerId", "answerLabel", "answeredAt"]) { state.data[key] = patch[key]; state.versions[key] = version; delete patch[key]; }
  }
  for (const [key, value] of Object.entries(patch)) {
    if (state.table === "ReadState" && ["lastReadAt", "lastDeliveredAt"].includes(key)) {
      if (!Object.hasOwn(state.data, key) || typeof value === "string" && (state.data[key] === null || value > String(state.data[key]))) state.data[key] = value;
      if (!state.versions[key] || version > state.versions[key]) state.versions[key] = version;
      continue;
    }
    if (!state.versions[key] || version > state.versions[key]) { state.data[key] = value; state.versions[key] = version; }
  }
  return state;
}
export function effectiveRowData(state: RowState): RowData {
  // Derive lifecycle protection without altering the field-versioned state:
  // mutating the winning value itself would break out-of-order convergence.
  if (state.table === "Attachment") return {thumbnailKey:null,thumbnailSize:null,...state.data,...(state.data.messageId||state.data.groupMessageId?{status:"attached"}:{})};
  return state.data;
}
export function rowBucket(table: RowTable) { return "rows:" + table; }
