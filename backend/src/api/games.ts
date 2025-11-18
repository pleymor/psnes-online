import { Router } from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { promises as fs } from 'fs';
import { User } from '../types/index.js';
import { findGameMetadata, refreshGameMetadata } from '../services/metadata-loader.js';
import { prisma } from '../db/prisma.js';

export const gamesRouter = Router();

// Middleware to check authentication
const requireAuth = (req: any, res: any, next: any) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
};

// Configure multer for ROM uploads
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const romsDir = process.env.ROMS_DIR || './roms';
    await fs.mkdir(romsDir, { recursive: true });
    cb(null, romsDir);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${uuidv4()}${path.extname(file.originalname)}`;
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
    console.log(`✅ Found metadata for "${metadata.title}"`);
    gameData.genre = metadata.genre;
    gameData.publisher = metadata.publisher;
    gameData.developer = metadata.developer;
    gameData.releaseDate = metadata.releaseDate;
    gameData.players = metadata.players;
    gameData.region = metadata.region;
    gameData.description = metadata.description;
    gameData.coverUrl = metadata.coverUrl;
  } else {
    console.log(`ℹ️  No metadata found for "${detectedTitle}"`);
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
    console.error('Failed to delete ROM file:', error);
  }

  // Delete from database (cascade will delete saves)
  await prisma.game.delete({
    where: { id: gameId }
  });

  res.json({ message: 'Game deleted' });
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
        console.log(`✅ Updated metadata for "${game.title}" -> "${metadata.title}"`);
      } else {
        skippedCount++;
        console.log(`ℹ️  No metadata found for "${game.title}"`);
      }
    }

    res.json({
      success: true,
      total: games.length,
      updated: updatedCount,
      skipped: skippedCount
    });
  } catch (error) {
    console.error('Error refreshing metadata:', error);
    res.status(500).json({ error: 'Failed to refresh metadata' });
  }
});
