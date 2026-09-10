import express, { Router } from 'express';
import { User } from '../types/index.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { getDb } from '../db/sqlite.js';
import { findGameMetadataById, setCover, updateCommunityMetadata } from '../db/game-metadata.js';
import { ownsDumpLinkedTo } from '../db/games.js';
import { sanitiseEntry } from './entry-input.js';
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
 * Fixing an entry that is wrong.
 *
 * Identifying a dump used to be a one-way door: the link could not be
 * re-pointed and the entry itself could not be touched, so a typo, a wrong
 * publisher or a half-filled row stayed that way for everyone holding the
 * dump. Re-pointing lives on `POST /games/:id/identify`; this is the other
 * half, for when the entry is the right one and merely wrong.
 *
 * Anyone holding the dump may write here - the decision on 2026-09-09 - and
 * `ownsDumpLinkedTo` is the whole of it. Contributing the entry is
 * deliberately not the test: the player who wrote a typo is rarely the one
 * who notices it, and the entry describes every one of their games equally.
 * The cost, named at the time, is that nothing records who changed what.
 *
 * PUT and not PATCH because `sanitiseEntry` replaces every descriptive field:
 * the form sends all of them, so an emptied box means "this was wrong".
 */
metadataRouter.put('/:metadataId', asyncHandler(async (req, res) => {
  const user = req.user as User;
  const db = getDb();

  const existing = findGameMetadataById(db, req.params.metadataId);
  if (!existing) return res.status(404).json({ error: 'No such catalogue entry' });
  if (!ownsDumpLinkedTo(db, user.id, existing.id)) {
    return res.status(403).json({ error: 'Only a player who has this game can correct its entry' });
  }

  const updated = updateCommunityMetadata(db, existing.id, sanitiseEntry(req.body, existing.title));
  if (!updated) {
    // `updateCommunityMetadata` refuses a shipped row, and says why: the JSON
    // refresh would delete the edit at the next deploy. Pointing the dump at a
    // new entry is the way to correct one of those.
    return res.status(409).json({ error: 'This entry ships with the catalogue and cannot be edited' });
  }

  // The cache feeds the title matcher and the search, so a correction that
  // does not invalidate it is invisible until the container restarts.
  invalidateMetadataCache();
  res.json({ metadata: updated });
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
    // The same rule as the edit above, and for the same reason: this was
    // `contributedBy === user.id`, which would have let a player fix every
    // word of an entry except its picture.
    if (!ownsDumpLinkedTo(db, user.id, entry.id)) {
      return res.status(403).json({ error: 'Only a player who has this game can correct its entry' });
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
