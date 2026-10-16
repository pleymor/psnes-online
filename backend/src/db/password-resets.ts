import { randomUUID } from 'node:crypto';
import type { Database } from './sqlite.js';

/** Une heure. Un lien de récupération de compte n'a pas à traîner. */
export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

/**
 * Une nouvelle demande éteint les précédentes.
 *
 * Sans cela, un lien reçu il y a cinquante minutes -- et toujours dans une
 * boîte mail, peut-être sur un appareil partagé -- resterait une clé vivante
 * après que son propriétaire a demandé un nouveau lien précisément parce qu'il
 * s'inquiétait.
 */
export function createPasswordReset(
  db: Database, userId: string, tokenHash: string, now: number = Date.now()
): void {
  db.transaction(() => {
    db.query(
      `UPDATE "PasswordReset" SET usedAt = @now WHERE userId = @userId AND usedAt IS NULL`
    ).run({ userId, now });
    db.query(
      `INSERT INTO "PasswordReset" (id, userId, tokenHash, createdAt, expiresAt, usedAt)
       VALUES (@id, @userId, @tokenHash, @now, @expiresAt, NULL)`
    ).run({ id: randomUUID(), userId, tokenHash, now, expiresAt: now + PASSWORD_RESET_TTL_MS });
  })();
}

export function findLiveResetByToken(
  db: Database, tokenHash: string, now: number = Date.now()
): { id: string; userId: string } | null {
  const row = db.query(
    `SELECT id, userId FROM "PasswordReset"
      WHERE tokenHash = @tokenHash AND usedAt IS NULL AND expiresAt > @now`
  ).get({ tokenHash, now }) as { id: string; userId: string } | null;
  return row ?? null;
}

/**
 * Brûle le jeton, et dit s'il était encore vivant.
 *
 * Le `AND usedAt IS NULL` est l'arbitre entre deux clics simultanés sur le
 * même lien : un seul des deux UPDATE trouve la ligne.
 */
export function useReset(db: Database, id: string): boolean {
  const info = db.query(
    `UPDATE "PasswordReset" SET usedAt = @now WHERE id = @id AND usedAt IS NULL`
  ).run({ id, now: Date.now() });
  return info.changes === 1;
}
