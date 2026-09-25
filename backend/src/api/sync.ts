/**
 * La file d'attente des sauvegardes, côté serveur (#71).
 *
 * Le joueur écrit d'abord chez lui, toujours ; ces routes sont le second
 * destinataire, que la file du client nourrit quand le réseau est là. Du HTTP
 * et pas la socket, pour la raison que le ticket donne en §5 : une écriture
 * émise sur une socket morte disparaît sans erreur, alors qu'un 200 est une
 * preuve de réception - la seule chose qui autorise le client à retirer une
 * écriture de sa file.
 *
 * Un jeu est nommé par son checksum et non par l'id de sa ligne : la file vit
 * sur l'appareil, là où le jeu EST un checksum (`saves/local-store.ts`), et un
 * même joueur a une seule ligne par cartouche (`Game_userId_crc32_key`). Cela
 * évite aussi de demander à un appareil hors-ligne un id qu'il n'a peut-être
 * jamais vu.
 *
 * La règle de fusion est dans `saves/sync-plan.ts`, l'écriture dans
 * `db/sync.ts` ; ce fichier ne fait que valider et traduire.
 *
 * `Cache-Control: no-store` sur chaque réponse : ce sont les sauvegardes d'un
 * compte, et le service worker comme n'importe quel intermédiaire doivent le
 * lire dans la réponse même, pas seulement dans la liste des chemins exclus.
 */

import { Router, type Response } from 'express';
import type { User } from '../types/index.js';
import { getDb } from '../db/sqlite.js';
import { findGameByChecksum } from '../db/games.js';
import { readStoredSram, restoreKeptSram, syncSram, syncState } from '../db/sync.js';
import { MAX_NAME_CHARS, MAX_SCREENSHOT_CHARS, MAX_SRAM_BYTES, MAX_STATE_BYTES, decodedLength, isBase64, isImageDataUrl } from '../saves/archive.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('SaveSync');

export const syncRouter = Router();

syncRouter.use(requireAuth);
syncRouter.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

/**
 * Pourquoi un envoi est refusé, sous une forme que le client range.
 *
 * `retry` sépare ce qui passera plus tard de ce qui ne passera jamais tel
 * quel : le client garde les deux dans sa file - rien n'y est jeté - mais ne
 * s'acharne que sur les premiers, et dit les seconds au joueur.
 */
export type SyncRefusal =
  | 'bad-request'
  | 'account-mismatch'
  | 'not-in-library';

function refuse(res: Response, status: number, reason: SyncRefusal, error: string) {
  return res.status(status).json({ error, reason });
}

const CHECKSUM = /^[0-9A-F]{8}$/;

function isMoment(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isSyncId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(value);
}

export interface SramUpload {
  syncId: string;
  userId: string;
  bytes: Buffer;
  base: number | null;
  savedAt: number;
}

/** Le corps d'un `PUT .../sram`, champ par champ, ou la raison de son refus. */
export function parseSramUpload(body: unknown): SramUpload | { error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  if (!isSyncId(b.syncId)) return { error: 'A syncId is required' };
  if (typeof b.userId !== 'string' || !b.userId) return { error: 'A userId is required' };
  if (!isMoment(b.savedAt)) return { error: 'savedAt must be a timestamp' };
  if (b.base !== null && !isMoment(b.base)) return { error: 'base must be a timestamp or null' };
  if (typeof b.sram !== 'string' || !b.sram || !isBase64(b.sram)) return { error: 'sram must be base64' };
  if (decodedLength(b.sram) > MAX_SRAM_BYTES) return { error: 'sram is too large' };
  return {
    syncId: b.syncId,
    userId: b.userId,
    bytes: Buffer.from(b.sram, 'base64'),
    base: b.base as number | null,
    savedAt: b.savedAt
  };
}

export interface StateUpload {
  syncId: string;
  userId: string;
  name: string;
  bytes: Buffer;
  screenshot: string | null;
  savedAt: number;
  replaces: { id: string; updatedAt: number } | null;
}

export function parseStateUpload(body: unknown): StateUpload | { error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  if (!isSyncId(b.syncId)) return { error: 'A syncId is required' };
  if (typeof b.userId !== 'string' || !b.userId) return { error: 'A userId is required' };
  if (!isMoment(b.savedAt)) return { error: 'savedAt must be a timestamp' };
  if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > MAX_NAME_CHARS) {
    return { error: 'A name is required' };
  }
  if (typeof b.data !== 'string' || !b.data || !isBase64(b.data)) return { error: 'data must be base64' };
  if (decodedLength(b.data) > MAX_STATE_BYTES) return { error: 'data is too large' };
  let screenshot: string | null = null;
  if (b.screenshot !== undefined && b.screenshot !== null) {
    // La seule chaîne qui atteint un `<img src>` telle quelle : une image
    // matricielle en base64, et rien d'autre - la règle de l'import.
    if (typeof b.screenshot !== 'string' || b.screenshot.length > MAX_SCREENSHOT_CHARS || !isImageDataUrl(b.screenshot)) {
      return { error: 'screenshot must be an image data URL' };
    }
    screenshot = b.screenshot;
  }
  let replaces: StateUpload['replaces'] = null;
  if (b.replaces !== undefined && b.replaces !== null) {
    const r = b.replaces as Record<string, unknown>;
    if (typeof r.id !== 'string' || !isMoment(r.updatedAt)) return { error: 'replaces is malformed' };
    replaces = { id: r.id, updatedAt: r.updatedAt };
  }
  return {
    syncId: b.syncId,
    userId: b.userId,
    name: b.name,
    bytes: Buffer.from(b.data, 'base64'),
    screenshot,
    savedAt: b.savedAt,
    replaces
  };
}

/** La ligne `Game` du joueur pour ce checksum, ou le refus déjà envoyé. */
function ownGame(res: Response, user: User, crc32: string): string | null {
  if (!CHECKSUM.test(crc32)) {
    refuse(res, 400, 'bad-request', 'A CRC32 checksum is required');
    return null;
  }
  const game = findGameByChecksum(getDb(), user.id, crc32);
  if (!game) {
    refuse(res, 404, 'not-in-library', 'This game is not in your library');
    return null;
  }
  return game.id;
}

/**
 * La SRAM stockée et sa version.
 *
 * `sram: null` est une réponse - rien n'a jamais été écrit - et le client la
 * distingue d'un échec, qui lui arrive comme un statut ou une exception.
 */
syncRouter.get('/:crc32/sram', asyncHandler(async (req, res) => {
  const user = req.user as User;
  const gameId = ownGame(res, user, req.params.crc32);
  if (!gameId) return;
  const stored = readStoredSram(getDb(), gameId);
  res.json({
    sram: stored ? stored.bytes.toString('base64') : null,
    updatedAt: stored ? stored.updatedAt : null
  });
}));

/**
 * Une SRAM écrite sur un appareil.
 *
 * `userId` dans le corps n'est pas une authentification - la session l'est -
 * mais une garde : la file d'un navigateur partagé peut porter les écritures
 * d'un autre compte, et les envoyer sous la session courante les verserait
 * dans une bibliothèque qui n'est pas la leur. Le client filtre déjà ; ceci le
 * rend impossible plutôt qu'improbable.
 */
syncRouter.put('/:crc32/sram', asyncHandler(async (req, res) => {
  const user = req.user as User;
  const upload = parseSramUpload(req.body);
  if ('error' in upload) return refuse(res, 400, 'bad-request', upload.error);
  if (upload.userId !== user.id) {
    return refuse(res, 409, 'account-mismatch', 'This save belongs to another account');
  }
  const gameId = ownGame(res, user, req.params.crc32);
  if (!gameId) return;

  const result = syncSram(getDb(), gameId, upload);
  logger.info(
    { gameId, userId: user.id, outcome: result.outcome, size: upload.bytes.length, kept: result.kept?.id ?? null },
    'SRAM synchronised'
  );
  res.json({
    outcome: result.outcome,
    updatedAt: result.updatedAt,
    sram: result.sram ? result.sram.toString('base64') : null,
    kept: result.kept
  });
}));

/** Un savestate écrit sur un appareil : créé, ou écrasant celui que le joueur a vu. */
syncRouter.post('/:crc32/states', asyncHandler(async (req, res) => {
  const user = req.user as User;
  const upload = parseStateUpload(req.body);
  if ('error' in upload) return refuse(res, 400, 'bad-request', upload.error);
  if (upload.userId !== user.id) {
    return refuse(res, 409, 'account-mismatch', 'This save belongs to another account');
  }
  const gameId = ownGame(res, user, req.params.crc32);
  if (!gameId) return;

  const result = syncState(getDb(), gameId, {
    name: upload.name,
    data: upload.bytes,
    screenshot: upload.screenshot,
    savedAt: upload.savedAt,
    syncId: upload.syncId,
    replaces: upload.replaces
  });
  logger.info({ gameId, userId: user.id, outcome: result.outcome, saveId: result.saveId }, 'Savestate synchronised');
  res.json(result);
}));

/**
 * Remettre une SRAM gardée à la place de la SRAM - par un échange, jamais un
 * écrasement : voir `restoreKeptSram`.
 */
syncRouter.post('/:crc32/sram/restore', asyncHandler(async (req, res) => {
  const user = req.user as User;
  const saveId = (req.body ?? {}).saveId;
  if (typeof saveId !== 'string' || !saveId) return refuse(res, 400, 'bad-request', 'A saveId is required');
  const gameId = ownGame(res, user, req.params.crc32);
  if (!gameId) return;

  const result = restoreKeptSram(getDb(), gameId, saveId);
  // 404 pour « pas à vous » comme pour « n'existe pas » : la règle de la
  // suppression, pour la même raison.
  if (!result.ok) return res.status(404).json({ error: 'Save not found' });
  logger.info({ gameId, userId: user.id, restored: saveId, kept: result.kept?.id ?? null }, 'Kept SRAM restored');
  res.json({ sram: result.sram.toString('base64'), updatedAt: result.updatedAt, kept: result.kept });
}));
