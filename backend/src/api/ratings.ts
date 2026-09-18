/**
 * Ce que les écrans de classement ont le droit de lire.
 *
 * Trois routes en lecture seule, derrière `requireAuth` et `requirePseudo` comme
 * `friendsRouter` : le classement est visible de tout joueur connecté, et de
 * personne d'autre. Pas de route ouverte - le dépôt vient d'en refermer une.
 *
 * `requirePseudo` en plus du compte, et pour la même raison que les amis : un
 * compte encore derrière le portique de pseudonyme n'a pas de nom à afficher, et
 * le laisser passer ferait apparaître une ligne sans identité.
 *
 * Les deux fonctions de validation sont exportées et pures, parce que c'est
 * elles que l'on peut prouver : un handler Express ne se pilote pas dans un
 * test, et une règle écrite dedans est une règle que personne ne vérifie.
 */

import { Router } from 'express';
import { getDb } from '../db/sqlite.js';
import { rankingFor, standingsOf, recentMatches } from '../db/matches.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/async-handler.js';

/** Combien de lignes une page rend par défaut, et au plus. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Le checksum tel que `Game.crc32` le porte : huit hexadécimaux MAJUSCULES.
 *
 * La casse n'est pas un détail : `watcherFor()` compare en majuscules et
 * `POST /api/games` refuse déjà tout le reste. Accepter les minuscules ici
 * créerait deux orthographes du même jeu, dont une qui ne trouve jamais rien.
 */
export function isCrc32(value: unknown): boolean {
  return typeof value === 'string' && /^[0-9A-F]{8}$/.test(value);
}

/**
 * La page demandée, ramenée dans des bornes.
 *
 * Tout ce qui n'est pas un entier utile retombe sur le défaut plutôt que de
 * produire une erreur : une page est une commodité, et refuser une requête
 * parce qu'un `?limit=` est bizarre coûterait un écran blanc pour rien. Le
 * plafond, lui, n'est pas négociable - c'est ce qui empêche une seule requête
 * de lire toute la table.
 */
export function pageOf(limit: unknown, offset: unknown): { limit: number; offset: number } {
  const n = (value: unknown, fallback: number, max: number) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
    return Math.min(parsed, max);
  };
  const off = Number(offset);
  return {
    limit: n(limit, DEFAULT_LIMIT, MAX_LIMIT),
    offset: Number.isInteger(off) && off > 0 ? off : 0
  };
}

export const ratingsRouter = Router();

ratingsRouter.use(requireAuth);

/**
 * Le classement d'un jeu, ou les cotes de joueurs nommés.
 *
 * `?users=a,b` sert le salon, qui n'a besoin que de deux lignes et n'a aucune
 * raison de tirer la table entière pour les trouver. Cette forme-là rend une
 * ligne par joueur demandé même sans cote, parce que l'écran doit distinguer
 * « pas encore classé » de « jamais classable ».
 */
ratingsRouter.get('/:crc32', asyncHandler(async (req, res) => {
  const { crc32 } = req.params;
  if (!isCrc32(crc32)) return res.status(400).json({ error: 'A CRC32 checksum is required' });

  const users = typeof req.query.users === 'string'
    ? req.query.users.split(',').map(s => s.trim()).filter(Boolean)
    : null;

  if (users) {
    // Borné comme le reste : `?users=` est une liste écrite par un client.
    return res.json(standingsOf(getDb(), crc32, users.slice(0, MAX_LIMIT)));
  }

  const { limit, offset } = pageOf(req.query.limit, req.query.offset);
  res.json(rankingFor(getDb(), crc32, limit, offset));
}));

/** L'historique d'un jeu, du plus récent au plus ancien. */
ratingsRouter.get('/:crc32/matches', asyncHandler(async (req, res) => {
  const { crc32 } = req.params;
  if (!isCrc32(crc32)) return res.status(400).json({ error: 'A CRC32 checksum is required' });

  const { limit, offset } = pageOf(req.query.limit, req.query.offset);
  res.json(recentMatches(getDb(), crc32, limit, offset));
}));
