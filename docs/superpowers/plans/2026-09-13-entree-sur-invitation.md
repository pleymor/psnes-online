# Entrée sur invitation — plan d'implémentation (chantier 1/2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On ne crée plus de compte sur la plateforme sans un lien d'invitation émis par un joueur déjà présent, et le nombre de comptes est borné à 100.

**Architecture:** Une table `SignupInvite`, une fonction pure `signupDoorDecision()` qui porte l'ordre des refus, et un seul point d'application : la stratégie Google, qui consulte la porte quand — et seulement quand — le `googleId` est inconnu. Le quota et le plafond sont des requêtes de comptage, jamais des compteurs dénormalisés.

**Tech Stack:** Bun + `bun:sqlite`, Express 4, Passport (`passport-google-oauth20`), SvelteKit 2 / Svelte 4, tests `bun:test` + `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-09-13-invitations-et-mot-de-passe-design.md`

**Chantier 2 (auth e-mail + mot de passe) fait l'objet d'un plan séparé, écrit après celui-ci.** Ce plan-là livre du logiciel utile seul : l'inscription Google devient fermée.

## Global Constraints

- **Les dates sont des millisecondes epoch** (`INTEGER`), écrites explicitement avec `Date.now()`. Jamais de `DEFAULT CURRENT_TIMESTAMP` — il insérerait du texte là où tout le dépôt met des nombres, et SQLite ne s'en plaindrait pas. Voir `backend/src/db/invitations.ts:19-23`.
- **`bun:sqlite` est ouvert en `strict: true`** : les paramètres nommés se lient avec des clés nues (`{ id }` pour `@id`), sans sigil.
- **Aucun `PRAGMA` dans un fichier de migration** — `migrate.ts:assertNoPragma` refuse le fichier avant de l'exécuter.
- **Aucune dépendance npm nouvelle dans ce chantier.**
- **`AUTH_MODE` ne change pas.** Toute nouvelle porte est une variable d'environnement à part, comme `ANONYMOUS_JOIN` (`backend/src/auth/anonymous.ts:36-48`).
- **Le mot « invitation » nu est ambigu** dans ce dépôt : `Invitation` / `RoomInvitation` désigne « rejoins mon salon ». Le nouveau concept est `SignupInvite` partout — table, fichiers, types, clés i18n.
- **Chaînes d'interface en `en` ET `fr`** dans `frontend/src/lib/i18n/translations.ts`, sans quoi `core/test/i18n-parity.test.ts` échoue.
- **Toute route SvelteKit nouvelle doit être ajoutée à `entries`** dans `frontend/svelte.config.js:32` — `prerender = true` est global, et l'oubli casse le build de production, pas les tests.
- Commandes : `bun run test:backend` (glob, aucun fichier à enregistrer), `bun run test:ui` (liste explicite dans `package.json`), `cd frontend && bun run build` pour le contrôle de prérendu.

---

## Structure des fichiers

| Fichier | Responsabilité |
|---|---|
| `backend/migrations/0006_invite_only_signup.sql` | la table `SignupInvite` |
| `backend/src/db/signup-invites.ts` | les requêtes : frapper, trouver par code, consommer, révoquer, compter |
| `backend/src/auth/signup-door.ts` | **fonction pure** : faut-il ouvrir, et dans quel ordre refuser |
| `backend/src/auth/passport.ts` | *modifié* : `passReqToCallback`, consultation de la porte sur `googleId` inconnu |
| `backend/src/api/auth.ts` | *modifié* : `/auth/google` mémorise `?invite=`, `GET /auth/invite/:code` |
| `backend/src/api/invites.ts` | les routes `/api/invites` du propriétaire d'un quota |
| `backend/src/bootstrap/app.ts` | *modifié* : montage du routeur |
| `backend/src/utils/attempt-limit.ts` | *modifié* : une limite de plus, `inviteLookupLimit` |
| `backend/src/db/invite-cli.ts` | l'échappatoire en ssh |
| `frontend/src/routes/+page.svelte` | *modifié* : le lien `?invite=` porté jusqu'à Google, et les refus affichés |
| `frontend/src/lib/components/MyInvites.svelte` | la section « Mes invitations » |
| `frontend/src/routes/profile/+page.svelte` | *modifié* : y monte le composant |

---

## Task 1 : La table et ses requêtes

**Files:**
- Create: `backend/migrations/0006_invite_only_signup.sql`
- Create: `backend/src/db/signup-invites.ts`
- Test: `backend/test/signup-invites.test.ts`

**Interfaces:**
- Consumes: `migratedDb()` et `insertUser()` de `backend/test/helpers.ts`, `Database` de `../src/db/sqlite.js`.
- Produces:
  ```ts
  export interface SignupInvite {
    id: string; code: string; inviterId: string; inviteeId: string | null;
    grantedByCli: boolean; createdAt: Date; usedAt: Date | null; revokedAt: Date | null;
  }
  export const INVITE_QUOTA = 2;
  export function mintInvite(db: Database, inviterId: string, opts?: { grantedByCli?: boolean }): SignupInvite;
  export function findInviteByCode(db: Database, code: string): SignupInvite | null;
  export function findInviteById(db: Database, id: string): SignupInvite | null;
  export function listInvitesOf(db: Database, inviterId: string): SignupInvite[];
  export function countChargedInvites(db: Database, inviterId: string): number;
  export function revokeInvite(db: Database, id: string): void;
  export function consumeInvite(db: Database, id: string, inviteeId: string): void;
  export function countAccounts(db: Database): number;
  export function maxUsers(env?: Record<string, string | undefined>): number;
  ```

- [ ] **Step 1 : Écrire le test qui échoue**

Créer `backend/test/signup-invites.test.ts` :

```ts
/**
 * Les places, comptées sur la base plutôt que sur un compteur.
 *
 * Le quota est une requête et non une colonne : une colonne `invitesLeft`
 * dériverait au premier chemin qui oublie de la décrémenter, et rien ne le
 * dirait. Ces tests épinglent le comptage, pas le stockage.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { migratedDb, insertUser } from './helpers.js';
import {
  INVITE_QUOTA, mintInvite, findInviteByCode, listInvitesOf,
  countChargedInvites, revokeInvite, consumeInvite, countAccounts, maxUsers
} from '../src/db/signup-invites.js';

test('un lien frappé est retrouvable par son code, et son code est imprévisible', () => {
  const db = migratedDb();
  const alice = insertUser(db);

  const invite = mintInvite(db, alice.id);

  assert.equal(findInviteByCode(db, invite.code)?.id, invite.id);
  assert.equal(invite.inviteeId, null);
  assert.equal(invite.usedAt, null);
  assert.equal(invite.grantedByCli, false);
  // 128 bits en base64url : 22 caractères, sans remplissage.
  assert.match(invite.code, /^[A-Za-z0-9_-]{22}$/);
  assert.notEqual(mintInvite(db, alice.id).code, invite.code);
});

test('un lien vivant coûte une place, exactement comme un lien consommé', () => {
  const db = migratedDb();
  const alice = insertUser(db);
  const bob = insertUser(db);

  const first = mintInvite(db, alice.id);
  assert.equal(countChargedInvites(db, alice.id), 1);

  consumeInvite(db, first.id, bob.id);
  assert.equal(countChargedInvites(db, alice.id), 1);

  mintInvite(db, alice.id);
  assert.equal(countChargedInvites(db, alice.id), INVITE_QUOTA);
});

test('révoquer un lien non consommé rend la place', () => {
  const db = migratedDb();
  const alice = insertUser(db);

  const invite = mintInvite(db, alice.id);
  revokeInvite(db, invite.id);

  assert.equal(countChargedInvites(db, alice.id), 0);
  assert.notEqual(findInviteByCode(db, invite.code)?.revokedAt, null);
});

test('une invitation frappée par le CLI ne débite personne', () => {
  const db = migratedDb();
  const alice = insertUser(db);

  mintInvite(db, alice.id, { grantedByCli: true });

  assert.equal(countChargedInvites(db, alice.id), 0);
  assert.equal(listInvitesOf(db, alice.id).length, 1);
});

test('un filleul qui disparaît laisse la place consommée', () => {
  const db = migratedDb();
  const alice = insertUser(db);
  const bob = insertUser(db);
  const invite = mintInvite(db, alice.id);
  consumeInvite(db, invite.id, bob.id);

  db.prepare(`DELETE FROM "User" WHERE id = ?`).run(bob.id);

  // ON DELETE SET NULL, pas CASCADE : sans quoi un inviteur recyclerait ses
  // places indéfiniment en faisant tourner des comptes.
  const after = findInviteByCode(db, invite.code);
  assert.equal(after?.inviteeId, null);
  assert.notEqual(after?.usedAt, null);
  assert.equal(countChargedInvites(db, alice.id), 1);
});

test('un inviteur qui disparaît emporte ses liens', () => {
  const db = migratedDb();
  const alice = insertUser(db);
  const invite = mintInvite(db, alice.id);

  db.prepare(`DELETE FROM "User" WHERE id = ?`).run(alice.id);

  assert.equal(findInviteByCode(db, invite.code), null);
});

test('les anonymes ne comptent pas dans les places de la plateforme', () => {
  const db = migratedDb();
  insertUser(db);
  insertUser(db);
  insertUser(db, { isAnonymous: 1 });

  assert.equal(countAccounts(db), 2);
});

test('le plafond est une variable, pas une constante', () => {
  assert.equal(maxUsers({}), 100);
  assert.equal(maxUsers({ MAX_USERS: '250' }), 250);
  // Une valeur illisible ne doit pas ouvrir la plateforme en grand.
  assert.equal(maxUsers({ MAX_USERS: 'beaucoup' }), 100);
});
```

- [ ] **Step 2 : Vérifier que le test échoue**

Run: `bun test backend/test/signup-invites.test.ts`
Expected: FAIL — `Cannot find module '../src/db/signup-invites.js'`

- [ ] **Step 3 : Écrire la migration**

Créer `backend/migrations/0006_invite_only_signup.sql` :

```sql
-- On n'entre plus sans y être invité.
--
-- `code` est en clair, contrairement aux jetons de mail du chantier suivant.
-- Ce n'est pas un oubli : l'inviteur doit pouvoir rouvrir son profil et
-- recopier son lien, et un secret qu'il faut réafficher ne peut pas être
-- haché. Ce que ce code donne est borné -- le droit de créer un compte, pas
-- d'en prendre un.
--
-- `inviteeId` est en ON DELETE SET NULL et non CASCADE. Si le filleul supprime
-- son compte, l'invitation reste consommée : avec CASCADE, un inviteur
-- recyclerait ses deux places indéfiniment en faisant tourner des comptes.
--
-- Les trois dates sont des millisecondes epoch, écrites explicitement par le
-- code appelant. Pas de DEFAULT CURRENT_TIMESTAMP : il insérerait du texte là
-- où tout ce schéma met des nombres, et SQLite étant typé dynamiquement
-- personne ne s'en plaindrait avant qu'une comparaison de dates soit fausse.

CREATE TABLE "SignupInvite" (
  "id"           TEXT PRIMARY KEY,
  "code"         TEXT NOT NULL UNIQUE,
  "inviterId"    TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "inviteeId"    TEXT REFERENCES "User"("id") ON DELETE SET NULL,
  "grantedByCli" INTEGER NOT NULL DEFAULT 0,
  "createdAt"    INTEGER NOT NULL,
  "usedAt"       INTEGER,
  "revokedAt"    INTEGER
);

CREATE INDEX "SignupInvite_inviterId_idx" ON "SignupInvite" ("inviterId");
```

- [ ] **Step 4 : Écrire le module de requêtes**

Créer `backend/src/db/signup-invites.ts` :

```ts
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
```

- [ ] **Step 5 : Vérifier que les tests passent**

Run: `bun test backend/test/signup-invites.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6 : Vérifier que la migration ne casse pas les bases existantes**

Run: `bun test backend/test/migrate.test.ts`
Expected: PASS — ce test rejoue les vrais fichiers de `backend/migrations`.

- [ ] **Step 7 : Commit**

```bash
git add backend/migrations/0006_invite_only_signup.sql backend/src/db/signup-invites.ts backend/test/signup-invites.test.ts
git commit -m "Compter les places d'invitation plutôt que les liens"
```

---

## Task 2 : La porte, en fonction pure

**Files:**
- Create: `backend/src/auth/signup-door.ts`
- Test: `backend/test/signup-door.test.ts`

**Interfaces:**
- Consumes: `SignupInvite` et `INVITE_QUOTA` de `../db/signup-invites.js`.
- Produces:
  ```ts
  export type SignupRefusal =
    | 'ALREADY_SIGNED_IN' | 'PLATFORM_FULL' | 'INVITE_UNKNOWN'
    | 'INVITE_REVOKED' | 'INVITE_USED' | 'QUOTA_EXHAUSTED' | 'TOO_MANY_ATTEMPTS';
  export type SignupDecision =
    | { ok: true; invite: SignupInvite }
    | { ok: false; status: number; error: SignupRefusal };
  export function signupDoorDecision(input: {
    signedIn: boolean; blocked: boolean; accounts: number; maxUsers: number;
    invite: SignupInvite | null; inviterCharged: number;
  }): SignupDecision;
  ```

`INVITE_HELD` n'apparaît pas ici : il appartient au chantier 2, où une inscription en attente retient un lien. Ce chantier n'a pas d'état intermédiaire.

- [ ] **Step 1 : Écrire le test qui échoue**

Créer `backend/test/signup-door.test.ts` :

```ts
/**
 * L'ordre des refus EST la décision de sécurité.
 *
 * Testé sur une fonction pure, sans serveur ni base, exactement comme
 * `anonymousDoorDecision` (backend/src/auth/anonymous.ts) : une décision
 * d'autorisation doit pouvoir être lue et épinglée sans monter une pile.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { signupDoorDecision } from '../src/auth/signup-door.js';
import type { SignupInvite } from '../src/db/signup-invites.js';

function invite(over: Partial<SignupInvite> = {}): SignupInvite {
  return {
    id: 'inv-1', code: 'abcdefghijklmnopqrstuv', inviterId: 'alice',
    inviteeId: null, grantedByCli: false,
    createdAt: new Date(), usedAt: null, revokedAt: null,
    ...over
  };
}

const OPEN = {
  signedIn: false, blocked: false, accounts: 10, maxUsers: 100,
  invite: invite(), inviterCharged: 1
};

test('un lien valide sur une plateforme qui a de la place ouvre', () => {
  const decision = signupDoorDecision(OPEN);
  assert.equal(decision.ok, true);
  assert.equal(decision.ok && decision.invite.id, 'inv-1');
});

test('la plateforme pleine refuse AVANT de regarder le code', () => {
  // L'inverse offrirait un compteur de places restantes à qui détient un lien
  // mort : « code inconnu » signifierait alors « il reste de la place ».
  const decision = signupDoorDecision({
    ...OPEN, accounts: 100, maxUsers: 100, invite: null
  });
  assert.equal(decision.ok, false);
  assert.equal(!decision.ok && decision.error, 'PLATFORM_FULL');
  assert.equal(!decision.ok && decision.status, 503);
});

test('une session existante est refusée avant tout le reste', () => {
  const decision = signupDoorDecision({ ...OPEN, signedIn: true, accounts: 100 });
  assert.equal(!decision.ok && decision.error, 'ALREADY_SIGNED_IN');
  assert.equal(!decision.ok && decision.status, 400);
});

test('la limite de tentatives passe avant la lecture du code', () => {
  const decision = signupDoorDecision({ ...OPEN, blocked: true });
  assert.equal(!decision.ok && decision.error, 'TOO_MANY_ATTEMPTS');
  assert.equal(!decision.ok && decision.status, 429);
});

test('un code inconnu, un code révoqué et un code consommé sont trois réponses', () => {
  // Distinctes exprès : le porteur d'un lien mort a le droit de savoir que le
  // lien a existé, et le dire ne lui apprend rien qu'il ne détienne déjà.
  const unknown = signupDoorDecision({ ...OPEN, invite: null });
  assert.equal(!unknown.ok && unknown.error, 'INVITE_UNKNOWN');
  assert.equal(!unknown.ok && unknown.status, 404);

  const revoked = signupDoorDecision({ ...OPEN, invite: invite({ revokedAt: new Date() }) });
  assert.equal(!revoked.ok && revoked.error, 'INVITE_REVOKED');
  assert.equal(!revoked.ok && revoked.status, 410);

  const used = signupDoorDecision({
    ...OPEN, invite: invite({ usedAt: new Date(), inviteeId: 'bob' })
  });
  assert.equal(!used.ok && used.error, 'INVITE_USED');
  assert.equal(!used.ok && used.status, 410);
});

test('révoqué l\'emporte sur consommé quand une ligne porte les deux', () => {
  // consumeInvite refuse un lien révoqué et revokeInvite un lien consommé,
  // donc la ligne ne devrait pas exister. Si elle existe, la réponse doit être
  // déterministe plutôt que dépendante de l'ordre des `if`.
  const decision = signupDoorDecision({
    ...OPEN, invite: invite({ usedAt: new Date(), revokedAt: new Date() })
  });
  assert.equal(!decision.ok && decision.error, 'INVITE_REVOKED');
});

test('le lien en cours de consommation est LUI-MÊME compté, donc 2 passe', () => {
  // La borne, et elle est contre-intuitive : `countChargedInvites` compte
  // toutes les invitations non révoquées, celle qu'on est en train d'utiliser
  // comprise. Un inviteur qui a distribué ses deux liens est à 2, et son
  // deuxième filleul doit pouvoir entrer. Refuser à 2 fermerait la seconde
  // place à tout le monde -- un hors-par-un qui ne se verrait qu'en
  // production, sur la deuxième invitation de chaque joueur.
  assert.equal(signupDoorDecision({ ...OPEN, inviterCharged: 2 }).ok, true);
});

test('un inviteur au-delà de son quota ne fait plus entrer personne', () => {
  // 3 places non révoquées ne peut venir que d'un contournement de POST
  // /api/invites, qui refuse à partir de 2. La porte le rattrape.
  const decision = signupDoorDecision({ ...OPEN, inviterCharged: 3 });
  assert.equal(!decision.ok && decision.error, 'QUOTA_EXHAUSTED');
  assert.equal(!decision.ok && decision.status, 403);
});

test('un lien frappé par le CLI ouvre même si son inviteur est au bout', () => {
  const decision = signupDoorDecision({
    ...OPEN, invite: invite({ grantedByCli: true }), inviterCharged: 2
  });
  assert.equal(decision.ok, true);
});
```

- [ ] **Step 2 : Vérifier que le test échoue**

Run: `bun test backend/test/signup-door.test.ts`
Expected: FAIL — `Cannot find module '../src/auth/signup-door.js'`

- [ ] **Step 3 : Écrire la porte**

Créer `backend/src/auth/signup-door.ts` :

```ts
/**
 * Qui a le droit de faire naître un compte, et dans quel ordre on refuse.
 *
 * Une fonction pure, sans base ni requête, comme `anonymousDoorDecision` juste
 * à côté : l'ordre des refus est la décision de sécurité, et il doit pouvoir
 * être lu et épinglé sans monter un serveur.
 *
 * `SignupInvite` et non `Invitation` : `Invitation` est déjà pris dans ce
 * dépôt et veut dire « rejoins mon salon » (`db/invitations.ts`). Deux
 * concepts, deux mots.
 */

import { INVITE_QUOTA, type SignupInvite } from '../db/signup-invites.js';

export type SignupRefusal =
  | 'ALREADY_SIGNED_IN'
  | 'PLATFORM_FULL'
  | 'INVITE_UNKNOWN'
  | 'INVITE_REVOKED'
  | 'INVITE_USED'
  | 'QUOTA_EXHAUSTED'
  | 'TOO_MANY_ATTEMPTS';

export type SignupDecision =
  | { ok: true; invite: SignupInvite }
  | { ok: false; status: number; error: SignupRefusal };

/**
 * Trois choses se jouent dans l'ordre ci-dessous :
 *
 * - `PLATFORM_FULL` passe AVANT la validation du code. L'inverse offrirait un
 *   compteur de places restantes à qui détient un lien mort : « code inconnu »
 *   voudrait alors dire « il reste de la place ».
 * - La limite de tentatives passe avant la lecture du code, pour la même
 *   raison que dans `anonymousDoorDecision` : sans cela, chaque tentative
 *   bloquée resterait un test d'existence gratuit.
 * - Révoqué l'emporte sur consommé. Les deux ne devraient jamais coexister
 *   (`consumeInvite` refuse un lien révoqué, `revokeInvite` un lien consommé),
 *   mais si une ligne portait les deux, la réponse doit être déterministe et
 *   non dépendante de l'ordre où les `if` ont été tapés.
 */
export function signupDoorDecision(input: {
  signedIn: boolean;
  blocked: boolean;
  accounts: number;
  maxUsers: number;
  invite: SignupInvite | null;
  /** Places déjà dépensées par l'inviteur, hors invitations frappées au CLI. */
  inviterCharged: number;
}): SignupDecision {
  if (input.signedIn) {
    return { ok: false, status: 400, error: 'ALREADY_SIGNED_IN' };
  }
  if (input.blocked) {
    return { ok: false, status: 429, error: 'TOO_MANY_ATTEMPTS' };
  }
  if (input.accounts >= input.maxUsers) {
    return { ok: false, status: 503, error: 'PLATFORM_FULL' };
  }
  if (!input.invite) {
    return { ok: false, status: 404, error: 'INVITE_UNKNOWN' };
  }
  if (input.invite.revokedAt) {
    return { ok: false, status: 410, error: 'INVITE_REVOKED' };
  }
  if (input.invite.usedAt) {
    return { ok: false, status: 410, error: 'INVITE_USED' };
  }
  // Une invitation frappée au CLI est l'échappatoire du propriétaire : elle ne
  // débite personne, donc le quota de l'inviteur ne la concerne pas.
  if (!input.invite.grantedByCli && input.inviterCharged > INVITE_QUOTA) {
    return { ok: false, status: 403, error: 'QUOTA_EXHAUSTED' };
  }
  return { ok: true, invite: input.invite };
}
```

- [ ] **Step 4 : Vérifier que les tests passent**

Run: `bun test backend/test/signup-door.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5 : Commit**

```bash
git add backend/src/auth/signup-door.ts backend/test/signup-door.test.ts
git commit -m "Écrire la porte d'inscription comme une fonction pure"
```

---

## Task 3 : Google passe par la porte

**Files:**
- Modify: `backend/src/auth/passport.ts` (la stratégie entière)
- Modify: `backend/src/api/auth.ts:21-45` (les deux routes Google)
- Test: `backend/test/signup-flow.test.ts`

**Interfaces:**
- Consumes: `signupDoorDecision`, `SignupDecision` (Task 2) ; `mintInvite`, `findInviteByCode`, `consumeInvite`, `countChargedInvites`, `countAccounts`, `maxUsers` (Task 1).
- Produces:
  ```ts
  // backend/src/auth/signup-door.ts, ajouté ici
  export function admitSignup(db: Database, input: {
    code: string | undefined; signedIn: boolean; blocked: boolean;
  }): SignupDecision;
  // express-session gagne un champ
  declare module 'express-session' { interface SessionData { pendingInviteCode?: string } }
  ```

`admitSignup` est la couche qui va chercher en base ce que `signupDoorDecision` reçoit tout cuit. Elle vit dans le même fichier pour que le lecteur voie d'un coup d'œil ce qui est lu et ce qui est décidé — mais c'est bien `signupDoorDecision` qui décide, et elle seule qui est testée exhaustivement.

- [ ] **Step 1 : Écrire le test qui échoue**

Créer `backend/test/signup-flow.test.ts` :

```ts
/**
 * La porte branchée sur une vraie base.
 *
 * `signup-door.test.ts` épingle l'ordre des refus sur une fonction pure ; ce
 * fichier-ci vérifie que ce qu'on lui donne à décider vient bien de la base --
 * le quota du bon inviteur, le compte des vrais comptes.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { migratedDb, insertUser } from './helpers.js';
import { admitSignup } from '../src/auth/signup-door.js';
import { mintInvite, consumeInvite } from '../src/db/signup-invites.js';

test('un code valide est admis, et rend la ligne à consommer', () => {
  const db = migratedDb();
  const alice = insertUser(db);
  const invite = mintInvite(db, alice.id);

  const decision = admitSignup(db, { code: invite.code, signedIn: false, blocked: false });

  assert.equal(decision.ok, true);
  assert.equal(decision.ok && decision.invite.id, invite.id);
});

test('aucun code du tout est un code inconnu', () => {
  const db = migratedDb();
  const decision = admitSignup(db, { code: undefined, signedIn: false, blocked: false });
  assert.equal(!decision.ok && decision.error, 'INVITE_UNKNOWN');
});

test('le quota lu est celui de l\'inviteur du lien, pas d\'un autre', () => {
  const db = migratedDb();
  const alice = insertUser(db);
  const bob = insertUser(db);
  const carol = insertUser(db);
  const dave = insertUser(db);

  // Alice a tout dépensé, Bob n'a rien dépensé.
  consumeInvite(db, mintInvite(db, alice.id).id, carol.id);
  consumeInvite(db, mintInvite(db, alice.id).id, dave.id);
  const fromAlice = mintInvite(db, alice.id);
  const fromBob = mintInvite(db, bob.id);

  assert.equal(
    admitSignup(db, { code: fromAlice.code, signedIn: false, blocked: false }).ok, false
  );
  assert.equal(
    admitSignup(db, { code: fromBob.code, signedIn: false, blocked: false }).ok, true
  );
});

test('le plafond compte les comptes, pas les invités anonymes', () => {
  const db = migratedDb();
  const alice = insertUser(db);
  const invite = mintInvite(db, alice.id);
  process.env.MAX_USERS = '2';
  try {
    // alice + un anonyme = 1 compte, il reste une place.
    insertUser(db, { isAnonymous: 1 });
    assert.equal(
      admitSignup(db, { code: invite.code, signedIn: false, blocked: false }).ok, true
    );

    insertUser(db);
    const full = admitSignup(db, { code: invite.code, signedIn: false, blocked: false });
    assert.equal(!full.ok && full.error, 'PLATFORM_FULL');
  } finally {
    delete process.env.MAX_USERS;
  }
});
```

> **Attention** — `bun test` partage un processus entre les fichiers : une variable d'environnement posée par un test fuit vers les autres. Le `try/finally` ci-dessus n'est pas décoratif. Voir la mémoire « Test globals leak across files ».

- [ ] **Step 2 : Vérifier que le test échoue**

Run: `bun test backend/test/signup-flow.test.ts`
Expected: FAIL — `admitSignup is not a function`

- [ ] **Step 3 : Ajouter `admitSignup` à `signup-door.ts`**

Ajouter en bas de `backend/src/auth/signup-door.ts` :

```ts
import type { Database } from '../db/sqlite.js';
import { countAccounts, countChargedInvites, findInviteByCode, maxUsers } from '../db/signup-invites.js';

/**
 * Ce que la porte a besoin de savoir, lu en base.
 *
 * Séparée de `signupDoorDecision` : celle-ci décide et se teste sans rien
 * monter, celle-là va chercher. Le partage est délibéré -- une lecture ratée
 * ne doit pas pouvoir se faire passer pour une décision.
 */
export function admitSignup(
  db: Database,
  input: { code: string | undefined; signedIn: boolean; blocked: boolean }
): SignupDecision {
  const invite = input.code ? findInviteByCode(db, input.code) : null;
  return signupDoorDecision({
    signedIn: input.signedIn,
    blocked: input.blocked,
    accounts: countAccounts(db),
    maxUsers: maxUsers(),
    invite,
    inviterCharged: invite ? countChargedInvites(db, invite.inviterId) : 0
  });
}

/**
 * Le code d'invitation que porte la session, entre le clic sur le lien et le
 * retour de Google.
 *
 * Dans la session du serveur et pas dans le paramètre `state` d'OAuth : `state`
 * revient du navigateur, donc d'un endroit que l'utilisateur contrôle. Ce
 * champ-là ne peut être posé que par notre propre route.
 */
declare module 'express-session' {
  interface SessionData {
    pendingInviteCode?: string;
  }
}
```

- [ ] **Step 4 : Vérifier que les tests passent**

Run: `bun test backend/test/signup-flow.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5 : Brancher la stratégie Google**

Dans `backend/src/auth/passport.ts`, remplacer l'appel `new GoogleStrategy({...}, callback)` par :

```ts
    passport.use(
      new GoogleStrategy(
        {
          clientID: process.env.GOOGLE_CLIENT_ID!,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
          callbackURL: process.env.GOOGLE_CALLBACK_URL!,
          // La porte a besoin de la session pour y lire le code d'invitation.
          // C'est la seule raison de ce drapeau ; le reste du rappel ne touche
          // pas à `req`.
          passReqToCallback: true
        },
        async (req, _accessToken, _refreshToken, profile, done) => {
          try {
            const db = getDb();
            let user = findUserByGoogleId(db, profile.id);

            // Se reconnecter n'est pas s'inscrire : un googleId connu ne
            // consulte jamais la porte. Sans cette distinction, baisser
            // MAX_USERS mettrait dehors des joueurs déjà installés.
            if (!user) {
              const code = req.session?.pendingInviteCode;
              const decision = admitSignup(db, {
                code,
                signedIn: false,
                blocked: inviteLookupLimit.blocked(req.ip ?? 'unknown')
              });
              inviteLookupLimit.record(req.ip ?? 'unknown');

              if (!decision.ok) {
                logger.info({ error: decision.error }, 'Signup door refused a Google sign-in');
                // `done(null, false, info)` et non une erreur : ce n'est pas
                // une panne, c'est un refus. `failureRedirect` s'en charge.
                return done(null, false, { message: decision.error });
              }

              user = createUser(db, { googleId: profile.id, avatar: null });
              consumeInvite(db, decision.invite.id, user.id);
              delete req.session.pendingInviteCode;
            }

            const googleAvatarUrl = profile.photos?.[0]?.value;
            if (googleAvatarUrl) {
              const downloaded = await downloadAvatar(googleAvatarUrl, user.id);
              user = updateUserAvatar(db, user.id, downloaded || googleAvatarUrl);
            }

            return done(null, user);
          } catch (error) {
            return done(error as Error);
          }
        }
      )
    );
```

Ajouter en tête du fichier :

```ts
import { admitSignup } from './signup-door.js';
import { consumeInvite } from '../db/signup-invites.js';
import { inviteLookupLimit } from '../utils/attempt-limit.js';
```

> La création du compte et la consommation du lien sont deux écritures ; les envelopper d'une transaction ici demanderait de faire remonter `db.transaction` à travers le rappel asynchrone de Passport. Elles se suivent immédiatement, sans `await` entre elles, et le pire cas — un compte créé sur un lien resté vivant — coûte une place à l'inviteur, pas une faille. Le chantier 2, lui, a une vraie transaction : sa confirmation écrit quatre lignes.

- [ ] **Step 6 : Ajouter la limite de tentatives**

À la fin de `backend/src/utils/attempt-limit.ts`, à côté de `anonymousDoorLimit` :

```ts
/**
 * Les codes d'invitation présentés, par adresse.
 *
 * Comptée par IP et non par compte : personne n'est connecté ici, c'est le
 * propre de l'inscription. Chaque tentative compte, réussie ou non -- une
 * réussite pose une ligne, donc ne compter que les refus reviendrait à ne pas
 * compter. Un code fait 128 bits, donc cette limite ne le protège pas du
 * devinage : elle empêche d'en essayer un million par minute pour rien.
 */
export const inviteLookupLimit = new AttemptLimit({ max: 30, windowMs: 60 * 60 * 1000 });
```

- [ ] **Step 7 : Faire porter le code par `/auth/google`**

Dans `backend/src/api/auth.ts`, remplacer la route `authRouter.get('/google', ...)` par :

```ts
  /**
   * Le code d'invitation entre dans la session AVANT la redirection.
   *
   * Il ne peut pas voyager dans l'URL de rappel : celle-ci est déclarée chez
   * Google et fixe. `state` reviendrait du navigateur ; la session, non.
   */
  authRouter.get('/google', (req, res, next) => {
    const code = req.query.invite;
    if (typeof code === 'string' && code.length > 0) {
      req.session.pendingInviteCode = code;
    }
    next();
  }, passport.authenticate('google', { scope: ['profile'] }));
```

Et la route de rappel, pour que le refus arrive quelque part de lisible :

```ts
  authRouter.get('/google/callback',
    (req, res, next) => {
      passport.authenticate('google', (err: unknown, user: User | false, info?: { message?: string }) => {
        if (err) return next(err);
        if (!user) {
          const reason = info?.message ?? 'SIGNUP_REFUSED';
          const target = new URL(process.env.FRONTEND_URL || 'http://localhost:5173');
          target.searchParams.set('signupError', reason);
          return res.redirect(target.toString());
        }
        req.login(user, loginErr => {
          if (loginErr) return next(loginErr);
          res.redirect(process.env.FRONTEND_URL || 'http://localhost:5173');
        });
      })(req, res, next);
    }
  );
```

> `failureRedirect: '/login'` disparaît : il pointait une route qui n'existe pas dans ce front, et il avalait la raison du refus. Le code de refus doit atteindre la page d'accueil, sans quoi un invité recalé voit l'écran de connexion sans savoir pourquoi.

- [ ] **Step 8 : Vérifier que rien n'a cassé**

Run: `bun run test:backend`
Expected: PASS, y compris `self-view.test.ts` et `anonymous.test.ts`.

- [ ] **Step 9 : Commit**

```bash
git add backend/src/auth/signup-door.ts backend/src/auth/passport.ts backend/src/api/auth.ts backend/src/utils/attempt-limit.ts backend/test/signup-flow.test.ts
git commit -m "Faire passer l'inscription Google par la porte"
```

---

## Task 4 : Les routes du quota

**Files:**
- Create: `backend/src/api/invites.ts`
- Modify: `backend/src/bootstrap/app.ts:196` (montage, après `/api/user`)
- Modify: `backend/src/api/auth.ts` (route publique `GET /auth/invite/:code`)
- Test: `backend/test/invites-api.test.ts`

**Interfaces:**
- Consumes: tout Task 1 et Task 2 ; `requirePseudo` de `../middleware/auth.js` ; `asyncHandler` de `../middleware/async-handler.js`.
- Produces:
  ```ts
  export const invitesRouter: Router;
  export function toInviteView(invite: SignupInvite, inviteePseudo: string | null, frontendUrl: string): {
    id: string; code: string; url: string;
    usedAt: string | null; inviteePseudo: string | null;
  };
  ```

- [ ] **Step 1 : Écrire le test qui échoue**

Créer `backend/test/invites-api.test.ts` :

```ts
/**
 * Ce que le propriétaire d'un quota voit de ses places.
 *
 * `toInviteView` est testée seule parce que c'est elle qui décide de ce qui
 * sort du serveur -- la même raison qui a fait écrire `toSelf` à la main dans
 * api/auth.ts plutôt que de sérialiser la ligne.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { toInviteView } from '../src/api/invites.js';
import type { SignupInvite } from '../src/db/signup-invites.js';

const invite: SignupInvite = {
  id: 'inv-1', code: 'abcdefghijklmnopqrstuv', inviterId: 'alice',
  inviteeId: null, grantedByCli: false,
  createdAt: new Date(1_700_000_000_000), usedAt: null, revokedAt: null
};

test('la vue porte le lien complet, prêt à copier', () => {
  const view = toInviteView(invite, null, 'https://psnes.example');
  assert.equal(view.url, 'https://psnes.example/?invite=abcdefghijklmnopqrstuv');
});

test('la vue ne laisse pas sortir l\'identifiant de l\'inviteur ni celui du filleul', () => {
  const used = { ...invite, usedAt: new Date(1_700_000_001_000), inviteeId: 'bob-uuid' };
  const view = toInviteView(used, 'Sprite#0417', 'https://psnes.example');

  assert.deepEqual(Object.keys(view).sort(), ['code', 'id', 'inviteePseudo', 'url', 'usedAt']);
  assert.equal(view.inviteePseudo, 'Sprite#0417');
  assert.equal(JSON.stringify(view).includes('bob-uuid'), false);
});
```

- [ ] **Step 2 : Vérifier que le test échoue**

Run: `bun test backend/test/invites-api.test.ts`
Expected: FAIL — `Cannot find module '../src/api/invites.js'`

- [ ] **Step 3 : Écrire le routeur**

Créer `backend/src/api/invites.ts` :

```ts
import { Router } from 'express';
import { getDb } from '../db/sqlite.js';
import {
  INVITE_QUOTA, countAccounts, countChargedInvites, findInviteById,
  listInvitesOf, maxUsers, mintInvite, revokeInvite, type SignupInvite
} from '../db/signup-invites.js';
import { findUserById } from '../db/users.js';
import { asyncHandler } from '../middleware/async-handler.js';
import type { User } from '../db/types.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('Invites');

export const invitesRouter = Router();

function frontendUrl(): string {
  return process.env.FRONTEND_URL || 'http://localhost:5173';
}

/**
 * Ce qu'un joueur apprend de ses propres invitations.
 *
 * Écrite à la main plutôt que dérivée de la ligne, pour la raison que `toSelf`
 * documente dans api/auth.ts : une colonne ajoutée plus tard à `SignupInvite`
 * ne doit pas pouvoir rejoindre cette réponse par accident. `inviterId` et
 * `inviteeId` restent au serveur -- le pseudonyme du filleul est ce qui est
 * lisible, son identifiant interne n'apprend rien à personne.
 */
export function toInviteView(
  invite: SignupInvite, inviteePseudo: string | null, base: string
) {
  return {
    id: invite.id,
    code: invite.code,
    url: `${base.replace(/\/$/, '')}/?invite=${invite.code}`,
    usedAt: invite.usedAt ? invite.usedAt.toISOString() : null,
    inviteePseudo
  };
}

function viewOf(db: ReturnType<typeof getDb>, invite: SignupInvite) {
  const invitee = invite.inviteeId ? findUserById(db, invite.inviteeId) : null;
  const pseudo = invitee ? `${invitee.pseudo}#${invitee.discriminator}` : null;
  return toInviteView(invite, pseudo, frontendUrl());
}

invitesRouter.get('/', asyncHandler(async (req, res) => {
  const db = getDb();
  const me = req.user as User;
  const charged = countChargedInvites(db, me.id);
  res.json({
    quota: INVITE_QUOTA,
    remaining: Math.max(0, INVITE_QUOTA - charged),
    platformFull: countAccounts(db) >= maxUsers(),
    invites: listInvitesOf(db, me.id).map(invite => viewOf(db, invite))
  });
}));

invitesRouter.post('/', asyncHandler(async (req, res) => {
  const db = getDb();
  const me = req.user as User;

  // Le plafond est vérifié ici ET à la consommation. Ici pour ne pas laisser
  // frapper un lien vers une plateforme pleine ; là-bas parce que des semaines
  // peuvent passer entre les deux, et qu'un lien émis n'est pas une place
  // réservée.
  if (countAccounts(db) >= maxUsers()) {
    return res.status(503).json({ error: 'PLATFORM_FULL' });
  }
  if (countChargedInvites(db, me.id) >= INVITE_QUOTA) {
    return res.status(403).json({ error: 'QUOTA_EXHAUSTED' });
  }

  const invite = mintInvite(db, me.id);
  logger.info({ userId: me.id, inviteId: invite.id }, 'Signup invite minted');
  res.status(201).json(viewOf(db, invite));
}));

invitesRouter.delete('/:id', asyncHandler(async (req, res) => {
  const db = getDb();
  const me = req.user as User;
  const invite = findInviteById(db, req.params.id);

  // Un lien qui n'est pas le vôtre est un lien qui n'existe pas : un 403
  // confirmerait l'existence d'un identifiant à qui l'a deviné.
  if (!invite || invite.inviterId !== me.id) {
    return res.status(404).json({ error: 'INVITE_UNKNOWN' });
  }
  if (invite.usedAt) {
    return res.status(409).json({ error: 'INVITE_USED' });
  }

  revokeInvite(db, invite.id);
  res.status(204).end();
}));
```

- [ ] **Step 4 : Monter le routeur**

Dans `backend/src/bootstrap/app.ts`, après la ligne `app.use('/api/user', requirePseudo, userRouter);` :

```ts
  // `requirePseudo` et pas `requireAccount` : un anonyme n'invite personne, et
  // un compte qui n'a pas encore choisi son pseudonyme n'a rien à distribuer.
  app.use('/api/invites', requirePseudo, invitesRouter);
```

Et l'import, à côté des autres routeurs :

```ts
import { invitesRouter } from '../api/invites.js';
```

- [ ] **Step 5 : Ajouter la route publique de vérification**

Dans `backend/src/api/auth.ts`, avant `authRouter.get('/mode', ...)` :

```ts
/**
 * Ce code vaut-il quelque chose ?
 *
 * Publique par nécessité : elle précède toute session. Donc limitée par IP, et
 * chaque appel compté qu'il réussisse ou non -- sans plafond, c'est un oracle
 * d'énumération de codes gratuit.
 *
 * Elle ne rend jamais l'invitation elle-même, seulement un verdict. Le
 * pseudonyme de l'inviteur serait agréable à afficher (« Sprite#0417 vous
 * invite ») et donnerait à qui balaye des codes un annuaire de joueurs : non.
 */
authRouter.get('/invite/:code', (req, res) => {
  const key = req.ip ?? 'unknown';
  const decision = admitSignup(getDb(), {
    code: req.params.code,
    signedIn: Boolean(req.user),
    blocked: inviteLookupLimit.blocked(key)
  });
  inviteLookupLimit.record(key);

  if (!decision.ok) {
    return res.status(decision.status).json({ error: decision.error });
  }
  res.json({ ok: true });
});
```

Avec les imports correspondants (`admitSignup`, `inviteLookupLimit`).

- [ ] **Step 6 : Compléter `GET /auth/mode`**

Remplacer le corps de la route par :

```ts
authRouter.get('/mode', (req, res) => {
  res.json({
    mode: AUTH_MODE,
    anonymousJoin: anonymousJoinEnabled(),
    // Le front n'a aucun moyen de savoir autrement que l'inscription est
    // fermée, et il doit le dire à un visiteur sans lien plutôt que de lui
    // offrir un bouton qui le renverra avec une erreur.
    inviteOnly: true
  });
});
```

- [ ] **Step 7 : Vérifier**

Run: `bun run test:backend`
Expected: PASS. `self-view.test.ts` épingle les clés de `toSelf`, pas celles de `/auth/mode` — mais relire son échec s'il y en a un.

- [ ] **Step 8 : Commit**

```bash
git add backend/src/api/invites.ts backend/src/api/auth.ts backend/src/bootstrap/app.ts backend/test/invites-api.test.ts
git commit -m "Ouvrir les routes du quota d'invitations"
```

---

## Task 5 : L'échappatoire en ssh

**Files:**
- Create: `backend/src/db/invite-cli.ts`
- Modify: `backend/package.json` (script `invite`)
- Test: `backend/test/invite-cli.test.ts`

**Interfaces:**
- Consumes: Task 1 ; `findUserByHandle` de `../db/users.js` ; `parseHandle` — **à vérifier** dans `backend/src/utils/pseudo.ts` ; s'il n'existe pas, la découpe se fait dans le CLI.
- Produces:
  ```ts
  export function runInviteCli(db: Database, argv: string[]): { code: number; lines: string[] };
  ```

Le CLI est écrit comme une fonction pure de `(db, argv)` vers des lignes, et le fichier ne fait que l'appeler avec `process.argv` et imprimer. C'est ce qui le rend testable sans lancer un processus.

- [ ] **Step 1 : Écrire le test qui échoue**

Créer `backend/test/invite-cli.test.ts` :

```ts
/**
 * L'échappatoire du propriétaire, testée sans lancer de processus.
 *
 * Le CLI est une fonction de (base, arguments) vers des lignes ; le fichier ne
 * fait que l'appeler avec process.argv. Un CLI qui ne se teste qu'en le
 * lançant n'est pas testé.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { migratedDb, insertUser } from './helpers.js';
import { runInviteCli } from '../src/db/invite-cli.js';
import { countChargedInvites, listInvitesOf } from '../src/db/signup-invites.js';

test('grant frappe une invitation hors quota', () => {
  const db = migratedDb();
  const alice = insertUser(db, { pseudo: 'Sprite', discriminator: '0417' });

  const result = runInviteCli(db, ['grant', 'Sprite#0417']);

  assert.equal(result.code, 0);
  assert.equal(listInvitesOf(db, alice.id).length, 1);
  assert.equal(countChargedInvites(db, alice.id), 0);
  assert.match(result.lines.join('\n'), /\?invite=/);
});

test('grant sur un handle inconnu échoue franchement', () => {
  const db = migratedDb();
  const result = runInviteCli(db, ['grant', 'Personne#9999']);
  assert.equal(result.code, 1);
  assert.match(result.lines.join('\n'), /Personne#9999/);
});

test('grant refuse un handle malformé plutôt que de deviner', () => {
  const db = migratedDb();
  const result = runInviteCli(db, ['grant', 'Sprite']);
  assert.equal(result.code, 1);
});

test('revoke éteint un lien par son code', () => {
  const db = migratedDb();
  const alice = insertUser(db, { pseudo: 'Sprite', discriminator: '0417' });
  runInviteCli(db, ['grant', 'Sprite#0417']);
  const code = listInvitesOf(db, alice.id)[0].code;

  const result = runInviteCli(db, ['revoke', code]);

  assert.equal(result.code, 0);
  assert.equal(listInvitesOf(db, alice.id).length, 0);
});

test('list dit combien de places sont prises sur la plateforme', () => {
  const db = migratedDb();
  insertUser(db);
  insertUser(db, { isAnonymous: 1 });

  const result = runInviteCli(db, ['list']);

  assert.equal(result.code, 0);
  // Un anonyme ne compte pas : 1 sur 100.
  assert.match(result.lines.join('\n'), /1\s*\/\s*100/);
});

test('une commande inconnue rend l\'usage et un code non nul', () => {
  const db = migratedDb();
  const result = runInviteCli(db, ['offrir']);
  assert.equal(result.code, 1);
  assert.match(result.lines.join('\n'), /grant/);
});
```

- [ ] **Step 2 : Vérifier que le test échoue**

Run: `bun test backend/test/invite-cli.test.ts`
Expected: FAIL — `Cannot find module '../src/db/invite-cli.js'`

- [ ] **Step 3 : Vérifier ce que `utils/pseudo.ts` offre déjà**

Run: `grep -n "export function" backend/src/utils/pseudo.ts`

Si une fonction découpe déjà `Pseudo#1234`, l'utiliser. Sinon, la découpe locale ci-dessous suffit — **ne pas** ajouter une fonction exportée dans `utils/pseudo.ts` pour un seul appelant.

- [ ] **Step 4 : Écrire le CLI**

Créer `backend/src/db/invite-cli.ts` :

```ts
/**
 * L'échappatoire du propriétaire, en ssh.
 *
 * Pas de colonne `isAdmin`, pas d'écran `/admin`. Une route privilégiée
 * exposée au web est une surface d'attaque permanente pour un besoin
 * occasionnel ; une commande derrière ssh a exactement la portée de l'accès
 * ssh, qui existe déjà.
 *
 * Écrit comme une fonction de (base, arguments) vers des lignes : c'est ce qui
 * le rend testable sans lancer de processus.
 *
 *     bun src/db/invite-cli.ts grant Sprite#0417
 *     bun src/db/invite-cli.ts list
 *     bun src/db/invite-cli.ts revoke <code>
 */

import { databaseFileFromUrl, openDatabase, type Database } from './sqlite.js';
import { findUserByHandle } from './users.js';
import {
  INVITE_QUOTA, countAccounts, countChargedInvites, findInviteByCode,
  listInvitesOf, maxUsers, mintInvite, revokeInvite
} from './signup-invites.js';

const USAGE = [
  'Usage :',
  '  grant <Pseudo#1234>   frappe une invitation qui ne débite pas son quota',
  '  list                  les places de la plateforme',
  '  revoke <code>         éteint un lien non consommé'
];

export function runInviteCli(db: Database, argv: string[]): { code: number; lines: string[] } {
  const [command, argument] = argv;

  if (command === 'list') {
    const lines = [`Comptes : ${countAccounts(db)} / ${maxUsers()}`];
    return { code: 0, lines };
  }

  if (command === 'grant') {
    const match = /^([^#]+)#(\d{4})$/.exec(argument ?? '');
    if (!match) {
      return { code: 1, lines: [`Handle attendu sous la forme Sprite#0417, reçu « ${argument ?? ''} »`] };
    }
    const user = findUserByHandle(db, match[1], match[2]);
    if (!user) {
      return { code: 1, lines: [`Aucun joueur ne porte ${argument}`] };
    }
    const invite = mintInvite(db, user.id, { grantedByCli: true });
    const base = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
    return {
      code: 0,
      lines: [
        `Invitation hors quota pour ${argument} :`,
        `${base}/?invite=${invite.code}`,
        `(quota ordinaire : ${countChargedInvites(db, user.id)} / ${INVITE_QUOTA})`
      ]
    };
  }

  if (command === 'revoke') {
    const invite = argument ? findInviteByCode(db, argument) : null;
    if (!invite) {
      return { code: 1, lines: [`Aucun lien ne porte ce code`] };
    }
    if (invite.usedAt) {
      return { code: 1, lines: [`Ce lien est déjà consommé ; une place occupée ne se rend pas`] };
    }
    revokeInvite(db, invite.id);
    return { code: 0, lines: [`Lien éteint. Il reste ${listInvitesOf(db, invite.inviterId).length} lien(s) vivant(s) à son inviteur.`] };
  }

  return { code: 1, lines: USAGE };
}

// `import.meta.main` : vrai seulement quand ce fichier est le point d'entrée,
// donc jamais pendant les tests qui importent `runInviteCli`.
if (import.meta.main) {
  const db = openDatabase(databaseFileFromUrl(process.env.DATABASE_URL ?? 'file:./dev.db'));
  const { code, lines } = runInviteCli(db, process.argv.slice(2));
  for (const line of lines) console.log(line);
  process.exit(code);
}
```

- [ ] **Step 5 : Ajouter le script**

Dans `backend/package.json`, à côté de `"db:migrate"` :

```json
    "invite": "bun src/db/invite-cli.ts",
```

- [ ] **Step 6 : Vérifier**

Run: `bun test backend/test/invite-cli.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 7 : Commit**

```bash
git add backend/src/db/invite-cli.ts backend/test/invite-cli.test.ts backend/package.json
git commit -m "Donner au propriétaire une échappatoire en ssh"
```

---

## Task 6 : L'accueil porte le lien, et dit les refus

**Files:**
- Modify: `frontend/src/routes/+page.svelte:475-478` (fonction `login`), et la section `login-section` autour de la ligne 521
- Modify: `frontend/src/lib/i18n/translations.ts` (blocs `en` et `fr`, section « Home page »)
- Test: `core/test/invite-copy.test.ts`
- Modify: `package.json` (ajouter le fichier à `test:ui`)

**Interfaces:**
- Consumes: `GET /auth/invite/:code` et les codes de refus de Task 2.
- Produces:
  ```ts
  // core/test/invite-copy.test.ts vérifie la table ci-dessous
  export const SIGNUP_REFUSAL_KEYS: Record<string, string>; // dans frontend/src/lib/auth/signup-refusal.ts
  ```

- [ ] **Step 1 : Écrire le test qui échoue**

Créer `core/test/invite-copy.test.ts` :

```ts
/**
 * Chaque refus de la porte a une phrase, dans les deux langues.
 *
 * Sans ce test, un code de refus ajouté côté serveur s'afficherait au visiteur
 * sous la forme `INVITE_REVOKED` -- et personne ne le verrait avant que ça
 * arrive à quelqu'un.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { SIGNUP_REFUSAL_KEYS } from '../../frontend/src/lib/auth/signup-refusal.js';
import { translations } from '../../frontend/src/lib/i18n/translations.js';

// La liste vient de backend/src/auth/signup-door.ts:SignupRefusal. Elle est
// recopiée ici plutôt qu'importée : le front ne dépend pas du backend, et une
// divergence doit faire échouer ce test plutôt que de disparaître dans un type.
const REFUSALS = [
  'ALREADY_SIGNED_IN', 'PLATFORM_FULL', 'INVITE_UNKNOWN',
  'INVITE_REVOKED', 'INVITE_USED', 'QUOTA_EXHAUSTED', 'TOO_MANY_ATTEMPTS'
];

test('chaque refus de la porte a une clé de traduction', () => {
  for (const refusal of REFUSALS) {
    assert.ok(SIGNUP_REFUSAL_KEYS[refusal], `aucune clé pour ${refusal}`);
  }
});

test('chaque clé existe en anglais et en français', () => {
  for (const key of Object.values(SIGNUP_REFUSAL_KEYS)) {
    assert.ok((translations.en as Record<string, unknown>)[key], `en.${key} manque`);
    assert.ok((translations.fr as Record<string, unknown>)[key], `fr.${key} manque`);
  }
});

test('un refus inconnu retombe sur une phrase générique', () => {
  assert.ok(SIGNUP_REFUSAL_KEYS.UNKNOWN);
});
```

- [ ] **Step 2 : Enregistrer le fichier dans `test:ui`**

Dans `package.json`, ajouter `core/test/invite-copy.test.ts` à la fin de la commande `test:ui`.

> Sans cette ligne, le fichier ne tournera jamais et le vert du CI ne voudra rien dire. Voir la mémoire « Test scripts enumerate files » : surveiller le **total** de tests, pas la couleur.

- [ ] **Step 3 : Vérifier que le test échoue**

Run: `bun test core/test/invite-copy.test.ts`
Expected: FAIL — module `signup-refusal.js` introuvable.

- [ ] **Step 4 : Écrire la table des refus**

Créer `frontend/src/lib/auth/signup-refusal.ts` :

```ts
/**
 * Un code de refus du serveur, et la phrase qui le dit à un humain.
 *
 * Une table plutôt qu'un `switch` dans le composant : `core/test/
 * invite-copy.test.ts` la parcourt pour vérifier qu'aucun refus ne sort en
 * MAJUSCULES_SOULIGNÉES devant un visiteur, ce qu'un switch ne permettrait pas
 * de vérifier sans monter le composant.
 */
export const SIGNUP_REFUSAL_KEYS: Record<string, string> = {
  ALREADY_SIGNED_IN: 'signupAlreadySignedIn',
  PLATFORM_FULL: 'signupPlatformFull',
  INVITE_UNKNOWN: 'signupInviteUnknown',
  INVITE_REVOKED: 'signupInviteRevoked',
  INVITE_USED: 'signupInviteUsed',
  QUOTA_EXHAUSTED: 'signupQuotaExhausted',
  TOO_MANY_ATTEMPTS: 'signupTooManyAttempts',
  UNKNOWN: 'signupRefused'
};

export function signupRefusalKey(code: string | null | undefined): string {
  return (code && SIGNUP_REFUSAL_KEYS[code]) || SIGNUP_REFUSAL_KEYS.UNKNOWN;
}
```

- [ ] **Step 5 : Écrire les traductions**

Dans `frontend/src/lib/i18n/translations.ts`, sous `// Home page` du bloc `en` :

```ts
    // Invitation à rejoindre la plateforme
    signupInviteOnly: 'psnes is invitation-only',
    signupInviteOnlyHint: 'Ask a player who is already here for their invitation link.',
    signupInviteValid: 'Your invitation is valid. Sign in to claim your place.',
    signupAlreadySignedIn: 'You already have an account on this device.',
    signupPlatformFull: 'psnes is full for now. Every place is taken.',
    signupInviteUnknown: 'This invitation link is not one of ours.',
    signupInviteRevoked: 'This invitation was withdrawn by the player who sent it.',
    signupInviteUsed: 'This invitation has already been used.',
    signupQuotaExhausted: 'The player who invited you has no places left.',
    signupTooManyAttempts: 'Too many attempts. Try again later.',
    signupRefused: 'Your invitation could not be accepted.',
```

Et le miroir exact dans le bloc `fr` :

```ts
    // Invitation à rejoindre la plateforme
    signupInviteOnly: 'psnes se joue sur invitation',
    signupInviteOnlyHint: 'Demandez son lien d\'invitation à un joueur déjà présent.',
    signupInviteValid: 'Votre invitation est valide. Connectez-vous pour prendre votre place.',
    signupAlreadySignedIn: 'Vous avez déjà un compte sur cet appareil.',
    signupPlatformFull: 'psnes est complet pour le moment. Toutes les places sont prises.',
    signupInviteUnknown: 'Ce lien d\'invitation n\'est pas des nôtres.',
    signupInviteRevoked: 'Cette invitation a été retirée par le joueur qui vous l\'a envoyée.',
    signupInviteUsed: 'Cette invitation a déjà servi.',
    signupQuotaExhausted: 'Le joueur qui vous a invité n\'a plus de place à donner.',
    signupTooManyAttempts: 'Trop de tentatives. Réessayez plus tard.',
    signupRefused: 'Votre invitation n\'a pas pu être acceptée.',
```

- [ ] **Step 6 : Vérifier que les tests passent**

Run: `bun test core/test/invite-copy.test.ts core/test/i18n-parity.test.ts`
Expected: PASS.

- [ ] **Step 7 : Câbler l'accueil**

Dans `frontend/src/routes/+page.svelte`, remplacer la fonction `login()` (ligne ~475) :

```ts
  /**
   * Le code d'invitation suit le joueur jusqu'à Google.
   *
   * Lu depuis l'URL à chaque clic plutôt que mémorisé au chargement : un
   * visiteur peut coller un second lien dans la barre d'adresse sans recharger
   * la page, et c'est le dernier qui doit compter.
   */
  function login() {
    const invite = new URLSearchParams(window.location.search).get('invite');
    window.location.href = invite
      ? `/auth/google?invite=${encodeURIComponent(invite)}`
      : '/auth/google';
  }
```

Ajouter, dans le `<script>` du même fichier :

```ts
  import { signupRefusalKey } from '$lib/auth/signup-refusal';

  let inviteCode: string | null = null;
  let inviteVerdict: 'checking' | 'valid' | 'refused' | 'none' = 'none';
  let inviteMessageKey = '';

  /**
   * Le verdict est demandé au serveur avant que le visiteur clique.
   *
   * Ce n'est pas une autorisation -- la porte est reconsultée côté serveur au
   * retour de Google, et c'est elle qui fait foi. C'est ce qui évite à
   * quelqu'un de traverser tout le parcours Google pour apprendre en revenant
   * que son lien avait déjà servi.
   */
  async function checkInvite() {
    const params = new URLSearchParams(window.location.search);
    const refusedOnReturn = params.get('signupError');
    if (refusedOnReturn) {
      inviteVerdict = 'refused';
      inviteMessageKey = signupRefusalKey(refusedOnReturn);
      return;
    }

    inviteCode = params.get('invite');
    if (!inviteCode) return;

    inviteVerdict = 'checking';
    try {
      const res = await fetch(`/auth/invite/${encodeURIComponent(inviteCode)}`);
      if (res.ok) {
        inviteVerdict = 'valid';
        inviteMessageKey = 'signupInviteValid';
      } else {
        const body = await res.json().catch(() => ({}));
        inviteVerdict = 'refused';
        inviteMessageKey = signupRefusalKey(body?.error);
      }
    } catch {
      // Le serveur ne répond pas : le message existe déjà pour ce cas.
      inviteVerdict = 'refused';
      inviteMessageKey = 'authUnavailable';
    }
  }
```

Appeler `checkInvite()` dans le `onMount` existant du fichier, à côté de `loadAuthMode()`.

Dans le balisage, à l'intérieur de `.login-section` et **avant** le bouton de connexion :

```svelte
      {#if inviteVerdict === 'valid'}
        <p class="invite-note invite-note--ok">{$t(inviteMessageKey)}</p>
      {:else if inviteVerdict === 'refused'}
        <p class="invite-note invite-note--refused" role="alert">{$t(inviteMessageKey)}</p>
      {:else if inviteVerdict === 'none'}
        <p class="invite-note">
          {$t('signupInviteOnly')}<br />
          <span class="invite-note__hint">{$t('signupInviteOnlyHint')}</span>
        </p>
      {/if}
```

> Vérifier le nom réel du store de traduction dans ce fichier (`$t`, `$_`, ou un appel direct) avant de coller : ce plan ne l'a pas relu. `grep -n "i18n\|\\$t(" frontend/src/routes/+page.svelte | head`.

- [ ] **Step 8 : Vérifier le typage et le prérendu**

Run: `cd frontend && bun run check`
Expected: 0 erreur. Si des centaines d'erreurs apparaissent, c'est `.svelte-kit` qui manque : `npx svelte-kit sync` puis recommencer.

Run: `cd frontend && bun run build`
Expected: succès. Aucune route nouvelle dans cette tâche, donc `entries` ne change pas.

- [ ] **Step 9 : Commit**

```bash
git add frontend/src/lib/auth/signup-refusal.ts frontend/src/lib/i18n/translations.ts frontend/src/routes/+page.svelte core/test/invite-copy.test.ts package.json
git commit -m "Porter le lien d'invitation jusqu'à Google, et dire les refus"
```

---

## Task 7 : « Mes invitations » dans le profil

**Files:**
- Create: `frontend/src/lib/components/MyInvites.svelte`
- Modify: `frontend/src/routes/profile/+page.svelte` (montage du composant)
- Modify: `frontend/src/lib/i18n/translations.ts` (blocs `en` et `fr`)

**Interfaces:**
- Consumes: `GET /api/invites`, `POST /api/invites`, `DELETE /api/invites/:id` (Task 4).
- Produces: rien que d'autres tâches consomment.

- [ ] **Step 1 : Ajouter les traductions**

Dans les deux blocs de `frontend/src/lib/i18n/translations.ts` :

```ts
    // en
    myInvites: 'My invitations',
    invitesRemaining: 'places left to give',
    mintInvite: 'Create an invitation link',
    inviteCopy: 'Copy link',
    inviteCopied: 'Copied',
    inviteRevoke: 'Withdraw',
    inviteJoined: 'joined with this link',
    invitesNone: 'You have not invited anyone yet.',
    invitesSpent: 'You have given away both of your places.',
    invitesPlatformFull: 'psnes is full: new invitations cannot be used right now.',
    inviteMintFailed: 'The invitation could not be created.',
```

```ts
    // fr
    myInvites: 'Mes invitations',
    invitesRemaining: 'places à donner',
    mintInvite: 'Créer un lien d\'invitation',
    inviteCopy: 'Copier le lien',
    inviteCopied: 'Copié',
    inviteRevoke: 'Retirer',
    inviteJoined: 'est entré par ce lien',
    invitesNone: 'Vous n\'avez encore invité personne.',
    invitesSpent: 'Vous avez donné vos deux places.',
    invitesPlatformFull: 'psnes est complet : une nouvelle invitation ne pourrait pas servir pour l\'instant.',
    inviteMintFailed: 'Le lien n\'a pas pu être créé.',
```

- [ ] **Step 2 : Vérifier la parité**

Run: `bun test core/test/i18n-parity.test.ts`
Expected: PASS.

- [ ] **Step 3 : Écrire le composant**

Créer `frontend/src/lib/components/MyInvites.svelte`. Relire d'abord un composant voisin (`frontend/src/lib/components/FriendsList.svelte`) pour reprendre exactement sa façon d'appeler l'API et de traduire, plutôt que d'inventer une convention.

```svelte
<script lang="ts">
  /**
   * Les deux places d'un joueur.
   *
   * Le composant ne calcule pas le restant : il affiche celui que le serveur
   * annonce. Un compteur recalculé côté client dériverait du serveur au
   * premier cas limite (un lien révoqué par une autre session, un filleul
   * arrivé entre deux chargements) et donnerait un chiffre faux avec aplomb.
   */
  import { onMount } from 'svelte';

  interface InviteView {
    id: string; code: string; url: string;
    usedAt: string | null; inviteePseudo: string | null;
  }

  let quota = 0;
  let remaining = 0;
  let platformFull = false;
  let invites: InviteView[] = [];
  let loading = true;
  let error = '';
  let copied: string | null = null;

  async function load() {
    loading = true;
    error = '';
    try {
      const res = await fetch('/api/invites', { credentials: 'include' });
      if (!res.ok) throw new Error(String(res.status));
      const body = await res.json();
      quota = body.quota;
      remaining = body.remaining;
      platformFull = body.platformFull;
      invites = body.invites;
    } catch {
      error = 'inviteMintFailed';
    } finally {
      loading = false;
    }
  }

  async function mint() {
    error = '';
    const res = await fetch('/api/invites', { method: 'POST', credentials: 'include' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      error = body?.error === 'PLATFORM_FULL' ? 'invitesPlatformFull' : 'inviteMintFailed';
      return;
    }
    await load();
  }

  async function revoke(id: string) {
    await fetch(`/api/invites/${id}`, { method: 'DELETE', credentials: 'include' });
    await load();
  }

  async function copy(invite: InviteView) {
    await navigator.clipboard.writeText(invite.url);
    copied = invite.id;
    setTimeout(() => { if (copied === invite.id) copied = null; }, 2000);
  }

  onMount(load);
</script>
```

Le balisage : un titre `myInvites`, la ligne « `remaining` / `quota` `invitesRemaining` », le bouton `mintInvite` désactivé quand `remaining === 0` ou `platformFull`, puis la liste — chaque lien avec son bouton copier ; les liens consommés affichent `inviteePseudo` + `inviteJoined` au lieu des boutons. `invitesNone` quand la liste est vide, `invitesSpent` quand `remaining === 0`.

- [ ] **Step 4 : Monter le composant dans le profil**

Dans `frontend/src/routes/profile/+page.svelte`, importer `MyInvites` et le placer après la section du handle (repérer la section existante avec `grep -n "discriminator\|handle" frontend/src/routes/profile/+page.svelte`).

- [ ] **Step 5 : Vérifier**

Run: `cd frontend && bun run check`
Expected: 0 erreur.

Run: `cd frontend && bun run build`
Expected: succès — `/profile` est déjà dans `entries`.

- [ ] **Step 6 : Commit**

```bash
git add frontend/src/lib/components/MyInvites.svelte frontend/src/routes/profile/+page.svelte frontend/src/lib/i18n/translations.ts
git commit -m "Montrer à chaque joueur les deux places qu'il a à donner"
```

---

## Task 8 : Le déploiement, et le contrôle dans une vraie pile

**Files:**
- Modify: `backend/.env.example`
- Modify: `docker-compose.yml` (service `backend`, bloc `environment`)
- Modify: `docker-compose.prod.yml` (même bloc)
- Modify: `ARCHITECTURE.md`

**Interfaces:** aucune.

- [ ] **Step 1 : Déclarer la variable**

Dans `backend/.env.example`, après le bloc `# Authentication Mode` :

```
# Le nombre maximum de comptes sur la plateforme. Les invités anonymes venus
# par un lien de salon ne comptent pas. Une valeur illisible retombe sur 100
# plutôt que d'ouvrir la plateforme en grand.
MAX_USERS=100
```

Dans `docker-compose.yml` et `docker-compose.prod.yml`, dans `environment` du service `backend` :

```yaml
      # Le plafond de comptes. Passé depuis l'hôte pour qu'il puisse monter
      # sans redéploiement d'image.
      - MAX_USERS=${MAX_USERS:-100}
```

- [ ] **Step 2 : Documenter la porte**

Dans `ARCHITECTURE.md`, ajouter une section « L'entrée sur la plateforme » : l'invitation obligatoire, le quota de 2 à vie, le plafond `MAX_USERS`, le fait que la porte anonyme est inchangée, et la commande `bun src/db/invite-cli.ts`.

- [ ] **Step 3 : Monter la pile et vérifier en vrai**

Suivre la recette de la mémoire « Running the app from a worktree ». Points obligatoires depuis ce worktree :

```bash
ln -s /home/pleymor/projects/psnes-repos/psnes/node_modules node_modules
ln -s /home/pleymor/projects/psnes-repos/psnes/node_modules backend/node_modules
mkdir -p frontend/node_modules
docker run -d --rm -p 6399:6379 redis:7-alpine
```

Backend **sur le port 3000** (le client code `http://${hostname}:3000` en dur dans `frontend/src/lib/api/socket.ts`), avec `FRONTEND_URL=http://localhost:5276`, `AUTH_MODE=dev`, `REDIS_PORT=6399`, `MAX_USERS=3`, et la base migrée par `bun src/db/migrate-cli.ts`.

Front sur **5276**, via un `frontend/vite.worktree.config.ts` jetable qui met `server.port: 5276`, `cacheDir` dans le scratchpad, et `server.fs.allow` sur le checkout principal.

- [ ] **Step 4 : Le parcours, à la main**

1. `/auth/dev/login` en tant qu'utilisateur 1, ouvrir `/profile` : deux places, aucun lien.
2. Frapper un lien, le copier.
3. Se déconnecter, ouvrir le lien : l'accueil dit « invitation valide ».
4. Ouvrir l'accueil **sans** `?invite=` : l'accueil dit « psnes se joue sur invitation ».
5. Frapper le deuxième lien, tenter le troisième : refusé, `QUOTA_EXHAUSTED`.
6. Révoquer un lien vivant, vérifier que la place revient.
7. `MAX_USERS=3` avec 3 comptes : un lien valide doit rendre `PLATFORM_FULL`.
8. `bun src/db/invite-cli.ts grant DevOne#0001` : un lien de plus, quota inchangé.

> Le chemin Google lui-même n'est pas testable ici (`AUTH_MODE=dev`, et Google refuse `localhost:5276` comme URI de redirection). C'est la limite connue de ce contrôle : `signup-flow.test.ts` couvre la décision, l'appel réel à `passport.authenticate` ne l'est que par la vérification en production.

- [ ] **Step 5 : La suite complète**

Run: `bun run test:all`
Expected: PASS. Noter le **total** de tests, pas seulement la couleur.

- [ ] **Step 6 : Commit**

```bash
git add backend/.env.example docker-compose.yml docker-compose.prod.yml ARCHITECTURE.md
git commit -m "Déclarer le plafond de comptes et documenter la porte"
```

---

## Auto-relecture

**Couverture de la spec (chantier 1)**

| Exigence de la spec | Tâche |
|---|---|
| Table `SignupInvite`, dates en ms epoch, `SET NULL` sur le filleul | 1 |
| `restant = 2 − compte(grantedByCli = 0 et revokedAt IS NULL)` | 1 (`countChargedInvites`) |
| Liens sans expiration, révocables | 1 |
| `MAX_USERS`, anonymes non comptés, vérifié à la consommation | 1, 3, 4 |
| Ordre des refus, `PLATFORM_FULL` en premier | 2 |
| Google par la même porte, `googleId` connu exempté | 3 |
| `GET`/`POST`/`DELETE /api/invites` | 4 |
| `GET /auth/invite/:code` limité par IP | 3 (limite), 4 (route) |
| CLI hors quota | 5 |
| Accueil : `?invite=`, refus lisibles | 6 |
| Profil : « Mes invitations » | 7 |
| `.env`, compose, documentation | 8 |

**Non couvert par ce plan, et c'est voulu** : `INVITE_HELD`, `PendingSignup`, `Credential`, le mailer, `PASSWORD_AUTH`, les routes `/signup` `/login` `/reset`. Tout cela appartient au chantier 2.

**Deux endroits que ce plan n'a pas relus, et qu'il signale plutôt que de deviner** :
- le nom du store de traduction dans `+page.svelte` (Task 6, Step 7) ;
- l'existence d'un découpeur de handle dans `utils/pseudo.ts` (Task 5, Step 3).

Les deux sont des `grep` d'une ligne, posés en étape explicite.

**Cohérence des types** : `SignupInvite` porte les mêmes champs de la Task 1 à la Task 7 ; `countChargedInvites` s'appelle ainsi partout ; `signupDoorDecision` reçoit `inviterCharged` et jamais `inviterQuota` ; les codes de refus de `SignupRefusal` (Task 2) sont exactement ceux de `SIGNUP_REFUSAL_KEYS` (Task 6), et le test de la Task 6 échoue si l'un des deux bouge.
