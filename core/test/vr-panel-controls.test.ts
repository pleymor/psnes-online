/**
 * Le panneau de remap, sur l'écran courbe.
 *
 * Deux règles portantes, toutes deux héritées de pannes réelles ailleurs dans
 * ce dossier.
 *
 * La ligne qui écoute est marquée par autre chose qu'une couleur : deux états
 * ne différant que par un remplissage produisent un jeu de `fillText`
 * identique, et le test « l'état est visible » n'aurait rien à comparer -
 * exactement le piège où étaient tombées les cartes de preset du pupitre.
 *
 * Les entrées non assignables sont nommées quelque part. Un joueur qui ne voit
 * la croix ni le menu nulle part les croit cassées, et la seule chose qu'il
 * puisse en conclure est que le remap les a mangées.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  CONTROLS_PANEL_SIZE,
  layoutControlsPanel,
  drawControlsPanel,
  type ControlsLabels,
  type ControlsState
} from '../../frontend/src/lib/vr/panels/controls.js';
import { LETTERS_MAP, assignInput } from '../../frontend/src/lib/vr/pad-map.js';

const LABELS: ControlsLabels = {
  heading: 'Contrôles',
  // La formulation expédiée, pas un bouchon : le test de largeur ci-dessous
  // mesure cette chaîne, et un remplaçant court passerait une vérification que
  // le vrai libellé pourrait échouer.
  press: 'Pressez un bouton — clic du stick droit pour annuler',
  done: 'Terminé',
  presetLetters: 'Preset lettres',
  presetThumb: 'Preset pouce',
  fixedDpad: 'Croix directionnelle : les deux sticks',
  fixedMenu: 'Menu : clic du stick droit',
  button: { a: 'A', b: 'B', x: 'X', y: 'Y', l: 'L', r: 'R', start: 'START', select: 'SELECT' },
  input: {
    XrLeftTrigger: 'Gauche — gâchette',
    XrRightTrigger: 'Droite — gâchette',
    XrLeftSqueeze: 'Gauche — grip',
    XrRightSqueeze: 'Droite — grip',
    XrLeftFaceUpper: 'Gauche — bouton haut',
    XrRightFaceUpper: 'Droite — bouton haut',
    XrLeftFaceLower: 'Gauche — bouton bas',
    XrRightFaceLower: 'Droite — bouton bas',
    XrLeftStickClick: 'Gauche — clic du stick'
  }
};

function state(over: Partial<ControlsState> = {}): ControlsState {
  return { map: LETTERS_MAP, listeningFor: null, ...over };
}

function recordingContext() {
  const texts: string[] = [];
  const calls: string[] = [];
  const placed: Array<{ text: string; x: number; y: number }> = [];
  return {
    texts, calls, placed,
    font: '', fillStyle: '', strokeStyle: '', lineWidth: 0,
    textAlign: 'left', textBaseline: 'alphabetic',
    save() {}, restore() {}, clearRect() {},
    fillRect() { calls.push('fillRect'); },
    strokeRect() { calls.push('strokeRect'); },
    beginPath() {}, arc() { calls.push('arc'); }, fill() {}, stroke() {},
    drawImage() { calls.push('drawImage'); },
    fillText(text: string, x: number, y: number) {
      texts.push(text);
      calls.push(`fillText:${text}`);
      placed.push({ text, x, y });
    },
    measureText(text: string) { return { width: text.length * 9 }; }
  } as unknown as CanvasRenderingContext2D & {
    texts: string[];
    calls: string[];
    placed: Array<{ text: string; x: number; y: number }>;
  };
}

function draw(s: ControlsState, hoverId: string | null = null) {
  const ctx = recordingContext();
  drawControlsPanel(ctx, s, layoutControlsPanel(s), { labels: LABELS, hoverId });
  return ctx;
}

test('les huit boutons ont chacun leur région', () => {
  const ids = layoutControlsPanel(state()).map((r) => r.id);
  for (const button of ['a', 'b', 'x', 'y', 'l', 'r', 'start', 'select']) {
    assert.ok(ids.includes(`bind:${button}`), `${button} n'est pas cliquable`);
  }
});

test('les deux presets sont offerts', () => {
  const ids = layoutControlsPanel(state()).map((r) => r.id);
  assert.ok(ids.includes('preset:letters'));
  assert.ok(ids.includes('preset:thumb'), 'revenir en arrière doit être possible aussi');
});

test('chaque ligne nomme son bouton et l entrée qui le porte', () => {
  const drawn = draw(state()).texts.join('\n');
  assert.ok(drawn.includes('START'), "le bouton START n'est pas nommé");
  assert.ok(
    drawn.includes(LABELS.input[LETTERS_MAP.start]),
    "l'entrée qui porte START n'est pas nommée"
  );
});

test('la ligne qui écoute est marquée autrement que par une couleur', () => {
  const idle = draw(state()).calls;
  const listening = draw(state({ listeningFor: 'a' })).calls;
  assert.notDeepEqual(idle, listening, "rien sur le canvas ne dit qu'une ligne écoute");
});

test('l invite d annulation est dite pendant la capture, et pas avant', () => {
  // Sans elle, un joueur qui a ouvert une capture par erreur n'a aucun moyen de
  // savoir qu'il peut en sortir : tous les autres boutons sont capturables.
  assert.ok(!draw(state()).texts.includes(LABELS.press));
  assert.ok(draw(state({ listeningFor: 'a' })).texts.includes(LABELS.press));
});

test('aucune ligne n est cliquable pendant une capture', () => {
  // Sinon la pression qui lie A peut aussi être lue comme un clic sur B.
  const ids = layoutControlsPanel(state({ listeningFor: 'a' })).map((r) => r.id);
  assert.deepEqual(ids, [], 'le panneau reste cliquable pendant la capture');
});

test('les huit lignes restent dessinées pendant une capture', () => {
  // Elles n'ont plus de région, mais un panneau qui se vide pendant la capture
  // laisserait le joueur sans rien à quoi rapporter le bouton qu'il presse.
  const drawn = draw(state({ listeningFor: 'a' })).texts.join('\n');
  for (const label of ['A', 'B', 'X', 'Y', 'L', 'R', 'START', 'SELECT']) {
    assert.ok(drawn.includes(label), `${label} a disparu pendant la capture`);
  }
});

test('les entrées non assignables sont nommées', () => {
  const drawn = draw(state()).texts.join('\n');
  assert.ok(drawn.includes(LABELS.fixedDpad), "la croix n'est expliquée nulle part");
  assert.ok(drawn.includes(LABELS.fixedMenu), "le menu n'est expliqué nulle part");
});

test('une map remappée est ce qui est dessiné, pas le preset', () => {
  const custom = assignInput(LETTERS_MAP, 'a', 'XrLeftStickClick');
  const drawn = draw(state({ map: custom })).texts.join('\n');
  assert.ok(drawn.includes(LABELS.input.XrLeftStickClick), "le remap n'est pas montré");
});

test('une ligne survolée est entourée, une autre non', () => {
  // Sans ce test, tout le bloc de survol pourrait être supprimé sans que rien
  // ne le remarque.
  const plain = draw(state()).calls.filter((c) => c === 'strokeRect').length;
  const hovered = draw(state(), 'bind:a').calls.filter((c) => c === 'strokeRect').length;
  assert.ok(hovered > plain, 'le survol ne se voit pas');
});

test('aucun texte de ligne ne déborde de sa ligne', () => {
  // La mesure du faux contexte, la même que les autres tests de largeur.
  const regions = layoutControlsPanel(state());
  for (const listeningFor of [null, 'a'] as const) {
    const ctx = draw(state({ listeningFor }));
    for (const drawn of ctx.placed) {
      // Par x ET par y : les boutons de preset partagent la bande verticale des
      // deux premières lignes sans être dedans, et les attribuer à une ligne
      // faisait échouer ce test sur un texte parfaitement placé.
      const row = regions.find(
        (r) =>
          r.id.startsWith('bind:') &&
          drawn.y >= r.y && drawn.y < r.y + r.h &&
          drawn.x >= r.x && drawn.x < r.x + r.w
      );
      if (!row) continue;
      assert.ok(
        drawn.x + drawn.text.length * 9 <= row.x + row.w,
        `"${drawn.text}" atteint ${drawn.x + drawn.text.length * 9}px, la ligne finit à ${row.x + row.w}px`
      );
    }
  }
});

test('aucune région ne sort du panneau ni n en chevauche une autre', () => {
  for (const listeningFor of [null, 'a', 'select'] as const) {
    const regions = layoutControlsPanel(state({ listeningFor }));
    for (const r of regions) {
      assert.ok(r.x >= 0 && r.y >= 0, `${r.id} commence hors panneau`);
      assert.ok(r.x + r.w <= CONTROLS_PANEL_SIZE.width, `${r.id} déborde à droite`);
      assert.ok(r.y + r.h <= CONTROLS_PANEL_SIZE.height, `${r.id} déborde en bas`);
    }
    for (let i = 0; i < regions.length; i++) {
      for (let j = i + 1; j < regions.length; j++) {
        const a = regions[i];
        const b = regions[j];
        const apart =
          a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        assert.ok(apart, `${a.id} chevauche ${b.id}`);
      }
    }
  }
});

test('le panneau porte de quoi en sortir', () => {
  /*
   * Sans ça le panneau est un cul-de-sac.
   *
   * Le clic du stick droit rappelle les panneaux, il ne rend pas l'écran ; le
   * pupitre n'offre « Retour au jeu » que pendant une partie. Un joueur qui
   * ouvre le remap sans jeu en cours n'avait donc plus aucun moyen de revenir
   * aux options de lancement - l'écran courbe gardait le remap pour le reste
   * de la session.
   */
  const ids = layoutControlsPanel(state()).map((r) => r.id);
  assert.ok(ids.includes('close'), 'aucune sortie depuis le panneau de remap');
});

test('la sortie est nommée', () => {
  assert.ok(draw(state()).texts.includes(LABELS.done), 'la sortie est sans libellé');
});

test('la sortie disparaît pendant une capture, comme tout le reste', () => {
  // Elle est capturable comme les autres boutons : la laisser cliquable
  // pendant l'écoute ferait d'une pression un clic autant qu'une liaison.
  const ids = layoutControlsPanel(state({ listeningFor: 'a' })).map((r) => r.id);
  assert.ok(!ids.includes('close'));
});
