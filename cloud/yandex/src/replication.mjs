import { timingSafeEqual } from "node:crypto";
import { REPLICATION_VERSION, REPLICATION_BATCH, REPLICATION_FEED, replicationCursor } from "../shared/replication.mjs";
import { HttpError } from "./service.mjs";

export function authorizePeer(headers, configuration) {
  const expected = Buffer.from(configuration.TM_REPLICATION_SECRET || "");
  const supplied = Buffer.from(headers["x-tm-replication-key"] || "");
  if (expected.length < 32 || supplied.length !== expected.length || !timingSafeEqual(expected, supplied))
    throw new HttpError(401, "peer_unauthorized", "Недоступно");
}
export async function appendReplication(tx, key, event) {
  if (await tx.get("replication-index", key)) return;
  const sequence = await tx.nextSequence();
  await tx.addFeed(REPLICATION_FEED, sequence, event);
  await tx.put("replication-index", key, { sequence });
}
export function createReplication(database, service, configuration) {
  return async (body) => {
    let after;
    try { after = replicationCursor(body.after); } catch { throw new HttpError(422, "invalid_peer_cursor", "Некорректный курсор"); }
    if (body.protocolVersion !== REPLICATION_VERSION || body.sourceId !== (configuration.TM_REPLICATION_PEER || "vps-1")
      || body.targetId !== service.installationId || !Array.isArray(body.operations) || body.operations.length > REPLICATION_BATCH || body.rows !== undefined && (!Array.isArray(body.rows) || body.rows.length + body.operations.length > REPLICATION_BATCH))
      throw new HttpError(422, "invalid_peer_envelope", "Некорректный пакет репликации");
    if (body.rows?.length && body.rowProtocolVersion !== 1) throw new HttpError(409, "row_protocol_mismatch", "Нужна совместимая версия обмена");
    // Import every item durably before acknowledging the batch. If the request
    // fails half way through, replay is safe and neither cursor advances.
    if (body.directory) await service.importDirectory(body.directory);
    for (const operation of body.operations) await service.importMutation(operation, body.sourceId);
    for (const operation of body.rows || []) {
      if (operation.origin !== body.sourceId) throw new HttpError(422, "row_origin_mismatch", "Неверный источник изменения");
    }
    if (body.rows?.length) await service.rows.importMany(body.rows);
    const result = await database.transaction(async (tx) => {
      if (BigInt(after) > BigInt(await tx.sequence())) throw new HttpError(409, "peer_cursor_ahead", "Курсор опережает журнал");
      const events = await tx.feed(REPLICATION_FEED, after, REPLICATION_BATCH + 1);
      let hasMore = events.length > REPLICATION_BATCH;
      if (hasMore) events.pop();
      while (events.length > 1 && Buffer.byteLength(JSON.stringify(events)) > 420 * 1024) { events.pop(); hasMore = true; }
      const userIds = new Set();
      for (const event of events) if (event.type === "mutation") {
        userIds.add(event.operation.actorId);
        if (event.operation.type === "message.create") {
          userIds.add(event.operation.message.fromUserId); userIds.add(event.operation.message.toUserId);
        }
      }
      for (const event of events) if (event.type === "receipt") { userIds.add(event.userId); userIds.add(event.peerId); }
      for (const event of events) if (event.type === "row") {
        const patch = event.operation.patch;
        for (const key of ["fromUserId", "toUserId", "ownerId", "uploaderId", "userId", "peerId"]) if (patch[key]) userIds.add(patch[key]);
      }
      const users = [];
      for (const id of userIds) { const user = await tx.get("users", id); if (user) users.push(user); }
      return { users, rowProtocolVersion: 1, protocolVersion: REPLICATION_VERSION, sourceId: service.installationId, targetId: body.sourceId,
        events, cursor: events.at(-1)?.sequence || after, hasMore };
    }, { readOnly: true });
    return result;
  };
}
