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
  import { onDestroy } from 'svelte';
  import type { Button } from '$lib/controls/binding';
  import type { TouchPad } from '$lib/controls/touch';

  export let pad: TouchPad;

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
  onDestroy(() => pad.releaseAll());

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

  <div class="faces">
    {#each FACES as face (face.b)}
      <button
        type="button"
        class="face {face.cell}"
        class:on={held[face.b]}
        aria-label={face.label}
        on:pointerdown={(e) => press(e, face.b)}
        on:pointerup={() => release(face.b)}
        on:pointercancel={() => release(face.b)}
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
    grid-row: 2;
    grid-column: 2;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 0.5rem;
  }

  .pill {
    padding: 0.35rem 0.9rem;
    border-radius: 999px;
    font-size: 0.7rem;
    font-size: clamp(0.5rem, min(7cqh, 2.6cqw), 0.75rem);
    letter-spacing: 0.06em;
  }

  .faces {
    grid-row: 2;
    grid-column: 3;
    justify-self: end;
    position: relative;
    height: 8.5rem;
    height: min(80cqh, 34cqw);
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

      grid-template-rows: auto 1fr auto;
      /* Only the controls take touches: a double-click on the picture has to
         reach the screen underneath, which is how fullscreen is toggled. */
      pointer-events: none;
    }

    .pad button,
    .pad .stick {
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
    .faces { height: 7.5rem; height: max(4.5rem, min(50cqh, var(--margin))); }
    .shoulder {
      height: 1.9rem;
      height: min(13cqh, 7cqw);
      width: 6rem;
      width: min(26cqw, 7rem, var(--margin));
    }
  }

  /* The SNES diamond: X on top, Y left, A right, B below. */
  .face.top { top: 0; left: 50%; transform: translateX(-50%); }
  .face.bottom { bottom: 0; left: 50%; transform: translateX(-50%); }
  .face.left { left: 0; top: 50%; transform: translateY(-50%); }
  .face.right { right: 0; top: 50%; transform: translateY(-50%); }
</style>
