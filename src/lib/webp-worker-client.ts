// The codec itself is fetched only after native WebP encoding fails. Each job
// owns a worker so cancel/timeout can release its WASM heap immediately.
export function encodeWebpPixels(image: ImageData, signal?: AbortSignal): Promise<Blob> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Подготовка отменена", "AbortError"));
    let worker: Worker;
    try { worker = new Worker("/webp-encoder-worker.js", { type: "module" }); }
    catch (error) { reject(error); return; }
    let settled = false;
    const finish = (error?: unknown, data?: ArrayBuffer) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); worker.terminate();
      if (error) reject(error); else resolve(new Blob([data!], { type: "image/webp" }));
    };
    const abort = () => finish(new DOMException("Подготовка отменена", "AbortError"));
    const timer = window.setTimeout(() => finish(new Error("webp_encode_timeout")), 25_000);
    signal?.addEventListener("abort", abort, { once: true });
    worker.onerror = (event) => { event.preventDefault(); finish(new Error("webp_worker_unavailable")); };
    worker.onmessage = (event: MessageEvent<{ buffer?: ArrayBuffer; error?: string }>) => {
      const buffer = event.data?.buffer;
      const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : null;
      if (!bytes || bytes.length < 12 || String.fromCharCode(...bytes.subarray(0, 4)) !== "RIFF"
        || String.fromCharCode(...bytes.subarray(8, 12)) !== "WEBP") return finish(new Error("webp_encode_failed"));
      finish(undefined, buffer);
    };
    try {
      const buffer = image.data.buffer as ArrayBuffer;
      worker.postMessage({ buffer, offset: image.data.byteOffset, width: image.width, height: image.height, quality: 92 }, [buffer]);
    } catch (error) { finish(error); }
  });
}
