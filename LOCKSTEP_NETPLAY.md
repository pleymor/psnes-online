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
  handshake, taking the fastest sample and discarding the single worst - a
  session's first ping carries the socket and the relay waking up, reads far
  above the link, and sizing on it alone priced every match for a latency that
  never came back. On top of the trip go **two frames of margin at minimum**,
  plus the measured spread when it asks for more.

  That floor is not caution, it is a measured requirement, and it was removed
  once by mistake. The spread looked like a principled replacement for it, but
  the spread is gathered over a 300ms burst during the handshake and cannot see
  how the relay delivers under play: pads do not arrive one per frame down a TCP
  relay, they arrive in clumps. A production session sized without the floor held
  0 to 2 frames of the peer's pads and stalled 24 times a second; the same
  session at two more frames of delay held 5 and stalled not at all. The margin
  is the buffer that absorbs a clump.
- A frame does not run until **every** player's pad for it has arrived. If a
  packet is late, the emulator waits. There is no prediction and no rollback.
- Frames `0..D-1` are primed with neutral pads on both sides: nobody could have
  sampled input for them.
- Each pad packet repeats the last few frames the sender already transmitted.
  A dropped packet then costs nothing, where asking for a retransmit would cost
  a full round trip with both peers stalled.
- Each pad packet also carries one byte of **strain**: how many of the sender's
  last 128 frames arrived late. A peer that is losing frames cannot fix it
  itself, because what keeps its frames on time is its *partner's* delay
  arriving early enough. So it reports, and the partner adds a frame. One-way
  only: this never lowers a delay.
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

Neither delay has to cover the one-way trip by itself, so on a steady link
input latency is a budget the two players can split unevenly. But the sum is
only half the model, and taking it for the whole of it leads to a bad setting.

**The sum governs throughput; each delay separately governs how much jitter the
*partner* can absorb.** A peer holding one frame of lead sends its pads 17ms
before they are needed, so any jitter makes them late - and the peer waiting on
them is the one that stutters, not the one that saved the latency. Whoever takes
the small half does not pay for it; their partner pays, in late frames.

Measured on the real core with Super Mario World, twenty-second windows against
an 8/8 reference that is clean in every condition, one network seed per
condition so the splits are comparable:

| link | sum that suffices | lopsided split |
|---|---|---|
| 60ms RTT, 3ms jitter | 4 | **works** - 1/5 and 1/3 clean, short end feels 17ms |
| 60ms RTT, 12ms jitter | ~8 | **fails** - 4/4 clean, 1/7 drops 250-273 frames late |
| 90ms RTT, 3ms jitter | 6 | **works** - 1/5 clean, short end feels 17ms |
| 90ms RTT, 20ms jitter | over 8 | **fails** - nothing under 8/8 is clean |

The 4/4-versus-1/7 comparison held across five seeds: the even split was clean
on three of them and mildly lumpy on two, while the lopsided one lost 250 or
more frames on every single seed with a worst gap of 40ms each time.

So **jitter sets the delay, not latency**. Holding the round trip at 60ms and
moving jitter from 3ms to 12ms more than doubles the delay the pair needs. That
is also the strongest argument for a peer-to-peer data channel: TCP
retransmission is a jitter source, and the relay runs over socket.io. Removing
that jitter is worth more than the hop it also saves.

Which is why the stats panel shows it next to the round trip. It cannot come from
the ping - one sample every two seconds says nothing about variation at frame
scale - so it is measured over the pad stream instead, the way RFC 3550 computes
interarrival jitter for RTP: the running mean of how far each packet's spacing
departs from the spacing it was sent with. Pad packets are the right carrier,
because the peer emits one per frame it runs and each names the frame it belongs
to, which gives the intended spacing with no clock to synchronise. Only packets
whose newest frame has advanced are timed; every pad packet repeats recent frames
and the engine re-sends the whole reachable range while stalled, so timing the
rest would measure the re-send policy rather than the link.

Read it as a monotone index, not a calibrated peak. Against a simulated link it
reports roughly half the peak deviation and flattens out at the top:

| link jitter | reported |
|---|---|
| none | 0.5ms |
| ±5ms | 2.7ms |
| ±10ms | 5.8ms |
| ±20ms | 8.4ms |
| ±40ms | 13.8ms |

In the terms above, a reading under about 2ms is a link where a lopsided split is
safe; past about 6ms, keep the split even and give the pair more total delay.
Packet loss also raises it, which is correct: from the receiver's side, a pad
whose replacement arrives later is indistinguishable from a late one.

`NetplaySession.setInputDelay()` sets one peer's delay and needs no agreement
from the other: pads are keyed by absolute frame, so past the priming window the
delay governs nothing but how far ahead a peer samples its own input. Tests hold
two different delays over 90ms and 200ms links and check the machines stay
bit-identical. The manual floor is one frame where the automatic one is three -
the automatic value is symmetric and has to be safe for both peers at once,
while a hand-set value is somebody deliberately spending their partner's
headroom, which the table above says to do only on a quiet link.

Note also that a *constant* latency above `D` costs a one-off offset between the
peers rather than frame rate. Only jitter stalls.

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
| `lag-transport.ts` | Decorator that adds simulated distance to a real transport |
| `governor.ts` | Real-time driver (rAF, frame pacing, bounded catch-up) |
| `core.ts` / `loader.ts` | Typed wrapper around the wasm core |
| `output.ts` / `input.ts` | Canvas, AudioWorklet, and pad collection |

The engine owns no timers on purpose. That is what lets the test suite drive
whole sessions through a virtual clock, at full CPU speed and reproducibly.

### Three attempts at one control loop

Sizing the delay from a measurement is easy. Adjusting it while playing took
three tries, and the first two failed the same way: they read a number that
measures the follower's ordinary position rather than its distress. In lockstep
one peer always runs at the edge of the other's production, so on a *flawless*
link the follower's counters look alarming.

| signal | why it failed |
|---|---|
| `stats.stalls` | The follower logged 494 stall episodes in ten seconds on a 30ms link while the leader logged zero. The loop walked the delay down while latency climbed. |
| `padsAhead` depth | Same trap, one layer in: the follower legitimately holds ~0 frames of its partner's pads because it has consumed them. A healthy session crept to the ceiling. |
| late frames | Works. Measured against a deliberately generous split the follower lost **no** frames while its stalled-tick count ran into the thousands; a genuinely tight split on a jittery link lost 26 per 128-frame window. |

The discriminating question turned out to be not "is this peer waiting" - it
always is - but "are its frames arriving on time". A frame gap wider than 1.5
times the machine's own frame is a stutter a player sees, and that is what
travels in the `strain` byte. `npm run measure:splits` counts the same thing
offline, deliberately, so the two agree.

The loop only raises, and each raise demands twice the evidence of the last.
That asymmetry is the honest trade rather than caution: a frame too generous
costs 17 to 20ms of input latency, and a frame too tight costs the *other*
player several visible stutters a second.

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
against `FakeCore`, a toy deterministic machine. 48 tests covering the wire
format, lockstep under 5% loss and 60ms of jitter, input-delay behaviour,
desync detection from either side, epoch handling, savestate retransmission,
and recovery from a total blackout.

**`core/test/relay.test.ts`** starts a real socket.io server running the real
backend handler and pushes a whole netplay session through it.

### Feeling it locally

Two windows on one desktop reach the relay over loopback, so a local session
runs at a latency no real pair will ever see. That leaves the one question the
test suite cannot answer - how the game *feels* at a given input delay, and
whether a lopsided split beats an even one - needing a second house.

`?lag=ping[,jitter[,loss]]` on the room URL fixes that. It wraps the real
transport, so the real socket.io path, the real backend and real TCP are all
still in play, and adds the distance on top. **Half the ping is spent on each
one-way hop**, which is not an approximation: a pad travels `me -> relay ->
peer`, so its trip costs my half plus my partner's half, and each window
injecting its own half in both directions makes the round trip the session
measures come out at `ping_mine + ping_theirs` - exactly what the relay gives
you in production.

```
window 1:  /room/<id>?lag=30
window 2:  /room/<id>?lag=30,8      # 8ms of jitter on top
```

That pair reproduces a 60ms round trip, so the estimator sizes three frames and
`__znetDelay` can then be used to try splits against it. A parameter rather than
a console call because the delay is sized during the handshake; anything set
afterwards is too late for the number that matters. A malformed value is refused
outright and leaves the session on the real link - a session quietly running on
a different link than you configured invalidates every conclusion drawn from it.

**`core/test/determinism.test.ts`** and **`lockstep.test.ts`** need the built
core. They check that two wasm instances fed the same pads stay bit-identical
for thousands of frames, that a savestate round-trip reproduces the same
future, that the entropy shims are actually linked in, that SRAM survives a
resync, and that the core really renders a picture and emits audio. They look
for a ROM in `backend/roms/` or at `PSNES_TEST_ROM`, and skip cleanly when
there is none.

**`e2e/znet-relay.spec.ts`** covers the relay against the running stack (see
`e2e/README.md` for the prerequisites).

### Measuring, as opposed to testing

`npm run measure:splits` asserts nothing. It answers the question a player asks
instead of the one a test asks: not "does it stay in sync" but "does the picture
hold steady". `stats.stalls` cannot say, because the follower waits by
construction and its counter climbs on a healthy link, so this stamps every
executed frame with the clock and counts the gaps wider than 1.5 frame times.

Two details it took a wrong answer to learn. It uses **one network seed per
condition**, because a seed per row compares splits over different networks and
makes noise look like a finding. And it prints a **generous 8/8 reference first**,
so that lumpiness present at any delay is not attributed to the split under test.
`-- --seeds` runs one split pair over five networks, which is what settled the
even-versus-lopsided question above.

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
end. 66 tests, none skipped - 55 for the netcode and the relay, 11 against the
real wasm core: two independent wasm instances stay bit-identical for 1800 frames
of pseudo-random two-player input, and full sessions over a simulated 150ms /
60ms-jitter / 5%-loss link never diverge.

Known limits:

- **Two players only.** The protocol carries a player index and the core
  exposes two controller ports; multitap would need both extended.
- **The input delay only ever goes up.** The handshake under-reads this relay -
  a session measured 66ms while sizing and then ran at a median of 81ms - so the
  strain loop exists to close that gap while playing. But it closes it in one
  direction: a link that *improves* mid-match keeps paying, and the only way
  down is `__znetDelay(n)` by hand. Lowering automatically was attempted twice
  and abandoned twice, for the reason in the next section. Adapting it while running needs
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
