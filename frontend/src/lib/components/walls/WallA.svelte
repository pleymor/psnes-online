<!--
  A. Le papier peint des années 90 : fusées, dinos, étoiles et gribouillis
  sur un turquoise, une frise à hauteur d'appui, le soubassement rayé.
  Trois calques : le mur, l'affiche et la fenêtre, les fanions et le mobile.
-->
<div class="layer" data-depth="0.12">
  <svg class="fill" aria-hidden="true">
    <defs>
      <pattern id="a-paper" width="200" height="200" patternUnits="userSpaceOnUse">
        <rect width="200" height="200" fill="#2a8a95" />
        <rect x="100" width="100" height="200" fill="#2c8f9a" />
        <!-- Étoile -->
        <polygon points="36,14 42,30 59,30 45,40 50,56 36,46 22,56 27,40 13,30 30,30" fill="#ffd23f" />
        <!-- Fusée -->
        <g transform="translate(132 26) rotate(35)">
          <path d="M0 -26 C10 -14 10 8 7 16 H-7 C-10 8 -10 -14 0 -26Z" fill="#fdf6e3" />
          <path d="M0 -26 C5 -20 7 -15 7 -12 H-7 C-7 -15 -5 -20 0 -26Z" fill="#e8402a" />
          <circle cy="-2" r="4.5" fill="#3aa0d8" stroke="#1d4a86" stroke-width="2" />
          <path d="M-7 6 L-14 18 L-7 16Z M7 6 L14 18 L7 16Z" fill="#e8402a" />
          <path d="M-4 16 L0 28 L4 16Z" fill="#ffb347" />
        </g>
        <!-- Dino -->
        <path
          d="M28 150 c0-14 10-22 24-22 c8 0 12-10 20-12 c6-1 10 3 8 7 c-2 3-7 3-8 6 c4 6 4 14 0 21 l6 12 h-7 l-5-9 c-6 3-14 3-20 0 l-4 9 h-7 l3-12 c-6-2-14 2-22 6 c4-6 8-8 12-6z"
          fill="#7ccf5a"
        />
        <circle cx="74" cy="121" r="1.6" fill="#1e3a1e" />
        <!-- Gribouillis -->
        <path d="M118 140 q8 -14 16 0 t16 0 t16 0" fill="none" stroke="#ff7eb6" stroke-width="5" stroke-linecap="round" />
        <!-- Confettis -->
        <polygon points="160,92 172,112 148,112" fill="#8a5cf0" />
        <circle cx="96" cy="86" r="5" fill="#ffd23f" />
        <rect x="18" y="84" width="10" height="10" fill="#ff7eb6" transform="rotate(20 23 89)" />
        <circle cx="178" cy="176" r="3" fill="#fdf6e3" />
        <circle cx="112" cy="190" r="3" fill="#fdf6e3" />
        <circle cx="12" cy="196" r="3" fill="#8a5cf0" />
      </pattern>
      <pattern id="a-frieze" width="48" height="34" patternUnits="userSpaceOnUse">
        <rect width="48" height="34" fill="#6c3fc4" />
        <path d="M0 26 L12 10 L24 26 L36 10 L48 26" fill="none" stroke="#ffd23f" stroke-width="5" />
        <rect y="0" width="48" height="4" fill="#fdf6e3" />
        <rect y="30" width="48" height="4" fill="#fdf6e3" />
      </pattern>
      <pattern id="a-dado" width="28" height="10" patternUnits="userSpaceOnUse">
        <rect width="28" height="10" fill="#1f6f7a" />
        <rect width="14" height="10" fill="#236f7a" />
        <rect x="13" width="2" height="10" fill="#1a5d67" />
      </pattern>
    </defs>
    <rect width="100%" height="100%" fill="url(#a-paper)" />
  </svg>
  <!-- La frise à hauteur d'appui, et sous elle le soubassement. -->
  <svg class="lower" aria-hidden="true">
    <rect width="100%" height="34" fill="url(#a-frieze)" />
    <rect y="34" width="100%" height="100%" fill="url(#a-dado)" />
    <rect y="34" width="100%" height="6" fill="#000" opacity=".18" />
  </svg>
</div>

<div class="layer" data-depth="0.45">
  <!-- La fenêtre, un jour de beau temps. -->
  <div class="item window">
    <svg viewBox="0 0 180 210" aria-hidden="true">
      <rect x="4" y="4" width="172" height="190" rx="6" fill="#fdf6e3" />
      <rect x="16" y="16" width="148" height="166" fill="#8fd3ff" />
      <rect x="16" y="120" width="148" height="62" fill="#b8e6ff" />
      <circle cx="130" cy="52" r="18" fill="#ffd23f" />
      <path d="M30 96 a14 14 0 0 1 24 -8 a16 16 0 0 1 30 4 a10 10 0 0 1 0 20 h-50 a10 10 0 0 1 -4 -16z" fill="#fff" />
      <path d="M100 140 a10 10 0 0 1 18 -6 a12 12 0 0 1 22 3 a8 8 0 0 1 0 15 h-36 a8 8 0 0 1 -4 -12z" fill="#fff" opacity=".9" />
      <rect x="86" y="16" width="8" height="166" fill="#fdf6e3" />
      <rect x="16" y="95" width="148" height="8" fill="#fdf6e3" />
      <rect x="0" y="188" width="180" height="14" rx="4" fill="#e9dcb8" />
      <!-- Les rideaux vichy. -->
      <path d="M4 4 h44 c-6 60 -22 110 -36 140 l-8 0z" fill="#e8402a" opacity=".92" />
      <path d="M176 4 h-44 c6 60 22 110 36 140 l8 0z" fill="#e8402a" opacity=".92" />
    </svg>
  </div>
  <!-- L'affiche, scotchée de travers. -->
  <div class="item poster">
    <svg viewBox="0 0 140 190" aria-hidden="true">
      <rect width="140" height="190" fill="#2b1f5c" />
      <circle cx="30" cy="30" r="2" fill="#fff" /><circle cx="110" cy="22" r="2.5" fill="#ffd23f" />
      <circle cx="96" cy="150" r="2" fill="#fff" /><circle cx="20" cy="120" r="1.5" fill="#fff" />
      <ellipse cx="70" cy="86" rx="58" ry="14" fill="none" stroke="#ffd23f" stroke-width="6" transform="rotate(-18 70 86)" />
      <circle cx="70" cy="86" r="32" fill="#ff8a3d" />
      <path d="M42 76 q28 -10 56 0" stroke="#e8602a" stroke-width="6" fill="none" />
      <path d="M26 100 q44 -24 88 -30" fill="none" stroke="#ffd23f" stroke-width="6" />
      <text x="70" y="160" text-anchor="middle" font-family="Arial Black, Arial, sans-serif" font-weight="900" font-size="22" fill="#ffd23f">PLANÈTE X</text>
      <rect x="-6" y="-4" width="34" height="12" fill="#fdf6e3" opacity=".75" transform="rotate(-20 11 2)" />
      <rect x="112" y="-4" width="34" height="12" fill="#fdf6e3" opacity=".75" transform="rotate(20 129 2)" />
    </svg>
  </div>
</div>

<div class="layer" data-depth="0.9">
  <!-- Les fanions, tendus sous la barre. -->
  <svg class="bunting" aria-hidden="true">
    <defs>
      <pattern id="a-flags" width="260" height="70" patternUnits="userSpaceOnUse">
        <path d="M0 6 Q130 40 260 6" fill="none" stroke="#fdf6e3" stroke-width="2" />
        <polygon points="18,11 44,17 27,44" fill="#ffd23f" />
        <polygon points="62,20 90,24 72,52" fill="#e8402a" />
        <polygon points="110,24 138,24 124,54" fill="#8a5cf0" />
        <polygon points="160,23 188,20 176,50" fill="#7ccf5a" />
        <polygon points="208,17 234,11 225,40" fill="#ff7eb6" />
      </pattern>
    </defs>
    <rect width="100%" height="70" fill="url(#a-flags)" />
  </svg>
  <!-- Le mobile : une planète au bout de son fil. -->
  <div class="item mobile">
    <svg viewBox="0 0 70 170" aria-hidden="true">
      <line x1="35" y1="0" x2="35" y2="112" stroke="#fdf6e3" stroke-width="1.5" />
      <ellipse cx="35" cy="134" rx="32" ry="8" fill="none" stroke="#8a5cf0" stroke-width="5" transform="rotate(-14 35 134)" />
      <circle cx="35" cy="134" r="20" fill="#ffd23f" />
      <path d="M17 128 q18 -6 36 0" stroke="#e8a33c" stroke-width="4" fill="none" />
      <path d="M5 142 q30 -14 60 -16" fill="none" stroke="#8a5cf0" stroke-width="5" />
    </svg>
  </div>
</div>

<style>
  /* Un calque déborde de 24 px : chaque coordonnée les ajoute. */
  .window {
    top: calc(24px + 92px);
    right: calc(24px + 3cqw);
    width: 180px;
  }

  .poster {
    top: calc(24px + 30cqh);
    left: calc(24px + 1.2cqw);
    width: 112px;
    transform: rotate(-5deg);
  }

  .lower {
    position: absolute;
    top: 68%;
    left: 0;
    width: 100%;
    height: 40%;
  }

  .bunting {
    position: absolute;
    top: calc(24px + 54px);
    left: 0;
    width: 100%;
    height: 70px;
  }

  .mobile {
    top: calc(24px + 54px);
    right: calc(24px + 2cqw + 190px);
    width: 64px;
  }

  @container (max-width: 768px) {
    .window { top: calc(24px + 72px); right: calc(24px + 8px); width: 104px; }
    .poster { top: calc(24px + 52cqh); left: calc(24px + 4px); width: 76px; }
    .mobile { display: none; }
  }
</style>
