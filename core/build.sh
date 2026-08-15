#!/usr/bin/env bash
#
# Builds the deterministic snes9x wasm core.
#
# Runs entirely inside the official emscripten image, so the only host
# requirements are docker and git. The snes9x checkout is pinned: a core
# rebuilt from a different commit is a different state machine, and two peers
# on two different builds desync in ways that look exactly like a netcode bug.
#
#   ./core/build.sh          # incremental
#   ./core/build.sh --clean  # from scratch
#
set -euo pipefail

CORE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$CORE_DIR/.." && pwd)"

SNES9X_REPO="https://github.com/libretro/snes9x.git"
SNES9X_COMMIT="97c65a34a2eb8592de6c7b44a0ad681895684a41"
EMSDK_IMAGE="emscripten/emsdk:3.1.64"

VENDOR_DIR="$CORE_DIR/vendor/snes9x"
DIST_DIR="$CORE_DIR/dist"

CLEAN=0
[[ "${1:-}" == "--clean" ]] && CLEAN=1

log() { printf '\033[1;36m[core]\033[0m %s\n' "$*"; }

# ------------------------------------------------------------------ sources

if [[ ! -d "$VENDOR_DIR/.git" ]]; then
  log "cloning snes9x @ ${SNES9X_COMMIT:0:8}"
  rm -rf "$VENDOR_DIR"
  mkdir -p "$(dirname "$VENDOR_DIR")"
  git clone --filter=blob:none --no-checkout "$SNES9X_REPO" "$VENDOR_DIR"
fi

CURRENT="$(git -C "$VENDOR_DIR" rev-parse HEAD 2>/dev/null || echo none)"

# Check for the files, not just the commit. The clone above uses --no-checkout,
# and when the pinned commit happens to be the default branch tip, HEAD already
# reads as correct while the working tree is still empty.
if [[ "$CURRENT" != "$SNES9X_COMMIT" || ! -f "$VENDOR_DIR/libretro/Makefile" ]]; then
  log "checking out pinned commit ${SNES9X_COMMIT:0:8}"
  git -C "$VENDOR_DIR" checkout --force "$SNES9X_COMMIT" 2>/dev/null || {
    git -C "$VENDOR_DIR" fetch --depth 1 origin "$SNES9X_COMMIT"
    git -C "$VENDOR_DIR" checkout --force "$SNES9X_COMMIT"
  }
  CLEAN=1
fi

if [[ ! -f "$VENDOR_DIR/libretro/Makefile" ]]; then
  echo "snes9x checkout is incomplete: $VENDOR_DIR/libretro/Makefile is missing" >&2
  exit 1
fi

mkdir -p "$DIST_DIR"

# ------------------------------------------------------------------- docker

if ! docker image inspect "$EMSDK_IMAGE" >/dev/null 2>&1; then
  log "pulling $EMSDK_IMAGE (this takes a while the first time)"
  docker pull "$EMSDK_IMAGE"
fi

JOBS="$(nproc 2>/dev/null || echo 4)"

# The container runs as the invoking user so build artefacts stay writable on
# the host, and HOME is redirected because emscripten wants a cache directory.
docker_run() {
  docker run --rm \
    -u "$(id -u):$(id -g)" \
    -v "$REPO_DIR:/src" \
    -e "HOME=/src/core/.emcache" \
    -w /src/core \
    "$EMSDK_IMAGE" \
    bash -c "$1"
}

mkdir -p "$CORE_DIR/.emcache"

# ------------------------------------------------------- 1. snes9x archive

if [[ $CLEAN == 1 ]]; then
  log "cleaning previous objects"
  docker_run "make -C vendor/snes9x/libretro -f Makefile platform=emscripten clean >/dev/null 2>&1 || true"
  rm -f "$DIST_DIR"/psnes_core.*
fi

# STATIC_LINKING=0 with STATIC_LINKING_LINK=1: still produce an archive, but
# keep libretro's VFS sources in it. The emscripten platform block sets
# STATIC_LINKING=1, which drops file_stream/vfs_implementation on the
# assumption that RetroArch supplies them - true for the usual emscripten
# build, false for us, and the link fails on undefined rfopen/rfread.
log "compiling snes9x (${JOBS} jobs)"
docker_run "emmake make -C vendor/snes9x/libretro -f Makefile \
  platform=emscripten STATIC_LINKING=0 STATIC_LINKING_LINK=1 -j${JOBS}"

ARCHIVE="vendor/snes9x/libretro/snes9x_libretro_emscripten.bc"
if [[ ! -f "$CORE_DIR/$ARCHIVE" ]]; then
  echo "core build failed: $ARCHIVE not produced" >&2
  exit 1
fi

# --------------------------------------------------- 2. link the frontend

EXPORTS='[
"_pn_init","_pn_load_rom","_pn_unload","_pn_reset","_pn_run_frame",
"_pn_video","_pn_video_width","_pn_video_height","_pn_video_stride",
"_pn_audio","_pn_audio_frames","_pn_sample_rate","_pn_fps",
"_pn_frame_count","_pn_set_frame_count",
"_pn_state_size","_pn_state_save","_pn_state_load","_pn_state_crc",
"_pn_sram","_pn_sram_size","_pn_wram","_pn_wram_size","_pn_wram_crc",
"_pn_debug_rand","_pn_debug_time","_pn_debug_reset_entropy",
"_malloc","_free"
]'
EXPORTS="$(echo "$EXPORTS" | tr -d ' \n')"

# --wrap on the entropy entry points: see core/src/determinism.c. Every call
# in snes9x, including ones we have not audited, lands on the fixed-seed
# versions instead of the host's.
WRAPS="-Wl,--wrap=rand -Wl,--wrap=srand -Wl,--wrap=time -Wl,--wrap=clock -Wl,--wrap=gettimeofday"

# Compile the frontend with emcc, not em++. Handing a .c file to em++ compiles
# it as C++, which mangles the symbol names - and then every name in
# EXPORTED_FUNCTIONS silently fails to resolve.
log "compiling the frontend"
mkdir -p "$CORE_DIR/build"
docker_run "emcc -O3 -std=c11 \
  -I vendor/snes9x/libretro \
  -I vendor/snes9x/libretro/libretro-common/include \
  -c src/psnes_core.c -o build/psnes_core.o"
docker_run "emcc -O3 -std=c11 -c src/determinism.c -o build/determinism.o"

# The libretro makefile names its ar archive .bc, which emcc treats as a
# bitcode *source* file and tries to compile. Renaming is enough for it to be
# recognised as the archive it actually is.
cp "$CORE_DIR/$ARCHIVE" "$CORE_DIR/build/libsnes9x.a"

# Linking goes through em++: the snes9x archive is C++ and needs libc++.
log "linking psnes_core.mjs"
docker_run "em++ -O3 \
  build/psnes_core.o build/determinism.o build/libsnes9x.a \
  $WRAPS \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s EXPORT_NAME=createPsnesCore \
  -s ENVIRONMENT=web,worker,node \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=134217728 \
  -s STACK_SIZE=5242880 \
  -s INVOKE_RUN=0 \
  -s EXIT_RUNTIME=0 \
  -s ASSERTIONS=0 \
  -s EXPORTED_FUNCTIONS='$EXPORTS' \
  -s EXPORTED_RUNTIME_METHODS='[\"HEAPU8\",\"HEAP16\",\"HEAPU16\",\"HEAP32\",\"HEAPU32\",\"HEAPF32\"]' \
  -o dist/psnes_core.mjs"

# Both artefacts go to static/ and are loaded at runtime with a dynamic import
# rather than bundled. That keeps `vite build` working on a checkout where the
# core has not been built yet, instead of failing on a missing module.
STATIC_DIR="$REPO_DIR/frontend/static/psnes-core"
mkdir -p "$STATIC_DIR"
cp "$DIST_DIR/psnes_core.mjs" "$DIST_DIR/psnes_core.wasm" "$STATIC_DIR/"

log "done:"
ls -lh "$DIST_DIR"/psnes_core.mjs "$DIST_DIR"/psnes_core.wasm | sed 's/^/  /'
