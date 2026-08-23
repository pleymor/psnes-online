import express, { Router } from 'express';
import { User } from '../types/index.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { getDb } from '../db/sqlite.js';
import { findGameMetadataById, setCover } from '../db/game-metadata.js';
import { cachedCatalogue, invalidateMetadataCache } from '../services/metadata-loader.js';
import { rankCatalogue } from '../services/catalogue-search.js';
import { imageKindOf } from '../utils/image-kind.js';

/**
 * The shared catalogue, as players search and extend it.
 *
 * Search costs no query: the catalogue is already in memory, held by
 * metadata-loader's cache, and every contribution invalidates it.
 */
export const metadataRouter = Router();

metadataRouter.use(requireAuth);

metadataRouter.get('/search', asyncHandler(async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  res.json(rankCatalogue(cachedCatalogue(), q));
}));

/**
 * A cover, sized on the client and sent as bytes.
 *
 * Raw rather than a data URI inside JSON, for three reasons. The global
 * `express.json()` is mounted before every router (index.ts:124), so a 400 KB
 * data URI would be rejected with a 413 before reaching this handler; a raw
 * parser scoped to these three content types is skipped by that global one,
 * which only claims `application/json`; and base64 would cost a third of the
 * payload for nothing.
 */
export const COVER_LIMIT = '400kb';

metadataRouter.put(
  '/:metadataId/cover',
  express.raw({ type: ['image/png', 'image/jpeg', 'image/webp'], limit: COVER_LIMIT }),
  asyncHandler(async (req, res) => {
    const user = req.user as User;
    const db = getDb();

    const entry = findGameMetadataById(db, req.params.metadataId);
    if (!entry) return res.status(404).json({ error: 'No such catalogue entry' });
    if (entry.contributedBy !== user.id) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    // A Content-Type outside the three above is never parsed here, so the body
    // is whatever the global parsers left behind rather than a Buffer.
    const bytes = req.body;
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
      return res.status(415).json({ error: 'A PNG, JPEG or WebP image is required' });
    }

    const kind = imageKindOf(bytes);
    if (!kind) {
      return res.status(415).json({ error: 'That file is not a PNG, JPEG or WebP image' });
    }

    const coverUrl = setCover(db, entry.id, bytes, kind);
    invalidateMetadataCache();
    res.json({ coverUrl });
  })
);
