import { Router } from 'express';
import { User } from '../types/index.js';
import { findGameMetadata, findGameMetadataByChecksum } from '../services/metadata-loader.js';
import { getDb } from '../db/sqlite.js';
import {
  listGamesWithSaveSummaries, listGamesFor, findGameById, findGameWithSaves,
  findGameByChecksum, findOtherGameWithChecksum, countGamesFor, createGame,
  updateGameChecksum, updateGameMetadata, deleteGame
} from '../db/games.js';
import { requireAuth } from '../middleware/auth.js';
import { createLogger } from '../utils/logger.js';
import { asyncHandler } from '../middleware/async-handler.js';

const logger = createLogger('Games');

export const gamesRouter = Router();

const MAX_GAMES_PER_USER = 100;

/**
 * Games, without ever holding a ROM.
 *
 * A row here is a game's identity - its title, its cover, its saves - and
 * `crc32` is what maps it back to a file on the player's own machine. The
 * bytes are never uploaded, never stored and never served: that is the point,
 * and it is why there is no download route below.
 */
gamesRouter.use(requireAuth);

// Get user's game library
gamesRouter.get('/', asyncHandler(async (req, res) => {
  const user = req.user as User;

  const games = listGamesWithSaveSummaries(getDb(), user.id);

  res.json(games);
}));

/**
 * Adds a game the player already has on disk.
 *
 * Takes a checksum and a filename, never the file. Metadata is matched on the
 * checksum first and the filename only as a fallback, because a checksum
 * identifies a dump exactly while a filename is a guess.
 */
gamesRouter.post('/', asyncHandler(async (req, res) => {
  const user = req.user as User;
  const { checksum, filename, title } = req.body ?? {};

  if (typeof checksum !== 'string' || !/^[0-9A-F]{8}$/.test(checksum)) {
    return res.status(400).json({ error: 'A CRC32 checksum is required' });
  }
  if (typeof filename !== 'string' || !filename) {
    return res.status(400).json({ error: 'A filename is required' });
  }

  const db = getDb();
  const existing = findGameByChecksum(db, user.id, checksum);
  if (existing) {
    // Not an error: picking a ROM already in the library should land on it,
    // with its saves, rather than creating a second copy.
    return res.json(existing);
  }

  const count = countGamesFor(db, user.id);
  if (count >= MAX_GAMES_PER_USER) {
    return res.status(400).json({ error: `Maximum number of games reached (${MAX_GAMES_PER_USER})` });
  }

  const detected = (typeof title === 'string' && title.trim()) || filename.replace(/\.[^.]+$/, '');
  const metadata = (await findGameMetadataByChecksum(checksum)) || (await findGameMetadata(detected));

  const game = createGame(db, {
    title: metadata?.title || detected,
    filename,
    crc32: checksum,
    userId: user.id,
    genre: metadata?.genre ?? null,
    publisher: metadata?.publisher ?? null,
    developer: metadata?.developer ?? null,
    releaseDate: metadata?.releaseDate ?? null,
    players: metadata?.players ?? null,
    region: metadata?.region ?? null,
    description: metadata?.description ?? null,
    coverUrl: metadata?.coverUrl ?? null
  });

  logger.info({ title: game.title, checksum }, 'Game added from the player library');
  res.json(game);
}));

/**
 * Attaches a checksum to a game that predates local ROMs.
 *
 * Those rows came from Drive and the server never saw their bytes, so they
 * have no checksum and cannot be resolved to a local file. This is how a
 * player reconnects one - keeping the row, and with it the saves.
 */
gamesRouter.patch('/:gameId/checksum', asyncHandler(async (req, res) => {
  const user = req.user as User;
  const { checksum } = req.body ?? {};

  if (typeof checksum !== 'string' || !/^[0-9A-F]{8}$/.test(checksum)) {
    return res.status(400).json({ error: 'A CRC32 checksum is required' });
  }

  const db = getDb();
  const game = findGameById(db, req.params.gameId);
  if (!game) return res.status(404).json({ error: 'Game not found' });
  if (game.userId !== user.id) return res.status(403).json({ error: 'Not authorized' });

  const clash = findOtherGameWithChecksum(db, user.id, checksum, game.id);
  if (clash) {
    return res.status(409).json({ error: 'Another game in your library already has that ROM', gameId: clash.id });
  }

  const updated = updateGameChecksum(db, game.id, checksum);
  logger.info({ gameId: game.id, checksum }, 'Game re-linked to a local ROM');
  res.json(updated);
}));

gamesRouter.delete('/:gameId', asyncHandler(async (req, res) => {
  const user = req.user as User;
  const { gameId } = req.params;

  const db = getDb();
  const game = findGameById(db, gameId);

  if (!game) {
    return res.status(404).json({ error: 'Game not found' });
  }

  if (game.userId !== user.id) {
    return res.status(403).json({ error: 'Not authorized' });
  }

  // Cascade takes the saves. Nothing else to clean up: the server never held
  // the ROM, so deleting a game leaves no file behind.
  deleteGame(db, gameId);

  res.json({ message: 'Game deleted' });
}));

// Get game saves
gamesRouter.get('/:gameId/saves', asyncHandler(async (req, res) => {
  const user = req.user as User;
  const { gameId } = req.params;

  const game = findGameWithSaves(getDb(), gameId);

  if (!game) {
    return res.status(404).json({ error: 'Game not found' });
  }

  if (game.userId !== user.id) {
    return res.status(403).json({ error: 'Not authorized' });
  }

  res.json(game.saves);
}));

// Refresh metadata for all user's games
gamesRouter.post('/refresh-metadata', asyncHandler(async (req, res) => {
  const user = req.user as User;

  try {
    const db = getDb();
    const games = listGamesFor(db, user.id);

    let updatedCount = 0;
    let skippedCount = 0;

    for (const game of games) {
      const metadata = await findGameMetadata(game.title);

      if (metadata) {
        updateGameMetadata(db, game.id, {
          title: metadata.title,
          genre: metadata.genre ?? null,
          publisher: metadata.publisher ?? null,
          developer: metadata.developer ?? null,
          releaseDate: metadata.releaseDate ?? null,
          players: metadata.players ?? null,
          region: metadata.region ?? null,
          description: metadata.description ?? null,
          coverUrl: metadata.coverUrl ?? null
        });
        updatedCount++;
        logger.info({ oldTitle: game.title, newTitle: metadata.title }, 'Updated metadata');
      } else {
        skippedCount++;
      }
    }

    res.json({
      success: true,
      total: games.length,
      updated: updatedCount,
      skipped: skippedCount
    });
  } catch (error) {
    logger.error({ err: error }, 'Error refreshing metadata');
    res.status(500).json({ error: 'Failed to refresh metadata' });
  }
}));
