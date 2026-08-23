<script lang="ts">
  /**
   * A SNES controller drawing you click on to rebind.
   *
   * Stateless and logic-free: it receives twelve lists of codes and renders
   * twelve labels. What happens on click belongs to PlayerControls; what a
   * code means belongs to binding.ts.
   *
   * The binding is written *on* the button rather than beside it in a list,
   * because the drawing should be the config, not its legend. The price is a
   * label of at most three characters, hence the short forms; the long form
   * lives in the aria-label, which is also what a screen reader reads.
   */
  import { createEventDispatcher } from 'svelte';
  import { shortLabelList, type Button } from '$lib/controls/binding';

  export let bindings: Record<Button, string[]>;
  export let capturing: Button | null = null;
  export let pressed: Set<Button> = new Set();
  export let conflicts: Set<Button> = new Set();
  /** The readable name of each button, already translated, for aria-labels. */
  export let labels: Record<Button, string>;
  /** The long-form binding descriptions, already translated. */
  export let descriptions: Record<Button, string>;
  export let interactive = true;

  const dispatch = createEventDispatcher<{ select: { button: Button } }>();

  /**
   * Geometry, in a 520 x 244 viewBox.
   *
   * Labels sit at 18 units, i.e. 3.5% of the width: about 10px in the 280px
   * useful width of the pause panel, which stays legible in bold monospace
   * for one or two letters.
   */
  const FACE = { x: 400, y: 78, r: 24 } as const;

  const SHOULDERS: Array<{ b: Button; x: number; letter: string }> = [
    { b: 'l', x: 74, letter: 'L' },
    { b: 'r', x: 338, letter: 'R' }
  ];

  const DPAD: Array<{ b: Button; x: number; y: number; hit: { x: number; y: number; w: number; h: number } }> = [
    { b: 'up', x: 131, y: 96, hit: { x: 112, y: 74, w: 38, h: 31 } },
    { b: 'down', x: 131, y: 168, hit: { x: 112, y: 143, w: 38, h: 31 } },
    { b: 'left', x: 90, y: 131, hit: { x: 55, y: 105, w: 57, h: 38 } },
    { b: 'right', x: 162, y: 131, hit: { x: 150, y: 105, w: 31, h: 38 } }
  ];

  /* Face buttons: X on top, Y on the left, A on the right, B on the bottom. */
  const FACE_BUTTONS: Array<{ b: Button; cx: number; cy: number; fill: string; stroke: string; letter: string }> = [
    { b: 'x', cx: 400, cy: 78, fill: '#2f6bd8', stroke: '#1d4795', letter: 'X' },
    { b: 'y', cx: 356, cy: 122, fill: '#2fa34a', stroke: '#1d6e33', letter: 'Y' },
    { b: 'a', cx: 444, cy: 122, fill: '#d63a3a', stroke: '#95251f', letter: 'A' },
    { b: 'b', cx: 400, cy: 166, fill: '#e0b325', stroke: '#9c7a14', letter: 'B' }
  ];

  const PILLS: Array<{ b: Button; x: number; tx: number; label: string; lx: number }> = [
    { b: 'select', x: 198, tx: 224, label: 'SELECT', lx: 206 },
    { b: 'start', x: 258, tx: 284, label: 'START', lx: 300 }
  ];

  function choose(button: Button) {
    if (!interactive) return;
    dispatch('select', { button });
  }

  /**
   * Enter and Space activate a button of the drawing - except during a
   * capture, where the key belongs to the player currently binding `⏎` to
   * Start.
   */
  function onKey(event: KeyboardEvent, button: Button) {
    if (capturing !== null) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    choose(button);
  }

  $: label = (button: Button) =>
    `${labels[button]} — ${descriptions[button]}`;
</script>

<svg viewBox="0 0 520 244" class="pad" role="group" aria-label="SNES controller">
  <defs>
    <linearGradient id="snes-body" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#e6e6ee" />
      <stop offset="1" stop-color="#a5a5b6" />
    </linearGradient>
    <linearGradient id="snes-shoulder" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#d4d4de" />
      <stop offset="1" stop-color="#9a9aa9" />
    </linearGradient>
  </defs>

  <!-- shoulder buttons -->
  {#each SHOULDERS as shoulder}
    <g
      class="hit"
      class:capturing={capturing === shoulder.b}
      class:pressed={pressed.has(shoulder.b)}
      class:conflict={conflicts.has(shoulder.b)}
      role="button"
      tabindex={interactive ? 0 : -1}
      aria-label={label(shoulder.b)}
      on:click={() => choose(shoulder.b)}
      on:keydown={(e) => onKey(e, shoulder.b)}
    >
      <rect x={shoulder.x} y="6" width="108" height="30" rx="12" fill="url(#snes-shoulder)" stroke="#7b7b8a" stroke-width="1.6" />
      <text x={shoulder.x + 22} y="27" class="glyph">{shoulder.letter}</text>
      <text x={shoulder.x + 72} y="27" class="binding dark">{shortLabelList(bindings[shoulder.b])}</text>
    </g>
  {/each}

  <rect x="14" y="32" width="492" height="180" rx="88" fill="url(#snes-body)" stroke="#7b7b8a" stroke-width="2" />

  <!-- d-pad -->
  <g fill="#41414c" stroke="#2a2a33" stroke-width="1.6">
    <rect x="112" y="74" width="38" height="100" rx="6" />
    <rect x="50" y="105" width="131" height="38" rx="6" />
  </g>
  {#each DPAD as dir}
    <g
      class="hit"
      class:capturing={capturing === dir.b}
      class:pressed={pressed.has(dir.b)}
      class:conflict={conflicts.has(dir.b)}
      role="button"
      tabindex={interactive ? 0 : -1}
      aria-label={label(dir.b)}
      on:click={() => choose(dir.b)}
      on:keydown={(e) => onKey(e, dir.b)}
    >
      <rect x={dir.hit.x} y={dir.hit.y} width={dir.hit.w} height={dir.hit.h} fill="transparent" />
      <text x={dir.x} y={dir.y} class="binding light">{shortLabelList(bindings[dir.b])}</text>
    </g>
  {/each}

  <!-- face buttons -->
  {#each FACE_BUTTONS as face}
    <g
      class="hit"
      class:capturing={capturing === face.b}
      class:pressed={pressed.has(face.b)}
      class:conflict={conflicts.has(face.b)}
      role="button"
      tabindex={interactive ? 0 : -1}
      aria-label={label(face.b)}
      on:click={() => choose(face.b)}
      on:keydown={(e) => onKey(e, face.b)}
    >
      <circle cx={face.cx} cy={face.cy} r={FACE.r} fill={face.fill} stroke={face.stroke} stroke-width="1.6" />
      <text x={face.cx} y={face.cy - 4} class="glyph on-colour">{face.letter}</text>
      <text x={face.cx} y={face.cy + 13} class="binding light">{shortLabelList(bindings[face.b])}</text>
    </g>
  {/each}

  <!-- select and start -->
  {#each PILLS as pill}
    <g
      class="hit"
      class:capturing={capturing === pill.b}
      class:pressed={pressed.has(pill.b)}
      class:conflict={conflicts.has(pill.b)}
      role="button"
      tabindex={interactive ? 0 : -1}
      aria-label={label(pill.b)}
      on:click={() => choose(pill.b)}
      on:keydown={(e) => onKey(e, pill.b)}
    >
      <g transform="rotate(-18 252 160)">
        <rect x={pill.x} y="150" width="52" height="19" rx="9.5" fill="#6b6b78" stroke="#494954" stroke-width="1.3" />
        <text x={pill.tx} y="164" class="binding light small">{shortLabelList(bindings[pill.b])}</text>
      </g>
      <text x={pill.lx} y="196" class="glyph faint">{pill.label}</text>
    </g>
  {/each}
</svg>

<style>
  .pad {
    width: 100%;
    height: auto;
    display: block;
  }

  .hit {
    cursor: pointer;
  }

  .hit:focus-visible {
    outline: 2px solid #7ea6ff;
    outline-offset: 2px;
  }

  text {
    text-anchor: middle;
    pointer-events: none;
    user-select: none;
  }

  /* 18 units in a 520-wide viewBox: ~3.5% of the width, so ~10px in the
     280px useful width of the pause panel. Below that it stops being
     legible. */
  .binding {
    font-family: 'Monaco', 'Courier New', monospace;
    font-size: 18px;
    font-weight: 700;
  }

  .binding.small {
    font-size: 14px;
  }

  .light {
    fill: #fff;
  }

  .dark {
    fill: #33333d;
  }

  .glyph {
    font-family: system-ui, sans-serif;
    font-size: 14px;
    font-weight: 700;
    fill: #3a3a46;
  }

  .glyph.on-colour {
    fill: #fff;
    font-size: 11px;
    opacity: 0.9;
  }

  .glyph.faint {
    font-size: 10px;
    fill: #5c5c68;
  }

  /* While capturing: the target blinks, as the old grid's button did - same
     signal, same place as the attention. */
  .hit.capturing rect,
  .hit.capturing circle {
    stroke: #1976d2;
    stroke-width: 3;
    animation: pulse 1s ease-in-out infinite;
  }

  /* Pressed live: this is what tells the player which controller they're
     holding. */
  .hit.pressed circle,
  .hit.pressed rect {
    filter: brightness(1.5);
  }

  .hit.conflict circle,
  .hit.conflict rect {
    stroke: #d32f2f;
    stroke-width: 3;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.6; }
  }
</style>
