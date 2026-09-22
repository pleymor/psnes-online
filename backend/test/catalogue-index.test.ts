/**
 * Le catalogue normalisé une fois, et non à chaque question posée.
 *
 * `normalizeTitle` enchaîne treize expressions régulières, et la recherche
 * comme l'identification les lançaient sur les 1475 fiches à chaque appel.
 * Ce qui vaut d'être épinglé ici n'est pas la vitesse - elle se mesure, elle
 * ne s'assure pas - mais les deux propriétés sans lesquelles l'index serait
 * faux : il ne doit pas se reconstruire pour un catalogue qu'on tient déjà, et
 * à titre normalisé identique il doit désigner la MÊME fiche que le balayage
 * linéaire qu'il remplace.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogueIndex } from '../src/services/catalogue-index.js';
import type { GameMetadata } from '../src/db/types.js';

function entry(over: Partial<GameMetadata>): GameMetadata {
  return {
    id: over.id ?? 'x', title: over.title ?? 'A Game', altTitle: over.altTitle ?? null,
    genre: null, publisher: null, developer: null, releaseDate: null, players: null,
    region: null, description: null, coverUrl: null, crc32: null, md5: null,
    source: 'catalogue', contributedBy: null, hasCover: false,
    createdAt: new Date(0), updatedAt: new Date(0)
  };
}

test('un catalogue déjà indexé ne se réindexe pas', () => {
  const entries = [entry({ id: 'sm', title: 'Super Metroid' })];

  // L'identité, et non l'égalité : c'est tout le contrat. Le cache est claveté
  // sur le TABLEAU lui-même, si bien qu'il ne peut pas devenir périmé -
  // `invalidateMetadataCache` en fabrique un neuf, qui rate le cache.
  assert.equal(catalogueIndex(entries), catalogueIndex(entries));
});

test('un autre catalogue est indexé à part', () => {
  const before = [entry({ id: 'sm', title: 'Super Metroid' })];
  const after = [entry({ id: 'sm', title: 'Super Metroid' })];

  assert.notEqual(catalogueIndex(before), catalogueIndex(after));
});

test('le titre est rangé sous sa forme normalisée', () => {
  const entries = [entry({ id: 'sm', title: 'The Super Metroid (USA).sfc' })];

  const index = catalogueIndex(entries);

  assert.equal(index.rows[0].title, 'super metroid');
  assert.equal(index.rows[0].altTitle, null);
  assert.equal(index.byTitle.get('super metroid')?.id, 'sm');
});

test("l'alt-titre est rangé lui aussi, sous la même fiche", () => {
  const entries = [entry({ id: 'act', title: 'ActRaiser', altTitle: 'アクトレイザー' })];

  const index = catalogueIndex(entries);

  assert.equal(index.rows[0].altTitle, 'アクトレイザー');
  assert.equal(index.byTitle.get('アクトレイザー')?.id, 'act');
});

test('à titre normalisé identique, la PREMIÈRE fiche du catalogue gagne', () => {
  // Le piège de tout le changement. `findGameMetadata` faisait un `Array.find`,
  // qui rend la première ; une Map remplie sans garde rend la DERNIÈRE, et le
  // dump d'un joueur se met alors à pointer sur une autre fiche sans que rien
  // ne le dise.
  const entries = [
    entry({ id: 'premiere', title: 'Super Metroid' }),
    entry({ id: 'doublon', title: 'Super Metroid (USA)' })
  ];

  assert.equal(catalogueIndex(entries).byTitle.get('super metroid')?.id, 'premiere');
});

test("une fiche dont l'ALT-titre correspond plus tôt bat un titre plus loin", () => {
  // Même règle, et c'est bien ce que faisait le `find` : il rendait la première
  // fiche dont le titre OU l'alt-titre correspondait, sans préférer l'un à
  // l'autre.
  const entries = [
    entry({ id: 'par-alt', title: 'Contra III', altTitle: 'Super Probotector' }),
    entry({ id: 'par-titre', title: 'Super Probotector' })
  ];

  assert.equal(catalogueIndex(entries).byTitle.get('super probotector')?.id, 'par-alt');
});
