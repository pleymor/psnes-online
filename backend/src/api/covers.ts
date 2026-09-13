import { Router } from 'express';
import { asyncHandler } from '../middleware/async-handler.js';
import { getDb } from '../db/sqlite.js';
import { findCover } from '../db/game-metadata.js';

/**
 * Cover images, straight out of the database.
 *
 * Public, and that is the whole point of it.
 *
 * This route used to sit behind `requireAuth`, on the reasoning that a
 * same-origin <img> sends the session cookie anyway so the check was free. It
 * was not free: an authenticated response is one no cache may keep, so every
 * cover was fetched from the VPS by every browser, every time, and no edge
 * could ever help. Box art is not a secret, the id in the URL is not guessable,
 * and making it public is what lets a CDN answer instead of the origin.
 *
 * It is also no longer the usual way a cover is served. The ingestion writes
 * `/covers/<hash>.webp` onto a volume nginx reads directly, and rows point
 * there. This stays for two jobs: rows the warming pass has not reached or
 * could not decode, and being the source `covers-cli --rebuild` reads from.
 */
export const coversRouter = Router();

coversRouter.get('/:metadataId', asyncHandler(async (req, res) => {
  const cover = findCover(getDb(), req.params.metadataId);
  if (!cover) return res.status(404).json({ error: 'Cover not found' });

  res.setHeader('Content-Type', cover.mime);
  res.setHeader('Content-Disposition', 'inline');
  // Still versioned by `setCover`'s timestamp, so a replaced cover is a
  // different URL rather than a stale hit.
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(cover.bytes);
}));
