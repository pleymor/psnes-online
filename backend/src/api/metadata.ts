import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { cachedCatalogue } from '../services/metadata-loader.js';
import { rankCatalogue } from '../services/catalogue-search.js';

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
