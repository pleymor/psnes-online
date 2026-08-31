/**
 * Getting a player's progress out of the server, and letting them hand it back.
 *
 * This is portability, not a backup - the server's safety net is an off-box
 * copy that runs whether anyone clicks or not. What this answers is the player
 * who changes machine, and the one who wants a copy of a hundred hours in
 * their own hands. Since the ROM moved onto the player's own disk, this
 * database is the only place their progress lives.
 *
 * Its own router rather than more routes under `/api/games`, because the unit
 * is the library: `GET /api/games/:gameId/saves/export` would have to lie
 * about the whole-library case, and the whole-library case is the one a player
 * actually wants when changing machines.
 *
 * The import is the one endpoint in this application that takes opaque blobs
 * from a file somebody was handed and writes them into rows keyed by their
 * account. Every guard it has is in `saves/archive.ts` (the format) and
 * `saves/import-plan.ts` (what may be overwritten); this file is only the
 * plumbing between them and the session.
 */

import { Router } from 'express';
import type { User } from '../types/index.js';
import { getDb } from '../db/sqlite.js';
import { exportableLibrary, applyImport } from '../db/portability.js';
import { buildArchive, parseArchive } from '../saves/archive.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('SavesPortability');

export const savesRouter = Router();

savesRouter.use(requireAuth);

/** `psnes-saves-2026-08-30.json`, which sorts and says what it is. */
function archiveFilename(now: Date): string {
  return `psnes-saves-${now.toISOString().slice(0, 10)}.json`;
}

/**
 * The export.
 *
 * `?gameId=` narrows it to one game - the "here, take my finished file" case -
 * and the file shape does not change: one game is a list of one, so the same
 * import path reads both. Passing somebody else's game id exports nothing
 * rather than their saves; the filter is in the query, not in a check that
 * could be forgotten.
 *
 * `?screenshots=0` leaves the thumbnails behind. `Save.screenshot` is a PNG
 * data URL, so a full library is mostly picture by weight, and a player on a
 * slow line should not have to take them.
 */
savesRouter.get('/export', asyncHandler(async (req, res) => {
  const user = req.user as User;
  const gameId = typeof req.query.gameId === 'string' ? req.query.gameId : undefined;
  const screenshots = req.query.screenshots !== '0';

  const games = exportableLibrary(getDb(), user.id, gameId);
  const archive = buildArchive(games, { screenshots });

  logger.info(
    { userId: user.id, games: archive.games.length, gameId: gameId ?? null, screenshots },
    'Saves exported'
  );

  res.setHeader('Content-Disposition', `attachment; filename="${archiveFilename(new Date())}"`);
  res.json(archive);
}));

/**
 * The import.
 *
 * Answers 400 with the reason the parser gave, because the four reasons need
 * four different things from the player: a file that is not one of ours, a file
 * from a newer release, a corrupt one, and one that is simply too big are not
 * the same sentence.
 *
 * A core-version mismatch is deliberately NOT a 400. The savestates are
 * dropped - a state from a different snes9x build loads into garbage rather
 * than failing, which would corrupt the very progress this is meant to keep -
 * but the battery SRAM in the same file has no core version and is still
 * worth having. So the import proceeds, and `coreMatches: false` in the
 * response is what the UI says out loud.
 */
savesRouter.post('/import', asyncHandler(async (req, res) => {
  const user = req.user as User;
  const body = req.body ?? {};
  const replaceSram = body.replaceSram === true;

  const parsed = parseArchive(body.archive);
  if (!parsed.ok) {
    logger.warn({ userId: user.id, reason: parsed.reason, detail: parsed.detail }, 'Import refused');
    return res.status(400).json({ error: parsed.detail, reason: parsed.reason });
  }

  const report = applyImport(getDb(), user.id, parsed.archive, { replaceSram });

  logger.info({ userId: user.id, coreMatches: parsed.coreMatches, ...report }, 'Saves imported');

  res.json({ coreMatches: parsed.coreMatches, report });
}));
