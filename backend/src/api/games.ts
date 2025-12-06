import { Router } from 'express';
import path from 'path';
import { User } from '../types/index.js';
import { findGameMetadata } from '../services/metadata-loader.js';
import { prisma } from '../db/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { createLogger } from '../utils/logger.js';
import { getRooms } from '../websocket/index.js';
import { getValidAccessToken, downloadDriveFile, getDriveFileMetadata, listDriveFolder } from '../services/google-drive.js';
import { getCachedRom } from '../services/rom-cache.js';

const logger = createLogger('Games');

export const gamesRouter = Router();

const ALLOWED_EXTENSIONS = ['.smc', '.sfc', '.fig', '.swc', '.mgd', '.zip'];
const MAX_GAMES_PER_USER = 100;

gamesRouter.use(requireAuth);

// Get user's game library
gamesRouter.get('/', async (req, res) => {
  const user = req.user as User;

  const games = await prisma.game.findMany({
    where: { userId: user.id },
    include: {
      saves: {
        select: {
          id: true,
          name: true,
          slotNumber: true,
          screenshot: true,
          createdAt: true,
          updatedAt: true
        }
      }
    },
    orderBy: { uploadedAt: 'desc' }
  });

  res.json(games);
});

// Get access token for Google Drive Picker
gamesRouter.get('/drive-token', async (req, res) => {
  const user = req.user as User;

  try {
    const accessToken = await getValidAccessToken(user.id);
    res.json({ accessToken });
  } catch (error: any) {
    logger.error({ err: error, userId: user.id }, 'Failed to get Drive token');
    res.status(401).json({ error: 'Drive not connected. Please re-authenticate.' });
  }
});

// List contents of a Drive folder
gamesRouter.get('/drive-folder/:folderId?', async (req, res) => {
  const user = req.user as User;
  const { folderId } = req.params;

  try {
    const items = await listDriveFolder(user.id, folderId === 'root' ? undefined : folderId);
    res.json(items);
  } catch (error: any) {
    logger.error({ err: error, userId: user.id, folderId }, 'Failed to list Drive folder');
    res.status(500).json({ error: 'Failed to list folder contents' });
  }
});

// Add game from Google Drive
gamesRouter.post('/add-from-drive', async (req, res) => {
  const user = req.user as User;
  const { driveFileId, driveFileName, title } = req.body;

  if (!driveFileId || !driveFileName) {
    return res.status(400).json({ error: 'Missing Drive file information' });
  }

  // Validate file extension
  const ext = path.extname(driveFileName).toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return res.status(400).json({ error: 'Invalid file type. Only SNES ROM files are allowed.' });
  }

  // Check game count limit
  const gameCount = await prisma.game.count({ where: { userId: user.id } });
  if (gameCount >= MAX_GAMES_PER_USER) {
    return res.status(400).json({ error: `Maximum number of games reached (${MAX_GAMES_PER_USER})` });
  }

  // Verify file exists and is accessible
  try {
    await getDriveFileMetadata(user.id, driveFileId);
  } catch (error) {
    logger.error({ err: error, driveFileId }, 'Cannot access Drive file');
    return res.status(400).json({ error: 'Cannot access Drive file. Make sure the file exists and you have permission.' });
  }

  const detectedTitle = title || path.basename(driveFileName, ext);
  const metadata = await findGameMetadata(detectedTitle);

  const gameData: any = {
    title: metadata?.title || detectedTitle,
    filename: driveFileName,
    driveFileId,
    driveFileName,
    userId: user.id
  };

  if (metadata) {
    logger.info({ title: metadata.title }, 'Found metadata for game');
    gameData.genre = metadata.genre;
    gameData.publisher = metadata.publisher;
    gameData.developer = metadata.developer;
    gameData.releaseDate = metadata.releaseDate;
    gameData.players = metadata.players;
    gameData.region = metadata.region;
    gameData.description = metadata.description;
    gameData.coverUrl = metadata.coverUrl;
  }

  const game = await prisma.game.create({ data: gameData });

  res.json(game);
});

// Delete a game
gamesRouter.delete('/:gameId', async (req, res) => {
  const user = req.user as User;
  const { gameId } = req.params;

  const game = await prisma.game.findUnique({
    where: { id: gameId }
  });

  if (!game) {
    return res.status(404).json({ error: 'Game not found' });
  }

  if (game.userId !== user.id) {
    return res.status(403).json({ error: 'Not authorized' });
  }

  // Delete from database (cascade will delete saves)
  // Note: ROM is stored in user's Drive, not on server
  await prisma.game.delete({
    where: { id: gameId }
  });

  res.json({ message: 'Game deleted' });
});

// Download ROM file from Google Drive (for single player)
gamesRouter.get('/:gameId/download', async (req, res) => {
  const user = req.user as User;
  const { gameId } = req.params;

  const game = await prisma.game.findUnique({
    where: { id: gameId }
  });

  if (!game) {
    return res.status(404).json({ error: 'Game not found' });
  }

  if (game.userId !== user.id) {
    return res.status(403).json({ error: 'Not authorized' });
  }

  try {
    const romBuffer = await downloadDriveFile(user.id, game.driveFileId);

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${game.filename}"`);
    res.send(romBuffer);
  } catch (error: any) {
    logger.error({ err: error, gameId, driveFileId: game.driveFileId }, 'Failed to download ROM from Drive');
    res.status(500).json({ error: 'Failed to download ROM from Google Drive' });
  }
});

// Download ROM file for a room (from cache for multiplayer)
gamesRouter.get('/room/:roomId/rom', async (req, res) => {
  const user = req.user as User;
  const { roomId } = req.params;

  const rooms = getRooms();
  const room = rooms.get(roomId);

  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  const isInRoom = room.players.some(p => p.userId === user.id);
  if (!isInRoom) {
    return res.status(403).json({ error: 'Not authorized - not in room' });
  }

  // Get cached ROM path
  const cachedPath = await getCachedRom(roomId);
  if (!cachedPath) {
    return res.status(404).json({ error: 'ROM not cached. Room may need to be recreated.' });
  }

  const game = await prisma.game.findUnique({
    where: { id: room.gameId }
  });

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${game?.filename || 'rom.smc'}"`);
  res.sendFile(path.resolve(cachedPath));
});

// Get game saves
gamesRouter.get('/:gameId/saves', async (req, res) => {
  const user = req.user as User;
  const { gameId } = req.params;

  const game = await prisma.game.findUnique({
    where: { id: gameId },
    include: { saves: true }
  });

  if (!game) {
    return res.status(404).json({ error: 'Game not found' });
  }

  if (game.userId !== user.id) {
    return res.status(403).json({ error: 'Not authorized' });
  }

  res.json(game.saves);
});

// Refresh metadata for all user's games
gamesRouter.post('/refresh-metadata', async (req, res) => {
  const user = req.user as User;

  try {
    const games = await prisma.game.findMany({
      where: { userId: user.id }
    });

    let updatedCount = 0;
    let skippedCount = 0;

    for (const game of games) {
      const metadata = await findGameMetadata(game.title);

      if (metadata) {
        await prisma.game.update({
          where: { id: game.id },
          data: {
            title: metadata.title,
            genre: metadata.genre,
            publisher: metadata.publisher,
            developer: metadata.developer,
            releaseDate: metadata.releaseDate,
            players: metadata.players,
            region: metadata.region,
            description: metadata.description,
            coverUrl: metadata.coverUrl
          }
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
});
