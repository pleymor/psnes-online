/**
 * The low band, which is now a launcher.
 *
 * It used to be a settings surface: two preset cards with controller diagrams,
 * a language pair, and four rows naming the mappings no preset changes. All of
 * that is gone from here, and none of it is lost - which is the only thing
 * that made removing it defensible.
 *
 * The four fixed rows were there for a real reason, and the header they came
 * from spelt it out: START sits on the right grip, the one button nobody
 * thinks to squeeze, and a whole hardware test session went into concluding
 * the controls were dead when they were merely unlabelled. That fact now lives
 * on `panels/controls.ts`, better: it draws all eight buttons with the human
 * name of the input each one currently carries, so START names its grip from
 * the REAL map rather than from a static picture of a default. The two
 * mappings that belong to no button - the d-pad on the sticks, the system
 * menu - have their own lines there too. The preset cards went the same way,
 * and for the same reason: the remap panel's eight rows are the diagram, in
 * full, instead of a compressed preview of two defaults.
 *
 * What the band keeps is what only it can offer. The exit above all: the
 * Quest's menu button is reserved by the system and delivers nothing to the
 * page, so this region is the only way out this app has, and a state without
 * it is a state somebody is stuck in.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  layoutProfilePanel,
  drawProfilePanel,
  PROFILE_PANEL_SIZE,
  type ProfileState
} from '../../frontend/src/lib/vr/panels/profile.js';

/*
 * Les formulations expédiées, pas des bouchons.
 *
 * Le test de largeur en bas mesure ces chaînes, et un remplaçant court
 * passerait une vérification que le vrai libellé pourrait échouer - ce qui est
 * arrivé : la bande est passée à quatre colonnes pour faire tenir Sauver et
 * Charger, et « Back to the game » a cessé de tenir dans son bouton. Il a été
 * raccourci plutôt que coupé, et « Arrêter » face à « Quitter la VR » lève au
 * passage la collision des deux « Quitter » que ce fichier surveille déjà.
 */
const LABELS = {
  controls: 'Contrôles',
  recenter: 'Recentrer',
  save: 'Sauver',
  load: 'Charger',
  quit: 'Quitter la VR',
  resume: 'Reprendre',
  stopGame: 'Arrêter'
};

function recordingContext() {
  const texts: string[] = [];
  const placed: Array<{ text: string; x: number; y: number }> = [];
  return {
    texts,
    placed,
    font: '', fillStyle: '', strokeStyle: '', lineWidth: 0,
    textAlign: 'left', textBaseline: 'alphabetic',
    save() {}, restore() {}, clearRect() {}, fillRect() {}, strokeRect() {},
    beginPath() {}, arc() {}, fill() {}, stroke() {},
    fillText(text: string, x: number, y: number) {
      texts.push(text);
      placed.push({ text, x, y });
    },
    measureText(text: string) { return { width: text.length * 11 }; }
  } as unknown as CanvasRenderingContext2D & {
    texts: string[];
    placed: Array<{ text: string; x: number; y: number }>;
  };
}

function state(over: Partial<ProfileState> = {}): ProfileState {
  return { pseudo: 'Ada', playing: false, notice: null, ...over };
}

const ids = (s: ProfileState) => layoutProfilePanel(s).map((r) => r.id);

test('the exit exists in every state, because nothing else can offer one', () => {
  assert.ok(ids(state()).includes('quit'));
  assert.ok(ids(state({ playing: true })).includes('quit'));
});

/*
 * And it does not move when a game starts.
 *
 * The band gains two regions while something is running, and if the exit were
 * laid out after them it would shift under the player's pointer at exactly the
 * moment they are most likely to want it. A button you have to find again is
 * not the same button.
 */
test('the exit is in the same place whether or not a game is running', () => {
  const idle = layoutProfilePanel(state()).find((r) => r.id === 'quit');
  const busy = layoutProfilePanel(state({ playing: true })).find((r) => r.id === 'quit');
  assert.deepEqual(idle, busy);
});

test('the controls panel and the recentre are offered in every state', () => {
  for (const playing of [false, true]) {
    const shown = ids(state({ playing }));
    assert.ok(shown.includes('controls'), 'rebinding must be reachable while playing too');
    assert.ok(shown.includes('recenter'), 'a room in the wrong place is worst mid-game');
  }
});

test('going back to the game is offered only when there is one', () => {
  assert.ok(!ids(state()).includes('resume'));
  assert.ok(ids(state({ playing: true })).includes('resume'));
});

test('stopping the game is offered only while one is running', () => {
  assert.ok(!ids(state()).includes('stop'));
  assert.ok(ids(state({ playing: true })).includes('stop'));
});

/*
 * Ending the game and leaving VR are different regions with different words.
 *
 * They were one button once, and the consequence was that finishing a game and
 * choosing another meant taking the headset off. Keeping them distinguishable
 * is not cosmetic: one is recoverable in a second and the other ends the
 * session.
 */
test('stopping the game is a different region from leaving VR', () => {
  const regions = layoutProfilePanel(state({ playing: true }));
  const stop = regions.find((r) => r.id === 'stop');
  const quit = regions.find((r) => r.id === 'quit');
  assert.ok(stop && quit);
  assert.notDeepEqual({ x: stop.x, y: stop.y }, { x: quit.x, y: quit.y });
});

test('stopping the game says so, in words that are not the ones for leaving VR', () => {
  const ctx = recordingContext();
  const s = state({ playing: true });
  drawProfilePanel(ctx, s, layoutProfilePanel(s), { labels: LABELS, hoverId: null });
  assert.ok(ctx.texts.includes(LABELS.stopGame));
  assert.ok(ctx.texts.includes(LABELS.quit));
  assert.notEqual(LABELS.stopGame, LABELS.quit);
});

test('every region stays on the band and none overlap', () => {
  for (const playing of [false, true]) {
    const regions = layoutProfilePanel(state({ playing }));
    for (const r of regions) {
      assert.ok(r.x >= 0 && r.y >= 0, `${r.id} starts off the band`);
      assert.ok(r.x + r.w <= PROFILE_PANEL_SIZE.width, `${r.id} runs off the right`);
      assert.ok(r.y + r.h <= PROFILE_PANEL_SIZE.height, `${r.id} runs off the bottom`);
    }
    // `hit()` returns the first match, so an overlap silently eats the region
    // underneath - and one of these is the only exit the app has.
    for (const a of regions) {
      for (const b of regions) {
        if (a === b) continue;
        const apart =
          a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        assert.ok(apart, `${a.id} overlaps ${b.id}`);
      }
    }
  }
});

test('the pseudonym is shown, because this is the identity panel', () => {
  const ctx = recordingContext();
  const s = state({ pseudo: 'Bo' });
  drawProfilePanel(ctx, s, layoutProfilePanel(s), { labels: LABELS, hoverId: null });
  assert.ok(ctx.texts.includes('Bo'));
});

test('the identity does not sit under a button', () => {
  const ctx = recordingContext();
  const s = state({ playing: true });
  drawProfilePanel(ctx, s, layoutProfilePanel(s), { labels: LABELS, hoverId: null });
  const name = ctx.placed.find((p) => p.text === 'Ada');
  assert.ok(name);
  for (const r of layoutProfilePanel(s)) {
    const inside = name.x >= r.x && name.x <= r.x + r.w && name.y >= r.y && name.y <= r.y + r.h;
    assert.ok(!inside, `the pseudonym is drawn inside the ${r.id} button`);
  }
});

test('every button carries a legible label', () => {
  const ctx = recordingContext();
  const s = state({ playing: true });
  drawProfilePanel(ctx, s, layoutProfilePanel(s), { labels: LABELS, hoverId: null });
  for (const label of Object.values(LABELS)) {
    assert.ok(ctx.texts.includes(label), `${label} was never drawn`);
  }
});

/*
 * A translation longer than its button is cut rather than left to run.
 *
 * These canvases have no layout engine, so the alternative is text spilling
 * over the neighbouring button - and the neighbour here can be the exit.
 */
test('a label too long for its button is truncated', () => {
  const ctx = recordingContext();
  const s = state();
  const long = 'Recentrer la pièce autour de la position actuelle de la tête du joueur';
  drawProfilePanel(ctx, s, layoutProfilePanel(s), {
    labels: { ...LABELS, recenter: long },
    hoverId: null
  });
  assert.ok(!ctx.texts.includes(long), 'the untruncated label reached the canvas');
  assert.ok(ctx.texts.some((tx) => tx.endsWith('…')), 'nothing was marked as cut');
});

test('a label that fits is not cut', () => {
  const ctx = recordingContext();
  const s = state();
  drawProfilePanel(ctx, s, layoutProfilePanel(s), { labels: LABELS, hoverId: null });
  assert.ok(ctx.texts.includes(LABELS.recenter));
  assert.ok(!ctx.texts.includes(`${LABELS.recenter}…`));
});

/*
 * Saving and loading, which the headset had no way to reach.
 *
 * Only the launch screen listed a game's saves, and only before launching it -
 * so a player mid-game could neither save nor reload. These two buttons are
 * `saves/quick-actions.ts` exactly as F2 and F4 use it: one slot, overwritten,
 * sharing the `QUICK_SAVE_NAME` sentinel with the flat page so a headset save
 * and a keyboard save are the same save rather than two competing ones.
 *
 * Both exist only while something is running. There is nothing to write when
 * no game is loaded, and reloading into no game is not a thing either.
 */
test('saving and loading are offered only while a game is running', () => {
  for (const id of ['save', 'load']) {
    assert.ok(!ids(state()).includes(id), `${id} has nothing to act on when idle`);
    assert.ok(ids(state({ playing: true })).includes(id));
  }
});

test('the two of them are named', () => {
  const ctx = recordingContext();
  const s = state({ playing: true });
  drawProfilePanel(ctx, s, layoutProfilePanel(s), { labels: LABELS, hoverId: null });
  assert.ok(ctx.texts.includes(LABELS.save));
  assert.ok(ctx.texts.includes(LABELS.load));
});

/*
 * The notice, without which the feature is unusable even when it works.
 *
 * `quickSave` reports through `notifications.show`, and those are DOM toasts:
 * a headset presenting an immersive session cannot see one. Pressing Save
 * would produce no confirmation at all, which is indistinguishable from a
 * button that does nothing. `VrShell` mirrors the newest notification into
 * this field, so any of them raised during a session becomes visible - not
 * only the ones about saves.
 */
test('a notice is drawn when there is one', () => {
  const ctx = recordingContext();
  const s = state({ playing: true, notice: 'Saved' });
  drawProfilePanel(ctx, s, layoutProfilePanel(s), { labels: LABELS, hoverId: null });
  assert.ok(ctx.texts.includes('Saved'));
});

test('no notice draws no line, rather than an empty one', () => {
  const ctx = recordingContext();
  const s = state({ playing: true });
  drawProfilePanel(ctx, s, layoutProfilePanel(s), { labels: LABELS, hoverId: null });
  assert.ok(!ctx.texts.includes(''), 'an empty string was drawn as if it were a message');
});

test('a long notice is truncated rather than run off the band', () => {
  const ctx = recordingContext();
  const long = 'La sauvegarde a échoué parce que la liste des sauvegardes du jeu était illisible';
  const s = state({ playing: true, notice: long });
  drawProfilePanel(ctx, s, layoutProfilePanel(s), { labels: LABELS, hoverId: null });
  assert.ok(!ctx.texts.includes(long));
  assert.ok(ctx.texts.some((tx) => tx.endsWith('…')));
});

test('the notice does not sit under a button', () => {
  const ctx = recordingContext();
  const s = state({ playing: true, notice: 'Saved' });
  drawProfilePanel(ctx, s, layoutProfilePanel(s), { labels: LABELS, hoverId: null });
  const line = ctx.placed.find((pl) => pl.text === 'Saved');
  assert.ok(line);
  for (const r of layoutProfilePanel(s)) {
    const inside =
      line.x >= r.x && line.x <= r.x + r.w && line.y >= r.y && line.y <= r.y + r.h;
    assert.ok(!inside, `the notice is drawn inside the ${r.id} button`);
  }
});

/*
 * Chaque libellé expédié tient dans son bouton sans être coupé.
 *
 * C'est le test que la bande n'avait pas quand elle est passée de trois
 * colonnes à quatre : les boutons ont rétréci de 200 à 147 px et deux
 * libellés ont silencieusement commencé à finir par une ellipse. Une ellipse
 * sur « Reprendre » n'est pas grave ; sur la sortie, c'est le seul chemin hors
 * de la session qui devient illisible.
 */
test('aucun libellé expédié ne se fait couper', () => {
  const ctx = recordingContext();
  const s = state({ playing: true });
  drawProfilePanel(ctx, s, layoutProfilePanel(s), { labels: LABELS, hoverId: null });
  for (const label of Object.values(LABELS)) {
    assert.ok(
      ctx.texts.includes(label),
      `"${label}" a été coupé - raccourcir la formulation ou élargir le bouton`
    );
  }
});
