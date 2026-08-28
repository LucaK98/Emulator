#!/usr/bin/env bash
#
# Builds the Game Boy / Game Boy Color core (SameBoy) to WebAssembly.
#
# Output lands in public/cores/ and is committed, so neither CI nor the Pages
# deploy needs Emscripten. Re-run this after bumping the vendor/sameboy
# submodule.
#
# Requires:
#   emcc   - Emscripten SDK, e.g. `source /path/to/emsdk/emsdk_env.sh`
#   rgbds  - the RGBDS assembler (rgbasm/rgblink/rgbgfx), on PATH or in RGBDS_DIR;
#            SameBoy's boot ROMs are assembled from source.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SAMEBOY="$ROOT/vendor/sameboy"
BUILD="$ROOT/build/gb"
OUT="$ROOT/public/cores"

if [ ! -f "$SAMEBOY/Core/gb.c" ]; then
  echo "vendor/sameboy is empty. Run: git submodule update --init --recursive" >&2
  exit 1
fi

command -v emcc >/dev/null || { echo "emcc not found; source emsdk_env.sh first" >&2; exit 1; }

if [ -n "${RGBDS_DIR:-}" ]; then
  export PATH="$RGBDS_DIR:$PATH"
fi
command -v rgbasm >/dev/null || { echo "rgbasm not found; install RGBDS or set RGBDS_DIR" >&2; exit 1; }

echo "==> Assembling boot ROMs"
make -C "$SAMEBOY" bootroms -j"$(nproc)" >/dev/null

echo "==> Embedding boot ROMs"
python3 "$ROOT/scripts/build-cores/embed-bootroms.py" \
  "$SAMEBOY/build/bin/BootROMs" "$BUILD/bootroms.h"

# Compiled explicitly rather than with a glob: the debugger, cheat engine and
# rewind buffer are switched off below, and their translation units do not
# compile once the matching fields are gone from GB_gameboy_t.
CORE_SOURCES=(
  "$SAMEBOY/Core/apu.c"
  "$SAMEBOY/Core/camera.c"
  "$SAMEBOY/Core/display.c"
  "$SAMEBOY/Core/gb.c"
  "$SAMEBOY/Core/joypad.c"
  "$SAMEBOY/Core/mbc.c"
  "$SAMEBOY/Core/memory.c"
  "$SAMEBOY/Core/printer.c"
  "$SAMEBOY/Core/random.c"
  "$SAMEBOY/Core/rumble.c"
  "$SAMEBOY/Core/save_state.c"
  "$SAMEBOY/Core/sgb.c"
  "$SAMEBOY/Core/sm83_cpu.c"
  "$SAMEBOY/Core/timing.c"
  "$SAMEBOY/Core/workboy.c"
  "$ROOT/native/gb/sameboy_wasm.c"
)

echo "==> Compiling core to WebAssembly"
mkdir -p "$OUT"

# The debugger, cheat engine and rewind buffer are dead weight in the browser:
# save states cover rewind, and the debugger drags in stdio. Disabling them
# keeps the module small and the guards in SameBoy's headers do the rest.
DEFINES=(
  -DGB_INTERNAL
  -DGB_DISABLE_DEBUGGER
  -DGB_DISABLE_CHEATS
  -DGB_DISABLE_REWIND
  -DGB_VERSION="\"$(cd "$SAMEBOY" && git describe --tags --always)\""
)

emcc \
  -O3 -flto \
  -std=gnu11 \
  "${DEFINES[@]}" \
  -I"$SAMEBOY" \
  -I"$BUILD" \
  -Wno-multichar \
  "${CORE_SOURCES[@]}" \
  -o "$OUT/sameboy.js" \
  -s ENVIRONMENT=worker,node \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s EXPORT_NAME=createSameBoy \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=33554432 \
  -s STACK_SIZE=1048576 \
  -s FILESYSTEM=0 \
  -s EXPORTED_FUNCTIONS='["_malloc","_free"]' \
  -s EXPORTED_RUNTIME_METHODS='["HEAPU8","HEAPU16","HEAP32","HEAPU32","HEAP16"]' \
  -s INCOMING_MODULE_JS_API='["wasmBinary","locateFile"]'

echo "==> Built:"
ls -la "$OUT"/sameboy.js "$OUT"/sameboy.wasm
