# Solo on znet — verification record

Companion to `docs/superpowers/specs/2026-08-20-solo-on-znet-design.md` and
`docs/superpowers/plans/2026-08-20-solo-on-znet.md`.

`SoloSession` is fully unit-tested. `SoloRoom.svelte` is not testable in this
repo — no WebGL context under Node, no browser harness that loads a ROM — so
this file separates what was actually checked from what still needs a human at
a keyboard. A record that blurs the two is worse than none.

## Verified mechanically

| Check | Result |
|---|---|
| Unit suite | **203 passing, 0 failing** — 37 netplay, 11 core, 89 ui, 66 backend. Baseline at the branch point was 194; the 9 new tests are 1 governor-contract test and 8 for `SoloSession`. |
| `svelte-check` | **0 errors, 19 warnings in 10 files.** One warning fewer than mid-branch, because Task 4 consumed the `gameId` prop that Task 3 had left unused. |
| Production build | `npm run build --workspace frontend` succeeds. |
| No timers in the session | `grep -nE "requestAnimationFrame\|setTimeout\|setInterval\|performance\.now\|Date\.now" frontend/src/lib/znet/solo.ts` returns **nothing**. Run by the implementer, the task reviewer and the controller independently. |
| The widening bites | Reverting `FrameGovernor`'s field to the concrete `NetplaySession` makes `svelte-check` fail. Restoring the interface returns it to 0 errors. |
| The governor test can fail | Commenting out the governor's `pump()` call turns the run to 0 passed / 1 failed; restoring it returns to 1 passed. Three consecutive runs before that were identical, so the test's global stubbing does not leak. |

### The bundle check, and a claim I had to withdraw

Searching the built client bundle in `frontend/build/_app/immutable/` confirms
`SoloRoom` ships: its battery-save notice text and its `Menu (Esc)` label are
both present, in the route chunk. `SoloSession` itself does not appear by name
because minification renames classes — string literals survive, identifiers do
not, so strings are the only useful probe here.

**What the bundle does not prove**, and what I initially got wrong: the
"LATENCE" panel is still in the shipped bundle. My first grep searched for the
uppercase form and found nothing, which looked like proof the panel was gone.
It is not — the source writes `Latence` and CSS uppercases it, and searching
the real string finds it in two files.

That is correct and intended. `ClientEmulator` still exists, because dual and
streaming still use it and this plan deleted nothing. What changed is not the
bundle's contents but the **routing**: the room page's single-player branch now
renders `SoloRoom`, so solo never reaches `ClientEmulator`. That is proven by
the render branch in `frontend/src/routes/room/[id]/+page.svelte`, where
`EmulationMode.SINGLE` is matched before `LOCKSTEP` and the `{:else}` P2PRoom
branch is untouched — not by anything a grep of the artefact can show.

Worth stating plainly because the wrong version of this claim is more
convincing than the right one.

## What the fix loops caught, and why it matters here

Task 4 needed three fix rounds, all on the same function, and the defect was
data loss each time. It is recorded because the same trap will be there for
whoever edits it next.

`persistSram()` writes the emulated machine's SRAM back to the server. That is
the **in-game** save — what a player writes from the cartridge's own menu — so
losing it is losing real progress, not a preference.

The hole was that `persistSram()` could run before `loadSram()` had succeeded,
writing the blank SRAM a freshly-loaded ROM starts with over the server's good
copy. Closing it took three attempts:

1. No guard at all: closing the room during `loadSram()`'s round trip
   destroyed the save.
2. A `sramLoaded` flag — set after the `try/catch`, so a payload `atob()` could
   not decode still counted as a successful read and still permitted the
   overwrite.
3. The flag set inside the `try`, on the applied-data path and on the
   server-says-none path, and by nothing in the `catch`.

Every attempt looked right to whoever wrote it, and twice the mistake was about
**where** the flag was set rather than what it meant. So the invariant is now a
comment on `loadSram` naming what the flag asserts, which of its paths may set
it, and that `persistSram` trusts it completely. The final review verdicted
that comment useful rather than decorative, and enumerated all seven paths
through the function to confirm the rule holds on each — including that "the
handler arrives after the timeout" is unreachable by construction, because the
timeout deregisters the handler before resolving.

The rule, if it needs restating: **never write back what you did not
successfully read.**

## Not verified — needs a human, a ROM, and a GPU

None of this has been done.

- [ ] **A solo game plays, with sound.** The basic claim.
- [ ] **No "LATENCE" panel.** This is what the report that started this work
      was about. It should be absent because solo no longer renders
      `ClientEmulator` at all — not because anything was deleted.
- [ ] **The toolbar is there**: fullscreen, scanlines, sharp/smooth,
      fit/stretch, shader, and `☰ Menu (Esc)`.
- [ ] **Alt+Enter toggles fullscreen**, which the tooltip has been promising.
      It was wired only in the last fix round.
- [ ] **Escape opens the pause menu, and the game actually pauses.** Solo stops
      the governor, which lockstep deliberately does not — stopping its clock
      would freeze the peer. Confirm the picture and the sound both stop, and
      that resuming does not produce a burst of catch-up frames. `start()`
      resets its clock, so it should not, but this is the check for it.
- [ ] **Saving from the pause menu produces a thumbnail**, and loading restores
      the state.
- [ ] **The battery save survives a round trip.** Save inside a game from its
      own menu, leave the room, come back, and confirm it is still there. Given
      the history above, this is the single most important item on this list.
- [ ] **A failed battery-save read says so and then saves nothing.** Hard to
      force deliberately; if you can block the socket or make the server return
      a malformed payload, confirm the notice appears and that leaving the room
      afterwards has *not* replaced the server's copy with a blank one.
- [ ] **Shaders work in solo**, with the fallback notice when one cannot load.
      Expect the same limitation the WebGL work documented: the three xBRZ
      presets do real work, and `sharp-bilinear-simple` and `fxaa` are limited
      by the final pass running at source size.
- [ ] **Two physical gamepads.** The open question the spec refused to settle
      from code. RetroArch's config maps a second pad to player 2, so the old
      solo path may have supported couch co-op; `InputCollector` reads one
      source, so this migration would have lost it. Plug two in, check whether
      the *old* path drove player 2 — a dual-mode room, or the previous commit
      — and write the answer down either way. `SoloSession` takes a pad pair
      precisely so that adding a second reader later changes one line.

## Deferred minor findings, for triage before merge

- `SoloRoom.svelte` — the battery-save notice string is duplicated verbatim at
  two sites rather than shared, and on the decode path its wording says "could
  not read from the server" where the server did in fact answer. Imprecise, not
  wrong.
- `SoloRoom.svelte` — `persistSram`'s base64 encode builds its string one
  character at a time rather than chunked as `LockstepRoom` does. Harmless at
  SNES SRAM sizes.
- `solo.ts` — its doc comment states the couch-co-op question is untestable
  here. Honest hedging; worth a human sanity check if it turns out to matter.
- No test uses a longer or randomised pad sequence. The four-pad test already
  discriminates on drop, duplicate and reorder, so this is marginal.
- `frontend/src/routes/room/[id]/+page.svelte` — solo now stops the governor on
  pause while `LockstepRoom` detaches input instead. That divergence is
  deliberate and explained in both components, but the two files now differ in
  three ways (this, `collector.detach()` on teardown, and the boot guard) and
  the follow-up that shares their common code should reconcile all three at
  once rather than piecemeal.

## Known divergence from LockstepRoom, deliberate

`SoloRoom` does three things `LockstepRoom` does not, and none of them should be
"reconciled" by copying the older component:

- **It detaches its input collector on teardown.** `LockstepRoom` calls
  `attach()` and never `detach()`, so its window keydown/keyup handlers outlive
  the room. That is a pre-existing leak, reported separately, not a convention.
- **It guards `boot()`'s continuations with a `destroyed` flag.** Without it, a
  room destroyed mid-await resumes on a dead closure and builds a fresh
  governor, audio sink and input collector that nothing can ever stop — because
  the only `teardown()` already ran. `LockstepRoom` has the same hole.
- **Its pause really pauses.** Lockstep cannot stop its clock without freezing
  the peer. Solo has no peer.
