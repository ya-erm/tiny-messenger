import {encodeWebpPixels} from "./webp-worker-client";
// Optional, sequential client work. Unsupported decoders keep the original path.
export async function imageThumbnail(file: File, signal?: AbortSignal): Promise<Blob | undefined> {
  if (!/^image\/(jpeg|png|webp|gif|avif)$/.test(file.type) || file.size < 32768) return;
  let bitmap: ImageBitmap | undefined, objectUrl: string | undefined, canvas: HTMLCanvasElement | undefined;
  try {
    if (signal?.aborted) return;
    try {bitmap = await createImageBitmap(file, {imageOrientation: "from-image"});} catch {}
    let image: HTMLImageElement | undefined;
    if (!bitmap) {objectUrl = URL.createObjectURL(file); image = new Image(); image.src = objectUrl; await image.decode();}
    const width = bitmap?.width || image!.naturalWidth, height = bitmap?.height || image!.naturalHeight;
    if (!width || !height || width * height > 64000000) return;
    canvas = document.createElement("canvas");
    for (const edge of [640, 480, 320]) {
      if (signal?.aborted) return;
      const scale = Math.min(1, edge / Math.max(width, height));
      canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
      const context = canvas.getContext("2d"); if (!context) return;
      context.drawImage(bitmap || image!, 0, 0, canvas.width, canvas.height);
      let blob = await new Promise<Blob | null>(resolve => canvas!.toBlob(resolve, "image/webp", .72));
      if (blob?.type !== "image/webp") blob = await encodeWebpPixels(context.getImageData(0, 0, canvas.width, canvas.height), signal);
      if (blob && blob.size <= 102400 && blob.size < file.size * .8) return blob;
    }
  } catch {} finally {bitmap?.close(); if (objectUrl) URL.revokeObjectURL(objectUrl); if (canvas) {canvas.width = 0; canvas.height = 0;}}
}
