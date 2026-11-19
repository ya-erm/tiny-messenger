#include <stdint.h>
#include <webp/encode.h>

int tm_webp_version(void) { return WebPGetEncoderVersion(); }
size_t tm_webp_encode(const uint8_t* rgba, int width, int height, float quality, uint8_t** output) {
  if (!rgba || !output || width < 1 || height < 1 || width > 4096 || height > 4096) return 0;
  return WebPEncodeRGBA(rgba, width, height, width * 4, quality, output);
}
