/**
 * Le panneau de réglage de l'écran, et le menu d'options qui y mène.
 *
 * Deux règles portantes.
 *
 * Un cran de bout n'a PAS de région. Le bouton est encore dessiné - il faut
 * voir qu'on est au bout - mais il n'est plus visable, donc la pressée n'a
 * rien à laisser passer. L'autre réponse possible était une région inerte, et
 * elle est pire dans un casque : le pointeur s'accroche, le survol s'allume,
 * et rien ne se passe, ce qui se lit comme une panne plutôt que comme une
 * limite.
 *
 * Toute valeur affichée vient de la forme et non d'un libellé figé. Un panneau
 * qui écrirait « 2,5 m » en dur passerait tous les tests de mise en page en
 * mentant au joueur sur ce que sa manette vient de faire.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  SCREEN_PANEL_SIZE,
  layoutScreenPanel,
  drawScreenPanel,
  type ScreenPanelLabels
} from '../../frontend/src/lib/vr/panels/screen-settings.js';
import {
  OPTIONS_PANEL_SIZE,
  layoutOptionsPanel,
  drawOptionsPanel,
  type OptionsLabels
} from '../../frontend/src/lib/vr/panels/options.js';
import {
  DEFAULT_SHAPE,
  SCREEN_DISTANCES,
  SCREEN_ANGLES,
  SCREEN_HEIGHTS,
  type ScreenShape
} from '../../frontend/src/lib/vr/screen-shape.js';

const LABELS: ScreenPanelLabels = {
  heading: 'Écran',
  distance: 'Distance',
  size: 'Taille',
  height: 'Hauteur',
  shape: 'Forme',
  flat: 'Plat',
  curved: 'Incurvé',
  close: 'Retour',
  metres: (value: number) => `${value.toFixed(1).replace('.', ',')} m`,
  degrees: (value: number) => `${value}°`,
  centimetres: (value: number) =>
    value === 0 ? '0 cm' : `${value > 0 ? '+' : '−'}${Math.abs(Math.round(value * 100))} cm`
};

const OPTIONS_LABELS: OptionsLabels = {
  heading: 'Options',
  controls: 'Contrôles',
  screen: 'Écran',
  relief: 'Relief',
  close: 'Retour'
};

/** Le faux contexte 2D des autres tests de panneau : il enregistre. */
function fakeCtx() {
  const texts: string[] = [];
  const rects: { x: number; y: number; w: number; h: number }[] = [];
  const ctx = {
    canvas: { width: 0, height: 0 },
    save() {}, restore() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
    arc() {}, fill() {}, stroke() {}, clip() {}, translate() {}, rotate() {}, scale() {},
    clearRect() {},
    fillRect(x: number, y: number, w: number, h: number) { rects.push({ x, y, w, h }); },
    strokeRect() {},
    createLinearGradient: () => ({ addColorStop() {} }),
    drawImage() {},
    fillText(text: string) { texts.push(text); },
    measureText(text: string) { return { width: text.length * 9 }; },
    set fillStyle(_v: unknown) {}, set strokeStyle(_v: unknown) {},
    set lineWidth(_v: unknown) {}, set font(_v: unknown) {},
    set textAlign(_v: unknown) {}, set textBaseline(_v: unknown) {},
    set imageSmoothingEnabled(_v: unknown) {}, set imageSmoothingQuality(_v: unknown) {}
  } as unknown as CanvasRenderingContext2D;
  return { ctx, texts, rects };
}

function drawScreen(shape: ScreenShape, hoverId: string | null = null) {
  const { ctx, texts, rects } = fakeCtx();
  drawScreenPanel(ctx, shape, layoutScreenPanel(shape), { labels: LABELS, hoverId });
  return { texts, rects, joined: texts.join('\n') };
}

const ids = (shape: ScreenShape) => layoutScreenPanel(shape).map((r) => r.id).sort();

test('les neuf commandes sont là au réglage livré', () => {
  assert.deepEqual(ids(DEFAULT_SHAPE), [
    'bigger', 'close', 'curved', 'farther', 'flat', 'higher', 'lower', 'nearer', 'smaller'
  ]);
});

test('le bout de l échelle retire sa région, pas son bouton', () => {
  const nearest: ScreenShape = { ...DEFAULT_SHAPE, distance: SCREEN_DISTANCES[0] };
  assert.ok(!ids(nearest).includes('nearer'), 'on peut encore se rapprocher du plus proche');
  assert.ok(ids(nearest).includes('farther'));
  // Dessiné quand même : sans le bouton, le joueur ne voit pas qu'il est au bout.
  assert.ok(drawScreen(nearest).rects.length > 0);

  const farthest: ScreenShape = { ...DEFAULT_SHAPE, distance: SCREEN_DISTANCES[SCREEN_DISTANCES.length - 1] };
  assert.ok(!ids(farthest).includes('farther'));

  const smallest: ScreenShape = { ...DEFAULT_SHAPE, angle: SCREEN_ANGLES[0] };
  assert.ok(!ids(smallest).includes('smaller'));

  const biggest: ScreenShape = { ...DEFAULT_SHAPE, angle: SCREEN_ANGLES[SCREEN_ANGLES.length - 1] };
  assert.ok(!ids(biggest).includes('bigger'));

  const lowest: ScreenShape = { ...DEFAULT_SHAPE, height: SCREEN_HEIGHTS[0] };
  assert.ok(!ids(lowest).includes('lower'));
  assert.ok(ids(lowest).includes('higher'));

  const highest: ScreenShape = { ...DEFAULT_SHAPE, height: SCREEN_HEIGHTS[SCREEN_HEIGHTS.length - 1] };
  assert.ok(!ids(highest).includes('higher'));
});

test('les deux formes restent visables, y compris celle qui est active', () => {
  // Cliquer sur la forme déjà choisie est sans effet, et c'est mieux qu'une
  // moitié de paire qui disparaît : la paire dit l'état, comme les langues.
  for (const curved of [true, false]) {
    const list = ids({ ...DEFAULT_SHAPE, curved });
    assert.ok(list.includes('flat'));
    assert.ok(list.includes('curved'));
  }
});

test('les valeurs dessinées sont celles de la forme', () => {
  const drawn = drawScreen({ distance: 3.0, angle: 70, height: 0.2, curved: false }).joined;
  assert.ok(drawn.includes('3,0 m'), `la distance manque : ${drawn}`);
  assert.ok(drawn.includes('70°'), 'la taille manque');
  assert.ok(drawn.includes('+20 cm'), 'la hauteur manque');

  const other = drawScreen({ distance: 4.3, angle: 45, height: -0.4, curved: true }).joined;
  assert.ok(other.includes('4,3 m'));
  assert.ok(other.includes('45°'));
  assert.ok(other.includes('−40 cm'));
  assert.ok(!other.includes('3,0 m'), 'une valeur en dur traîne dans le dessin');
});

test('la hauteur zéro se lit sans signe', () => {
  // « +0 cm » et « −0 cm » sont tous les deux faux : c'est le niveau des yeux.
  assert.ok(drawScreen(DEFAULT_SHAPE).joined.includes('0 cm'));
  assert.ok(!drawScreen(DEFAULT_SHAPE).joined.includes('+0 cm'));
});

test('les trois intitulés et la sortie sont dessinés', () => {
  const drawn = drawScreen(DEFAULT_SHAPE).joined;
  for (const label of [
    LABELS.heading, LABELS.distance, LABELS.size, LABELS.height, LABELS.shape,
    LABELS.flat, LABELS.curved, LABELS.close
  ]) {
    assert.ok(drawn.includes(label), `${label} n'est pas dessiné`);
  }
});

test('aucun libellé du panneau écran ne dépasse sa boîte', () => {
  // Le rendu tranche, pas le test - mais un libellé plus large que son bouton
  // se voit ici sans casque.
  const regions = layoutScreenPanel(DEFAULT_SHAPE);
  const { ctx } = fakeCtx();
  for (const region of regions) {
    const label = { flat: LABELS.flat, curved: LABELS.curved, close: LABELS.close }[
      region.id as 'flat' | 'curved' | 'close'
    ];
    if (!label) continue;
    const width = ctx.measureText(label).width;
    assert.ok(width < region.w - 20, `${label} fait ${width} pour ${region.w}`);
  }
});

test('les régions du panneau écran ne se chevauchent pas', () => {
  const regions = layoutScreenPanel(DEFAULT_SHAPE);
  for (let i = 0; i < regions.length; i++) {
    for (let j = i + 1; j < regions.length; j++) {
      const a = regions[i];
      const b = regions[j];
      const apart =
        a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
      assert.ok(apart, `${a.id} et ${b.id} se chevauchent`);
    }
  }
});

test('les cibles du panneau écran sont assez grandes pour être visées', () => {
  // La tablette fait 1,12 m de large pour 1024 px à 1,5 m, soit environ
  // 24 px par degré. 90 px de côté font donc près de 4 degrés.
  for (const region of layoutScreenPanel(DEFAULT_SHAPE)) {
    assert.ok(region.w >= 88 && region.h >= 64, `${region.id} fait ${region.w}x${region.h}`);
  }
});

test('le menu d options mène aux trois panneaux et sort', () => {
  assert.deepEqual(layoutOptionsPanel().map((r) => r.id).sort(), [
    'close', 'controls', 'relief', 'screen'
  ]);
});

test('le menu d options dessine ses quatre libellés', () => {
  const { ctx, texts } = fakeCtx();
  drawOptionsPanel(ctx, layoutOptionsPanel(), { labels: OPTIONS_LABELS, hoverId: null });
  const drawn = texts.join('\n');
  for (const label of [
    OPTIONS_LABELS.heading, OPTIONS_LABELS.controls, OPTIONS_LABELS.screen,
    OPTIONS_LABELS.relief, OPTIONS_LABELS.close
  ]) {
    assert.ok(drawn.includes(label), `${label} n'est pas dessiné`);
  }
});

test('les tuiles du menu d options ne se chevauchent pas', () => {
  // La troisième tuile a ouvert une deuxième rangée, donc la sortie a dû
  // descendre : sans ce test, elle aurait pu descendre sous la toile ou rester
  // sous la rangée neuve, et le rendu seul l'aurait dit.
  const regions = layoutOptionsPanel();
  for (let i = 0; i < regions.length; i++) {
    for (let j = i + 1; j < regions.length; j++) {
      const a = regions[i];
      const b = regions[j];
      const apart =
        a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
      assert.ok(apart, `${a.id} et ${b.id} se chevauchent`);
    }
  }
});

test('les deux panneaux tiennent sur la tablette', () => {
  // Même surface physique, donc même toile : un panneau plus grand serait
  // écrasé, un plus petit flou.
  assert.deepEqual(SCREEN_PANEL_SIZE, { width: 1024, height: 768 });
  assert.deepEqual(OPTIONS_PANEL_SIZE, SCREEN_PANEL_SIZE);

  for (const regions of [layoutScreenPanel(DEFAULT_SHAPE), layoutOptionsPanel()]) {
    for (const r of regions) {
      assert.ok(r.x >= 0 && r.y >= 0, `${r.id} sort par le haut ou la gauche`);
      assert.ok(r.x + r.w <= SCREEN_PANEL_SIZE.width, `${r.id} sort à droite`);
      assert.ok(r.y + r.h <= SCREEN_PANEL_SIZE.height, `${r.id} sort en bas`);
    }
  }
});
