import { randomUUID } from 'node:crypto';
import type { Database } from './sqlite.js';
import type { User, PublicUser } from './types.js';
import {
  AUTO_PSEUDO_WORDS,
  DISCRIMINATOR_SPACE,
  isValidPseudo,
  padDiscriminator
} from '../utils/pseudo.js';

interface UserRow {
  id: string;
  googleId: string;
  pseudo: string;
  discriminator: string;
  pseudoChosenAt: number | null;
  avatar: string | null;
  controlsConfig: string | null;
  createdAt: number;
  updatedAt: number;
}

/** The one place a User row becomes a User. */
function toUser(row: UserRow): User {
  return {
    id: row.id,
    googleId: row.googleId,
    pseudo: row.pseudo,
    discriminator: row.discriminator,
    pseudoChosenAt: row.pseudoChosenAt === null ? null : new Date(row.pseudoChosenAt),
    avatar: row.avatar,
    controlsConfig: row.controlsConfig,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt)
  };
}

const SELECT = `SELECT * FROM "User"`;

/** The projection every cross-user read goes through. See PublicUser. */
export const PUBLIC_COLUMNS = `id, pseudo, discriminator, avatar`;

export function findUserById(db: Database, id: string): User | null {
  const row = db.prepare(`${SELECT} WHERE id = ?`).get(id) as UserRow | undefined;
  return row ? toUser(row) : null;
}

export function findUserByGoogleId(db: Database, googleId: string): User | null {
  const row = db.prepare(`${SELECT} WHERE googleId = ?`).get(googleId) as UserRow | undefined;
  return row ? toUser(row) : null;
}

/**
 * The only way to find a player you are not already connected to.
 *
 * COLLATE NOCASE matches the unique index, so `sprite#0417` finds
 * `Sprite#0417`. Without it a player who typed their friend's handle in the
 * wrong case would be told no such player exists, while the database would
 * still refuse to let anyone else take that handle.
 */
export function findUserByHandle(
  db: Database,
  pseudo: string,
  discriminator: string
): User | null {
  const row = db.prepare(
    `${SELECT} WHERE pseudo = ? COLLATE NOCASE AND discriminator = ?`
  ).get(pseudo, discriminator) as UserRow | undefined;
  return row ? toUser(row) : null;
}

/** Raised when all 10 000 discriminators of a pseudonym are taken. */
export class PseudoFullError extends Error {
  constructor(public readonly pseudo: string) {
    super(`Every discriminator for "${pseudo}" is taken`);
    this.name = 'PseudoFullError';
  }
}

/**
 * A discriminator nobody else holds for this pseudonym.
 *
 * The random generator is a parameter rather than a direct call to
 * Math.random, and that is not decoration: the retry path in claimPseudo is
 * only reachable when the first draw collides, so without an injectable
 * generator it could be tested by luck alone.
 */
export function allocateDiscriminator(
  db: Database,
  pseudo: string,
  random: () => number = Math.random
): string {
  const taken = new Set(
    (db.prepare(`SELECT discriminator FROM "User" WHERE pseudo = ? COLLATE NOCASE`)
      .all(pseudo) as { discriminator: string }[]).map(r => r.discriminator)
  );

  if (taken.size >= DISCRIMINATOR_SPACE) throw new PseudoFullError(pseudo);

  const free: string[] = [];
  for (let n = 0; n < DISCRIMINATOR_SPACE; n++) {
    const candidate = padDiscriminator(n);
    if (!taken.has(candidate)) free.push(candidate);
  }

  return free[Math.floor(random() * free.length)];
}

/**
 * Writes a pseudonym the player picked, with a fresh discriminator, and
 * records that they picked it.
 *
 * The read in allocateDiscriminator and the write here are not one atomic
 * step, so two players claiming the same pseudonym in the same millisecond can
 * both be handed the same free slot. The unique index is the real arbiter --
 * an application-level guard alone would eventually be bypassed by a new call
 * site -- and this retries around it rather than surfacing a constraint error
 * the player cannot act on.
 */
export function claimPseudo(
  db: Database,
  userId: string,
  pseudo: string,
  random: () => number = Math.random
): { pseudo: string; discriminator: string } {
  if (!isValidPseudo(pseudo)) throw new TypeError(`Invalid pseudonym: ${pseudo}`);

  for (let attempt = 0; attempt < 3; attempt++) {
    const discriminator = allocateDiscriminator(db, pseudo, random);
    try {
      db.prepare(`
        UPDATE "User"
           SET pseudo = ?, discriminator = ?, pseudoChosenAt = ?, updatedAt = ?
         WHERE id = ?
      `).run(pseudo, discriminator, Date.now(), Date.now(), userId);
      return { pseudo, discriminator };
    } catch (err) {
      if ((err as { code?: string }).code !== 'SQLITE_CONSTRAINT_UNIQUE') throw err;
    }
  }

  throw new PseudoFullError(pseudo);
}

/**
 * A brand new account.
 *
 * It is handed a pseudonym straight away rather than being left blank: every
 * screen that lists players reads `pseudo` unconditionally, and a row without
 * one would render as a hole. `pseudoChosenAt` stays null, which is what puts
 * the onboarding gate in front of them on their first page.
 */
export function createUser(
  db: Database,
  input: { googleId: string; avatar: string | null },
  random: () => number = Math.random
): User {
  const id = randomUUID();
  const now = Date.now();

  for (let attempt = 0; attempt < 3; attempt++) {
    const pseudo = AUTO_PSEUDO_WORDS[Math.floor(random() * AUTO_PSEUDO_WORDS.length)];
    const discriminator = allocateDiscriminator(db, pseudo, random);
    try {
      db.prepare(`
        INSERT INTO "User" (id, googleId, pseudo, discriminator, pseudoChosenAt, avatar, controlsConfig, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, ?)
      `).run(id, input.googleId, pseudo, discriminator, input.avatar, now, now);
      return findUserById(db, id)!;
    } catch (err) {
      if ((err as { code?: string }).code !== 'SQLITE_CONSTRAINT_UNIQUE') throw err;
    }
  }

  throw new Error('Could not allocate a handle for a new account after three attempts');
}

/**
 * Refreshes the avatar, and nothing else.
 *
 * This used to be updateUserProfile and also rewrote displayName from the
 * Google profile on every sign-in. There is no longer a name to resynchronise:
 * the pseudonym belongs to the player, and a login must never overwrite it.
 */
export function updateUserAvatar(db: Database, id: string, avatar: string | null): User {
  db.prepare(`UPDATE "User" SET avatar = ?, updatedAt = ? WHERE id = ?`)
    .run(avatar, Date.now(), id);
  return findUserById(db, id)!;
}

/**
 * The dev-login shortcut. Creates the fixed dev user, or refreshes nothing but
 * its avatar - matching what the Prisma upsert did.
 *
 * The two dev accounts are deliberately asymmetric on pseudoChosenAt: one has
 * chosen, one has not, so both the ordinary session and the onboarding gate
 * are one click away without editing the database by hand.
 */
export function upsertDevUser(
  db: Database,
  input: {
    id: string;
    googleId: string;
    pseudo: string;
    discriminator: string;
    pseudoChosenAt: number | null;
    avatar: string;
  }
): User {
  const now = Date.now();
  db.prepare(`
    INSERT INTO "User" (id, googleId, pseudo, discriminator, pseudoChosenAt, avatar, controlsConfig, createdAt, updatedAt)
    VALUES (@id, @googleId, @pseudo, @discriminator, @pseudoChosenAt, @avatar, NULL, @now, @now)
    ON CONFLICT(id) DO UPDATE SET avatar = @avatar, updatedAt = @now
  `).run({ ...input, now });
  return findUserById(db, input.id)!;
}

export function findControlsConfig(db: Database, userId: string): string | null {
  const row = db.prepare(`SELECT controlsConfig FROM "User" WHERE id = ?`)
    .get(userId) as { controlsConfig: string | null } | undefined;
  return row?.controlsConfig ?? null;
}

/**
 * Unlike Prisma, which threw P2025 for a row that had vanished, a `WHERE id
 * = ?` matching nothing here silently affects zero rows - a deliberate
 * decision, not an oversight, made the same way across the five other writes
 * of this shape (updateSaveData, updateGameMetadata, deleteGame,
 * deleteFriendship, saveSram), each already guarded by an existence or
 * ownership check; its one caller-visible effect is that `PUT /controls` and
 * `POST /controls/reset` now return 200 instead of 500 for a user whose row
 * is gone.
 */
export function updateControlsConfig(db: Database, userId: string, json: string): void {
  db.prepare(`UPDATE "User" SET controlsConfig = ?, updatedAt = ? WHERE id = ?`)
    .run(json, Date.now(), userId);
}

/** What another player is allowed to see. Used wherever a User must not be. */
export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    pseudo: user.pseudo,
    discriminator: user.discriminator,
    avatar: user.avatar
  };
}
