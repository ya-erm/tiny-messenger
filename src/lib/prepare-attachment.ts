// Client-only: image bytes never pass through the application server.
export type AttachmentMode = "media" | "file";
export type PreparedAttachment = { file: File; note?: string; originalSize?: number };

const WEBP_QUALITY = 0.92;
const MAX_EDGE = 4096;

async function staticPng(file: File) {
  const signature = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  if (signature.join() !== "137,80,78,71,13,10,26,10") return false;
  let offset = 8;
  // acTL precedes IDAT in animated PNG. Inspect chunk headers, without
  // allocating large ancillary chunks or flattening an animation to a frame.
  for (let count = 0; count < 128 && offset + 8 <= file.size; count++) {
    const bytes = new Uint8Array(await file.slice(offset, offset + 8).arrayBuffer());
    const length = new DataView(bytes.buffer).getUint32(0);
    const kind = String.fromCharCode(...bytes.subarray(4, 8));
    if (kind === "acTL") return false;
    if (kind === "IDAT") return true;
    offset += length + 12;
  }
  return false;
}

export async function prepareAttachment(file: File, mode: AttachmentMode): Promise<PreparedAttachment> {
  if (mode === "file") return { file, note: "Оригинал без сжатия" };
  // Preserve animation and already-efficient/unsupported formats verbatim.
  if (!['image/jpeg', 'image/png'].includes(file.type)) return { file, note: "Оригинал" };
  let bitmap: ImageBitmap | undefined;
  let image: HTMLImageElement | undefined;
  let objectUrl: string | undefined;
  let canvas: HTMLCanvasElement | undefined;
  try {
    if (file.type === "image/png" && !await staticPng(file)) return { file, note: "Оригинал" };
    if (typeof createImageBitmap === "function") {
      // Some WebKit versions expose this API but reject images they can decode
      // through <img>. Do not make that optional fast path a requirement.
      try { bitmap = await createImageBitmap(file, { imageOrientation: "from-image" }); } catch { /* try the image decoder */ }
    }
    if (!bitmap) {
      objectUrl = URL.createObjectURL(file);
      image = new Image(); image.src = objectUrl;
      await image.decode();
    }
    const source = bitmap ?? image!;
    const width = bitmap?.width ?? image!.naturalWidth;
    const height = bitmap?.height ?? image!.naturalHeight;
    if (!width || !height || width * height > 64_000_000) throw new Error("image_dimensions");
    const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
    canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("canvas_unavailable");
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    const encode = (type: string) => new Promise<Blob | null>((resolve) => canvas!.toBlob(resolve, type, WEBP_QUALITY));
    let blob = await encode("image/webp");
    // Canvas may silently return PNG when WebP encoding is unsupported. Keep
    // alpha for PNG; for JPEG use the browser's JPEG encoder at the same quality.
    if (blob?.type !== "image/webp") {
      blob = file.type === "image/png" && blob?.type === "image/png" ? blob : await encode(file.type);
      if (blob?.type !== file.type) throw new Error("encoder_unavailable");
    }
    if (!blob) throw new Error("encoder_unavailable");
    if (blob.size >= file.size) return { file, note: "Оригинал меньше сжатой копии" };
    const stem = [...(file.name.replace(/\.[^.]+$/, "") || "image")];
    const encoder = new TextEncoder();
    while (encoder.encode(stem.join("")).length > 250) stem.pop();
    const extension = blob.type === "image/webp" ? ".webp" : blob.type === "image/jpeg" ? ".jpg" : ".png";
    const name = stem.join("") + extension;
    const result = new File([blob], name, { type: blob.type, lastModified: file.lastModified });
    const note = blob.type === "image/webp" ? "WebP · качество 92%" : blob.type === "image/jpeg" ? "JPEG · качество 92%" : "PNG · без потери прозрачности";
    return { file: result, note, originalSize: file.size };
  } catch {
    // Compression is optional. Existing file-size/count checks still apply to
    // the original, so an unsupported decoder/encoder must not block sending.
    return { file, note: "Оригинал: сжатие недоступно в этом браузере" };
  } finally {
    bitmap?.close();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
}
