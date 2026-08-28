#!/usr/bin/env bash
#
# Builds the Nintendo DS core (melonDS) to WebAssembly.
#
# Output lands in public/cores/ and is committed, so neither CI nor the Pages
# deploy needs Emscripten. Re-run after bumping the vendor/melonds submodule.
#
# Requires:
#   emcc / emcmake - Emscripten SDK, e.g. `source /path/to/emsdk/emsdk_env.sh`
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MELON="$ROOT/vendor/melonds"
BUILD="$MELON/build-wasm"
OUT="$ROOT/public/cores"

if [ ! -f "$MELON/CMakeLists.txt" ]; then
  echo "vendor/melonds is empty. Run: git submodule update --init --recursive" >&2
  exit 1
fi

command -v emcc >/dev/null || { echo "emcc not found; source emsdk_env.sh first" >&2; exit 1; }

echo "==> Configuring melonDS"
# Core only: no Qt frontend, no OpenGL renderer (the software renderer is what
# runs in a browser), no GDB stub. The JIT disables itself on wasm32 because
# melonDS only offers it for x86-64 and ARM64.
mkdir -p "$BUILD"
(cd "$BUILD" && emcmake cmake .. \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_QT_SDL=OFF \
  -DENABLE_OGLRENDERER=OFF \
  -DENABLE_GDBSTUB=OFF \
  >/dev/null)

echo "==> Building libcore"
(cd "$BUILD" && emmake make -j"$(nproc)" core >/dev/null)

echo "==> Linking WebAssembly module"
mkdir -p "$OUT"

em++ \
  -O3 -flto \
  -std=c++17 \
  -I"$MELON/src" \
  "$ROOT/native/nds/melonds_wasm.cpp" \
  "$ROOT/native/nds/platform.cpp" \
  "$BUILD/src/libcore.a" \
  "$BUILD/src/teakra/src/libteakra.a" \
  -o "$OUT/melonds.js" \
  -s ENVIRONMENT=worker,node \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s EXPORT_NAME=createMelonDS \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=134217728 \
  -s STACK_SIZE=4194304 \
  -s FILESYSTEM=0 \
  -s EXPORTED_FUNCTIONS='["_malloc","_free"]' \
  -s EXPORTED_RUNTIME_METHODS='["HEAPU8","HEAPU16","HEAP32","HEAPU32","HEAP16"]' \
  -s INCOMING_MODULE_JS_API='["wasmBinary","locateFile"]' \
  -s DISABLE_EXCEPTION_CATCHING=0

echo "==> Built:"
ls -la "$OUT"/melonds.js "$OUT"/melonds.wasm
