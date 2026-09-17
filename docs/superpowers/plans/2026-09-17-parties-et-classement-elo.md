# Enregistrer les parties et classer à l'Elo — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enregistrer une ligne par KO dans une table `Match`, et en dériver une cote Elo par joueur et par jeu — après avoir posé la garde sans laquelle ces lignes seraient fausses.

**Architecture :** Une garde d'activité par port vit dans `MatchObserver`, nourrie à chaque image par les masques de manette que `session.ts` élargit son rappel `onFrame` pour porter. Un module de câblage unique sert les trois présentations lockstep (page plate, VR) et rapporte au serveur, qui dérive lui-même l'identité des joueurs depuis le salon, déduplique les deux rapports sur `(sessionId, frame)` et rejoue tout l'historique du jeu pour réécrire les cotes.

**Tech Stack :** TypeScript, Svelte 4, Bun, bun:sqlite, socket.io, `node:test` + `node:assert/strict`.

**Spec :** `docs/superpowers/specs/2026-09-17-parties-et-classement-elo-design.md`

## Global Constraints

- **Rien dans `match-watch.ts` ni dans le module de câblage ne peut émettre, recevoir ou écrire vers le cœur.** Un guetteur qui touche la machine est une seconde voie d'entrée dans une session lockstep, ce que le netcode ne survit pas. Le rapport au serveur part du câblage, jamais de l'observateur.
- **Elo : `INITIAL_RATING = 1000`, `K_FACTOR = 32`, double KO = 0,5 à chacun.** Le delta est arrondi **une fois** puis appliqué en plus à l'un et en moins à l'autre, ce qui garde les cotes entières et la somme exactement conservée.
- **La garde est un fait, pas un réglage.** « Zéro appui du port sur tout le combat ». Aucune constante réglable, aucun seuil `N`.
- **`FIGHT_BUTTONS` exclut `START` et `SELECT`**, et rien d'autre. L et R sont des boutons de combat dans Super Butouden 2.
- **Prochaine migration : `0008`.** `main` a pris 0006 et 0007. `backend/src/db/migrate.ts` compare le schéma vivant à ce que produisent les migrations et refuse de démarrer sur un écart : le SQL doit être exact.
- **Les dates sont des millisecondes epoch écrites par le code appelant.** Jamais `DEFAULT CURRENT_TIMESTAMP`, qui insérerait du texte là où tout ce schéma met des nombres.
- **Un fichier `core/test/*.test.ts` neuf ne tourne pas tant qu'il n'est pas nommé dans le script `test:ui` du `package.json` racine.** `backend/test/*.test.ts` est un glob et s'auto-énumère : le piège ne concerne que `core/test`.
- **Imports depuis `core/test` :** chemins relatifs avec extension `.js`, jamais l'alias `$lib` — ces tests tournent sous node nu et ne résolvent pas l'alias de SvelteKit.
- **Commandes :** `bun run test:ui`, `bun run test:backend` depuis la racine ; `bun run db:migrate` depuis `backend/`. Jamais `npx tsx`, qui échoue depuis le passage à Bun.

---

## Structure des fichiers

| fichier | responsabilité |
|---|---|
| `frontend/src/lib/games/match-watch.ts` | **modifié.** La machine à états gagne l'activité par port et la garde |
| `frontend/src/lib/games/match-recorder.ts` | **créé.** Le câblage guetteur + notification + rapport, partagé par les trois présentations |
| `frontend/src/lib/znet/session.ts` | **modifié.** `onFrame` porte les deux masques |
| `frontend/src/lib/rooms/lockstep-engine.ts` | **modifié.** Idem, relayé jusqu'à la VR |
| `frontend/src/lib/components/LockstepRoom.svelte` | **modifié.** Appelle le module partagé |
| `frontend/src/lib/components/VrShell.svelte` | **modifié.** Idem, via l'engine |
| `frontend/src/lib/components/SoloRoom.svelte` | **modifié.** N'arme plus du tout |
| `backend/migrations/0008_match_ratings.sql` | **créé.** Les deux tables |
| `backend/src/ratings/elo.ts` | **créé.** La formule, pure, sans base |
| `backend/src/db/matches.ts` | **créé.** Insertion, déduplication, recalcul |
| `backend/src/rooms/play-session.ts` | **créé.** L'estampille de session, posée en un seul endroit |
| `backend/src/websocket/match-handlers.ts` | **créé.** L'événement `match:report` |

---

### Task 1 : La garde d'activité dans `MatchObserver`

**Files:**
- Modify: `frontend/src/lib/games/match-watch.ts`
- Test: `core/test/match-watch.test.ts` (existe déjà, déjà nommé dans `test:ui`)

**Interfaces:**
- Consumes: `PAD`, `PadMask` depuis `frontend/src/lib/znet/protocol.ts` (aucun import interne dans ce fichier, donc résoluble sous node).
- Produces: `MatchObserver.note(pad1: PadMask, pad2: PadMask): void`, à appeler **à chaque image, avant `observe(frame)`**.

- [ ] **Step 1 : Écrire les tests qui échouent**

À ajouter à la fin de `core/test/match-watch.test.ts`. Le helper `replay` existant ne passe pas de pads : en écrire un second à côté, plutôt que de changer celui que les tests existants utilisent.

```ts
/* ------------------------------------------------ la garde d'activité */

/** Comme `replay`, mais en poussant un masque de manette par image. */
function replayWithPads(
  frames: Uint8Array[],
  pads: [number, number][],
  sampleEvery = 1
): MatchVerdict[] {
  const verdicts: MatchVerdict[] = [];
  let current = frames[0];
  const observer = new MatchObserver({
    watcher: watcherFor(DBZ2)!,
    readWram: () => current,
    onVerdict: (verdict) => verdicts.push(verdict),
    sampleEvery
  });

  for (let frame = 0; frame < frames.length; frame++) {
    current = frames[frame];
    observer.note(pads[frame][0], pads[frame][1]);
    observer.observe(frame);
  }
  return verdicts;
}

/**
 * Plein, entamé, puis le port 2 à zéro : un KO du port 1 sur trois images.
 *
 * L'image du milieu n'est délibérément PAS à pleine vie. La branche qui arme
 * se reprend à chaque échantillon où les deux barres sont pleines et remet
 * l'activité à zéro : avec deux images pleines d'affilée, il ne resterait
 * qu'une seule image pour prouver quoi que ce soit, et chaque test serait à un
 * appui près de ne plus rien dire.
 */
const KO_OF_P2 = [ram(100, 100, 100, 100), ram(100, 90, 100, 40), ram(100, 80, 100, 0)];

test('un port muet pendant tout le combat ne produit aucun verdict', () => {
  const verdicts = replayWithPads(KO_OF_P2, [[PAD.A, 0], [PAD.B, 0], [PAD.A, 0]]);
  assert.deepEqual(verdicts, []);
});

test('les deux ports actifs produisent le verdict', () => {
  // Les appuis comptés sont ceux d'APRÈS la dernière image de pleine vie.
  const verdicts = replayWithPads(KO_OF_P2, [[0, 0], [0, PAD.B], [PAD.A, 0]]);
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0].winner, 1);
});

test('START et SELECT ne sont pas des appuis de combat', () => {
  const pads: [number, number][] = [
    [PAD.A, PAD.START],
    [PAD.A, PAD.SELECT],
    [PAD.A, PAD.START | PAD.SELECT]
  ];
  assert.deepEqual(replayWithPads(KO_OF_P2, pads), []);
});

test('les gâchettes en sont, elles', () => {
  const verdicts = replayWithPads(KO_OF_P2, [[0, 0], [PAD.L, 0], [0, PAD.R]]);
  assert.equal(verdicts.length, 1);
});

test('un appui avant que le combat s’arme ne compte pas', () => {
  // Le port 2 joue pendant les menus, puis se tait dès que les deux barres
  // sont pleines : c’est le joueur qui repose sa manette avant le round.
  const frames = [ram(100, 40, 100, 90), ...KO_OF_P2];
  const pads: [number, number][] = [[0, PAD.A], [PAD.A, 0], [PAD.B, 0], [PAD.A, 0]];
  assert.deepEqual(replayWithPads(frames, pads), []);
});

test('un appui entre deux échantillons compte quand même', () => {
  // La raison d’être de `note()` : `observe()` ne lit la RAM qu’une image sur
  // 30, et l’unique appui du port 2 tombe sur une image non échantillonnée.
  const frames: Uint8Array[] = [];
  const pads: [number, number][] = [];
  for (let f = 0; f < 61; f++) {
    frames.push(f < 60 ? ram(100, 100, 100, 100) : ram(100, 80, 100, 0));
    pads.push([PAD.A, f === 45 ? PAD.B : 0]);
  }
  const verdicts = replayWithPads(frames, pads, 30);
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0].winner, 1);
});

test('un combat refusé ne compte pas non plus au score courant', () => {
  const verdicts: MatchVerdict[] = [];
  let wram = ram(100, 100, 100, 100);
  const observer = new MatchObserver({
    watcher: watcherFor(DBZ2)!,
    readWram: () => wram,
    onVerdict: (verdict) => verdicts.push(verdict),
    sampleEvery: 1
  });

  // Armer pour de bon - deux barres pleines - puis un KO que seul le port 1 a
  // joué. Sans l'armement, la machine sortirait sur `!armed` et ce test
  // passerait sans jamais atteindre la garde.
  observer.note(PAD.A, 0);
  observer.observe(0);
  wram = ram(100, 80, 100, 0);
  observer.note(PAD.A, 0);
  observer.observe(1);

  assert.deepEqual(verdicts, []);
  assert.deepEqual([...observer.score], [0, 0]);
  assert.equal(observer.draws, 0);
});
```

Ajouter `PAD` à l'import en tête de fichier :

```ts
import { PAD } from '../../frontend/src/lib/znet/protocol.js';
```

- [ ] **Step 2 : Lancer les tests et vérifier qu'ils échouent**

Run: `bun test core/test/match-watch.test.ts`
Expected: FAIL — `observer.note is not a function`.

- [ ] **Step 3 : Implémenter la garde**

Dans `frontend/src/lib/games/match-watch.ts`, ajouter l'import en tête :

```ts
import { PAD, type PadMask } from '../znet/protocol.js';
```

Puis, sous la constante `DEFAULT_SAMPLE_EVERY` :

```ts
/**
 * Les boutons avec lesquels on se bat.
 *
 * START et SELECT en sont exclus : ils servent à passer les écrans et à mettre
 * en pause, jamais à frapper. Les garder ferait passer la garde à un joueur 2
 * qui pianote pour sauter un dialogue, ce qui est exactement le faux positif
 * qu'elle existe pour attraper.
 *
 * Tout le reste compte, gâchettes comprises : dans Super Butouden 2, L et R
 * sont des boutons de combat.
 */
const FIGHT_BUTTONS = ~(PAD.SELECT | PAD.START);
```

Dans la classe, à côté de `armed` :

```ts
	/**
	 * Quels ports ont joué depuis que le combat s'est armé.
	 *
	 * Ici et pas dans un filtre posé sur le verdict, pour deux raisons qui se
	 * cumulent : la fenêtre est celle du combat et seul `armed` sait où elle
	 * commence, et un appui doit être compté à chaque image alors que la RAM
	 * n'est lue qu'une image sur trente.
	 */
	private activity: [boolean, boolean] = [false, false];
```

La méthode, au-dessus d'`observe` :

```ts
	/**
	 * Appelée à chaque image, avant `observe`.
	 *
	 * Deux `|=` sur des entiers masqués : c'est tout le coût sur la boucle
	 * chaude. L'ordre compte à l'image du verdict - un appui de cette image-là
	 * doit être compté avant d'être jugé.
	 */
	note(pad1: PadMask, pad2: PadMask): void {
		if ((pad1 & FIGHT_BUTTONS) !== 0) this.activity[0] = true;
		if ((pad2 & FIGHT_BUTTONS) !== 0) this.activity[1] = true;
	}
```

Dans `observe`, la branche qui arme gagne la remise à zéro :

```ts
		if (this.isFull(sample.p1) && this.isFull(sample.p2)) {
			this.armed = true;
			// Cette branche se reprend à chaque échantillon de pleine vie, donc
			// l'activité ne compte qu'à partir du dernier : les appuis dans les
			// menus qui précèdent le round sont écartés gratuitement.
			this.activity = [false, false];
			return;
		}
```

Et la branche du verdict gagne la garde, juste après la libération d'`armed` :

```ts
		this.armed = false;

		// Un port qui n'a pressé aucun bouton de combat n'a pas joué : ni le
		// processeur du mode histoire, ni le joueur 2 qui n'a pas touché sa
		// manette. Avant `wins++` comme avant `onVerdict` - un combat qui n'a
		// pas eu lieu ne compte pas non plus au score courant. `armed` s'est
		// libéré quand même : le combat est fini quelle que soit la garde.
		if (!this.activity[0] || !this.activity[1]) return;

		const winner: 0 | 1 | 2 = p1Down && p2Down ? 0 : p1Down ? 2 : 1;
```

Enfin, corriger l'en-tête du fichier : il énonce deux règles, il en énonce trois. Ajouter après le paragraphe « Zero health is not the end of a match » :

```
 * **Both ports must have played.** Health alone cannot tell a versus from a
 * story mode - the computer's bar empties exactly like a player's - nor from a
 * match where the second pad was never touched. The discriminant is the
 * inputs, and it is the right one for a second reason: inputs are what lockstep
 * guarantees identical on both peers, so the guard costs the verdict none of
 * its silence.
```

- [ ] **Step 4 : Lancer les tests et vérifier qu'ils passent**

Run: `bun test core/test/match-watch.test.ts`
Expected: PASS, y compris les tests préexistants — ceux-ci n'appellent pas `note()`, donc leurs verdicts doivent maintenant être refusés. **S'ils échouent, c'est attendu : les mettre à jour en appelant `note(PAD.A, PAD.B)` avant chaque `observe` dans le helper `replay` existant**, ce qui préserve exactement ce qu'ils testaient (la machine à états) sans les faire tester la garde.

- [ ] **Step 5 : Lancer la suite complète**

Run: `bun run test:ui`
Expected: PASS.

- [ ] **Step 6 : Commit**

```bash
git add frontend/src/lib/games/match-watch.ts core/test/match-watch.test.ts
git commit -m "Refuser le verdict d'un combat que les deux ports n'ont pas joué"
```

---

### Task 2 : Les masques de manette jusqu'au guetteur

**Files:**
- Modify: `frontend/src/lib/znet/session.ts:173,297,405,833`
- Modify: `frontend/src/lib/rooms/lockstep-engine.ts:80,149-151`
- Test: `core/test/lockstep-engine.test.ts` (existe, déjà dans `test:ui`)

**Interfaces:**
- Produces: `onFrame(frame: number, pad1: PadMask, pad2: PadMask)` sur `NetplaySession`, et `onFrame(core: PsnesCore, frame: number, pad1: number, pad2: number)` sur `LockstepEngineOptions`.

- [ ] **Step 1 : Écrire le test qui échoue**

À ajouter à `core/test/lockstep-engine.test.ts`. Ce fichier utilise `bun:test` et non `node:test`, et son `harness()` garde déjà l'objet d'options que l'engine a remis à `NetplaySession` — c'est par là qu'on atteint le rappel réel.

```ts
test('les masques de manette traversent le rappel d’image', async () => {
  const { options, session } = harness();
  const seen: [number, number, number][] = [];
  options.onFrame = (_c: unknown, frame: number, pad1: number, pad2: number) =>
    seen.push([frame, pad1, pad2]);

  const engine = await createLockstepEngine(options);

  // Le rappel tel que l'engine l'a donné à la session, appelé comme la session
  // l'appellera : c'est la couture que `makeSession` existe pour offrir.
  const onFrame = session()!.onFrame as (f: number, p1: number, p2: number) => void;
  onFrame(42, 0x0101, 0x0202);

  assert.deepEqual(seen, [[42, 0x0101, 0x0202]]);
  await engine.stop();
});
```

- [ ] **Step 2 : Lancer le test et vérifier qu'il échoue**

Run: `bun test core/test/lockstep-engine.test.ts`
Expected: FAIL — `pad1` et `pad2` sont `undefined`.

- [ ] **Step 3 : Élargir la chaîne**

`frontend/src/lib/znet/session.ts`, quatre points :

```ts
// l. 173, dans les options
	onFrame?: (frame: number, pad1: PadMask, pad2: PadMask) => void;

// l. 297, le champ
	private onFrame: (frame: number, pad1: PadMask, pad2: PadMask) => void;

// l. 405, le défaut
		this.onFrame = options.onFrame ?? (() => {});

// l. 833, l'appel — `pad1` et `pad2` sont déjà en portée depuis la l. 820
		this.onFrame(this.frame, pad1, pad2);
```

`frontend/src/lib/rooms/lockstep-engine.ts` :

```ts
// l. 80
	onFrame(core: PsnesCore, frame: number, pad1: number, pad2: number): void;

// l. 149-151
		onFrame: (frame: number, pad1: number, pad2: number) => {
			try {
				options.onFrame(core, frame, pad1, pad2);
				audio.push(core.audio());
			} catch (err) {
				onError(err);
			}
		}
```

`solo.ts` **n'est pas touché** : la solo room cesse d'armer en Task 4, donc rien ne consomme les pads sur ce chemin.

- [ ] **Step 4 : Lancer les tests et vérifier qu'ils passent**

Run: `bun test core/test/lockstep-engine.test.ts`
Expected: PASS.

- [ ] **Step 5 : Vérifier que le netcode n'a rien perdu**

Run: `bun run test:netplay`
Expected: PASS. `onFrame` est sur la boucle chaude ; ces suites sont ce qui prouve qu'elle n'a pas bougé.

- [ ] **Step 6 : Commit**

```bash
git add frontend/src/lib/znet/session.ts frontend/src/lib/rooms/lockstep-engine.ts core/test/lockstep-engine.test.ts
git commit -m "Porter les deux masques de manette jusqu'au rappel d'image"
```

---

### Task 3 : Le module de câblage partagé

**Files:**
- Create: `frontend/src/lib/games/match-recorder.ts`
- Create: `core/test/match-recorder.test.ts`
- Modify: `package.json` (script `test:ui`)

**Interfaces:**
- Consumes: `MatchObserver`, `watcherFor` (Task 1) ; `verdictMessage` de `rooms/match-report.ts`.
- Produces:
  ```ts
  export interface MatchRecorderPorts {
    crc32: string | null | undefined;
    wram: () => Uint8Array;
    announce: (verdict: MatchVerdict, score: readonly [number, number]) => void;
    report: (verdict: MatchVerdict) => void;
  }
  export interface MatchRecorder {
    onFrame(frame: number, pad1: PadMask, pad2: PadMask): void;
  }
  export function createMatchRecorder(ports: MatchRecorderPorts): MatchRecorder | null;
  ```

- [ ] **Step 1 : Écrire les tests qui échouent**

Créer `core/test/match-recorder.test.ts` :

```ts
/**
 * Le câblage du guetteur, une fois pour les trois présentations.
 *
 * Il a existé en deux copies identiques dans deux composants, et une
 * troisième présentation - la VR, qui passe par `rooms/lockstep-engine.ts` -
 * n'en avait aucune : un versus en casque ne comptait pas, sans que rien ne le
 * dise. C'est ce fichier qui rend cette situation impossible à reproduire.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createMatchRecorder } from '../../frontend/src/lib/games/match-recorder.js';
import type { MatchVerdict } from '../../frontend/src/lib/games/match-watch.js';
import { PAD } from '../../frontend/src/lib/znet/protocol.js';

const DBZ2 = '8F24F886';

function ram(p1max: number, p1: number, p2max: number, p2: number): Uint8Array {
  const w = new Uint8Array(128 * 1024);
  const put = (at: number, value: number) => {
    w[at] = value & 0xff;
    w[at + 1] = (value >> 8) & 0xff;
  };
  put(0x0560, p1max);
  put(0x0562, p1);
  put(0x0660, p2max);
  put(0x0662, p2);
  return w;
}

test('une ROM non mesurée ne donne aucun enregistreur', () => {
  assert.equal(
    createMatchRecorder({
      crc32: 'DEADBEEF',
      wram: () => ram(100, 100, 100, 100),
      announce: () => {},
      report: () => {}
    }),
    null
  );
});

test('un salon sans checksum non plus', () => {
  assert.equal(
    createMatchRecorder({
      crc32: null,
      wram: () => ram(100, 100, 100, 100),
      announce: () => {},
      report: () => {}
    }),
    null
  );
});

test('un KO joué des deux côtés est annoncé et rapporté une fois', () => {
  const announced: MatchVerdict[] = [];
  const reported: MatchVerdict[] = [];
  let wram = ram(100, 100, 100, 100);
  const recorder = createMatchRecorder({
    crc32: DBZ2,
    wram: () => wram,
    announce: (verdict) => announced.push(verdict),
    report: (verdict) => reported.push(verdict)
  })!;

  // Le guetteur échantillonne une image sur 30 : rester sur des multiples.
  // L'image 0 arme et remet l'activité à zéro, donc ce sont les manettes de
  // l'image 30 qui doivent porter les deux appuis.
  recorder.onFrame(0, PAD.A, PAD.B);
  wram = ram(100, 80, 100, 0);
  recorder.onFrame(30, PAD.A, PAD.B);

  assert.equal(announced.length, 1);
  assert.equal(reported.length, 1);
  assert.equal(reported[0].winner, 1);
});

test('la garde vaut aussi pour le rapport, pas seulement pour la notification', () => {
  const reported: MatchVerdict[] = [];
  let wram = ram(100, 100, 100, 100);
  const recorder = createMatchRecorder({
    crc32: DBZ2,
    wram: () => wram,
    announce: () => {},
    report: (verdict) => reported.push(verdict)
  })!;

  recorder.onFrame(0, PAD.A, 0);
  wram = ram(100, 80, 100, 0);
  recorder.onFrame(30, PAD.A, 0);

  assert.deepEqual(reported, []);
});

test('le score annoncé est celui de l’observateur qui a produit le verdict', () => {
  const scores: (readonly [number, number])[] = [];
  let wram = ram(100, 100, 100, 100);
  const recorder = createMatchRecorder({
    crc32: DBZ2,
    wram: () => wram,
    announce: (_verdict, score) => scores.push(score),
    report: () => {}
  })!;

  recorder.onFrame(0, PAD.A, PAD.B);
  wram = ram(100, 80, 100, 0);
  recorder.onFrame(30, PAD.A, PAD.B);
  wram = ram(100, 100, 100, 100);
  recorder.onFrame(60, PAD.A, PAD.B);
  wram = ram(100, 0, 100, 60);
  recorder.onFrame(90, PAD.A, PAD.B);

  assert.deepEqual([...scores[0]], [1, 0]);
  assert.deepEqual([...scores[1]], [1, 1]);
});
```

- [ ] **Step 2 : Nommer le fichier dans `test:ui`**

Sans ça il ne tournera **jamais**. Dans le `package.json` racine, ajouter `core/test/match-recorder.test.ts` à la liste du script `test:ui`, à côté de `core/test/match-watch.test.ts`.

- [ ] **Step 3 : Lancer le test et vérifier qu'il échoue**

Run: `bun test core/test/match-recorder.test.ts`
Expected: FAIL — le module n'existe pas.

- [ ] **Step 4 : Écrire le module**

Créer `frontend/src/lib/games/match-recorder.ts` :

```ts
/**
 * Le guetteur, sa notification et son rapport — une fois pour les trois
 * présentations.
 *
 * Il y en avait deux copies identiques, dans `SoloRoom.svelte` et
 * `LockstepRoom.svelte`, et une troisième présentation qui n'en avait aucune :
 * `VrShell.svelte` passe par `rooms/lockstep-engine.ts`, donc un versus joué
 * en casque ne comptait pas et rien ne le disait. Un module, trois appelants,
 * et la prochaine présentation hérite du comportement au lieu de le recopier.
 *
 * Rien ici n'émet vers le cœur ni ne lit un store : les quatre ports sont
 * passés par l'appelant, ce qui rend la règle testable depuis `core/test` sous
 * node nu - et ce qui garantit que l'observateur reste en lecture seule, la
 * propriété dont dépend tout le reste.
 *
 * Réserve honnête sur la VR : la couverture y est juste par construction et
 * non par observation, #62 rapportant que le lancement d'une partie en casque
 * échoue en production.
 */

import { MatchObserver, watcherFor, type MatchVerdict } from './match-watch.js';
import type { PadMask } from '../znet/protocol.js';

export interface MatchRecorderPorts {
	/** Le checksum du jeu, ou null quand le salon n'en porte pas. */
	crc32: string | null | undefined;
	/**
	 * La mémoire du cœur, pas une copie. La vue n'est valable que jusqu'à
	 * l'appel suivant au cœur, d'où une fonction plutôt qu'un tableau.
	 */
	wram: () => Uint8Array;
	/** Dire le vainqueur au joueur. */
	announce: (verdict: MatchVerdict, score: readonly [number, number]) => void;
	/** Dire le vainqueur au serveur. */
	report: (verdict: MatchVerdict) => void;
}

export interface MatchRecorder {
	/** À appeler à chaque image, depuis le rappel de la session. */
	onFrame(frame: number, pad1: PadMask, pad2: PadMask): void;
}

/** Un enregistreur pour cette cartouche, ou null pour toute ROM non mesurée. */
export function createMatchRecorder(ports: MatchRecorderPorts): MatchRecorder | null {
	const watcher = ports.crc32 ? watcherFor(ports.crc32) : null;
	if (!watcher) return null;

	// Nommé plutôt que retourné directement, pour que la notification lise le
	// score sur l'observateur qui a produit le verdict et non sur ce que le
	// champ d'un composant contient au moment où elle part.
	const observer: MatchObserver = new MatchObserver({
		watcher,
		readWram: ports.wram,
		onVerdict: (verdict) => {
			ports.announce(verdict, observer.score);
			ports.report(verdict);
		}
	});

	return {
		onFrame(frame, pad1, pad2) {
			// `note` avant `observe` : un appui de cette image doit être compté
			// avant d'être jugé.
			observer.note(pad1, pad2);
			observer.observe(frame);
		}
	};
}
```

- [ ] **Step 5 : Lancer les tests et vérifier qu'ils passent**

Run: `bun test core/test/match-recorder.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6 : Vérifier que le fichier tourne bien dans la suite**

Run: `bun run test:ui`
Expected: PASS, et le **nombre de fichiers** doit avoir augmenté de un. Vérifier ce nombre, pas seulement la couleur.

- [ ] **Step 7 : Commit**

```bash
git add frontend/src/lib/games/match-recorder.ts core/test/match-recorder.test.ts package.json
git commit -m "Réunir le câblage du guetteur en un module pour les trois salons"
```

---

### Task 4 : Brancher les trois présentations

**Files:**
- Modify: `frontend/src/lib/components/LockstepRoom.svelte:30,158,649,658,1268-1287,1290`
- Modify: `frontend/src/lib/components/VrShell.svelte:2267,2920`
- Modify: `frontend/src/lib/components/SoloRoom.svelte:35,127,545,567,786-803,807`
- Modify: `frontend/src/lib/rooms/match-report.ts` (en-tête)

**Interfaces:**
- Consumes: `createMatchRecorder` (Task 3), `onFrame(core, frame, pad1, pad2)` (Task 2).
- Produces: rien de nouveau. `report` est branché sur un `() => {}` ici ; la Task 8 y met l'émission socket.

- [ ] **Step 1 : `LockstepRoom.svelte`**

Remplacer l'import l. 30 :

```ts
  import { createMatchRecorder, type MatchRecorder } from '$lib/games/match-recorder';
  import { verdictMessage } from '$lib/rooms/match-report';
```

Le champ l. 158 :

```ts
  let matchWatch: MatchRecorder | null = null;
```

Le rappel l. 643-650 :

```ts
        onFrame: (frame, pad1, pad2) => {
          renderer!.draw(core!);
          audio!.push(core!.audio());
          // Read-only, off the emulation path, and on a schedule of its own -
          // the same rule the renderer obeys, for the same reason.
          matchWatch?.onFrame(frame, pad1, pad2);
        }
```

La construction l. 658 :

```ts
      matchWatch = createMatchRecorder({
        crc32: gameCrc32,
        wram: () => core!.wram(),
        announce: (verdict, score) =>
          notifications.show(verdictMessage($language, verdict, score), 'info', 5000),
        // Branché en Task 8.
        report: () => {}
      });
```

Supprimer entièrement la fonction locale `createMatchWatch()` (l. 1268-1287).

- [ ] **Step 2 : `SoloRoom.svelte` — ne plus armer**

Supprimer l'import l. 35, le champ l. 127, l'affectation l. 545, l'appel `matchWatch?.observe(frame)` l. 567, la fonction `createMatchWatch()` l. 786-803, et la remise à null l. 807.

Laisser `import { verdictMessage }` **seulement s'il reste utilisé** ; sinon le supprimer aussi.

Ajouter, à l'endroit d'où la construction disparaît, le commentaire qui empêche que ça revienne par inadvertance :

```ts
      // Pas de guetteur ici, et c'est une décision. Un versus à deux manettes
      // sur un seul compte est légitime - `pad2` ci-dessous le distingue déjà -
      // mais il n'y a personne à qui annoncer le vainqueur, et pour l'Elo c'est
      // un seul compte pour deux ports, donc non classable. Si la notification
      // revient un jour, c'est cette condition-là qui la garde.
```

- [ ] **Step 3 : `VrShell.svelte`**

Aux deux appels `onFrame` (l. 2267 et 2920), élargir la signature et relayer. Lire les deux sites avant d'éditer : le premier est le chemin solo (`createSoloEngine`, qui **n'arme pas** — le laisser tel quel), le second le chemin lockstep (`createLockstepEngine`). Seul le second reçoit l'enregistreur, sur le modèle de `LockstepRoom` ci-dessus.

- [ ] **Step 4 : Corriger l'en-tête de `rooms/match-report.ts`**

Il affirme le contraire de ce qui est vrai désormais. Remplacer le deuxième paragraphe :

```
 * The verdict itself is a display detail, and deliberately so: nothing in the
 * schema records a match result, and inventing a table for the first game whose
 * memory layout has been read would be a migration paid for one row of
 * addresses. A toast and a running score for as long as the room is open is the
 * whole of it, and it costs a store nothing.
```

par :

```
 * This is the wording only. The schema does record match results now - see
 * `db/matches.ts` and migration 0008 - and the toast is one of two things a
 * verdict feeds, the other being the report that lands in that table. What
 * stays true is that the score shown here lives and dies with the room: the
 * standing a player carries between rooms is their rating, not this count.
```

- [ ] **Step 5 : Vérifier que rien n'est cassé**

Run: `bun run test:ui`
Expected: PASS.

- [ ] **Step 6 : Construire le frontend pour de vrai**

Run: `cd frontend && bun run build`
Expected: succès. **Cette étape n'est pas facultative** : `test:all` ne construit rien, et une référence morte à `createMatchWatch` ou un import inutilisé ne se voit qu'ici.

- [ ] **Step 7 : Commit**

```bash
git add frontend/src/lib/components/LockstepRoom.svelte frontend/src/lib/components/SoloRoom.svelte frontend/src/lib/components/VrShell.svelte frontend/src/lib/rooms/match-report.ts
git commit -m "Brancher les trois salons sur l'enregistreur, et désarmer le solo"
```

---

### Task 5 : La migration 0008

**Files:**
- Create: `backend/migrations/0008_match_ratings.sql`
- Create: `backend/test/matches.test.ts`

**Interfaces:**
- Produces: les tables `Match` et `Rating`, consommées par les Tasks 6 à 8.

- [ ] **Step 1 : Écrire le test qui échoue**

Créer `backend/test/matches.test.ts`. `backend/test/*.test.ts` est un glob : ce fichier tourne tout seul, pas de `package.json` à toucher.

```ts
/**
 * Les parties enregistrées, et les cotes qui en dérivent.
 *
 * La table est la source de vérité et `Rating` en est recalculé : c'est ce qui
 * permet de changer la formule, le facteur K ou le classement initial sans
 * perdre l'historique. Les tests ci-dessous pincent cette propriété autant que
 * les chiffres.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { migratedDb, insertUser } from './helpers.js';

test('0008 crée les deux tables, et la clé unique porte sur la session', () => {
  const db = migratedDb();

  const tables = db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('Match', 'Rating')`
  ).all() as { name: string }[];
  assert.deepEqual(tables.map(t => t.name).sort(), ['Match', 'Rating']);

  const indexes = db.prepare(`PRAGMA index_list('Match')`).all() as {
    name: string;
    unique: number;
  }[];
  const unique = indexes.find(i => i.name === 'Match_sessionId_frame_key');
  assert.ok(unique, 'Match_sessionId_frame_key doit exister');
  assert.equal(unique!.unique, 1);
});

test('une partie survit à la suppression de son joueur, une cote non', () => {
  const db = migratedDb();
  const alice = insertUser(db);
  const bob = insertUser(db);

  db.prepare(`
    INSERT INTO "Match" (id, playedAt, gameCrc32, roomId, sessionId, frame,
                         p1UserId, p2UserId, winner, p1Health, p2Health)
    VALUES ('m1', 1000, '8F24F886', 'r1', 's1', 30, ?, ?, 1, 80, 0)
  `).run(alice.id, bob.id);
  db.prepare(`
    INSERT INTO "Rating" (userId, gameCrc32, rating, matches) VALUES (?, '8F24F886', 1016, 1)
  `).run(alice.id);

  db.prepare(`DELETE FROM "User" WHERE id = ?`).run(alice.id);

  const match = db.prepare(`SELECT p1UserId, p2UserId FROM "Match" WHERE id = 'm1'`)
    .get() as { p1UserId: string | null; p2UserId: string | null };
  assert.equal(match.p1UserId, null, 'la partie reste, le joueur s’efface');
  assert.equal(match.p2UserId, bob.id);

  const ratings = db.prepare(`SELECT COUNT(*) AS n FROM "Rating"`).get() as { n: number };
  assert.equal(ratings.n, 0, 'une cote n’a pas de sens sans son compte');
});

test('deux parties de la même session ne peuvent pas partager une image', () => {
  const db = migratedDb();
  const insert = (id: string, frame: number) =>
    db.prepare(`
      INSERT INTO "Match" (id, playedAt, gameCrc32, roomId, sessionId, frame,
                           p1UserId, p2UserId, winner, p1Health, p2Health)
      VALUES (?, 1000, '8F24F886', 'r1', 's1', ?, NULL, NULL, 1, 80, 0)
    `).run(id, frame);

  insert('m1', 30);
  assert.throws(() => insert('m2', 30));
  insert('m3', 60);
});

test('deux sessions du même salon peuvent partager une image', () => {
  // Le compteur d’images repart de zéro à la session suivante ; sans le
  // sessionId dans la clé, la seconde partie serait rejetée comme un doublon.
  const db = migratedDb();
  const insert = (id: string, sessionId: string) =>
    db.prepare(`
      INSERT INTO "Match" (id, playedAt, gameCrc32, roomId, sessionId, frame,
                           p1UserId, p2UserId, winner, p1Health, p2Health)
      VALUES (?, 1000, '8F24F886', 'r1', ?, 1800, NULL, NULL, 1, 80, 0)
    `).run(id, sessionId);

  insert('m1', 's1');
  insert('m2', 's2');
  const n = db.prepare(`SELECT COUNT(*) AS n FROM "Match"`).get() as { n: number };
  assert.equal(n.n, 2);
});
```

- [ ] **Step 2 : Lancer le test et vérifier qu'il échoue**

Run: `bun test backend/test/matches.test.ts`
Expected: FAIL — `no such table: Match`.

- [ ] **Step 3 : Écrire la migration**

Créer `backend/migrations/0008_match_ratings.sql` :

```sql
-- Le résultat d'une partie cesse de mourir avec la page.
--
-- `Match` fait autorité et `Rating` en est entièrement recalculé. C'est ce qui
-- permet de changer la formule, le facteur K ou le classement initial sans
-- perdre l'historique, et de refaire les cotes si un défaut d'enregistrement
-- est découvert. L'inverse - tenir la cote et jeter les parties - ne se
-- rattrape pas.
--
-- ------------------------------------------------------------- gameCrc32
--
-- Et non `gameId`. Un `Game.id` appartient à un compte : les deux joueurs
-- d'une même partie ont deux lignes `Game` distinctes pour la même cartouche
-- (`Game_userId_crc32_key`, 0001). Classer par `gameId` donnerait deux
-- classements pour un jeu. Le checksum est ce que les deux partagent, c'est
-- déjà la clé de `watched-roms.ts`, et c'est sur lui qu'un appariement par
-- voisinage de cote joindra.
--
-- --------------------------------------------------------------- sessionId
--
-- La clé de déduplication porte sur la session de jeu et non sur le salon.
-- Les deux pairs calculent le même verdict et le rapportent tous les deux ;
-- l'index unique est ce qui garde une seule ligne. Mais le compteur d'images
-- repart de zéro à chaque session, et le salon, lui, ne change pas : avec
-- `(roomId, frame)`, deux parties jouées dans le même salon à deux moments
-- différents se confondraient, la seconde rejetée comme un doublon et son
-- vainqueur comparé à celui de la première - donc une fausse alerte de
-- désynchronisation. Le serveur pose `sessionId` quand une partie commence.
--
-- --------------------------------------------------------- les deux FK
--
-- Asymétrie voulue, sur le modèle de `SignupInvite.inviteeId` en 0007. Une
-- partie jouée est un fait qui a eu lieu : elle survit à la suppression d'un
-- compte, d'où SET NULL. Une cote est une propriété de ce compte et n'a plus
-- de sens sans lui, d'où CASCADE.
--
-- Un joueur sans compte n'a pas d'identité durable : sa colonne est écrite
-- NULL dès l'insertion, et non laissée au balayage des anonymes. « Classable »
-- se lit alors `p1UserId IS NOT NULL AND p2UserId IS NOT NULL`, c'est vrai dès
-- l'écriture et ça le reste - aucune colonne `ranked` à tenir en accord avec
-- autre chose.
--
-- Les dates sont des millisecondes epoch écrites par le code appelant. Pas de
-- DEFAULT CURRENT_TIMESTAMP, qui insérerait du texte là où tout ce schéma met
-- des nombres.

CREATE TABLE "Match" (
  "id"        TEXT PRIMARY KEY,
  "playedAt"  INTEGER NOT NULL,
  "gameCrc32" TEXT    NOT NULL,
  "roomId"    TEXT    NOT NULL,
  "sessionId" TEXT    NOT NULL,
  "frame"     INTEGER NOT NULL,
  "p1UserId"  TEXT REFERENCES "User"("id") ON DELETE SET NULL,
  "p2UserId"  TEXT REFERENCES "User"("id") ON DELETE SET NULL,
  "winner"    INTEGER NOT NULL,
  "p1Health"  INTEGER NOT NULL,
  "p2Health"  INTEGER NOT NULL
);

CREATE UNIQUE INDEX "Match_sessionId_frame_key" ON "Match" ("sessionId", "frame");
CREATE INDEX "Match_gameCrc32_playedAt_idx" ON "Match" ("gameCrc32", "playedAt");

-- `rating` en INTEGER : tout ce schéma met des nombres, et le delta est arrondi
-- une fois puis appliqué en plus à l'un et en moins à l'autre, donc les cotes
-- restent entières sans que la somme dérive.
CREATE TABLE "Rating" (
  "userId"    TEXT    NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "gameCrc32" TEXT    NOT NULL,
  "rating"    INTEGER NOT NULL,
  "matches"   INTEGER NOT NULL,
  PRIMARY KEY ("userId", "gameCrc32")
);

-- L'index du voisinage de cote : c'est celui qu'un appariement lira pour
-- trouver un adversaire de force voisine parmi les possesseurs d'une cartouche.
CREATE INDEX "Rating_gameCrc32_rating_idx" ON "Rating" ("gameCrc32", "rating");
```

- [ ] **Step 4 : Lancer les tests et vérifier qu'ils passent**

Run: `bun test backend/test/matches.test.ts`
Expected: PASS, 4 tests.

> **Si `Match_sessionId_frame_key` n'apparaît pas dans `PRAGMA index_list`** : vérifier que les clés étrangères sont actives. `backend/src/db/sqlite.ts` les active à l'ouverture ; sans ça le test des FK passerait en ne prouvant rien.

- [ ] **Step 5 : Appliquer la migration à la base de développement**

Run: `cd backend && bun run db:migrate`
Expected: `0008_match_ratings.sql` appliquée. Pas `npx tsx`.

- [ ] **Step 6 : Commit**

```bash
git add backend/migrations/0008_match_ratings.sql backend/test/matches.test.ts
git commit -m "Donner un schéma aux parties jouées et aux cotes"
```

---

### Task 6 : La formule Elo, pure

**Files:**
- Create: `backend/src/ratings/elo.ts`
- Create: `backend/test/elo.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const INITIAL_RATING = 1000;
  export const K_FACTOR = 32;
  export interface PlayedMatch { p1UserId: string; p2UserId: string; winner: 0 | 1 | 2 }
  export interface Standing { rating: number; matches: number }
  export function fold(matches: readonly PlayedMatch[]): Map<string, Standing>;
  ```

- [ ] **Step 1 : Écrire les tests qui échouent**

Créer `backend/test/elo.test.ts` :

```ts
/**
 * La formule, et rien d'autre.
 *
 * Pure et sans base, pour la raison que l'en-tête de `saves/import-plan.ts`
 * énonce : rien ici ne peut piloter un handler dans un test, donc une règle
 * écrite dans une route est une règle que personne ne peut prouver.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { fold, INITIAL_RATING, K_FACTOR } from '../src/ratings/elo.js';

test('deux inconnus : le vainqueur prend la moitié du facteur K', () => {
  const standings = fold([{ p1UserId: 'a', p2UserId: 'b', winner: 1 }]);
  assert.equal(standings.get('a')!.rating, INITIAL_RATING + K_FACTOR / 2);
  assert.equal(standings.get('b')!.rating, INITIAL_RATING - K_FACTOR / 2);
});

test('un double KO entre égaux ne bouge rien, mais compte une partie', () => {
  const standings = fold([{ p1UserId: 'a', p2UserId: 'b', winner: 0 }]);
  assert.equal(standings.get('a')!.rating, INITIAL_RATING);
  assert.equal(standings.get('b')!.rating, INITIAL_RATING);
  assert.equal(standings.get('a')!.matches, 1);
  assert.equal(standings.get('b')!.matches, 1);
});

test('la somme des cotes est exactement conservée', () => {
  // Le delta est arrondi une fois puis appliqué symétriquement : ce test est
  // ce qui interdit de l'arrondir deux fois, ce qui ferait fuir des points.
  const standings = fold([
    { p1UserId: 'a', p2UserId: 'b', winner: 1 },
    { p1UserId: 'a', p2UserId: 'b', winner: 1 },
    { p1UserId: 'b', p2UserId: 'a', winner: 1 },
    { p1UserId: 'a', p2UserId: 'c', winner: 2 }
  ]);
  const total = [...standings.values()].reduce((sum, s) => sum + s.rating, 0);
  assert.equal(total, INITIAL_RATING * 3);
});

test('battre plus faible que soi rapporte moins', () => {
  const strong = fold([
    { p1UserId: 'a', p2UserId: 'b', winner: 1 },
    { p1UserId: 'a', p2UserId: 'b', winner: 1 },
    { p1UserId: 'a', p2UserId: 'b', winner: 1 }
  ]);
  const gains: number[] = [];
  let previous = INITIAL_RATING;
  for (let n = 1; n <= 3; n++) {
    const upTo = fold(
      Array.from({ length: n }, () => ({ p1UserId: 'a', p2UserId: 'b', winner: 1 as const }))
    );
    gains.push(upTo.get('a')!.rating - previous);
    previous = upTo.get('a')!.rating;
  }
  assert.ok(gains[0] > gains[1], 'le premier gain est le plus gros');
  assert.ok(gains[1] >= gains[2]);
  assert.ok(strong.get('a')!.rating > INITIAL_RATING);
});

test('l’ordre des parties change le résultat', () => {
  // Elo est un pliage séquentiel. C'est la raison pour laquelle le recalcul
  // relit les parties dans l'ordre plutôt que d'appliquer un delta à l'arrivée.
  const forward = fold([
    { p1UserId: 'a', p2UserId: 'b', winner: 1 },
    { p1UserId: 'a', p2UserId: 'c', winner: 1 }
  ]);
  const backward = fold([
    { p1UserId: 'a', p2UserId: 'c', winner: 1 },
    { p1UserId: 'a', p2UserId: 'b', winner: 1 }
  ]);
  assert.notDeepEqual(
    [forward.get('b')!.rating, forward.get('c')!.rating],
    [backward.get('b')!.rating, backward.get('c')!.rating]
  );
});

test('une liste vide ne classe personne', () => {
  assert.equal(fold([]).size, 0);
});
```

- [ ] **Step 2 : Lancer les tests et vérifier qu'ils échouent**

Run: `bun test backend/test/elo.test.ts`
Expected: FAIL — le module n'existe pas.

- [ ] **Step 3 : Écrire la formule**

Créer `backend/src/ratings/elo.ts` :

```ts
/**
 * Elo, par jeu.
 *
 * Pure et sans base : une liste de parties entre, des cotes sortent. C'est le
 * découpage d'`auth/anonymous.ts` et de `saves/import-plan.ts`, et pour la même
 * raison - une formule écrite dans une route est une formule que personne ne
 * peut prouver.
 *
 * Le pliage est séquentiel : la cote d'une partie dépend de celles que les deux
 * joueurs portaient à ce moment-là, donc l'ordre compte. C'est pourquoi
 * `db/matches.ts` relit tout l'historique d'un jeu dans l'ordre plutôt que
 * d'appliquer un delta à l'arrivée : une partie qui arrive en retard - un pair
 * qui rapporte après une reconnexion - se range à sa place au lieu d'être
 * repliée à la fin.
 */

/** La cote d'un joueur dont on n'a jamais enregistré de partie. */
export const INITIAL_RATING = 1000;

/**
 * Combien une partie peut déplacer.
 *
 * 32 est le choix des petites populations : à une poignée de joueurs, un K
 * faible met des centaines de parties à séparer qui que ce soit. Ce chiffre se
 * change sans rien perdre - `Match` fait autorité et `Rating` en est recalculé.
 */
export const K_FACTOR = 32;

export interface PlayedMatch {
	p1UserId: string;
	p2UserId: string;
	/** Le port qui a gagné, ou 0 pour un double KO. */
	winner: 0 | 1 | 2;
}

export interface Standing {
	rating: number;
	matches: number;
}

/**
 * Les cotes que produit cette suite de parties, dans cet ordre.
 *
 * Le delta est arrondi **une fois**, puis ajouté à l'un et retranché à l'autre.
 * Arrondir les deux cotes séparément ferait fuir un point de temps en temps, et
 * la somme des cotes cesserait d'être conservée sans que personne le voie.
 */
export function fold(matches: readonly PlayedMatch[]): Map<string, Standing> {
	const standings = new Map<string, Standing>();
	const of = (id: string): Standing =>
		standings.get(id) ?? { rating: INITIAL_RATING, matches: 0 };

	for (const match of matches) {
		const p1 = of(match.p1UserId);
		const p2 = of(match.p2UserId);

		const scored = match.winner === 0 ? 0.5 : match.winner === 1 ? 1 : 0;
		const expected = 1 / (1 + 10 ** ((p2.rating - p1.rating) / 400));
		const delta = Math.round(K_FACTOR * (scored - expected));

		standings.set(match.p1UserId, { rating: p1.rating + delta, matches: p1.matches + 1 });
		standings.set(match.p2UserId, { rating: p2.rating - delta, matches: p2.matches + 1 });
	}

	return standings;
}
```

- [ ] **Step 4 : Lancer les tests et vérifier qu'ils passent**

Run: `bun test backend/test/elo.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5 : Commit**

```bash
git add backend/src/ratings/elo.ts backend/test/elo.test.ts
git commit -m "Écrire la formule Elo, pure et prouvable sans base"
```

---

### Task 7 : L'accès base — insertion, déduplication, recalcul

**Files:**
- Create: `backend/src/db/matches.ts`
- Modify: `backend/test/matches.test.ts` (créé en Task 5)

**Interfaces:**
- Consumes: `fold`, `PlayedMatch` (Task 6) ; les tables (Task 5) ; `Database` de `db/sqlite.js`.
- Produces:
  ```ts
  export interface MatchInsert {
    playedAt: number; gameCrc32: string; roomId: string; sessionId: string;
    frame: number; p1UserId: string | null; p2UserId: string | null;
    winner: 0 | 1 | 2; p1Health: number; p2Health: number;
  }
  export type RecordOutcome =
    | { kind: 'recorded' }
    | { kind: 'duplicate' }
    | { kind: 'disagreement'; stored: 0 | 1 | 2 };
  export function recordMatch(db: Database, match: MatchInsert): RecordOutcome;
  export function ratingFor(db: Database, userId: string, gameCrc32: string): number;
  ```

- [ ] **Step 1 : Écrire les tests qui échouent**

À ajouter à `backend/test/matches.test.ts` :

```ts
import { recordMatch, ratingFor } from '../src/db/matches.js';
import { INITIAL_RATING, K_FACTOR } from '../src/ratings/elo.js';

/** Une partie prête à insérer, dont on ne change que ce qui compte au test. */
function match(over: Partial<Parameters<typeof recordMatch>[1]> = {}) {
  return {
    playedAt: 1000,
    gameCrc32: '8F24F886',
    roomId: 'r1',
    sessionId: 's1',
    frame: 30,
    p1UserId: null,
    p2UserId: null,
    winner: 1 as 0 | 1 | 2,
    p1Health: 80,
    p2Health: 0,
    ...over
  };
}

test('une partie classée écrit les deux cotes', () => {
  const db = migratedDb();
  const alice = insertUser(db);
  const bob = insertUser(db);

  const outcome = recordMatch(db, match({ p1UserId: alice.id, p2UserId: bob.id }));

  assert.deepEqual(outcome, { kind: 'recorded' });
  assert.equal(ratingFor(db, alice.id, '8F24F886'), INITIAL_RATING + K_FACTOR / 2);
  assert.equal(ratingFor(db, bob.id, '8F24F886'), INITIAL_RATING - K_FACTOR / 2);
});

test('le second rapport du même KO est un doublon, pas une seconde partie', () => {
  const db = migratedDb();
  const alice = insertUser(db);
  const bob = insertUser(db);
  const same = match({ p1UserId: alice.id, p2UserId: bob.id });

  recordMatch(db, same);
  const second = recordMatch(db, { ...same, playedAt: 1100 });

  assert.deepEqual(second, { kind: 'duplicate' });
  const n = db.prepare(`SELECT COUNT(*) AS n FROM "Match"`).get() as { n: number };
  assert.equal(n.n, 1);
  // La cote n'a pas bougé deux fois.
  assert.equal(ratingFor(db, alice.id, '8F24F886'), INITIAL_RATING + K_FACTOR / 2);
});

test('deux pairs qui ne sont pas d’accord sont signalés, pas écrasés', () => {
  const db = migratedDb();
  const alice = insertUser(db);
  const bob = insertUser(db);
  const base = match({ p1UserId: alice.id, p2UserId: bob.id, winner: 1 });

  recordMatch(db, base);
  const second = recordMatch(db, { ...base, winner: 2 });

  assert.deepEqual(second, { kind: 'disagreement', stored: 1 });
  const stored = db.prepare(`SELECT winner FROM "Match"`).get() as { winner: number };
  assert.equal(stored.winner, 1, 'le premier rapport fait foi');
});

test('une partie contre un invité est gardée, mais ne classe personne', () => {
  const db = migratedDb();
  const alice = insertUser(db);

  recordMatch(db, match({ p1UserId: alice.id, p2UserId: null }));

  const n = db.prepare(`SELECT COUNT(*) AS n FROM "Match"`).get() as { n: number };
  assert.equal(n.n, 1, 'l’historique garde la partie');
  assert.equal(ratingFor(db, alice.id, '8F24F886'), INITIAL_RATING, 'et la cote ne bouge pas');
  const ratings = db.prepare(`SELECT COUNT(*) AS n FROM "Rating"`).get() as { n: number };
  assert.equal(ratings.n, 0);
});

test('une partie arrivée en retard se range à sa place', () => {
  // Deux bases identiques sauf l'ordre d'insertion : les cotes finales doivent
  // être les mêmes, puisque le recalcul relit l'historique trié.
  const ratingsAfter = (order: number[]) => {
    const db = migratedDb();
    const alice = insertUser(db, { id: `a-${order.join('')}` });
    const bob = insertUser(db, { id: `b-${order.join('')}` });
    const carol = insertUser(db, { id: `c-${order.join('')}` });
    const rows = [
      match({ playedAt: 1000, frame: 30, p1UserId: alice.id, p2UserId: bob.id, winner: 1 }),
      match({ playedAt: 2000, frame: 60, p1UserId: alice.id, p2UserId: carol.id, winner: 1 }),
      match({ playedAt: 3000, frame: 90, p1UserId: bob.id, p2UserId: carol.id, winner: 2 })
    ];
    for (const i of order) recordMatch(db, rows[i]);
    return [
      ratingFor(db, alice.id, '8F24F886'),
      ratingFor(db, bob.id, '8F24F886'),
      ratingFor(db, carol.id, '8F24F886')
    ];
  };

  assert.deepEqual(ratingsAfter([2, 0, 1]), ratingsAfter([0, 1, 2]));
});

test('deux jeux ont deux classements', () => {
  const db = migratedDb();
  const alice = insertUser(db);
  const bob = insertUser(db);

  recordMatch(db, match({ p1UserId: alice.id, p2UserId: bob.id, winner: 1 }));
  recordMatch(db, match({
    gameCrc32: 'AAAAAAAA', sessionId: 's2', p1UserId: alice.id, p2UserId: bob.id, winner: 2
  }));

  assert.equal(ratingFor(db, alice.id, '8F24F886'), INITIAL_RATING + K_FACTOR / 2);
  assert.equal(ratingFor(db, alice.id, 'AAAAAAAA'), INITIAL_RATING - K_FACTOR / 2);
});

test('un joueur sans partie vaut le classement initial', () => {
  const db = migratedDb();
  const alice = insertUser(db);
  assert.equal(ratingFor(db, alice.id, '8F24F886'), INITIAL_RATING);
});
```

- [ ] **Step 2 : Lancer les tests et vérifier qu'ils échouent**

Run: `bun test backend/test/matches.test.ts`
Expected: FAIL — `db/matches.js` n'existe pas.

- [ ] **Step 3 : Écrire le module**

Créer `backend/src/db/matches.ts` :

```ts
/**
 * Les parties jouées, et les cotes qu'on en tire.
 *
 * `Match` fait autorité ; `Rating` est effacé et réécrit depuis lui à chaque
 * insertion. Ce n'est pas de la prudence : Elo est un pliage séquentiel, donc
 * une partie qui arrive en retard - un pair qui rapporte après une reconnexion
 * - doit se ranger à sa place et non être repliée à la fin. Rejouer est la
 * façon la plus simple d'obtenir ça, et à cette échelle le coût est nul.
 *
 * Le jour où il cesse de l'être, on passe à l'incrémental sans changer le
 * schéma - ce qui est exactement pourquoi `Match` reste la source de vérité.
 */

import { randomUUID } from 'node:crypto';
import type { Database } from './sqlite.js';
import { fold, INITIAL_RATING, type PlayedMatch } from '../ratings/elo.js';

export interface MatchInsert {
  playedAt: number;
  gameCrc32: string;
  roomId: string;
  sessionId: string;
  frame: number;
  /** Null pour un joueur sans compte : pas d'identité durable, pas de colonne. */
  p1UserId: string | null;
  p2UserId: string | null;
  winner: 0 | 1 | 2;
  p1Health: number;
  p2Health: number;
}

/**
 * Ce que le second rapport d'un même KO produit.
 *
 * `disagreement` n'est pas une erreur à écraser : c'est le signal d'une
 * désynchronisation entre les deux pairs, et le seul endroit du système où
 * elle devient visible. Le premier rapport fait foi.
 */
export type RecordOutcome =
  | { kind: 'recorded' }
  | { kind: 'duplicate' }
  | { kind: 'disagreement'; stored: 0 | 1 | 2 };

export function recordMatch(db: Database, match: MatchInsert): RecordOutcome {
  const run = db.transaction((): RecordOutcome => {
    // Lecture avant écriture plutôt qu'un INSERT OR IGNORE : celui-ci
    // avalerait aussi une violation de clé étrangère, donc un vrai défaut.
    // L'index unique reste la garantie ; ceci est le chemin.
    const existing = db.prepare(
      `SELECT winner FROM "Match" WHERE sessionId = ? AND frame = ?`
    ).get(match.sessionId, match.frame) as { winner: number } | undefined;

    if (existing) {
      return existing.winner === match.winner
        ? { kind: 'duplicate' }
        : { kind: 'disagreement', stored: existing.winner as 0 | 1 | 2 };
    }

    db.prepare(`
      INSERT INTO "Match" (id, playedAt, gameCrc32, roomId, sessionId, frame,
                           p1UserId, p2UserId, winner, p1Health, p2Health)
      VALUES (@id, @playedAt, @gameCrc32, @roomId, @sessionId, @frame,
              @p1UserId, @p2UserId, @winner, @p1Health, @p2Health)
    `).run({ id: randomUUID(), ...match });

    // Une partie contre un invité est de l'historique, pas du classement : la
    // requête ci-dessous l'écarte par ses deux IS NOT NULL, donc il n'y a rien
    // à tester ici.
    recomputeRatings(db, match.gameCrc32);
    return { kind: 'recorded' };
  });

  return run();
}

/**
 * Efface et réécrit les cotes de ce jeu depuis tout son historique.
 *
 * L'ordre est `(playedAt, frame)` et non l'ordre d'insertion : c'est ce qui
 * rend le résultat indépendant de la route qu'ont prise les rapports.
 */
function recomputeRatings(db: Database, gameCrc32: string): void {
  const played = db.prepare(`
    SELECT p1UserId, p2UserId, winner FROM "Match"
    WHERE gameCrc32 = ? AND p1UserId IS NOT NULL AND p2UserId IS NOT NULL
    ORDER BY playedAt, frame
  `).all(gameCrc32) as PlayedMatch[];

  db.prepare(`DELETE FROM "Rating" WHERE gameCrc32 = ?`).run(gameCrc32);

  const insert = db.prepare(`
    INSERT INTO "Rating" (userId, gameCrc32, rating, matches) VALUES (?, ?, ?, ?)
  `);
  for (const [userId, standing] of fold(played)) {
    insert.run(userId, gameCrc32, standing.rating, standing.matches);
  }
}

/**
 * La cote de ce joueur sur ce jeu.
 *
 * Absence de ligne = classement initial, et c'est voulu : la table ne contient
 * que ceux qui ont joué. Un appariement partira des possesseurs de la cartouche
 * et joindra ceci à gauche, l'absence valant `INITIAL_RATING` - une constante
 * partagée avec la formule, pas une ligne fantôme à pré-créer.
 */
export function ratingFor(db: Database, userId: string, gameCrc32: string): number {
  const row = db.prepare(
    `SELECT rating FROM "Rating" WHERE userId = ? AND gameCrc32 = ?`
  ).get(userId, gameCrc32) as { rating: number } | undefined;
  return row?.rating ?? INITIAL_RATING;
}
```

- [ ] **Step 4 : Lancer les tests et vérifier qu'ils passent**

Run: `bun test backend/test/matches.test.ts`
Expected: PASS, 11 tests (les 4 de la Task 5 et les 7 d'ici).

- [ ] **Step 5 : Commit**

```bash
git add backend/src/db/matches.ts backend/test/matches.test.ts
git commit -m "Enregistrer une partie, dédupliquer les deux rapports, refaire les cotes"
```

---

### Task 8 : L'estampille de session, le handler, et l'émission

**Files:**
- Create: `backend/src/rooms/play-session.ts`
- Create: `backend/src/websocket/match-handlers.ts`
- Create: `backend/test/play-session.test.ts`
- Modify: `backend/src/types/index.ts` (interface `Room`)
- Modify: `backend/src/websocket/game-handlers.ts:70`
- Modify: `backend/src/websocket/room-handlers.ts:106`
- Modify: `backend/src/websocket/index.ts` (enregistrer le handler)
- Modify: `frontend/src/lib/components/LockstepRoom.svelte`, `frontend/src/lib/components/VrShell.svelte` (le port `report`)

**Interfaces:**
- Consumes: `recordMatch`, `MatchInsert` (Task 7) ; `createMatchRecorder` (Task 3).
- Produces: `beginPlaySession(room: Room): void` ; l'événement socket `match:report`.

- [ ] **Step 1 : Écrire le test qui échoue**

Créer `backend/test/play-session.test.ts` :

```ts
/**
 * L'identifiant d'une session de jeu, et les transitions qui le renouvellent.
 *
 * Toutes les écritures de `status = 'playing'` ne sont pas des débuts de
 * partie, et c'est tout le piège : reprendre après une pause en est une, et
 * restamper là casserait la déduplication autour de la pause - deux rapports
 * du même KO porteraient deux identifiants, et la ligne serait écrite deux
 * fois.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { beginPlaySession } from '../src/rooms/play-session.js';
import type { Room } from '../src/types/index.js';

function room(): Room {
  return {
    id: 'r1',
    hostId: 'u1',
    createdBy: 'u1',
    players: [],
    status: 'waiting',
    emulationMode: 'lockstep',
    latencyMode: 'auto',
    createdAt: new Date()
  } as Room;
}

test('commencer une partie met le salon en jeu et lui donne une session', () => {
  const r = room();
  beginPlaySession(r);
  assert.equal(r.status, 'playing');
  assert.ok(r.playSessionId, 'une session doit être posée');
});

test('deux parties successives dans le même salon ont deux sessions', () => {
  const r = room();
  beginPlaySession(r);
  const first = r.playSessionId;
  beginPlaySession(r);
  assert.notEqual(r.playSessionId, first);
});
```

- [ ] **Step 2 : Lancer le test et vérifier qu'il échoue**

Run: `bun test backend/test/play-session.test.ts`
Expected: FAIL — le module n'existe pas.

- [ ] **Step 3 : L'estampille**

Dans `backend/src/types/index.ts`, ajouter à l'interface `Room`, après `status` :

```ts
  /**
   * La session de jeu en cours, renouvelée à chaque partie qui commence.
   *
   * C'est la clé sur laquelle les deux rapports d'un même KO se dédupliquent.
   * Pas `id` : le compteur d'images repart de zéro à chaque session alors que
   * le salon, lui, ne change pas, donc deux parties du même salon peuvent
   * tomber sur la même image. Posée par `rooms/play-session.ts` et nulle part
   * ailleurs.
   */
  playSessionId?: string;
```

Créer `backend/src/rooms/play-session.ts` :

```ts
/**
 * Le début d'une partie, en un seul endroit.
 *
 * Trois sites écrivent `status = 'playing'`, et ils ne veulent pas dire la
 * même chose : `game:start` et la création d'un salon en `autoStart` commencent
 * une partie, `game:resume` termine une pause. Seuls les deux premiers
 * renouvellent la session.
 *
 * Restamper sur une reprise casserait la déduplication autour d'une pause :
 * deux rapports du même KO encadrant la reprise porteraient deux identifiants
 * différents, et la ligne serait écrite deux fois. Le compteur d'images ne
 * repart pas de zéro à la reprise, donc il n'y a rien à protéger là.
 *
 * Écrit à part et en une fonction pour la raison que `rooms/presence.ts`
 * donne : trois sites d'appel déclenchent la transition, et un drapeau posé à
 * deux endroits sur trois est un défaut que personne ne voit.
 */

import { randomUUID } from 'node:crypto';
import type { Room } from '../types/index.js';

/** Une partie commence : le salon joue, et sa session est neuve. */
export function beginPlaySession(room: Room): void {
	room.status = 'playing';
	room.playSessionId = randomUUID();
}
```

Dans `backend/src/websocket/game-handlers.ts`, remplacer l. 70 `room.status = 'playing';` par `beginPlaySession(room);` et ajouter l'import. **Ne pas toucher la l. 127** (`game:resume`) : y appeler `beginPlaySession` est exactement l'erreur que le module existe pour empêcher.

Dans `backend/src/websocket/room-handlers.ts` l. 106, le salon est construit littéralement avec `status: autoStart ? 'playing' : 'waiting'`. Ajouter à côté :

```ts
      playSessionId: autoStart ? randomUUID() : undefined,
```

> **Note :** ce site construit un objet plutôt que de muter un salon existant, donc `beginPlaySession` ne s'y applique pas telle quelle. Si l'implémenteur préfère, extraire une seconde fonction `newPlaySessionId()` dans `play-session.ts` et l'appeler des deux côtés — l'important est qu'aucun `randomUUID()` de session ne soit écrit ailleurs que dans ce module.

- [ ] **Step 4 : Lancer le test et vérifier qu'il passe**

Run: `bun test backend/test/play-session.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5 : Le handler**

Créer `backend/src/websocket/match-handlers.ts` :

```ts
/**
 * Le rapport d'un KO, et ce qu'on en croit.
 *
 * On croit le client sur parole pour *qui a gagné* : le verdict vient de sa
 * RAM et il n'y a pas d'autre source. On ne le croit pas sur *qui jouait* -
 * l'identité des deux joueurs est lue sur le salon, au moment du rapport,
 * parce que les ports se réassignent en cours de session et parce qu'un
 * client qui nomme les joueurs peut s'attribuer la victoire de n'importe qui.
 *
 * Les deux pairs rapportent le même KO : la déduplication est dans
 * `db/matches.ts`, sur `(sessionId, frame)`. Deux rapporteurs plutôt qu'un
 * n'est pas un gaspillage - un `emit` sur un socket coupé disparaît sans
 * erreur et rien ne le rejoue, donc il faut que les deux tombent au même
 * instant pour perdre la ligne.
 */

import type { Server, Socket } from 'socket.io';
import type { Room } from '../types/index.js';
import { getDb } from '../db/sqlite.js';
import { findUserById } from '../db/users.js';
import { recordMatch } from '../db/matches.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('Match');

interface MatchReport {
  roomId: string;
  frame: number;
  winner: 0 | 1 | 2;
  p1Health: number;
  p2Health: number;
}

/** L'identité classable derrière un port, ou null pour un invité ou un siège vide. */
function rankableAt(room: Room, port: 1 | 2): string | null {
  const player = room.players.find(p => p.port === port);
  if (!player) return null;
  const user = findUserById(getDb(), player.userId);
  // Un anonyme n'a pas d'identité durable : la colonne reste vide dès
  // l'insertion, plutôt que d'attendre le balayage des sessions mortes.
  return user && !user.isAnonymous ? user.id : null;
}

export function registerMatchHandlers(
  socket: Socket,
  _io: Server,
  userId: string,
  rooms: Map<string, Room>
): void {
  socket.on('match:report', (data: MatchReport) => {
    const room = rooms.get(data?.roomId);
    if (!room) return;
    // Un rapport ne peut venir que d'un membre du salon qu'il décrit.
    if (!room.players.some(p => p.userId === userId)) return;

    if (!room.gameCrc32 || !room.playSessionId) {
      // Ne devrait pas arriver : le guetteur ne s'arme que sur un CRC32 connu,
      // et une partie en cours a une session. D'où le bruit plutôt que le
      // silence - c'est le seul endroit où l'anomalie serait visible.
      logger.warn(
        { roomId: room.id, hasCrc32: !!room.gameCrc32, hasSession: !!room.playSessionId },
        'Match reported for a room that cannot be ranked'
      );
      return;
    }

    const outcome = recordMatch(getDb(), {
      playedAt: Date.now(),
      gameCrc32: room.gameCrc32,
      roomId: room.id,
      sessionId: room.playSessionId,
      frame: data.frame,
      p1UserId: rankableAt(room, 1),
      p2UserId: rankableAt(room, 2),
      winner: data.winner,
      p1Health: data.p1Health,
      p2Health: data.p2Health
    });

    if (outcome.kind === 'disagreement') {
      // Les deux pairs ont lu la même RAM et ne sont pas tombés d'accord : ils
      // ne font plus tourner la même machine. Le premier rapport est gardé.
      logger.error(
        { roomId: room.id, frame: data.frame, stored: outcome.stored, reported: data.winner },
        'Peers disagree on who won - the session has desynchronised'
      );
    }
  });
}
```

Dans `backend/src/websocket/index.ts`, à côté des autres `registerXHandlers` (vers l. 207-209) :

```ts
  registerMatchHandlers(socket, io, user.id, rooms);
```

avec l'import correspondant.

- [ ] **Step 6 : Brancher l'émission côté client**

Dans `LockstepRoom.svelte`, le port `report` posé en Task 4 :

```ts
        report: (verdict) =>
          $socket?.emit('match:report', {
            roomId,
            frame: verdict.frame,
            winner: verdict.winner,
            p1Health: verdict.health.p1,
            p2Health: verdict.health.p2
          })
```

Faire la même chose au site lockstep de `VrShell.svelte`.

- [ ] **Step 7 : Lancer toute la suite**

Run: `bun run test:all`
Expected: PASS.

- [ ] **Step 8 : Construire le frontend**

Run: `cd frontend && bun run build`
Expected: succès.

- [ ] **Step 9 : Commit**

```bash
git add backend/src/rooms/play-session.ts backend/src/websocket/match-handlers.ts backend/src/websocket/index.ts backend/src/websocket/game-handlers.ts backend/src/websocket/room-handlers.ts backend/src/types/index.ts backend/test/play-session.test.ts frontend/src/lib/components/LockstepRoom.svelte frontend/src/lib/components/VrShell.svelte
git commit -m "Rapporter les KO au serveur, et n'en croire que ce qui se vérifie"
```

---

## Vérification finale

Avant d'ouvrir la PR, et pas seulement en regardant la couleur :

- [ ] `bun run test:all` passe.
- [ ] Le **nombre de fichiers** de `test:ui` a augmenté de un (`match-recorder.test.ts`). Un fichier oublié dans ce script ne tourne jamais.
- [ ] `cd frontend && bun run build` réussit. `test:all` ne construit rien.
- [ ] `cd backend && bun run db:migrate` applique bien `0008` sur une base existante.
- [ ] Une vraie partie à deux sur la ROM mesurée produit **une** ligne dans `Match` et non deux — c'est la seule preuve que la déduplication marche contre deux vrais pairs, et aucun test ne la remplace.
- [ ] Un combat où le second joueur ne touche pas sa manette n'en produit **aucune**.
