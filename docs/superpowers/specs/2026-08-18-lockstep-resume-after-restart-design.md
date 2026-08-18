# Resuming a lockstep game after the server restarts

## The problem

A backend restart — a deployment, a crash — freezes every lockstep game
permanently. The picture stops, a message appears telling the player to reload,
and reloading sends them to the lobby.

There is no single cause. Three independent failures stack up, and each one
alone is enough to make the game unrecoverable.

**1. The client stops trying to reconnect.** `frontend/src/lib/api/socket.ts`
sets `reconnectionAttempts: 10`, with the delay capped at socket.io's default
5 s. Socket.io therefore gives up after roughly 30 to 60 seconds and never
retries. The production deploy measured on 2026-08-18 took 1 min 19 s on the
VPS step alone.

**2. The server loses every room, and no reconnection can repair that.**
`backend/src/websocket/index.ts:17` holds rooms in `const rooms = new Map<string,
Room>()`. They are in neither the database (there is no `Room` model in
`backend/prisma/schema.prisma`) nor Redis (which backs Express sessions only).
A restart erases all of them. So even once the socket returns —
`SocketTransport` does re-emit `znet:join` on `connect` — `getMemberRoom` no
longer finds the room and **returns `null` silently**: no `znet:joined`, no
channel join, and every subsequent packet is dropped by
`if (!joined.has(room.id)) return`. The session is dead with a healthy socket.

**3. The advice on screen cannot be followed.** After `SILENCE_MS` (15 s) the
session reports "Lost contact with the other player. Reload to rejoin."
Reloading lands on a room that no longer exists and redirects to the lobby
(`frontend/src/routes/room/[id]/+page.svelte:160`).

### What already works

The hard part is written. `tick()` re-sends its own pending pads every
`stallResendEvery` (8) stalled ticks over a deliberately wide window
(`frontend/src/lib/znet/session.ts:455-465`), for exactly this reason: to break
a deadlock where the pad the peer waits for was sent once and lost. Both peers
are frozen on the same frame, because lockstep cannot advance without the peer.
So **once the relay is back, the game resumes on its own** — no resync, no
savestate exchange. `session.ts:807` additionally handles a peer that restarted
outright, with the host reseeding from its authoritative state.

### The bug that is not about the server at all

`handleMessage` clears `reportedSilence` on any incoming packet
(`session.ts:736-737`) but **emits no event**, so nothing tells the UI. Meanwhile
`LockstepRoom` has already set `phase = 'error'`, a state nothing ever leaves.

**Any outage longer than 15 seconds therefore kills the display for good, even
though the netcode recovered.** A plain 20-second network blip is enough. This
is likely most of the reported "never resumes", and it is fixed independently of
any server work.

## Goals

- A lockstep game in progress survives a backend restart and resumes where both
  machines left off, without either player reloading.
- No outage — server or network — can leave the UI permanently stuck when the
  session underneath has recovered.
- When recovery is genuinely impossible, the player is told why and gets a way
  out, instead of a frozen picture.

## Non-goals

- **Resuming dual and streaming modes.** Room persistence benefits every mode,
  since the lobby and the room itself come back. But those modes negotiate
  WebRTC through the server as a signalling channel, and dual mode has no
  authoritative savestate to adopt, so resuming them is separate work. They fall
  back to an honest message.
- **Multiple backend instances.** Production runs one backend container
  (`docker-compose.prod.yml`). The design does not attempt to make room state
  shareable between processes, only to make it survive one process being
  replaced.
- **Surviving a hard kill without loss.** A `SIGKILL` or an OOM may lose the
  last second of room state — one player's `isReady` flag. That is acceptable;
  see "Approach" below.

## Approach

Rooms are persisted by **snapshotting the whole `Map` to Redis** — on a short
interval, and on graceful shutdown — and restoring it at boot.

The alternative was write-through persistence via a `RoomStore` whose setters
write to Redis. It is exact even under a hard kill, and it is the path to
multiple instances. It was rejected: room state is mutated in place at 28 sites
across 5 files, including nested mutations such as
`room.players[0].isReady = true`, and the compiler cannot flag a site that was
missed because the object stays perfectly well typed. The failure mode is a
silently stale room, which is more insidious than the freeze being fixed, and
the multi-instance benefit is one we do not currently have.

Snapshotting the live Map instead means **no mutation site is instrumented at
all**, so none can be forgotten.

The keystone is the shutdown flush. **A deployment is a graceful shutdown**:
Docker sends `SIGTERM` and waits 10 s by default. For the case that motivated
this work, the snapshot is therefore exact rather than best-effort. The interval
only covers a hard crash.

Rebuilding a room from what the reconnecting client claims was also considered
and rejected: `backend/src/websocket/guards.ts` exists precisely because room
ids are handed out by `GET /api/rooms` and by friend notifications, so trusting
a client's own claim of membership would be a security regression.

## Design

### A. Room state that outlives the process

**`backend/src/db/redis.ts` (new)** owns the Redis client, mirroring the
existing `backend/src/db/prisma.ts`. Today `backend/src/index.ts` creates the
client locally and does not export it; extracting it gives one place that knows
how to connect and avoids an import cycle, since `index.ts` already imports the
websocket layer. `index.ts` and the Express session store both consume it from
there.

**`backend/src/websocket/room-snapshot.ts` (new)** owns persistence of the
`rooms` Map, which `backend/src/websocket/index.ts` already exposes via
`getRooms()`.

- `restoreRooms(rooms)` — called before `httpServer.listen`. Reads the single
  key `psnes:rooms:v1`, parses it, revives `createdAt` into a `Date` (JSON
  renders it as a string), discards rooms with no players, and arms the
  departure grace period for every restored player.

  That last step is what prevents phantom rooms. `DISCONNECT_GRACE_MS` is
  already 45 s and `scheduleLeaveRoom` already removes a player who does not
  return, so a restored room that nobody reclaims dies exactly as it would have
  had the server never restarted. This needs a variant of `scheduleLeaveRoom`
  that takes no socket, since on restore there is none; it must reuse the same
  timer map and the same `cancelScheduledLeave` path, so a returning player's
  seat is held by the mechanism that already exists.

- A periodic snapshot, every 1000 ms: serialise the Map, compare against the
  last string written, and write only on a difference. The key is written with a
  one-hour TTL — a backstop so a long outage cannot resurrect a stale world. In
  practice the 45 s grace period destroys an abandoned room long before the TTL
  matters.

- `flushRooms(rooms)` — awaited from a `SIGTERM`/`SIGINT` handler. There is no
  shutdown handler in the backend today. It must be idempotent (a second signal
  must not start a second flush), and the sequence is: stop the interval, flush,
  close the HTTP server, quit Redis, exit.

**Not persisted**, deliberately: the netplay slot map `roomSlots`, presence,
pending departure timers, and per-room checksums. Every one of them is
socket-scoped and is rebuilt by the clients themselves, which already re-emit
`room:join` (`frontend/src/routes/room/[id]/+page.svelte:130`) and `znet:join`
(`frontend/src/lib/znet/socket-transport.ts`) on `connect`. Persisting a
`socketId` that no longer exists would be worse than persisting nothing.

**Snapshot format.** A JSON object `{ version: 1, savedAt: <ISO string>, rooms:
[Room, ...] }`, stored under `psnes:rooms:v1`. The version field is checked on
restore and a mismatch is discarded rather than coerced: an old snapshot read
into a changed `Room` shape is how a restart turns into a subtly corrupt lobby.

### B. A client that keeps trying

`reconnectionAttempts` becomes `Infinity`, keeping the 5 s ceiling between
attempts, so the client retries every five seconds for as long as the tab is
open.

An endless retry has to be visible, or the player is left staring at a frozen
picture with no idea whether anything is happening. A store
`frontend/src/lib/stores/connection.ts` exposes the link state as
`'connected' | 'reconnecting'` — two states, since with an unbounded retry
there is no third one to be in — and
`+layout.svelte` renders a discreet banner from it — at the same cost this
serves every page rather than the room alone.

**A prerequisite fix.** `frontend/src/routes/room/[id]/+page.svelte:171` calls
`$socket.off('connect')` with no handler, which removes *every* `connect`
listener on the socket, including ones registered elsewhere. A connection store
subscribing to `connect` would be silently destroyed the first time a player
leaves a room. Those `off` calls must pass their handlers so they remove only
their own listeners.

### C. A screen that can come back

Prolonged silence currently travels on `type: 'error'`, the same channel as a
genuinely fatal failure — a ROM mismatch, an incompatible protocol version —
which `fail()` emits and which must *not* be recoverable. The two are split:

- `SessionEvent` gains `link-lost` and `link-restored`. Silence emits
  `link-lost`; the point in `handleMessage` that already clears
  `reportedSilence` emits `link-restored`. `SILENCE_MS` stays at 15 s.
- `type: 'error'` keeps its current meaning: terminal.
- `LockstepRoom` tracks link loss as its own flag and **stays in
  `phase = 'playing'`**, showing an overlay over the last frame rather than
  swapping in the terminal error screen. Recovery is then just clearing the
  flag, with no phase juggling.
- The wording changes. "Reload to rejoin" is bad advice: reloading lands on a
  room that may not exist. It becomes a statement of what is happening and what
  will happen by itself — the connection is lost, play resumes as soon as it is
  back.

### D. A relay that answers instead of going quiet

`znet:join` on an unknown room returns `null` silently, which is what makes the
freeze permanent even with a live socket. It will emit `znet:error` carrying a
machine-readable `code` (`room-gone`), so the client can tell it apart from the
existing `session-full` case.

This must fire **only when the room is absent**, never when the room exists and
the caller is not a member. `getMemberRoom` currently collapses both into
`null`; the distinction has to be made at the call site so an authorization
rejection stays as silent as it is today and does not become a probe that
confirms a room id exists.

`znet:error` turns out to have **no listener on the client at all** — the
existing "this netplay session is full" case is itself a silent freeze today.
`LockstepRoom` will listen, show a real message, and offer a way back to the
lobby. This is the safety net for when persistence cannot help: a crash before
the first snapshot, or an expired TTL.

### E. Re-entering a game after a reload

This goes slightly beyond the literal request and was called out for that
reason; it was reviewed and kept. `gameStarted` in `frontend/src/routes/room/[id]/+page.svelte` is only set
by the `game:started` event, so reloading the tab during a match shows the
room's lobby view rather than the game, even when `room.status` is `playing`.

With rooms persisted, honouring `room.status === 'playing'` on join makes a
reload — or a closed tab, or a browser crash — a working recovery path too,
and it reuses the mid-session rejoin already designed for it: "A HELLO arriving
mid-session means the peer restarted — it reloaded" (`session.ts:807`), where
the host reseeds the returning peer from its authoritative state.

Kept, decided at review on 2026-08-18: without it, recovery works only if the
tab survived.

## Failure modes

| What happens | Result |
|---|---|
| Graceful restart (deploy) | Flush on `SIGTERM` is exact; clients reconnect within ~5 s; pads re-send; play resumes. |
| Hard kill (OOM, `SIGKILL`) | Up to 1 s of room state lost — a readiness flag. The game still resumes. |
| A player does not return within 45 s of restore | The grace period removes them, exactly as it would without a restart. If that empties the room it is destroyed, and a later `znet:join` answers `room-gone`. Note the clock starts at restore, and the client retries every 5 s, so this is the closed-tab case rather than the slow-deploy case. |
| Redis unavailable at boot | Restore fails; log and start empty. The app works, in-progress games do not resume. Redis is already a hard dependency for sessions. |
| Redis unavailable at runtime | Snapshot writes fail and are logged; nothing else is affected. |
| Snapshot from an older `Room` shape | Version mismatch discards it. Start empty rather than corrupt. |
| Network blip under 15 s | Unchanged: the stall badge appears, play resumes. |
| Network blip over 15 s | `link-lost` overlay, then `link-restored` clears it. Previously fatal. |
| ROM or protocol mismatch | Still terminal, as it must be. |

## Testing

- **`room-snapshot`**, unit, in the repo's existing style (`node --import tsx
  --test`, run from `core/test/` where frontend and backend modules are already
  tested) against a fake Redis client: round-trip of a populated Map, `Date`
  revival, empty rooms discarded, version mismatch discarded, grace armed per
  restored player, and the "unchanged means no write" rule.
- **Session**, in `core/test/netcode.test.ts`, which already drives real
  sessions over a harness: silence produces `link-lost`, resumed packets produce
  `link-restored`, and a fatal `fail()` produces `error` and is *not* followed
  by any recovery event.
- **The relay**, in `core/test/relay.test.ts`, which already stands up a real
  socket.io server around `registerZnetHandlers` and drives it with a real
  `SocketTransport`: `znet:join` on an absent room answers `znet:error` with
  `code: 'room-gone'`, and a caller who is not a member of a room that *does*
  exist still gets silence. That second assertion is the one that matters —
  it is what keeps the new error from becoming a way to confirm a room id.
- **Shutdown**: the flush is idempotent and a second signal does not double-run
  it.
- **End to end**: not claimed. Restarting the backend from Playwright is not
  something this suite can do reliably, so it will not be pretended. The real
  validation is a deployment during a live match — which, once this is in place,
  is a test that can be repeated at will.

## Files

New:

- `backend/src/db/redis.ts`
- `backend/src/websocket/room-snapshot.ts`
- `core/test/room-snapshot.test.ts`
- `frontend/src/lib/stores/connection.ts`

Changed:

- `backend/src/index.ts` — consume the extracted Redis client, restore before
  listen, add the shutdown handler.
- `backend/src/websocket/room-handlers.ts` — a socket-less variant of
  `scheduleLeaveRoom` for restored players.
- `backend/src/websocket/znet-handlers.ts` — answer `znet:join` on an absent
  room.
- `frontend/src/lib/api/socket.ts` — retry forever, feed the connection store.
- `frontend/src/lib/znet/session.ts` — split recoverable link loss from fatal
  error.
- `frontend/src/lib/components/LockstepRoom.svelte` — recoverable overlay,
  `znet:error` handling.
- `frontend/src/routes/+layout.svelte` — the connection banner.
- `frontend/src/routes/room/[id]/+page.svelte` — targeted `off()` calls; and,
  if section E is kept, re-enter a game whose status is `playing`.
- `core/test/netcode.test.ts` — link-loss events.
