<!--
  D. Le bleu, repensé en mur : une peinture bleue au rouleau, un soubassement
  de lambris blanc, deux cadres (un voilier, une montgolfière), et une fenêtre
  à voilages sur un ciel de nuages. Le ciel d'aujourd'hui, vu de la chambre.

  La fenêtre montre le seul effet de profondeur à deux étages : ses nuages
  portent une profondeur négative dans un calque qui en a une positive, donc
  ils bougent moins que le cadre, comme un ciel lointain derrière une vitre.
-->
<div class="layer" data-depth="0.1">
  <svg class="fill" aria-hidden="true">
    <defs>
      <linearGradient id="d-paint" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#4f86c6" />
        <stop offset="1" stop-color="#3c6fae" />
      </linearGradient>
      <!-- Les passes du rouleau, à peine visibles. -->
      <pattern id="d-roller" width="90" height="400" patternUnits="userSpaceOnUse">
        <rect x="0" width="38" height="400" fill="#fff" opacity=".035" />
        <rect x="60" width="14" height="400" fill="#000" opacity=".03" />
      </pattern>
      <pattern id="d-panels" width="240" height="1000" patternUnits="userSpaceOnUse">
        <rect width="240" height="1000" fill="#e9f0f7" />
        <rect x="24" y="30" width="192" height="1000" rx="3" fill="none" stroke="#c9d6e4" stroke-width="3" />
        <rect x="30" y="36" width="180" height="1000" rx="2" fill="none" stroke="#ffffff" stroke-width="2" />
      </pattern>
    </defs>
    <rect width="100%" height="100%" fill="url(#d-paint)" />
    <rect width="100%" height="100%" fill="url(#d-roller)" />
  </svg>
  <!-- La cimaise et le lambris, sur le bas du mur. -->
  <svg class="wainscot" aria-hidden="true">
    <rect width="100%" height="100%" fill="url(#d-panels)" />
    <rect width="100%" height="14" fill="#f7fbff" />
    <rect y="14" width="100%" height="4" fill="#b7c7d8" />
    <rect y="18" width="100%" height="8" fill="#000" opacity=".06" />
  </svg>
</div>

<div class="layer" data-depth="0.4">
  <!-- La fenêtre : l'ouverture découpe le ciel, qui a sa propre profondeur. -->
  <div class="item window">
    <div class="pane">
      <div class="sky" data-depth="-0.3">
        <svg viewBox="0 0 260 240" aria-hidden="true">
          <rect width="260" height="240" fill="#bfe3ff" />
          <rect y="150" width="260" height="90" fill="#d9efff" />
          <path d="M20 90 a16 16 0 0 1 28 -10 a20 20 0 0 1 38 4 a13 13 0 0 1 0 26 h-62 a13 13 0 0 1 -4 -20z" fill="#fff" />
          <path d="M140 60 a12 12 0 0 1 22 -7 a15 15 0 0 1 28 3 a10 10 0 0 1 0 20 h-46 a10 10 0 0 1 -4 -16z" fill="#fff" opacity=".95" />
          <path d="M120 170 a14 14 0 0 1 24 -8 a18 18 0 0 1 34 4 a12 12 0 0 1 0 24 h-54 a12 12 0 0 1 -4 -20z" fill="#fff" opacity=".9" />
        </svg>
      </div>
    </div>
    <svg class="frame" viewBox="0 0 200 230" aria-hidden="true">
      <path fill-rule="evenodd" d="M0 0 H200 V214 H0Z M14 14 V200 H186 V14Z" fill="#f7fbff" />
      <rect x="96" y="14" width="8" height="186" fill="#f7fbff" />
      <rect x="14" y="104" width="172" height="8" fill="#f7fbff" />
      <rect x="-10" y="210" width="220" height="16" rx="3" fill="#f7fbff" />
      <rect x="-10" y="224" width="220" height="4" fill="#000" opacity=".12" />
      <!-- Les voilages, qui laissent passer le jour. -->
      <path d="M-12 -8 h56 c-10 70 -20 150 -40 214 h-16z" fill="#ffffff" opacity=".78" />
      <path d="M212 -8 h-56 c10 70 20 150 40 214 h16z" fill="#ffffff" opacity=".78" />
      <rect x="-20" y="-12" width="240" height="7" rx="3" fill="#c9a86a" />
    </svg>
  </div>
  <!-- Le voilier, dans un cadre de bois clair. -->
  <div class="item frame-pic boat">
    <svg viewBox="0 0 120 100" aria-hidden="true">
      <rect width="120" height="100" fill="#c9a86a" />
      <rect x="8" y="8" width="104" height="84" fill="#fdf6e3" />
      <rect x="14" y="14" width="92" height="72" fill="#cde9ff" />
      <rect x="14" y="62" width="92" height="24" fill="#3b7fc4" />
      <path d="M58 22 V62 H34Z" fill="#fff" /><path d="M62 30 V62 H82Z" fill="#e8402a" />
      <path d="M32 62 H88 L80 72 H40Z" fill="#6b4a2b" />
    </svg>
  </div>
  <!-- La montgolfière, dans un cadre blanc. -->
  <div class="item frame-pic balloon">
    <svg viewBox="0 0 100 124" aria-hidden="true">
      <rect width="100" height="124" fill="#f7fbff" />
      <rect x="7" y="7" width="86" height="110" fill="#fff7e6" />
      <path d="M50 22 C74 22 78 50 62 70 H38 C22 50 26 22 50 22Z" fill="#f8d030" />
      <path d="M50 22 C60 22 62 50 56 70 H44 C38 50 40 22 50 22Z" fill="#e8402a" />
      <path d="M40 70 L44 84 M60 70 L56 84" stroke="#6b4a2b" stroke-width="1.5" />
      <rect x="43" y="84" width="14" height="10" fill="#8a6239" />
    </svg>
  </div>
</div>

<div class="layer" data-depth="0.85">
  <!-- L'avion en papier du mobile, au bout de son fil. -->
  <div class="item plane">
    <svg viewBox="0 0 90 150" aria-hidden="true">
      <line x1="45" y1="0" x2="45" y2="100" stroke="#e9f0f7" stroke-width="1.5" />
      <path d="M6 110 L84 96 L40 128Z" fill="#ffffff" />
      <path d="M40 128 L84 96 L46 114Z" fill="#c9d6e4" />
      <path d="M46 114 L84 96 L52 136Z" fill="#e9f0f7" />
    </svg>
  </div>
</div>

<style>
  .wainscot {
    position: absolute;
    left: 0;
    width: 100%;
    top: 70%;
    height: 40%;
  }

  .window {
    top: calc(24px + 96px);
    right: calc(24px + 3cqw);
    width: 200px;
    height: 230px;
  }

  .pane {
    position: absolute;
    left: 14px;
    top: 14px;
    width: 172px;
    height: 186px;
    overflow: hidden;
  }

  /* Plus grand que l'ouverture, pour qu'en glissant il ne montre pas de bord. */
  .sky {
    position: absolute;
    inset: -24px;
    will-change: transform;
  }

  .sky svg {
    width: 100%;
    height: 100%;
    display: block;
  }

  .frame {
    position: absolute;
    inset: 0;
    overflow: visible;
  }

  .frame-pic {
    box-shadow: 0 6px 0 rgba(0, 0, 0, 0.14);
  }

  .boat {
    top: calc(24px + 26cqh);
    left: calc(24px + 1.4cqw);
    width: 112px;
  }

  .balloon {
    top: calc(24px + 26cqh + 124px);
    left: calc(24px + 2.4cqw);
    width: 84px;
  }

  .plane {
    top: calc(24px + 54px);
    right: calc(24px + 3cqw + 220px);
    width: 76px;
  }

  @container (max-width: 768px) {
    .window { top: calc(24px + 70px); right: calc(24px + 8px); transform: scale(0.55); transform-origin: top right; }
    .boat { top: calc(24px + 44cqh); left: calc(24px + 4px); width: 72px; }
    .balloon { top: calc(24px + 44cqh + 84px); left: calc(24px + 8px); width: 56px; }
    .plane { display: none; }
  }
</style>
