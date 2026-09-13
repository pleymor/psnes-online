# Lobby VR multijoueur — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Voir bouger, dans le lobby VR, l'avatar de chaque ami connecté qui a lui aussi ouvert la VR — tête et mains, pseudo au-dessus — et lire « en VR » dans les deux listes d'amis.

**Architecture :** Le repère partagé n'est pas inventé : c'est le repère local du décor, celui où `decor/placement.ts` pose ses tuyaux et où `playerAt` s'accumule depuis `e3b1250`. Chaque casque y envoie sa pose à 15 Hz sur `vr:pose` ; le serveur ne relaie rien, il écrit dans une carte, et un unique battement à 15 Hz envoie à chacun `vr:lobby` — l'instantané de ses amis présents. Toute la décision vit dans trois modules purs testables sous Bun (`roster`, `proximity`, `avatar-art`) ; le module three ne fait qu'appliquer.

**Tech Stack :** TypeScript, Bun (tests + backend), socket.io, Svelte 4, three.js, WebXR.

**Spec :** `docs/superpowers/specs/2026-09-13-vr-lobby-multijoueur-design.md`

## Global Constraints

- **Branche/worktree :** `worktree-vr-lobby-multijoueur`, basé sur `origin/main` à `8c18f79`. Ne pas rebaser en cours de route.
- **Ne jamais commiter** `frontend/vite.worktree.config.ts` ni les liens `node_modules` (racine et `backend/`). Toujours `git add` **par chemin**, jamais `git add -A`.
- **Références à battre**, mesurées sur cette base le 2026-09-13 :
  - `bun run test:ui` → **1248 pass, 1 skip, 0 fail, 1249 tests / 100 fichiers**
  - `bun run test:backend` → **385 pass, 0 fail, 385 tests / 34 fichiers**
- **Tout nouveau fichier de test frontend doit être ajouté à `test:ui`** dans `package.json`, qui énumère ses fichiers un par un. Un fichier absent de cette liste ne tourne jamais. **Vérifier le total après chaque ajout**, pas la couleur.
- **Deux langues obligatoires.** Toute clé i18n ajoutée à `frontend/src/lib/i18n/translations.ts` doit l'être en `en` **et** `fr` ; `core/test/i18n-parity.test.ts` refuse un seul des deux.
- **Tout art pixel doit être inscrit dans `ALL_ART`** (`frontend/src/lib/vr/decor/art/index.ts`). La règle est écrite dans ce fichier : « un motif qui n'est pas ici n'est ni vérifié ni rangé ».
- **Langue du code :** commentaires et messages d'erreur en français, à l'image des modules `vr/decor/*` et `vr/walk.ts`. Les commentaires expliquent *pourquoi*, pas *quoi*.
- **Commits :** français, à l'infinitif ou à l'impératif descriptif, sur le modèle de `git log` (« Faire tourner le monde autour de la tête, et marcher dans le repère du décor »). Terminer chaque message par :
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  ```
- **Ne pas pousser, ne pas ouvrir de PR** sans accord explicite du propriétaire.

---

## Structure des fichiers

**Créés**

| Fichier | Responsabilité |
|---|---|
| `frontend/src/lib/vr/lobby/roster.ts` | Le seul module qui a une horloge : accumule les instantanés, interpole, expire. Sans three. |
| `frontend/src/lib/vr/lobby/proximity.ts` | L'opacité d'un ami selon sa distance. Sans three. |
| `frontend/src/lib/vr/lobby/avatar-art.ts` | Les pixels de la tête et de la main. Sans three, sans DOM. |
| `frontend/src/lib/vr/lobby/avatars.ts` | Les maillages three. Aucune décision : il applique. |
| `backend/src/websocket/vr-lobby.ts` | La carte des poses, le cache d'amis, le battement. |
| `core/test/vr-lobby-roster.test.ts` | |
| `core/test/vr-lobby-proximity.test.ts` | |
| `core/test/vr-lobby-art.test.ts` | |
| `backend/test/vr-lobby.test.ts` | |

**Modifiés**

| Fichier | Modification |
|---|---|
| `frontend/src/lib/vr/scene.ts` | `poseInRoom()` sur `VrScene`. |
| `frontend/src/lib/vr/decor/art/index.ts` | Inscrire `avatarFace`, `avatarSide`, `avatarTop`, `avatarHand`. |
| `frontend/src/lib/vr/decor/build.ts` | Exposer `atlas` et `quadMaterial` sur `Decor`, pour que les avatars partagent la texture. |
| `frontend/src/lib/vr/panels/friends.ts` | `FriendRow.inVr`, `FriendsLabels.inVr`, la ligne d'état. |
| `frontend/src/lib/components/VrShell.svelte` | Le raccordement. |
| `frontend/src/lib/components/FriendsList.svelte` | La mention « en VR » sur la page à plat. |
| `frontend/src/lib/i18n/translations.ts` | `vrInVr` en `en` et `fr`. |
| `backend/src/services/friends.ts` | `OnlineFriend.inVr`. |
| `backend/src/websocket/index.ts` | Enregistrer `registerVrLobby`, passer la présence VR à `getOnlineFriends`. |
| `package.json` | Les trois nouveaux fichiers dans `test:ui`. |

**L'ordre est délibéré.** Les trois modules purs d'abord (1-3) : ils n'ont aucune dépendance, ils sont entièrement testables, et ils fixent les types que tout le reste consomme. Le serveur ensuite (4-5), vérifiable par de vraies sockets sans casque. `poseInRoom` et le rendu après (6-7). Le raccordement en dernier (8), parce que c'est la seule partie qu'aucun test ne couvre et qu'elle doit se poser sur des pièces déjà vertes.

---

## Task 1: `roster.ts` — accumuler, interpoler, expirer

**Files:**
- Create: `frontend/src/lib/vr/lobby/roster.ts`
- Create: `core/test/vr-lobby-roster.test.ts`
- Modify: `package.json` (script `test:ui`)

**Interfaces:**
- Consumes: rien.
- Produces:
  ```ts
  export type Pose = readonly [number, number, number, number, number, number, number];
  export interface PeerSnapshot { id: string; head: Pose; left: Pose | null; right: Pose | null; }
  export interface LobbySnapshot { peers: readonly PeerSnapshot[]; }
  export interface PeerPose { head: Pose; left: Pose | null; right: Pose | null; }
  export const INTERPOLATION_DELAY_MS = 100;
  export function createRoster(): Roster;
  export interface Roster {
    accept(snapshot: LobbySnapshot, at: number): void;
    at(now: number): ReadonlyMap<string, PeerPose>;
  }
  export function slerp(a: Pose, b: Pose, t: number): Pose;
  ```

- [ ] **Step 1: Écrire les tests qui échouent**

Créer `core/test/vr-lobby-roster.test.ts` :

```ts
/**
 * Le seul module du lobby qui a une horloge.
 *
 * Ce que ces tests gardent, et qu'aucune lecture ne garderait : le retard
 * d'interpolation (sans lui chaque tête saute six fois par seconde), le fait
 * qu'un ami absent du dernier instantané disparaisse, et le SIGNE du slerp -
 * un quaternion et son opposé décrivent la même orientation, donc interpoler
 * sans retourner le signe fait tourner un ami de 170° dans le mauvais sens.
 * Ce dernier est invisible en lisant le code et évident dans un casque.
 */
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  createRoster,
  slerp,
  INTERPOLATION_DELAY_MS,
  type Pose
} from '../../frontend/src/lib/vr/lobby/roster.js';

const IDENTITY: Pose = [0, 0, 0, 0, 0, 0, 1];

function head(x: number, y = 0, z = 0): Pose {
  return [x, y, z, 0, 0, 0, 1];
}

test('un ami inconnu apparaît dès le premier instantané, à sa pose brute', () => {
  const roster = createRoster();
  roster.accept({ peers: [{ id: 'a', head: head(1), left: null, right: null }] }, 1000);

  const shown = roster.at(1000 + INTERPOLATION_DELAY_MS);
  assert.equal(shown.size, 1);
  assert.deepEqual([...shown.get('a')!.head], [...head(1)]);
});

test('entre deux instantanés, la position est interpolée à mi-chemin', () => {
  const roster = createRoster();
  roster.accept({ peers: [{ id: 'a', head: head(0), left: null, right: null }] }, 1000);
  roster.accept({ peers: [{ id: 'a', head: head(2), left: null, right: null }] }, 1100);

  // On dessine à `now - DELAY`. Pour viser 1050, soit le milieu, il faut
  // demander 1050 + DELAY.
  const shown = roster.at(1050 + INTERPOLATION_DELAY_MS);
  assert.ok(Math.abs(shown.get('a')!.head[0] - 1) < 1e-6, `attendu 1, reçu ${shown.get('a')!.head[0]}`);
});

test("le retard d'interpolation est réel : sans lui on verrait déjà la pose la plus récente", () => {
  const roster = createRoster();
  roster.accept({ peers: [{ id: 'a', head: head(0), left: null, right: null }] }, 1000);
  roster.accept({ peers: [{ id: 'a', head: head(2), left: null, right: null }] }, 1100);

  // À l'instant 1100 SANS retard on verrait x = 2. Avec le retard, on regarde
  // 1000 : la plus ancienne des deux.
  const shown = roster.at(1100);
  assert.ok(Math.abs(shown.get('a')!.head[0] - 0) < 1e-6, `attendu 0, reçu ${shown.get('a')!.head[0]}`);
});

test('au-delà du dernier instantané, on tient la dernière pose sans extrapoler', () => {
  const roster = createRoster();
  roster.accept({ peers: [{ id: 'a', head: head(0), left: null, right: null }] }, 1000);
  roster.accept({ peers: [{ id: 'a', head: head(2), left: null, right: null }] }, 1100);

  // Très loin dans le futur : extrapoler enverrait l'ami à l'infini.
  const shown = roster.at(9000);
  assert.equal(shown.get('a')!.head[0], 2);
});

test('un ami absent du dernier instantané a quitté le lobby', () => {
  const roster = createRoster();
  roster.accept(
    {
      peers: [
        { id: 'a', head: head(0), left: null, right: null },
        { id: 'b', head: head(1), left: null, right: null }
      ]
    },
    1000
  );
  roster.accept({ peers: [{ id: 'a', head: head(0), left: null, right: null }] }, 1100);

  const shown = roster.at(1100 + INTERPOLATION_DELAY_MS);
  assert.ok(shown.has('a'));
  assert.ok(!shown.has('b'), 'b est absent du dernier instantané, donc parti');
});

test('un instantané plus ancien que le précédent est ignoré', () => {
  const roster = createRoster();
  roster.accept({ peers: [{ id: 'a', head: head(5), left: null, right: null }] }, 1100);
  roster.accept({ peers: [{ id: 'a', head: head(0), left: null, right: null }] }, 1000);

  const shown = roster.at(1100 + INTERPOLATION_DELAY_MS);
  assert.equal(shown.get('a')!.head[0], 5, "l'instantané en retard ne doit pas remonter le temps");
});

test('une main absente le reste', () => {
  const roster = createRoster();
  roster.accept({ peers: [{ id: 'a', head: head(0), left: IDENTITY, right: null }] }, 1000);

  const shown = roster.at(1000 + INTERPOLATION_DELAY_MS);
  assert.notEqual(shown.get('a')!.left, null);
  assert.equal(shown.get('a')!.right, null);
});

test("une main qui apparaît entre deux instantanés n'est pas interpolée depuis rien", () => {
  const roster = createRoster();
  roster.accept({ peers: [{ id: 'a', head: head(0), left: null, right: null }] }, 1000);
  roster.accept({ peers: [{ id: 'a', head: head(0), left: head(3), right: null }] }, 1100);

  const shown = roster.at(1050 + INTERPOLATION_DELAY_MS);
  // Interpoler depuis `null` donnerait NaN ou l'origine : la main doit
  // simplement prendre sa valeur d'arrivée.
  assert.deepEqual([...shown.get('a')!.left!], [...head(3)]);
});

test('le slerp prend le chemin court, même quand les quaternions sont de signes opposés', () => {
  // 170° autour de Y, et le MÊME angle écrit avec le quaternion opposé.
  const angle = (170 * Math.PI) / 180;
  const a: Pose = [0, 0, 0, 0, Math.sin(angle / 2), 0, Math.cos(angle / 2)];
  // L'opposé terme à terme de la partie rotation : la MÊME orientation, écrite
  // avec l'autre signe. Rien dans les nombres ne dit lequel des deux on reçoit.
  const b: Pose = [0, 0, 0, -a[3], -a[4], -a[5], -a[6]];

  const mid = slerp(a, b, 0.5);
  // a et b décrivent la MÊME orientation : toute interpolation entre eux doit
  // y rester. Sans le retournement de signe, le milieu part à l'opposé.
  const dot = mid[3] * a[3] + mid[4] * a[4] + mid[5] * a[5] + mid[6] * a[6];
  assert.ok(Math.abs(Math.abs(dot) - 1) < 1e-6, `le milieu a quitté l'orientation : dot=${dot}`);
});

test('le slerp interpole bien un demi-tour en deux quarts', () => {
  const half = Math.PI / 2;
  const a: Pose = [0, 0, 0, 0, 0, 0, 1];
  const b: Pose = [0, 0, 0, 0, Math.sin(half / 2), 0, Math.cos(half / 2)];

  const mid = slerp(a, b, 0.5);
  const quarter = Math.PI / 4;
  assert.ok(Math.abs(mid[4] - Math.sin(quarter / 2)) < 1e-6, `y=${mid[4]}`);
  assert.ok(Math.abs(mid[6] - Math.cos(quarter / 2)) < 1e-6, `w=${mid[6]}`);
});

test('le slerp rend un quaternion unitaire', () => {
  const a: Pose = [0, 0, 0, 0, 0, 0, 1];
  const angle = (120 * Math.PI) / 180;
  const b: Pose = [0, 0, 0, Math.sin(angle / 2), 0, 0, Math.cos(angle / 2)];

  const mid = slerp(a, b, 0.37);
  const norm = Math.hypot(mid[3], mid[4], mid[5], mid[6]);
  assert.ok(Math.abs(norm - 1) < 1e-6, `norme=${norm}`);
});
```

- [ ] **Step 2: Ajouter le fichier à `test:ui` et vérifier qu'il échoue**

Dans `package.json`, ajouter `core/test/vr-lobby-roster.test.ts` à la fin de la liste du script `test:ui`, juste avant `core/test/docs-content.test.ts`.

Run: `bun test core/test/vr-lobby-roster.test.ts`
Expected: FAIL — `Cannot find module '../../frontend/src/lib/vr/lobby/roster.js'`

- [ ] **Step 3: Écrire `roster.ts`**

```ts
/**
 * Qui est là, et où, à l'instant qu'on dessine.
 *
 * LE SEUL MODULE DU LOBBY QUI A UNE HORLOGE, et c'est pour ça qu'il existe
 * séparément du code qui dessine : sous Bun il n'y a ni casque ni GPU, et
 * l'arithmétique du temps est précisément ce qu'on ne peut vérifier qu'ici.
 *
 * Les instantanés arrivent à 15 Hz et on dessine à 72 ou 90. Sans
 * interpolation, chaque tête saute six fois par seconde. On garde donc les
 * DEUX derniers instantanés par ami et on dessine à `maintenant - 100 ms`,
 * entre les deux qui encadrent cet instant : un retard d'un battement et demi,
 * invisible sur une tête qui marche, et qui absorbe une image réseau perdue.
 *
 * L'HORLOGE EST L'ARRIVÉE LOCALE, jamais une estampille du serveur. Deux
 * horloges qui ne se sont jamais parlé ne peuvent pas dater le même instant,
 * et c'est aussi pourquoi `vr:lobby` ne porte aucun `t` : socket.io est sur
 * TCP, l'ordre est déjà garanti, et un champ de plus n'aurait servi qu'à
 * inviter à s'en servir.
 *
 * ON N'EXTRAPOLE PAS. Passé le dernier instantané on tient la dernière pose.
 * Extrapoler la vitesse d'une tête qui s'est tue enverrait un ami traverser le
 * décor pendant une coupure réseau, et le ramènerait d'un bond au retour.
 */

/** `[x, y, z, qx, qy, qz, qw]`, dans le repère local du décor. */
export type Pose = readonly [number, number, number, number, number, number, number];

export interface PeerSnapshot {
  id: string;
  head: Pose;
  left: Pose | null;
  right: Pose | null;
}

export interface LobbySnapshot {
  peers: readonly PeerSnapshot[];
}

export interface PeerPose {
  head: Pose;
  left: Pose | null;
  right: Pose | null;
}

/**
 * Un battement et demi, à 15 Hz.
 *
 * Pas un réglage de confort : c'est la marge qui permet d'avoir TOUJOURS deux
 * instantanés de part et d'autre de l'instant dessiné, y compris quand l'un
 * des deux s'est perdu en route.
 */
export const INTERPOLATION_DELAY_MS = 100;

export interface Roster {
  /** `at` est l'arrivée LOCALE, en millisecondes. */
  accept(snapshot: LobbySnapshot, at: number): void;
  /** `now` est l'horloge locale ; le retard est appliqué ici. */
  at(now: number): ReadonlyMap<string, PeerPose>;
}

interface Timed {
  readonly at: number;
  readonly peers: ReadonlyMap<string, PeerSnapshot>;
}

function byId(peers: readonly PeerSnapshot[]): ReadonlyMap<string, PeerSnapshot> {
  return new Map(peers.map((peer) => [peer.id, peer]));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Interpole deux orientations par l'arc le plus court.
 *
 * LE RETOURNEMENT DE SIGNE EST TOUT L'INTÉRÊT. Un quaternion et son opposé
 * décrivent la MÊME orientation, et rien dans les nombres ne dit lequel des
 * deux on a reçu. Sans le retournement, deux poses successives d'une tête qui
 * tourne de 190° peuvent arriver avec des signes opposés, et l'interpolation
 * prend alors l'arc de 170° dans l'autre sens : l'ami fait demi-tour. C'est
 * invisible en lisant et évident dans un casque.
 *
 * En deçà de `LINEAR_ENOUGH` on interpole linéairement puis on renormalise :
 * `acos` d'un produit scalaire proche de 1 perd ses chiffres, et `sin(theta)`
 * au dénominateur tend vers zéro.
 */
const LINEAR_ENOUGH = 0.9995;

export function slerp(a: Pose, b: Pose, t: number): Pose {
  const px = lerp(a[0], b[0], t);
  const py = lerp(a[1], b[1], t);
  const pz = lerp(a[2], b[2], t);

  let bx = b[3];
  let by = b[4];
  let bz = b[5];
  let bw = b[6];

  let dot = a[3] * bx + a[4] * by + a[5] * bz + a[6] * bw;
  if (dot < 0) {
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
    dot = -dot;
  }

  let qx: number;
  let qy: number;
  let qz: number;
  let qw: number;

  if (dot > LINEAR_ENOUGH) {
    qx = lerp(a[3], bx, t);
    qy = lerp(a[4], by, t);
    qz = lerp(a[5], bz, t);
    qw = lerp(a[6], bw, t);
  } else {
    const theta = Math.acos(Math.min(1, dot));
    const sinTheta = Math.sin(theta);
    const wa = Math.sin((1 - t) * theta) / sinTheta;
    const wb = Math.sin(t * theta) / sinTheta;
    qx = a[3] * wa + bx * wb;
    qy = a[4] * wa + by * wb;
    qz = a[5] * wa + bz * wb;
    qw = a[6] * wa + bw * wb;
  }

  const norm = Math.hypot(qx, qy, qz, qw) || 1;
  return [px, py, pz, qx / norm, qy / norm, qz / norm, qw / norm];
}

/**
 * Interpole deux poses, en traitant l'apparition et la disparition d'une main.
 *
 * Une main qui vient d'apparaître n'a pas de pose de départ : interpoler
 * depuis `null` donnerait l'origine, donc une manette qui jaillit du sol. Elle
 * prend sa valeur d'arrivée, et symétriquement une main qui disparaît s'en va
 * tout de suite plutôt que de fondre vers un point.
 */
function tween(from: Pose | null, to: Pose | null, t: number): Pose | null {
  if (to === null) return null;
  if (from === null) return to;
  return slerp(from, to, t);
}

export function createRoster(): Roster {
  let older: Timed | null = null;
  let newer: Timed | null = null;

  return {
    accept(snapshot, at) {
      // Un instantané plus ancien que celui qu'on tient déjà remonterait le
      // temps. Socket.io garantit l'ordre, donc c'est une ceinture ; elle
      // coûte une comparaison et évite un saut inexplicable si jamais le
      // transport change un jour.
      if (newer !== null && at <= newer.at) return;
      older = newer;
      newer = { at, peers: byId(snapshot.peers) };
    },

    at(now) {
      const shown = new Map<string, PeerPose>();
      if (newer === null) return shown;

      const when = now - INTERPOLATION_DELAY_MS;

      // La présence est décidée par le DERNIER instantané, et par lui seul :
      // un ami absent de celui-ci est parti, et il ne doit pas survivre dans
      // l'ancien le temps que l'interpolation le rattrape.
      for (const [id, target] of newer.peers) {
        const from = older?.peers.get(id) ?? null;

        // Pas de pose antérieure, pas d'intervalle, ou un instant hors de
        // l'intervalle : on montre la pose d'arrivée. C'est aussi ce qui
        // interdit d'extrapoler au-delà du dernier instantané.
        if (from === null || older === null || when >= newer.at || newer.at <= older.at) {
          shown.set(id, { head: target.head, left: target.left, right: target.right });
          continue;
        }

        const t = (when - older.at) / (newer.at - older.at);
        if (t <= 0) {
          shown.set(id, { head: from.head, left: from.left, right: from.right });
          continue;
        }

        shown.set(id, {
          head: slerp(from.head, target.head, t),
          left: tween(from.left, target.left, t),
          right: tween(from.right, target.right, t)
        });
      }

      return shown;
    }
  };
}
```

- [ ] **Step 4: Faire passer les tests**

Run: `bun test core/test/vr-lobby-roster.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Passe de mutation — prouver que les tests mordent**

Pour chacune des trois mutations ci-dessous : appliquer, constater l'échec **nommé**, restaurer.

1. Dans `slerp`, supprimer le bloc `if (dot < 0) { ... }`.
   → « le slerp prend le chemin court » doit échouer.
2. Dans `at()`, remplacer `const when = now - INTERPOLATION_DELAY_MS;` par `const when = now;`.
   → « le retard d'interpolation est réel » doit échouer.
3. Dans `at()`, itérer sur `older.peers` au lieu de `newer.peers` (avec le repli qui va bien).
   → « un ami absent du dernier instantané a quitté le lobby » doit échouer.

Si une mutation ne fait rien échouer, le test correspondant ne teste rien : le corriger avant de continuer.

- [ ] **Step 6: Vérifier le total de la suite**

Run: `bun run test:ui`
Expected: **1259 tests** (1249 + 10 nouvelles fonctions de test ; le onzième assert vit dans une fonction déjà comptée — vérifier le chiffre réellement obtenu et le noter). Si le total est resté à 1249, le fichier n'a pas été ajouté à `test:ui`.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/vr/lobby/roster.ts core/test/vr-lobby-roster.test.ts package.json
git commit -m "$(cat <<'EOF'
Tenir où sont les amis, un battement et demi en arrière

Les instantanés arrivent à 15 Hz et on dessine à 90 : sans interpolation une
tête saute six fois par seconde. Ce module garde les deux derniers et dessine
entre eux, avec un retard d'un battement et demi qui absorbe une image perdue.

L'horloge est l'arrivée locale, pas une estampille du serveur - deux horloges
qui ne se sont jamais parlé ne peuvent pas dater le même instant, et c'est
pourquoi l'instantané n'en porte pas.

Le slerp retourne le signe avant d'interpoler. Un quaternion et son opposé
décrivent la même orientation, et rien dans les nombres ne dit lequel on a
reçu : sans ce retournement, un ami qui tourne de 190° fait demi-tour sur 170.
Invisible en lisant, évident dans un casque, et attrapé ici par un test.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `proximity.ts` — s'effacer quand on gêne

**Files:**
- Create: `frontend/src/lib/vr/lobby/proximity.ts`
- Create: `core/test/vr-lobby-proximity.test.ts`
- Modify: `package.json` (script `test:ui`)

**Interfaces:**
- Consumes: `Pose` de `roster.ts`.
- Produces:
  ```ts
  export const FADE_NEAR = 0.5;
  export const FADE_FULL = 1.2;
  export interface Presence { visible: boolean; opacity: number; }
  export function presenceFor(mine: Pose, theirs: Pose): Presence;
  ```

- [ ] **Step 1: Écrire les tests qui échouent**

Créer `core/test/vr-lobby-proximity.test.ts` :

```ts
/**
 * La règle demandée : un ami trop près s'efface pour ne pas gêner.
 *
 * Elle remplace l'allocateur de places de départ qu'on n'a pas voulu : tout le
 * monde entre au même point du repère du décor, donc tout le monde se
 * chevauche pendant quelques secondes, et c'est cette règle qui fait que ça ne
 * se voit pas. Elle sert aussi au cas qui compte vraiment - un ami qui vient
 * se coller à vous.
 *
 * Le test du seuil bas garde `visible: false` et non `opacity: 0` : un objet
 * transparent invisible coûte quand même son tri, et ce dépôt a déjà payé un
 * basculement d'ordre de rendu sur une surface transparente.
 */
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  presenceFor,
  FADE_NEAR,
  FADE_FULL
} from '../../frontend/src/lib/vr/lobby/proximity.js';
import type { Pose } from '../../frontend/src/lib/vr/lobby/roster.js';

function at(x: number, y = 0, z = 0): Pose {
  return [x, y, z, 0, 0, 0, 1];
}

test('un ami lointain est entièrement solide', () => {
  const p = presenceFor(at(0), at(5));
  assert.equal(p.visible, true);
  assert.equal(p.opacity, 1);
});

test('un ami juste au-delà du seuil haut est solide', () => {
  const p = presenceFor(at(0), at(FADE_FULL + 0.01));
  assert.equal(p.visible, true);
  assert.ok(Math.abs(p.opacity - 1) < 1e-6, `opacité=${p.opacity}`);
});

test('un ami sous le seuil bas est absent, pas transparent', () => {
  const p = presenceFor(at(0), at(0.2));
  assert.equal(p.visible, false, 'un objet transparent invisible coûte encore son tri');
});

test('deux joueurs exactement superposés — le cas du départ — ne se gênent pas', () => {
  const p = presenceFor(at(0), at(0));
  assert.equal(p.visible, false);
});

test("à mi-chemin entre les deux seuils, l'opacité est à la moitié", () => {
  const middle = (FADE_NEAR + FADE_FULL) / 2;
  const p = presenceFor(at(0), at(middle));
  assert.equal(p.visible, true);
  assert.ok(Math.abs(p.opacity - 0.5) < 1e-6, `opacité=${p.opacity}`);
});

test("l'opacité croît avec la distance, sans marche d'escalier", () => {
  let previous = -1;
  for (let d = FADE_NEAR; d <= FADE_FULL; d += 0.05) {
    const p = presenceFor(at(0), at(d));
    assert.ok(p.opacity >= previous, `l'opacité a reculé à d=${d}`);
    previous = p.opacity;
  }
});

test('la distance se mesure en trois dimensions, pas seulement au sol', () => {
  // Un ami debout sur un tuyau, juste au-dessus : loin en hauteur, au même
  // point au sol. Mesurer à plat le ferait disparaître sans raison.
  const p = presenceFor(at(0, 0, 0), at(0, 2, 0));
  assert.equal(p.visible, true, "deux mètres au-dessus, c'est loin");
});

test("l'orientation n'entre pas dans le calcul", () => {
  const turned: Pose = [3, 0, 0, 0, 1, 0, 0];
  const straight: Pose = [3, 0, 0, 0, 0, 0, 1];
  assert.deepEqual(presenceFor(at(0), turned), presenceFor(at(0), straight));
});
```

- [ ] **Step 2: Ajouter à `test:ui` et vérifier l'échec**

Ajouter `core/test/vr-lobby-proximity.test.ts` au script `test:ui`.

Run: `bun test core/test/vr-lobby-proximity.test.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 3: Écrire `proximity.ts`**

```ts
/**
 * Ce qu'on montre d'un ami selon sa distance, et pourquoi on ne montre rien de
 * trop près.
 *
 * La règle vient du propriétaire, mot pour mot : « les autres deviennent
 * invisibles quand on se chevauche pour ne pas se gêner ». Elle tient la place
 * d'une décision qu'on a écartée - attribuer une place de départ côté serveur.
 * Tout le monde entre au même point du repère du décor, donc tout le monde se
 * superpose pendant quelques secondes ; trois lignes d'arithmétique règlent ça
 * sans allocateur, et règlent en prime le cas qu'aucun allocateur ne pourrait
 * régler : un ami qui vient se coller à vous.
 *
 * UN FONDU, PAS UNE BASCULE. Une disparition sèche se remarque davantage
 * qu'une transparence : l'œil attrape le changement brutal, pas le graduel.
 *
 * ET `visible: false`, PAS `opacity: 0`. Un objet transparent invisible coûte
 * encore son tri à chaque image, et ce dépôt a déjà payé un basculement
 * d'ordre de rendu sur une surface transparente. Sous le seuil, l'objet sort
 * du rendu pour de bon.
 */
import type { Pose } from './roster';

/** En deçà, l'ami n'est pas dessiné du tout. */
export const FADE_NEAR = 0.5;
/** Au-delà, il est entièrement solide. */
export const FADE_FULL = 1.2;

export interface Presence {
  visible: boolean;
  /** 0..1. Une seule valeur pour la tête, les mains ET la plaque de pseudo :
   *  un nom qui flotte sans visage est pire que pas de nom. */
  opacity: number;
}

const ABSENT: Presence = { visible: false, opacity: 0 };

export function presenceFor(mine: Pose, theirs: Pose): Presence {
  // En trois dimensions, et non à plat : un ami perché sur un tuyau est au
  // même point au sol et pourtant loin. À plat, il disparaîtrait sous nos
  // pieds sans rien gêner du tout.
  const distance = Math.hypot(theirs[0] - mine[0], theirs[1] - mine[1], theirs[2] - mine[2]);

  if (distance <= FADE_NEAR) return ABSENT;
  if (distance >= FADE_FULL) return { visible: true, opacity: 1 };

  return {
    visible: true,
    opacity: (distance - FADE_NEAR) / (FADE_FULL - FADE_NEAR)
  };
}
```

- [ ] **Step 4: Faire passer les tests**

Run: `bun test core/test/vr-lobby-proximity.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Passe de mutation**

1. Remplacer `Math.hypot(dx, dy, dz)` par `Math.hypot(dx, dz)` (à plat).
   → « la distance se mesure en trois dimensions » doit échouer.
2. Remplacer `return ABSENT;` par `return { visible: true, opacity: 0 };`.
   → « un ami sous le seuil bas est absent, pas transparent » doit échouer.

Restaurer après chaque.

- [ ] **Step 6: Vérifier le total**

Run: `bun run test:ui`
Expected: 8 tests de plus qu'à la fin de la Task 1.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/vr/lobby/proximity.ts core/test/vr-lobby-proximity.test.ts package.json
git commit -m "$(cat <<'EOF'
Effacer l'ami qui vient se coller, plutôt que lui donner une place

Tout le monde entre au même point du repère du décor, donc tout le monde se
superpose au départ. Plutôt qu'un allocateur de places côté serveur - avec le
comptoir qui ne serait plus en face en entrant - trois lignes d'arithmétique :
en deçà de cinquante centimètres l'ami n'est pas dessiné, au-delà d'un mètre
vingt il est solide, et un fondu entre les deux.

Ça règle en prime le cas qu'aucune place attribuée n'aurait réglé : quelqu'un
qui vient se planter devant vous.

Et `visible: false` plutôt qu'une opacité nulle, parce qu'un objet transparent
invisible coûte encore son tri.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `avatar-art.ts` — les pixels d'une tête et d'une main

**Files:**
- Create: `frontend/src/lib/vr/lobby/avatar-art.ts`
- Create: `core/test/vr-lobby-art.test.ts`
- Modify: `frontend/src/lib/vr/decor/art/index.ts`
- Modify: `frontend/src/lib/vr/decor/palette.ts`
- Modify: `package.json` (script `test:ui`)

**Interfaces:**
- Consumes: `Art` de `decor/pixels.ts`, `COLOURS`/`ColourName` de `decor/palette.ts`.
- Produces: `AVATAR_FACE`, `AVATAR_SIDE`, `AVATAR_TOP`, `AVATAR_HAND` (tous `Art`), inscrits dans `ALL_ART` sous les clés `avatarFace`, `avatarSide`, `avatarTop`, `avatarHand`.

**Note :** les motifs sont en 16×16, comme `GROUND_BRICK` et consorts — `ART_PIXELS_PER_METRE` vaut 16, donc une tête de 16 pixels fait un mètre à l'échelle du décor ; `avatars.ts` (Task 7) la dessine plus petite en donnant à la boîte sa taille en mètres, indépendamment du nombre de pixels.

- [ ] **Step 1: Ajouter les couleurs manquantes à la palette**

Dans `frontend/src/lib/vr/decor/palette.ts`, ajouter au `COLOURS` (avant `outline`) :

```ts
  skin: '#f8b070',
  skinShade: '#c07038',
  cap: '#d82800',
  capShade: '#a01800',
```

Ces quatre-là manquent : la palette actuelle n'a que du terrain, des tuyaux et des goombas.

- [ ] **Step 2: Écrire les tests qui échouent**

Créer `core/test/vr-lobby-art.test.ts` :

```ts
/**
 * Les motifs de l'avatar, vérifiés sans casque ni GPU.
 *
 * `vr-decor-art.test.ts` balaie déjà `ALL_ART` pour les invariants communs
 * (grille rectangulaire, tout caractère dans la palette). Ce fichier-ci garde
 * ce qui est propre à l'avatar : qu'il soit bien INSCRIT au registre - la règle
 * que `art/index.ts` énonce : « un motif qui n'est pas ici n'est ni vérifié ni
 * rangé » - et que la face avant ne soit pas symétrique gauche-droite, faute de
 * quoi on ne verrait pas de quel côté un ami regarde.
 */
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { ALL_ART } from '../../frontend/src/lib/vr/decor/art/index.js';
import { rasterise } from '../../frontend/src/lib/vr/decor/pixels.js';
import {
  AVATAR_FACE,
  AVATAR_SIDE,
  AVATAR_TOP,
  AVATAR_HAND
} from '../../frontend/src/lib/vr/lobby/avatar-art.js';

const EXPECTED = ['avatarFace', 'avatarSide', 'avatarTop', 'avatarHand'] as const;

test('les quatre motifs sont inscrits au registre', () => {
  for (const name of EXPECTED) {
    assert.ok(ALL_ART[name], `${name} absent de ALL_ART : ni vérifié ni rangé`);
  }
});

test('les faces de la tête sont carrées et de même taille', () => {
  for (const art of [AVATAR_FACE, AVATAR_SIDE, AVATAR_TOP]) {
    const raster = rasterise(art);
    assert.equal(raster.width, 16);
    assert.equal(raster.height, 16);
  }
});

test('la main tient dans la même grille', () => {
  const raster = rasterise(AVATAR_HAND);
  assert.equal(raster.width, 16);
  assert.equal(raster.height, 16);
});

test('aucun motif ne se rasterise en erreur', () => {
  for (const art of [AVATAR_FACE, AVATAR_SIDE, AVATAR_TOP, AVATAR_HAND]) {
    assert.doesNotThrow(() => rasterise(art));
  }
});

test("la face avant n'est pas symétrique : sinon on ne sait pas où l'ami regarde", () => {
  const raster = rasterise(AVATAR_FACE);
  let asymmetric = false;
  for (let y = 0; y < raster.height && !asymmetric; y++) {
    for (let x = 0; x < raster.width / 2; x++) {
      const left = (y * raster.width + x) * 4;
      const right = (y * raster.width + (raster.width - 1 - x)) * 4;
      for (let c = 0; c < 4; c++) {
        if (raster.data[left + c] !== raster.data[right + c]) {
          asymmetric = true;
          break;
        }
      }
      if (asymmetric) break;
    }
  }
  assert.ok(asymmetric, 'une tête symétrique ne dit pas de quel côté elle regarde');
});

test('la face avant est opaque partout : une tête ne doit pas être trouée', () => {
  const raster = rasterise(AVATAR_FACE);
  for (let i = 3; i < raster.data.length; i += 4) {
    assert.equal(raster.data[i], 255, `pixel transparent à l'octet ${i}`);
  }
});

test('la main a des pixels transparents : elle est découpée, pas carrée', () => {
  const raster = rasterise(AVATAR_HAND);
  let transparent = 0;
  for (let i = 3; i < raster.data.length; i += 4) {
    if (raster.data[i] === 0) transparent++;
  }
  assert.ok(transparent > 0, 'une main carrée serait un cube, pas une main');
});
```

- [ ] **Step 3: Ajouter à `test:ui` et vérifier l'échec**

Ajouter `core/test/vr-lobby-art.test.ts` au script `test:ui`.

Run: `bun test core/test/vr-lobby-art.test.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 4: Écrire `avatar-art.ts`**

```ts
/**
 * À quoi ressemble un ami : une tête, et une main.
 *
 * ON NE DESSINE QUE CE QU'ON MESURE. Le casque donne la tête, les manettes
 * donnent les mains, et rien ne donne le bassin ni les jambes. Un corps entier
 * serait plus lisible de loin et plus charmant, mais ses jambes glisseraient au
 * sol à chaque pas - le patinage, qu'aucun réglage ne rattrape parce que
 * l'information n'existe pas. Une tête et deux mains flottantes disent la
 * vérité, et c'est ce qui permettra un jour de pointer et de saluer.
 *
 * Le format est celui de `decor/pixels.ts` : une grille de caractères où un
 * caractère désigne un NOM de couleur, jamais une valeur. Diffable, modifiable
 * sans outil, et vérifiable sans GPU.
 *
 * La casquette et le regard décentré ne sont pas de la coquetterie : une tête
 * cubique symétrique ne dit pas de quel côté elle regarde, et savoir où
 * regarde un ami est la moitié de ce que cette fonctionnalité apporte.
 */
import type { Art } from '../decor/pixels';

/** La face qui porte le regard : celle tournée vers `FRONT_NORMAL` (-Z). */
export const AVATAR_FACE: Art = {
  palette: {
    c: 'cap',
    d: 'capShade',
    s: 'skin',
    h: 'skinShade',
    o: 'outline'
  },
  rows: [
    'oooooooooooooooo',
    'occcccccccccccco',
    'occcccccccccccco',
    'oddddddddddddddo',
    'osssssssssssssho',
    'osssssssssssssho',
    'ossoossoosssssho',
    'ossoossoosssssho',
    'osssssssssssssho',
    'osssshhhhsssssho',
    'osssssssssssssho',
    'osssssooooosssho',
    'osssssssssssssho',
    'ohhhhhhhhhhhhhho',
    'ohhhhhhhhhhhhhho',
    'oooooooooooooooo'
  ]
};

/** Les flancs et l'arrière : la même tête, sans visage. */
export const AVATAR_SIDE: Art = {
  palette: {
    c: 'cap',
    d: 'capShade',
    s: 'skin',
    h: 'skinShade',
    o: 'outline'
  },
  rows: [
    'oooooooooooooooo',
    'occcccccccccccco',
    'occcccccccccccco',
    'oddddddddddddddo',
    'ohhhhhhhhhhhhhho',
    'ohhsssssssssssho',
    'ohhsssssssssssho',
    'ohhsssssssssssho',
    'ohhsssssssssssho',
    'ohhsssssssssssho',
    'ohhsssssssssssho',
    'ohhsssssssssssho',
    'ohhsssssssssssho',
    'ohhhhhhhhhhhhhho',
    'ohhhhhhhhhhhhhho',
    'oooooooooooooooo'
  ]
};

/** Le dessus : la casquette, vue de haut. */
export const AVATAR_TOP: Art = {
  palette: {
    c: 'cap',
    d: 'capShade',
    o: 'outline'
  },
  rows: [
    'oooooooooooooooo',
    'occcccccccccccco',
    'occcccccccccccco',
    'occcccccccccccco',
    'occcccccccccccco',
    'occcccccccccccco',
    'occcccccccccccco',
    'occcccccccccccco',
    'occcccccccccccco',
    'occcccccccccccco',
    'occcccccccccccco',
    'oddddddddddddddo',
    'oddddddddddddddo',
    'oddddddddddddddo',
    'oddddddddddddddo',
    'oooooooooooooooo'
  ]
};

/** Une main fermée sur une manette, en quad découpé. */
export const AVATAR_HAND: Art = {
  palette: {
    s: 'skin',
    h: 'skinShade',
    o: 'outline'
  },
  rows: [
    '................',
    '................',
    '....oooooooo....',
    '...osssssssso...',
    '..osssssssssso..',
    '..osssssssssho..',
    '.osssssssssssho.',
    '.osssssssssssho.',
    '.osssssssssssho.',
    '.osssssssssssho.',
    '..osssssssssho..',
    '..ohhhhhhhhhho..',
    '...ohhhhhhhho...',
    '....oooooooo....',
    '................',
    '................'
  ]
};
```

> **Attention au dessinateur :** `rasterise` **jette** si une ligne n'a pas la
> même longueur que la ligne 0, ou si un caractère n'est pas dans la palette.
> C'est voulu (`pixels.ts` : « tout ce qui est douteux jette, et jette en
> NOMMANT le coupable »), et ça fait de l'erreur ton instrument : elle nomme la
> ligne et sa longueur. Chaque grille ci-dessus fait **exactement seize lignes
> de seize caractères** ; si tu en modifies une, recompte. Le dessin lui-même
> est un point de départ et non une contrainte — améliore-le tant que les tests
> passent, en gardant les deux propriétés qu'ils gardent : la face avant reste
> asymétrique gauche-droite (sans quoi on ne sait pas où regarde un ami) et
> entièrement opaque, et la main garde des pixels transparents (sans quoi c'est
> un cube).

- [ ] **Step 5: Inscrire les motifs au registre**

Dans `frontend/src/lib/vr/decor/art/index.ts` :

```ts
import { AVATAR_FACE, AVATAR_SIDE, AVATAR_TOP, AVATAR_HAND } from '../../lobby/avatar-art';
```

et dans `ALL_ART`, après `counterTop` :

```ts
  avatarFace: AVATAR_FACE,
  avatarSide: AVATAR_SIDE,
  avatarTop: AVATAR_TOP,
  avatarHand: AVATAR_HAND
```

- [ ] **Step 6: Faire passer les tests**

Run: `bun test core/test/vr-lobby-art.test.ts`
Expected: PASS, 7 tests.

Puis, parce que les invariants communs balaient désormais quatre motifs de plus :

Run: `bun test core/test/vr-decor-art.test.ts core/test/vr-decor-atlas.test.ts core/test/vr-decor-palette.test.ts`
Expected: PASS. Si l'atlas déborde, il grandit tout seul (`FIRST_SIZE` 256 → `MAX_SIZE` 2048) ; si un test de palette compte les couleurs, l'ajuster.

- [ ] **Step 7: Vérifier le total**

Run: `bun run test:ui`
Expected: 7 tests de plus qu'à la fin de la Task 2, et **zéro échec ailleurs**.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/lib/vr/lobby/avatar-art.ts frontend/src/lib/vr/decor/art/index.ts frontend/src/lib/vr/decor/palette.ts core/test/vr-lobby-art.test.ts package.json
git commit -m "$(cat <<'EOF'
Dessiner une tête et une main, et rien en dessous

On ne dessine que ce qu'on mesure : le casque donne la tête, les manettes
donnent les mains, et rien ne donne les jambes. Un corps entier serait plus
charmant et ses pieds glisseraient au sol à chaque pas, faute d'information -
un patinage qu'aucun réglage ne rattrape.

La face avant est volontairement asymétrique. Une tête cubique symétrique ne
dit pas de quel côté elle regarde, et savoir où regarde un ami est la moitié de
ce qu'on ajoute ici. Un test le garde.

Les quatre motifs sont inscrits dans ALL_ART, donc rangés dans l'atlas existant
et balayés par les invariants sans que ceux-ci les connaissent.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `vr-lobby.ts` côté serveur — la carte, le cache, le battement

**Files:**
- Create: `backend/src/websocket/vr-lobby.ts`
- Create: `backend/test/vr-lobby.test.ts`
- Modify: `backend/src/websocket/index.ts`

**Interfaces:**
- Consumes: `Presence` de `./presence.js`, `listAcceptedFriendshipsWithProfiles` de la couche dépôt (celle qu'utilise `services/friends.ts`), `Socket`/`Server` de socket.io.
- Produces:
  ```ts
  export const BEAT_MS = 66;
  export const MAX_POSES_PER_SECOND = 25;
  export interface VrLobby {
    /** Pour `getOnlineFriends` : qui est actuellement en VR. */
    isInVr(userId: string): boolean;
    /** Arrête le battement. Pour les tests et l'arrêt du serveur. */
    stop(): void;
  }
  export function registerVrLobby(io: Server, presence: Presence): VrLobby;
  export function attachVrLobby(lobby: VrLobby, socket: Socket, user: User): void;
  ```

**Note d'architecture :** `registerVrLobby` est appelé **une fois** au démarrage (il détient la carte et le battement) ; `attachVrLobby` est appelé **par connexion** pour brancher les écouteurs de ce socket. C'est la même séparation que `Presence` (une instance) et `presence.register` (par socket).

- [ ] **Step 1: Lire le modèle avant d'écrire**

Lire `backend/test/lobby-protocol.test.ts` en entier, en particulier le helper `roomOfTwo` et son commentaire sur la course `room:updated`/`room:update`. Les nouveaux tests doivent suivre ses conventions de montage de vraies sockets, pas en inventer d'autres.

Lire aussi `backend/src/websocket/presence.ts` : la règle « chaque mutation est clavetée sur le socket qui la possède » s'applique ici mot pour mot.

- [ ] **Step 2: Écrire les tests qui échouent**

Créer `backend/test/vr-lobby.test.ts`, en reprenant le montage de `lobby-protocol.test.ts`. Les cas à couvrir, chacun dans sa propre fonction `test` :

```ts
test('deux amis en VR se voient dans leur instantané', async () => {
  // A et B amis acceptés, tous deux émettent vr:enter puis vr:pose.
  // Attendre un vr:lobby sur A : peers contient exactement B, avec sa pose.
  // Puis sur B : peers contient exactement A.
});

test("un joueur ne se voit jamais lui-même", async () => {
  // A seul en VR, avec un ami B qui N'est PAS en VR.
  // A reçoit bien des vr:lobby, et peers est vide - jamais A lui-même.
});

test("un non-ami en VR est invisible des deux côtés", async () => {
  // A et C sans amitié, tous deux en VR, tous deux émettant leur pose.
  // Sur plusieurs battements, aucun vr:lobby de A ne contient C, ni l'inverse.
  // C'est LE test de confidentialité : il doit échouer bruyamment si la
  // diffusion est un jour élargie.
});

test('un départ est une absence dans l\'instantané suivant', async () => {
  // A et B en VR et visibles l'un de l'autre. B émet vr:leave.
  // Le prochain vr:lobby de A a peers vide. Aucun message de départ n'existe.
});

test('une déconnexion vaut un départ', async () => {
  // Comme ci-dessus, mais B ferme son socket sans vr:leave.
});

test("vr:enter reçu deux fois n'ajoute pas un second joueur", async () => {
  // B émet vr:enter deux fois. L'instantané de A contient B UNE fois.
});

test('une pose malformée est rejetée sans casser le battement', async () => {
  // B envoie head: [1, 2], puis head: ['x', ...], puis une pose valide.
  // A ne reçoit que la valide, et le battement continue de tourner.
});

test('un client qui inonde est plafonné, pas déconnecté', async () => {
  // B émet 200 vr:pose d'affilée. Son socket est toujours connecté après,
  // et A reçoit toujours des instantanés.
});

test('le battement ne tourne pas quand personne n\'est en VR', async () => {
  // Aucun vr:enter : aucun vr:lobby ne doit arriver en 300 ms.
  // Puis un vr:enter, et les instantanés commencent.
  // Puis vr:leave, et ils s'arrêtent.
});

test("une reconnexion tardive ne retire pas la présence VR de la connexion neuve", async () => {
  // Le piège que presence.ts documente : B se reconnecte (socket 2) et entre
  // en VR, PUIS le socket 1 se déclare mort. B doit rester visible de A.
});
```

- [ ] **Step 3: Vérifier que les tests échouent**

Run: `bun test backend/test/vr-lobby.test.ts`
Expected: FAIL — module `vr-lobby.js` introuvable.

(`test:backend` utilise `backend/test/*.test.ts`, donc ce fichier est pris automatiquement — contrairement à `test:ui`.)

- [ ] **Step 4: Écrire `vr-lobby.ts`**

```ts
/**
 * Qui est dans le lobby VR, où, et à qui le dire.
 *
 * LE SERVEUR NE RELAIE RIEN. `vr:pose` écrit dans une carte et s'arrête là ;
 * c'est un unique battement qui parle. La conséquence est ce qui a fait
 * choisir cette forme : un client ne peut pas, en émettant plus vite,
 * augmenter la charge que ses amis reçoivent, et chacun reçoit UN message par
 * battement quel que soit son nombre d'amis présents.
 *
 * ET UN DÉPART EST UNE ABSENCE. Il n'y a pas de message « untel est parti » :
 * l'instantané suivant ne le contient plus, un point c'est tout. Ça supprime
 * toute une classe de courses - « il est parti » qui double « voici sa pose »
 * et laisse un fantôme - parce que présence et position sont le même message.
 *
 * L'ensemble des destinataires est calculé ICI, jamais fourni par le client,
 * et il est mis en cache à l'entrée : `listAcceptedFriendshipsWithProfiles`
 * touche la base, et l'appeler quinze fois par seconde et par joueur serait
 * exactement le défaut que ce module existe pour ne pas avoir.
 *
 * Aucune pose n'est persistée.
 */
import { Server, Socket } from 'socket.io';
import { User } from '../types/index.js';
import { Presence } from './presence.js';
import { getDb } from '../db/index.js';
import { listAcceptedFriendshipsWithProfiles } from '../db/repositories/friends.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('VrLobby');

/** Quinze instantanés par seconde. */
export const BEAT_MS = 66;

/**
 * Le plafond d'un client, généreux d'un tiers par rapport aux quinze qu'il
 * doit émettre.
 *
 * Au-delà on IGNORE, on ne déconnecte pas : une rafale peut venir d'un réveil
 * de tâche ou d'une image en retard, et couper la session de quelqu'un pour ça
 * serait une punition sans faute. Le plafond n'est là que pour qu'un client
 * modifié ne puisse pas inonder la carte.
 */
export const MAX_POSES_PER_SECOND = 25;

/** `[x, y, z, qx, qy, qz, qw]`. */
type Pose = [number, number, number, number, number, number, number];

interface PeerPose {
  head: Pose;
  left: Pose | null;
  right: Pose | null;
}

interface Present {
  /** Le socket par lequel ce joueur est en VR. Clé de toute mutation : voir
   *  `presence.ts` et la reconnexion tardive. */
  socketId: string;
  friendIds: ReadonlySet<string>;
  pose: PeerPose | null;
  /** Fenêtre glissante du plafond de débit. */
  windowStart: number;
  posesInWindow: number;
}

export interface VrLobby {
  isInVr(userId: string): boolean;
  stop(): void;
}

/**
 * Valide une pose à la FORME, et rend `null` sinon.
 *
 * Sept nombres finis, ou rien. Une pose partiellement valide qui passerait
 * donnerait un `NaN` dans une matrice, donc un ami qui disparaît du rendu chez
 * tous ses amis sans que rien ne soit journalisé nulle part.
 */
function readPose(value: unknown): Pose | null {
  if (!Array.isArray(value) || value.length !== 7) return null;
  for (const component of value) {
    if (typeof component !== 'number' || !Number.isFinite(component)) return null;
  }
  return value as Pose;
}

export function registerVrLobby(io: Server, presence: Presence): VrLobby {
  const present = new Map<string, Present>();
  let beat: ReturnType<typeof setInterval> | null = null;

  /*
   * Le battement n'existe pas tant que personne n'est là.
   *
   * Un serveur au repos ne doit pas se réveiller quinze fois par seconde pour
   * parcourir une carte vide. Armé au premier entrant, désarmé au dernier
   * sortant - et c'est un test qui le garde, sans quoi la version « toujours
   * armé » passerait inaperçue pour toujours.
   */
  function arm(): void {
    if (beat !== null) return;
    beat = setInterval(tick, BEAT_MS);
  }

  function disarm(): void {
    if (beat === null) return;
    clearInterval(beat);
    beat = null;
  }

  function tick(): void {
    for (const [userId, me] of present) {
      const peers = [];
      for (const friendId of me.friendIds) {
        const friend = present.get(friendId);
        // Pas encore de pose : présent mais pas encore situé. On ne l'annonce
        // pas, plutôt que de l'annoncer à l'origine du décor - ce qui le
        // ferait apparaître une image dans le comptoir avant de sauter à sa
        // vraie place.
        if (!friend || friend.pose === null) continue;
        peers.push({
          id: friendId,
          head: friend.pose.head,
          left: friend.pose.left,
          right: friend.pose.right
        });
      }
      // Jamais soi-même : la boucle parcourt `friendIds`, dont on ne fait pas
      // partie. L'exclusion est donc structurelle et non une condition qu'on
      // pourrait oublier.
      io.to(me.socketId).emit('vr:lobby', { peers });
    }
  }

  function leave(userId: string, socketId: string): void {
    const entry = present.get(userId);
    if (!entry) return;
    /*
     * LA MUTATION EST CLAVETÉE SUR LE SOCKET.
     *
     * Le piège que `presence.ts` documente déjà, et qui a fait disparaître des
     * joueurs de la liste d'amis : un client qui se reconnecte enregistre son
     * nouveau socket tout de suite, tandis que le serveur peut ne déclarer
     * l'ancien mort que vingt secondes plus tard. Traiter cette mort sans
     * vérifier détruirait l'entrée de la connexion NEUVE.
     */
    if (entry.socketId !== socketId) return;
    present.delete(userId);
    if (present.size === 0) disarm();
  }

  return {
    isInVr: (userId) => present.has(userId),
    stop: disarm,

    // Exposé au reste du module ci-dessous via une fermeture ; voir
    // `attachVrLobby`.
    ...({ present, arm, leave, readPose } as Record<string, never>)
  } as VrLobby;
}
```

> **Note pour l'implémenteur :** la dernière ligne de `registerVrLobby`
> ci-dessus est un raccourci illisible. **Ne la reproduis pas.** Structure
> plutôt le module ainsi : `registerVrLobby` crée l'état et rend un objet qui
> expose, en plus de `isInVr` et `stop`, une méthode
> `attach(socket: Socket, user: User): void`. `attachVrLobby(lobby, socket,
> user)` devient alors `lobby.attach(socket, user)` — ou disparaît au profit de
> l'appel direct. Choisis la forme la plus simple ; ce que le plan impose est le
> **comportement** décrit par les tests, pas cette syntaxe.

Le corps de `attach` :

```ts
    attach(socket: Socket, user: User): void {
      socket.on('vr:enter', () => {
        // Entrer est un ÉTAT, pas un événement : reçu deux fois, le second est
        // sans effet. Sinon un client qui réémet au retour d'un menu se
        // dédoublerait dans l'instantané de ses amis.
        const friendships = listAcceptedFriendshipsWithProfiles(getDb(), user.id);
        const friendIds = new Set(
          friendships.map((f) => (f.initiatorId === user.id ? f.receiver.id : f.initiator.id))
        );

        const existing = present.get(user.id);
        present.set(user.id, {
          socketId: socket.id,
          friendIds,
          // Une réentrée depuis le même socket garde la pose : sinon l'ami
          // clignote hors du monde le temps d'un battement.
          pose: existing?.socketId === socket.id ? (existing.pose ?? null) : null,
          windowStart: Date.now(),
          posesInWindow: 0
        });
        arm();
        logger.debug({ user: user.pseudo }, 'entré dans le lobby VR');
        notifyFriendsVrChanged(user.id, true);
      });

      socket.on('vr:pose', (data: unknown) => {
        const entry = present.get(user.id);
        if (!entry || entry.socketId !== socket.id) return;

        const now = Date.now();
        if (now - entry.windowStart >= 1000) {
          entry.windowStart = now;
          entry.posesInWindow = 0;
        }
        entry.posesInWindow += 1;
        if (entry.posesInWindow > MAX_POSES_PER_SECOND) return;

        const payload = data as { head?: unknown; left?: unknown; right?: unknown } | null;
        const head = readPose(payload?.head);
        // Sans tête, pas de pose : les mains sans elle n'ont nulle part où
        // aller, et la proximité se mesure tête à tête.
        if (head === null) return;

        entry.pose = {
          head,
          left: readPose(payload?.left),
          right: readPose(payload?.right)
        };
      });

      socket.on('vr:leave', () => {
        leave(user.id, socket.id);
        notifyFriendsVrChanged(user.id, false);
      });

      socket.on('disconnect', () => {
        leave(user.id, socket.id);
        notifyFriendsVrChanged(user.id, false);
      });
    }
```

Et l'annonce aux amis, qui réutilise le canal existant :

```ts
  /**
   * Prévient les amis en ligne qu'on est entré ou sorti de la VR.
   *
   * Le même canal que `friend:statusChanged`, et volontairement : « en VR »
   * est un état d'ami comme « en ligne », pas un état d'une autre famille.
   * Sans ça, personne ne saurait depuis la page à plat qu'il y a quelqu'un à
   * rejoindre - et on ne met pas un casque au hasard.
   */
  function notifyFriendsVrChanged(userId: string, inVr: boolean): void {
    const entry = present.get(userId);
    const friendIds =
      entry?.friendIds ??
      new Set(
        listAcceptedFriendshipsWithProfiles(getDb(), userId).map((f) =>
          f.initiatorId === userId ? f.receiver.id : f.initiator.id
        )
      );
    for (const friendId of friendIds) {
      const socketId = presence.socketFor(friendId);
      if (socketId) io.to(socketId).emit('friend:statusChanged', { userId, online: true, inVr });
    }
  }
```

> **Attention :** à la sortie, `present.get(userId)` a déjà été supprimé par
> `leave`. D'où le repli qui relit la base — c'est une lecture par sortie, pas
> par image, donc acceptable. Alternative plus propre si tu préfères : capturer
> `friendIds` **avant** d'appeler `leave`. Fais-le ; c'est mieux.

- [ ] **Step 5: Brancher dans `websocket/index.ts`**

- Au niveau module, à côté de `const presence = new Presence();` :
  ```ts
  const vrLobby = registerVrLobby(io, presence);
  ```
  (Si `io` n'existe pas encore à cet endroit, appeler `registerVrLobby` là où `io` est disponible, une seule fois.)
- Dans le handler de connexion, après `presence.register(user, socket.id);` :
  ```ts
  vrLobby.attach(socket, user);
  ```

- [ ] **Step 6: Faire passer les tests**

Run: `bun test backend/test/vr-lobby.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 7: Passe de mutation**

1. Dans `leave`, supprimer `if (entry.socketId !== socketId) return;`.
   → « une reconnexion tardive ne retire pas la présence VR » doit échouer.
2. Dans `tick`, itérer sur `present` au lieu de `me.friendIds`.
   → « un non-ami en VR est invisible » **et** « un joueur ne se voit jamais lui-même » doivent échouer. C'est la mutation la plus importante des deux : elle est exactement la fuite de confidentialité que ce module existe pour rendre impossible.
3. Remplacer `arm()`/`disarm()` par un `setInterval` armé une fois pour toutes.
   → « le battement ne tourne pas quand personne n'est en VR » doit échouer.

Restaurer après chaque.

- [ ] **Step 8: Vérifier la suite backend**

Run: `bun run test:backend`
Expected: **395 tests** (385 + 10), 0 fail.

- [ ] **Step 9: Commit**

```bash
git add backend/src/websocket/vr-lobby.ts backend/src/websocket/index.ts backend/test/vr-lobby.test.ts
git commit -m "$(cat <<'EOF'
Tenir les poses du lobby VR, et n'en parler qu'aux amis

Le serveur ne relaie rien : `vr:pose` écrit dans une carte, et un unique
battement à 15 Hz envoie à chacun l'instantané de ses amis présents. Un client
ne peut donc pas, en émettant plus vite, augmenter la charge que ses amis
reçoivent, et chacun reçoit un message par battement quel que soit son nombre
d'amis.

Un départ est une absence dans l'instantané suivant, pas un message. Présence
et position étant le même message, la course « il est parti » contre « voici sa
pose » n'existe pas.

L'ensemble des destinataires est calculé ici et mis en cache à l'entrée - la
liste d'amis touche la base, et la lire quinze fois par seconde et par joueur
serait le défaut que ce module existe pour ne pas avoir. Un test vérifie qu'un
non-ami en VR reste invisible des deux côtés.

Le battement n'existe pas tant que personne n'est là, et la sortie est clavetée
sur le socket : le piège de la reconnexion tardive que presence.ts documente
déjà avait fait disparaître des joueurs de la liste d'amis.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: « en VR » dans les deux listes d'amis

**Files:**
- Modify: `backend/src/services/friends.ts`
- Modify: `backend/src/websocket/index.ts:161`
- Modify: `frontend/src/lib/vr/panels/friends.ts`
- Modify: `frontend/src/lib/i18n/translations.ts`
- Modify: `frontend/src/lib/components/FriendsList.svelte`
- Modify: `frontend/src/lib/components/VrShell.svelte`
- Test: `core/test/vr-panel-friends.test.ts`

**Interfaces:**
- Consumes: `VrLobby.isInVr` de la Task 4.
- Produces:
  ```ts
  // backend/src/services/friends.ts
  export interface OnlineFriend { id; pseudo; discriminator; avatar; online: boolean; inVr: boolean; }
  export async function getOnlineFriends(
    userId: string,
    presence: { socketFor(userId: string): string | undefined },
    vr: { isInVr(userId: string): boolean }
  ): Promise<OnlineFriend[]>;

  // frontend/src/lib/vr/panels/friends.ts
  export interface FriendRow { id; pseudo; online: boolean; inVr: boolean; playing: string | null; }
  export interface FriendsLabels { /* ... */ inVr: string; }
  export function friendRows(
    friends: readonly { friend: { id: string; pseudo: string } }[],
    online: ReadonlyMap<string, boolean>,
    inVr: ReadonlySet<string>,
    playingByUserId: ReadonlyMap<string, string>,
    cap: number,
    invitedId?: string
  ): FriendRow[];
  ```

- [ ] **Step 1: Écrire les tests qui échouent**

Ajouter à `core/test/vr-panel-friends.test.ts` :

```ts
test('un ami en VR le dit, plutôt que de dire seulement « en ligne »', () => {
  const rows = friendRows(
    [{ friend: { id: 'a', pseudo: 'Luigi' } }],
    new Map([['a', true]]),
    new Set(['a']),
    new Map(),
    8
  );
  assert.equal(rows[0].inVr, true);
});

test('un ami qui joue le dit, même s\'il est en VR : la partie l\'emporte', () => {
  const rows = friendRows(
    [{ friend: { id: 'a', pseudo: 'Luigi' } }],
    new Map([['a', true]]),
    new Set(['a']),
    new Map([['a', 'Zelda']]),
    8
  );
  // Il a quitté le lobby partagé en lançant : `playing` décrit mieux son état.
  assert.equal(rows[0].playing, 'Zelda');
});

test('un ami hors ligne ne peut pas être en VR', () => {
  const rows = friendRows(
    [{ friend: { id: 'a', pseudo: 'Luigi' } }],
    new Map([['a', false]]),
    new Set(['a']),
    new Map(),
    8
  );
  assert.equal(rows[0].inVr, false, 'hors ligne prime : un socket fermé ne porte pas de casque');
});
```

Et, dans le test de région existant qui vérifie que chaque état est expliqué, ajouter l'état `inVr` au jeu de données parcouru.

- [ ] **Step 2: Vérifier l'échec**

Run: `bun test core/test/vr-panel-friends.test.ts`
Expected: FAIL — `friendRows` prend cinq arguments, pas six ; `inVr` n'existe pas sur `FriendRow`.

- [ ] **Step 3: Étendre `friendRows` et l'affichage**

Dans `frontend/src/lib/vr/panels/friends.ts` :

```ts
export interface FriendRow {
  id: string;
  pseudo: string;
  online: boolean;
  /** Il a ouvert la VR et n'est pas en partie : on peut aller le voir. */
  inVr: boolean;
  /** The game's title, when they are in one. */
  playing: string | null;
}
```

Dans `friendRows`, la ligne construite devient :

```ts
    online: online.get(entry.friend.id) === true,
    // Hors ligne prime : un socket fermé ne porte pas de casque. Sans ce ET,
    // un ami dont la déconnexion arrive avant la sortie de VR resterait
    // « en VR » jusqu'au rechargement.
    inVr: online.get(entry.friend.id) === true && inVr.has(entry.friend.id),
    playing: playingByUserId.get(entry.friend.id) ?? null
```

Dans `FriendsLabels`, ajouter :

```ts
  /** Sur la ligne d'un ami présent dans le lobby VR. */
  inVr: string;
```

Et dans le dessin de la ligne d'état, l'ordre de priorité est : `playing` d'abord (il a quitté le lobby partagé, donc c'est l'état le plus précis), puis `inVr`, puis `online`, puis `offline`.

- [ ] **Step 4: Ajouter la clé i18n dans les deux langues**

Dans `frontend/src/lib/i18n/translations.ts`, à côté de `vrFriendReady`/`vrFriendAway` :

- `en` : `vrInVr: 'In VR',`
- `fr` : `vrInVr: 'En VR',`

Run: `bun test core/test/i18n-parity.test.ts`
Expected: PASS.

- [ ] **Step 5: Côté serveur, remplir `inVr`**

Dans `backend/src/services/friends.ts`, ajouter `inVr: boolean` à `OnlineFriend` et le troisième paramètre `vr` à `getOnlineFriends`. Dans le `map`, ajouter la ligne explicitement — **ne pas** passer au spread : le commentaire du fichier explique que la vérification des propriétés excédentaires ne mord que sur une liste écrite à la main.

```ts
      online: presence.socketFor(friend.id) !== undefined,
      inVr: vr.isInVr(friend.id)
```

Dans `backend/src/websocket/index.ts:161`, passer `vrLobby` en troisième argument.

Et dans le même fichier, là où `friend:statusChanged` est émis à la connexion et à la déconnexion, ajouter `inVr: false` pour une déconnexion (un socket fermé ne porte pas de casque) et `inVr: vrLobby.isInVr(user.id)` à la connexion.

- [ ] **Step 6: Les deux consommateurs frontend**

`FriendsList.svelte` : ajouter une `Set<string>` `inVrFriends` alimentée par `friends:online` (`f.inVr`) et par `friend:statusChanged` (`inVr`), et afficher le libellé « En VR » sur la ligne. Suivre le style du composant tel qu'il est — il réassigne pour déclencher la réactivité Svelte 4 ; ne pas le refactorer ici.

`VrShell.svelte` : ajouter `let inVrFriends = new Set<string>();` à côté de `onlineFriends`, l'alimenter dans `handleFriendsOnline` et `handleFriendStatusChanged`, la remettre à zéro au même endroit que `onlineFriends = new Map();`, et la passer à `friendRows`. Ajouter `inVr: t($language, 'vrInVr')` à l'objet `FriendsLabels` construit par le composant.

> **Piège Svelte 4 connu dans ce dépôt :** une fonction *déclarée* et appelée
> depuis un bloc `$:` ou depuis le template se compile en initialisation unique.
> Si l'affichage ne se met pas à jour, ne pas raisonner par lecture : compiler
> et regarder dans `$$self.$$.update`.

- [ ] **Step 7: Faire passer l'ensemble**

Run: `bun test core/test/vr-panel-friends.test.ts core/test/i18n-parity.test.ts`
Expected: PASS.

Run: `bun run test:backend`
Expected: 395 tests, 0 fail.

Run: `cd frontend && bun run check`
Expected: **0 erreur**. (Si `svelte-check` explose en centaines d'erreurs sur des types manquants, lancer `npx svelte-kit sync` : c'est l'absence des types générés, pas une régression.)

- [ ] **Step 8: Commit**

```bash
git add backend/src/services/friends.ts backend/src/websocket/index.ts frontend/src/lib/vr/panels/friends.ts frontend/src/lib/i18n/translations.ts frontend/src/lib/components/FriendsList.svelte frontend/src/lib/components/VrShell.svelte core/test/vr-panel-friends.test.ts
git commit -m "$(cat <<'EOF'
Dire « en VR » dans les deux listes d'amis

Un lobby vide et un lobby qu'on n'a pas su remplir se ressemblent. Sans cette
mention, on ne découvre ses amis présents qu'une fois le casque sur la tête,
donc on le met rarement au bon moment.

« En VR » est un état d'ami comme « en ligne », et voyage donc par le canal qui
porte déjà les deux autres plutôt que par un canal réservé à la VR.

Hors ligne prime sur en VR : un socket fermé ne porte pas de casque, et sans ce
ET un ami dont la déconnexion arrive avant la sortie resterait en VR jusqu'au
rechargement. Une partie prime sur les deux, puisqu'on quitte le lobby partagé
en lançant.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `poseInRoom()` — ma pose dans le repère du décor

**Files:**
- Modify: `frontend/src/lib/vr/scene.ts`

**Interfaces:**
- Consumes: le groupe `room` interne à `createVrScene`.
- Produces:
  ```ts
  // sur VrScene
  poseInRoom(): { head: Pose; left: Pose | null; right: Pose | null } | null;
  ```
  où `Pose` est le type importé de `$lib/vr/lobby/roster`.

**Pourquoi ce n'est pas testable sous Bun :** trois y est importé. C'est la même frontière que `decor/build.ts`, et la raison pour laquelle ce module reste minuscule : toute décision est déjà partie ailleurs.

- [ ] **Step 1: Lire `place()` avant d'écrire**

Lire `frontend/src/lib/vr/scene.ts`, fonction `place()`, en entier — y compris son commentaire en capitales sur le centre de rotation. C'est l'aller de la transformation que cette tâche prend à l'envers, et le fichier raconte ce qu'a coûté de l'écrire à la main.

**La règle de cette tâche : n'écrire aucune trigonométrie.** `room.worldToLocal` traverse la matrice que three tient déjà, donc il porte gratuitement `walkAt`, `walkYaw`, `setPlayerHeight` et l'accroupissement. Une formule manuscrite devrait recomposer ces quatre termes sans se tromper de signe, et ce dépôt en a payé quatre.

- [ ] **Step 2: Écrire la méthode**

Dans l'interface `VrScene`, à côté de `headPosition` :

```ts
  /**
   * Ma tête et mes mains DANS LE REPÈRE DU DÉCOR — celui de `addDecor`, où
   * `decor/placement.ts` pose ses tuyaux et où `playerAt` s'accumule.
   *
   * C'est le repère que deux clients partagent par construction : « deux
   * mètres à gauche du comptoir » y désigne le même endroit pour tout le
   * monde. C'est donc lui, et pas l'espace de référence, qui part sur le fil.
   *
   * AUCUNE TRIGONOMÉTRIE ICI, ET C'EST DÉLIBÉRÉ. `place()` écrit l'aller à la
   * main et son commentaire raconte ce qu'a coûté le centre de rotation mal
   * placé ; `decor/box.ts` en garde deux autres. Écrire le retour à la main
   * serait la cinquième erreur de signe de ce dépôt. `worldToLocal` traverse
   * la matrice que three tient déjà, donc il porte gratuitement la marche, le
   * lacet, la hauteur et l'accroupissement — un joueur perché sur un tuyau
   * apparaît sur le tuyau sans une ligne de plus.
   *
   * Rend `null` hors image ou tant que le suivi n'est pas prêt : à traiter
   * comme « redemande », jamais comme « pas de pose », exactement comme
   * `poseIn`.
   */
  poseInRoom(): { head: Pose; left: Pose | null; right: Pose | null } | null;
```

L'implémentation, dans l'objet rendu par `createVrScene` :

```ts
    poseInRoom(): { head: Pose; left: Pose | null; right: Pose | null } | null {
      const frame = currentFrame;
      const space = referenceSpace;
      if (!frame || !space) return null;

      /*
       * Les matrices d'abord, et ce n'est pas décoratif.
       *
       * La lecture a lieu dans `onFrame`, donc AVANT le rendu qui rafraîchit
       * les matrices. Sans ça, la pose émise est celle de l'image précédente —
       * un retard d'une image chez tous ses amis, invisible au débogage et
       * bien réel dans un casque.
       */
      room.updateMatrixWorld(true);

      const eye = renderer.xr.getCamera();
      const position = new THREE.Vector3();
      const quaternion = new THREE.Quaternion();
      const scale = new THREE.Vector3();

      const toRoom = new THREE.Matrix4().copy(room.matrixWorld).invert();

      const headMatrix = new THREE.Matrix4().compose(eye.position, eye.quaternion, ONE);
      headMatrix.premultiply(toRoom);
      headMatrix.decompose(position, quaternion, scale);
      const head: Pose = [
        position.x, position.y, position.z,
        quaternion.x, quaternion.y, quaternion.z, quaternion.w
      ];

      let left: Pose | null = null;
      let right: Pose | null = null;

      for (const source of session?.inputSources ?? []) {
        if (!source.gripSpace) continue;
        const pose = frame.getPose(source.gripSpace, space);
        // Une manette posée sur la table n'est pas suivie : pas de pose, pas
        // de main. Elle disparaît chez les amis plutôt que de rester figée,
        // ce que `roster.ts`'s `tween` traite déjà.
        if (!pose) continue;

        const gripMatrix = new THREE.Matrix4().fromArray(pose.transform.matrix);
        gripMatrix.premultiply(toRoom);
        gripMatrix.decompose(position, quaternion, scale);
        const hand: Pose = [
          position.x, position.y, position.z,
          quaternion.x, quaternion.y, quaternion.z, quaternion.w
        ];
        if (source.handedness === 'left') left = hand;
        else if (source.handedness === 'right') right = hand;
      }

      return { head, left, right };
    },
```

avec, au niveau module :

```ts
/** Pas d'échelle, et une seule instance : `compose` en exige une, et en
 *  allouer une par main et par image serait trois cents `Vector3` par seconde
 *  pour toujours la même valeur. */
const ONE = new THREE.Vector3(1, 1, 1);
```

> **À vérifier en lisant `scene.ts` :** les noms `currentFrame`, `referenceSpace`,
> `session` et `renderer` ci-dessus sont les variables que la boucle d'animation
> détient déjà. Si elles s'appellent autrement dans le fichier, **utiliser les
> vrais noms** — ne pas en introduire de nouvelles. `poseIn(space)` fait déjà
> exactement ce genre de lecture : la prendre pour modèle.

- [ ] **Step 3: Vérifier la compilation**

Run: `cd frontend && bun run check`
Expected: 0 erreur.

Run: `cd frontend && bun run build`
Expected: succès.

- [ ] **Step 4: Vérifier qu'on n'a rien cassé**

Run: `bun run test:ui`
Expected: même total qu'à la fin de la Task 5, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/vr/scene.ts
git commit -m "$(cat <<'EOF'
Lire ma tête et mes mains dans le repère du décor

C'est le repère que deux clients partagent par construction depuis qu'on marche
dedans : « deux mètres à gauche du comptoir » y désigne le même endroit pour
tout le monde. C'est donc lui, et pas l'espace de référence, qui doit partir sur
le fil.

Aucune trigonométrie ici, et c'est délibéré. `place()` écrit l'aller à la main
et raconte ce qu'a coûté le centre de rotation mal placé ; `box.ts` en garde
deux autres. Écrire le retour à la main serait la cinquième erreur de signe de
ce dépôt. `worldToLocal` traverse la matrice que three tient déjà, donc il porte
gratuitement la marche, le lacet, la hauteur et l'accroupissement : un joueur
perché sur un tuyau apparaît sur le tuyau sans une ligne de plus.

Les matrices sont rafraîchies avant la lecture, parce qu'elle a lieu avant le
rendu - sans quoi on émettrait la pose de l'image précédente.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: `avatars.ts` — les maillages

**Files:**
- Create: `frontend/src/lib/vr/lobby/avatars.ts`
- Modify: `frontend/src/lib/vr/decor/build.ts`

**Interfaces:**
- Consumes: `PeerPose` et `Pose` de `roster.ts`, `presenceFor` de `proximity.ts`, `boxGeometry`/`BoxSpec` de `decor/box.ts`, `uvOf`/`Atlas` de `decor/atlas.ts`, `ART_PIXELS_PER_METRE` de `decor/composition.ts`.
- Produces:
  ```ts
  export const HEAD_SIZE = 0.24;
  export const HAND_SIZE = 0.1;
  export interface AvatarsOptions {
    atlas: Atlas;
    material: THREE.Material;
    label: (id: string) => string | null;
  }
  export interface Avatars {
    group: THREE.Object3D;
    update(peers: ReadonlyMap<string, PeerPose>, mine: Pose | null): void;
    dispose(): void;
  }
  export function createAvatars(opts: AvatarsOptions): Avatars;
  ```

- [ ] **Step 1: Exposer l'atlas et le matériau sur `Decor`**

Dans `frontend/src/lib/vr/decor/build.ts`, ajouter à l'interface `Decor` :

```ts
  /**
   * L'atlas et le matériau des props, pour qui doit dessiner dans la même
   * texture.
   *
   * Exposés plutôt que reconstruits par l'appelant : `packAtlas(ALL_ART)` est
   * déterministe, donc un second appel donnerait le même rangement — mais une
   * SECONDE texture, un second téléversement et un bind de plus par image,
   * pour des UV identiques. Les avatars sont dans `ALL_ART`, donc leur place
   * est déjà dans celui-ci.
   */
  atlas: Atlas;
  propMaterial: THREE.Material;
```

et les renseigner depuis `createDecor` avec `atlas` et `quadMaterial` déjà construits. **Ne pas les disposer deux fois** : `dispose()` de `Decor` en reste le seul propriétaire.

- [ ] **Step 2: Écrire `avatars.ts`**

```ts
/**
 * Les amis, en maillages. Ce module n'a AUCUNE décision.
 *
 * La jumelle de `decor/build.ts`, et pour la même raison : trois n'est pas
 * exécutable sous Bun, donc tout ce qui pourrait se tromper est déjà parti
 * ailleurs. `roster.ts` dit où sont les amis, `proximity.ts` dit ce qu'on en
 * montre, `avatar-art.ts` dit à quoi ils ressemblent. Ici on pose des boîtes.
 *
 * TROIS PIÈGES, DÉSARMÉS ICI PARCE QU'ILS ONT DÉJÀ COÛTÉ.
 *
 * La façade d'une boîte regarde -Z (`FRONT_NORMAL`), celle d'un quad regarde
 * +Z. Recopier la ligne de lacet de l'un à l'autre a déjà tourné tout le décor
 * proche de 180°, sans qu'aucun test le voie. Ici on ne calcule pas de lacet
 * du tout : on applique le quaternion reçu, qui est celui d'une tête.
 *
 * L'opacité descend de `proximity`, et sous le seuil on retire l'objet du
 * rendu (`visible = false`) au lieu de le rendre transparent : un transparent
 * invisible coûte encore son tri, et ce dépôt a déjà payé un basculement
 * d'ordre de rendu sur une surface transparente.
 *
 * Et on ne recrée JAMAIS un maillage par image. Un ami garde les siens tant
 * qu'il est là ; seuls ses `position`/`quaternion`/`visible` changent. C'est
 * l'avertissement de `panel-mesh.ts` sur le coût d'une re-rasterisation à
 * 72 Hz, appliqué aux géométries.
 */
import * as THREE from 'three';
import { boxGeometry } from '../decor/box';
import { uvOf, type Atlas } from '../decor/atlas';
import { presenceFor } from './proximity';
import type { Pose, PeerPose } from './roster';

/** Une tête d'adulte fait vingt-quatre centimètres de large. */
export const HEAD_SIZE = 0.24;
/** Un poing fermé sur une manette. */
export const HAND_SIZE = 0.1;
/** De combien la plaque de pseudo flotte au-dessus du crâne. */
const LABEL_RISE = 0.22;

export interface AvatarsOptions {
  atlas: Atlas;
  material: THREE.Material;
  /*
   * Pas de `head()` ici, contrairement à `DecorOptions`.
   *
   * Les billboards du décor sont des quads qu'il faut faire pivoter à la main
   * vers la tête, d'où le rappel dont `build.ts` a besoin. La plaque de pseudo
   * est un `THREE.Sprite`, qui fait face au lecteur tout seul par construction.
   * Un rappel de plus serait un paramètre que personne ne lit.
   */
  /** Le pseudo d'un identifiant, ou `null` si on ne le connaît pas — auquel
   *  cas l'ami n'est PAS dessiné : voir `update`. */
  label: (id: string) => string | null;
}

export interface Avatars {
  /** À passer à `scene.addDecor`. */
  group: THREE.Object3D;
  /**
   * `mine` est ma propre tête, pour la proximité. `null` tant que je n'ai pas
   * de pose : dans ce cas on montre tout le monde solide plutôt que de faire
   * disparaître le lobby.
   */
  update(peers: ReadonlyMap<string, PeerPose>, mine: Pose | null): void;
  dispose(): void;
}

interface Avatar {
  root: THREE.Object3D;
  head: THREE.Mesh;
  left: THREE.Mesh;
  right: THREE.Mesh;
  label: THREE.Sprite;
  material: THREE.Material;
  labelMaterial: THREE.SpriteMaterial;
  geometries: THREE.BufferGeometry[];
}

function place(mesh: THREE.Object3D, pose: Pose): void {
  mesh.position.set(pose[0], pose[1], pose[2]);
  mesh.quaternion.set(pose[3], pose[4], pose[5], pose[6]);
}

export function createAvatars(opts: AvatarsOptions): Avatars {
  const group = new THREE.Group();
  const avatars = new Map<string, Avatar>();

  function build(id: string, pseudo: string): Avatar {
    /*
     * Un matériau PAR AMI, et non le matériau partagé du décor.
     *
     * L'opacité est individuelle - deux amis à deux distances ne s'effacent
     * pas pareil - et une opacité posée sur le matériau partagé les ferait
     * tous s'effacer ensemble, décor compris. Le coût est un bind par ami,
     * pour quelques amis.
     */
    const material = (opts.material as THREE.MeshBasicMaterial).clone();
    material.transparent = true;
    material.alphaTest = 0;
    material.depthWrite = true;

    const headGeometry = geometryFor(opts.atlas, HEAD_SIZE, 'avatarFace', 'avatarSide', 'avatarTop');
    const handGeometry = geometryFor(opts.atlas, HAND_SIZE, 'avatarHand', 'avatarHand', 'avatarHand');

    const head = new THREE.Mesh(headGeometry, material);
    const left = new THREE.Mesh(handGeometry, material);
    const right = new THREE.Mesh(handGeometry.clone(), material);

    const labelMaterial = labelSprite(pseudo);
    const label = new THREE.Sprite(labelMaterial);
    label.scale.set(0.5, 0.125, 1);

    const root = new THREE.Group();
    root.add(head, left, right, label);
    group.add(root);

    return {
      root, head, left, right, label, material, labelMaterial,
      geometries: [headGeometry, handGeometry, right.geometry as THREE.BufferGeometry]
    };
  }

  return {
    group,

    update(peers, mine) {
      // Les partis, d'abord : un ami absent de la carte a quitté le lobby, et
      // `roster` a déjà décidé ça pour nous.
      for (const [id, avatar] of avatars) {
        if (peers.has(id)) continue;
        release(avatar);
        group.remove(avatar.root);
        avatars.delete(id);
      }

      for (const [id, pose] of peers) {
        const pseudo = opts.label(id);
        /*
         * Un identifiant qu'on ne connaît pas comme ami n'est PAS dessiné.
         *
         * La garantie de dernier recours : même si le serveur se trompait un
         * jour de destinataire, aucun inconnu n'apparaîtrait dans le lobby de
         * personne. C'est aussi ce qui arrive légitimement pendant la seconde
         * où `friends:online` n'est pas encore arrivé.
         */
        if (pseudo === null) continue;

        let avatar = avatars.get(id);
        if (!avatar) {
          avatar = build(id, pseudo);
          avatars.set(id, avatar);
        }

        const presence = mine === null
          ? { visible: true, opacity: 1 }
          : presenceFor(mine, pose.head);

        avatar.root.visible = presence.visible;
        if (!presence.visible) continue;

        avatar.material.opacity = presence.opacity;
        avatar.labelMaterial.opacity = presence.opacity;

        place(avatar.head, pose.head);

        avatar.left.visible = pose.left !== null;
        if (pose.left) place(avatar.left, pose.left);
        avatar.right.visible = pose.right !== null;
        if (pose.right) place(avatar.right, pose.right);

        // La plaque flotte au-dessus du crâne et regarde toujours le lecteur :
        // un Sprite s'oriente tout seul, d'où le choix contre un quad qu'il
        // faudrait faire pivoter à la main comme les billboards du décor.
        avatar.label.position.set(pose.head[0], pose.head[1] + LABEL_RISE, pose.head[2]);
      }
    },

    dispose() {
      for (const avatar of avatars.values()) {
        release(avatar);
        group.remove(avatar.root);
      }
      avatars.clear();
    }
  };
}
```

Fonctions restantes à écrire dans le même fichier :

- `geometryFor(atlas, size, front, side, top)` : construit une `BufferGeometry` à partir de `boxGeometry({ width: size, height: size, depth: size, front: uvOf(atlas, front), side: uvOf(atlas, side), top: uvOf(atlas, top) })`, en posant les attributs `position`, `uv` et l'index — prendre `decor/build.ts`'s `boxFor` pour modèle exact.
- `labelSprite(pseudo)` : une `THREE.SpriteMaterial` dont la `map` est une `CanvasTexture` où le pseudo est écrit. Reprendre la fabrication de texte de `panel-mesh.ts`. **Une seule rasterisation par ami**, à la création — jamais par image.
- `release(avatar)` : `dispose()` sur les géométries, le matériau cloné, la `SpriteMaterial` et sa `map`.

- [ ] **Step 3: Vérifier la compilation et le build**

Run: `cd frontend && bun run check`
Expected: 0 erreur.

Run: `cd frontend && bun run build`
Expected: succès.

- [ ] **Step 4: Vérifier qu'on n'a rien cassé**

Run: `bun run test:ui`
Expected: même total qu'à la fin de la Task 6, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/vr/lobby/avatars.ts frontend/src/lib/vr/decor/build.ts
git commit -m "$(cat <<'EOF'
Poser les amis dans le décor, sans décider de rien

La jumelle de decor/build.ts : trois n'est pas exécutable sous Bun, donc tout ce
qui pourrait se tromper est déjà parti ailleurs. `roster` dit où ils sont,
`proximity` ce qu'on en montre, `avatar-art` à quoi ils ressemblent.

Aucun lacet n'est calculé ici. La façade d'une boîte regarde -Z et celle d'un
quad regarde +Z, et recopier la ligne de l'un à l'autre a déjà tourné tout le
décor de 180° : on applique le quaternion reçu, qui est celui d'une tête.

Un matériau par ami, parce que deux amis à deux distances ne s'effacent pas
pareil et qu'une opacité posée sur le matériau partagé emporterait le décor. Et
aucun maillage n'est recréé par image - seuls position, quaternion et visible
changent.

Un identifiant qu'on ne connaît pas comme ami n'est pas dessiné : la garantie de
dernier recours qu'aucun inconnu n'apparaît dans le lobby de personne.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Le raccordement dans `VrShell.svelte`

**Files:**
- Modify: `frontend/src/lib/components/VrShell.svelte`

**Interfaces:**
- Consumes: tout ce qui précède.
- Produces: rien — c'est la dernière pièce.

**Pourquoi en dernier :** c'est la seule partie qu'aucun test ne couvre. Elle doit se poser sur des pièces déjà vertes, sinon un défaut ici sera cherché ailleurs.

- [ ] **Step 1: L'état du composant**

À côté de `walkAt` et `onlineFriends` :

```ts
  /** Les amis présents dans le lobby VR, et leur pose interpolée. */
  let roster = createRoster();
  let avatars: Avatars | null = null;
  /** Ma dernière pose émise, gardée pour la proximité. */
  let myPose: Pose | null = null;
  /** L'horloge du dernier envoi, pour tenir les quinze par seconde. */
  let posedAt = 0;
  /** Faux pendant une partie : on quitte alors le lobby partagé. */
  let inSharedLobby = false;
```

- [ ] **Step 2: L'entrée**

Dans `enter()`, après la création de `decor` et **sans aucun `await` bloquant** :

```ts
  // Pas de socket, pas de lobby partagé — et le reste de la VR marche. C'est
  // pourquoi rien ici n'est attendu : une session solo ne doit pas dépendre
  // d'un serveur joignable.
  avatars = createAvatars({
    atlas: decor.atlas,
    material: decor.propMaterial,
    label: (id) => friendPseudo(id)
  });
  scene.addDecor(avatars.group);

  $socket?.on('vr:lobby', handleVrLobby);
  $socket?.emit('vr:enter');
  inSharedLobby = true;
```

avec :

```ts
  function handleVrLobby(snapshot: { peers: PeerSnapshot[] }): void {
    roster.accept(snapshot, performance.now());
  }

  /** Le pseudo d'un ami, ou `null` : voir `avatars.ts`'s `label`. */
  function friendPseudo(id: string): string | null {
    const found = $friends?.find((entry) => entry.friend.id === id);
    if (!found) {
      logger.debug({ id }, 'instantané du lobby : identifiant inconnu, ignoré');
      return null;
    }
    return found.friend.pseudo;
  }
```

> **À vérifier :** le nom exact du magasin d'amis du composant. `VrShell` tient
> déjà de quoi construire `friendRows` — utiliser **cette même source**, pas une
> nouvelle. Si elle n'expose que les identifiants en ligne, prendre la liste
> d'amis complète d'où `friendRows` la tire.

- [ ] **Step 3: L'image**

Dans la fonction appelée chaque image, **après** `scene.setPlayerAt(walkAt, walkYaw)` — l'ordre compte : `poseInRoom` lit la matrice que `setPlayerAt` vient de changer :

```ts
    if (avatars) {
      const now = performance.now();

      if (inSharedLobby && now - posedAt >= POSE_INTERVAL_MS) {
        const pose = scene.poseInRoom();
        // `null` veut dire « redemande », pas « pas de pose » : on saute
        // l'envoi de cette image et on réessaie à la suivante.
        if (pose) {
          myPose = pose.head;
          posedAt = now;
          $socket?.emit('vr:pose', { head: pose.head, left: pose.left, right: pose.right });
        }
      }

      // Mis à jour à CHAQUE image, même sans envoi : c'est l'interpolation qui
      // fait qu'une tête ne saute pas, et elle a besoin d'être rejouée à la
      // cadence du rendu, pas à celle du réseau.
      avatars.update(roster.at(now), myPose);
    }
```

avec, au niveau module :

```ts
  /** Quinze poses par seconde : la cadence du battement serveur. */
  const POSE_INTERVAL_MS = 66;
```

- [ ] **Step 4: La partie**

Trouver l'endroit qui déclenche le fondu du rideau vers `'dark'` au démarrage d'une partie, et celui qui le ramène vers `'decor'` en sortie. **Ne pas s'accrocher à `panelsVisible(false)`** : il a six sites d'appel dont la plupart sont des ouvertures de menu, et les amis disparaîtraient dès qu'on ouvre les options.

Au fondu vers `'dark'` :

```ts
    // On quitte le lobby partagé en lançant. Le rideau nous cache le décor de
    // toute façon, et un ami à moins de cinq mètres cinquante serait DEDANS,
    // donc flottant dans le noir à côté de l'écran.
    if (inSharedLobby) {
      $socket?.emit('vr:leave');
      inSharedLobby = false;
      roster = createRoster();
      avatars?.update(new Map(), myPose);
    }
```

Au retour vers `'decor'` :

```ts
    if (!inSharedLobby) {
      $socket?.emit('vr:enter');
      inSharedLobby = true;
    }
```

- [ ] **Step 5: La sortie**

Dans `teardown()`, à côté des autres `off` :

```ts
    if (inSharedLobby) $socket?.emit('vr:leave');
    inSharedLobby = false;
    $socket?.off('vr:lobby', handleVrLobby);
    avatars?.dispose();
    avatars = null;
    roster = createRoster();
    myPose = null;
```

> **`$socket?.off('vr:lobby', handleVrLobby)` avec la référence**, jamais
> `$socket?.off('vr:lobby')` seul : le commentaire de `VrShell.svelte:3256`
> raconte qu'un `off` sans référence avait arraché les écouteurs de
> `FriendsList` par la même occasion.

- [ ] **Step 6: Vérifier la compilation et les suites**

Run: `cd frontend && bun run check`
Expected: 0 erreur.

Run: `cd frontend && bun run build`
Expected: succès.

Run: `bun run test:ui`
Expected: même total qu'à la fin de la Task 7, 0 fail.

Run: `bun run test:backend`
Expected: 395, 0 fail.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/components/VrShell.svelte
git commit -m "$(cat <<'EOF'
Brancher le lobby partagé, et le débrancher pendant une partie

Rien n'est attendu à l'entrée : pas de socket, pas de lobby partagé, et la VR
solo marche quand même.

Les avatars sont rafraîchis à chaque image et la pose n'est émise que quinze
fois par seconde. Les deux cadences sont différentes exprès - c'est
l'interpolation qui empêche une tête de sauter, et elle doit être rejouée au
rythme du rendu, pas à celui du réseau.

Le départ s'accroche au fondu du rideau et non à `panelsVisible(false)`, qui a
six sites d'appel dont la plupart sont des ouvertures de menu : s'y accrocher
ferait disparaître les amis dès qu'on ouvre les options. Et pendant une partie
le rideau nous cache le décor de toute façon - un ami à moins de cinq mètres
cinquante serait dedans, flottant dans le noir à côté de l'écran.

Le `off` cite sa fonction : un `off` sans référence avait déjà arraché les
écouteurs de FriendsList par la même occasion.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Vérification dans un vrai navigateur, à deux joueurs

**Files:** aucun (sauf correctifs).

**Pourquoi cette tâche existe :** tout ce qui précède est vert sans qu'un seul avatar ait jamais été dessiné. Les tests ne compilent aucun maillage et ne montent aucune session XR — ce dépôt a déjà constaté « 1234 assertions, zéro shader compilé ».

- [ ] **Step 1: Vérifier que la pile tourne**

Run: `ss -lptnH 'sport = :3000 or sport = :5276'`
Expected: les deux écoutent. Sinon, relancer selon `docs/superpowers/plans/` — recette dans la mémoire projet « running-the-app-from-a-worktree » : Redis en conteneur, backend sur **:3000** (le client code ce port en dur en dev), `FRONTEND_URL=http://localhost:5276`, front via `vite.worktree.config.ts` lancé avec le node de nvm (`npx` nu est celui de Windows et échoue en « Maximum call stack size exceeded »).

- [ ] **Step 2: Deux joueurs, deux contextes**

Ouvrir deux contextes de navigateur distincts, connecter deux comptes **amis acceptés**, et entrer en VR des deux côtés (émulateur WebXR — voir la mémoire « driving-the-webxr-emulator » : un port de pont par machine, et un clic humain pour ouvrir la session).

- [ ] **Step 3: Les six observations qui valident**

1. Chacun voit l'autre. Une tête, deux mains, un pseudo lisible.
2. Quand A marche, sa tête bouge **de la même distance et dans le même sens** chez B. C'est le test du repère : si A avance de deux mètres vers le comptoir, B doit le voir avancer de deux mètres vers le comptoir.
3. Quand A tourne la tête de 180°, B la voit faire un demi-tour **continu**, sans passer par l'autre côté. C'est le slerp.
4. Quand A s'approche de B à moins de cinquante centimètres, A cesse de voir B, avec un fondu et non une disparition sèche.
5. Quand A monte sur un tuyau, B le voit **sur le tuyau**, pas au sol.
6. Quand A lance une partie, son avatar s'efface chez B, et le panneau Amis de B dit le nom du jeu. À la sortie de partie, il revient.

- [ ] **Step 4: Lire le journal du backend**

Le journal du conteneur backend porte les lignes `VrLobby`. Vérifier qu'un `vr:enter` est bien journalisé pour chaque joueur, et qu'aucun « identifiant inconnu, ignoré » ne défile — ce dernier voudrait dire que le magasin d'amis du composant n'est pas la bonne source.

Rappel de la mémoire projet : **le rapatriement des logs client ne s'arme qu'avec un compte connecté et non anonyme**. Sans connexion, le journal reste muet et on croit la pile cassée.

- [ ] **Step 5: Ne rien conclure sans avoir vu**

Si une observation échoue, **ne pas raisonner par lecture du code** — invoquer `superpowers:systematic-debugging`. Le repère en particulier a déjà coûté quatre erreurs de signe à ce dépôt, et la quatrième est la plus instructive : la fonction pure était juste, et c'est la jointure qui mentait.

- [ ] **Step 6: Commit des correctifs éventuels, puis arrêt**

Ne pas pousser et ne pas ouvrir de PR sans accord explicite du propriétaire.

---

## Auto-revue

**Couverture de la spec :**

| Section de la spec | Tâche |
|---|---|
| §1 chevauchement accepté + effacement | 2 |
| §1 tête + deux mains | 3, 7 |
| §1 sortie du lobby en partie | 8 |
| §1 « en VR » dans les deux listes | 5 |
| §2 repère du décor, `poseInRoom`, `updateMatrixWorld` | 6 |
| §2 hauteur comparable | 6 (portée gratuitement par `worldToLocal`) |
| §3 les quatre messages | 4 |
| §3 pas de relais, départ = absence, pas de pseudo, pas de `t` | 4, 1 |
| §3 auto-exclusion, `vr:enter` idempotent | 4 |
| §3 `inVr` sur les deux canaux d'amis | 5 |
| §4 cache d'amis, battement armé/désarmé, plafond, trois portes de sortie | 4 |
| §5 `roster`, `proximity`, `avatar-art`, `avatars` | 1, 2, 3, 7 |
| §5 raccordement, fondu du rideau | 8 |
| §5 page à plat + i18n | 5 |
| §6 les cinq cas d'erreur | 4 (formes, plafond), 7 (id inconnu), 8 (socket absent, `null`) |
| §7 les cinq fichiers de test + `test:ui` | 1, 2, 3, 4, 5 |
| §8 hors périmètre | aucune tâche, volontairement |

Aucun trou.

**Note sur les totaux de test :** les chiffres attendus aux Tasks 1-3 sont donnés à titre de contrôle. Ce qui compte n'est pas de tomber sur le nombre exact mais que le total **bouge** de ce qu'on vient d'ajouter. Un total inchangé est le symptôme d'un fichier absent de `test:ui`, et c'est le seul symptôme qu'il ait.
