import { randomUUID } from 'node:crypto';
import { asBuffer, type Database } from './sqlite.js';
import type { Game, Save, SaveSummary } from './types.js';
import { mergeIdentity, needsIdentification, type IdentityFields } from './game-identity.js';
import { servedCoversFor } from './game-metadata.js';

/**
 * How many games one account may hold.
 *
 * Here rather than in the route that first enforced it, because it is now
 * enforced in two places: adding a game one at a time, and importing an archive
 * that arrives with up to two hundred of them in a single request. Two copies
 * of this number would drift, and the import would silently become the way
 * round the ceiling.
 */
export const MAX_GAMES_PER_USER = 100;

export interface GameWithSaveSummaries extends Game {
  saves: SaveSummary[];
  /** The catalogue entry this game's dump is linked to, if anyone has said. */
  metadataId: string | null;
  /** Whether to offer the player the chance to say what this game is. */
  needsIdentification: boolean;
}

export interface GameWithSaves extends Game {
  saves: Save[];
}

/** The descriptive columns, which a metadata match fills in and a bare add leaves null. */
export interface GameDescriptiveFields {
  genre: string | null;
  publisher: string | null;
  developer: string | null;
  releaseDate: string | null;
  players: string | null;
  region: string | null;
  description: string | null;
  coverUrl: string | null;
}

/** A metadata refresh also rewrites the title, which creation takes separately. */
export interface GameMetadataFields extends GameDescriptiveFields {
  title: string;
}

interface GameRow {
  id: string;
  title: string;
  filename: string;
  coverUrl: string | null;
  uploadedAt: number;
  genre: string | null;
  publisher: string | null;
  developer: string | null;
  releaseDate: string | null;
  players: string | null;
  region: string | null;
  description: string | null;
  crc32: string | null;
  /** As bun:sqlite hands a BLOB back; `asBuffer` turns it into the Buffer callers expect. */
  sram: Uint8Array | null;
  sramUpdatedAt: number | null;
  userId: string;
}

function toGame(row: GameRow): Game {
  return {
    id: row.id,
    title: row.title,
    filename: row.filename,
    coverUrl: row.coverUrl,
    uploadedAt: new Date(row.uploadedAt),
    genre: row.genre,
    publisher: row.publisher,
    developer: row.developer,
    releaseDate: row.releaseDate,
    players: row.players,
    region: row.region,
    description: row.description,
    crc32: row.crc32,
    sram: asBuffer(row.sram),
    sramUpdatedAt: row.sramUpdatedAt === null ? null : new Date(row.sramUpdatedAt),
    userId: row.userId
  };
}

export function findGameById(db: Database, id: string): Game | null {
  const row = db.query(`SELECT * FROM "Game" WHERE id = ?`).get(id) as GameRow | undefined;
  return row ? toGame(row) : null;
}

export function listGamesFor(db: Database, userId: string): Game[] {
  const rows = db.query(`SELECT * FROM "Game" WHERE userId = ?`).all(userId) as GameRow[];
  return rows.map(toGame);
}

/**
 * The library listing. Saves come back as summaries: the blob is up to a
 * megabyte per slot and the listing never used it.
 */
export function listGamesWithSaveSummaries(db: Database, userId: string): GameWithSaveSummaries[] {
  // The two joins are what make a contribution retroactive: the identity is
  // resolved on the way out rather than copied into the row at creation, so a
  // link posted today reaches a game added a month ago. A NULL g.crc32 matches
  // nothing, which is the right answer for a row that predates local ROMs.
  const games = db.query(`
    SELECT g.*,
           k.metadataId AS linkedMetadataId,
           m.altTitle AS metaAltTitle, m.source AS metaSource,
           m.title AS metaTitle, m.genre AS metaGenre, m.publisher AS metaPublisher,
           m.developer AS metaDeveloper, m.releaseDate AS metaReleaseDate,
           m.players AS metaPlayers, m.region AS metaRegion,
           m.description AS metaDescription, m.coverUrl AS metaCoverUrl,
           -- Ce qu'on sert, quand la passe de chauffe y est passee. Sans
           -- cette colonne, cette requete lisait la source distante et la
           -- couture de toMetadata ne la voyait jamais : la grille a charge
           -- ses jaquettes chez libretro jusqu'au 13/09/2026.
           m.servedCoverUrl AS metaServedCoverUrl
    FROM "Game" g
    LEFT JOIN "GameMetadataChecksum" k ON k.crc32 = g.crc32
    LEFT JOIN "GameMetadata" m ON m.id = k.metadataId
    WHERE g.userId = ?
    ORDER BY g.uploadedAt DESC
  `).all(userId) as (GameRow & {
    linkedMetadataId: string | null;
    metaAltTitle: string | null; metaSource: string | null;
    metaTitle: string | null; metaGenre: string | null; metaPublisher: string | null;
    metaDeveloper: string | null; metaReleaseDate: string | null; metaPlayers: string | null;
    metaRegion: string | null; metaDescription: string | null; metaCoverUrl: string | null;
    metaServedCoverUrl: string | null;
  })[];
  if (games.length === 0) return [];

  // `prepare` et non `query` : le nombre de marqueurs change avec la taille de
  // la bibliothèque, donc chaque taille est un SQL différent. Le cache de
  // `query` est claveté sur la chaîne, et il grossirait d'une entrée par taille
  // rencontrée - jusqu'à cent, ici. Recompiler est moins cher que retenir cent
  // variantes dont on ne réutilisera presque jamais la même.
  const summaries = db.prepare(`
    SELECT id, name, slotNumber, screenshot, createdAt, updatedAt, gameId, kind, syncId
    FROM "Save" WHERE gameId IN (${games.map(() => '?').join(',')})
  `).all(...games.map(g => g.id)) as (Omit<SaveSummary, 'createdAt' | 'updatedAt' | 'kind' | 'syncId'> & {
    createdAt: number; updatedAt: number; gameId: string; kind: string; syncId: string | null;
  })[];

  const byGame = new Map<string, SaveSummary[]>();
  for (const s of summaries) {
    const list = byGame.get(s.gameId) ?? [];
    list.push({
      id: s.id,
      name: s.name,
      slotNumber: s.slotNumber,
      screenshot: s.screenshot,
      createdAt: new Date(s.createdAt),
      updatedAt: new Date(s.updatedAt),
      kind: s.kind === 'sram' ? 'sram' : 'state',
      syncId: s.syncId
    });
    byGame.set(s.gameId, list);
  }

  /*
   * La jaquette d'un jeu NON identifie : `Game.coverUrl` est une copie prise
   * quand le jeu a ete ajoute, et elle porte donc l'URL distante d'alors.
   * Trente-trois des soixante-six jeux de la production sont dans ce cas - sans
   * lien de checksum, cette colonne est tout ce qu'il y a.
   *
   * Traduite ici plutot que reecrite en base : la ligne appartient au joueur,
   * et une traduction a la lecture rattrape aussi les jeux ajoutes avant la
   * chauffe.
   */
  const served = servedCoversFor(
    db,
    games.map(g => g.coverUrl).filter((u): u is string => u !== null)
  );

  return games.map(row => {
    const identity: IdentityFields | null = row.linkedMetadataId === null ? null : {
      title: row.metaTitle,
      genre: row.metaGenre,
      publisher: row.metaPublisher,
      developer: row.metaDeveloper,
      releaseDate: row.metaReleaseDate,
      players: row.metaPlayers,
      region: row.metaRegion,
      description: row.metaDescription,
      coverUrl: row.metaServedCoverUrl ?? row.metaCoverUrl
    };
    const base = toGame(row);
    const game: Game = base.coverUrl === null
      ? base
      : { ...base, coverUrl: served.get(base.coverUrl) ?? base.coverUrl };
    return {
      ...mergeIdentity(game, identity),
      saves: byGame.get(row.id) ?? [],
      metadataId: row.linkedMetadataId,
      /*
       * Beside the merged fields rather than among them, and on purpose.
       * `mergeIdentity` produces a Game, and neither of these is one: they
       * exist so the correction form can open filled in - `altTitle` is the
       * one descriptive field nothing displays, so it is the one a form would
       * silently blank - and so the library knows whether correcting is even
       * offered, since a shipped row would lose the edit at the next deploy.
       */
      metadataAltTitle: row.metaAltTitle,
      metadataSource: row.metaSource,
      needsIdentification: needsIdentification(game, identity)
    };
  });
}

export function findGameWithSaves(db: Database, id: string): GameWithSaves | null {
  const game = findGameById(db, id);
  if (!game) return null;
  const rows = db.query(`SELECT * FROM "Save" WHERE gameId = ?`).all(id) as {
    id: string; name: string; slotNumber: number; data: Uint8Array; screenshot: string | null;
    createdAt: number; updatedAt: number; gameId: string; kind: string;
  }[];
  return {
    ...game,
    saves: rows.map(r => ({
      id: r.id,
      name: r.name,
      slotNumber: r.slotNumber,
      data: asBuffer(r.data),
      screenshot: r.screenshot,
      createdAt: new Date(r.createdAt),
      updatedAt: new Date(r.updatedAt),
      gameId: r.gameId,
      kind: r.kind === 'sram' ? 'sram' : 'state'
    }))
  };
}

export function findGameByChecksum(db: Database, userId: string, crc32: string): Game | null {
  const row = db.query(`SELECT * FROM "Game" WHERE userId = ? AND crc32 = ?`)
    .get(userId, crc32) as GameRow | undefined;
  return row ? toGame(row) : null;
}

/**
 * Whether this player holds a dump that the given catalogue entry describes.
 *
 * The permission to correct an entry, expressed as a query. A catalogue entry
 * reaches every owner of the CRC32 it is claimed by, so the person who can see
 * that it is wrong is any one of them - and equally, someone who owns none of
 * them has no business rewriting what everyone else reads. Contributing it is
 * deliberately not the test: the player who wrote a typo is rarely the one who
 * notices it.
 *
 * The join goes through the link table rather than through `Game.crc32` alone,
 * because owning a game is not owning the catalogue: the dump has to be
 * claimed by THIS entry.
 */
export function ownsDumpLinkedTo(db: Database, userId: string, metadataId: string): boolean {
  // Truthiness, not `!== undefined`: bun:sqlite answers a miss with null, and
  // `null !== undefined` is true - which made this return "yes" for everyone.
  const row = db.query(`
    SELECT 1 AS ok
      FROM "Game" g
      JOIN "GameMetadataChecksum" k ON k.crc32 = g.crc32
     WHERE g.userId = ? AND k.metadataId = ?
     LIMIT 1
  `).get(userId, metadataId) as { ok: number } | null;
  return Boolean(row);
}

export function findOtherGameWithChecksum(
  db: Database, userId: string, crc32: string, excludeGameId: string
): Game | null {
  const row = db.query(`SELECT * FROM "Game" WHERE userId = ? AND crc32 = ? AND id != ?`)
    .get(userId, crc32, excludeGameId) as GameRow | undefined;
  return row ? toGame(row) : null;
}

export function countGamesFor(db: Database, userId: string): number {
  const row = db.query(`SELECT COUNT(*) AS n FROM "Game" WHERE userId = ?`)
    .get(userId) as { n: number };
  return row.n;
}

export function createGame(
  db: Database,
  input: { title: string; filename: string; crc32: string | null; userId: string } & GameDescriptiveFields
): Game {
  const id = randomUUID();
  db.query(`
    INSERT INTO "Game" (id, title, filename, coverUrl, uploadedAt, genre, publisher,
                        developer, releaseDate, players, region, description, crc32,
                        sram, sramUpdatedAt, userId)
    VALUES (@id, @title, @filename, @coverUrl, @uploadedAt, @genre, @publisher,
            @developer, @releaseDate, @players, @region, @description, @crc32,
            NULL, NULL, @userId)
  `).run({
    id,
    title: input.title,
    filename: input.filename,
    coverUrl: input.coverUrl,
    uploadedAt: Date.now(),
    genre: input.genre,
    publisher: input.publisher,
    developer: input.developer,
    releaseDate: input.releaseDate,
    players: input.players,
    region: input.region,
    description: input.description,
    crc32: input.crc32,
    userId: input.userId
  });
  return findGameById(db, id)!;
}

export function updateGameChecksum(db: Database, id: string, crc32: string): Game {
  db.query(`UPDATE "Game" SET crc32 = ? WHERE id = ?`).run(crc32, id);
  return findGameById(db, id)!;
}

export function updateGameMetadata(db: Database, id: string, fields: GameMetadataFields): void {
  db.query(`
    UPDATE "Game" SET
      title = @title, genre = @genre, publisher = @publisher,
      developer = @developer, releaseDate = @releaseDate, players = @players,
      region = @region, description = @description, coverUrl = @coverUrl
    WHERE id = @id
  `).run({
    id,
    title: fields.title,
    genre: fields.genre,
    publisher: fields.publisher,
    developer: fields.developer,
    releaseDate: fields.releaseDate,
    players: fields.players,
    region: fields.region,
    description: fields.description,
    coverUrl: fields.coverUrl
  });
}

export function deleteGame(db: Database, id: string): void {
  db.query(`DELETE FROM "Game" WHERE id = ?`).run(id);
}

/**
 * Ownership check for the save path: returns the id only if the game is theirs.
 *
 * Never pair this with `room.gameId`. A room stores the row of whoever CHOSE
 * the game, and Game.id is per-user, so that pairing silently matches nobody
 * when the other player is the one acting - which is exactly how battery saves
 * were lost under a success acknowledgement. Use `findOwnGameIdForRoom` in
 * `rooms/own-game.ts`, which resolves by the room's checksum instead.
 */
export function findOwnedGameId(db: Database, gameId: string, userId: string): string | null {
  const row = db.query(`SELECT id FROM "Game" WHERE id = ? AND userId = ?`)
    .get(gameId, userId) as { id: string } | undefined;
  return row?.id ?? null;
}

/**
 * The two things a room copies from a game, and only if the game is theirs.
 *
 * Neither may come from a client payload: the other player uses `crc32` to
 * find the file on their own disk, and `coverUrl` is broadcast to them and
 * rendered as an image source. `room:choose-game` in particular can be called
 * by the guest, about a room that is not theirs.
 */
export function findOwnedGameForRoom(
  db: Database, gameId: string, userId: string
): { crc32: string | null; coverUrl: string | null } | null {
  const row = db.query(`SELECT crc32, coverUrl FROM "Game" WHERE id = ? AND userId = ?`)
    .get(gameId, userId) as { crc32: string | null; coverUrl: string | null } | undefined;
  if (!row) return null;

  // Traduite comme partout ailleurs : ce qui part d'ici devient une source
  // d'image chez l'autre joueur, et l'URL figee sur la ligne l'enverrait
  // chercher l'octet chez un tiers.
  if (row.coverUrl === null) return row;
  return {
    crc32: row.crc32,
    coverUrl: servedCoversFor(db, [row.coverUrl]).get(row.coverUrl) ?? row.coverUrl
  };
}

/**
 * Écrit la sauvegarde de pile, et dit combien de lignes ont changé.
 *
 * Le compte n'est pas décoratif. Le `AND userId = ?` fait de cette requête une
 * garde autant qu'une écriture : quand la ligne n'est pas celle de l'appelant,
 * elle ne touche rien et ne lève rien. Un appelant qui ignorait le résultat a
 * pu répondre « sauvegardé » pendant une heure de jeu perdue - d'où le retour,
 * que le gestionnaire doit vérifier avant d'accuser réception.
 */
export function saveSram(db: Database, gameId: string, userId: string, sram: Buffer): number {
  const info = db.query(`UPDATE "Game" SET sram = ?, sramUpdatedAt = ? WHERE id = ? AND userId = ?`)
    .run(sram, Date.now(), gameId, userId);
  return info.changes;
}

export function findSram(
  db: Database, gameId: string, userId: string
): { sram: Buffer; sramUpdatedAt: Date | null } | null {
  const row = db.query(`SELECT sram, sramUpdatedAt FROM "Game" WHERE id = ? AND userId = ?`)
    .get(gameId, userId) as { sram: Uint8Array | null; sramUpdatedAt: number | null } | undefined;
  if (!row?.sram) return null;
  return {
    sram: asBuffer(row.sram),
    sramUpdatedAt: row.sramUpdatedAt === null ? null : new Date(row.sramUpdatedAt)
  };
}
