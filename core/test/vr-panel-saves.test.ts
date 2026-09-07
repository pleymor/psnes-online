/**
 * Le panneau des sauvegardes, sur la tablette.
 *
 * Il existe parce que la VR ne savait que CHARGER, et seulement avant de
 * lancer : l'écran de lancement listait les sauvegardes d'un jeu, et une fois
 * la partie commencée il n'y avait plus rien. Un emplacement rapide a été
 * essayé d'abord et écarté à l'usage.
 *
 * Ce qu'il ne réinvente pas : les noms. `saveIdentity` est la seule réponse à
 * « comment s'appelle cette sauvegarde », et le dépôt dit pourquoi elle doit
 * rester seule - la sauvegarde rapide est stockée sous la sentinelle
 * `__quick__`, choisie pour qu'aucun joueur ne puisse la taper, et une deuxième
 * réponse a déjà mis ce `__quick__` sur un écran incurvé.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  layoutSavesPanel,
  drawSavesPanel,
  savesRows,
  SAVES_VISIBLE,
  SAVES_PANEL_SIZE,
  type SavesState
} from '../../frontend/src/lib/vr/panels/saves.js';
import type { SaveSummary } from '../../frontend/src/lib/saves/api.js';

const LABELS = {
  heading: 'Sauvegardes',
  newSave: 'Nouvelle sauvegarde',
  close: 'Retour',
  empty: 'Aucune sauvegarde pour ce jeu',
  quickSave: 'Sauvegarde rapide'
};

function save(over: Partial<SaveSummary> = {}): SaveSummary {
  return {
    id: 's1',
    name: 'Avant le boss',
    slotNumber: 1,
    screenshot: null,
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
    ...over
  };
}

function recordingContext() {
  const texts: string[] = [];
  const calls: string[] = [];
  const images: Array<{ x: number; y: number; w: number; h: number }> = [];
  return {
    texts, calls, images,
    font: '', fillStyle: '', strokeStyle: '', lineWidth: 0,
    textAlign: 'left', textBaseline: 'alphabetic',
    imageSmoothingEnabled: false, imageSmoothingQuality: 'low',
    save() {}, restore() {}, clearRect() {}, fillRect() { calls.push('fillRect'); },
    strokeRect() { calls.push('strokeRect'); },
    beginPath() {}, moveTo() {}, lineTo() {}, arcTo() {}, closePath() {},
    arc() {}, fill() {}, stroke() {},
    drawImage(_i: unknown, x: number, y: number, w: number, h: number) {
      calls.push('drawImage');
      images.push({ x, y, w, h });
    },
    fillText(text: string) { texts.push(text); },
    measureText(text: string) { return { width: text.length * 9 }; }
  } as unknown as CanvasRenderingContext2D & {
    texts: string[];
    calls: string[];
    images: Array<{ x: number; y: number; w: number; h: number }>;
    imageSmoothingQuality: string;
  };
}

function state(over: Partial<SavesState> = {}): SavesState {
  return { saves: [save()], shots: new Map(), locale: 'fr', busy: false, ...over };
}

const ids = (s: SavesState) => layoutSavesPanel(s).map((r) => r.id);

test('chaque sauvegarde visible offre son chargement, par son id', () => {
  const s = state({ saves: [save({ id: 'a' }), save({ id: 'b' })] });
  assert.ok(ids(s).includes('load:a'));
  assert.ok(ids(s).includes('load:b'));
});

test('creer et sortir sont toujours offerts', () => {
  for (const saves of [[], [save()]]) {
    const shown = ids(state({ saves }));
    assert.ok(shown.includes('new-save'), 'ecrire une sauvegarde ne depend pas d en avoir');
    assert.ok(shown.includes('close'), 'sans sortie le panneau est un cul-de-sac');
  }
});

/*
 * Rien n'est cliquable pendant qu'une écriture ou un chargement est en vol.
 *
 * `awaitSave` n'attend qu'une réponse à la fois - un deuxième appel dépose
 * l'écouteur du premier - donc une deuxième pression pendant l'attente perdrait
 * silencieusement la première. La même règle que le panneau des contrôles
 * applique pendant une capture.
 */
test('rien n est cliquable pendant qu une operation est en vol', () => {
  assert.deepEqual(ids(state({ busy: true })), []);
});

test('la liste est plafonnee, et garde les plus recentes', () => {
  const many = Array.from({ length: SAVES_VISIBLE + 4 }, (_, i) =>
    save({ id: `s${i}`, updatedAt: `2026-09-0${(i % 9) + 1}T10:00:00.000Z` })
  );
  const rows = savesRows({ ...state({ saves: many }) });
  assert.equal(rows.length, SAVES_VISIBLE, 'il n y a pas de scroll ici, donc un plafond est honnete');

  // `byNewest` d'abord : le plafond garde le haut de la pile, pas son fond.
  const newest = [...many].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  assert.equal(rows[0].id, newest.id, 'la plus recente doit etre la premiere');
});

/*
 * Le nom vient de `saveIdentity`, jamais du nom stocké.
 *
 * La sauvegarde rapide est stockée sous `__quick__`, une sentinelle choisie
 * pour qu'aucun joueur ne puisse la taper. L'afficher brute est un défaut qui
 * s'est déjà produit sur un écran incurvé.
 */
test('la sauvegarde rapide est nommee, pas montree sous sa sentinelle', () => {
  const s = state({ saves: [save({ name: '__quick__' })] });
  const ctx = recordingContext();
  drawSavesPanel(ctx, s, layoutSavesPanel(s), LABELS);
  assert.ok(ctx.texts.includes(LABELS.quickSave));
  assert.ok(!ctx.texts.includes('__quick__'), 'la sentinelle a atteint l ecran');
});

test('une sauvegarde nommee garde son nom', () => {
  const s = state({ saves: [save({ name: 'Avant le boss' })] });
  const ctx = recordingContext();
  drawSavesPanel(ctx, s, layoutSavesPanel(s), LABELS);
  assert.ok(ctx.texts.includes('Avant le boss'));
});

test('une liste vide le dit au lieu de dessiner un panneau blanc', () => {
  const s = state({ saves: [] });
  const ctx = recordingContext();
  drawSavesPanel(ctx, s, layoutSavesPanel(s), LABELS);
  assert.ok(ctx.texts.includes(LABELS.empty));
});

test('une vignette chargee est dessinee, et son absence ne casse rien', () => {
  const withShot = recordingContext();
  const s = state({ shots: new Map([['s1', {} as CanvasImageSource]]) });
  drawSavesPanel(withShot, s, layoutSavesPanel(s), LABELS);
  assert.ok(withShot.calls.includes('drawImage'));

  const without = recordingContext();
  const bare = state();
  drawSavesPanel(without, bare, layoutSavesPanel(bare), LABELS);
  assert.ok(!without.calls.includes('drawImage'));
  // Et la ligne existe quand meme : une sauvegarde sans image reste chargeable.
  assert.ok(ids(bare).includes('load:s1'));
});

test('les vignettes sont reduites avec le bon filtre', () => {
  const ctx = recordingContext();
  const s = state({ shots: new Map([['s1', {} as CanvasImageSource]]) });
  drawSavesPanel(ctx, s, layoutSavesPanel(s), LABELS);
  assert.equal(ctx.imageSmoothingQuality, 'high');
});

test('aucune region ne chevauche une autre ni ne sort du panneau', () => {
  const s = state({
    saves: Array.from({ length: SAVES_VISIBLE }, (_, i) => save({ id: `s${i}` }))
  });
  const regions = layoutSavesPanel(s);
  for (const r of regions) {
    assert.ok(r.x >= 0 && r.y >= 0, `${r.id} sort par en haut a gauche`);
    assert.ok(r.x + r.w <= SAVES_PANEL_SIZE.width, `${r.id} sort par la droite`);
    assert.ok(r.y + r.h <= SAVES_PANEL_SIZE.height, `${r.id} sort par le bas`);
  }
  for (const p of regions) {
    for (const q of regions) {
      if (p === q) continue;
      const apart =
        p.x + p.w <= q.x || q.x + q.w <= p.x || p.y + p.h <= q.y || q.y + q.h <= p.y;
      assert.ok(apart, `${p.id} chevauche ${q.id}, donc hit() en avalera un`);
    }
  }
});
