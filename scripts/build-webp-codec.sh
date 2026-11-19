#!/usr/bin/env bash
# Run only on an isolated build machine with Emscripten 3.1.70 activated.
set -euo pipefail
codec_source=$(realpath "${1:?libwebp source checkout required}")
codec_output=$(realpath -m "${2:?output directory required}")
codec_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
codec_commit=4fa21912338357f89e4fd51cf2368325b59e9bd9
[[ $(git -C "$codec_source" rev-parse HEAD) == "$codec_commit" ]]
command -v emcmake >/dev/null
mkdir -p "$codec_output"
emcmake cmake -S "$codec_source" -B "$codec_source/wasm-build" \
  -DCMAKE_BUILD_TYPE=MinSizeRel -DBUILD_SHARED_LIBS=OFF -DWEBP_ENABLE_SIMD=OFF \
  -DWEBP_BUILD_ANIM_UTILS=OFF -DWEBP_BUILD_CWEBP=OFF -DWEBP_BUILD_DWEBP=OFF \
  -DWEBP_BUILD_GIF2WEBP=OFF -DWEBP_BUILD_IMG2WEBP=OFF -DWEBP_BUILD_VWEBP=OFF \
  -DWEBP_BUILD_WEBPINFO=OFF -DWEBP_BUILD_WEBPMUX=OFF -DWEBP_BUILD_EXTRAS=OFF
cmake --build "$codec_source/wasm-build" --target webp --parallel 2
codec_webp=$(find "$codec_source/wasm-build" -name libwebp.a -print -quit)
codec_yuv=$(find "$codec_source/wasm-build" -name libsharpyuv.a -print -quit)
[[ -n "$codec_webp" && -n "$codec_yuv" ]]
emcc "$codec_root/scripts/webp-codec-wrapper.c" -I "$codec_source/src" "$codec_webp" "$codec_yuv" \
  -O3 --no-entry -s MODULARIZE=1 -s EXPORT_ES6=1 -s ENVIRONMENT=worker \
  -s FILESYSTEM=0 -s ALLOW_MEMORY_GROWTH=1 -s INITIAL_MEMORY=16777216 \
  -s MAXIMUM_MEMORY=268435456 -s MALLOC=emmalloc \
  -s 'EXPORTED_FUNCTIONS=["_malloc","_free","_tm_webp_encode","_tm_webp_version","_WebPFree"]' \
  -s 'EXPORTED_RUNTIME_METHODS=["HEAPU8","HEAPU32"]' \
  -o "$codec_output/encoder.mjs"
cp "$codec_source/COPYING" "$codec_output/LICENSE.libwebp"
cp "$codec_source/PATENTS" "$codec_output/PATENTS"
cp "$codec_source/AUTHORS" "$codec_output/AUTHORS"
cp "$EMSDK/upstream/emscripten/LICENSE" "$codec_output/LICENSE.emscripten"
printf '%s\n' "libwebp 1.6.0 $codec_commit" 'Emscripten 3.1.70' > "$codec_output/SOURCE.txt"
(cd "$codec_output" && sha256sum encoder.mjs encoder.wasm LICENSE.libwebp LICENSE.emscripten PATENTS AUTHORS SOURCE.txt > SHA256SUMS)
