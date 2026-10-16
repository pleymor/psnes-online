import type { Database } from './sqlite.js';

/**
 * L'adresse et le hash d'un compte à mot de passe.
 *
 * Une table à part de "User" -- voir 0009_password_accounts.sql pour le
 * pourquoi. Un compte Google n'y a pas de ligne.
 */
export interface Credential {
  userId: string;
  email: string;
  createdAt: Date;
  updatedAt: Date;
}

interface CredentialRow {
  userId: string;
  email: string;
  passwordHash: string;
  createdAt: number;
  updatedAt: number;
}

function toCredential(row: CredentialRow): Credential & { passwordHash: string } {
  return {
    userId: row.userId,
    email: row.email,
    passwordHash: row.passwordHash,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt)
  };
}

export function createCredential(
  db: Database, userId: string, email: string, passwordHash: string
): Credential {
  const now = Date.now();
  db.query(
    `INSERT INTO "Credential" (userId, email, passwordHash, createdAt, updatedAt)
     VALUES (@userId, @email, @passwordHash, @now, @now)`
  ).run({ userId, email, passwordHash, now });
  return { userId, email, createdAt: new Date(now), updatedAt: new Date(now) };
}

/**
 * COLLATE NOCASE dans la requête, comme `findUserByHandle` le fait pour le
 * pseudonyme : sans elle, `Alice@x.fr` ne retrouverait pas le compte que
 * l'index unique l'empêche pourtant de créer une seconde fois.
 */
export function findCredentialByEmail(
  db: Database, email: string
): (Credential & { passwordHash: string }) | null {
  const row = db.query(
    `SELECT * FROM "Credential" WHERE email = ? COLLATE NOCASE`
  ).get(email) as CredentialRow | null;
  return row ? toCredential(row) : null;
}

export function emailTaken(db: Database, email: string): boolean {
  return findCredentialByEmail(db, email) !== null;
}

export function setPasswordHash(db: Database, userId: string, passwordHash: string): void {
  db.query(
    `UPDATE "Credential" SET passwordHash = @passwordHash, updatedAt = @now WHERE userId = @userId`
  ).run({ userId, passwordHash, now: Date.now() });
}
