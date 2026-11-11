import "server-only";
import {
  CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand,
  PutObjectCommand, S3Client, ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { ApiError } from "@/lib/api";
import { attachmentSettings } from "@/lib/attachment-config";

let client: S3Client | undefined;
function storage() {
  const settings = attachmentSettings();
  if (!settings.enabled) throw new ApiError(503, "attachments_unconfigured", "Отправка файлов пока не настроена");
  client ??= new S3Client({
    endpoint: settings.endpoint, region: settings.region, credentials: settings.credentials,
    forcePathStyle: true, maxAttempts: 2,
    requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED",
    requestHandler: new NodeHttpHandler({ connectionTimeout: 5000, requestTimeout: 15000 }),
  });
  return { client, ...settings };
}

async function operation<T>(name: string, id: string, run: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    const value = await run();
    console.info(JSON.stringify({ event: "attachment-storage", operation: name, id, ok: true, durationMs: Date.now() - started }));
    return value;
  } catch (error) {
    console.warn(JSON.stringify({ event: "attachment-storage", operation: name, id, ok: false, durationMs: Date.now() - started }));
    if (error instanceof ApiError) throw error;
    throw new ApiError(502, "attachment_storage_unavailable", "Хранилище файлов временно недоступно. Попробуйте ещё раз.");
  }
}

export async function signedUpload(id: string, key: string, size: number, contentType: string, expiresAt: string) {
  return operation("sign-upload", id, async () => {
    const s = storage();
    const expiresIn = Math.floor((Date.parse(expiresAt) - Date.now()) / 1000);
    if (expiresIn <= 0) throw new ApiError(410, "upload_expired", "Срок загрузки истёк. Выберите файл заново.");
    const url = await getSignedUrl(s.client, new PutObjectCommand({
      Bucket: s.bucket, Key: key, ContentLength: size, ContentType: contentType,
      Metadata: { "upload-id": id },
    }), {
      expiresIn,
      signableHeaders: new Set(["content-length", "content-type", "x-amz-meta-upload-id"]),
      unhoistableHeaders: new Set(["x-amz-meta-upload-id"]),
    });
    // Content-Length is signed but set by the browser from File.size; scripts
    // cannot set this forbidden header themselves. A different length fails.
    return { url, method: "PUT" as const, headers: { "Content-Type": contentType, "x-amz-meta-upload-id": id }, expiresAt };
  });
}

export async function headAttachment(id: string, key: string) {
  return operation("head", id, async () => {
    const s = storage();
    try {
      return await s.client.send(new HeadObjectCommand({ Bucket: s.bucket, Key: key }));
    } catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null;
      throw error;
    }
  });
}

export async function freezeAttachment(id: string, source: string, destination: string, etag: string, contentType: string) {
  return operation("copy-final", id, async () => {
    const s = storage();
    return s.client.send(new CopyObjectCommand({
      Bucket: s.bucket, Key: destination,
      CopySource: encodeURIComponent(s.bucket + "/" + source).replace(/%2F/g, "/"),
      CopySourceIfMatch: etag,
      MetadataDirective: "REPLACE", Metadata: { "upload-id": id, "source-etag": etag.replace(/^"|"$/g, "") },
      ContentType: contentType, ContentDisposition: "attachment", CacheControl: "private, max-age=0",
      StorageClass: "STANDARD",
    }));
  });
}

export async function deleteAttachmentObject(id: string, key: string) {
  return operation("delete", id, async () => {
    const s = storage();
    await s.client.send(new DeleteObjectCommand({ Bucket: s.bucket, Key: key }));
  });
}

export async function listAttachmentObjects(prefix: string, startAfter?: string) {
  return operation("sweep-list", prefix.split("/").at(-2) || "objects", async () => {
    const s = storage();
    return s.client.send(new ListObjectsV2Command({ Bucket: s.bucket, Prefix: prefix, StartAfter: startAfter, MaxKeys: 100 }));
  });
}

function disposition(name: string, inline: boolean) {
  const encoded = encodeURIComponent(name).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return `${inline ? "inline" : "attachment"}; filename="download"; filename*=UTF-8''${encoded}`;
}

export async function signedDownload(id: string, key: string, name: string, contentType: string, preview: boolean) {
  return operation("sign-download", id, async () => {
    const s = storage();
    const url = await getSignedUrl(s.client, new GetObjectCommand({
      Bucket: s.bucket, Key: key, ResponseContentDisposition: disposition(name, preview),
      ResponseContentType: preview ? contentType : "application/octet-stream",
      ResponseCacheControl: "private, max-age=0",
    }), { expiresIn: s.downloadTTL });
    return { url, expiresAt: new Date(Date.now() + s.downloadTTL * 1000).toISOString() };
  });
}
