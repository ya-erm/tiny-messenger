import {ApiError} from "@/lib/api";
export const THUMBNAIL_SUFFIX = ".thumbnail.webp";
export const THUMBNAIL_MAX_BYTES = 102400;
export function thumbnailRequestedSize(value: unknown, contentType: string): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > THUMBNAIL_MAX_BYTES || !/^image\/(jpeg|png|webp|gif|avif)$/.test(contentType)) throw new ApiError(422, "invalid_thumbnail", "Некорректные параметры миниатюры");
  return Number(value);
}
export async function completeThumbnail(id: string, stagingKey: string, objectKey: string, size: number | null, storage: {headAttachment: (id: string, key: string) => Promise<any>; freezeAttachment: (id: string, source: string, destination: string, etag: string, type: string) => Promise<any>}) {
  if (!size) return {thumbnailKey: null, thumbnailSize: null};
  const uploadId = id + "-thumbnail", key = objectKey + THUMBNAIL_SUFFIX;
  let final = await storage.headAttachment(uploadId, key);
  if (!final) {
    const source = await storage.headAttachment(uploadId, stagingKey + THUMBNAIL_SUFFIX);
    // A failed optional preview upload must not discard the original image.
    if (!source) return {thumbnailKey: null, thumbnailSize: size};
    if (source.ContentLength !== size || source.ContentType !== "image/webp" || source.Metadata?.["upload-id"] !== uploadId || !source.ETag) throw new ApiError(422, "thumbnail_mismatch", "Параметры миниатюры не совпадают");
    await storage.freezeAttachment(uploadId, stagingKey + THUMBNAIL_SUFFIX, key, source.ETag, "image/webp");
    final = await storage.headAttachment(uploadId, key);
  }
  if (!final?.ETag || final.ContentLength !== size || final.ContentType !== "image/webp" || final.Metadata?.["upload-id"] !== uploadId || !final.Metadata?.["source-etag"]) throw new ApiError(422, "thumbnail_mismatch", "Не удалось подтвердить миниатюру");
  return {thumbnailKey: key, thumbnailSize: size};
}
