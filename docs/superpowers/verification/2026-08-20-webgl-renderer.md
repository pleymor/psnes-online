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
| Unit suite | **194 passing, 0 failing** — 37 netplay, 11 core, 80 ui, 66 backend. Baseline before the branch was 165; the 29 new tests are Task 1's 20 preset tests, Task 2's 6 surface tests, and 3 added by the final-review fix wave. |
| `svelte-check` | **0 errors, 19 warnings in 10 files** — identical to the pre-branch baseline. The 19 warnings are pre-existing CSS-compatibility notes. |
| Production build | `npm run build --workspace frontend` succeeds in 4.24s. |
| Timing constraint | `grep -nE "requestAnimationFrame\|setTimeout\|setInterval\|performance\.now\|Date\.now"` over `webgl-renderer.ts`, `preset.ts` and `shader-source.ts` returns **nothing**. Run independently by the implementer, the task reviewer, and the controller. |
| Pinned shader source | All five URLs used by the presets return **200** at commit `468f67b6f6788e2719d1dd28dfb2c9b7c3db3cc7`. Checked while six presets were offered; `crt-easymode` was removed afterwards, leaving five entries plus "none". |
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

- [ ] **The presets render correctly.** Cycle the toolbar button through all six
      states in a lockstep room. Two shapes must each be exercised: the two-pass
      path (any xBRZ) and the plain single pass (`sharp-bilinear-simple`,
      `fxaa`). The `#pragma parameter` path is no longer reachable — it was
      `crt-easymode`'s alone, and that preset has been removed.

      Do not just look for a black screen: **compare each preset side by side
      with the same preset in solo**, which runs the RetroArch path. The spec's
      decisive argument is that both paths show the *same* shader, and the known
      open defect below breaks exactly that for the single-pass presets in a way
      that still produces a plausible picture.
- [ ] **The picture is the right way up.** This is the check I would run first.
      The `v` axis is reversed on pass 0 only; getting it wrong renders the game
      upside down. A one-pass preset and a two-pass preset must *both* be
      upright — the bug class here is one that fixes itself for odd pass counts
      and breaks for even ones.
- [ ] **Frame pacing is unchanged with and without a shader.** The decisive
      check, and more important than any screenshot. Read the netplay stats over
      ~30s with no shader, then with `xbrz/6xbrz-linear` (the most expensive).
      Record the two side by side.
      If enabling a shader changes emulated frames per second, the renderer is
      influencing timing and the feature is not finished — that is the one defect
      here that could desync a game rather than merely look wrong.
- [ ] **The other player is unaffected.** Shader choice is local and never enters
      the protocol. Changing it in one window must change nothing in the other.
- [ ] **All four fallbacks are graceful.** Each must end with a visible picture
      and a notice, never a black canvas:
      no WebGL2 (launch Chrome with `--disable-gpu`);
      an unsupported preset (temporarily add `xbrz/xbrz-freescale` to `SHADERS`
      in `ShaderSelector.svelte` and confirm the console *names* the offending
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

## Open design defect: the final pass runs at source size

Found by the whole-branch review, **not fixed**, and the most consequential
thing still outstanding.

The final canvas is sized `source × (product of the intermediate passes'
scales)`. Every single-pass preset has an empty product, so it renders at
`OutputSize == InputSize == 256×224` and is then CSS-upscaled. RetroArch runs
the final pass at the viewport, which is what these shaders are written for.

The consequence is not a black screen, which is why nothing caught it. It is a
plausible wrong picture:

- `sharp-bilinear-simple` exists to prescale to an integer multiple before
  smoothing. At scale 1 it degenerates to a plain blit — the same output as no
  shader at all.
- `fxaa` at native resolution is close to a no-op.
- `crt-easymode` was the worst case: at 1:1, its scanline term evaluates at
  every output pixel centre to `cos(π(2n+1)) = -1`, so the weight is a constant
  and **the scanlines vanish entirely**. It has since been removed, which
  retires the symptom without addressing the cause.

So of the five shader entries, the three xBRZ presets work as intended — they
have a real intermediate pass at an integer scale, which is the case this
design serves correctly — and the two remaining single-pass presets do almost
nothing.

This originates in the spec, not the implementation: the spec says intermediate
passes are `scale × source` and that the last draws to the canvas, and never
says what size that canvas should be. The minimal fix is to size the final
canvas to its CSS box (`clientWidth`/`clientHeight` × `devicePixelRatio`,
clamped) and feed that as `OutputSize`; xBRZ is unaffected in kind because its
second pass is `stock.glsl`, a plain blit. It was deliberately not done here
because it changes how every preset looks and cannot be verified in any
environment available to the implementation.

## Minor findings — what the fix wave took, and what stands

The whole-branch review triaged the seven minors recorded during the task
reviews. Four were fixed, three stand deliberately.

**Fixed:**

- `preset.ts` — `SUPPORTED_DIRECTIVES` no longer doubles as the indexed-prefix
  table, so `shaders2` is now refused by name rather than silently accepted as
  base `shaders`. This was the substantive one: "everything outside the subset
  is refused by name" is the module's whole reason to exist, and a key it
  accepted-and-ignored was a hole in the one invariant the spec makes binding.
- `preset.ts` — the no-`=`-in-line branch is now tested. It will actually be
  reached: a CDN or captive portal serving an HTML error page with a 200 status
  lands there, and the test pins that the whole preset is refused rather than
  half-read.
- `presetUrl` and `SHADER_BASE_URL` moved from `shader-source.ts` to `preset.ts`,
  which makes the pure/impure boundary literally true rather than almost true,
  and gets `presetUrl` under test.
- `output.ts` — the `DisplayOptions.shader` doc comment no longer claims that
  `WebglRenderer` honours the field. Neither renderer reads it; the room does.

**Stands:**

- `preset.ts` — the module doc says "no globals" while `resolveShaderUrl` uses
  the global `URL` constructor. Wording only.
- `core.ts` — the `videoSurface` doc says the consumer "must skip the padding
  itself"; with `UNPACK_ROW_LENGTH` set, GL does the skipping.
- `shader-source.ts` — `Promise.all` over passes is fail-fast. The behaviour is
  right and the return type makes partial results unrepresentable.

One finding was answered differently from how it was prescribed, and the
reasoning is worth keeping. The pinned commit is duplicated between
`shader-source.ts` and `options.ts`, which undercuts the spec's reason for
pinning. The preferred fix was a real import; it was rejected because importing
from the emulator module would drag `ini` and `path-browserify` into the pure
`znet` bundle — and cutting exactly that kind of dependency surface was the
point of issues #10 and #11. Cross-referencing comments in both files instead,
so the two copies at least name each other.
