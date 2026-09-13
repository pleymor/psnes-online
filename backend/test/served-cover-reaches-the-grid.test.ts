/**
 * Ce que l'API rend vraiment pour une jaquette, et non ce que db/ croit rendre.
 *
 * Le 13/09/2026, `servedCoverUrl` a été ajouté avec une couture dans
 * `toMetadata` - `servedCoverUrl ?? coverUrl` - et la conclusion « rien
 * au-dessus de db/ ne voit qu'il y a deux colonnes » a été VÉRIFIÉE AVEC UNE
 * REQUÊTE ÉCRITE POUR L'OCCASION, qui lisait `servedCoverUrl`. Elle ne prouvait
 * donc que ce qu'elle affirmait.
 *
 * En production, la grille chargeait toujours ses 66 jaquettes chez
 * raw.githubusercontent. Deux chemins passent à côté de la couture :
 *
 *   - `listGamesWithSaveSummaries` lit `m.coverUrl` en SQL direct ;
 *   - `Game.coverUrl` est une copie figée au moment où le jeu a été ajouté.
 *
 * Ce fichier teste la sortie, pas la colonne. C'est le test qui manquait.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { migratedDb, insertUser } from './helpers.js';
import {
  createGame,
  listGamesWithSaveSummaries,
  findOwnedGameForRoom
} from '../src/db/games.js';
import { createSave, findSaveWithGame } from '../src/db/saves.js';
import {
  insertGameMetadataBatch,
  listGameMetadata,
  setServedCover
} from '../src/db/game-metadata.js';
import { claimChecksum } from '../src/db/metadata-links.js';
import { invalidateMetadataCache } from '../src/services/metadata-loader.js';

const LIBRETRO =
  'https://raw.githubusercontent.com/libretro-thumbnails/SNES/master/Named_Boxarts/DBZ.png';
const SERVED = '/covers/b859fdf041d7b9fd.webp';

const NO_METADATA = {
  genre: null, publisher: null, developer: null, releaseDate: null,
  players: null, region: null, description: null, coverUrl: null
};

/**
 * Une entrée de catalogue déjà ingérée, et le jeu d'un joueur qui porte encore
 * l'URL distante - exactement l'état de la production après la chauffe.
 */
function seeded(opts: { linked: boolean }) {
  const db = migratedDb();
  const user = insertUser(db);

  insertGameMetadataBatch(db, [{
    title: 'Dragon Ball Z: La Legende Saien', altTitle: null, genre: null,
    publisher: null, developer: null, releaseDate: null, players: null,
    region: null, description: null, coverUrl: LIBRETRO,
    crc32: null, md5: null
  }]);
  const entry = listGameMetadata(db)[0];
  setServedCover(db, entry.id, SERVED);
  // Le cache catalogue est un module partagé par le processus bun : sans ça,
  // un test voisin aurait déjà figé une version sans jaquette servie.
  invalidateMetadataCache();

  const game = createGame(db, {
    title: 'Dragon Ball Z: La Legende Saien',
    filename: 'dbz.sfc',
    crc32: '8F24F886',
    userId: user.id,
    ...NO_METADATA,
    // La copie figée : le jeu a été ajouté avant la chauffe.
    coverUrl: LIBRETRO
  });

  if (opts.linked) {
    claimChecksum(db, { crc32: '8F24F886', metadataId: entry.id, contributedBy: user.id });
  }

  return { db, user, game, entry };
}

test('un jeu identifié montre la jaquette servie, pas celle de libretro', () => {
  const { db, user } = seeded({ linked: true });

  const [listed] = listGamesWithSaveSummaries(db, user.id);

  assert.equal(listed.coverUrl, SERVED);
});

test('un jeu NON identifié aussi, alors que sa ligne porte encore l URL distante', () => {
  // Trente-trois des soixante-six jeux de la production sont dans ce cas :
  // aucun lien de checksum, donc `Game.coverUrl` est tout ce qu'il y a.
  const { db, user, game } = seeded({ linked: false });

  const [listed] = listGamesWithSaveSummaries(db, user.id);

  assert.equal(listed.coverUrl, SERVED);
  assert.equal(
    db.prepare(`SELECT coverUrl FROM "Game" WHERE id = ?`).get(game.id).coverUrl,
    LIBRETRO,
    'la traduction se fait à la lecture : la ligne du joueur n est pas réécrite'
  );
});

test('une sauvegarde rapporte le jeu avec la même jaquette', () => {
  // `findSaveWithGame` a sa propre requête et lisait `g.coverUrl` sans passer
  // par la couture non plus.
  const { db, game } = seeded({ linked: true });
  const save = createSave(db, {
    gameId: game.id, slotNumber: 1, name: 'avant le boss',
    data: Buffer.from([1, 2, 3]), screenshot: null
  });

  const found = findSaveWithGame(db, save.id);

  assert.equal(found!.game.coverUrl, SERVED);
});

test('une jaquette qu on n a jamais ingérée est rendue telle quelle', () => {
  // Soixante et une entrées du catalogue n ont aucune jaquette, et deux ont
  // échoué. Traduire ne veut pas dire inventer.
  const db = migratedDb();
  const user = insertUser(db);
  const ailleurs = 'https://example.invalid/jamais-vue.png';
  createGame(db, {
    title: 'Inconnu au bataillon', filename: 'x.sfc', crc32: 'CCCCCCCC',
    userId: user.id, ...NO_METADATA, coverUrl: ailleurs
  });
  invalidateMetadataCache();

  const [listed] = listGamesWithSaveSummaries(db, user.id);

  assert.equal(listed.coverUrl, ailleurs);
});

test('un jeu sans jaquette du tout en reste sans', () => {
  const db = migratedDb();
  const user = insertUser(db);
  createGame(db, {
    title: 'Sans image', filename: 'y.sfc', crc32: 'DDDDDDDD',
    userId: user.id, ...NO_METADATA
  });
  invalidateMetadataCache();

  const [listed] = listGamesWithSaveSummaries(db, user.id);

  assert.equal(listed.coverUrl, null);
});

test('le salon diffuse la jaquette servie, pas celle de libretro', () => {
  // `findOwnedGameForRoom` a elle aussi sa propre requete, et ce qu elle rend
  // part vers l autre joueur comme source d image : c est ce que dit deja son
  // commentaire, « broadcast to them and rendered as an image source ».
  const { db, user, game } = seeded({ linked: true });

  const facts = findOwnedGameForRoom(db, game.id, user.id);

  assert.equal(facts!.coverUrl, SERVED);
  assert.equal(facts!.crc32, '8F24F886', 'le checksum ne doit pas bouger');
});
