#!/usr/bin/env bash
#
# Builds the Game Boy Advance core (mGBA) to WebAssembly.
#
# Output lands in public/cores/ and is committed, so neither CI nor the Pages
# deploy needs Emscripten. Re-run this after bumping the vendor/mgba submodule.
#
# Requires:
#   emcc / emcmake - Emscripten SDK, e.g. `source /path/to/emsdk/emsdk_env.sh`
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MGBA="$ROOT/vendor/mgba"
BUILD="$MGBA/build-wasm"
OUT="$ROOT/public/cores"

if [ ! -f "$MGBA/CMakeLists.txt" ]; then
  echo "vendor/mgba is empty. Run: git submodule update --init --recursive" >&2
  exit 1
fi

command -v emcc >/dev/null || { echo "emcc not found; source emsdk_env.sh first" >&2; exit 1; }

echo "==> Configuring mGBA"
# A core-only build: no frontends, no image/archive/scripting dependencies.
#
# Two overrides are needed under Emscripten. _GNU_SOURCE exposes strdup and
# PATH_MAX, which mGBA's POSIX code expects. HAVE_STRLCPY is forced off because
# CMake's link-based probe reports it as present while Emscripten's libc does
# not actually declare it, and mGBA then skips its own implementation.
#
# MINIMAL_CORE is deliberately not used: it drops the video proxy, video logger
# and audio mixer sources, but src/gba/core.c still references them, so the
# link fails. The regular core build is the supported configuration.
mkdir -p "$BUILD"
(cd "$BUILD" && emcmake cmake .. \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_C_FLAGS="-D_GNU_SOURCE" \
  -DHAVE_STRLCPY:INTERNAL=0 \
  -DBUILD_STATIC=ON -DBUILD_SHARED=OFF \
  -DDISABLE_FRONTENDS=ON \
  -DM_CORE_GBA=ON -DM_CORE_GB=OFF \
  -DUSE_DEBUGGERS=OFF -DUSE_GDB_STUB=OFF -DUSE_EDITLINE=OFF \
  -DUSE_ZLIB=OFF -DUSE_PNG=OFF -DUSE_SQLITE3=OFF -DUSE_LIBZIP=OFF \
  -DUSE_MINIZIP=OFF -DUSE_LZMA=OFF -DUSE_ELF=OFF -DUSE_FFMPEG=OFF \
  -DUSE_DISCORD_RPC=OFF -DUSE_LUA=OFF -DUSE_EPOXY=OFF -DUSE_PTHREADS=OFF \
  -DBUILD_GL=OFF -DBUILD_GLES2=OFF -DBUILD_GLES3=OFF \
  -DBUILD_QT=OFF -DBUILD_SDL=OFF -DBUILD_LIBRETRO=OFF -DBUILD_TEST=OFF \
  >/dev/null)

echo "==> Building libmgba"
(cd "$BUILD" && emmake make -j"$(nproc)" mgba >/dev/null)

echo "==> Linking WebAssembly module"
mkdir -p "$OUT"

emcc \
  -O3 -flto \
  -std=gnu11 \
  -D_GNU_SOURCE \
  -I"$MGBA/include" \
  -I"$MGBA/src" \
  -I"$BUILD" \
  "$ROOT/native/gba/mgba_wasm.c" \
  "$BUILD/libmgba.a" \
  -o "$OUT/mgba.js" \
  -s ENVIRONMENT=worker,node \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s EXPORT_NAME=createMgba \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=67108864 \
  -s STACK_SIZE=2097152 \
  -s FILESYSTEM=0 \
  -s EXPORTED_FUNCTIONS='["_malloc","_free"]' \
  -s EXPORTED_RUNTIME_METHODS='["HEAPU8","HEAPU16","HEAP32","HEAPU32","HEAP16"]' \
  -s INCOMING_MODULE_JS_API='["wasmBinary","locateFile"]'

echo "==> Built:"
ls -la "$OUT"/mgba.js "$OUT"/mgba.wasm
