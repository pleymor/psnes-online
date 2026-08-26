<script lang="ts">
  /**
   * The controller you play with when the machine has no keys.
   *
   * Logic-free on purpose: pixels and pointer ids live here, the mask lives in
   * `controls/touch.ts`, and the two meet only through the `TouchPad` this
   * receives. That is what lets the arithmetic - dead zone, sectors, two thumbs
   * at once - be tested without a browser.
   *
   * A stick rather than a d-pad: a thumb on glass has no edges to feel, so a
   * cross asks the player to hit a quarter of a small square blind. A stick
   * only asks for a direction, and it is the same twelve-bit mask either way -
   * the emulated machine still sees a d-pad.
   */
  import { onDestroy, createEventDispatcher } from 'svelte';
  import type { Button } from '$lib/controls/binding';
  import type { FaceTarget, TouchPad } from '$lib/controls/touch';
  import { facesAt } from '$lib/controls/touch';

  export let pad: TouchPad;

  /**
   * Whether to offer fast-forward, which only solo can answer for.
   *
   * False by default because lockstep must not: the clock is agreed between
   * two peers, and one of them running four times faster is the same thing as
   * one of them stalling. `FrameGovernor.setTurbo` exists there and nothing
   * calls it, for exactly this reason.
   */
  export let canTurbo = false;

  const dispatch = createEventDispatcher<{ turbo: boolean }>();

  /**
   * Which buttons are lit. The drawing only: the emulator reads `pad`, never
   * this, so a bug here can make the pad look wrong but never play wrong.
   */
  let held: Partial<Record<Button, boolean>> = {};

  let stickEl: HTMLElement | null = null;
  /** The pointer that owns the stick, so a second thumb cannot steal it. */
  let stickPointer: number | null = null;
  let centreX = 0;
  let centreY = 0;
  let radius = 1;
  let knobX = 0;
  let knobY = 0;

  /** How far the knob travels, as a fraction of the stick's radius. */
  const KNOB_TRAVEL = 0.42;

  function press(event: PointerEvent, button: Button) {
    capture(event);
    event.preventDefault();
    pad.press(button);
    held = { ...held, [button]: true };
  }

  /**
   * Ties the rest of this gesture to the control it started on.
   *
   * Without it a thumb sliding off a button sends its `pointerup` to whatever
   * is underneath, and the button stays held for the rest of the game. The
   * throw is real - the browser refuses a pointer it no longer considers
   * active - and it must not cost us the press: a captured button that plays
   * is better than a lost one.
   */
  function capture(event: PointerEvent) {
    try {
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    } catch {
      // Uncapturable pointer: the press still counts.
    }
  }

  /**
   * Fast-forward, held rather than latched.
   *
   * Reported as a plain boolean instead of going through `pad`, because it is
   * not a button on the emulated machine - nothing in the twelve-bit mask says
   * "run faster". The room decides what to do with it.
   *
   * `turboHeld` is tracked here only so the release is idempotent: a
   * `pointercancel` after a `pointerup` would otherwise report a release
   * nobody was holding, which is harmless today and the sort of thing that
   * stops being harmless once something counts them.
   */
  let turboHeld = false;

  function turboDown(event: PointerEvent) {
    capture(event);
    event.preventDefault();
    if (turboHeld) return;
    turboHeld = true;
    dispatch('turbo', true);
  }

  function turboUp() {
    if (!turboHeld) return;
    turboHeld = false;
    dispatch('turbo', false);
  }

  function release(button: Button) {
    pad.release(button);
    held = { ...held, [button]: false };
  }

  function stickDown(event: PointerEvent) {
    if (stickPointer !== null || !stickEl) return;
    stickPointer = event.pointerId;
    capture(event);
    event.preventDefault();
    // Measured on every press rather than once: an orientation change, the
    // toolbar appearing, or entering fullscreen all move this box.
    const box = stickEl.getBoundingClientRect();
    centreX = box.left + box.width / 2;
    centreY = box.top + box.height / 2;
    radius = Math.max(box.width, box.height) / 2;
    aim(event);
  }

  function stickMove(event: PointerEvent) {
    if (event.pointerId !== stickPointer) return;
    event.preventDefault();
    aim(event);
  }

  function stickUp(event: PointerEvent) {
    if (event.pointerId !== stickPointer) return;
    stickPointer = null;
    pad.setStick(0, 0);
    knobX = 0;
    knobY = 0;
  }

  /** Where the thumb is, in units of the stick's radius. */
  function aim(event: PointerEvent) {
    const dx = (event.clientX - centreX) / radius;
    const dy = (event.clientY - centreY) / radius;
    pad.setStick(dx, dy);

    // The knob follows the thumb but stays inside the ring: a thumb that
    // wanders far still shows which way it is pushing.
    const distance = Math.hypot(dx, dy);
    const scale = distance > 1 ? 1 / distance : 1;
    knobX = dx * scale * radius * KNOB_TRAVEL;
    knobY = dy * scale * radius * KNOB_TRAVEL;
  }

  // Whatever is under a thumb when the room goes away never gets its release.
  onDestroy(() => {
    pad.releaseAll();
    // Unmounting fires no `pointerup`, and this component is unmounted the
    // moment the pause menu opens - so a thumb still on fast-forward would
    // leave the game running at four times speed with nothing holding it. The
    // room clears its own copy too; this is the half that belongs here.
    turboUp();
  });

  /**
   * Which face buttons each thumb currently holds.
   *
   * Per pointer rather than one set, so two thumbs on the diamond cannot
   * release each other's buttons: what the pad gets is the union.
   */
  const faceHolds = new Map<number, Button[]>();
  let facesEl: HTMLElement | null = null;

  /**
   * A touch anywhere on the diamond, resolved by geometry rather than by which
   * element it landed on.
   *
   * Per-button handlers gave one button per thumb and nothing at all in the gap
   * between two - which is precisely where a player aiming at A+B puts their
   * thumb. Measured on every move, so a thumb rolling from Y to B plays both on
   * the way, the way it does on a real pad.
   */
  function faceTargets(): FaceTarget[] {
    if (!facesEl) return [];
    const targets: FaceTarget[] = [];
    for (const node of facesEl.querySelectorAll<HTMLElement>('button[data-face]')) {
      const button = node.dataset.face as Button;
      const box = node.getBoundingClientRect();
      targets.push({
        button,
        x: box.left + box.width / 2,
        y: box.top + box.height / 2,
        r: box.width / 2
      });
    }
    return targets;
  }

  function facesDown(event: PointerEvent) {
    capture(event);
    event.preventDefault();
    faceHolds.set(event.pointerId, facesAt(event.clientX, event.clientY, faceTargets()));
    applyFaces();
  }

  function facesMove(event: PointerEvent) {
    if (!faceHolds.has(event.pointerId)) return;
    event.preventDefault();
    faceHolds.set(event.pointerId, facesAt(event.clientX, event.clientY, faceTargets()));
    applyFaces();
  }

  function facesUp(event: PointerEvent) {
    if (!faceHolds.delete(event.pointerId)) return;
    applyFaces();
  }

  /** The pad holds the union of what the thumbs hold, and nothing else. */
  function applyFaces() {
    const union = new Set<Button>();
    for (const buttons of faceHolds.values()) for (const b of buttons) union.add(b);

    const lit: Partial<Record<Button, boolean>> = { ...held };
    for (const face of FACES) {
      if (union.has(face.b)) pad.press(face.b);
      else pad.release(face.b);
      lit[face.b] = union.has(face.b);
    }
    held = lit;
  }

  const FACES: Array<{ b: Button; label: string; cell: string }> = [
    { b: 'x', label: 'X', cell: 'top' },
    { b: 'y', label: 'Y', cell: 'left' },
    { b: 'a', label: 'A', cell: 'right' },
    { b: 'b', label: 'B', cell: 'bottom' }
  ];
</script>

<!-- No context menu, no text selection, no magnifier: a long press on a
     control is a held button, not a gesture. -->
<div class="pad" on:contextmenu|preventDefault role="group" aria-label="Touch controller">
  <button
    type="button"
    class="shoulder left"
    class:on={held.l}
    aria-label="L"
    on:pointerdown={(e) => press(e, 'l')}
    on:pointerup={() => release('l')}
    on:pointercancel={() => release('l')}
  >L</button>

  <button
    type="button"
    class="shoulder right"
    class:on={held.r}
    aria-label="R"
    on:pointerdown={(e) => press(e, 'r')}
    on:pointerup={() => release('r')}
    on:pointercancel={() => release('r')}
  >R</button>

  {#if canTurbo}
    <!--
      Against the diamond's inner edge, so the right thumb can reach it from
      the face buttons without leaving the pad's playing half.
    -->
    <button
      type="button"
      class="turbo"
      class:on={turboHeld}
      aria-label="Fast-forward"
      on:pointerdown={turboDown}
      on:pointerup={turboUp}
      on:pointercancel={turboUp}
    >&gt;&gt;</button>
  {/if}

  <div
    class="stick"
    class:active={stickPointer !== null}
    bind:this={stickEl}
    role="presentation"
    on:pointerdown={stickDown}
    on:pointermove={stickMove}
    on:pointerup={stickUp}
    on:pointercancel={stickUp}
  >
    <span class="knob" style="transform: translate({knobX}px, {knobY}px)"></span>
  </div>

  <div class="middle">
    <button
      type="button"
      class="pill"
      class:on={held.select}
      aria-label="Select"
      on:pointerdown={(e) => press(e, 'select')}
      on:pointerup={() => release('select')}
      on:pointercancel={() => release('select')}
    >SELECT</button>
    <button
      type="button"
      class="pill"
      class:on={held.start}
      aria-label="Start"
      on:pointerdown={(e) => press(e, 'start')}
      on:pointerup={() => release('start')}
      on:pointercancel={() => release('start')}
    >START</button>
  </div>

  <!--
    The diamond takes the touches, not its four buttons: a thumb is wider than
    the gap between them, and which element a contact point lands on is the
    wrong question. facesAt answers the right one.
  -->
  <div
    class="faces"
    bind:this={facesEl}
    role="presentation"
    on:pointerdown={facesDown}
    on:pointermove={facesMove}
    on:pointerup={facesUp}
    on:pointercancel={facesUp}
  >
    {#each FACES as face (face.b)}
      <button
        type="button"
        class="face {face.cell}"
        class:on={held[face.b]}
        data-face={face.b}
        aria-label={face.label}
        tabindex="-1"
      >{face.label}</button>
    {/each}
  </div>
</div>

<style>
  .pad {
    /* Every size below is a share of this box, in container units, because the
       box is the only thing that knows how much room the room gave it: a 40vh
       strip in landscape and a floating band in portrait are very different
       shapes, and sizing from the viewport made the stick overflow its column
       in one of them. Both axes are always in the min(), so nothing can grow
       past the short one. */
    container-type: size;

    /* A grid rather than free positioning: the shoulders own a row, so they can
       never land on the stick when the band is short. */
    display: grid;
    grid-template-rows: auto 1fr;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    gap: 0.4rem;
    width: 100%;
    height: 100%;
    padding: 0.3rem 0.5rem 0.5rem;
    box-sizing: border-box;
    /* The whole point: no scrolling, no pinch-zoom and no double-tap zoom
       while a thumb is playing. */
    touch-action: none;
    user-select: none;
    -webkit-user-select: none;
    -webkit-touch-callout: none;
    -webkit-tap-highlight-color: transparent;
  }

  button {
    font-family: inherit;
    font-weight: 700;
    color: #f8fafc;
    background: rgba(30, 30, 46, 0.85);
    border: 1px solid rgba(148, 163, 184, 0.45);
    /* Never take focus from the game: a focused button would swallow the
       keyboard, and there is no ring worth showing to a thumb. */
    outline: none;
    touch-action: none;
    padding: 0;
  }

  button.on {
    background: rgba(86, 71, 203, 0.95);
    border-color: #a5b4fc;
  }

  .shoulder {
    grid-row: 1;
    /*
     * Every size in this file is declared twice: a plain value first, then the
     * container-unit one.
     *
     * A browser without container queries - Safari before 16 - drops the second
     * declaration as invalid, and a control whose only height was expressed in
     * cqh would then have no height at all: not a smaller pad, an invisible
     * one. The first value is what such a browser renders, and it is sized for
     * a phone.
     */
    height: 2rem;
    height: min(18cqh, 9cqw);
    min-height: 1.6rem;
    width: 6rem;
    width: min(26cqw, 7rem);
    font-size: 0.8rem;
    font-size: clamp(0.7rem, min(9cqh, 4cqw), 1rem);
    border-radius: 0.4rem 0.4rem 1rem 1rem;
  }

  .shoulder.left {
    grid-column: 1;
    justify-self: start;
  }

  .shoulder.right {
    grid-column: 3;
    justify-self: end;
  }

  .stick {
    grid-row: 2;
    grid-column: 1;
    /* Against the edge, under the shoulder, rather than centred in its half:
       in landscape the phone is held by its corners, and a stick centred in a
       422px column is out of the left thumb's reach. */
    justify-self: start;
    position: relative;
    /* 34cqw is what is left once the Start pills have taken the middle column:
       above that the stick pushes out of its own half of the pad. */
    height: 8rem;
    height: min(74cqh, 34cqw);
    aspect-ratio: 1;
    border-radius: 50%;
    background: rgba(30, 30, 46, 0.7);
    border: 1px solid rgba(148, 163, 184, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    touch-action: none;
  }

  .stick.active {
    border-color: #a5b4fc;
  }

  .knob {
    width: 45%;
    height: 45%;
    border-radius: 50%;
    background: rgba(148, 163, 184, 0.75);
    /* Follows the thumb with no transition: easing here would lag the input it
       is supposed to be reporting. */
    pointer-events: none;
  }

  .middle {
    /*
     * Up with the shoulders, between L and R.
     *
     * Select and Start were a column in the middle of the pad, and that column
     * was width taken from the two controls that are actually played with: the
     * thumbs' half of the pad ended where the pills began. Moved into the top
     * row - which the shoulders already own and which is taller than a pill -
     * they cost no height, and the diamond grows by a quarter into the space
     * they left.
     */
    grid-row: 1;
    /*
     * Across the whole row and centred on the pad, not on the middle column:
     * the diamond is wider than the stick, so the two side columns are not the
     * same width, and a pill centred in what is left between them sits visibly
     * off to one side. L and R keep their corners either way.
     */
    grid-column: 1 / -1;
    justify-self: center;
    display: flex;
    flex-direction: row;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
    min-width: 0;
  }

  .pill {
    padding: 0.35rem 0.75rem;
    white-space: nowrap;
    border-radius: 999px;
    font-size: 0.7rem;
    font-size: clamp(0.5rem, min(7cqh, 2.6cqw), 0.75rem);
    letter-spacing: 0.06em;
  }

  /*
   * The middle column of the playing row, hugging the diamond.
   *
   * Two placements were measured first and both cost something. Above the
   * diamond: in landscape the diamond's height is bound by `cqh`, not `cqw` -
   * 163px of a 272px band once the top row and the padding have taken theirs -
   * so a button stacked over it comes straight off the control the previous
   * change had just widened, and it still overlapped by 13px. Beside R in the
   * top row: no vertical cost, but at 390px of portrait, L plus the centred
   * pills plus R already want more width than there is, and it landed 33px
   * inside the pills.
   *
   * This column is the one place that costs nothing either way. It is `auto`
   * and was empty, and the stick and the diamond are pinned to the outer edges
   * and sized from the container rather than from their columns - so widening
   * this one eats slack between them and takes nothing from either. There is
   * 420px of that slack in landscape and 84px in portrait.
   */
  .turbo {
    grid-row: 2;
    grid-column: 2;
    align-self: center;
    /* Toward the diamond rather than centred in the gap: the right thumb is
       the one that reaches here, and it starts on the face buttons. Not right
       up against it, though - `justify-self` alone left 6px between this and
       Y, and a thumb is wider than that. `facesAt` resolves a touch by its
       point, so those 6px are the difference between reaching for Y and
       fast-forwarding by accident. */
    justify-self: end;
    margin-right: 0.75rem;
    letter-spacing: 0.08em;
    /* Declared twice, as everything here is: see .shoulder for why. */
    height: 1.9rem;
    height: min(15cqh, 8cqw);
    min-height: 1.5rem;
    width: 3.4rem;
    width: min(14cqw, 4rem);
    font-size: 0.9rem;
    font-size: clamp(0.75rem, min(10cqh, 4.5cqw), 1.1rem);
    border-radius: 999px;
    line-height: 1;
  }

  .faces {
    grid-row: 2;
    grid-column: 3;
    justify-self: end;
    position: relative;
    /* A quarter wider than it was, which is the width the pills used to take
       out of this half of the pad. */
    height: 10.5rem;
    /* 76cqh, not more: the top row and the padding take the rest of the band,
       and a diamond taller than what is left hangs out of the pad on a tablet,
       where height rather than width is the binding constraint. */
    height: min(76cqh, 42cqw);
    aspect-ratio: 1;
  }

  .face {
    position: absolute;
    /* Three across the diamond, with a little air between them. */
    width: 36%;
    height: 36%;
    border-radius: 50%;
    font-size: 1.1rem;
    font-size: clamp(0.8rem, min(14cqh, 6cqw), 1.5rem);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  /*
   * Wide landscape - a phone on its side - rearranges rather than resizes.
   *
   * The room turns the pad into an overlay there (same media query, in both
   * room components) so the picture can have the whole height. An 8:7 picture
   * on a 2:1 screen leaves about a quarter of the width black on each side,
   * and that black is exactly where the thumbs are: the two clusters move into
   * it, and Select and Start go to the bottom corners under them rather than
   * staying in the middle, where they would sit on the picture.
   */
  @media (orientation: landscape) and (min-aspect-ratio: 16 / 9) {
    .pad {
      /*
       * How much black there is beside a full-height 8:7 picture, less a little
       * air: 114.3vh is 100vh x 8/7, so this is what the window has left over
       * once the picture has taken the height. Conservative on purpose - the
       * picture is a little shorter than the window, so the real margin is a
       * little wider than this - and it is what keeps a cluster off the
       * picture on a screen narrower than the one this was measured on.
       */
      --margin: calc((100vw - 114.3vh) / 2 - 0.75rem);
      /* Named because fast-forward is placed just past L and must not drift
         from L's actual width if that ever changes. */
      --shoulder-w: min(26cqw, 7rem, var(--margin));

      grid-template-rows: auto 1fr auto;
      /* Only the controls take touches: a double-click on the picture has to
         reach the screen underneath, which is how fullscreen is toggled. */
      pointer-events: none;
    }

    .pad button,
    .pad .stick,
    /* The gap between two face buttons belongs to the diamond, not to the
       picture behind it: that gap is where A+B is played. */
    .pad .faces {
      pointer-events: auto;
    }

    .middle {
      grid-row: 3;
      grid-column: 1 / -1;
      flex-direction: row;
      justify-content: space-between;
      width: 100%;
    }

    /* What has to fit is no longer half the screen but that margin. The floor
       keeps a thumb-sized control on a screen too narrow to deserve this
       layout at all - it would rather overlap a little than vanish. */
    /* Same discipline: a plain value first, so a browser that cannot read the
       container units still draws a controller. */
    .stick { height: 7rem; height: max(4.5rem, min(46cqh, var(--margin))); }
    /* The same quarter here, as far as the black beside the picture allows. */
    .faces { height: 9rem; height: max(4.5rem, min(62cqh, var(--margin))); }
    .shoulder {
      height: 1.9rem;
      height: min(13cqh, 7cqw);
      width: 6rem;
      width: var(--shoulder-w);
    }

    /*
     * Into the left margin, under the stick.
     *
     * This layout exists to keep the controls off the picture - that is what
     * the `--margin` sizing above is for, and what `pointer-events: none` on
     * the pad protects. The middle column, which is where fast-forward sits in
     * every other shape, is precisely the picture here, so it cannot stay
     * there. The right margin is already full: the diamond takes 161 of the
     * 195px this row has. The left has room, because the stick is the smaller
     * of the two - 125px, leaving about 70 under it.
     *
     * Beside L rather than under the stick, and that is measured rather than
     * taste. Under the stick looks better and does not fit: the row's 70px of
     * slack is split above and below a stick the grid centres, so what is
     * free under it is 35 - which left 8px between a thumb-sized button and
     * the stick a thumb is already dragging. Up here the row is `auto` and
     * sized by the shoulders, which are taller than this, so it costs nothing;
     * and the margin has 69px left once L has taken its 112 of 187.
     *
     * The left index finger is already on L, which is a better home for a
     * button held down than any thumb reach: both thumbs stay on the stick and
     * the diamond while the game runs fast.
     */
    .turbo {
      grid-row: 1;
      grid-column: 1;
      justify-self: start;
      align-self: center;
      margin: 0 0 0 calc(var(--shoulder-w) + 0.4rem);
      height: 1.6rem;
      height: min(11cqh, 5.5cqw);
      min-height: 1.4rem;
      width: 3rem;
      width: min(20cqw, 3.5rem);
    }
  }

  /* The SNES diamond: X on top, Y left, A right, B below. */
  .face.top { top: 0; left: 50%; transform: translateX(-50%); }
  .face.bottom { bottom: 0; left: 50%; transform: translateX(-50%); }
  .face.left { left: 0; top: 50%; transform: translateY(-50%); }
  .face.right { right: 0; top: 50%; transform: translateY(-50%); }
</style>
