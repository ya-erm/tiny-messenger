import { Driver } from "@ydbjs/core";
import { query } from "@ydbjs/query";
import { MetadataCredentialsProvider } from "@ydbjs/auth/metadata";
import { CredentialsProvider } from "@ydbjs/auth";
import { Uint64 } from "@ydbjs/value/primitive";

export async function connectYdb(connectionString, credentialsProvider = new MetadataCredentialsProvider()) {
  // SDK 6.x also requires its gRPC middleware on custom token providers.
  if (typeof credentialsProvider.middleware !== "function") {
    const source = credentialsProvider;
    credentialsProvider = new class extends CredentialsProvider {
      getToken(force, signal) { return source.getToken(force, signal); }
    }();
  }
  const driver = new Driver(connectionString, { credentialsProvider,
    "ydb.sdk.application": "tiny-messenger-prototype", "ydb.sdk.ready_timeout_ms": 8000 });
  try { await driver.ready(AbortSignal.timeout(10_000)); }
  catch (error) { driver.close(); throw error; }
  const sql = query(driver, { poolOptions: { maxSize: 2 } });
  return {
    async createSchema() {
      await sql`CREATE TABLE IF NOT EXISTS tm_kv (bucket Utf8 NOT NULL, key Utf8 NOT NULL, body Utf8 NOT NULL, PRIMARY KEY (bucket, key))`;
      await sql`CREATE TABLE IF NOT EXISTS tm_views (user_id Utf8 NOT NULL, sent_at Utf8 NOT NULL, message_id Utf8 NOT NULL, body Utf8 NOT NULL, PRIMARY KEY (user_id, sent_at, message_id))`;
      await sql`CREATE TABLE IF NOT EXISTS tm_feed (user_id Utf8 NOT NULL, seq Uint64 NOT NULL, body Utf8 NOT NULL, PRIMARY KEY (user_id, seq))`;
    },
    async transaction(callback, { readOnly = false } = {}) {
      const callbackErrors = new Set();
      try { return await sql.begin({ isolation: readOnly ? "snapshotReadOnly" : "serializableReadWrite", idempotent: true }, async (tx) => {
        const store = {
          async get(bucket, key) {
            const [rows] = await tx`SELECT body FROM tm_kv WHERE bucket = ${bucket} AND key = ${key}`;
            return rows[0] ? JSON.parse(rows[0].body) : undefined;
          },
          async put(bucket, key, value) {
            const body = JSON.stringify(value);
            await tx`UPSERT INTO tm_kv (bucket, key, body) VALUES (${bucket}, ${key}, ${body})`;
          },
          async delete(bucket,key){await tx`DELETE FROM tm_kv WHERE bucket = ${bucket} AND key = ${key}`;},
          async adminRows(){
            const [rows]=await tx`SELECT bucket, key,
              COALESCE(JSON_VALUE(CAST(body AS Json),'$.data.id'),JSON_VALUE(CAST(body AS Json),'$.operation.message.id'),JSON_VALUE(CAST(body AS Json),'$.archive.id')) AS id,
              COALESCE(JSON_VALUE(CAST(body AS Json),'$.data.fromUserId'),JSON_VALUE(CAST(body AS Json),'$.operation.message.fromUserId'),JSON_VALUE(CAST(body AS Json),'$.archive.fromUserId')) AS fromUserId,
              COALESCE(JSON_VALUE(CAST(body AS Json),'$.data.toUserId'),JSON_VALUE(CAST(body AS Json),'$.operation.message.toUserId'),JSON_VALUE(CAST(body AS Json),'$.archive.toUserId')) AS toUserId,
              COALESCE(JSON_VALUE(CAST(body AS Json),'$.data.groupId'),JSON_VALUE(CAST(body AS Json),'$.archive.groupId')) AS groupId,
              COALESCE(JSON_VALUE(CAST(body AS Json),'$.data.userId'),JSON_VALUE(CAST(body AS Json),'$.data.uploaderId'),JSON_VALUE(CAST(body AS Json),'$.userId')) AS userId,
              COALESCE(JSON_VALUE(CAST(body AS Json),'$.data.sentAt'),JSON_VALUE(CAST(body AS Json),'$.operation.message.sentAt'),JSON_VALUE(CAST(body AS Json),'$.archive.sentAt')) AS at,
              JSON_VALUE(CAST(body AS Json),'$.lastSeenAt') AS lastSeenAt,
              JSON_VALUE(CAST(body AS Json),'$.operation.type') AS opType,
              JSON_VALUE(CAST(body AS Json),'$.data.status') AS status,
              JSON_VALUE(CAST(body AS Json),'$.data.messageId') AS messageId,
              JSON_VALUE(CAST(body AS Json),'$.data.groupMessageId') AS groupMessageId,
              COALESCE(JSON_VALUE(CAST(body AS Json),'$.data.confirmedSize'),JSON_VALUE(CAST(body AS Json),'$.data.requestedSize')) AS size,
              JSON_VALUE(CAST(body AS Json),'$.deletedVersion') AS deletedVersion,
              JSON_VALUE(CAST(body AS Json),'$.aliveVersion') AS aliveVersion,
              CAST(JSON_QUERY(CAST(body AS Json),'$.contacts') AS Utf8) AS contacts
              FROM tm_kv WHERE bucket IN ('rows:Message'u,'rows:GroupMessage'u,'operations'u,'states'u,'rows:GroupMember'u,'rows:Attachment'u,'device-telemetry'u,'user-state'u)
              ORDER BY bucket,key LIMIT 20001`;
            return rows.map(row=>({...row,...(row.bucket==='user-state'?{userId:row.key}:{})}));
          },
          async scan(bucket, limit = 100) {
            const [rows] = await tx`SELECT body FROM tm_kv WHERE bucket = ${bucket} ORDER BY key LIMIT ${new Uint64(BigInt(limit))}`;
            return rows.map((row) => JSON.parse(row.body));
          },
          async scanPrefix(bucket, prefix, limit = 1000) {
            const upper = prefix + "\uffff";
            const [rows] = await tx`SELECT body FROM tm_kv WHERE bucket = ${bucket} AND key >= ${prefix} AND key < ${upper} ORDER BY key LIMIT ${new Uint64(BigInt(limit))}`;
            return rows.map((row) => JSON.parse(row.body));
          },
          async scanEntries(bucket, limit = 100) {
            const [rows] = await tx`SELECT key, body FROM tm_kv WHERE bucket = ${bucket} ORDER BY key LIMIT ${new Uint64(BigInt(limit))}`;
            return rows.map((row) => ({ key: row.key, value: JSON.parse(row.body) }));
          },
          async putView(userId, message) {
            const body = JSON.stringify(message);
            await tx`UPSERT INTO tm_views (user_id, sent_at, message_id, body) VALUES (${userId}, ${message.sentAt}, ${message.id}, ${body})`;
          },
          async getView(userId, sentAt, messageId) {
            const [rows] = await tx`SELECT body FROM tm_views WHERE user_id = ${userId} AND sent_at = ${sentAt} AND message_id = ${messageId}`;
            return rows[0] ? JSON.parse(rows[0].body) : undefined;
          },
          async views(userId, limit = 100) {
            const [rows] = await tx`SELECT body FROM tm_views WHERE user_id = ${userId} ORDER BY sent_at DESC, message_id DESC LIMIT ${new Uint64(BigInt(limit))}`;
            return rows.map((row) => JSON.parse(row.body));
          },
          async addFeed(userId, sequence, value) {
            const body = JSON.stringify(value);
            await tx`UPSERT INTO tm_feed (user_id, seq, body) VALUES (${userId}, ${new Uint64(BigInt(sequence))}, ${body})`;
          },
          async feed(userId, after, limit) {
            const [rows] = await tx`SELECT seq, body FROM tm_feed WHERE user_id = ${userId} AND seq > ${new Uint64(BigInt(after))} ORDER BY seq LIMIT ${new Uint64(BigInt(limit))}`;
            return rows.map((row) => ({ sequence: String(row.seq), ...JSON.parse(row.body) }));
          },
          async sequence() {
            return (await store.get("meta", "sequence"))?.value || "0";
          },
          async nextSequence() {
            const next = String(BigInt(await store.sequence()) + 1n);
            await store.put("meta", "sequence", { value: next });
            return next;
          },
        };
        try { return await callback(store); }
        catch (error) { callbackErrors.add(error); throw error; }
      }); } catch (error) {
        // SDK wraps callback exceptions after rolling back the transaction.
        // Preserve only errors we actually observed in our callback.
        for (let cause = error; cause; cause = cause.cause) if (callbackErrors.has(cause)) throw cause;
        throw error;
      }
    },
    close() { driver.close(); },
  };
}
