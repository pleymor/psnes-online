import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { getDb } from '../db/sqlite.js';
import { findCover } from '../db/game-metadata.js';

/**
 * Cover images, straight out of the database.
 *
 * Behind requireAuth, unlike avatars: this is content one player uploaded and
 * another downloads, and a same-origin <img> sends the session cookie anyway,
 * so the check costs nothing at display time.
 *
 * Cached hard because the URL is versioned - setCover appends the write's
 * timestamp - so a replaced cover is a different URL rather than a stale hit.
 */
export const coversRouter = Router();

coversRouter.use(requireAuth);

coversRouter.get('/:metadataId', asyncHandler(async (req, res) => {
  const cover = findCover(getDb(), req.params.metadataId);
  if (!cover) return res.status(404).json({ error: 'Cover not found' });

  res.setHeader('Content-Type', cover.mime);
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(cover.bytes);
}));
