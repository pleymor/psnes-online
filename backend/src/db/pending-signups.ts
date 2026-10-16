import { randomUUID } from 'node:crypto';
import type { Database } from './sqlite.js';

/**
 * Vingt-quatre heures pour ouvrir sa boîte mail.
 *
 * Assez long pour un mail qui arrive le soir et se lit le lendemain, assez
 * court pour que l'invitation retenue revienne à son propriétaire si personne
 * ne clique.
 */
export const PENDING_SIGNUP_TTL_MS = 24 * 60 * 60 * 1000;

export interface PendingSignup {
  id: string;
  email: string;
  passwordHash: string;
  inviteId: string;
  expiresAt: Date;
}

interface PendingSignupRow {
  id: string;
  email: string;
  passwordHash: string;
  inviteId: string;
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
}

function toPending(row: PendingSignupRow): PendingSignup {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.passwordHash,
    inviteId: row.inviteId,
    expiresAt: new Date(row.expiresAt)
  };
}

export function createPendingSignup(
  db: Database,
  input: { email: string; passwordHash: string; inviteId: string; tokenHash: string; now?: number }
): PendingSignup {
  const now = input.now ?? Date.now();
  const row: PendingSignupRow = {
    id: randomUUID(),
    email: input.email,
    passwordHash: input.passwordHash,
    inviteId: input.inviteId,
    tokenHash: input.tokenHash,
    createdAt: now,
    expiresAt: now + PENDING_SIGNUP_TTL_MS
  };
  db.query(
    `INSERT INTO "PendingSignup" (id, email, passwordHash, inviteId, tokenHash, createdAt, expiresAt)
     VALUES (@id, @email, @passwordHash, @inviteId, @tokenHash, @createdAt, @expiresAt)`
  ).run({ ...row });
  return toPending(row);
}

export function findLivePendingSignupByToken(
  db: Database, tokenHash: string, now: number = Date.now()
): PendingSignup | null {
  const row = db.query(
    `SELECT * FROM "PendingSignup" WHERE tokenHash = @tokenHash AND expiresAt > @now`
  ).get({ tokenHash, now }) as PendingSignupRow | null;
  return row ? toPending(row) : null;
}

/**
 * Ce lien est-il en cours d'utilisation par quelqu'un.
 *
 * La retenue est l'absence de ligne expirée, pas une colonne à mettre à jour :
 * à l'échéance, la place revient toute seule. Rien à balayer, donc rien à
 * oublier de balayer.
 *
 * `exceptId` est l'inscription qui demande : sans lui, la confirmation se
 * refuserait elle-même, sa propre attente retenant le lien qu'elle vient
 * utiliser -- et aucune inscription par mot de passe n'aboutirait jamais.
 */
export function inviteIsHeld(
  db: Database, inviteId: string, now: number = Date.now(), exceptId: string = ''
): boolean {
  const row = db.query(
    `SELECT 1 AS held FROM "PendingSignup"
      WHERE inviteId = @inviteId AND expiresAt > @now AND id != @exceptId LIMIT 1`
  ).get({ inviteId, now, exceptId });
  return row != null;
}

export function deletePendingSignup(db: Database, id: string): void {
  db.query(`DELETE FROM "PendingSignup" WHERE id = ?`).run(id);
}
