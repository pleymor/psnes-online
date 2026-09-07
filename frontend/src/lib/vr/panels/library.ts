/**
 * The left lectern: which games this headset can actually open.
 *
 * The list is already filtered by `deviceLibrary()` before it arrives, so the
 * only rule this module carries is the consequence of that filter: there are
 * TWO empty libraries and they must not share a message. "Your library is
 * empty" said to someone who owns two hundred games is precisely the lie
 * `roms/device-library.ts` exists to prevent, and `+page.svelte:496` already
 * keeps the two apart on the flat screen.
 *
 * In a headset the second message needs one more sentence than it does on the
 * flat page: there is no file picker in an immersive session, so the only
 * useful instruction is to leave, add the games, and come back.
 *
 * Layout is pure and returns regions; drawing consumes them. That split is what
 * `panel.ts` exists for, and it is why everything above is checkable under Bun.
 */

import { fitContain, intrinsicSize, truncate, type PanelSize, type Region } from '../panel';
import type { Game } from '$lib/stores/games';

/** Canvas pixels. Mapped onto the 0.7 x 0.5 m lectern `layout.ts` places. */
export const LIBRARY_PANEL_SIZE: PanelSize = { width: 1120, height: 840 };

const PAD = 34;
const HEADER = 78;
const COLUMNS = 3;
const GAP = 22;
const SCROLL_W = 78;
/*
 * The scroll buttons get a gutter of their own rather than floating over the
 * grid's right-hand column.
 *
 * They used to share that space, and `hit()` returns the first match - so the
 * tile drawn underneath swallowed every press on the up arrow. It is the kind
 * of overlap a no-overlap test misses if it only ever exercises the unscrolled
 * state, where the up arrow does not exist yet.
 */
const GUTTER = SCROLL_W + GAP;
const TILE_W = Math.floor(
  (LIBRARY_PANEL_SIZE.width - PAD * 2 - GUTTER - GAP * (COLUMNS - 1)) / COLUMNS
);
/**
 * The cover slot's height, and the largest it can be.
 *
 * It was 150. The covers were too small in the headset, and the lever is this
 * number rather than `COLUMNS`: box art is portrait, so its height is what
 * binds it, and widening the tile to two columns would have made a portrait
 * cover no bigger at all while halving how many games fit.
 *
 * 212 is the ceiling. `VISIBLE_ROWS` below divides the 520 usable pixels by
 * `COVER_H + TITLE_H + GAP`, so 212 is the last value that still leaves two
 * rows: one pixel more drops the grid to a single row of three and costs the
 * player half their library to a scroll they did not need. So this buys 41 per
 * cent more cover for nothing, and there is no more to be had here -
 * `vr-panel-library.test.ts` pins both ends of that.
 *
 * Exported because the tests derive the drawn rectangle from it rather than
 * restating it, which is what stops them going stale the next time it moves.
 */
export const COVER_H = 297;
const TITLE_H = 45;
const TILE_H = COVER_H + TITLE_H;

/** Rows that fit under the header. */
const VISIBLE_ROWS = Math.floor((LIBRARY_PANEL_SIZE.height - HEADER - PAD) / (TILE_H + GAP));

export type LibraryEmptiness = 'has-games' | 'library-empty' | 'none-on-this-device';

export interface LibraryState {
  /** Already filtered by `deviceLibrary()`. */
  games: Game[];
  /** What the account owns, which is what makes the second message true. */
  ownedTotal: number;
  /** Index of the first visible row. */
  scroll: number;
}

export interface LibraryLabels {
  heading: string;
  emptyLibrary: string;
  emptyLibraryHint: string;
  /** Already interpolated with the count by the caller. */
  noneHere: string;
  noneHereHint: string;
}

export function libraryEmptiness(state: LibraryState): LibraryEmptiness {
  if (state.games.length > 0) return 'has-games';
  return state.ownedTotal > 0 ? 'none-on-this-device' : 'library-empty';
}

/** How many rows the whole list needs. */
export function libraryRows(state: LibraryState): number {
  return Math.ceil(state.games.length / COLUMNS);
}

/**
 * A scroll offset that exists.
 *
 * Clamped rather than wrapped: there is no scrollbar in here to show a player
 * they have reached the end, so jumping back to the top would read as the list
 * having reloaded itself.
 */
export function clampScroll(scroll: number, rows: number): number {
  if (rows <= 0) return 0;
  return Math.max(0, Math.min(Math.floor(scroll), rows - 1));
}

export function layoutLibraryPanel(state: LibraryState): Region[] {
  if (libraryEmptiness(state) !== 'has-games') return [];

  const rows = libraryRows(state);
  const scroll = clampScroll(state.scroll, rows);
  const regions: Region[] = [];

  for (let row = 0; row < VISIBLE_ROWS; row++) {
    for (let column = 0; column < COLUMNS; column++) {
      const index = (scroll + row) * COLUMNS + column;
      const game = state.games[index];
      if (!game) continue;
      regions.push({
        id: `game:${game.id}`,
        x: PAD + column * (TILE_W + GAP),
        y: HEADER + row * (TILE_H + GAP),
        w: TILE_W,
        h: TILE_H
      });
    }
  }

  // Only where they lead somewhere: a button that does nothing is worse than
  // an absent one, because it invites the press that proves it is broken.
  // `right` is inside the reserved gutter, so these can never overlap a tile.
  const right = LIBRARY_PANEL_SIZE.width - PAD - SCROLL_W;
  if (scroll > 0) {
    regions.push({ id: 'scroll:up', x: right, y: HEADER, w: SCROLL_W, h: SCROLL_W });
  }
  if (scroll + VISIBLE_ROWS < rows) {
    regions.push({
      id: 'scroll:down',
      x: right,
      y: LIBRARY_PANEL_SIZE.height - PAD - SCROLL_W,
      w: SCROLL_W,
      h: SCROLL_W
    });
  }

  return regions;
}

export function drawLibraryPanel(
  ctx: CanvasRenderingContext2D,
  state: LibraryState,
  regions: readonly Region[],
  opts: {
    labels: LibraryLabels;
    hoverId: string | null;
    /** Keyed by game id. Absent until the image has loaded. */
    covers: Map<string, CanvasImageSource>;
  }
): void {
  const { width, height } = LIBRARY_PANEL_SIZE;

  ctx.save();
  /*
   * The good downscale filter, and why it is not cosmetic.
   *
   * The covers arrive at full size (`/api/covers/<id>`, or a libretro
   * thumbnail) and land in a 216 x 150 slot, so every one of them is minified
   * several times over. At the default quality the browser point-samples that
   * reduction - it skips source pixels rather than averaging them - which
   * bakes aliasing into the canvas before three ever uploads it. In a headset
   * that reads as covers that shimmer whenever the head moves, and no texture
   * filtering downstream can recover detail the 2D context already discarded.
   */
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#14141c';
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = '#ffffff';
  ctx.font = '600 42px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText(opts.labels.heading, PAD, HEADER / 2);

  const emptiness = libraryEmptiness(state);
  if (emptiness !== 'has-games') {
    const heading =
      emptiness === 'library-empty' ? opts.labels.emptyLibrary : opts.labels.noneHere;
    const hint =
      emptiness === 'library-empty' ? opts.labels.emptyLibraryHint : opts.labels.noneHereHint;

    ctx.textAlign = 'center';
    ctx.font = '600 39px system-ui, sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(heading, width / 2, height / 2 - 20);
    ctx.font = '28px system-ui, sans-serif';
    ctx.fillStyle = '#a0a0b0';
    ctx.fillText(hint, width / 2, height / 2 + 20);
    ctx.restore();
    return;
  }

  const byId = new Map(state.games.map((game) => [`game:${game.id}`, game]));

  for (const region of regions) {
    if (region.id === 'scroll:up' || region.id === 'scroll:down') {
      ctx.fillStyle = opts.hoverId === region.id ? '#3a3a52' : '#22222e';
      ctx.fillRect(region.x, region.y, region.w, region.h);
      ctx.fillStyle = '#ffffff';
      ctx.font = '600 39px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(
        region.id === 'scroll:up' ? '▲' : '▼',
        region.x + region.w / 2,
        region.y + region.h / 2
      );
      continue;
    }

    const game = byId.get(region.id);
    if (!game) continue;

    ctx.fillStyle = '#1e1e2a';
    ctx.fillRect(region.x, region.y, region.w, COVER_H);

    const cover = opts.covers.get(game.id);
    if (cover) {
      // Its own proportions inside the slot, not the slot's. The slot is
      // landscape and box art is portrait, so the old `region.w, COVER_H` pair
      // squashed every cover by about a third. `panel.ts` carries the why.
      const fitted = fitContain(intrinsicSize(cover), {
        x: region.x,
        y: region.y,
        w: region.w,
        h: COVER_H
      });
      ctx.drawImage(cover, fitted.x, fitted.y, fitted.w, fitted.h);
    }

    // The title is drawn whether or not the cover loaded: an unidentified game
    // is still a game the player owns, and a blank tile is unlaunchable in
    // practice because nobody presses what they cannot read.
    ctx.fillStyle = '#ffffff';
    ctx.font = '25px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(
      truncate(ctx, game.title, region.w - 8),
      region.x + 4,
      region.y + COVER_H + TITLE_H / 2
    );

    if (opts.hoverId === region.id) {
      ctx.strokeStyle = '#7aa2ff';
      ctx.lineWidth = 4;
      ctx.strokeRect(region.x - 2, region.y - 2, region.w + 4, TILE_H + 4);
    }
  }

  ctx.restore();
}
