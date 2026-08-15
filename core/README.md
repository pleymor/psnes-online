# psnes deterministic core

A snes9x build whose only way to advance emulation is:

```c
pn_run_frame(uint16_t pad1, uint16_t pad2);
```

No main loop of its own, no browser input, no wall clock, no host randomness,
no user-adjustable options. Two instances given the same ROM and the same pads
produce identical bytes, which is what ZSNES-style lockstep netplay needs and
what a RetroArch build cannot promise.

See [`../LOCKSTEP_NETPLAY.md`](../LOCKSTEP_NETPLAY.md) for the wider design.

## Building

```bash
./build.sh          # incremental
./build.sh --clean  # from scratch
```

Requirements: `docker` and `git`. Everything compiles inside
`emscripten/emsdk:3.1.64`; nothing is installed on the host. The first run pulls
that image (680MB compressed, 2.75GB on disk) and clones snes9x at a pinned
commit into `vendor/`. After that a rebuild takes under a minute.

The snes9x makefile is invoked with `STATIC_LINKING=0 STATIC_LINKING_LINK=1`.
Its `platform=emscripten` block assumes RetroArch will supply libretro's VFS
implementation and leaves those sources out; we are not RetroArch, so they have
to stay in, and the archive output still has to be produced.

Output:

- `dist/psnes_core.mjs` + `dist/psnes_core.wasm` — used by the node test suite
- copied to `frontend/static/psnes-core/` — loaded by the browser at runtime

**The pin matters.** A core rebuilt from a different snes9x commit is a
different state machine. Two players on two builds desync in a way that looks
exactly like a netcode bug, so `SNES9X_COMMIT` in `build.sh` is part of the
protocol, not a convenience.

## Layout

```
src/psnes_core.c    libretro frontend: callbacks, pad injection, savestates, CRC
src/determinism.c   fixed-seed replacements for rand/srand/time/clock/gettimeofday
build.sh            docker + emscripten build
test/               node test suite (see below)
vendor/, dist/      generated, gitignored
```

## The entropy shims

`src/determinism.c` exists because of this, in snes9x's `retro_load_game()`:

```c
srand(time(NULL));
for (lcv = 0; lcv < sizeof(Memory.RAM); lcv++)
    Memory.RAM[lcv] = rand() % 256;
```

The core pins that option off, but "correct as long as nobody flips an option"
is not a guarantee worth having. The shims are linked in with `-Wl,--wrap`, so
they intercept every call in snes9x including ones nobody has audited, and
`pn_debug_rand()` lets the test suite check they are really there rather than
inferring it from emulation looking fine.

## Tests

```bash
npm run test:netplay   # from the repo root: netcode + relay, no core needed
npm run test:core      # needs this core built, and a ROM
```

| File | Needs | Covers |
|---|---|---|
| `test/netcode.test.ts` | nothing | Wire format, lockstep, desync/resync, epochs, packet loss, outage recovery |
| `test/relay.test.ts` | nothing | The real backend relay handler over real sockets |
| `test/determinism.test.ts` | core + ROM | Two wasm instances stay bit-identical; savestate round-trips; video/audio/SRAM output |
| `test/lockstep.test.ts` | core + ROM | Full netplay sessions driving the real emulator |
| `test/fake-core.ts` | — | Toy deterministic machine standing in for the emulator |
| `test/harness.ts` | — | Two-player session on a virtual clock |

ROMs are never committed. The suite uses `PSNES_TEST_ROM` if set, otherwise
anything already in `backend/roms/` or `core/test/roms/`, and skips with a clear
message when it finds nothing.
