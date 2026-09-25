/**
 * La règle de fusion de la synchronisation (#71), sans base ni serveur.
 *
 * La même discipline qu'`import-plan.test.ts` : une décision qu'un test ne
 * peut pas atteindre est une décision que personne ne peut prouver. Le cas
 * qui compte est celui où les deux côtés ont avancé : il doit TOUJOURS finir
 * avec les deux, jamais avec un seul.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  planSramSync,
  planStateSync,
  QUICK_SAVE_NAME,
  type StoredState
} from '../src/saves/sync-plan.js';

const NOW = 1_800_000_000_000;
const bytes = (...b: number[]) => new Uint8Array(b);

/* ------------------------------------------------------------------ SRAM */

test('rien de stocké : la SRAM arrivée est écrite, datée de son moment', () => {
  const plan = planSramSync(null, { bytes: bytes(1), base: null, savedAt: NOW - 5000 }, NOW);
  assert.deepEqual(plan, { kind: 'write', updatedAt: NOW - 5000 });
});

test('un appareil qui avait vu la version stockée la remplace : il en descend', () => {
  const plan = planSramSync(
    { bytes: bytes(1), updatedAt: NOW - 10_000 },
    { bytes: bytes(2), base: NOW - 10_000, savedAt: NOW - 1000 },
    NOW
  );
  assert.deepEqual(plan, { kind: 'fast-forward', updatedAt: NOW - 1000 });
});

test('les mêmes octets ne sont pas une écriture : un envoi rejoué ne change rien', () => {
  const plan = planSramSync(
    { bytes: bytes(7, 7), updatedAt: NOW - 10_000 },
    { bytes: bytes(7, 7), base: null, savedAt: NOW },
    NOW
  );
  assert.deepEqual(plan, { kind: 'same', updatedAt: NOW - 10_000 });
});

test('divergence, l\'arrivée est plus récente : elle devient la SRAM, la stockée est gardée', () => {
  // Deux appareils partis de la version 100, chacun a joué de son côté.
  const plan = planSramSync(
    { bytes: bytes(1), updatedAt: NOW - 60_000 },
    { bytes: bytes(2), base: NOW - 120_000, savedAt: NOW - 1000 },
    NOW
  );
  assert.equal(plan.kind, 'incoming-wins');
  assert.equal(plan.updatedAt, NOW - 1000);
  assert.deepEqual((plan as { keep: unknown }).keep, { savedAt: NOW - 60_000 });
});

test('divergence, la stockée est plus récente : elle reste, l\'arrivée est gardée à côté', () => {
  // Le cas de l'appareil resté hors-ligne : il arrive le dernier avec une
  // partie jouée plus tôt. Arriver le dernier ne doit pas suffire à gagner.
  const plan = planSramSync(
    { bytes: bytes(1), updatedAt: NOW - 1000 },
    { bytes: bytes(2), base: NOW - 120_000, savedAt: NOW - 60_000 },
    NOW
  );
  assert.deepEqual(plan, { kind: 'stored-wins', updatedAt: NOW - 1000, keep: { savedAt: NOW - 60_000 } });
});

test('un appareil jamais synchronisé ne prouve rien : ses octets différents sont un conflit, pas un écrasement', () => {
  const plan = planSramSync(
    { bytes: bytes(1), updatedAt: NOW - 1000 },
    { bytes: bytes(2), base: null, savedAt: NOW - 500 },
    NOW
  );
  assert.equal(plan.kind, 'incoming-wins', 'le plus récent gagne, mais la stockée est gardée');
});

test('aucun conflit ne finit avec un seul côté', () => {
  for (const savedAt of [NOW - 90_000, NOW - 30_000, NOW]) {
    for (const base of [null, NOW - 200_000]) {
      const plan = planSramSync(
        { bytes: bytes(1), updatedAt: NOW - 30_000 },
        { bytes: bytes(2), base, savedAt },
        NOW
      );
      assert.ok(
        plan.kind === 'incoming-wins' || plan.kind === 'stored-wins',
        `savedAt ${savedAt}, base ${base} : ${plan.kind}`
      );
    }
  }
});

test('une horloge en avance est bornée à l\'heure du serveur, pour ne pas gagner tous les conflits à venir', () => {
  const plan = planSramSync(null, { bytes: bytes(1), base: null, savedAt: NOW + 86_400_000 }, NOW);
  assert.equal(plan.updatedAt, NOW);
});

test('une avance rapide pose toujours une version nouvelle, même sur une horloge en retard', () => {
  // `base` compare des nombres : deux versions au même nombre seraient
  // indiscernables pour le prochain appareil qui revient.
  const plan = planSramSync(
    { bytes: bytes(1), updatedAt: NOW - 1000 },
    { bytes: bytes(2), base: NOW - 1000, savedAt: NOW - 50_000 },
    NOW
  );
  assert.deepEqual(plan, { kind: 'fast-forward', updatedAt: NOW - 999 });
});

/* ------------------------------------------------------------ savestates */

const quick = (over: Partial<StoredState> = {}): StoredState => ({
  id: 'q', name: QUICK_SAVE_NAME, slotNumber: 3, kind: 'state', updatedAt: NOW - 10_000, ...over
});

test('un savestate nouveau prend l\'emplacement au-dessus du plus haut', () => {
  const plan = planStateSync(
    [{ id: 'a', name: 'x', slotNumber: 7, kind: 'state', updatedAt: 1 }],
    { name: 'y', savedAt: NOW - 1 },
    NOW
  );
  assert.deepEqual(plan, { kind: 'create', name: 'y', slotNumber: 8, savedAt: NOW - 1 });
});

test('écraser le savestate que le joueur a vu, c\'est son geste : il est écrasé', () => {
  const stored = { id: 'a', name: 'x', slotNumber: 1, kind: 'state' as const, updatedAt: NOW - 5000 };
  const plan = planStateSync([stored], { name: 'x', savedAt: NOW, replaces: { id: 'a', updatedAt: NOW - 5000 } }, NOW);
  assert.deepEqual(plan, { kind: 'overwrite', id: 'a', savedAt: NOW });
});

test('écraser un savestate qu\'un autre appareil a réécrit depuis garde les deux', () => {
  const stored = { id: 'a', name: 'x', slotNumber: 1, kind: 'state' as const, updatedAt: NOW - 1000 };
  const plan = planStateSync([stored], { name: 'x', savedAt: NOW, replaces: { id: 'a', updatedAt: NOW - 5000 } }, NOW);
  assert.equal(plan.kind, 'create');
});

test('écraser un savestate supprimé depuis le recrée plutôt que de le perdre', () => {
  const plan = planStateSync([], { name: 'x', savedAt: NOW, replaces: { id: 'gone', updatedAt: NOW - 5000 } }, NOW);
  assert.equal(plan.kind, 'create');
});

test('une SRAM gardée n\'est jamais la cible d\'un écrasement', () => {
  const kept = { id: 's', name: '__sram__', slotNumber: 1, kind: 'sram' as const, updatedAt: NOW - 5000 };
  const plan = planStateSync([kept], { name: 'x', savedAt: NOW, replaces: { id: 's', updatedAt: NOW - 5000 } }, NOW);
  assert.equal(plan.kind, 'create');
});

test('sauvegarde rapide : la première est créée', () => {
  assert.deepEqual(
    planStateSync([], { name: QUICK_SAVE_NAME, savedAt: NOW }, NOW),
    { kind: 'create', name: QUICK_SAVE_NAME, slotNumber: 1, savedAt: NOW }
  );
});

test('sauvegarde rapide prise hors-ligne, plus récente : elle devient LA rapide, l\'autre est gardée', () => {
  const plan = planStateSync([quick()], { name: QUICK_SAVE_NAME, savedAt: NOW - 1000 }, NOW);
  assert.deepEqual(plan, { kind: 'take-quick', renameId: 'q', slotNumber: 4, savedAt: NOW - 1000 });
});

test('sauvegarde rapide prise hors-ligne, plus ancienne : la rapide reste, l\'arrivée est gardée à côté', () => {
  const plan = planStateSync([quick()], { name: QUICK_SAVE_NAME, savedAt: NOW - 60_000 }, NOW);
  assert.deepEqual(plan, { kind: 'keep-beside-quick', slotNumber: 4, savedAt: NOW - 60_000 });
});

test('sauvegarde rapide écrasée en connaissance de cause : écrasée, sans copie', () => {
  const plan = planStateSync(
    [quick()],
    { name: QUICK_SAVE_NAME, savedAt: NOW, replaces: { id: 'q', updatedAt: NOW - 10_000 } },
    NOW
  );
  assert.deepEqual(plan, { kind: 'overwrite', id: 'q', savedAt: NOW });
});
