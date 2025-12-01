import { Router } from 'express';
import multer from 'multer';
import { randomUUID } from 'crypto';
import path from 'path';
import { promises as fs } from 'fs';
import { User } from '../types/index.js';
import { findGameMetadata } from '../services/metadata-loader.js';
import { prisma } from '../db/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { createLogger } from '../utils/logger.js';
import { getRooms } from '../websocket/index.js';

const logger = createLogger('Games');

export const gamesRouter = Router();

// Configure multer for ROM uploads
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const romsDir = process.env.ROMS_DIR || './roms';
    await fs.mkdir(romsDir, { recursive: true });
    cb(null, romsDir);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${randomUUID()}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB max
  },
  fileFilter: (req, file, cb) => {
    const allowedExtensions = ['.smc', '.sfc', '.fig', '.swc', '.mgd', '.zip'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedExtensions.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only SNES ROM files are allowed.'));
    }
  }
});

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

// Upload a new game
gamesRouter.post('/upload', upload.single('rom'), async (req, res) => {
  const user = req.user as User;

  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  // Check if user has reached the maximum number of games
  const gameCount = await prisma.game.count({
    where: { userId: user.id }
  });

  const MAX_GAMES_PER_USER = 100;
  if (gameCount >= MAX_GAMES_PER_USER) {
    // Delete the uploaded file since we won't use it
    try {
      await fs.unlink(req.file.path);
    } catch (error) {
      logger.error({ err: error }, 'Failed to delete rejected ROM file');
    }
    return res.status(400).json({ error: `Maximum number of games reached (${MAX_GAMES_PER_USER})` });
  }

  const { title } = req.body;

  // Extract title from filename if not provided
  const detectedTitle = title || path.basename(req.file.originalname, path.extname(req.file.originalname));

  // Try to find metadata for this game
  const metadata = await findGameMetadata(detectedTitle);

  // Create game with metadata if found
  const gameData: any = {
    title: metadata?.title || detectedTitle,
    filename: req.file.originalname,
    romPath: req.file.path,
    userId: user.id
  };

  // Add metadata fields if available
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
  } else {
    logger.debug({ title: detectedTitle }, 'No metadata found for game');
  }

  const game = await prisma.game.create({
    data: gameData
  });

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

  // Delete ROM file
  try {
    await fs.unlink(game.romPath);
  } catch (error) {
    logger.error({ err: error, romPath: game.romPath }, 'Failed to delete ROM file');
  }

  // Delete from database (cascade will delete saves)
  await prisma.game.delete({
    where: { id: gameId }
  });

  res.json({ message: 'Game deleted' });
});

// Download ROM file (for client-side emulation)
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

  // Check if ROM file exists
  try {
    await fs.access(game.romPath);
  } catch (error) {
    return res.status(404).json({ error: 'ROM file not found on server' });
  }

  // Send ROM file
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${game.filename}"`);
  res.sendFile(path.resolve(game.romPath));
});

// Download ROM file for a room (allows guest to download if in room)
gamesRouter.get('/room/:roomId/rom', async (req, res) => {
  const user = req.user as User;
  const { roomId } = req.params;

  // Find the room
  const rooms = getRooms();
  const room = rooms.get(roomId);

  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  // Check if user is in the room
  const isInRoom = room.players.some(p => p.userId === user.id);
  if (!isInRoom) {
    return res.status(403).json({ error: 'Not authorized - not in room' });
  }

  // Get the game
  const game = await prisma.game.findUnique({
    where: { id: room.gameId }
  });

  if (!game) {
    return res.status(404).json({ error: 'Game not found' });
  }

  // Check if ROM file exists
  try {
    await fs.access(game.romPath);
  } catch (error) {
    return res.status(404).json({ error: 'ROM file not found on server' });
  }

  // Send ROM file
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${game.filename}"`);
  res.sendFile(path.resolve(game.romPath));
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
    // Get all user's games
    const games = await prisma.game.findMany({
      where: { userId: user.id }
    });

    let updatedCount = 0;
    let skippedCount = 0;

    for (const game of games) {
      // Try to find metadata for this game
      const metadata = await findGameMetadata(game.title);

      if (metadata) {
        // Update game with metadata
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
        logger.debug({ title: game.title }, 'No metadata found');
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
