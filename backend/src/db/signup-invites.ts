import { randomBytes, randomUUID } from 'node:crypto';
import type { Database } from './sqlite.js';

/**
 * Deux comptes par compte, à vie.
 *
 * Le quota compte les PLACES et non les liens émis : une invitation vivante
 * coûte autant qu'une invitation consommée. L'alternative -- n'émettre aucune
 * limite et refuser à la consommation -- déplacerait le refus sur le filleul,
 * qui cliquerait un lien pour lire « invitation invalide » sans avoir rien
 * fait de mal. Ici le refus tombe sur l'inviteur, au moment où il frappe le
 * lien de trop, et il est actionnable : révoquer, ou attendre.
 */
export const INVITE_QUOTA = 2;

export interface SignupInvite {
  id: string;
  code: string;
  inviterId: string;
  inviteeId: string | null;
  grantedByCli: boolean;
  createdAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
}

interface SignupInviteRow {
  id: string;
  code: string;
  inviterId: string;
  inviteeId: string | null;
  grantedByCli: number;
  createdAt: number;
  usedAt: number | null;
  revokedAt: number | null;
}

/** Le seul endroit où une ligne devient une invitation. */
function toInvite(row: SignupInviteRow): SignupInvite {
  return {
    id: row.id,
    code: row.code,
    inviterId: row.inviterId,
    inviteeId: row.inviteeId,
    // `=== 1` et non une évaluation de vérité : cette colonne décide d'un
    // quota, et une chaîne qui s'y serait glissée ne doit pas se lire « oui ».
    grantedByCli: row.grantedByCli === 1,
    createdAt: new Date(row.createdAt),
    usedAt: row.usedAt === null ? null : new Date(row.usedAt),
    revokedAt: row.revokedAt === null ? null : new Date(row.revokedAt)
  };
}

const SELECT = `SELECT * FROM "SignupInvite"`;

/**
 * 128 bits, en base64url.
 *
 * Ce code est le seul secret du lien : qui le devine crée un compte. 22
 * caractères sans remplissage, sûrs dans une URL et dans un message copié à la
 * main.
 */
function newCode(): string {
  return randomBytes(16).toString('base64url');
}

export function mintInvite(
  db: Database, inviterId: string, opts: { grantedByCli?: boolean } = {}
): SignupInvite {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO "SignupInvite" (id, code, inviterId, inviteeId, grantedByCli, createdAt, usedAt, revokedAt)
     VALUES (@id, @code, @inviterId, NULL, @grantedByCli, @createdAt, NULL, NULL)`
  ).run({
    id,
    code: newCode(),
    inviterId,
    grantedByCli: opts.grantedByCli ? 1 : 0,
    createdAt: Date.now()
  });
  return findInviteById(db, id)!;
}

export function findInviteById(db: Database, id: string): SignupInvite | null {
  const row = db.prepare(`${SELECT} WHERE id = ?`).get(id) as SignupInviteRow | undefined;
  return row ? toInvite(row) : null;
}

export function findInviteByCode(db: Database, code: string): SignupInvite | null {
  const row = db.prepare(`${SELECT} WHERE code = ?`).get(code) as SignupInviteRow | undefined;
  return row ? toInvite(row) : null;
}

export function listInvitesOf(db: Database, inviterId: string): SignupInvite[] {
  const rows = db.prepare(
    `${SELECT} WHERE inviterId = ? AND revokedAt IS NULL ORDER BY createdAt`
  ).all(inviterId) as SignupInviteRow[];
  return rows.map(toInvite);
}

/**
 * Les places que ce joueur a dépensées.
 *
 * Une requête, pas une colonne : une colonne `invitesLeft` dériverait au
 * premier chemin qui oublie de la décrémenter, et rien ne le dirait.
 */
export function countChargedInvites(db: Database, inviterId: string): number {
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM "SignupInvite"
      WHERE inviterId = ? AND grantedByCli = 0 AND revokedAt IS NULL`
  ).get(inviterId) as { n: number };
  return row.n;
}

/** Ne révoque qu'un lien non consommé : une place occupée ne se rend pas. */
export function revokeInvite(db: Database, id: string): void {
  db.prepare(
    `UPDATE "SignupInvite" SET revokedAt = @now WHERE id = @id AND usedAt IS NULL`
  ).run({ id, now: Date.now() });
}

export function consumeInvite(db: Database, id: string, inviteeId: string): void {
  db.prepare(
    `UPDATE "SignupInvite" SET usedAt = @now, inviteeId = @inviteeId
      WHERE id = @id AND usedAt IS NULL AND revokedAt IS NULL`
  ).run({ id, inviteeId, now: Date.now() });
}

/**
 * Les places occupées sur la plateforme.
 *
 * `isAnonymous = 0` : un invité venu par un lien de salon ne consomme aucune
 * place. Sa ligne est éphémère -- `deleteAnonymousUser` à la déconnexion,
 * `sweepAnonymousUsers` en filet -- et ne porte ni bibliothèque, ni ami, ni
 * sauvegarde. La compter reviendrait à laisser une soirée à quatre invités
 * fermer la porte à quatre vrais joueurs.
 */
export function countAccounts(db: Database): number {
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM "User" WHERE isAnonymous = 0`
  ).get() as { n: number };
  return row.n;
}

/**
 * Le plafond, réglable sans redéploiement.
 *
 * Une valeur illisible retombe sur 100 plutôt que sur NaN : `n >= NaN` est
 * faux, donc une faute de frappe dans le .env ouvrirait la plateforme en grand
 * au lieu de la fermer.
 */
export function maxUsers(env: Record<string, string | undefined> = process.env): number {
  const parsed = Number.parseInt(env.MAX_USERS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 100;
}
