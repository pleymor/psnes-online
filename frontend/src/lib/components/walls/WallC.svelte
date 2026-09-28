<!--
  C. La chambre douce : un mur lavande qui descend vers le rose, un ciel de
  nuit en stickers (lune, étoiles, nuages), une guirlande lumineuse et une
  lampe de chevet. Des teintes calmes, pour une longue soirée à choisir.
-->
<script lang="ts">
  // Les ampoules de la guirlande, sur un feston de 220 px répété.
  const BULBS = [
    [22, 17], [66, 30], [110, 34], [154, 30], [198, 17]
  ];
  // Les étoiles du ciel en stickers : position en %, taille en px.
  const STARS: [number, number, number][] = [
    [8, 30, 16], [20, 56, 11], [4, 78, 14], [92, 44, 12], [86, 70, 18],
    [95, 86, 10], [50, 24, 9], [62, 52, 8], [36, 64, 10], [74, 92, 12], [16, 92, 9]
  ];
</script>

<div class="layer" data-depth="0.1">
  <div class="fill paint"></div>
  <svg class="fill" aria-hidden="true">
    <defs>
      <pattern id="c-dots" width="46" height="46" patternUnits="userSpaceOnUse">
        <circle cx="10" cy="10" r="2" fill="#fff" opacity=".13" />
        <circle cx="33" cy="33" r="2" fill="#fff" opacity=".13" />
      </pattern>
    </defs>
    <rect width="100%" height="100%" fill="url(#c-dots)" />
  </svg>
</div>

<div class="layer" data-depth="0.35">
  <!-- La lune, un croissant crème. -->
  <div class="item moon">
    <svg viewBox="0 0 120 120" aria-hidden="true">
      <path d="M80 8 A54 54 0 1 0 112 84 A44 44 0 1 1 80 8Z" fill="#fff4d6" />
      <circle cx="44" cy="72" r="5" fill="#f4e4bc" /><circle cx="30" cy="48" r="3.5" fill="#f4e4bc" />
    </svg>
  </div>
  {#each STARS as [x, y, size]}
    <svg class="item star" style="left: calc(24px + {x}%); top: calc(24px + {y}%); width: {size}px" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M10 0 C11 7 13 9 20 10 C13 11 11 13 10 20 C9 13 7 11 0 10 C7 9 9 7 10 0Z" fill="#ffe9a8" />
    </svg>
  {/each}
  <!-- Deux nuages en sticker. -->
  <svg class="item cloud cloud-1" viewBox="0 0 160 70" aria-hidden="true">
    <path d="M24 64 a22 22 0 0 1 6 -43 a30 30 0 0 1 56 -6 a24 24 0 0 1 44 16 a22 22 0 0 1 6 33z" fill="#fff" opacity=".55" />
  </svg>
  <svg class="item cloud cloud-2" viewBox="0 0 160 70" aria-hidden="true">
    <path d="M24 64 a22 22 0 0 1 6 -43 a30 30 0 0 1 56 -6 a24 24 0 0 1 44 16 a22 22 0 0 1 6 33z" fill="#fff" opacity=".45" />
  </svg>
</div>

<div class="layer" data-depth="0.8">
  <!-- La guirlande, en festons sous la barre. -->
  <svg class="garland" aria-hidden="true">
    <defs>
      <radialGradient id="c-glow">
        <stop offset="0" stop-color="#ffd88a" stop-opacity=".75" />
        <stop offset="1" stop-color="#ffd88a" stop-opacity="0" />
      </radialGradient>
      <pattern id="c-lights" width="220" height="64" patternUnits="userSpaceOnUse">
        <path d="M0 6 Q110 62 220 6" fill="none" stroke="#5a4a6e" stroke-width="1.6" />
        {#each BULBS as [x, y], i}
          <circle cx={x} cy={y + 6} r="13" fill="url(#c-glow)" class:dim={i % 2 === 1} />
          <rect x={x - 2} y={y - 3} width="4" height="4" fill="#5a4a6e" />
          <ellipse cx={x} cy={y + 5} rx="3.6" ry="5" fill={i % 2 ? '#ffc7d9' : '#fff1c1'} />
        {/each}
      </pattern>
    </defs>
    <rect width="100%" height="64" fill="url(#c-lights)" />
  </svg>
  <!-- La lampe de chevet et son halo. -->
  <div class="item halo"></div>
  <div class="item lamp">
    <svg viewBox="0 0 120 170" aria-hidden="true">
      <path d="M30 20 h60 l20 56 h-100z" fill="#bfe8d6" />
      <path d="M30 20 h60 l4 10 h-68z" fill="#d9f3e8" />
      <path d="M10 76 h100 v6 h-100z" fill="#9fd4bd" />
      <rect x="56" y="82" width="8" height="52" fill="#f3d6e4" />
      <path d="M26 162 q34 -40 68 0z" fill="#f3b8cf" />
      <rect x="22" y="160" width="76" height="8" rx="4" fill="#e59ab9" />
    </svg>
  </div>
</div>

<style>
  .paint {
    background: linear-gradient(180deg, #5d4f9c 0%, #8a74b8 45%, #c996b8 80%, #e0a8b4 100%);
  }

  .moon {
    top: calc(24px + 96px);
    right: calc(24px + 4cqw);
    width: 120px;
  }

  .star {
    position: absolute;
    height: auto;
  }

  .cloud { width: 170px; }
  .cloud-1 { top: calc(24px + 30cqh); left: calc(24px - 40px); }
  .cloud-2 { top: calc(24px + 62cqh); right: calc(24px - 30px); }

  .garland {
    position: absolute;
    top: calc(24px + 52px);
    left: 0;
    width: 100%;
    height: 64px;
  }

  /* Une ampoule sur deux plus faible, et immobile : animée, elle ferait
     repeindre toute la guirlande - un motif SVG - à chaque frame. */
  .garland :global(.dim) {
    opacity: 0.55;
  }

  .lamp {
    left: calc(24px + 1cqw);
    bottom: calc(24px + 8px);
    width: 110px;
  }

  .halo {
    left: calc(24px + 1cqw - 110px);
    bottom: calc(24px - 40px);
    width: 340px;
    height: 340px;
    border-radius: 50%;
    background: radial-gradient(closest-side, rgba(255, 226, 160, 0.45), rgba(255, 226, 160, 0));
  }

  @container (max-width: 768px) {
    .moon { top: calc(24px + 76px); right: calc(24px + 14px); width: 64px; }
    .lamp { width: 64px; left: calc(24px + 2px); }
    .halo { width: 200px; height: 200px; left: calc(24px - 70px); }
    .cloud { width: 110px; }
  }
</style>
