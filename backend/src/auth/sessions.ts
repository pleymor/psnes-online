import type { SessionData, Store } from 'express-session';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('Sessions');

type StoredSession = SessionData & { id?: string; passport?: { user?: string } };

/**
 * Ferme toutes les sessions ouvertes d'un compte.
 *
 * « Mot de passe oublié » est aussi ce qu'on fait quand on pense être
 * compromis : réécrire le hash sans fermer les sessions laisserait l'intrus
 * connecté. Le prix, assumé et annoncé dans le mail : le joueur est déconnecté
 * de son casque et de son PC en même temps.
 *
 * Implémenté par un balayage du magasin (`store.all`) plutôt que par un index
 * de sessions par utilisateur, ou par une époque portée dans la session. C'est
 * le choix de la simplicité, et il repose sur une hypothèse d'échelle
 * explicite : cent comptes, donc au plus quelques centaines de sessions. Si
 * `MAX_USERS` devait monter d'un ordre de grandeur, c'est cette fonction qu'il
 * faudrait revoir en premier -- pas les autres.
 *
 * Passer par l'interface `Store` d'express-session plutôt que par Redis
 * directement : le préfixe `sess:` et le format de sérialisation restent des
 * détails de `connect-redis`, et le test peut monter un `MemoryStore`. Les
 * deux formes que `all` peut rendre sont acceptées -- un tableau de sessions
 * portant leur `id` (connect-redis), ou un objet indexé par identifiant
 * (MemoryStore).
 */
export async function destroySessionsOf(store: Store, userId: string): Promise<number> {
  if (!store.all) {
    throw new Error('This session store cannot list its sessions');
  }
  const listed = await new Promise<unknown>((resolve, reject) => {
    store.all!((err, sessions) => (err ? reject(err) : resolve(sessions)));
  });

  const entries: Array<[string, StoredSession]> = Array.isArray(listed)
    ? (listed as StoredSession[]).filter(s => s?.id).map(s => [s.id!, s])
    : Object.entries((listed ?? {}) as Record<string, StoredSession>);

  let closed = 0;
  for (const [sid, session] of entries) {
    if (session?.passport?.user !== userId) continue;
    await new Promise<void>((resolve, reject) => {
      store.destroy(sid, err => (err ? reject(err) : resolve()));
    });
    closed++;
  }

  logger.info({ userId, closed }, 'Sessions closed after a password reset');
  return closed;
}
