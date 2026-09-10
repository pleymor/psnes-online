/**
 * Ce qu'un rafraîchissement du catalogue a le droit de détruire.
 *
 * Le fichier JSON est relu à chaque démarrage du backend, donc à chaque
 * déploiement. Il le faisait par DELETE puis INSERT, et `randomUUID()` par
 * ligne : chaque fiche livrée changeait d'identifiant à chaque redémarrage.
 * Or `GameMetadataChecksum.metadataId` est en `ON DELETE CASCADE`, et une
 * jaquette téléversée vit dans la ligne elle-même.
 *
 * La production du 2026-09-10 le montrait sans ambiguïté : 65 jeux dans les
 * bibliothèques, 1475 fiches au catalogue, et **2 liens** - les deux seuls qui
 * pointaient vers des fiches communautaires. Tout le reste avait été effacé au
 * dernier déploiement, et le serait de nouveau au suivant. Le propriétaire l'a
 * signalé ainsi : « je perds mes jaquettes et descriptions à chaque deploy ».
 *
 * Ce qui est épinglé ici est donc l'inverse : une fiche que le fichier décrit
 * toujours garde son identifiant, ce qui garde ses liens et sa jaquette.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { migratedDb, insertUser } from './helpers.js';
import {
  insertGameMetadataBatch, listGameMetadata, findGameMetadataById, setCover, findCover,
  insertCommunityMetadata, syncCatalogue, countGameMetadata
} from '../src/db/game-metadata.js';
import { claimChecksum, findLinkByChecksum } from '../src/db/metadata-links.js';

const EMPTY = {
  altTitle: null, genre: null, publisher: null, developer: null,
  releaseDate: null, players: null, region: null, description: null
};

/** Le catalogue tel que le fichier le décrit. */
const FILE = [
  { title: 'ActRaiser', publisher: 'Enix' },
  { title: 'Umihara Kawase', publisher: 'TNN' }
];

function catalogued(db: ReturnType<typeof migratedDb>, title: string) {
  return listGameMetadata(db).find(m => m.title === title)!;
}

test('une fiche que le fichier decrit toujours garde son identifiant', () => {
  const db = migratedDb();
  insertGameMetadataBatch(db, FILE);
  const before = catalogued(db, 'ActRaiser');

  syncCatalogue(db, FILE);

  // L identifiant est ce que tout le reste designe. Le changer a chaque
  // demarrage est ce qui detruisait les liens et les jaquettes.
  assert.equal(catalogued(db, 'ActRaiser').id, before.id);
});

test('un jeu identifie contre une fiche livree le reste apres un rafraichissement', () => {
  const db = migratedDb();
  const user = insertUser(db);
  insertGameMetadataBatch(db, FILE);
  const entry = catalogued(db, 'ActRaiser');
  claimChecksum(db, { crc32: 'DEADBEEF', metadataId: entry.id, contributedBy: user.id });

  syncCatalogue(db, FILE);

  // Le symptome exact : 65 jeux, 2 liens.
  assert.equal(findLinkByChecksum(db, 'DEADBEEF')?.metadataId, entry.id);
});

test('une jaquette televersee par un joueur survit au rafraichissement', () => {
  const db = migratedDb();
  insertGameMetadataBatch(db, FILE);
  const entry = catalogued(db, 'ActRaiser');
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
  const coverUrl = setCover(db, entry.id, bytes, 'image/png');

  syncCatalogue(db, FILE);

  // Le fichier porte sa propre `coverUrl`, et la reappliquer effacerait
  // l image du joueur - qui est la seule des deux a ne pas etre reproductible.
  assert.deepEqual(findCover(db, entry.id)?.bytes, bytes);
  assert.equal(findGameMetadataById(db, entry.id)!.coverUrl, coverUrl);
});

test('le rafraichissement applique ce que le fichier a change', () => {
  const db = migratedDb();
  insertGameMetadataBatch(db, FILE);
  const entry = catalogued(db, 'ActRaiser');

  syncCatalogue(db, [{ title: 'ActRaiser', publisher: 'Quintet', genre: 'Action' }, FILE[1]]);

  // Garder l identite ne veut pas dire figer le contenu : corriger le fichier
  // livre doit encore servir a quelque chose.
  const after = findGameMetadataById(db, entry.id)!;
  assert.equal(after.publisher, 'Quintet');
  assert.equal(after.genre, 'Action');
});

test('un champ vide dans le fichier efface celui qui etait la', () => {
  const db = migratedDb();
  insertGameMetadataBatch(db, [{ title: 'ActRaiser', publisher: 'Enix', genre: 'Action' }]);
  const entry = catalogued(db, 'ActRaiser');

  syncCatalogue(db, [{ title: 'ActRaiser', publisher: 'Enix' }]);

  // Le fichier fait foi pour ce qu il decrit : retirer un genre du JSON doit
  // le retirer de la base, sinon le catalogue ne se corrige qu en ajoutant.
  assert.equal(findGameMetadataById(db, entry.id)!.genre, null);
});

test('un titre que le fichier a gagne est insere', () => {
  const db = migratedDb();
  insertGameMetadataBatch(db, FILE);

  syncCatalogue(db, [...FILE, { title: 'Rendering Ranger R2', publisher: 'Virgin' }]);

  assert.equal(countGameMetadata(db, 'catalogue'), 3);
  assert.equal(catalogued(db, 'Rendering Ranger R2').publisher, 'Virgin');
});

test('un titre que le fichier a perdu est retire', () => {
  const db = migratedDb();
  insertGameMetadataBatch(db, FILE);

  syncCatalogue(db, [FILE[0]]);

  assert.equal(countGameMetadata(db, 'catalogue'), 1);
  assert.equal(listGameMetadata(db).some(m => m.title === 'Umihara Kawase'), false);
});

test('une fiche ecrite par un joueur n est jamais touchee par un rafraichissement', () => {
  const db = migratedDb();
  const user = insertUser(db);
  const mine = insertCommunityMetadata(db, { title: 'Written By Hand', ...EMPTY }, user.id);
  claimChecksum(db, { crc32: 'CAFEBABE', metadataId: mine.id, contributedBy: user.id });
  insertGameMetadataBatch(db, FILE);

  // Y compris quand elle porte le meme titre qu une fiche livree : ce sont
  // deux lignes distinctes, et le fichier ne possede que la sienne.
  syncCatalogue(db, [...FILE, { title: 'Written By Hand', publisher: 'Nobody' }]);

  assert.equal(findGameMetadataById(db, mine.id)!.publisher, null);
  assert.equal(findLinkByChecksum(db, 'CAFEBABE')?.metadataId, mine.id);
});
