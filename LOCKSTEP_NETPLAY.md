# Lockstep netplay (ZSNES-style)

An alternative to the existing dual and streaming multiplayer modes, modelled
on how ZSNES does netplay rather than on modern rollback netcode.

## Why a third mode

The dual mode runs two independent RetroArch instances and tries to keep them
together with input delay plus periodic resyncs. It drifts, and the reasons are
structural rather than bugs in the sync manager:

- **RetroArch owns its own main loop.** There is no way to say "run exactly one
  frame". `frame-controller.ts` monkey-patches `requestAnimationFrame` to fake
  it, which works until anything else in the page schedules a frame.
- **Input arrives through the browser.** Pads are injected by faking keyboard
  events and a virtual gamepad, so what the emulator sees depends on event
  timing rather than on a frame number.
- **Settings are per-user.** Two players with different core options are
  running two different state machines, and nothing detects that.
- **snes9x seeds work RAM from the wall clock.** In `libretro.cpp`:

  ```c
  srand(time(NULL));
  for (lcv = 0; lcv < sizeof(Memory.RAM); lcv++)
      Memory.RAM[lcv] = rand() % 256;
  ```

  Two players loading the same ROM a second apart start with 128KB of
  *different* work RAM. Any game that seeds its RNG from uninitialised memory
  diverges on its first random event.

None of that is fixable from the outside. So this mode replaces the emulator
layer as well as the netcode.

## The core

`core/` builds a purpose-made wasm module: the snes9x libretro core, pinned to
a specific commit, linked against a ~450-line libretro frontend
(`core/src/psnes_core.c`) instead of RetroArch.

The frontend exists to make one guarantee true:

```
new_state = run_frame(old_state, pad1, pad2)
```

- `pn_run_frame(pad1, pad2)` is the only way to advance emulation. Pads are
  arguments; the core never reads the browser.
- Core options are compiled in, so two peers cannot be running different ones.
- `rand`, `srand`, `time`, `clock` and `gettimeofday` are replaced at link time
  with fixed-seed versions (`core/src/determinism.c`, wired up with
  `-Wl,--wrap`). Loading a ROM is a pure function even if a future option turns
  RAM randomisation back on.
- `pn_state_crc()` is a CRC32 of the serialised machine; `pn_wram_crc()` is a
  CRC32 of work RAM, cheap enough to sample every frame while debugging.

Build it with:

```bash
./core/build.sh          # needs docker; pulls emscripten/emsdk on first run
./core/build.sh --clean
```

Artefacts land in `core/dist/` and are copied to `frontend/static/psnes-core/`.
Nothing imports them statically, so the app still builds without them — the
lockstep mode simply reports that the core is missing.

## The netcode

`frontend/src/lib/znet/`. The design is deliberately the old one:

- Local input read while frame `F` runs is scheduled for frame `F+D`, where `D`
  is the input delay. That delay is the window a pad packet has to cross the
  network in. It is sized from a burst of five round-trip samples during the
  handshake, taking the fastest sample plus the spread around it and discarding
  the single worst - a session's first ping carries the socket and the relay
  waking up, reads far above the link, and sizing on it alone priced every match
  for a latency that never came back.
- A frame does not run until **every** player's pad for it has arrived. If a
  packet is late, the emulator waits. There is no prediction and no rollback.
- Frames `0..D-1` are primed with neutral pads on both sides: nobody could have
  sampled input for them.
- Each pad packet repeats the last few frames the sender already transmitted.
  A dropped packet then costs nothing, where asking for a retransmit would cost
  a full round trip with both peers stalled.
- Every `crcInterval` frames both peers exchange a checksum. A mismatch makes
  the host ship a full savestate; both sides restart from it under a new
  *epoch*, and packets tagged with the old epoch are discarded.

`D` is not really a per-peer quantity, which is worth knowing before touching
it. Frame `F` needs the peer's pad from `F - D_peer`, which the peer could only
have sent once it held ours from `F - D_peer - D_ours`. A sustained 60fps
therefore needs only

```
D_host + D_guest >= rtt / frameMs
```

Neither delay has to cover the one-way trip by itself, so input latency is a
budget the two players can split unevenly: a 120ms link needs about eight frames
between them, and whoever minds the lag most can take three while the other
takes nine. `NetplaySession.setInputDelay()` does that. It needs no agreement
from the peer, because pads are keyed by absolute frame and past the priming
window the delay governs nothing but how far ahead a peer samples its own input;
a test holds two different delays over a 200ms link and checks the two machines
stay bit-identical. Note also that a *constant* latency above `D` costs a
one-off offset between the peers rather than frame rate. Only jitter stalls.

The trade-off against rollback is explicit. Lockstep costs `D` frames of input
latency and freezes when the network does, and in exchange it cannot produce
the "looked right locally, wrong on the other machine" class of bug. When it
does go wrong, it goes wrong visibly.

### Files

| File | Role |
|---|---|
| `session.ts` | The engine. Timer-free: everything happens in `tick()` and `pump()` |
| `protocol.ts` | Binary wire format |
| `transport.ts` | Transport interface, plus a simulated link with latency/jitter/loss |
| `socket-transport.ts` | Transport over the app's socket.io connection |
| `governor.ts` | Real-time driver (rAF, frame pacing, bounded catch-up) |
| `core.ts` / `loader.ts` | Typed wrapper around the wasm core |
| `output.ts` / `input.ts` | Canvas, AudioWorklet, and pad collection |

The engine owns no timers on purpose. That is what lets the test suite drive
whole sessions through a virtual clock, at full CPU speed and reproducibly.

### The relay

`backend/src/websocket/znet-handlers.ts` plays the part ZSNES gives its netplay
server: it assigns player slots, enforces room membership, and forwards bytes.
It never parses a packet. The wire format lives entirely on the client and is
tested without a server, so there is no second copy to drift out of agreement.

Going through the server rather than WebRTC costs one hop of latency and buys a
connection that always establishes. The input delay already absorbs latency; it
cannot absorb a peer connection that never forms.

## Testing

Everything below runs in plain node — no browser, no dev server, no ROM
required for the first two suites.

```bash
npm run test:netplay   # netcode + relay; no wasm, no ROM needed
npm run test:core      # the real emulator; needs ./core/build.sh and a ROM
npm run test:all
```

**`core/test/netcode.test.ts`** runs the real engine and the real protocol
against `FakeCore`, a toy deterministic machine. 35 tests covering the wire
format, lockstep under 5% loss and 60ms of jitter, input-delay behaviour,
desync detection from either side, epoch handling, savestate retransmission,
and recovery from a total blackout.

**`core/test/relay.test.ts`** starts a real socket.io server running the real
backend handler and pushes a whole netplay session through it.

**`core/test/determinism.test.ts`** and **`lockstep.test.ts`** need the built
core. They check that two wasm instances fed the same pads stay bit-identical
for thousands of frames, that a savestate round-trip reproduces the same
future, that the entropy shims are actually linked in, that SRAM survives a
resync, and that the core really renders a picture and emits audio. They look
for a ROM in `backend/roms/` or at `PSNES_TEST_ROM`, and skip cleanly when
there is none.

**`e2e/znet-relay.spec.ts`** covers the relay against the running stack (see
`e2e/README.md` for the prerequisites).

Six real bugs were found by these tests, all before anything ran in a browser.
Three would have hung a session permanently:

1. A session **deadlocked permanently** after a network outage. Both peers
   stalled, neither advanced a frame, so neither generated a new pad packet —
   and the packet the other was waiting for had already been sent and lost.
   Fixed by re-sending pending pads while stalled.
2. That re-send used the ordinary redundancy window, which can be shorter than
   the input delay. A peer may legitimately sit `inputDelay + 1` frames behind,
   so with a high delay the re-send never reached the frame the peer was stuck
   on and the deadlock survived the fix. Now it covers the whole reachable
   range.
3. A **late duplicate savestate chunk** dropped a *running* guest back to
   `syncing`, to wait for chunks the host had already stopped sending. State
   adoption is now idempotent: a straggler is answered with another ack.
4. The session parameters travelled in their own message, which jitter could
   deliver *after* the savestate they configured. The guest then primed the
   wrong startup frames and hung. Fixed by folding them into the state message.
5. The entropy shims declared `time()` as returning `long`. `time_t` is 64-bit
   on wasm32 and `long` is 32-bit, so the module linked cleanly and then failed
   wasm validation — callers stored an i64 where the shim returned an i32.
6. Peer-reported desyncs were not counted, so the statistics showed a resync
   with no cause.

Each of the first three has a regression test that was confirmed to fail
against the unfixed code.

## Status

Running in production as the default mode for new rooms, and playable end to
end. 53 tests, none skipped - 42 for the netcode and the relay, 11 against the
real wasm core: two independent wasm instances stay bit-identical for 1800 frames
of pseudo-random two-player input, and full sessions over a simulated 150ms /
60ms-jitter / 5%-loss link never diverge.

Known limits:

- **Two players only.** The protocol carries a player index and the core
  exposes two controller ports; multitap would need both extended.
- **The input delay is chosen once per epoch.** It comes from a real
  measurement, but one taken during the handshake, so a link that improves
  mid-match keeps paying the handshake's price. Adapting it while running needs
  a signal this engine does not have yet, and the obvious candidate is a trap:
  `stats.stalls` cannot serve, because in lockstep one peer leads and the other
  follows, so the follower stalls constantly on a perfectly healthy link while
  the leader never stalls at all. Measured on a 30ms link, the guest logged 494
  stall episodes over ten seconds and the host zero. The signal that does mean
  something is the sustained frame rate, since the pair can only hold 60fps when
  the two delays cover the round trip between them.
- **A hidden window keeps emulating** by design, driven by a worker timer,
  because a paused peer freezes its partner. That is a deliberate departure
  from what a solo emulator should do.

Unresolved: during one production freeze the host's resync acknowledgement
never arrived. A watchdog now restarts the handshake rather than wedging, so
the symptom is recoverable, but the cause was never found. `__znetStats()` and
the per-second `netplay` log line are the way in if it recurs.

## What it took to get there

The netcode was the easy half. Ten bugs were fixed along the way, most of them
pre-existing and unrelated to netplay:

- `vite build` had been failing on main - production could not be rebuilt at
  all - because `@vite-pwa/sveltekit` claimed the service worker under
  workbox's `injectManifest`.
- Direct visits to `/room/<id>` always bounced to the library, so every shared
  invite link and every mid-lobby refresh was broken.
- A dropped socket removed a player immediately, destroying rooms mid-game.
- ROMs from Drive are served as `.zip`, which the lockstep core does not
  refuse: it runs at a full 60fps and renders black.
- `.mjs` has no entry in nginx's mime.types, so the core module was rejected as
  `application/octet-stream` - and an `immutable` cache header, added in the
  same change that fixed the MIME type, pinned the broken copy for a year.

The lesson worth keeping: the last three of those were diagnosed in two log
queries, after client telemetry started reaching the server. The ones before it
took an evening of guessing each. Build the observability first.
