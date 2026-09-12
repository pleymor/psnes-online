/**
 * The launch screen, drawn on the curved screen because no game is running yet.
 *
 * Three rules are load-bearing.
 *
 * A save list the player may not act on is DRAWN and carries no regions. That
 * is the whole of decision D3: the server refuses a save staged by anyone but
 * the room's creator, so offering the click would earn an `error` that nothing
 * in a headset displays - while hiding the list would leave a guest unable to
 * see what they are about to join, which is the thing the rule exists to
 * prevent.
 *
 * A blocked launch carries no `launch` region. The button cannot be present
 * and dead: a press that does nothing is indistinguishable from a headset that
 * has stopped responding.
 *
 * And the chosen save is marked by something other than a colour. Two states
 * whose only difference is a fill produce an identical list of `fillText`
 * calls, and a test for "the choice is visible" would have nothing to compare -
 * the trap the profile band's preset cards already fell into.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  COVER_INSET,
  LAUNCH_PANEL_SIZE,
  layoutLaunchPanel,
  drawLaunchPanel,
  type LaunchLabels
} from '../../frontend/src/lib/vr/panels/launch.js';
import type { LaunchOptions } from '../../frontend/src/lib/vr/launch-options.js';
import { fieldFill } from '../../frontend/src/lib/vr/panels/chrome.js';

const LABELS: LaunchLabels = {
  newGame: 'New game',
  // The shipped English, not a placeholder: two tests below measure this
  // string, and a short stand-in would pass a width check the real wording
  // could fail - which is exactly how the banner came to run into the friend
  // line.
  saveLockedByCreator: 'Your friend chooses where this starts.',
  launch: 'Launch',
  port1: 'Player 1',
  port2: 'Player 2',
  waitingForFriend: 'Waiting for your friend',
  friendReady: 'Ready',
  friendAway: 'Away',
  romMissing: 'This game is not on this device. Launch it once outside VR.',
  romIncoming: 'Your friend will send you this game.',
  keepQuestion: 'Keep it on this device?',
  yes: 'Yes',
  no: 'No',
  // La vraie phrase, pas un bouchon : elle est mesuree plus bas, et un
  // remplacant court passerait une verification que le vrai libelle echoue.
  keepRomLegal: 'Only keep a game if you own the original cartridge.',
  alreadyPlaying: 'This room is already playing.',
  noSeat: 'Somebody has to take a controller first.',
  friendAwayBlocked: 'A player is away. Wait for them to come back before starting.'
};

const SHOT = 'data:image/png;base64,iVBORw0KGgo=';

const SAVES = [
  { id: 's1', primary: 'Before the boss', secondary: '03/09/2026 18:44', slotNumber: 1, screenshot: SHOT },
  { id: 's2', primary: 'Chapter two', secondary: '02/09/2026 09:12', slotNumber: 2, screenshot: SHOT }
];

/** A stand-in for a loaded `HTMLImageElement`; the painter only draws it. */
const IMAGE = { width: 320, height: 240 } as unknown as CanvasImageSource;

function options(over: Partial<LaunchOptions> = {}): LaunchOptions {
  return {
    game: { id: 'mine', title: 'Super Mario World', crc32: 'aaaa1111' },
    saves: SAVES,
    chosenSaveId: null,
    mayChooseSave: true,
    myPort: null,
    friend: null,
    romHere: true,
    romIncoming: false,
    blocked: null,
    ...over
  };
}

function recordingContext() {
  const texts: string[] = [];
  const calls: string[] = [];
  const placed: Array<{ text: string; x: number; y: number }> = [];
  const images: Array<{ x: number; y: number; w: number; h: number }> = [];
  return {
    texts,
    calls,
    placed,
    images,
    font: '', fillStyle: '', strokeStyle: '', lineWidth: 0,
    textAlign: 'left', textBaseline: 'alphabetic',
    imageSmoothingEnabled: false, imageSmoothingQuality: 'low',
    save() {}, restore() {}, clearRect() {}, fillRect() { calls.push('fillRect'); },
    strokeRect() { calls.push('strokeRect'); },
    beginPath() {}, arc() { calls.push('arc'); }, fill() {}, stroke() {},
    drawImage(_img: unknown, x: number, y: number, w: number, h: number) {
      calls.push('drawImage');
      images.push({ x, y, w, h });
    },
    fillText(text: string, x: number, y: number) {
      texts.push(text);
      placed.push({ text, x, y });
    },
    measureText(text: string) { return { width: text.length * 9 }; }
  } as unknown as CanvasRenderingContext2D & {
    texts: string[];
    calls: string[];
    placed: Array<{ text: string; x: number; y: number }>;
    images: Array<{ x: number; y: number; w: number; h: number }>;
    imageSmoothingEnabled: boolean;
    imageSmoothingQuality: string;
  };
}

function draw(
  o: LaunchOptions,
  hoverId: string | null = null,
  pictures: {
    covers?: Map<string, CanvasImageSource>;
    shots?: Map<string, CanvasImageSource>;
    keepRom?: boolean;
    transfer?: string | null;
  } = {}
) {
  const ctx = recordingContext();
  drawLaunchPanel(ctx, o, layoutLaunchPanel(o, LABELS), {
    labels: LABELS,
    hoverId,
    covers: pictures.covers ?? new Map(),
    shots: pictures.shots ?? new Map(),
    keepRom: pictures.keepRom ?? false,
    transfer: pictures.transfer ?? null
  });
  return ctx;
}

test('every save is offered, and so is starting fresh', () => {
  const ids = layoutLaunchPanel(options(), LABELS).map((r) => r.id);
  assert.ok(ids.includes('save:none'), 'starting over must always be reachable');
  assert.ok(ids.includes('save:s1'));
  assert.ok(ids.includes('save:s2'));
});

test('a save list the player may not act on is drawn, and carries no regions', () => {
  const locked = options({ mayChooseSave: false, chosenSaveId: 's1' });
  const ids = layoutLaunchPanel(locked, LABELS).map((r) => r.id);

  assert.ok(!ids.some((id) => id.startsWith('save:')), 'the server would refuse these clicks');

  const drawn = draw(locked).texts.join('\n');
  assert.ok(drawn.includes('Before the boss'), 'a guest has to see what they are joining');
  assert.ok(drawn.includes(LABELS.saveLockedByCreator), 'and why they cannot change it');
});

test('the ports are offered only when there is a group', () => {
  const alone = layoutLaunchPanel(options(), LABELS).map((r) => r.id);
  assert.ok(!alone.includes('port:1'), 'there is no port to pick alone');

  const grouped = layoutLaunchPanel(
    options({ friend: { pseudo: 'Bob', online: true, port: 2, isReady: true } }),
    LABELS
  ).map((r) => r.id);
  assert.ok(grouped.includes('port:1'));
  assert.ok(grouped.includes('port:2'));
});

test('a blocked launch has no launch region, and says which block it is', () => {
  for (const [blocked, label] of [
    ['rom-missing', LABELS.romMissing],
    ['already-playing', LABELS.alreadyPlaying],
    ['no-seat', LABELS.noSeat],
    ['friend-away', LABELS.friendAwayBlocked]
  ] as const) {
    const o = options({ blocked, romHere: blocked !== 'rom-missing' });
    const ids = layoutLaunchPanel(o, LABELS).map((r) => r.id);
    assert.ok(!ids.includes('launch'), `a dead ${blocked} button reads as a frozen headset`);
    assert.ok(draw(o).texts.includes(label), `${blocked} was not explained`);
  }
});

test('an unblocked launch has its region', () => {
  assert.ok(layoutLaunchPanel(options(), LABELS).map((r) => r.id).includes('launch'));
});

test('the chosen save is marked by more than a colour', () => {
  // Two states differing only by a fill draw the identical set of fillText
  // calls, and "the choice is visible" would have nothing to compare.
  const none = draw(options({ chosenSaveId: null })).texts;
  const one = draw(options({ chosenSaveId: 's1' })).texts;
  assert.notDeepEqual(none, one, 'nothing on the canvas says which save is chosen');
});

test('the friend is named with their state', () => {
  const drawn = draw(
    options({ friend: { pseudo: 'Bob', online: true, port: 2, isReady: true } })
  ).texts.join('\n');
  assert.ok(drawn.includes('Bob'));
});

test('no arrangement puts a region off the panel or on top of another', () => {
  /*
   * Every arrangement, not one of them - and that is the correction.
   *
   * This test used to build a single fixture with two saves, where nothing
   * could collide. With four saves or more the fifth and sixth rows reached
   * y 584..708 and overlapped a launch button centred at x 312..712: two
   * hit-testable regions on top of each other, on a curved texture with no
   * layout engine to notice, and the test read as guarding it. The button now
   * lives outside the save column entirely, so no row count can reach it -
   * but the fixture is what let the bug in, so the fixture is what changed.
   */
  const counts = [0, 1, 2, 5, 8];
  const friends = [null, { pseudo: 'Bob', online: true, port: null, isReady: false }] as const;
  const blocks = [null, 'no-seat'] as const;

  for (const count of counts) {
    for (const friend of friends) {
      for (const blocked of blocks) {
        for (const mayChooseSave of [true, false]) {
          const o = options({
            saves: Array.from({ length: count }, (_, i) => ({
              id: `s${i}`,
              primary: `Save ${i}`,
              secondary: '01/09/2026 20:30',
              slotNumber: i + 1,
              screenshot: SHOT
            })),
            friend,
            blocked,
            mayChooseSave
          });
          const regions = layoutLaunchPanel(o, LABELS);
          const where = `saves=${count} friend=${!!friend} blocked=${blocked} may=${mayChooseSave}`;

          for (const r of regions) {
            assert.ok(r.x >= 0 && r.y >= 0, `${r.id} starts off-panel (${where})`);
            assert.ok(
              r.x + r.w <= LAUNCH_PANEL_SIZE.width,
              `${r.id} runs off the right (${where})`
            );
            assert.ok(
              r.y + r.h <= LAUNCH_PANEL_SIZE.height,
              `${r.id} runs off the bottom (${where})`
            );
          }
          for (let i = 0; i < regions.length; i++) {
            for (let j = i + 1; j < regions.length; j++) {
              const a = regions[i];
              const b = regions[j];
              const apart =
                a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
              assert.ok(apart, `${a.id} overlaps ${b.id} (${where})`);
            }
          }
        }
      }
    }
  }
});

test('the locked-save banner stays clear of the friend line', () => {
  /*
   * Text, not regions, so the overlap test above cannot see it - and this is
   * the one case the banner exists for: a guest who cannot pick the save,
   * looking at a room their friend occupies. At full panel width the banner
   * ran to x 589 while "Bob — Ready" starts at 560.
   */
  const ctx = draw(
    options({
      mayChooseSave: false,
      friend: { pseudo: 'Bob', online: true, port: 2, isReady: true }
    })
  );
  const banner = ctx.placed.find((p) => p.text === LABELS.saveLockedByCreator);
  const friendLine = ctx.placed.find((p) => p.text.includes('Bob'));

  assert.ok(banner && friendLine, 'both lines must be drawn in this state');
  // The fixture's own metric, as the other width tests use.
  assert.ok(
    banner.x + banner.text.length * 9 <= friendLine.x,
    `the banner reaches ${banner.x + banner.text.length * 9}px, the friend line starts at ${friendLine.x}px`
  );
});

test('the save list is capped, not merely offered', () => {
  const many = Array.from({ length: 8 }, (_, i) => ({
    id: `s${i}`,
    primary: `Save ${i}`,
    secondary: null,
    slotNumber: i + 1,
    screenshot: null
  }));
  const o = options({ saves: many });
  const ids = layoutLaunchPanel(o, LABELS)
    .map((r) => r.id)
    .filter((id) => id.startsWith('save:'));
  // save:none plus at most 5 of the 8 saves.
  assert.ok(ids.length <= 6, `the list did not cap: ${ids.length} save regions`);
  assert.ok(!ids.includes('save:s7'), 'an eighth save was offered past the cap');

  const drawn = draw(o).texts.join('\n');
  assert.ok(!drawn.includes('Save 7'), 'a capped save was drawn anyway');
});

// The friend line was only ever checked for the pseudo, never for which of
// the two state words it carries - so "always say waiting" would have
// passed every test above.
test('the friend line says ready only when the friend is ready', () => {
  const waiting = draw(
    options({ friend: { pseudo: 'Bob', online: true, port: 2, isReady: false } })
  ).texts.join('\n');
  assert.ok(waiting.includes(LABELS.waitingForFriend), 'not-ready must say waiting');
  assert.ok(!waiting.includes(LABELS.friendReady), 'not-ready must not also claim ready');

  const ready = draw(
    options({ friend: { pseudo: 'Bob', online: true, port: 2, isReady: true } })
  ).texts.join('\n');
  assert.ok(ready.includes(LABELS.friendReady), 'ready must say ready');
  assert.ok(!ready.includes(LABELS.waitingForFriend), 'ready must not also claim waiting');
});

// `FriendState.online` was computed and never drawn: a friend who closed
// their tab kept their port and `isReady`, so the line above would have kept
// reading "Ready" with nobody there to have pressed anything.
test('the friend line says away when the friend is offline, whatever their port says', () => {
  const awayButReady = draw(
    options({ friend: { pseudo: 'Bob', online: false, port: 2, isReady: true } })
  ).texts.join('\n');
  assert.ok(awayButReady.includes(LABELS.friendAway), 'offline must say away');
  assert.ok(!awayButReady.includes(LABELS.friendReady), 'a stale "ready" must not survive the friend leaving');
  assert.ok(!awayButReady.includes(LABELS.waitingForFriend), 'nor a stale "waiting"');

  const present = draw(
    options({ friend: { pseudo: 'Bob', online: true, port: 2, isReady: true } })
  ).texts.join('\n');
  assert.ok(!present.includes(LABELS.friendAway), 'online must not also claim away');
});

// No test above ever passed a hoverId, so the outline block could be
// deleted outright and nothing would notice.
test('a hovered region draws an outline that an unhovered one does not', () => {
  const o = options();
  const regions = layoutLaunchPanel(o, LABELS);
  const unhovered = draw(o, null).calls.filter((c) => c === 'strokeRect').length;
  const hovered = draw(o, 'launch').calls.filter((c) => c === 'strokeRect').length;
  assert.ok(regions.some((r) => r.id === 'launch'), 'fixture needs a launch region to hover');
  assert.ok(hovered > unhovered, 'hovering drew no extra outline');
});

test('a banner too long for its column is cut to it, not to the panel', () => {
  /*
   * The shipped wording fits 470px whole, so the test above passes whatever
   * the truncation bound is - it guards the outcome, not the rule. A future
   * translation is what the bound exists for, and this is what pins it: a
   * label that must be cut, and a column it must be cut to.
   */
  const long = { ...LABELS, saveLockedByCreator: 'X'.repeat(200) };
  const o = options({
    mayChooseSave: false,
    friend: { pseudo: 'Bob', online: true, port: 2, isReady: true }
  });
  const ctx = recordingContext();
  drawLaunchPanel(ctx, o, layoutLaunchPanel(o, long), {
    labels: long,
    hoverId: null,
    covers: new Map(),
    shots: new Map()
  });

  const banner = ctx.placed.find((p) => p.text.startsWith('X'));
  const friendLine = ctx.placed.find((p) => p.text.includes('Bob'));
  assert.ok(banner && friendLine, 'both lines must be drawn in this state');
  assert.ok(
    banner.x + banner.text.length * 9 <= friendLine.x,
    `a long banner reached ${banner.x + banner.text.length * 9}px, past the friend line at ${friendLine.x}px`
  );
});

test('a long save name is truncated rather than run into the ports', () => {
  const o = options({
    saves: [
      {
        id: 's1',
        primary: 'A'.repeat(200),
        secondary: '03/09/2026 18:44',
        slotNumber: 1,
        screenshot: SHOT
      }
    ],
    friend: { pseudo: 'Bob', online: true, port: 2, isReady: true }
  });
  const region = layoutLaunchPanel(o, LABELS).find((r) => r.id === 'save:s1');
  const drawn = draw(o).placed.find((p) => p.text.startsWith('A'));

  assert.ok(region && drawn, 'the save was not drawn');
  // The fixture's own metric, the same one the profile band's test uses.
  assert.ok(
    drawn.x + drawn.text.length * 9 <= region.x + region.w,
    'a long name escaped its row'
  );
});

/*
 * The pictures, and why they were absent rather than broken.
 *
 * This panel shipped drawing a grey rectangle where the cover belongs, with a
 * comment saying a real one would mean handing this module the same `covers`
 * map and the same per-URL CORS handling `VrShell` already has. It would not:
 * `VrShell` resolves CORS at LOAD time and a tainting image never enters the
 * map at all, so what reaches here is always safe to draw. The map is now
 * simply passed, and the placeholder stays underneath for a game with no art.
 *
 * Save thumbnails are `data:` URLs and cannot taint anything, so they had no
 * excuse in the first place.
 */

test('the cover is drawn when it has loaded, and the placeholder when it has not', () => {
  const withArt = draw(options(), null, { covers: new Map([['mine', IMAGE]]) });
  assert.ok(withArt.calls.includes('drawImage'), 'the cover never reached the canvas');

  const without = draw(options());
  assert.ok(
    !without.images.some((i) => i.y < 264),
    'nothing should be drawn in the cover box before the image loads'
  );
});

test('the cover is looked up by game id, not by title', () => {
  // `VrShell` keys `covers` by `game.id`. A lookup by anything else finds
  // nothing and silently falls back to the placeholder - the exact failure
  // this whole change exists to end.
  const wrongKey = draw(options(), null, { covers: new Map([['Super Mario World', IMAGE]]) });
  assert.ok(!wrongKey.calls.includes('drawImage'), 'the cover was found under the wrong key');
});

test('each save row draws its thumbnail and both of its lines', () => {
  const ctx = draw(options(), null, {
    shots: new Map([
      ['s1', IMAGE],
      ['s2', IMAGE]
    ])
  });

  const drawn = ctx.texts.join('\n');
  assert.ok(drawn.includes('Before the boss'), 'the name is missing');
  assert.ok(drawn.includes('03/09/2026 18:44'), 'the moment is missing');
  assert.equal(ctx.images.length, 2, 'one thumbnail per save that has one');
});

test('a save with no thumbnail still draws its lines', () => {
  const ctx = draw(
    options({
      saves: [{ id: 's1', primary: 'Before the boss', secondary: null, slotNumber: 1, screenshot: null }]
    })
  );
  assert.ok(ctx.texts.join('\n').includes('Before the boss'));
  assert.equal(ctx.images.length, 0);
});

test('"start fresh" has no thumbnail, because there is nothing to depict', () => {
  const ctx = draw(options({ saves: [] }), null, { shots: new Map([['none', IMAGE]]) });
  assert.ok(ctx.texts.join('\n').includes(LABELS.newGame));
  assert.equal(ctx.images.length, 0, 'a new game was given a picture of something');
});

test('a thumbnail stays inside the row it belongs to', () => {
  /*
   * Geometry, not appearance. A thumbnail that overflows its row lands on the
   * neighbouring row's text on a curved texture with no layout engine to
   * notice - the same class of bug as the launch button that used to cross
   * the save column, which no test saw because no fixture built the case.
   */
  const regions = layoutLaunchPanel(options(), LABELS);
  const ctx = draw(options(), null, {
    shots: new Map([
      ['s1', IMAGE],
      ['s2', IMAGE]
    ])
  });

  for (const image of ctx.images) {
    const row = regions.find(
      (r) => r.id.startsWith('save:') && image.y >= r.y && image.y < r.y + r.h
    );
    assert.ok(row, `a thumbnail at y=${image.y} belongs to no row`);
    assert.ok(
      image.x >= row.x && image.x + image.w <= row.x + row.w,
      `the thumbnail runs out of ${row.id} horizontally`
    );
    assert.ok(
      image.y + image.h <= row.y + row.h,
      `the thumbnail runs out of ${row.id} vertically`
    );
  }
});

test('a row s text clears its thumbnail instead of being drawn over it', () => {
  const ctx = draw(options(), null, {
    shots: new Map([
      ['s1', IMAGE],
      ['s2', IMAGE]
    ])
  });

  const name = ctx.placed.find((p) => p.text === 'Before the boss');
  const shot = ctx.images[0];
  assert.ok(name && shot, 'both must be drawn in this state');
  assert.ok(
    name.x >= shot.x + shot.w,
    `the name starts at ${name.x}px, over a thumbnail ending at ${shot.x + shot.w}px`
  );
});

/*
 * The launch screen's cover had the lectern's two faults, from the same line.
 *
 * `COVER` is 160 x 112 - landscape - and box art is portrait, so handing
 * `drawImage` the box's own width and height squashed it. And this is the
 * BIGGEST the art ever gets in a session, on the curved screen the player is
 * looking straight at, so it is the copy where both faults show most.
 */

/** Box art proportions, unlike `IMAGE` above, which is a 4:3 screenshot. */
const PORTRAIT_COVER = { naturalWidth: 350, naturalHeight: 500 } as unknown as CanvasImageSource;

test('the launch cover keeps its own proportions inside the cover box', () => {
  const ctx = draw(options(), null, { covers: new Map([['mine', PORTRAIT_COVER]]) });

  const cover = ctx.images.find((i) => i.y < 264);
  assert.ok(cover, 'the cover never reached the canvas');
  // `COVER_INSET` de chaque côté : le cadre du logement n'est pas de la place
  // perdue, il EST le style.
  const innerH = 112 - COVER_INSET * 2;
  const innerW = 160 - COVER_INSET * 2;
  assert.equal(cover.h, innerH, 'the box constrains the tall axis');
  assert.equal(cover.w, 350 * (innerH / 500), 'not the box width, which is the squash');
  // The cover box is at the panel's own 40px pad, 160 wide.
  assert.equal(
    cover.x,
    40 + COVER_INSET + (innerW - 350 * (innerH / 500)) / 2,
    'centred in the slack'
  );
});

test('the launch screen downscales its pictures with the good filter', () => {
  const ctx = draw(options(), null, { covers: new Map([['mine', PORTRAIT_COVER]]) });
  assert.equal(ctx.imageSmoothingEnabled, true);
  assert.equal(
    ctx.imageSmoothingQuality,
    'high',
    'the default skips source pixels, which bakes shimmer into the canvas'
  );
});

/*
 * The save thumbnails had the same stretch, from a different line.
 *
 * The reserved column is 88 x 60, which is 1.47, and a SNES frame is 256 x 224,
 * which is 1.14 - so every thumbnail was 28 per cent too wide. A picture of the
 * game, visibly the wrong shape, sitting next to a cover that is now the right
 * one. Not box art, which is why it was left out of the first pass, but the
 * same defect and the same one-line fix.
 */

/** A SNES frame's own proportions, unlike `IMAGE`'s 4:3. */
const SNES_FRAME = { naturalWidth: 256, naturalHeight: 224 } as unknown as CanvasImageSource;

test('a save thumbnail keeps the shape of the frame it captured', () => {
  const ctx = draw(options(), null, { shots: new Map([['s1', SNES_FRAME]]) });

  assert.equal(ctx.images.length, 1, 'the thumbnail never reached the canvas');
  const [shot] = ctx.images;
  // The reserved column is 88 x 60.
  assert.equal(shot.h, 60, 'the column constrains the tall axis');
  assert.equal(shot.w, 256 * (60 / 224), 'not the column 88, which is the stretch');
});


/*
 * Le ROM qui arrive : ce que l'invite voit a la place d'un refus.
 *
 * L'ancien ecran disait « lance-le une fois hors VR » et retirait le bouton.
 * Un invite dans un groupe n'a plus a sortir du casque : l'hote a la
 * cartouche, le serveur relaie le transfert depuis toujours, et c'est
 * `launch-options.ts` qui a decide que ce n'est plus un blocage. Ce panneau ne
 * fait que le dire - et poser la seule question que le transfert souleve.
 */
test('un ROM qui arrive laisse le bouton et annonce l envoi', () => {
  const o = options({ romHere: false, romIncoming: true, blocked: null });
  const ids = layoutLaunchPanel(o, LABELS).map((r) => r.id);
  assert.ok(ids.includes('launch'), 'le bouton doit rester : il y a de quoi lancer');

  const drawn = draw(o).texts.join('\n');
  assert.ok(drawn.includes(LABELS.romIncoming), "rien n annonce que le jeu arrive");
  assert.ok(drawn.includes(LABELS.keepQuestion), 'la question n est pas ecrite');
  assert.ok(!drawn.includes(LABELS.romMissing), 'l ancien refus traine encore');
});

test('la question du conservage n est posee que quand un ROM arrive', () => {
  const incoming = layoutLaunchPanel(
    options({ romHere: false, romIncoming: true }),
    LABELS
  ).map((r) => r.id);
  assert.ok(incoming.includes('keep:yes'));
  assert.ok(incoming.includes('keep:no'));

  // Rien a garder quand le jeu est deja la : la question serait sans objet.
  const here = layoutLaunchPanel(options(), LABELS).map((r) => r.id);
  assert.ok(!here.includes('keep:yes'));
  assert.ok(!here.includes('keep:no'));
});

test('le disclaimer accompagne la question, et seulement elle', () => {
  const asked = draw(options({ romHere: false, romIncoming: true })).texts.join('\n');
  assert.ok(asked.includes(LABELS.keepRomLegal), 'la question est posee sans le disclaimer');

  const notAsked = draw(options()).texts.join('\n');
  assert.ok(!notAsked.includes(LABELS.keepRomLegal), 'un disclaimer sans question a poser');
});

test('le choix se voit sur le fond, pas sur le libelle', () => {
  // La meme regle que les deux ports et les deux langues : deux etats qui ne
  // differeraient que par un `fillText` ne seraient pas distinguables ici, et
  // c'est le piege ou sont tombees les cartes de preset du pupitre.
  const o = options({ romHere: false, romIncoming: true });
  const keeping = draw(o, null, { keepRom: true });
  const refusing = draw(o, null, { keepRom: false });

  assert.deepEqual(keeping.texts, refusing.texts, 'le libelle change de sens selon l etat');
  assert.notDeepEqual(
    keeping.calls.filter((c) => c === 'fillRect'),
    [],
    'le marquage doit etre un fond'
  );
});

test('le transfert en cours remplace le libelle du bouton', () => {
  const o = options({ romHere: false, romIncoming: true });
  const running = draw(o, null, { transfer: 'Receiving the game… 42%' });
  const drawn = running.texts.join('\n');

  assert.ok(drawn.includes('Receiving the game… 42%'));
  assert.ok(!drawn.includes(LABELS.launch), 'le bouton dit encore de lancer pendant qu il recoit');
});

/*
 * La largeur des libelles de bouton, mesuree avec un proxy HONNETE.
 *
 * Le faux contexte de ce fichier compte neuf pixels par caractere, ce qui est
 * optimiste pour du 26 px gras : le vrai en fait pres de quatorze. La premiere
 * paire - « Garder le jeu » et « Ne pas garder » - passait ce test a 117 px
 * pour 164 disponibles, et debordait de son bouton au rendu, par-dessus son
 * voisin. Le rendu tranche, mais un proxy honnete rattrape le cas grossier.
 */
const BUTTON_PX_PER_CHAR = 14;

test('les libelles des boutons tiennent dans leur boite', () => {
  const regions = layoutLaunchPanel(options({ romHere: false, romIncoming: true }), LABELS);
  const pairs = [
    ['keep:yes', LABELS.yes],
    ['keep:no', LABELS.no],
    ['launch', LABELS.launch]
  ] as const;

  for (const [id, label] of pairs) {
    const region = regions.find((r) => r.id === id)!;
    const width = label.length * BUTTON_PX_PER_CHAR;
    assert.ok(width < region.w - 16, `${label} fait environ ${width} px pour ${region.w}`);
  }
});

test('rien ne chevauche rien dans l etat du ROM qui arrive', () => {
  // L'etat le plus charge : cinq sauvegardes, deux ports, la question, le
  // bouton. C'est exactement ce genre d'ajout qui avait fait passer le bouton
  // de lancement par-dessus la sixieme ligne de sauvegarde.
  const regions = layoutLaunchPanel(
    options({
      romHere: false,
      romIncoming: true,
      friend: { pseudo: 'Bob', online: true, port: 2, isReady: true },
      myPort: 1
    }),
    LABELS
  );
  for (const a of regions) {
    assert.ok(a.x >= 0 && a.y >= 0 && a.x + a.w <= LAUNCH_PANEL_SIZE.width, `${a.id} sort`);
    assert.ok(a.y + a.h <= LAUNCH_PANEL_SIZE.height, `${a.id} sort par le bas`);
    for (const b of regions) {
      if (a === b) continue;
      const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
      assert.ok(apart, `${a.id} chevauche ${b.id}`);
    }
  }
});

test("l'ecran de lancement porte le verre de l'ecran au repos, puisque le monde est derriere les deux", () => {
  /*
   * La regle est dans `chrome.ts` : la transparence sert la ou il y a quelque
   * chose a voir au travers. Ce peintre portait de l'herbe opaque, et son
   * commentaire disait pourquoi - « aucun jeu ne tourne derriere lui ».
   *
   * C'etait vrai d'une salle noire. Ca ne l'est plus depuis que le lobby a un
   * monde : derriere cet ecran il y a le ciel, les collines et le comptoir,
   * exactement ce que l'ecran AU REPOS laisse deja passer (`idle-glass.ts`).
   * Deux etats de la MEME surface courbe ne peuvent pas etre faits de deux
   * matieres differentes sans que le passage de l'un a l'autre se voie comme
   * un defaut.
   *
   * Le test compare a `fieldFill('frost')` plutot qu'a une couleur ecrite ici :
   * ce qui est pince est « la meme matiere que les pupitres », pas une teinte.
   */
  let background: string | null = null;
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    font: '',
    lineWidth: 0,
    textAlign: 'left',
    textBaseline: 'alphabetic',
    imageSmoothingEnabled: false,
    imageSmoothingQuality: 'low',
    save() {},
    restore() {},
    clearRect() {},
    fillRect() {
      // Le premier `fillRect` d'un peintre est son fond : `drawField` est
      // appele juste apres le `clearRect` d'ouverture.
      if (background === null) background = ctx.fillStyle;
    },
    strokeRect() {},
    beginPath() {},
    arc() {},
    fill() {},
    stroke() {},
    drawImage() {},
    fillText() {},
    measureText(text: string) {
      return { width: text.length * 9 };
    }
  } as unknown as CanvasRenderingContext2D & { fillStyle: string };

  const o = options();
  drawLaunchPanel(ctx, o, layoutLaunchPanel(o, LABELS), {
    labels: LABELS,
    hoverId: null,
    covers: new Map(),
    shots: new Map(),
    keepRom: false,
    transfer: null
  });

  assert.equal(background, fieldFill('frost'));
});
