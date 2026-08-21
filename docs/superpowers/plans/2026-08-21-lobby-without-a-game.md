# Plan — un salon avant le jeu

> **Pour les exécutants :** SOUS-COMPÉTENCE REQUISE — utiliser superpowers:subagent-driven-development pour exécuter ce plan tâche par tâche. Les étapes sont des cases à cocher.

**But :** un salon peut exister avant qu'un jeu soit choisi ; on y invite un ami, l'un ou l'autre choisit le jeu et lance, et celui qui lance détient les sauvegardes.

**Architecture :** `gameId` et `gameTitle` deviennent optionnels sur `Room` plutôt que d'introduire une entité `Lobby`, parce que `Room` sait déjà faire l'appartenance, la présence, la persistance et la reprise après reconnexion. Les dix sites qui exigent un jeu passent par un accesseur unique. Les invitations sont persistées dans une table neuve, avec une machine à états pure dont l'horloge est un paramètre.

**Pile :** TypeScript, better-sqlite3 sans ORM, Socket.IO, SvelteKit 1 / Svelte 4, tests `node:test` via tsx.

**Spec :** `docs/superpowers/specs/2026-08-21-lobby-without-a-game-design.md`

## Contraintes globales

- **Indentation :** `backend/src/**` et `backend/test/**` en **deux espaces**. `frontend/src/lib/**/*.ts` en **tabulations**. `core/test/**` en deux espaces. Suivre le fichier qu'on touche.
- **Aucune dépendance runtime nouvelle.**
- **La migration ne contient aucun `PRAGMA`** : le runner refuse une migration qui en contient (`backend/test/migrate.test.ts:130`). Elle est **additive** — création de table seulement, aucune réécriture de données.
- **Jamais `Date.now()` dans la machine à états des invitations.** L'instant est un paramètre. Sans ça aucun test ne peut faire vieillir une invitation, et l'expiration est ce qu'il faut prouver.
- **`requireGame` ne doit PAS être appliqué à `backend/src/websocket/room-view.ts`.** Décrire un salon sans jeu est la raison d'être de ce fichier ; y refuser rendrait le salon inaffichable entre sa création et le choix du jeu.
- **Base de référence à ne pas régresser :** `npm run test:all` donne 37 / 11 / 112 / 66 sans échec ; `npm run check --workspace frontend` donne 0 erreur et 16 avertissements ; **`npm run build --workspace frontend` sort en 0**.
- **Le build fait partie de chaque contrôle**, pas seulement du dernier. Sur le morceau A la branche a passé six tâches en vert alors qu'elle ne compilait pas, parce que ni `check` ni les tests n'appellent le bundler — et le déploiement, c'est `vite build`.
- `export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH"` avant tout `npm`.

---

### Task 1 — les trois décisions pures

**Fichiers :**
- Créer : `backend/src/rooms/require-game.ts`
- Créer : `backend/src/rooms/invitation-state.ts`
- Créer : `backend/src/rooms/rom-availability.ts`
- Créer : `backend/test/lobby.test.ts`

**Interfaces :**
- Consomme : le type `Room` de `backend/src/types/index.ts`.
- Produit : `requireGame`, `invitationState`, `romAvailability` — les trois seules choses de ce plan qu'un test peut fixer sans navigateur ni socket.

`backend/test/*.test.ts` est pris par un glob dans `test:backend`, donc **aucun `package.json` à modifier**.

- [ ] **Étape 1 : écrire les tests d'abord**

Dans `backend/test/lobby.test.ts` :

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { requireGame } from '../src/rooms/require-game.js';
import { invitationState } from '../src/rooms/invitation-state.js';
import { romAvailability } from '../src/rooms/rom-availability.js';

const T0 = new Date('2026-08-21T12:00:00Z');
const plus = (ms: number) => new Date(T0.getTime() + ms);

test('requireGame rend le jeu quand il y en a un', () => {
  assert.deepEqual(requireGame({ gameId: 'g1', gameTitle: 'Chrono Trigger' }), {
    gameId: 'g1',
    gameTitle: 'Chrono Trigger'
  });
});

test('requireGame refuse un salon sans jeu', () => {
  assert.equal(requireGame({}), null);
});

test('requireGame refuse un jeu à moitié renseigné', () => {
  // Un identifiant sans titre est un état que rien ne devrait produire, donc
  // le laisser passer masquerait un bug ailleurs plutôt que de le révéler.
  assert.equal(requireGame({ gameId: 'g1' }), null);
  assert.equal(requireGame({ gameTitle: 'Chrono Trigger' }), null);
});

test('une invitation fraîche est en attente', () => {
  assert.equal(invitationState({ status: 'pending', expiresAt: plus(600_000) }, T0), 'pending');
});

test('une invitation acceptée le reste, même après son délai', () => {
  // L'état enregistré gagne : une invitation déjà acceptée ne doit pas
  // devenir expirée parce qu'on la relit plus tard.
  const accepted = { status: 'accepted' as const, expiresAt: plus(-1) };
  assert.equal(invitationState(accepted, plus(600_000)), 'accepted');
});

test('une invitation refusée le reste', () => {
  assert.equal(invitationState({ status: 'declined', expiresAt: plus(600_000) }, T0), 'declined');
});

test('une invitation en attente devient expirée passé son délai', () => {
  assert.equal(invitationState({ status: 'pending', expiresAt: plus(1) }, plus(2)), 'expired');
});

test('une invitation expire à la seconde exacte, pas après', () => {
  // La limite est celle qui se trompe : à l'instant pile, elle est expirée.
  const at = plus(600_000);
  assert.equal(invitationState({ status: 'pending', expiresAt: at }, at), 'expired');
});

test('la ROM est possédée quand le joueur a la ligne', () => {
  assert.equal(romAvailability({ gameCrc32: 'abc', playerOwnsChecksum: true }), 'has');
});

test('la ROM manque quand le joueur ne l a pas', () => {
  assert.equal(romAvailability({ gameCrc32: 'abc', playerOwnsChecksum: false }), 'missing');
});

test('sans checksum enregistré la réponse est inconnue, pas manquante', () => {
  // La colonne crc32 de Game est nullable. Dire "ne l'a pas" ici serait faux.
  assert.equal(romAvailability({ gameCrc32: undefined, playerOwnsChecksum: false }), 'unknown');
});

test('sans jeu choisi la réponse est inconnue', () => {
  assert.equal(romAvailability({ gameCrc32: null, playerOwnsChecksum: false }), 'unknown');
});
```

- [ ] **Étape 2 : les lancer et voir qu'ils échouent**

```bash
export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH"
node --import tsx --test backend/test/lobby.test.ts
```

Attendu : échec sur les modules introuvables.

- [ ] **Étape 3 : écrire les trois modules**

`backend/src/rooms/require-game.ts` :

```ts
/**
 * Le jeu d'un salon, ou rien.
 *
 * Depuis qu'un salon peut exister avant qu'un jeu soit choisi, dix
 * gestionnaires d'événements socket - sauvegardes, slots, SRAM - n'ont plus de
 * garantie que `room.gameId` existe. Ils passent tous par ici plutôt que de
 * répéter le même `if` dix fois : une garde répétée dix fois sera oubliée à la
 * onzième, et un accesseur unique est une fonction que le test fixe.
 *
 * Ne pas utiliser dans `room-view.ts`. Décrire un salon sans jeu est
 * exactement ce que la vue doit savoir faire.
 */
export interface GameOfRoom {
  gameId: string;
  gameTitle: string;
}

export function requireGame(room: { gameId?: string; gameTitle?: string }): GameOfRoom | null {
  if (!room.gameId || !room.gameTitle) return null;
  return { gameId: room.gameId, gameTitle: room.gameTitle };
}
```

`backend/src/rooms/invitation-state.ts` :

```ts
/**
 * L'état réel d'une invitation, qui n'est pas toujours celui qu'on a stocké.
 *
 * `expired` n'est jamais écrit en base au moment où ça arrive - personne ne
 * regarde. Il se calcule à la lecture, en comparant le délai à un instant
 * qu'on reçoit. L'instant est un paramètre et non `Date.now()` : sans ça,
 * aucun test ne peut faire vieillir une invitation, et l'expiration est
 * précisément ce qu'il faut prouver.
 */
export type InvitationStatus = 'pending' | 'accepted' | 'declined';
export type InvitationState = InvitationStatus | 'expired';

export function invitationState(
  invitation: { status: InvitationStatus; expiresAt: Date },
  now: Date
): InvitationState {
  // Un état déjà décidé gagne : relire une invitation acceptée plus tard ne
  // doit pas la transformer en expirée.
  if (invitation.status !== 'pending') return invitation.status;
  return invitation.expiresAt.getTime() <= now.getTime() ? 'expired' : 'pending';
}
```

`backend/src/rooms/rom-availability.ts` :

```ts
/**
 * Si un joueur a la ROM du jeu choisi - avec un troisième état.
 *
 * `unknown` n'est pas de la prudence décorative : la colonne `crc32` de `Game`
 * est nullable, donc un jeu enregistré sans checksum ne permet aucune
 * comparaison. Afficher « ne l'a pas » dans ce cas serait faux.
 *
 * Et ce que `has` affirme est plus étroit qu'il n'y paraît : le joueur a
 * enregistré cette ROM dans sa bibliothèque. Pas que le fichier soit
 * accessible maintenant - il vit sur sa machine, derrière une permission de
 * dossier qui peut avoir expiré. L'invite de localisation reste le filet.
 */
export type RomAvailability = 'has' | 'missing' | 'unknown';

export function romAvailability(facts: {
  gameCrc32: string | null | undefined;
  playerOwnsChecksum: boolean;
}): RomAvailability {
  if (!facts.gameCrc32) return 'unknown';
  return facts.playerOwnsChecksum ? 'has' : 'missing';
}
```

- [ ] **Étape 4 : les relancer, tout doit passer**

```bash
node --import tsx --test backend/test/lobby.test.ts
npm run test:all 2>&1 | grep -E "^# (pass|fail)"
```

- [ ] **Étape 5 : prouver que les gardes peuvent échouer**

Casser chacune, constater l'échec du test qui la vise, restaurer. Rapporter les deux chiffres pour chaque :

1. Dans `invitation-state.ts`, retirer la ligne qui rend l'état déjà décidé — le test de l'invitation acceptée doit échouer.
2. Dans `invitation-state.ts`, remplacer `<=` par `<` — le test de la seconde exacte doit échouer, et lui seul.
3. Dans `rom-availability.ts`, retirer le `if (!facts.gameCrc32)` — les deux tests `unknown` doivent échouer.

Un test qui n'échoue jamais ne protège rien. **Ne pas commiter tant que les trois n'ont pas été vus rouges puis verts.**

- [ ] **Étape 6 : commiter**

```bash
git add backend/src/rooms backend/test/lobby.test.ts
git commit -m "Decide a room's game, an invitation's real state and who has the ROM"
```

---

### Task 2 — la table des invitations

**Fichiers :**
- Créer : `backend/migrations/0002_room_invitations.sql`
- Créer : `backend/src/db/invitations.ts`
- Modifier : `backend/test/lobby.test.ts`

**Interfaces :**
- Consomme : `invitationState` (tâche 1), le helper `migratedDb()` de `backend/test/helpers.ts`.
- Produit : `createInvitation`, `findInvitationById`, `listPendingInvitationsFor`, `markInvitation`, `deleteInvitationsForRoom`.

- [ ] **Étape 1 : la migration**

Créer `backend/migrations/0002_room_invitations.sql`. **Aucun `PRAGMA`** : le runner refuse une migration qui en contient. Suivre les conventions du baseline — table entre guillemets, contraintes de clé étrangère nommées, `createdAt` avec défaut.

```sql
CREATE TABLE "RoomInvitation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "roomId" TEXT NOT NULL,
    "fromUserId" TEXT NOT NULL,
    "toUserId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    CONSTRAINT "RoomInvitation_fromUserId_fkey" FOREIGN KEY ("fromUserId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RoomInvitation_toUserId_fkey" FOREIGN KEY ("toUserId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "RoomInvitation_toUserId_status_idx" ON "RoomInvitation" ("toUserId", "status");
CREATE INDEX "RoomInvitation_roomId_idx" ON "RoomInvitation" ("roomId");
```

**Pas de clé étrangère sur `roomId`** : les salons vivent en mémoire dans une `Map`, pas en base. C'est délibéré et ça explique pourquoi une invitation peut désigner un salon disparu — voir l'étape 4.

- [ ] **Étape 2 : vérifier que la migration passe le runner et ses tests**

```bash
export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH"
npm run test:backend 2>&1 | grep -E "^# (pass|fail)|not ok"
```

Attendu : rien de rouge. `migrate.test.ts` couvre déjà « après baselining, les migrations suivantes s'appliquent » — c'est ce chemin-là qu'on vient d'emprunter. Si un test de migration casse, **s'arrêter et le rapporter** : ça voudrait dire que la table interfère avec la détection de dérive, et c'est une décision de conception, pas un détail à contourner.

- [ ] **Étape 3 : le module d'accès**

Créer `backend/src/db/invitations.ts`. Lire `backend/src/db/friendships.ts` avant d'écrire — même forme : `db.prepare(...)`, un type `Row`, un mapper, `randomUUID()` de `node:crypto`.

`InvitationStatus` **s'importe** de `../rooms/invitation-state.js` ; ne pas le redéclarer, sinon deux définitions du même vocabulaire divergeront.

Le patron, avec la partie qui compte — la conversion des dates :

```ts
import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import type { InvitationStatus } from '../rooms/invitation-state.js';

export interface Invitation {
  id: string;
  roomId: string;
  fromUserId: string;
  toUserId: string;
  status: InvitationStatus;
  createdAt: Date;
  expiresAt: Date;
}

interface InvitationRow {
  id: string;
  roomId: string;
  fromUserId: string;
  toUserId: string;
  status: string;
  // Des NOMBRES : ce dépôt stocke les dates en millisecondes epoch. Voir
  // `FriendshipRow` dans friendships.ts, qui déclare `createdAt: number` et
  // écrit `Date.now()`. Déclarer `string` ici typecheckerait sans broncher et
  // produirait une comparaison de temps fausse en silence.
  createdAt: number;
  expiresAt: number;
}

/**
 * Les repasser en `Date` ici et nulle part ailleurs : `invitationState`
 * compare des instants, et un nombre ou une chaîne qui lui arrive à la place
 * d'une `Date` donne une comparaison silencieusement fausse plutôt qu'une
 * erreur.
 */
function toInvitation(row: InvitationRow): Invitation {
  return {
    id: row.id,
    roomId: row.roomId,
    fromUserId: row.fromUserId,
    toUserId: row.toUserId,
    status: row.status as InvitationStatus,
    createdAt: new Date(row.createdAt),
    expiresAt: new Date(row.expiresAt)
  };
}

export function createInvitation(
  db: Database, roomId: string, fromUserId: string, toUserId: string, expiresAt: Date
): Invitation {
  const id = randomUUID();
  // `createdAt` est écrit EXPLICITEMENT, jamais laissé au DEFAULT
  // CURRENT_TIMESTAMP de la table : ce défaut insérerait du texte là où tout
  // le reste du dépôt met des millisecondes epoch, et SQLite étant typé
  // dynamiquement personne ne s'en plaindrait avant que la comparaison de
  // dates soit fausse.
  db.prepare(
    `INSERT INTO "RoomInvitation" (id, roomId, fromUserId, toUserId, status, createdAt, expiresAt)
     VALUES (?, ?, ?, ?, 'pending', ?, ?)`
  ).run(id, roomId, fromUserId, toUserId, Date.now(), expiresAt.getTime());
  const created = findInvitationById(db, id);
  if (!created) throw new Error('the invitation vanished between insert and read');
  return created;
}

export function findInvitationById(db: Database, id: string): Invitation | null {
  const row = db.prepare(`SELECT * FROM "RoomInvitation" WHERE id = ?`)
    .get(id) as InvitationRow | undefined;
  return row ? toInvitation(row) : null;
}
```

Les trois restantes suivent le même moule :

```ts
```ts
/** Les invitations encore en attente pour ce joueur, les plus récentes d'abord. */
export function listPendingInvitationsFor(db: Database, userId: string): Invitation[];

export function markInvitation(db: Database, id: string, status: InvitationStatus): void;

/** Appelée quand un salon meurt : ses invitations n'ont plus de cible. */
export function deleteInvitationsForRoom(db: Database, roomId: string): void;
```

`listPendingInvitationsFor` filtre sur `status = 'pending'` en SQL et trie par `createdAt DESC`. Elle ne filtre **pas** l'expiration : c'est `invitationState` qui la calcule, et dupliquer la règle en SQL ferait deux endroits à corriger le jour où le délai change.

- [ ] **Étape 4 : les tests d'accès**

Ajouter à `backend/test/lobby.test.ts`, avec `migratedDb()` et `insertUser()` de `backend/test/helpers.ts`. Couvrir :

1. Une invitation créée se relit avec les mêmes champs, et ses dates sont bien des `Date` — pas des nombres. **Ce test est celui qui compte** : une date restée en nombre fait échouer la comparaison de `invitationState` sans rien casser visiblement. Vérifier `instanceof Date` et l'égalité de `getTime()` avec ce qui a été passé, pas seulement la vérité de la valeur.
2. `listPendingInvitationsFor` ne rend pas celles marquées acceptées ou refusées.
3. `markInvitation` change l'état, et `findInvitationById` le voit.
4. `deleteInvitationsForRoom` supprime celles de ce salon et **laisse celles des autres salons**.
5. Une invitation dont le salon a disparu : la table n'a pas de clé étrangère sur `roomId`, donc la ligne survit — le test fixe ce comportement pour que personne ne « corrige » en ajoutant une contrainte impossible.

- [ ] **Étape 5 : vérifier, puis commiter**

```bash
npm run test:all 2>&1 | grep -E "^# (pass|fail)"
npm run build --workspace frontend >/dev/null 2>&1; echo "build: $?"
git add backend/migrations/0002_room_invitations.sql backend/src/db/invitations.ts backend/test/lobby.test.ts
git commit -m "Store invitations, and let one outlive the room it points at"
```

---

### Task 3 — le jeu devient optionnel

**Fichiers :**
- Modifier : `backend/src/types/index.ts`
- Modifier : `backend/src/websocket/game-handlers.ts` (les 10 sites)
- Modifier : `backend/src/websocket/room-view.ts` (laisser passer, ne pas garder)

**Interfaces :**
- Consomme : `requireGame` (tâche 1).
- Produit : un `Room` dont `gameId` et `gameTitle` sont optionnels.

- [ ] **Étape 1 : rendre les champs optionnels**

Dans `backend/src/types/index.ts`, `Room.gameId` et `Room.gameTitle` passent à `gameId?: string` et `gameTitle?: string`. Compiler tout de suite pour obtenir la liste réelle des sites à traiter :

```bash
export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH"
npx tsc --noEmit -p backend/tsconfig.json 2>&1 | head -30
```

Le compilateur est la liste de courses. **Ne pas se fier au décompte de la spec** — il a été fait à un instant donné et le code a pu bouger. S'il trouve un site que ce plan ne mentionne pas, le traiter selon la même règle et le signaler dans le rapport.

- [ ] **Étape 2 : les dix sites qui refusent**

Dans `game-handlers.ts`, chaque gestionnaire qui a besoin du jeu commence par :

```ts
    const game = requireGame(room);
    if (!game) {
      socket.emit('error', { message: 'No game has been chosen in this room yet.' });
      return;
    }
```

puis utilise `game.gameId` au lieu de `room.gameId`. **Ne pas** écrire `room.gameId!` : l'assertion non-nulle est exactement ce que cet accesseur existe pour éviter, et elle transforme un refus propre en plantage.

Regarder comment les gestionnaires voisins signalent déjà une erreur au client avant de choisir la forme de l'émission — suivre la convention du fichier plutôt que celle de ce plan si elles diffèrent, et le dire dans le rapport.

- [ ] **Étape 3 : `room-view.ts` laisse passer**

Les deux sites de `room-view.ts` transmettent `gameId` et `gameTitle` tels quels, `undefined` compris. **Ne pas y mettre `requireGame`.** Un client doit pouvoir afficher un salon entre sa création et le choix du jeu ; refuser ici rendrait cet écran impossible.

Ajouter un commentaire court disant pourquoi la garde est absente ici alors qu'elle est partout ailleurs, sinon une prochaine revue la « corrigera ».

- [ ] **Étape 4 : vérifier**

```bash
npx tsc --noEmit -p backend/tsconfig.json && echo "backend OK"
npm run test:all 2>&1 | grep -E "^# (pass|fail)"
npm run check --workspace frontend 2>&1 | tail -2
npm run build --workspace frontend >/dev/null 2>&1; echo "build: $?"
grep -rn "room\.gameId!\|room\.gameTitle!" backend/src && echo "ECHEC: une assertion non-nulle subsiste" || echo "aucune assertion non-nulle"
```

- [ ] **Étape 5 : commiter**

```bash
git commit -am "Let a room exist before its game, and refuse the ten things that need one"
```

---

### Task 4 — le vocabulaire du salon

**Fichiers :**
- Modifier : `backend/src/websocket/room-handlers.ts`
- Modifier : `backend/src/websocket/index.ts` (livraison des invitations à la connexion)

**Interfaces :**
- Consomme : les modules des tâches 1 et 2, `findFriendshipBetween` (`backend/src/db/friendships.ts:138`), `getUserSocket` (déjà passé aux gestionnaires), `findChecksumOfOwnedGame` (`backend/src/db/games.ts:223`).
- Produit : `room:create` sans jeu, `room:choose-game`, `lobby:invite`, `lobby:accept`, `lobby:decline`, `lobby:invitations`.

- [ ] **Étape 1 : `room:create` accepte l'absence de jeu**

Son type de charge utile devient `{ gameId?: string; gameTitle?: string; gameCoverUrl?: string; autoStart?: boolean; emulationMode?: EmulationMode }`.

**Le solo ne change pas** : `autoStart` continue de mettre le statut à `playing` (aujourd'hui `room-handlers.ts:50` et `:65`). Mais `autoStart` sans jeu n'a aucun sens — refuser cette combinaison explicitement plutôt que de démarrer un salon vide en `playing`.

- [ ] **Étape 2 : `room:choose-game`**

```ts
socket.on('room:choose-game', (data: { roomId: string; gameId: string; gameTitle: string }) => { ... })
```

Règles, dans cet ordre :
1. L'émetteur doit être membre du salon. Sinon, refus.
2. Le salon doit être en `waiting`. On ne change pas de jeu en pleine partie.
3. Le checksum vient de la bibliothèque du **serveur**, pas de la charge utile : `findChecksumOfOwnedGame(getDb(), data.gameId, user.id)`. Le commentaire déjà présent dans `room:create` explique pourquoi — le reprendre plutôt que de le réinventer.
4. Diffuser la nouvelle vue du salon aux deux joueurs.

Révocable : appeler `room:choose-game` plusieurs fois avant le lancement est un usage normal, pas une erreur.

- [ ] **Étape 3 : `lobby:invite`**

```ts
socket.on('lobby:invite', (data: { roomId: string; friendId: string }) => { ... })
```

Règles :
1. L'émetteur est membre du salon.
2. `findFriendshipBetween(db, user.id, data.friendId)` existe et est acceptée. On n'invite pas un inconnu.
3. Le salon n'est pas déjà plein (deux joueurs).
4. Créer l'invitation avec `expiresAt` à **dix minutes**.
5. Si `getUserSocket(data.friendId)` rend un socket, lui émettre l'invitation tout de suite. Sinon elle attend : c'est tout l'intérêt de la persister.

- [ ] **Étape 4 : `lobby:accept` et `lobby:decline`**

`lobby:accept { invitationId }` :
1. L'invitation existe et son `toUserId` est l'émetteur. Sinon, refus — sans révéler si elle existe pour quelqu'un d'autre.
2. `invitationState(invitation, new Date())` doit valoir `pending`. **C'est ici que l'instant réel entre dans le système** ; la fonction reste pure et c'est l'appelant qui lit l'horloge.
3. **Le salon doit encore exister dans la `Map`.** Un salon vide est supprimé (`room-handlers.ts:307-313`), donc une invitation peut parfaitement désigner un salon mort bien avant ses dix minutes. Refuser avec un message qui le dit, et marquer l'invitation.
4. Rejoindre en réutilisant le chemin de `room:join` — ne pas dupliquer l'ajout de joueur, la diffusion et l'attribution de port.

`lobby:decline { invitationId }` marque l'invitation et prévient l'invitant s'il est connecté.

- [ ] **Étape 5 : livrer les invitations en attente à la connexion**

À la connexion d'un socket authentifié, émettre `lobby:invitations` avec `listPendingInvitationsFor`, **filtrées par `invitationState`** pour ne pas envoyer des invitations expirées, et **par l'existence du salon** pour ne pas en envoyer vers des salons morts.

Chercher où les autres états initiaux sont poussés à la connexion et suivre le même endroit.

- [ ] **Étape 6 : nettoyer quand un salon meurt**

Là où un salon vide est supprimé (`room-handlers.ts:307-313`), appeler `deleteInvitationsForRoom`. Le nettoyage sert à ne pas accumuler des lignes ; la justesse, elle, vient du contrôle de l'étape 4 point 3 — les deux sont nécessaires et aucun ne remplace l'autre.

- [ ] **Étape 7 : vérifier et commiter**

```bash
npx tsc --noEmit -p backend/tsconfig.json && echo "backend OK"
npm run test:all 2>&1 | grep -E "^# (pass|fail)"
npm run build --workspace frontend >/dev/null 2>&1; echo "build: $?"
git commit -am "Create a room, invite a friend, choose the game together"
```

---

### Task 5 — qui a la ROM

**Fichiers :**
- Modifier : `backend/src/websocket/room-view.ts`

**Interfaces :**
- Consomme : `romAvailability` (tâche 1), `findGameByChecksum` (`backend/src/db/games.ts:135`).
- Produit : un `rom: 'has' | 'missing' | 'unknown'` par joueur dans la vue.

- [ ] **Étape 1 : calculer côté serveur**

Pour chaque joueur de la vue, ajouter `rom`, calculé avec `romAvailability({ gameCrc32: room.gameCrc32, playerOwnsChecksum: findGameByChecksum(db, player.userId, room.gameCrc32) !== null })`.

Ne pas demander au client s'il a la ROM : c'est une question à laquelle il répondrait sur son honneur.

Attention au coût : c'est une requête par joueur à chaque construction de vue, et la vue est diffusée souvent. Deux joueurs, une requête indexée sur `(userId, crc32)` — acceptable. **Si le profilage dit le contraire, le signaler plutôt que d'inventer un cache.**

- [ ] **Étape 2 : vérifier et commiter**

```bash
npx tsc --noEmit -p backend/tsconfig.json && echo "backend OK"
npm run test:all 2>&1 | grep -E "^# (pass|fail)"
git commit -am "Say who has the ROM, from the server's own records"
```

---

### Task 6 — l'écran du salon

**Fichiers :**
- Modifier : `frontend/src/routes/room/[id]/+page.svelte`
- Modifier : `frontend/src/lib/components/TopBar.svelte` (les invitations reçues)
- Modifier : `frontend/src/lib/i18n/translations.ts`
- Modifier : `frontend/src/routes/+page.svelte` (le bouton « créer un salon »)

**Interfaces :** consomme les événements de la tâche 4 et le `rom` de la tâche 5.

- [ ] **Étape 1 : créer un salon depuis la bibliothèque**

Un bouton « créer un salon » qui émet `room:create` **sans jeu** et navigue vers `/room/<id>`. Il ne remplace pas ▶ sur un jeu, qui reste le chemin du solo.

- [ ] **Étape 2 : l'écran d'attente**

Dans la page de salle, quand il n'y a pas de jeu : afficher les joueurs présents, un choix de jeu depuis sa bibliothèque, le bouton d'invitation, et le bouton de lancement **désactivé** tant qu'aucun jeu n'est choisi.

Les cinq sites qui lisent `room.gameId` dans ce fichier affichent l'attente au lieu du titre. Le sixième, dans `FriendsList.svelte`, affiche le salon sans titre de jeu.

- [ ] **Étape 3 : l'indicateur de ROM**

À côté de chaque joueur, montrer son `rom`. Trois états, trois affichages — et **`unknown` ne doit pas ressembler à `missing`**. Le libellé de `unknown` doit dire qu'on ne sait pas, pas que le joueur n'a pas le jeu.

- [ ] **Étape 4 : les invitations reçues**

Dans la barre du haut, à côté du bouton amis : les invitations en attente, avec accepter et refuser. Elles arrivent par `lobby:invitations` à la connexion et par l'événement direct ensuite.

- [ ] **Étape 5 : les chaînes**

Toute clé neuve va dans **les deux blocs de langue**. Ancrer par le contenu, jamais par un numéro de ligne — ce fichier a bougé à chaque tâche des morceaux précédents. Apostrophes typographiques (’) en français.

- [ ] **Étape 6 : vérifier et commiter**

```bash
npm run check --workspace frontend 2>&1 | tail -2
npm run build --workspace frontend >/dev/null 2>&1; echo "build: $?"
npm run test:all 2>&1 | grep -E "^# (pass|fail)"
```

Pour chaque clé ajoutée, vérifier qu'elle apparaît exactement deux fois. Rappel : `noUnusedLocals` n'est pas activé côté frontend, donc une variable oubliée ne produit **ni erreur ni avertissement** — relire son propre bloc `<script>` et rendre compte de chaque déclaration.

---

### Task 7 — l'ancienne porte se ferme

**Fichiers :**
- Modifier : `frontend/src/lib/components/FriendsList.svelte`
- Modifier : `frontend/src/routes/+page.svelte`
- Modifier : `backend/src/websocket/room-handlers.ts`

- [ ] **Étape 1 : retirer le « rejoindre le salon d'un ami »**

La liste d'amis montre aujourd'hui les salons actifs et permet de s'y inviter soi-même. Ce chemin disparaît : l'invitation devient la seule porte.

Côté serveur, `room:join` ne doit plus accepter n'importe quel membre : ou bien il exige une invitation acceptée, ou bien il ne sert plus qu'au retour d'un joueur déjà membre (reconnexion). **Lire le gestionnaire avant de choisir**, parce que la reprise après reconnexion passe par là et la casser rendrait un salon inrejoignable après une coupure réseau. Si les deux usages sont mêlés dans un seul gestionnaire, le dire dans le rapport avant de trancher.

- [ ] **Étape 2 : le balayage**

`grep` les symboles qui devraient avoir disparu, et rendre compte de chaque occurrence restante. Le contrôle automatique ne peut pas le faire : côté frontend une fonction dont le dernier appelant est parti ne produit ni erreur ni avertissement.

- [ ] **Étape 3 : vérifier et commiter**

Les trois contrôles, plus le build.

---

### Task 8 — de bout en bout, en local

**Fichiers :**
- Créer : `docs/superpowers/verification/2026-08-21-lobby-without-a-game.md`

- [ ] **Étape 1 : les contrôles mécaniques**

Capturer la sortie réelle de `test:all`, `check`, `build`, et de chaque `grep` de contrôle. Les chiffres écrits doivent être ceux qu'on a vus.

- [ ] **Étape 2 : le mode opératoire local à deux joueurs**

C'est la partie que le propriétaire a explicitement demandée. Écrire, précisément :

1. Comment lancer l'application en local (le serveur de dev tourne sur 5173, le backend sur 3000).
2. Comment être **deux joueurs différents** sur une seule machine — deux profils de navigateur ou une fenêtre privée, puisque la session est un cookie.
3. Le parcours : créer un salon vide, inviter l'autre, accepter, choisir un jeu de chaque côté à tour de rôle, voir l'indicateur de ROM, lancer depuis l'un puis depuis l'autre, et vérifier que **les sauvegardes suivent celui qui a lancé**.
4. Les chemins d'échec à essayer exprès : refuser une invitation ; laisser une invitation expirer (dix minutes, ou modifier `expiresAt` en base) ; accepter une invitation vers un salon qu'on a quitté entre-temps ; choisir un jeu que l'autre ne possède pas.
5. Ce qui ne doit **pas** avoir changé : ▶ sur un jeu lance toujours le solo directement.

- [ ] **Étape 3 : commiter**
