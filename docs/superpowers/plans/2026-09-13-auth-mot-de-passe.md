# Auth e-mail + mot de passe — plan d'implémentation (chantier 2/2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un joueur qui ne veut pas de Google peut créer son compte avec une adresse e-mail et un mot de passe — derrière une invitation, comme tout le monde — et le récupérer s'il l'oublie.

**Architecture:** L'adresse vit dans une table `Credential` séparée de `User`, jamais dans `User`. Le mail **est** la vérification : aucune ligne `User` non confirmée n'existe jamais, donc aucun état « compte non vérifié » ne traverse le reste de l'application. Deux tables de jetons, hachés, à durée courte.

**Tech Stack:** Bun (`Bun.password`, argon2id, sans dépendance), `nodemailer` (**seule dépendance nouvelle des deux chantiers**), Express 4, SvelteKit 2 / Svelte 4.

**Spec:** `docs/superpowers/specs/2026-09-13-invitations-et-mot-de-passe-design.md`

**Prérequis : le plan `2026-09-13-entree-sur-invitation.md` doit être intégralement exécuté.** Ce plan-ci consomme `SignupInvite`, `signupDoorDecision`, `admitSignup` et `consumeInvite`, et il ajoute `INVITE_HELD` à la porte.

## Global Constraints

- **Les dates sont des millisecondes epoch** (`INTEGER`), écrites explicitement avec `Date.now()`.
- **`bun:sqlite` en `strict: true`** : paramètres nommés à clés nues.
- **Aucun `PRAGMA` dans une migration** (`migrate.ts:assertNoPragma`).
- **`AUTH_MODE` ne change pas.** La porte à mot de passe s'ouvre par `PASSWORD_AUTH`, sur le modèle exact d'`ANONYMOUS_JOIN` (`backend/src/auth/anonymous.ts:36-48`). L'égalité stricte `AUTH_MODE === 'dev'` de `env-guard.ts:29` est ce qui tient `/auth/dev/login` hors de production ; y toucher rouvrirait une route non authentifiée qui distribue de vraies sessions.
- **L'adresse e-mail ne rentre jamais dans `User`.** Migration 0004 l'en a sortie ; `db/users.ts` fait un `SELECT *`.
- **Mot de passe : 10 caractères minimum, aucune règle de composition** (NIST).
- **Une seule dépendance nouvelle : `nodemailer`.** Après l'avoir ajoutée, lancer `bun pm untrusted` — `trustedDependencies` dans le `package.json` racine **remplace** la liste par défaut de Bun, et un paquet non nommé perd silencieusement ses scripts d'installation.
- **Chaînes en `en` ET `fr`** (`core/test/i18n-parity.test.ts`).
- **Trois routes SvelteKit nouvelles → trois entrées dans `entries`** (`frontend/svelte.config.js:32`), sans quoi le build de production échoue et les tests ne le voient pas.

---

## Structure des fichiers

| Fichier | Responsabilité |
|---|---|
| `backend/migrations/0008_password_accounts.sql` | `Credential`, `PendingSignup`, `PasswordReset` |
| `backend/src/db/credentials.ts` | l'adresse et le hash : créer, trouver, réécrire |
| `backend/src/db/pending-signups.ts` | l'inscription en attente, et la retenue du lien |
| `backend/src/db/password-resets.ts` | les jetons de réinitialisation |
| `backend/src/auth/password.ts` | hachage, vérification, politique, **coût constant** |
| `backend/src/auth/tokens.ts` | tirer un jeton, le hacher, le comparer |
| `backend/src/auth/credentials-door.ts` | `passwordAuthEnabled` + les décisions pures de ce chantier |
| `backend/src/auth/signup-door.ts` | *modifié* : `INVITE_HELD` |
| `backend/src/services/mailer.ts` | l'envoi SMTP, et le repli qui journalise |
| `backend/src/api/credentials.ts` | `/auth/signup`, `/auth/login`, `/auth/forgot`, `/auth/reset` |
| `backend/src/db/users.ts` | *modifié* : `createPasswordUser` |
| `backend/src/bootstrap/env-guard.ts` | *modifié* : `SMTP_URL` requis en production |
| `frontend/src/routes/signup/+page.svelte` | le formulaire du filleul |
| `frontend/src/routes/login/+page.svelte` | connexion + « oublié » dépliant |
| `frontend/src/routes/reset/+page.svelte` | le nouveau mot de passe |

---

## Task 1 : Le hachage et les jetons

**Files:**
- Create: `backend/src/auth/password.ts`
- Create: `backend/src/auth/tokens.ts`
- Test: `backend/test/password.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // password.ts
  export const MIN_PASSWORD_LENGTH = 10;
  export function passwordAcceptable(password: unknown): boolean;
  export function hashPassword(password: string): Promise<string>;
  export function verifyPassword(password: string, hash: string): Promise<boolean>;
  export function burnTime(): Promise<void>;
  // tokens.ts
  export function newToken(): { token: string; hash: string };
  export function hashToken(token: string): string;
  ```

- [ ] **Step 1 : Écrire le test qui échoue**

Créer `backend/test/password.test.ts` :

```ts
/**
 * Le hachage, la politique, et le temps que coûte un refus.
 *
 * `Bun.password` fait argon2id sans dépendance : le backend démarre déjà sous
 * Bun (`bun dist/index.js`). Ces tests épinglent ce que le dépôt attend de
 * lui, pas l'algorithme lui-même.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  MIN_PASSWORD_LENGTH, hashPassword, passwordAcceptable, verifyPassword
} from '../src/auth/password.js';
import { hashToken, newToken } from '../src/auth/tokens.js';

test('un hash est un argon2id, et jamais le mot de passe', async () => {
  const hash = await hashPassword('correct horse battery');
  assert.match(hash, /^\$argon2id\$/);
  assert.equal(hash.includes('correct horse battery'), false);
});

test('deux hachages du même mot de passe diffèrent, et vérifient tous les deux', async () => {
  // Le sel est dans le hash. Sans ce test, un jour où quelqu'un remplacerait
  // Bun.password par un sha256 nu, tout le reste passerait encore.
  const a = await hashPassword('correct horse battery');
  const b = await hashPassword('correct horse battery');
  assert.notEqual(a, b);
  assert.equal(await verifyPassword('correct horse battery', a), true);
  assert.equal(await verifyPassword('correct horse battery', b), true);
});

test('un mauvais mot de passe est refusé', async () => {
  const hash = await hashPassword('correct horse battery');
  assert.equal(await verifyPassword('correct horse batteri', hash), false);
});

test('un hash illisible rend faux plutôt que de jeter', async () => {
  // Une ligne corrompue ne doit pas rendre 500 sur la page de connexion : elle
  // doit rendre « mot de passe incorrect », comme n'importe quel refus.
  assert.equal(await verifyPassword('peu importe', 'pas-un-hash'), false);
});

test('la politique tient en une longueur', () => {
  assert.equal(MIN_PASSWORD_LENGTH, 10);
  assert.equal(passwordAcceptable('0123456789'), true);
  assert.equal(passwordAcceptable('012345678'), false);
  assert.equal(passwordAcceptable(''), false);
  assert.equal(passwordAcceptable(undefined), false);
  assert.equal(passwordAcceptable(42), false);
  // Aucune règle de composition : c'est la recommandation NIST, et une règle
  // de classes de caractères produit surtout des « Password1! ».
  assert.equal(passwordAcceptable('aaaaaaaaaaaaaaa'), true);
});

test('un jeton est imprévisible, et seul son hash est destiné à la base', () => {
  const { token, hash } = newToken();
  assert.match(token, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(hash.length, 64);
  assert.notEqual(hash, token);
  assert.equal(hashToken(token), hash);
  assert.notEqual(newToken().token, token);
});
```

- [ ] **Step 2 : Vérifier que le test échoue**

Run: `bun test backend/test/password.test.ts`
Expected: FAIL — modules introuvables.

- [ ] **Step 3 : Écrire `password.ts`**

```ts
/**
 * Le mot de passe, et ce qu'on en garde.
 *
 * `Bun.password` fait argon2id et vit dans le runtime : aucune dépendance à
 * ajouter, aucune compilation native à trustifier. Le backend démarre sous Bun
 * (`bun dist/index.js` dans backend/package.json), donc c'est disponible en
 * production comme en test.
 */

/**
 * Dix caractères, et rien d'autre.
 *
 * Pas de classe de caractères obligatoire : c'est la recommandation NIST
 * SP 800-63B, et une règle de composition produit surtout des mots de passe
 * qui se ressemblent tous. La longueur est ce qui compte.
 */
export const MIN_PASSWORD_LENGTH = 10;

export function passwordAcceptable(password: unknown): boolean {
  return typeof password === 'string' && password.length >= MIN_PASSWORD_LENGTH;
}

export function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: 'argon2id' });
}

/**
 * Rend `false` plutôt que de jeter sur un hash illisible.
 *
 * Une ligne corrompue doit produire « mot de passe incorrect » sur la page de
 * connexion, pas un 500 : le second dirait au visiteur qu'il a trouvé quelque
 * chose, et remplirait le journal d'erreurs sur un chemin qu'un attaquant
 * contrôle.
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await Bun.password.verify(password, hash);
  } catch {
    return false;
  }
}

/**
 * Le temps qu'aurait coûté une vérification, quand il n'y a rien à vérifier.
 *
 * Sans cela, `/auth/login` sur une adresse inconnue répond en une milliseconde
 * et sur une adresse connue en cinquante : la durée seule dit qui a un compte
 * ici. Le hash comparé est constant et ne correspond à aucun mot de passe.
 */
const DUMMY_HASH = await Bun.password.hash('psnes-timing-decoy', { algorithm: 'argon2id' });

export async function burnTime(): Promise<void> {
  await verifyPassword('psnes-timing-decoy-mismatch', DUMMY_HASH);
}
```

> `await` au niveau du module : Bun le supporte, et `tsconfig` du backend cible ESM. Si `tsc` refuse, remplacer par une constante calculée paresseusement à la première utilisation — **ne pas** remplacer par un hash écrit en dur, qui figerait les paramètres d'argon2 d'aujourd'hui.

- [ ] **Step 4 : Écrire `tokens.ts`**

```ts
import { createHash, randomBytes } from 'node:crypto';

/**
 * Les jetons qui voyagent dans une boîte mail.
 *
 * Hachés en base, contrairement au code d'invitation. Deux différences le
 * justifient : ceux-ci passent par un canal qu'on ne maîtrise pas, et ils
 * donnent un compte plutôt que le droit d'en créer un. Rien ne les réaffiche,
 * donc rien n'empêche de les hacher.
 *
 * SHA-256 nu, et pas argon2 : ce sont 128 bits d'aléa, pas un secret
 * devinable. L'étirement de clé n'ajouterait qu'une latence à chaque clic sur
 * un lien de récupération.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newToken(): { token: string; hash: string } {
  const token = randomBytes(16).toString('base64url');
  return { token, hash: hashToken(token) };
}
```

- [ ] **Step 5 : Vérifier**

Run: `bun test backend/test/password.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6 : Commit**

```bash
git add backend/src/auth/password.ts backend/src/auth/tokens.ts backend/test/password.test.ts
git commit -m "Hacher les mots de passe en argon2id, sans dépendance"
```

---

## Task 2 : Les trois tables

**Files:**
- Create: `backend/migrations/0008_password_accounts.sql`
- Create: `backend/src/db/credentials.ts`
- Create: `backend/src/db/pending-signups.ts`
- Create: `backend/src/db/password-resets.ts`
- Modify: `backend/src/db/users.ts` (ajout de `createPasswordUser`)
- Test: `backend/test/credentials.test.ts`

**Interfaces:**
- Consumes: Task 1 ; `SignupInvite` du chantier 1.
- Produces:
  ```ts
  // credentials.ts
  export interface Credential { userId: string; email: string; createdAt: Date; updatedAt: Date }
  export function createCredential(db: Database, userId: string, email: string, passwordHash: string): Credential;
  export function findCredentialByEmail(db: Database, email: string): (Credential & { passwordHash: string }) | null;
  export function emailTaken(db: Database, email: string): boolean;
  export function setPasswordHash(db: Database, userId: string, passwordHash: string): void;
  // pending-signups.ts
  export interface PendingSignup { id: string; email: string; passwordHash: string; inviteId: string; expiresAt: Date }
  export const PENDING_SIGNUP_TTL_MS: number; // 24 h
  export function createPendingSignup(db: Database, input: { email: string; passwordHash: string; inviteId: string; tokenHash: string; now?: number }): PendingSignup;
  export function findLivePendingSignupByToken(db: Database, tokenHash: string, now?: number): PendingSignup | null;
  export function inviteIsHeld(db: Database, inviteId: string, now?: number): boolean;
  export function deletePendingSignup(db: Database, id: string): void;
  // password-resets.ts
  export const PASSWORD_RESET_TTL_MS: number; // 1 h
  export function createPasswordReset(db: Database, userId: string, tokenHash: string, now?: number): void;
  export function findLiveResetByToken(db: Database, tokenHash: string, now?: number): { id: string; userId: string } | null;
  export function useReset(db: Database, id: string): void;
  // users.ts
  export function createPasswordUser(db: Database, random?: () => number): User;
  ```

Chaque fonction prend `now` en paramètre optionnel : c'est ce qui rend l'expiration testable sans attendre vingt-quatre heures, et c'est la discipline déjà en place dans `AttemptLimit` (`options.now`).

- [ ] **Step 1 : Écrire le test qui échoue**

Créer `backend/test/credentials.test.ts` :

```ts
/**
 * L'adresse, le hash, et les deux jetons — sur une vraie base migrée.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { migratedDb, insertUser } from './helpers.js';
import { hashPassword } from '../src/auth/password.js';
import { newToken } from '../src/auth/tokens.js';
import {
  createCredential, emailTaken, findCredentialByEmail, setPasswordHash
} from '../src/db/credentials.js';
import {
  PENDING_SIGNUP_TTL_MS, createPendingSignup, deletePendingSignup,
  findLivePendingSignupByToken, inviteIsHeld
} from '../src/db/pending-signups.js';
import {
  PASSWORD_RESET_TTL_MS, createPasswordReset, findLiveResetByToken, useReset
} from '../src/db/password-resets.js';
import { createPasswordUser } from '../src/db/users.js';
import { mintInvite } from '../src/db/signup-invites.js';

test('un compte à mot de passe n\'a pas de googleId, et n\'est pas anonyme', () => {
  const db = migratedDb();
  const user = createPasswordUser(db);
  assert.equal(user.googleId, null);
  assert.equal(user.isAnonymous, false);
  // Il tombe dans le portique d'embarquement existant, comme un compte Google.
  assert.equal(user.pseudoChosenAt, null);
});

test('l\'adresse est unique quelle que soit la casse', async () => {
  const db = migratedDb();
  const alice = insertUser(db);
  const bob = insertUser(db);
  createCredential(db, alice.id, 'Alice@Example.fr', await hashPassword('correct horse'));

  assert.equal(emailTaken(db, 'alice@example.fr'), true);
  assert.equal(emailTaken(db, 'ALICE@EXAMPLE.FR'), true);
  assert.equal(emailTaken(db, 'bob@example.fr'), false);
  assert.throws(() => {
    createCredential(db, bob.id, 'alice@EXAMPLE.fr', 'peu importe');
  });
});

test('l\'adresse est rendue telle qu\'elle a été tapée', async () => {
  const db = migratedDb();
  const alice = insertUser(db);
  createCredential(db, alice.id, 'Alice@Example.fr', await hashPassword('correct horse'));

  // C'est ce qui part dans le champ To: ; normaliser en minuscules casserait
  // les rares serveurs à casse significative. Seule la comparaison est
  // insensible.
  assert.equal(findCredentialByEmail(db, 'alice@example.fr')?.email, 'Alice@Example.fr');
});

test('réécrire le hash ne touche pas à l\'adresse', async () => {
  const db = migratedDb();
  const alice = insertUser(db);
  createCredential(db, alice.id, 'alice@example.fr', await hashPassword('ancien mot de passe'));

  const next = await hashPassword('nouveau mot de passe');
  setPasswordHash(db, alice.id, next);

  const after = findCredentialByEmail(db, 'alice@example.fr');
  assert.equal(after?.passwordHash, next);
  assert.equal(after?.email, 'alice@example.fr');
});

test('supprimer un compte emporte ses identifiants', async () => {
  const db = migratedDb();
  const alice = insertUser(db);
  createCredential(db, alice.id, 'alice@example.fr', await hashPassword('correct horse'));

  db.prepare(`DELETE FROM "User" WHERE id = ?`).run(alice.id);

  assert.equal(findCredentialByEmail(db, 'alice@example.fr'), null);
});

test('une inscription en attente retient son invitation, puis la rend', async () => {
  const db = migratedDb();
  const alice = insertUser(db);
  const invite = mintInvite(db, alice.id);
  const { token, hash } = newToken();
  const t0 = 1_700_000_000_000;

  createPendingSignup(db, {
    email: 'bob@example.fr', passwordHash: await hashPassword('correct horse'),
    inviteId: invite.id, tokenHash: hash, now: t0
  });

  assert.equal(inviteIsHeld(db, invite.id, t0), true);
  assert.ok(findLivePendingSignupByToken(db, hash, t0));

  // Vingt-quatre heures plus tard, la place est revenue d'elle-même : la
  // retenue est l'absence de ligne expirée, pas une colonne à nettoyer.
  const later = t0 + PENDING_SIGNUP_TTL_MS + 1;
  assert.equal(inviteIsHeld(db, invite.id, later), false);
  assert.equal(findLivePendingSignupByToken(db, hash, later), null);
  assert.equal(findLivePendingSignupByToken(db, newToken().hash, t0), null);
  void token;
});

test('confirmer supprime l\'attente, et rend la retenue', async () => {
  const db = migratedDb();
  const alice = insertUser(db);
  const invite = mintInvite(db, alice.id);
  const { hash } = newToken();
  const pending = createPendingSignup(db, {
    email: 'bob@example.fr', passwordHash: await hashPassword('correct horse'),
    inviteId: invite.id, tokenHash: hash
  });

  deletePendingSignup(db, pending.id);

  assert.equal(inviteIsHeld(db, invite.id), false);
  assert.equal(findLivePendingSignupByToken(db, hash), null);
});

test('un jeton de réinitialisation vaut une heure et une seule fois', () => {
  const db = migratedDb();
  const alice = insertUser(db);
  const { hash } = newToken();
  const t0 = 1_700_000_000_000;

  createPasswordReset(db, alice.id, hash, t0);
  const found = findLiveResetByToken(db, hash, t0);
  assert.equal(found?.userId, alice.id);

  useReset(db, found!.id);
  assert.equal(findLiveResetByToken(db, hash, t0), null);
});

test('une nouvelle demande éteint les précédentes', () => {
  const db = migratedDb();
  const alice = insertUser(db);
  const first = newToken();
  const second = newToken();
  const t0 = 1_700_000_000_000;

  createPasswordReset(db, alice.id, first.hash, t0);
  createPasswordReset(db, alice.id, second.hash, t0 + 1000);

  // Un ancien lien encore dans une boîte mail ne doit pas rester une clé
  // vivante.
  assert.equal(findLiveResetByToken(db, first.hash, t0 + 1000), null);
  assert.ok(findLiveResetByToken(db, second.hash, t0 + 1000));
});

test('un jeton de réinitialisation expire', () => {
  const db = migratedDb();
  const alice = insertUser(db);
  const { hash } = newToken();
  const t0 = 1_700_000_000_000;

  createPasswordReset(db, alice.id, hash, t0);

  assert.equal(findLiveResetByToken(db, hash, t0 + PASSWORD_RESET_TTL_MS + 1), null);
});
```

- [ ] **Step 2 : Vérifier que le test échoue**

Run: `bun test backend/test/credentials.test.ts`
Expected: FAIL — modules introuvables.

- [ ] **Step 3 : Écrire la migration**

Créer `backend/migrations/0008_password_accounts.sql` :

```sql
-- Google cesse d'être la seule porte.
--
-- L'adresse ne retourne PAS dans "User". La migration 0004 l'en a sortie en
-- argumentant longuement, et db/users.ts fait un SELECT * : l'y remettre
-- exposerait une adresse à chaque lecture d'utilisateur, et rendrait à toSelf()
-- et à USER_COLUMNS (db/friendships.ts) la possibilité de la fuiter par
-- accident. Dans une table à part, un compte Google n'a simplement pas de
-- ligne.
--
-- COLLATE NOCASE est sur l'INDEX et pas sur la colonne, comme le fait
-- 0004_pseudonymous_users.sql pour le handle. C'est ce qui fait de
-- Alice@x.fr et alice@x.fr un seul compte -- sans quoi la même personne
-- pourrait avoir deux comptes, et son « mot de passe oublié » atteindrait le
-- mauvais. La colonne, elle, garde la casse tapée : c'est ce qui part dans le
-- champ To:.
--
-- Rappel de 0004 : SQLite NOCASE ne replie que A-Z. Une adresse contenant des
-- lettres accentuées avant l'arobase échapperait donc à l'unicité. C'est
-- assumé, et c'est déjà la limite acceptée pour les pseudonymes.

CREATE TABLE "Credential" (
  "userId"       TEXT PRIMARY KEY REFERENCES "User"("id") ON DELETE CASCADE,
  "email"        TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "createdAt"    INTEGER NOT NULL,
  "updatedAt"    INTEGER NOT NULL
);

CREATE UNIQUE INDEX "Credential_email_key" ON "Credential" ("email" COLLATE NOCASE);

-- Une inscription qui attend son mail de confirmation.
--
-- Elle porte le hash du mot de passe, pas le mot de passe : entre le
-- formulaire et le clic, il peut se passer vingt-quatre heures, et rien ne
-- justifie de garder un secret en clair pendant ce temps-là.
--
-- Elle RETIENT son invitation : tant qu'une ligne non expirée pointe un lien,
-- ce lien répond INVITE_HELD. C'est ce qui empêche un lien partagé à deux
-- personnes de produire deux comptes. La retenue est l'absence de ligne
-- expirée, pas une colonne à nettoyer -- rien à balayer, rien à oublier de
-- balayer.
--
-- ON DELETE CASCADE depuis SignupInvite : révoquer un lien doit annuler
-- l'inscription qui l'attendait, sans quoi la confirmation créerait un compte
-- sur une invitation retirée.

CREATE TABLE "PendingSignup" (
  "id"           TEXT PRIMARY KEY,
  "email"        TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "inviteId"     TEXT NOT NULL REFERENCES "SignupInvite"("id") ON DELETE CASCADE,
  "tokenHash"    TEXT NOT NULL UNIQUE,
  "createdAt"    INTEGER NOT NULL,
  "expiresAt"    INTEGER NOT NULL
);

CREATE INDEX "PendingSignup_inviteId_idx" ON "PendingSignup" ("inviteId");

-- Le jeton est stocké HACHÉ, contrairement au code d'invitation.
-- Celui-ci voyage dans une boîte mail et donne un compte ; rien ne le
-- réaffiche, donc rien n'empêche de le hacher.

CREATE TABLE "PasswordReset" (
  "id"        TEXT PRIMARY KEY,
  "userId"    TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "tokenHash" TEXT NOT NULL UNIQUE,
  "createdAt" INTEGER NOT NULL,
  "expiresAt" INTEGER NOT NULL,
  "usedAt"    INTEGER
);

CREATE INDEX "PasswordReset_userId_idx" ON "PasswordReset" ("userId");
```

- [ ] **Step 4 : Écrire `credentials.ts`**

```ts
import type { Database } from './sqlite.js';

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
  db.prepare(
    `INSERT INTO "Credential" (userId, email, passwordHash, createdAt, updatedAt)
     VALUES (@userId, @email, @passwordHash, @now, @now)`
  ).run({ userId, email, passwordHash, now });
  return toCredential({ userId, email, passwordHash, createdAt: now, updatedAt: now });
}

/**
 * COLLATE NOCASE dans la requête, comme `findUserByHandle` le fait pour le
 * pseudonyme : sans elle, `Alice@x.fr` ne retrouverait pas le compte que
 * l'index unique l'empêche pourtant de créer une seconde fois.
 */
export function findCredentialByEmail(
  db: Database, email: string
): (Credential & { passwordHash: string }) | null {
  const row = db.prepare(
    `SELECT * FROM "Credential" WHERE email = ? COLLATE NOCASE`
  ).get(email) as CredentialRow | undefined;
  return row ? toCredential(row) : null;
}

export function emailTaken(db: Database, email: string): boolean {
  return findCredentialByEmail(db, email) !== null;
}

export function setPasswordHash(db: Database, userId: string, passwordHash: string): void {
  db.prepare(
    `UPDATE "Credential" SET passwordHash = @passwordHash, updatedAt = @now WHERE userId = @userId`
  ).run({ userId, passwordHash, now: Date.now() });
}
```

- [ ] **Step 5 : Écrire `pending-signups.ts`**

```ts
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
  const id = randomUUID();
  db.prepare(
    `INSERT INTO "PendingSignup" (id, email, passwordHash, inviteId, tokenHash, createdAt, expiresAt)
     VALUES (@id, @email, @passwordHash, @inviteId, @tokenHash, @now, @expiresAt)`
  ).run({ ...input, id, now, expiresAt: now + PENDING_SIGNUP_TTL_MS });
  return toPending({ ...input, id, createdAt: now, expiresAt: now + PENDING_SIGNUP_TTL_MS });
}

export function findLivePendingSignupByToken(
  db: Database, tokenHash: string, now: number = Date.now()
): PendingSignup | null {
  const row = db.prepare(
    `SELECT * FROM "PendingSignup" WHERE tokenHash = @tokenHash AND expiresAt > @now`
  ).get({ tokenHash, now }) as PendingSignupRow | undefined;
  return row ? toPending(row) : null;
}

/**
 * Ce lien est-il en cours d'utilisation par quelqu'un.
 *
 * La retenue est l'absence de ligne expirée, pas une colonne à mettre à jour :
 * à l'échéance, la place revient toute seule. Rien à balayer, donc rien à
 * oublier de balayer.
 */
export function inviteIsHeld(
  db: Database, inviteId: string, now: number = Date.now()
): boolean {
  const row = db.prepare(
    `SELECT 1 AS held FROM "PendingSignup" WHERE inviteId = @inviteId AND expiresAt > @now LIMIT 1`
  ).get({ inviteId, now }) as { held: number } | undefined;
  return row !== undefined;
}

export function deletePendingSignup(db: Database, id: string): void {
  db.prepare(`DELETE FROM "PendingSignup" WHERE id = ?`).run(id);
}
```

- [ ] **Step 6 : Écrire `password-resets.ts`**

```ts
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
  db.prepare(
    `UPDATE "PasswordReset" SET usedAt = @now WHERE userId = @userId AND usedAt IS NULL`
  ).run({ userId, now });
  db.prepare(
    `INSERT INTO "PasswordReset" (id, userId, tokenHash, createdAt, expiresAt, usedAt)
     VALUES (@id, @userId, @tokenHash, @now, @expiresAt, NULL)`
  ).run({ id: randomUUID(), userId, tokenHash, now, expiresAt: now + PASSWORD_RESET_TTL_MS });
}

export function findLiveResetByToken(
  db: Database, tokenHash: string, now: number = Date.now()
): { id: string; userId: string } | null {
  const row = db.prepare(
    `SELECT id, userId FROM "PasswordReset"
      WHERE tokenHash = @tokenHash AND usedAt IS NULL AND expiresAt > @now`
  ).get({ tokenHash, now }) as { id: string; userId: string } | undefined;
  return row ?? null;
}

export function useReset(db: Database, id: string): void {
  db.prepare(`UPDATE "PasswordReset" SET usedAt = @now WHERE id = @id`)
    .run({ id, now: Date.now() });
}
```

- [ ] **Step 7 : Ajouter `createPasswordUser`**

Dans `backend/src/db/users.ts`, juste après `createUser` :

```ts
/**
 * Un compte né d'une adresse et d'un mot de passe.
 *
 * Aucun `googleId` -- la colonne est nullable depuis 0005 -- et
 * `isAnonymous` à faux : c'est un vrai compte, il compte dans les cent places
 * et il tombe dans le portique d'embarquement comme n'importe lequel.
 *
 * L'adresse n'est PAS un paramètre : elle ne passe pas par cette table. Voir
 * db/credentials.ts, et 0004_pseudonymous_users.sql pour le pourquoi.
 */
export function createPasswordUser(db: Database, random: () => number = Math.random): User {
  return insertWithFreeHandle(
    db,
    { googleId: null, avatar: null, isAnonymous: false },
    random,
    'password account'
  );
}
```

- [ ] **Step 8 : Vérifier**

Run: `bun test backend/test/credentials.test.ts`
Expected: PASS, 10 tests.

Run: `bun test backend/test/migrate.test.ts backend/test/users.test.ts`
Expected: PASS.

- [ ] **Step 9 : Commit**

```bash
git add backend/migrations/0008_password_accounts.sql backend/src/db/credentials.ts backend/src/db/pending-signups.ts backend/src/db/password-resets.ts backend/src/db/users.ts backend/test/credentials.test.ts
git commit -m "Sortir l'adresse e-mail de User, et lui donner sa table"
```

---

## Task 3 : `INVITE_HELD` et la porte à mot de passe

**Files:**
- Modify: `backend/src/auth/signup-door.ts` (le refus `INVITE_HELD`)
- Create: `backend/src/auth/credentials-door.ts`
- Test: `backend/test/credentials-door.test.ts`
- Modify: `backend/test/signup-door.test.ts` (le nouveau refus)

**Interfaces:**
- Produces:
  ```ts
  // signup-door.ts, ajouts
  export type SignupRefusal = /* ... */ | 'INVITE_HELD';
  // signupDoorDecision gagne un champ d'entrée : `held: boolean`
  // credentials-door.ts
  export function passwordAuthEnabled(env?: Record<string, string | undefined>): boolean;
  export type CredentialRefusal =
    | 'PASSWORD_AUTH_DISABLED' | 'EMAIL_MALFORMED' | 'PASSWORD_TOO_SHORT' | 'EMAIL_TAKEN';
  export function signupFormDecision(input: {
    enabled: boolean; email: unknown; password: unknown; emailTaken: boolean;
  }): { ok: true; email: string; password: string } | { ok: false; status: number; error: CredentialRefusal };
  export function looksLikeEmail(value: unknown): value is string;
  ```

- [ ] **Step 1 : Écrire les tests qui échouent**

Ajouter à `backend/test/signup-door.test.ts` :

```ts
test('un lien retenu par une inscription en cours est refusé, distinctement', () => {
  // Un lien partagé à deux personnes ne doit pas produire deux comptes. Le
  // refus est distinct de INVITE_USED : celui-ci finira peut-être par
  // s'ouvrir, quand l'attente expirera.
  const decision = signupDoorDecision({ ...OPEN, held: true });
  assert.equal(!decision.ok && decision.error, 'INVITE_HELD');
  assert.equal(!decision.ok && decision.status, 409);
});

test('la retenue est examinée après la révocation et la consommation', () => {
  // Une invitation révoquée dont une inscription attendait encore est
  // révoquée, pas retenue : c'est ce que le propriétaire a demandé.
  const decision = signupDoorDecision({
    ...OPEN, held: true, invite: invite({ revokedAt: new Date() })
  });
  assert.equal(!decision.ok && decision.error, 'INVITE_REVOKED');
});
```

> Toutes les constructions `OPEN` existantes doivent gagner `held: false`. Modifier la constante `OPEN` suffit.

Créer `backend/test/credentials-door.test.ts` :

```ts
/**
 * Le formulaire d'inscription, décidé sans serveur.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { looksLikeEmail, passwordAuthEnabled, signupFormDecision } from '../src/auth/credentials-door.js';

const OK = { enabled: true, email: 'bob@example.fr', password: '0123456789', emailTaken: false };

test('la porte est ouverte par défaut et se referme sans toucher à AUTH_MODE', () => {
  assert.equal(passwordAuthEnabled({}), true);
  assert.equal(passwordAuthEnabled({ PASSWORD_AUTH: 'off' }), false);
  assert.equal(passwordAuthEnabled({ PASSWORD_AUTH: 'OFF' }), false);
  assert.equal(passwordAuthEnabled({ PASSWORD_AUTH: 'on' }), true);
});

test('un formulaire correct passe', () => {
  const decision = signupFormDecision(OK);
  assert.equal(decision.ok, true);
});

test('la porte fermée refuse avant de lire quoi que ce soit', () => {
  const decision = signupFormDecision({ ...OK, enabled: false, email: 'n\'importe quoi' });
  assert.equal(!decision.ok && decision.error, 'PASSWORD_AUTH_DISABLED');
  assert.equal(!decision.ok && decision.status, 404);
});

test('une adresse doit ressembler à une adresse', () => {
  for (const bad of ['', 'bob', 'bob@', '@example.fr', 'bob example.fr', 'bob@exemple', 42, null]) {
    assert.equal(looksLikeEmail(bad), false, `${String(bad)} ne devrait pas passer`);
  }
  assert.equal(looksLikeEmail('bob@example.fr'), true);
  assert.equal(looksLikeEmail('bob+psnes@sous.example.co.uk'), true);
});

test('un mot de passe trop court est refusé, et le dit', () => {
  const decision = signupFormDecision({ ...OK, password: '123456789' });
  assert.equal(!decision.ok && decision.error, 'PASSWORD_TOO_SHORT');
  assert.equal(!decision.ok && decision.status, 400);
});

test('une adresse déjà prise est refusée — et c\'est un oracle assumé', () => {
  // Ce refus dit à qui détient une invitation qu'une adresse a déjà un compte
  // ici. C'est le prix d'un message utilisable : l'alternative -- accepter
  // silencieusement puis envoyer un mail « vous avez déjà un compte » --
  // consommerait l'invitation du filleul pour rien. La porte d'invitation
  // borne déjà qui peut poser la question.
  const decision = signupFormDecision({ ...OK, emailTaken: true });
  assert.equal(!decision.ok && decision.error, 'EMAIL_TAKEN');
  assert.equal(!decision.ok && decision.status, 409);
});

test('l\'adresse est refusée avant d\'être testée en base', () => {
  const decision = signupFormDecision({ ...OK, email: 'pas une adresse', emailTaken: true });
  assert.equal(!decision.ok && decision.error, 'EMAIL_MALFORMED');
});
```

- [ ] **Step 2 : Vérifier l'échec**

Run: `bun test backend/test/credentials-door.test.ts backend/test/signup-door.test.ts`
Expected: FAIL.

- [ ] **Step 3 : Ajouter `INVITE_HELD` à la porte**

Dans `backend/src/auth/signup-door.ts` : ajouter `'INVITE_HELD'` au type `SignupRefusal`, ajouter `held: boolean` à l'entrée de `signupDoorDecision`, et le test **après** `revokedAt` et `usedAt` :

```ts
  // Après INVITE_USED, avant le quota. Une invitation révoquée dont une
  // inscription attendait encore est révoquée, pas retenue : c'est ce que le
  // propriétaire a demandé, et la cascade de PendingSignup l'a déjà effacée.
  if (input.held) {
    return { ok: false, status: 409, error: 'INVITE_HELD' };
  }
```

Et dans `admitSignup`, lire la retenue :

```ts
    held: invite ? inviteIsHeld(db, invite.id) : false,
```

avec `import { inviteIsHeld } from '../db/pending-signups.js';`.

- [ ] **Step 4 : Écrire `credentials-door.ts`**

```ts
/**
 * La deuxième porte, et ce qu'elle refuse.
 *
 * `PASSWORD_AUTH` est une variable À PART, et pas une valeur d'`AUTH_MODE`.
 * C'est la leçon écrite dans auth/anonymous.ts:36-48 : `env-guard.ts` refuse
 * de démarrer en production sur `AUTH_MODE === 'dev'` par une ÉGALITÉ STRICTE,
 * et cette égalité est ce qui tient `POST /auth/dev/login` -- une route non
 * authentifiée qui distribue de vraies sessions -- hors du web. Ajouter une
 * valeur à cette variable relâcherait la garantie par effet de bord ; une
 * variable à part n'a pas ce défaut.
 */

import { passwordAcceptable } from './password.js';

export function passwordAuthEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  return (env.PASSWORD_AUTH ?? 'on').toLowerCase() !== 'off';
}

export type CredentialRefusal =
  | 'PASSWORD_AUTH_DISABLED'
  | 'EMAIL_MALFORMED'
  | 'PASSWORD_TOO_SHORT'
  | 'EMAIL_TAKEN';

/**
 * Volontairement laxiste.
 *
 * La seule validation qui compte est le mail de confirmation, qui arrive ou
 * n'arrive pas. Une expression régulière stricte refuserait des adresses
 * légitimes -- les TLD longs, le `+`, les sous-domaines -- pour ne rien
 * garantir de plus. Celle-ci n'écarte que ce qui ne peut pas être une adresse.
 */
export function looksLikeEmail(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= 254
    && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

export function signupFormDecision(input: {
  enabled: boolean;
  email: unknown;
  password: unknown;
  emailTaken: boolean;
}):
  | { ok: true; email: string; password: string }
  | { ok: false; status: number; error: CredentialRefusal }
{
  // 404 et non 403 : quand la porte est fermée, cette route n'existe pas.
  if (!input.enabled) {
    return { ok: false, status: 404, error: 'PASSWORD_AUTH_DISABLED' };
  }
  if (!looksLikeEmail(input.email)) {
    return { ok: false, status: 400, error: 'EMAIL_MALFORMED' };
  }
  if (!passwordAcceptable(input.password)) {
    return { ok: false, status: 400, error: 'PASSWORD_TOO_SHORT' };
  }
  // Ce refus est un oracle : il dit à qui détient une invitation qu'une
  // adresse a déjà un compte ici. Assumé -- l'alternative, accepter
  // silencieusement puis envoyer « vous avez déjà un compte », consommerait
  // l'invitation du filleul pour rien. La porte d'invitation borne déjà qui
  // peut poser la question.
  if (input.emailTaken) {
    return { ok: false, status: 409, error: 'EMAIL_TAKEN' };
  }
  return { ok: true, email: input.email, password: input.password as string };
}
```

- [ ] **Step 5 : Vérifier**

Run: `bun test backend/test/credentials-door.test.ts backend/test/signup-door.test.ts backend/test/signup-flow.test.ts`
Expected: PASS.

- [ ] **Step 6 : Commit**

```bash
git add backend/src/auth/signup-door.ts backend/src/auth/credentials-door.ts backend/test/credentials-door.test.ts backend/test/signup-door.test.ts
git commit -m "Retenir une invitation le temps d'une inscription"
```

---

## Task 4 : Le mailer

**Files:**
- Create: `backend/src/services/mailer.ts`
- Modify: `backend/package.json` (dépendance `nodemailer`, types)
- Modify: `backend/src/bootstrap/env-guard.ts`
- Modify: `backend/.env.example`, `docker-compose.yml`, `docker-compose.prod.yml`
- Test: `backend/test/mailer.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface Mail { to: string; subject: string; text: string }
  export function signupConfirmationMail(to: string, link: string): Mail;
  export function passwordResetMail(to: string, link: string): Mail;
  export function smtpConfigured(env?: Record<string, string | undefined>): boolean;
  export function sendMail(mail: Mail): Promise<void>;
  ```

- [ ] **Step 1 : Écrire le test qui échoue**

Créer `backend/test/mailer.test.ts` :

```ts
/**
 * Le contenu des deux mails, et le repli qui les journalise.
 *
 * L'envoi lui-même n'est pas testé ici -- il n'y a rien à apprendre d'un
 * nodemailer mocké. Ce qui compte et se teste : que le lien soit dans le
 * corps, que la durée y soit dite, et que l'absence de SMTP ne fasse pas
 * échouer une inscription en développement.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { passwordResetMail, signupConfirmationMail, smtpConfigured } from '../src/services/mailer.js';

test('le mail de confirmation porte le lien et sa durée', () => {
  const mail = signupConfirmationMail('bob@example.fr', 'https://psnes.example/auth/signup/confirm?token=xyz');
  assert.equal(mail.to, 'bob@example.fr');
  assert.ok(mail.text.includes('https://psnes.example/auth/signup/confirm?token=xyz'));
  assert.match(mail.text, /24\s*h|vingt-quatre/i);
  assert.ok(mail.subject.length > 0);
});

test('le mail de réinitialisation porte le lien, sa durée, et le rappel « sinon, ignorez »', () => {
  const mail = passwordResetMail('bob@example.fr', 'https://psnes.example/reset?token=xyz');
  assert.ok(mail.text.includes('https://psnes.example/reset?token=xyz'));
  assert.match(mail.text, /1\s*h|une heure/i);
  // Quelqu'un qui n'a rien demandé doit lire quoi faire : rien.
  assert.match(mail.text, /ignor/i);
});

test('aucun mail ne contient de balise HTML', () => {
  // Texte brut, délibérément : un lien de récupération n'a pas besoin d'être
  // joli, et un mail texte passe mieux les filtres.
  for (const mail of [
    signupConfirmationMail('bob@example.fr', 'https://x/y'),
    passwordResetMail('bob@example.fr', 'https://x/y')
  ]) {
    assert.equal(/<[a-z]/i.test(mail.text), false);
  }
});

test('SMTP absent est un état reconnu, pas une panne', () => {
  assert.equal(smtpConfigured({}), false);
  assert.equal(smtpConfigured({ SMTP_URL: '' }), false);
  assert.equal(smtpConfigured({ SMTP_URL: 'smtps://u:p@host:465' }), true);
});
```

- [ ] **Step 2 : Vérifier l'échec**

Run: `bun test backend/test/mailer.test.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 3 : Ajouter la dépendance**

```bash
cd backend && bun add nodemailer && bun add -d @types/nodemailer
```

Puis, **obligatoirement** :

```bash
cd /home/pleymor/projects/psnes-repos/psnes/.claude/worktrees/invite-only-access && bun pm untrusted
```

> `trustedDependencies` dans le `package.json` racine **remplace** la liste par défaut de Bun (~368 paquets) au lieu de l'étendre — c'est écrit en toutes lettres dans le champ `//trustedDependencies`. Tout paquet ajouté qui aurait un script d'installation le perd en silence. `bun pm untrusted` est le seul moyen de le voir.

- [ ] **Step 4 : Écrire le mailer**

```ts
import nodemailer, { type Transporter } from 'nodemailer';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('Mailer');

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export function smtpConfigured(
  env: Record<string, string | undefined> = process.env
): boolean {
  return Boolean(env.SMTP_URL && env.SMTP_URL.length > 0);
}

/**
 * Texte brut, en français, et rien d'autre.
 *
 * Pas de gabarit HTML : un lien de récupération de compte n'a pas besoin
 * d'être joli, un mail texte passe mieux les filtres, et une seule version à
 * écrire est une seule version à maintenir juste.
 */
export function signupConfirmationMail(to: string, link: string): Mail {
  return {
    to,
    subject: 'Confirmez votre compte psnes',
    text: [
      'Bonjour,',
      '',
      'Quelqu\'un — vous, sans doute — a créé un compte psnes avec cette adresse.',
      'Ce lien le confirme et vous connecte :',
      '',
      link,
      '',
      'Il est valable 24 h. Passé ce délai, l\'invitation qui vous a été donnée',
      'retourne à la personne qui vous l\'avait offerte, et il faudra lui en',
      'redemander une.',
      '',
      'Si vous n\'êtes pas à l\'origine de cette demande, ignorez ce message :',
      'aucun compte n\'a encore été créé.'
    ].join('\n')
  };
}

export function passwordResetMail(to: string, link: string): Mail {
  return {
    to,
    subject: 'Réinitialiser votre mot de passe psnes',
    text: [
      'Bonjour,',
      '',
      'Ce lien vous laisse choisir un nouveau mot de passe :',
      '',
      link,
      '',
      'Il est valable 1 h et ne sert qu\'une fois. L\'utiliser déconnectera',
      'toutes vos sessions ouvertes, sur tous vos appareils.',
      '',
      'Si vous n\'avez rien demandé, ignorez ce message : votre mot de passe',
      'actuel continue de fonctionner, et personne n\'a accès à votre compte.'
    ].join('\n')
  };
}

let transport: Transporter | null = null;

function getTransport(): Transporter {
  if (!transport) transport = nodemailer.createTransport(process.env.SMTP_URL!);
  return transport;
}

/**
 * Envoie, ou journalise le lien quand aucun SMTP n'est configuré.
 *
 * Le repli n'est pas un confort : c'est ce qui rend les deux parcours
 * testables de bout en bout sans identifiants, et le mode développement
 * utilisable hors ligne. `env-guard.ts` exige `SMTP_URL` en production, donc
 * ce chemin ne peut pas s'y produire.
 */
export async function sendMail(mail: Mail): Promise<void> {
  if (!smtpConfigured()) {
    logger.warn(
      { to: mail.to, subject: mail.subject, body: mail.text },
      'Aucun SMTP configuré : le message est journalisé au lieu d\'être envoyé'
    );
    return;
  }
  await getTransport().sendMail({
    from: process.env.MAIL_FROM || 'psnes <no-reply@localhost>',
    to: mail.to,
    subject: mail.subject,
    text: mail.text
  });
}
```

- [ ] **Step 5 : Exiger `SMTP_URL` en production**

Dans `backend/src/bootstrap/env-guard.ts`, `assertUsableEnvironment` :

```ts
  // SMTP_URL n'est pas un secret au sens de la liste ci-dessus (pas de
  // longueur minimale, pas de motif de remplissage à traquer), mais son
  // absence est aussi grave : sans lui, `sendMail` journalise le lien de
  // réinitialisation au lieu de l'envoyer -- un jeton de reprise de compte
  // dans `docker logs`, et un joueur qui ne reçoit jamais rien.
  if (!process.env.SMTP_URL) {
    logger.fatal('Refusing to start in production: SMTP_URL is not set, so no confirmation or password-reset mail could be delivered');
    process.exit(1);
  }
```

> `AUTH_MODE` ne change pas dans ce fichier. L'égalité stricte reste.

- [ ] **Step 6 : Déclarer les variables**

`backend/.env.example` :

```
# Envoi de mail (confirmation d'inscription, réinitialisation de mot de passe).
# Une URL SMTP unique, pour que changer de fournisseur ne touche pas au code.
# Laissée vide en développement : le mailer journalise alors le lien au lieu
# de l'envoyer. Obligatoire en production, env-guard.ts refuse de démarrer sans.
SMTP_URL=
MAIL_FROM=psnes <no-reply@example.fr>

# La porte à mot de passe. `off` la referme sans toucher à AUTH_MODE, dont
# env-guard.ts teste l'égalité stricte pour refuser `dev` en production.
PASSWORD_AUTH=on
```

Dans les deux `docker-compose*.yml`, service `backend` :

```yaml
      - PASSWORD_AUTH=${PASSWORD_AUTH:-on}
```

> `SMTP_URL` et `MAIL_FROM` passent par `env_file: ./backend/.env` — ce sont des identifiants, ils n'ont rien à faire dans un fichier versionné.

- [ ] **Step 7 : Vérifier**

Run: `bun test backend/test/mailer.test.ts`
Expected: PASS, 4 tests.

Run: `bun run test:backend`
Expected: PASS.

- [ ] **Step 8 : Commit**

```bash
git add backend/src/services/mailer.ts backend/src/bootstrap/env-guard.ts backend/.env.example backend/package.json backend/test/mailer.test.ts docker-compose.yml docker-compose.prod.yml
git commit -m "Écrire les deux mails, et le repli qui les journalise"
```

---

## Task 5 : Les quatre routes

**Files:**
- Create: `backend/src/api/credentials.ts`
- Modify: `backend/src/bootstrap/app.ts` (montage sur `/auth`)
- Modify: `backend/src/api/auth.ts` (`GET /auth/mode` gagne `passwordAuth`)
- Create: `backend/src/auth/sessions.ts` (destruction des sessions d'un compte)
- Test: `backend/test/credentials-api.test.ts`

**Interfaces:**
- Consumes: Tasks 1-4 ; `admitSignup` et `consumeInvite` du chantier 1.
- Produces:
  ```ts
  export const credentialsRouter: Router;
  // sessions.ts
  export async function destroySessionsOf(userId: string): Promise<number>;
  ```

- [ ] **Step 1 : Écrire le test qui échoue**

Créer `backend/test/credentials-api.test.ts` :

```ts
/**
 * La confirmation, écrite comme une transaction.
 *
 * Les routes elles-mêmes sont minces ; ce qui mérite un test est la
 * transaction de confirmation -- quatre écritures qui doivent tenir ou tomber
 * ensemble -- et le fait que la porte soit reconsultée vingt-quatre heures
 * après le formulaire.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { migratedDb, insertUser } from './helpers.js';
import { hashPassword } from '../src/auth/password.js';
import { newToken } from '../src/auth/tokens.js';
import { mintInvite, findInviteByCode } from '../src/db/signup-invites.js';
import { createPendingSignup, findLivePendingSignupByToken } from '../src/db/pending-signups.js';
import { findCredentialByEmail } from '../src/db/credentials.js';
import { confirmSignup } from '../src/api/credentials.js';

test('confirmer crée le compte, l\'identifiant, consomme le lien et efface l\'attente', async () => {
  const db = migratedDb();
  const alice = insertUser(db);
  const invite = mintInvite(db, alice.id);
  const { token, hash } = newToken();
  createPendingSignup(db, {
    email: 'bob@example.fr', passwordHash: await hashPassword('correct horse'),
    inviteId: invite.id, tokenHash: hash
  });

  const result = confirmSignup(db, token);

  assert.equal(result.ok, true);
  const credential = findCredentialByEmail(db, 'bob@example.fr');
  assert.ok(credential);
  assert.equal(result.ok && result.user.id, credential!.userId);
  assert.equal(findInviteByCode(db, invite.code)?.inviteeId, credential!.userId);
  assert.notEqual(findInviteByCode(db, invite.code)?.usedAt, null);
  assert.equal(findLivePendingSignupByToken(db, hash), null);
});

test('un jeton inconnu ou expiré ne crée rien', () => {
  const db = migratedDb();
  const result = confirmSignup(db, newToken().token);
  assert.equal(!result.ok && result.error, 'TOKEN_INVALID');
});

test('la porte est reconsultée à la confirmation, pas seulement au formulaire', async () => {
  const db = migratedDb();
  const alice = insertUser(db);
  const invite = mintInvite(db, alice.id);
  const { token, hash } = newToken();
  createPendingSignup(db, {
    email: 'bob@example.fr', passwordHash: await hashPassword('correct horse'),
    inviteId: invite.id, tokenHash: hash
  });

  // La centième place part pendant que Bob lit ses mails.
  process.env.MAX_USERS = '1';
  try {
    const result = confirmSignup(db, token);
    assert.equal(!result.ok && result.error, 'PLATFORM_FULL');
    // Et rien n'a été écrit.
    assert.equal(findCredentialByEmail(db, 'bob@example.fr'), null);
    assert.equal(findInviteByCode(db, invite.code)?.usedAt, null);
    assert.ok(findLivePendingSignupByToken(db, hash));
  } finally {
    delete process.env.MAX_USERS;
  }
});

test('deux confirmations du même jeton ne font qu\'un compte', async () => {
  const db = migratedDb();
  const alice = insertUser(db);
  const invite = mintInvite(db, alice.id);
  const { token, hash } = newToken();
  createPendingSignup(db, {
    email: 'bob@example.fr', passwordHash: await hashPassword('correct horse'),
    inviteId: invite.id, tokenHash: hash
  });

  const first = confirmSignup(db, token);
  const second = confirmSignup(db, token);

  assert.equal(first.ok, true);
  assert.equal(!second.ok && second.error, 'TOKEN_INVALID');
  const count = db.prepare(`SELECT COUNT(*) AS n FROM "Credential"`).get() as { n: number };
  assert.equal(count.n, 1);
});
```

> `confirmSignup` est exportée séparément du routeur pour exactement cette raison : la transaction est ce qui mérite d'être épinglé, et elle n'a pas besoin d'un serveur HTTP pour l'être.

- [ ] **Step 2 : Vérifier l'échec**

Run: `bun test backend/test/credentials-api.test.ts`
Expected: FAIL.

- [ ] **Step 3 : Écrire les sessions**

Créer `backend/src/auth/sessions.ts` :

```ts
import { getRedis } from '../db/redis.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('Sessions');

/**
 * Ferme toutes les sessions ouvertes d'un compte.
 *
 * « Mot de passe oublié » est aussi ce qu'on fait quand on pense être
 * compromis : réécrire le hash sans fermer les sessions laisserait l'intrus
 * connecté. Le prix, assumé et annoncé dans le mail : le joueur est déconnecté
 * de son casque et de son PC en même temps.
 *
 * Implémenté par un balayage du magasin plutôt que par un index de sessions
 * par utilisateur, ou par une époque portée dans la session. C'est le choix de
 * la simplicité, et il repose sur une hypothèse d'échelle explicite : cent
 * comptes, donc au plus quelques centaines de clés `sess:*`. Si `MAX_USERS`
 * devait monter d'un ordre de grandeur, c'est cette fonction qu'il faudrait
 * revoir en premier -- pas les autres.
 *
 * `connect-redis` préfixe ses clés par `sess:` et y range du JSON dont
 * `passport.user` porte l'identifiant. Les deux sont des détails du magasin,
 * et c'est pourquoi ils sont écrits ici, à un seul endroit.
 */
export async function destroySessionsOf(userId: string): Promise<number> {
  const redis = getRedis();
  let closed = 0;

  for await (const key of redis.scanIterator({ MATCH: 'sess:*', COUNT: 100 })) {
    const raw = await redis.get(key);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as { passport?: { user?: string } };
      if (parsed.passport?.user === userId) {
        await redis.del(key);
        closed++;
      }
    } catch {
      // Une session illisible n'est pas la nôtre à réparer, et ne doit pas
      // interrompre la fermeture des autres.
    }
  }

  logger.info({ userId, closed }, 'Sessions closed after a password reset');
  return closed;
}
```

> Vérifier la forme de `scanIterator` pour la version de `redis` installée (`grep '"redis"' backend/package.json`, puis la doc de cette majeure) : elle a changé entre v4 et v5 — v4 rend des clés, v5 rend des lots. Adapter la boucle plutôt que de forcer la version.

- [ ] **Step 4 : Écrire le routeur**

Créer `backend/src/api/credentials.ts`. Le cœur, `confirmSignup`, avant les routes :

```ts
import { Router } from 'express';
import { getDb, type Database } from '../db/sqlite.js';
import { admitSignup } from '../auth/signup-door.js';
import { passwordAuthEnabled, signupFormDecision } from '../auth/credentials-door.js';
import { burnTime, hashPassword, passwordAcceptable, verifyPassword } from '../auth/password.js';
import { hashToken, newToken } from '../auth/tokens.js';
import { destroySessionsOf } from '../auth/sessions.js';
import { consumeInvite } from '../db/signup-invites.js';
import {
  createCredential, emailTaken, findCredentialByEmail, setPasswordHash
} from '../db/credentials.js';
import {
  createPendingSignup, deletePendingSignup, findLivePendingSignupByToken
} from '../db/pending-signups.js';
import {
  createPasswordReset, findLiveResetByToken, useReset
} from '../db/password-resets.js';
import { createPasswordUser, findUserById } from '../db/users.js';
import { passwordResetMail, sendMail, signupConfirmationMail } from '../services/mailer.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { credentialLoginLimit, inviteLookupLimit } from '../utils/attempt-limit.js';
import type { User } from '../db/types.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('Credentials');

export const credentialsRouter = Router();

function frontendUrl(): string {
  return (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
}

/**
 * Le compte naît ici, et nulle part ailleurs.
 *
 * Quatre écritures dans UNE transaction : le compte, l'identifiant,
 * l'invitation consommée, l'attente effacée. Séparées, un échec au milieu
 * laisserait un compte sans mot de passe, ou une invitation dépensée pour
 * personne.
 *
 * La porte est reconsultée À L'INTÉRIEUR. Vingt-quatre heures ont pu passer
 * depuis le formulaire : la centième place a pu partir, et l'invitation a pu
 * être révoquée par celui qui l'avait donnée.
 *
 * Exportée séparément du routeur pour être testable sans serveur HTTP -- c'est
 * la partie qui mérite d'être épinglée.
 */
export function confirmSignup(db: Database, token: string):
  | { ok: true; user: User }
  | { ok: false; status: number; error: string }
{
  const pending = findLivePendingSignupByToken(db, hashToken(token));
  if (!pending) {
    return { ok: false, status: 410, error: 'TOKEN_INVALID' };
  }

  // Hors transaction : `admitSignup` ne fait que lire, et la lecture d'une
  // retenue verrait sa propre PendingSignup si elle passait par la porte
  // complète. On saute donc `held` en consultant sur le code du lien.
  const invite = db.prepare(
    `SELECT code FROM "SignupInvite" WHERE id = ?`
  ).get(pending.inviteId) as { code: string } | undefined;

  const decision = admitSignup(db, {
    code: invite?.code,
    signedIn: false,
    blocked: false,
    ignoreHeldId: pending.id
  });
  if (!decision.ok) {
    return { ok: false, status: decision.status, error: decision.error };
  }

  const run = db.transaction(() => {
    const user = createPasswordUser(db);
    createCredential(db, user.id, pending.email, pending.passwordHash);
    consumeInvite(db, pending.inviteId, user.id);
    deletePendingSignup(db, pending.id);
    return user;
  });

  return { ok: true, user: run() };
}
```

> **`ignoreHeldId`** : `admitSignup` doit apprendre un paramètre optionnel. Sans lui, la confirmation se refuserait elle-même — sa propre `PendingSignup` retient le lien qu'elle vient utiliser. Ajouter à `signup-door.ts` :
>
> ```ts
> // La retenue d'une inscription ne doit pas bloquer CETTE inscription-là.
> held: invite ? inviteIsHeld(db, invite.id, Date.now(), input.ignoreHeldId) : false,
> ```
>
> et faire prendre à `inviteIsHeld` un quatrième paramètre `exceptId?: string` qui ajoute `AND id != @exceptId`. **Écrire d'abord le test** dans `credentials.test.ts` : « une inscription en attente ne se retient pas elle-même ».

Les quatre routes, ensuite :

```ts
/** Le formulaire. Ne crée aucun compte : seulement une attente et un mail. */
credentialsRouter.post('/signup', asyncHandler(async (req, res) => {
  const db = getDb();
  const key = req.ip ?? 'unknown';

  const door = admitSignup(db, {
    code: typeof req.body?.code === 'string' ? req.body.code : undefined,
    signedIn: Boolean(req.user),
    blocked: inviteLookupLimit.blocked(key)
  });
  inviteLookupLimit.record(key);
  if (!door.ok) return res.status(door.status).json({ error: door.error });

  const form = signupFormDecision({
    enabled: passwordAuthEnabled(),
    email: req.body?.email,
    password: req.body?.password,
    emailTaken: emailTaken(db, typeof req.body?.email === 'string' ? req.body.email : '')
  });
  if (!form.ok) return res.status(form.status).json({ error: form.error });

  const { token, hash } = newToken();
  createPendingSignup(db, {
    email: form.email,
    passwordHash: await hashPassword(form.password),
    inviteId: door.invite.id,
    tokenHash: hash
  });

  await sendMail(signupConfirmationMail(
    form.email,
    `${frontendUrl()}/auth/signup/confirm?token=${token}`
  ));

  logger.info({ inviteId: door.invite.id }, 'Signup awaiting mail confirmation');
  res.status(202).json({ ok: true });
}));

/** Le clic dans le mail. C'est ici que le compte existe pour la première fois. */
credentialsRouter.get('/signup/confirm', asyncHandler(async (req, res) => {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  const result = confirmSignup(getDb(), token);

  if (!result.ok) {
    return res.redirect(`${frontendUrl()}/signup?signupError=${result.error}`);
  }
  req.login(result.user, err => {
    if (err) return res.redirect(`${frontendUrl()}/login?signupError=LOGIN_FAILED`);
    res.redirect(frontendUrl());
  });
}));

credentialsRouter.post('/login', asyncHandler(async (req, res) => {
  if (!passwordAuthEnabled()) return res.status(404).json({ error: 'PASSWORD_AUTH_DISABLED' });

  const email = typeof req.body?.email === 'string' ? req.body.email : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  // Deux clés : l'adresse, pour qu'un attaquant distribué ne balaye pas un
  // compte depuis mille adresses IP ; l'IP, pour qu'il ne balaye pas mille
  // comptes depuis une seule.
  const keys = [`ip:${req.ip ?? 'unknown'}`, `mail:${email.toLowerCase()}`];
  if (keys.some(k => credentialLoginLimit.blocked(k))) {
    return res.status(429).json({ error: 'TOO_MANY_ATTEMPTS' });
  }

  const credential = findCredentialByEmail(getDb(), email);
  // Une adresse inconnue coûte le même temps qu'un mauvais mot de passe :
  // sans cela, la durée de réponse seule dit qui a un compte ici.
  const good = credential
    ? await verifyPassword(password, credential.passwordHash)
    : (await burnTime(), false);

  if (!good) {
    for (const k of keys) credentialLoginLimit.record(k);
    return res.status(401).json({ error: 'BAD_CREDENTIALS' });
  }

  const user = findUserById(getDb(), credential!.userId);
  if (!user) return res.status(401).json({ error: 'BAD_CREDENTIALS' });

  req.login(user, err => {
    if (err) return res.status(500).json({ error: 'Login failed' });
    res.json(toSelf(user));
  });
}));

/**
 * Toujours 200, toujours le même corps.
 *
 * Une réponse différenciée serait un test d'existence de compte gratuit, sur
 * une route ouverte à n'importe qui. Un compte Google n'a pas de Credential :
 * il tombe dans la même branche silencieuse que l'adresse inconnue.
 */
credentialsRouter.post('/forgot', asyncHandler(async (req, res) => {
  const key = req.ip ?? 'unknown';
  if (!credentialLoginLimit.blocked(key)) {
    credentialLoginLimit.record(key);
    const email = typeof req.body?.email === 'string' ? req.body.email : '';
    const credential = passwordAuthEnabled() ? findCredentialByEmail(getDb(), email) : null;
    if (credential) {
      const { token, hash } = newToken();
      createPasswordReset(getDb(), credential.userId, hash);
      await sendMail(passwordResetMail(credential.email, `${frontendUrl()}/reset?token=${token}`));
      logger.info({ userId: credential.userId }, 'Password reset mail sent');
    }
  }
  res.json({ ok: true });
}));

credentialsRouter.post('/reset', asyncHandler(async (req, res) => {
  const db = getDb();
  const token = typeof req.body?.token === 'string' ? req.body.token : '';
  const password = req.body?.password;

  if (!passwordAcceptable(password)) {
    return res.status(400).json({ error: 'PASSWORD_TOO_SHORT' });
  }
  const reset = findLiveResetByToken(db, hashToken(token));
  if (!reset) return res.status(410).json({ error: 'TOKEN_INVALID' });

  const hash = await hashPassword(password as string);
  db.transaction(() => {
    setPasswordHash(db, reset.userId, hash);
    useReset(db, reset.id);
  })();

  // Après l'écriture, jamais avant : si la fermeture échoue, le mot de passe
  // est tout de même changé, et c'est le bon sens de l'échec.
  await destroySessionsOf(reset.userId);

  const user = findUserById(db, reset.userId);
  if (!user) return res.status(410).json({ error: 'TOKEN_INVALID' });
  req.login(user, err => {
    if (err) return res.status(500).json({ error: 'Login failed' });
    res.json(toSelf(user));
  });
}));
```

`toSelf` est importée depuis `./auth.js` — elle y est déjà exportée.

- [ ] **Step 5 : Ajouter la limite de connexion**

Dans `backend/src/utils/attempt-limit.ts` :

```ts
/**
 * Les échecs de connexion, par adresse IP et par adresse e-mail.
 *
 * Deux clés distinctes et non une : l'IP seule laisserait un attaquant
 * distribué balayer un compte depuis mille machines, l'adresse seule le
 * laisserait balayer mille comptes depuis une. Seuls les échecs comptent --
 * quelqu'un qui se connecte correctement dix fois dans l'heure n'a rien fait
 * de mal.
 */
export const credentialLoginLimit = new AttemptLimit({ max: 10, windowMs: 15 * 60 * 1000 });
```

- [ ] **Step 6 : Monter le routeur et compléter `/auth/mode`**

Dans `backend/src/bootstrap/app.ts`, avant `app.use('/auth', authRouter);` :

```ts
  app.use('/auth', credentialsRouter);
```

Dans `backend/src/api/auth.ts`, ajouter `passwordAuth: passwordAuthEnabled()` à la réponse de `GET /auth/mode`.

- [ ] **Step 7 : Vérifier**

Run: `bun run test:backend`
Expected: PASS.

- [ ] **Step 8 : Commit**

```bash
git add backend/src/api/credentials.ts backend/src/auth/sessions.ts backend/src/auth/signup-door.ts backend/src/db/pending-signups.ts backend/src/utils/attempt-limit.ts backend/src/bootstrap/app.ts backend/src/api/auth.ts backend/test/credentials-api.test.ts backend/test/credentials.test.ts
git commit -m "Ouvrir l'inscription, la connexion et la reprise par mot de passe"
```

---

## Task 6 : Les trois écrans

**Files:**
- Create: `frontend/src/routes/signup/+page.svelte`
- Create: `frontend/src/routes/login/+page.svelte`
- Create: `frontend/src/routes/reset/+page.svelte`
- Modify: `frontend/svelte.config.js:32` (`entries`)
- Modify: `frontend/src/routes/+page.svelte` (lien vers `/login`)
- Modify: `frontend/src/lib/auth/signup-refusal.ts` (les refus du chantier 2)
- Modify: `frontend/src/lib/i18n/translations.ts`
- Modify: `core/test/invite-copy.test.ts` (la liste des refus)

**Interfaces:**
- Consumes: les routes de la Task 5 et les codes de refus des Tasks 3 et 5.

- [ ] **Step 1 : Étendre le test des refus**

Dans `core/test/invite-copy.test.ts`, ajouter à la constante `REFUSALS` :

```ts
  'INVITE_HELD', 'PASSWORD_AUTH_DISABLED', 'EMAIL_MALFORMED',
  'PASSWORD_TOO_SHORT', 'EMAIL_TAKEN', 'BAD_CREDENTIALS', 'TOKEN_INVALID'
```

- [ ] **Step 2 : Vérifier l'échec**

Run: `bun test core/test/invite-copy.test.ts`
Expected: FAIL — sept clés manquantes.

- [ ] **Step 3 : Étendre la table et les traductions**

Dans `frontend/src/lib/auth/signup-refusal.ts` :

```ts
  INVITE_HELD: 'signupInviteHeld',
  PASSWORD_AUTH_DISABLED: 'signupPasswordDisabled',
  EMAIL_MALFORMED: 'signupEmailMalformed',
  PASSWORD_TOO_SHORT: 'signupPasswordTooShort',
  EMAIL_TAKEN: 'signupEmailTaken',
  BAD_CREDENTIALS: 'loginBadCredentials',
  TOKEN_INVALID: 'signupTokenInvalid',
```

Dans les deux blocs de `translations.ts` — version `fr`, et son miroir exact en `en` :

```ts
    signupInviteHeld: 'Quelqu\'un est en train d\'utiliser cette invitation. Si c\'est vous, ouvrez le lien reçu par mail.',
    signupPasswordDisabled: 'La connexion par mot de passe n\'est pas ouverte.',
    signupEmailMalformed: 'Cette adresse ne ressemble pas à une adresse e-mail.',
    signupPasswordTooShort: 'Le mot de passe doit faire au moins 10 caractères.',
    signupEmailTaken: 'Un compte existe déjà avec cette adresse.',
    signupTokenInvalid: 'Ce lien a expiré ou a déjà servi.',
    loginBadCredentials: 'Adresse ou mot de passe incorrect.',
    // Écrans
    loginTitle: 'Se connecter',
    loginWithPassword: 'Se connecter avec un mot de passe',
    loginEmail: 'Adresse e-mail',
    loginPassword: 'Mot de passe',
    loginForgot: 'Mot de passe oublié ?',
    loginForgotSent: 'Si un compte existe avec cette adresse, un lien vient de partir. Regardez votre boîte mail.',
    loginSend: 'Envoyer le lien',
    signupTitle: 'Créer votre compte',
    signupPasswordHint: '10 caractères minimum. Aucune autre règle.',
    signupSubmit: 'Créer le compte',
    signupCheckMail: 'Regardez votre boîte mail : le lien de confirmation vous y attend. Il est valable 24 h.',
    resetTitle: 'Choisir un nouveau mot de passe',
    resetSubmit: 'Enregistrer',
    resetWillSignOut: 'Enregistrer déconnectera toutes vos sessions, sur tous vos appareils.',
```

- [ ] **Step 4 : Vérifier**

Run: `bun test core/test/invite-copy.test.ts core/test/i18n-parity.test.ts`
Expected: PASS.

- [ ] **Step 5 : Déclarer les routes au prérendu**

`frontend/svelte.config.js` :

```js
      entries: ['/', '/profile', '/docs', '/signup', '/login', '/reset']
```

> Sans cette ligne, `bun run build` échoue avec « marked as prerenderable, but were not prerendered because they were not found while crawling » — et aucun test ne le voit. C'est la panne documentée dans la mémoire « New route breaks the deploy ».

- [ ] **Step 6 : Écrire les trois pages**

Chacune reprend la mise en page de `frontend/src/routes/profile/+page.svelte` (le même cadre, le même retour) — la relire avant d'écrire, plutôt que d'inventer un cadre de plus.

`/signup` : lit `?invite=` et `?signupError=`, appelle `GET /auth/invite/:code` au montage ; si valide, un formulaire adresse + mot de passe qui `POST /auth/signup` puis remplace le formulaire par `signupCheckMail`. Le mot de passe garde `autocomplete="new-password"` et le champ adresse `type="email" autocomplete="email"`.

`/login` : adresse + mot de passe (`autocomplete="current-password"`), `POST /auth/login`, redirection vers `/` sur succès. Un `<button>` `loginForgot` déplie une seconde forme, dans la même page, qui `POST /auth/forgot` et affiche `loginForgotSent` **quelle que soit la réponse** — le serveur répond toujours 200, l'écran ne doit pas laisser croire le contraire.

`/reset` : lit `?token=`, un champ mot de passe, affiche `resetWillSignOut` sous le bouton, `POST /auth/reset`, redirige vers `/` sur succès.

Sur `/` (`+page.svelte`), sous le bouton Google, un lien vers `/login` intitulé `loginWithPassword`, affiché seulement si `authMode.passwordAuth` est vrai.

- [ ] **Step 7 : Vérifier**

Run: `cd frontend && bun run check`
Expected: 0 erreur.

Run: `cd frontend && bun run build`
Expected: succès, avec les six entrées prérendues.

- [ ] **Step 8 : Commit**

```bash
git add frontend/src/routes/signup frontend/src/routes/login frontend/src/routes/reset frontend/svelte.config.js frontend/src/routes/+page.svelte frontend/src/lib/auth/signup-refusal.ts frontend/src/lib/i18n/translations.ts core/test/invite-copy.test.ts
git commit -m "Donner à l'inscription par mot de passe ses trois écrans"
```

---

## Task 7 : Le parcours complet, dans une vraie pile

**Files:** aucun. C'est un contrôle.

- [ ] **Step 1 : Monter la pile**

Même recette que la Task 8 du chantier 1 : liens `node_modules`, vrai dossier vide pour `frontend/node_modules`, Redis en conteneur, backend **sur 3000**, front sur **5276**, `FRONTEND_URL=http://localhost:5276`.

**`SMTP_URL` laissée vide** : le mailer journalise les liens dans la sortie du backend, et c'est là qu'on ira les chercher.

- [ ] **Step 2 : L'inscription**

1. Se connecter en dev, frapper un lien d'invitation, le copier, se déconnecter.
2. Ouvrir `/signup?invite=CODE` : le formulaire apparaît.
3. Un mot de passe de 9 caractères : refusé, message lisible.
4. Un mot de passe correct : l'écran passe à « regardez votre boîte mail ».
5. **Rouvrir `/signup?invite=CODE` dans un autre onglet** : `signupInviteHeld`. C'est la retenue.
6. Récupérer le lien de confirmation dans le journal du backend, l'ouvrir : compte créé, connecté, portique de pseudonyme.
7. Rouvrir le même lien : `signupTokenInvalid`, et aucun second compte.

- [ ] **Step 3 : La connexion et la reprise**

8. Se déconnecter, `/login`, mauvais mot de passe : `loginBadCredentials`. Onze fois : `TOO_MANY_ATTEMPTS`.
9. Attendre la fenêtre ou redémarrer le backend, se connecter correctement.
10. `/login` → « mot de passe oublié », une adresse inconnue : le même message que pour une connue. Vérifier dans le journal qu'aucun mail n'est parti.
11. La vraie adresse : le lien apparaît dans le journal.
12. Ouvrir le lien depuis un **second navigateur** pendant que le premier est connecté ; changer le mot de passe. **Recharger le premier navigateur : il doit être déconnecté.** C'est le seul contrôle qui prouve `destroySessionsOf`.
13. Réutiliser le même lien de reprise : `signupTokenInvalid`.

- [ ] **Step 4 : Ce qui ne doit pas avoir changé**

14. Un lien de salon ouvre toujours la porte anonyme, sans invitation.
15. `PASSWORD_AUTH=off` : `/login` refuse, et l'accueil n'affiche plus le lien.
16. `AUTH_MODE=dev NODE_ENV=production` : le backend refuse de démarrer. L'égalité stricte est intacte.
17. `NODE_ENV=production` sans `SMTP_URL` : le backend refuse de démarrer.

- [ ] **Step 5 : La suite complète, sur une base neuve**

```bash
bun run test:all
```

> Une suite e2e rejouée sur une base déjà utilisée fait tomber deux ou trois specs qui ne sont pas les mêmes d'une fois sur l'autre — sessions et compteurs accumulés, pas régressions. Supprimer `e2e.db*`, `redis-cli FLUSHALL`, rejouer les migrations avant toute passe dont on veut croire le résultat.

- [ ] **Step 6 : Documenter**

Dans `ARCHITECTURE.md`, compléter la section « L'entrée sur la plateforme » : les deux portes, `PASSWORD_AUTH`, le fait qu'un compte Google n'a pas d'adresse et n'a donc pas de reprise par mail, et le fait qu'une méthode par compte est la règle pour l'instant.

```bash
git add ARCHITECTURE.md
git commit -m "Documenter les deux portes d'entrée"
```

---

## Auto-relecture

**Couverture de la spec (chantier 2)**

| Exigence | Tâche |
|---|---|
| `Bun.password` argon2id, zéro dépendance | 1 |
| 10 caractères, aucune règle de composition | 1 |
| Coût constant sur adresse inconnue | 1 (`burnTime`), 5 (l'appel) |
| Jetons hachés SHA-256, 128 bits | 1 |
| `Credential` séparée, index `COLLATE NOCASE`, adresse rendue telle que tapée | 2 |
| `PendingSignup` 24 h, `PasswordReset` 1 h usage unique | 2 |
| Une demande de reprise éteint les précédentes | 2 |
| `PASSWORD_AUTH` variable à part, `AUTH_MODE` intact | 3 |
| `INVITE_HELD`, la retenue | 2 (base), 3 (porte), 5 (`ignoreHeldId`) |
| nodemailer, `SMTP_URL`, repli qui journalise, `env-guard` | 4 |
| Les quatre routes, `/forgot` sans oracle | 5 |
| Confirmation en une transaction, porte reconsultée | 5 |
| Sessions détruites à la reprise | 5 |
| Trois écrans, `entries`, i18n | 6 |
| Une méthode par compte (rien à écrire, rien ne lie les deux) | — |

**Trois points que ce plan signale au lieu de deviner** :
- la forme de `scanIterator` selon la majeure de `redis` (Task 5, Step 3) ;
- `await` au niveau du module pour `DUMMY_HASH` — repli documenté si `tsc` refuse (Task 1, Step 3) ;
- la mise en page à reprendre de `/profile` pour les trois écrans (Task 6, Step 6).

**Une chose que ce plan ajoute à la spec** : `ignoreHeldId`. La spec dit « une inscription en attente retient l'invitation » sans dire que la confirmation doit s'exempter de sa propre retenue. Sans ce paramètre, **aucune inscription par mot de passe n'aboutirait jamais** — la confirmation se refuserait elle-même avec `INVITE_HELD`. C'est un blocage total, et il ne serait apparu qu'au premier essai bout en bout.

**Cohérence des types** : `PendingSignup` porte les mêmes champs de la Task 2 à la Task 5 ; `inviteIsHeld` prend `(db, inviteId, now?, exceptId?)` partout après la Task 5 ; `newToken()` rend `{ token, hash }` et jamais l'inverse ; les codes de refus des Tasks 3 et 5 sont exactement ceux que la Task 6 traduit, et son test échoue si l'un des deux bouge.
