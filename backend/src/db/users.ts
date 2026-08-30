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
  googleId: string | null;
  isAnonymous: number;
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
    // SQLite has no boolean, and `isAnonymous` decides authorization on every
    // request: `=== 1` rather than a truthiness test, so a column that somehow
    // held a string could never read as "an account".
    isAnonymous: row.isAnonymous === 1,
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
  return insertWithFreeHandle(
    db,
    { googleId: input.googleId, avatar: input.avatar, isAnonymous: false },
    random,
    'account'
  );
}

/**
 * Un joueur qui a suivi un lien de salon et n'a pas de compte.
 *
 * Aucun `googleId` : la colonne est nullable depuis
 * 0005_anonymous_players.sql, et c'est la moitié du sens du mot. `isAnonymous`
 * est l'autre moitié, et cette fonction est le seul endroit qui l'écrit à 1.
 *
 * `pseudoChosenAt` reste null, et ce n'est pas un oubli : cette date dit « ce
 * compte a répondu au portique d'embarquement », et un anonyme n'a pas de
 * compte à embarquer. C'est `requirePseudo` qui apprend une troisième branche,
 * plutôt que cette date d'apprendre un second sens - la deuxième option coûte
 * plus de code une fois, la première coûte une ambiguïté pour toujours.
 *
 * Le pseudonyme tapé à la porte, s'il y en a un, passe par `isValidPseudo`
 * comme celui de n'importe qui, et se voit attribuer un discriminateur libre
 * par le même chemin : un anonyme entre dans l'espace des handles aux mêmes
 * conditions que tout le monde, il n'y reste simplement pas.
 */
export function createAnonymousUser(
  db: Database,
  input: { pseudo?: string; avatar?: string | null },
  random: () => number = Math.random
): User {
  if (input.pseudo !== undefined && !isValidPseudo(input.pseudo)) {
    throw new TypeError(`Invalid pseudonym: ${input.pseudo}`);
  }

  return insertWithFreeHandle(
    db,
    {
      googleId: null,
      avatar: input.avatar ?? null,
      isAnonymous: true,
      pseudo: input.pseudo
    },
    random,
    'anonymous player'
  );
}

/**
 * Pose une ligne User avec un handle que personne ne tient.
 *
 * La lecture d'`allocateDiscriminator` et l'écriture ici ne forment pas un pas
 * atomique, donc deux arrivées dans la même milliseconde peuvent recevoir le
 * même créneau. L'index unique est l'arbitre ; ceci réessaie autour de lui
 * plutôt que de remonter une erreur de contrainte à quelqu'un qui n'y peut
 * rien - exactement la discipline de `claimPseudo`.
 */
function insertWithFreeHandle(
  db: Database,
  input: { googleId: string | null; avatar: string | null; isAnonymous: boolean; pseudo?: string },
  random: () => number,
  what: string
): User {
  const id = randomUUID();
  const now = Date.now();

  for (let attempt = 0; attempt < 3; attempt++) {
    const pseudo = input.pseudo ?? AUTO_PSEUDO_WORDS[Math.floor(random() * AUTO_PSEUDO_WORDS.length)];
    const discriminator = allocateDiscriminator(db, pseudo, random);
    try {
      db.prepare(`
        INSERT INTO "User" (id, googleId, isAnonymous, pseudo, discriminator, pseudoChosenAt, avatar, controlsConfig, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?)
      `).run(id, input.googleId, input.isAnonymous ? 1 : 0, pseudo, discriminator, input.avatar, now, now);
      return findUserById(db, id)!;
    } catch (err) {
      if ((err as { code?: string }).code !== 'SQLITE_CONSTRAINT_UNIQUE') throw err;
    }
  }

  throw new Error(`Could not allocate a handle for a new ${what} after three attempts`);
}

/**
 * Efface une session anonyme, et refuse tout le reste.
 *
 * Le `AND isAnonymous = 1` n'est pas une ceinture de sécurité décorative :
 * cette fonction est appelée depuis le chemin de déconnexion avec un
 * identifiant venu d'une session, et `User` porte des ON DELETE CASCADE vers
 * `Game`, `Friendship` et - par `Game` - `Save`. Supprimer la mauvaise ligne
 * ici ne raterait pas bruyamment, cela viderait la bibliothèque de quelqu'un.
 *
 * Renvoie s'il y avait bien une session anonyme à effacer.
 */
export function deleteAnonymousUser(db: Database, id: string): boolean {
  const info = db.prepare(`DELETE FROM "User" WHERE id = ? AND isAnonymous = 1`).run(id);
  return info.changes > 0;
}

/**
 * Le ménage des sessions que personne ne reprendra.
 *
 * Sans lui la table des joueurs enfle sans fin : un anonyme ne peut pas se
 * reconnecter pour y revenir, donc chaque ligne restée est une ligne morte. Le
 * critère est `createdAt` et non la dernière activité, parce qu'une session
 * anonyme est bornée par construction - elle n'existe que pour la durée d'une
 * partie - et qu'une deuxième colonne à tenir à jour à chaque paquet serait
 * une écriture par socket pour du ménage.
 *
 * Ne touche jamais un compte, si vieux et si inactif soit-il : un compte n'est
 * pas une session.
 */
export function sweepAnonymousUsers(db: Database, olderThan: Date): number {
  return db.prepare(`DELETE FROM "User" WHERE isAnonymous = 1 AND createdAt < ?`)
    .run(olderThan.getTime()).changes;
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
 * The dev-login shortcut: puts a dev account into exactly the state it
 * declares, whether or not it already existed.
 *
 * It used to refresh nothing but the avatar on conflict, matching the Prisma
 * upsert it replaced. That stopped being right the moment a pseudonym became
 * part of a dev account's identity, and running 0004 against the development
 * database is what showed it: the migration leaves every existing row with
 * pseudoChosenAt NULL, so both dev accounts came back stuck behind the
 * onboarding gate and an avatar-only upsert could not get them out.
 *
 * A dev account is a fixture, not a player. Being in a known state on every
 * sign-in is its entire purpose - including dev user 3, whose declared state
 * is "has not chosen", and which is therefore put back in front of the gate
 * each time rather than being answered once and never testable again.
 *
 * controlsConfig is deliberately not touched: key bindings set while testing
 * are worth keeping across a sign-in, and they are not part of the identity
 * this function is asserting.
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
    ON CONFLICT(id) DO UPDATE SET
      avatar = @avatar,
      pseudo = @pseudo,
      discriminator = @discriminator,
      pseudoChosenAt = @pseudoChosenAt,
      updatedAt = @now
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
