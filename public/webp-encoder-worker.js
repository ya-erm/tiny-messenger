// The source/encoder is pinned and built outside the production VPS. No images
// leave this worker; one transfer per job avoids a second full-size pixel copy.
const CODEC_BASE = "/codecs/libwebp-1.6.0-edcc45730b9d/";
self.onmessage = async ({ data }) => {
  let codec, input = 0, outputSlot = 0, output = 0;
  try {
    const { width, height, buffer, offset = 0 } = data;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 4096 || height > 4096
      || !(buffer instanceof ArrayBuffer) || !Number.isInteger(offset) || offset < 0 || buffer.byteLength - offset !== width * height * 4) throw new Error("invalid_pixels");
    const { default: createCodec } = await import(CODEC_BASE + "encoder.mjs");
    codec = await createCodec({ locateFile: (name) => CODEC_BASE + name });
    if (codec._tm_webp_version() !== 0x010600) throw new Error("unexpected_codec_version");
    input = codec._malloc(width * height * 4); outputSlot = codec._malloc(4);
    if (!input || !outputSlot) throw new Error("webp_memory_limit");
    codec.HEAPU8.set(new Uint8Array(buffer, offset), input);
    codec.HEAPU32[outputSlot >>> 2] = 0;
    const size = codec._tm_webp_encode(input, width, height, 92, outputSlot);
    output = codec.HEAPU32[outputSlot >>> 2];
    if (!size || !output || output + size > codec.HEAPU8.length) throw new Error("webp_encode_failed");
    const encoded = codec.HEAPU8.slice(output, output + size).buffer;
    self.postMessage({ buffer: encoded }, [encoded]);
  } catch { self.postMessage({ error: "webp_encode_failed" }); }
  finally {
    if (output) codec._WebPFree(output);
    if (outputSlot) codec._free(outputSlot);
    if (input) codec._free(input);
  }
};
