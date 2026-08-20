# WebGL renderer — verification record

Companion to `docs/superpowers/specs/2026-08-20-webgl-renderer-design.md` and
`docs/superpowers/plans/2026-08-20-webgl-renderer.md`.

The spec said plainly that the GL pipeline cannot be tested in this repo: there is
no WebGL context under Node, and the existing Playwright tests never load a ROM.
This file is the compensating control. It separates what was actually verified
from what still needs a human at a keyboard, because a verification record that
blurs the two is worse than none.

## Verified mechanically

All of this was run and observed, not assumed.

| Check | Result |
|---|---|
| Unit suite | **191 passing, 0 failing** — 37 netplay, 11 core, 77 ui, 66 backend. Baseline before the branch was 165; the 26 new tests are Task 1's 20 preset tests and Task 2's 6 surface tests. |
| `svelte-check` | **0 errors, 19 warnings in 10 files** — identical to the pre-branch baseline. The 19 warnings are pre-existing CSS-compatibility notes. |
| Production build | `npm run build --workspace frontend` succeeds in 4.24s. |
| Timing constraint | `grep -nE "requestAnimationFrame\|setTimeout\|setInterval\|performance\.now\|Date\.now"` over `webgl-renderer.ts`, `preset.ts` and `shader-source.ts` returns **nothing**. Run independently by the implementer, the task reviewer, and the controller. |
| Pinned shader source | All five URLs used by the six presets return **200** at commit `468f67b6f6788e2719d1dd28dfb2c9b7c3db3cc7`. |
| Preset fixtures | The four `.glslp` files inlined in `core/test/preset.test.ts` were diffed against the real files at the pinned commit and match **verbatim**, including `sharp-bilinear-simple.glslp`'s genuine lack of a trailing newline. |

### The bundle check, which is stronger than a source grep

Greps on source prove what the source says; they do not prove what ships. Searching
the built client bundle in `frontend/build/_app/immutable/` gives a harder answer:

| String | Files in the shipped bundle |
|---|---|
| `UNPACK_ROW_LENGTH` | 1 — the zero-copy upload path is bundled, not tree-shaken away |
| `468f67b6f6788e2719d1dd28dfb2c9b7c3db3cc7` | 1 — the pinned URL ships |
| `webglcontextlost` | 1 — the context-loss listener ships |
| `outside the supported subset` | 1 — the refusal path ships |
| **`PARAMETER_UNIFORM`** | **0** |

That last row is the point. Minification strips comments, so the macro name
appearing nowhere in the shipped bundle means it exists in no string literal and
no template that could reach `gl.shaderSource`. The constraint whose violation
would produce a black picture with no compilation error is proven absent from the
artefact, not merely absent from the source.

## Risks resolved by analysis rather than by eye

The Task 4 implementer was asked to list places where a wrong result would look
like a *plausible picture* rather than an error. It named eight. Four were
settled from the real preset files, which are not checked into this repo — they
are fetched from the pinned commit at runtime, so the implementer could not
reach them and I did.

**Rounding divergence between `allocate()` and `totalScale()` — unreachable.**
`allocate()` chains roundings pass by pass; `totalScale()` multiplies the raw
factors and rounds once. They can disagree by a pixel when two or more
intermediate passes have fractional scales. All six presets were fetched: the
maximum is **one** intermediate pass, and its scale is an integer (6.0, 5.0,
4.0). The divergence has no reachable input.

**Alpha carried through intermediate render targets — impossible.** Intermediate
targets are allocated `RGBA`, and `alpha: false` governs only the default
framebuffer, so a non-unit alpha written by a non-final pass would ride into the
next pass's sampled texture and change the picture subtly. The only intermediate
passes among the six presets are the three xBRZ shaders, and all three write
`FragColor = vec4(res, 1.0)`.

**`FrameCount` wrapping unsigned into a signed uniform — benign.** `>>> 0` yields
0..2³²-1 while `uniform1i` wants a signed int, so past 2³¹-1 a shader would read
a negative value. At 60fps that needs roughly 1,136 years of one unbroken tab.
Recorded, not chased.

**No `webglcontextrestored` handler — deliberate.** Once the context is lost the
renderer stays lost and the room stays on 2D for the session. This matches the
spec's stated contract. It is listed here so that a tester who forces a loss and
then a restore knows that staying on 2D is the intended outcome, not breakage.

## Not verified — needs a human, a ROM, and a GPU

Everything below requires a real game session. None of it has been done. Each
item names what to look for, so the answer is a judgement about a specific thing
rather than a general impression.

- [ ] **The six presets render correctly.** Cycle the toolbar button through all
      seven states in a lockstep room. Three shapes must each be exercised: the
      two-pass path (any xBRZ), the `#pragma parameter` path (`crt-easymode`),
      and the plain single pass (`sharp-bilinear-simple`, `fxaa`). Look for a
      black screen, garbled output, or a wrong aspect.
- [ ] **The picture is the right way up.** This is the check I would run first.
      The `v` axis is reversed on pass 0 only; getting it wrong renders the game
      upside down. A one-pass preset and a two-pass preset must *both* be
      upright — the bug class here is one that fixes itself for odd pass counts
      and breaks for even ones.
- [ ] **Frame pacing is unchanged with and without a shader.** The decisive
      check, and more important than any screenshot. Read the netplay stats over
      ~30s with no shader, then with `crt-easymode`, then with
      `xbrz/6xbrz-linear` (the most expensive). Record the three side by side.
      If enabling a shader changes emulated frames per second, the renderer is
      influencing timing and the feature is not finished — that is the one defect
      here that could desync a game rather than merely look wrong.
- [ ] **The other player is unaffected.** Shader choice is local and never enters
      the protocol. Changing it in one window must change nothing in the other.
- [ ] **All four fallbacks are graceful.** Each must end with a visible picture
      and a notice, never a black canvas:
      no WebGL2 (launch Chrome with `--disable-gpu`);
      an unsupported preset (temporarily point `SHADER_IDS` at
      `xbrz/xbrz-freescale` and confirm the console *names* the offending
      directive — then revert);
      a fetch failure (block `cdn.jsdelivr.net` in devtools);
      context loss (`document.querySelector('canvas').getContext('webgl2')
      .getExtension('WEBGL_lose_context').loseContext()`).
- [ ] **A resolution switch survives.** Play something that opens a
      high-resolution menu with a shader active. A fixed-size texture shows noise
      here; the reallocation path is what prevents it.
- [ ] **The notice does not collide with the other badges.** `shaderNotice` has no
      auto-dismiss. Confirm it does not overlap the link-lost or stalling
      indicators.
- [ ] **The per-emulated-frame draw does not visibly stutter.** `draw()` is called
      once per *emulated* frame, not per displayed frame, so after a network
      stall the governor can run up to 8 in one animation-frame slice and the
      pipeline runs 8 times for one visible frame. This is pre-existing 2D
      behaviour made more expensive by xBRZ 6x. It cannot desync — the governor
      caps and the accumulator absorbs it — but it can stutter. Record numbers if
      seen; do not fix it here, because the fix touches the 2D path too and is
      outside this spec.

## Deferred minor findings, for triage before merge

Recorded during review, none fixed:

- `preset.ts` — the module doc says "no globals" while `resolveShaderUrl` uses the
  global `URL` constructor. Wording.
- `preset.ts` — `SUPPORTED_DIRECTIVES` holds the literal `'shaders'` in the same
  list used as the prefix table for indexed directives, so a hypothetical
  `shaders2` key would be accepted as base `shaders` rather than refused. No real
  preset has such a key. **The most substantive of these.**
- `preset.ts` — the no-`=`-in-line branch is unexercised by any test.
- `core.ts` — the `videoSurface` doc says the consumer "must skip the padding
  itself"; with `UNPACK_ROW_LENGTH` set, GL does the skipping.
- `shader-source.ts` — `Promise.all` over passes is fail-fast; worth a comment
  saying partial results are never surfaced.
- `shader-source.ts` — `presetUrl` does not normalise its id, so a stray slash
  would produce a double slash rather than an explicit rejection. Unreachable
  from the six fixed ids.
- `webgl-renderer.ts` — `DisplayOptions.shader` is stored by `setOptions` but never
  read by the class; shader changes require constructing a new renderer. Nothing
  currently relies on the field, but the dead store invites someone to.
