import "server-only";
import type { AttachmentLimits } from "@/lib/attachment-types";

function integer(name: string, fallback: number, maximum = Number.MAX_SAFE_INTEGER) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new Error("Invalid attachment limit: " + name);
  return value;
}

export function attachmentSettings() {
  const endpoint = process.env.ATTACHMENTS_S3_ENDPOINT || "https://storage.yandexcloud.net";
  const region = process.env.ATTACHMENTS_S3_REGION || "ru-central1";
  const bucket = process.env.ATTACHMENTS_S3_BUCKET || "";
  const accessKeyId = process.env.ATTACHMENTS_S3_ACCESS_KEY_ID || "";
  const secretAccessKey = process.env.ATTACHMENTS_S3_SECRET_ACCESS_KEY || "";
  const prefix = process.env.ATTACHMENTS_S3_PREFIX || "";
  if (prefix && !/^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/.test(prefix)) throw new Error("Invalid attachment prefix");
  const url = new URL(endpoint);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Attachment endpoint must use HTTPS");
  const enabled = Boolean(bucket && accessKeyId && secretAccessKey);
  if (enabled && bucket === process.env.LITESTREAM_BUCKET) throw new Error("Attachments require a separate bucket");
  return {
    endpoint, region, bucket, credentials: { accessKeyId, secretAccessKey }, prefix,
    enabled,
    maxFileBytes: integer("ATTACHMENTS_MAX_FILE_BYTES", 50 * 1024 * 1024, 5 * 1024 ** 3),
    maxFilesPerMessage: integer("ATTACHMENTS_MAX_FILES_PER_MESSAGE", 4, 10),
    maxPending: integer("ATTACHMENTS_MAX_PENDING", 4, 20),
    userQuotaBytes: integer("ATTACHMENTS_USER_QUOTA_BYTES", 1024 ** 3),
    uploadTTL: integer("ATTACHMENTS_UPLOAD_TTL_SECONDS", 600, 1800),
    downloadTTL: integer("ATTACHMENTS_DOWNLOAD_TTL_SECONDS", 120, 300),
    unattachedTTL: integer("ATTACHMENTS_UNATTACHED_TTL_HOURS", 24) * 3600_000,
    deleteGrace: integer("ATTACHMENTS_DELETE_GRACE_HOURS", 168) * 3600_000,
    cleanupBatch: integer("ATTACHMENTS_CLEANUP_BATCH", 20, 100),
  };
}

export function attachmentLimits(): AttachmentLimits {
  const { enabled, maxFileBytes, maxFilesPerMessage, maxPending, userQuotaBytes } = attachmentSettings();
  return { enabled, maxFileBytes, maxFilesPerMessage, maxPending, userQuotaBytes };
}

export function attachmentObjectKey(kind: "staging" | "attachments", id: string) {
  const { prefix } = attachmentSettings();
  return (prefix ? prefix + "/" : "") + kind + "/" + id;
}
