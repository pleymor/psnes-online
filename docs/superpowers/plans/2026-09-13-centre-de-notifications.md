# Centre de notifications — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Réunir les six surfaces de notification derrière un seul store, un seul toast, et une cloche à pastille dans la barre du haut.

**Architecture:** Une notification est une donnée sérialisable (`kind` + `params`), jamais un composant ni une closure — c'est ce qui lui permet de survivre au rechargement. Un registre **pur** donne le texte et le ton de chaque `kind` ; les **actions**, qui ont besoin de la socket et des stores du navigateur, sont enregistrées à l'exécution par des ponts, de sorte que tout le reste se teste sous Bun sans navigateur. `notifications.show()` survit en couche de compatibilité pour ses huit appelants.

**Tech Stack:** Svelte 4 + SvelteKit, stores Svelte, `bun test` + `node:assert/strict`, `localStorage`.

**Spec:** `docs/superpowers/specs/2026-09-13-centre-de-notifications-design.md`
(sur la branche `spec-centre-de-notifications` ; à lire avant la tâche 1)

## Global Constraints

- **`notifications.show(message, type, duration)` ne change ni de nom, ni de signature, ni de comportement.** Huit fichiers l'appellent (`saves/quick-actions.ts`, `SaveGameMenu`, `LoadSavesMenu`, `TopBar`, `VrShell`, `SoloRoom`, `routes/room/[id]/+page.svelte`) et aucun n'est modifié par ce plan.
- **`VrShell.svelte` l. 774 lit `$notifications.at(-1)?.message`.** Le store exporté doit rester un tableau d'objets portant `id`, `message` et `type`. Casser cette forme rend muet le bandeau du casque, et aucun test ne le voit.
- **Pas d'alias SvelteKit (`$lib`, `$app`) dans un module testé sous Bun.** Imports relatifs avec l'extension `.js`, comme `roms/transfer.ts` l'explique en tête de fichier. Un `import type` est effacé à l'exécution et reste autorisé.
- **Un module qui persiste prend son stockage en argument**, il n'attrape jamais `localStorage` — même forme que `stores/aspect-preference.ts` et `roms/share-consent.ts`.
- **Un nouveau fichier de test ne tourne que s'il est nommé dans `test:ui`** de `package.json`. Vérifier le total, pas la couleur : 1251 avant ce plan.
- **Tout `kind` doit avoir un texte dans les deux langues.** `core/test/i18n-parity.test.ts` garde la parité des clés ; la tâche 1 ajoute la garde qui attrape un `kind` sans traduction.
- **Pas de configuration de formateur dans ce dépôt.** Suivre l'indentation du fichier voisin : tabulations dans `lib/roms/` et `core/test/`, deux espaces dans `lib/components/` et `lib/services/`.
- **Les commentaires expliquent pourquoi, pas quoi**, en français dans les fichiers récents. C'est la voix du dépôt ; la respecter fait partie de la tâche.
- Commandes : `export PATH="$HOME/.bun/bin:$PATH"` avant tout `bun`, et `export PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$PATH"` avant tout `npx`.

---

## Structure des fichiers

**Créés**

| Fichier | Responsabilité |
|---|---|
| `frontend/src/lib/notices/notice.ts` | Les types. Rien d'autre, aucun import de valeur. |
| `frontend/src/lib/notices/shapes.ts` | Le registre **pur** : texte et ton par `kind`. Testable sous Bun. |
| `frontend/src/lib/notices/actions.ts` | Les boutons par `kind`, enregistrés à l'exécution. Vide dans les tests. |
| `frontend/src/lib/notices/store.ts` | La liste, l'ouverture, la consommation, le compte. |
| `frontend/src/lib/notices/persist.ts` | Sérialisation et purge. Prend son stockage. |
| `frontend/src/lib/notices/bridges.ts` | Côté navigateur : suit invitations, offres, ROM reçue. |
| `frontend/src/lib/components/NoticeToast.svelte` | Ce qui passe à l'écran. |
| `frontend/src/lib/components/NoticeCentre.svelte` | La liste derrière la cloche. |
| `core/test/notices.test.ts` | Toute la logique ci-dessus. |

**Modifiés**

| Fichier | Changement |
|---|---|
| `frontend/src/lib/services/notification.ts` | Devient une couche de compatibilité au-dessus du store. |
| `frontend/src/lib/components/TopBar.svelte` | La cloche et la pastille. |
| `frontend/src/routes/+layout.svelte` | Monte `NoticeToast` et démarre les ponts. |
| `frontend/src/routes/+page.svelte` | Perd son toast maison. |
| `frontend/src/routes/room/[id]/+page.svelte` | Perd son toast maison. |
| `frontend/src/lib/i18n/translations.ts` | Les libellés des boutons et des `kind`. |
| `package.json` | `core/test/notices.test.ts` dans `test:ui`. |

**Supprimés** (tâche 7, jamais avant) : `components/NotificationToast.svelte`, `components/InvitationCard.svelte`, `components/ShareOffer.svelte`, `components/KeepRomOffer.svelte`.

---

## Task 1: Le modèle et le registre pur

**Files:**
- Create: `frontend/src/lib/notices/notice.ts`
- Create: `frontend/src/lib/notices/shapes.ts`
- Create: `core/test/notices.test.ts`
- Modify: `package.json` (script `test:ui`)

**Interfaces:**
- Consumes: `t`, `TranslationKey` de `frontend/src/lib/i18n/translations.ts`.
- Produces: `Notice`, `NoticeParams`, `NoticeTone`, `NoticeShape`, `NoticeAction`, `NOTICE_SHAPES`, `shapeOf(kind)`.

- [ ] **Step 1: Écrire le test qui échoue**

Créer `core/test/notices.test.ts` :

```ts
/**
 * Le centre de notifications : ce qui se pose, ce qui se lit, ce qui s efface.
 *
 * Tout ici est pur ou prend son stockage, pour la raison que `transfer.ts`
 * donne pour les siens : ce depot teste sous Bun, sans navigateur. Les
 * boutons, eux, ont besoin de la socket - ils sont enregistres a l execution
 * et n apparaissent donc pas dans ce fichier.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';

import { NOTICE_SHAPES, shapeOf } from '../../frontend/src/lib/notices/shapes.js';

test('un kind inconnu n a pas de forme', () => {
	assert.equal(shapeOf('rien-de-tel'), null);
});

test('le kind brut rend le message qu on lui a donne', () => {
	const shape = shapeOf('raw');

	assert.ok(shape);
	assert.equal(shape.text({ message: 'Sauvegarde creee' }, 'fr'), 'Sauvegarde creee');
	assert.equal(shape.tone, 'info');
});

test('chaque kind rend un texte non vide dans les deux langues', () => {
	// La garde que `i18n-parity` ne peut pas donner : elle compare les cles
	// des deux locales, pas les kinds qui les utilisent. Un kind ajoute avec
	// une cle oubliee compile et rend une chaine vide a l ecran.
	const params = { message: 'x', name: 'Bob', title: 'Umihara Kawase', count: 2 };

	for (const kind of Object.keys(NOTICE_SHAPES)) {
		for (const lang of ['en', 'fr'] as const) {
			const text = shapeOf(kind)?.text(params, lang) ?? '';
			assert.notEqual(text.trim(), '', `${kind} n a pas de texte en ${lang}`);
		}
	}
});
```

- [ ] **Step 2: Le lancer pour le voir échouer**

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun test core/test/notices.test.ts
```

Attendu : `error: Cannot find module '../../frontend/src/lib/notices/shapes.js'`.

- [ ] **Step 3: Écrire les types**

`frontend/src/lib/notices/notice.ts` :

```ts
/**
 * Ce qu'est une notification : une donnée, jamais un composant.
 *
 * C'est la persistance qui l'impose. Le centre survit au rechargement, donc
 * une notification s'écrit dans le stockage, donc elle ne peut pas contenir
 * ses actions - une fonction ne se sérialise pas. Elle les nomme, par son
 * `kind`, et `actions.ts` sait ce que ce nom veut dire.
 *
 * Aucun import de valeur ici : ce fichier doit pouvoir être lu par n'importe
 * quel module du projet sans en réveiller un autre.
 */

import type { TranslationKey } from '../i18n/translations';

export type NoticeTone = 'info' | 'success' | 'error' | 'warning';

/** Tout ce qu'une notification transporte doit tenir dans du JSON. */
export type NoticeParams = Record<string, string | number>;

export interface Notice {
  readonly id: string;
  readonly kind: string;
  readonly params: NoticeParams;
  /** Quand elle est née, pour l'ordre et pour la purge. */
  readonly at: number;
  /** Après quoi elle ne vaut plus rien. Absent = pas d'échéance. */
  readonly expiresAt?: number;
}

export interface NoticeAction {
  readonly label: TranslationKey;
  readonly primary?: boolean;
  run(params: NoticeParams): void | Promise<void>;
}

export interface NoticeShape {
  /** Le texte, dans la langue courante. */
  text(params: NoticeParams, lang: 'en' | 'fr'): string;
  readonly tone: NoticeTone;
  /**
   * Dépend d'une session vivante - une socket, une offre en cours - donc
   * purgée au démarrage : au rechargement elle n'a plus d'interlocuteur.
   */
  readonly live?: boolean;
  /**
   * Peut s'afficher pendant une partie.
   *
   * Faux par défaut, et c'est la règle qu'`InvitationCard` portait : un
   * panneau au-dessus d'un émulateur vole un clic, et accepter ferait sortir
   * le joueur du match.
   */
  readonly duringGame?: boolean;
  /**
   * Secondes à l'écran. 0 = jusqu'à réponse.
   *
   * Zéro n'existe que pour `keep-rom`, qui naît pendant une partie : la barre
   * du haut - donc la cloche - disparaît en plein écran, et une notification
   * qui s'efface serait alors sans recours.
   */
  readonly seconds?: number;
}
```

- [ ] **Step 4: Écrire le registre**

`frontend/src/lib/notices/shapes.ts` :

```ts
/**
 * Le texte et le ton de chaque sorte de notification.
 *
 * Pur, et sans alias : c'est la moitié du système qui se teste sous Bun. Les
 * boutons vivent dans `actions.ts`, parce qu'eux ont besoin de la socket.
 *
 * Ajouter une notification au projet, c'est ajouter une entrée ici. Le
 * compilateur exige alors `text` et `tone`, et `notices.test.ts` exige un
 * texte non vide dans les deux langues.
 */

import { t } from '../i18n/translations.js';
import type { NoticeShape } from './notice.js';

export const NOTICE_SHAPES: Record<string, NoticeShape> = {
  /**
   * Le message déjà traduit, tel que `notifications.show()` le reçoit.
   *
   * Le pont de compatibilité : ses huit appelants passent une chaîne, pas une
   * clé, et les réécrire serait un second chantier.
   */
  raw: {
    text: (params) => String(params.message ?? ''),
    tone: 'info'
  }
};

export function shapeOf(kind: string): NoticeShape | null {
  return NOTICE_SHAPES[kind] ?? null;
}
```

> Note pour l'implémenteur : `t` est importé sans être encore utilisé — les
> `kind` des tâches 4 et 7 s'en servent. Si le linter proteste à cette étape,
> retirer l'import et le remettre à la tâche 4 plutôt que d'inventer un usage.

- [ ] **Step 5: Nommer le test dans `test:ui`**

Dans `package.json`, ajouter `core/test/notices.test.ts` à la fin de la liste du script `test:ui`, juste après `core/test/docs-content.test.ts`.

- [ ] **Step 6: Vérifier que ça passe, et que ça tourne**

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun test core/test/notices.test.ts
bun run test:ui
```

Attendu : 3 tests dans le fichier, et **1254 pass** au total (1251 avant). Si le total est resté à 1251, l'ajout à `test:ui` n'a pas pris.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/notices/notice.ts frontend/src/lib/notices/shapes.ts core/test/notices.test.ts package.json
git commit -m "Dire ce qu'est une notification, avant de savoir qui la montre"
```

---

## Task 2: Le store — poser, retirer, compter

**Files:**
- Create: `frontend/src/lib/notices/store.ts`
- Modify: `core/test/notices.test.ts`

**Interfaces:**
- Consumes: `Notice`, `NoticeParams` (tâche 1).
- Produces: `createNotices()` rendant `{ list: Readable<Notice[]>, open: Readable<boolean>, count: Readable<number>, post(kind, params, options?): string, dismiss(id), openCentre(), closeCentre(), sweep(now), hydrate(notices) }`.

- [ ] **Step 1: Écrire les tests qui échouent**

Ajouter à `core/test/notices.test.ts` :

```ts
import { get } from 'svelte/store';
import { createNotices } from '../../frontend/src/lib/notices/store.js';

test('poser une notification la met dans la liste et dans le compte', () => {
	const notices = createNotices();

	notices.post('raw', { message: 'Sauvegarde creee' });

	assert.equal(get(notices.list).length, 1);
	assert.equal(get(notices.count), 1);
});

test('la plus recente vient en dernier', () => {
	const notices = createNotices();

	notices.post('raw', { message: 'un' });
	notices.post('raw', { message: 'deux' });

	assert.deepEqual(
		get(notices.list).map((n) => n.params.message),
		['un', 'deux']
	);
});

test('fermer le centre consomme ce qui n a pas de bouton', () => {
	// Et non l ouvrir : videes a l ouverture, elles s effaceraient sous les
	// yeux de qui vient les lire.
	const notices = createNotices();
	notices.post('raw', { message: 'un' });

	notices.openCentre();
	assert.equal(get(notices.list).length, 1, 'la liste doit tenir pendant la lecture');

	notices.closeCentre();
	assert.equal(get(notices.list).length, 0);
});

test('ce qui arrive pendant la lecture s ajoute, puis s en va avec le reste', () => {
	const notices = createNotices();
	notices.openCentre();

	notices.post('raw', { message: 'pendant' });
	assert.equal(get(notices.list).length, 1);

	notices.closeCentre();
	assert.equal(get(notices.list).length, 0);
});

test('une echeance depassee quitte la liste', () => {
	const notices = createNotices();
	notices.post('raw', { message: 'dix minutes' }, { expiresAt: 1_000 });

	notices.sweep(1_001);

	assert.equal(get(notices.list).length, 0);
});

test('retirer par identifiant ne touche pas les autres', () => {
	const notices = createNotices();
	const id = notices.post('raw', { message: 'un' });
	notices.post('raw', { message: 'deux' });

	notices.dismiss(id);

	assert.deepEqual(
		get(notices.list).map((n) => n.params.message),
		['deux']
	);
});
```

- [ ] **Step 2: Le lancer pour le voir échouer**

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun test core/test/notices.test.ts
```

Attendu : `Cannot find module '../../frontend/src/lib/notices/store.js'`.

- [ ] **Step 3: Écrire le store**

`frontend/src/lib/notices/store.ts` :

```ts
/**
 * La liste des notifications, et la lecture du centre.
 *
 * Une fabrique et non un singleton, pour la raison que `keep-offer.ts` donne
 * pour la sienne : deux centres ne coexistent pas, mais deux tests si. Le
 * singleton de l'application vit dans `services/notification.ts`.
 *
 * Aucune connaissance des boutons ici - seulement de leur existence, par
 * `hasActions`, injectée. C'est ce qui garde ce fichier sous Bun.
 */

import { derived, get, writable, type Readable } from 'svelte/store';
import type { Notice, NoticeParams } from './notice.js';

export interface NoticesDeps {
  /** Ce kind porte-t-il des boutons ? Décide de ce que la fermeture consomme. */
  hasActions?(kind: string): boolean;
  /** L'horloge, pour que les tests n'aient pas à attendre. */
  now?(): number;
}

export interface PostOptions {
  readonly expiresAt?: number;
}

export interface Notices {
  readonly list: Readable<Notice[]>;
  readonly open: Readable<boolean>;
  readonly count: Readable<number>;
  post(kind: string, params: NoticeParams, options?: PostOptions): string;
  dismiss(id: string): void;
  openCentre(): void;
  closeCentre(): void;
  /** Retire ce qui a passé son échéance. Appelée par une horloge, et testable. */
  sweep(now: number): void;
  /** Remet en place ce qui revient du stockage, sans rien notifier. */
  hydrate(notices: readonly Notice[]): void;
}

export function createNotices(deps: NoticesDeps = {}): Notices {
  const hasActions = deps.hasActions ?? (() => false);
  const now = deps.now ?? (() => Date.now());

  const list = writable<Notice[]>([]);
  const open = writable(false);
  let sequence = 0;

  function post(kind: string, params: NoticeParams, options: PostOptions = {}): string {
    const id = `${now()}-${sequence++}`;
    const notice: Notice = { id, kind, params, at: now(), expiresAt: options.expiresAt };
    list.update((current) => [...current, notice]);
    return id;
  }

  function dismiss(id: string): void {
    list.update((current) => current.filter((n) => n.id !== id));
  }

  function closeCentre(): void {
    open.set(false);
    // Ce qui porte des boutons reste : il attend une réponse, et la pastille
    // doit continuer de dire qu'il y a quelque chose à faire.
    list.update((current) => current.filter((n) => hasActions(n.kind)));
  }

  return {
    list: { subscribe: list.subscribe },
    open: { subscribe: open.subscribe },
    count: derived(list, (current) => current.length),
    post,
    dismiss,
    openCentre: () => open.set(true),
    closeCentre,
    sweep(at: number) {
      list.update((current) => current.filter((n) => n.expiresAt === undefined || n.expiresAt > at));
    },
    hydrate(notices) {
      list.set([...get(list), ...notices]);
    }
  };
}
```

- [ ] **Step 4: Vérifier que ça passe**

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun test core/test/notices.test.ts
```

Attendu : 9 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/notices/store.ts core/test/notices.test.ts
git commit -m "Tenir la liste, et ne vider qu'une fois le centre refermé"
```

---

## Task 3: La persistance

**Files:**
- Create: `frontend/src/lib/notices/persist.ts`
- Modify: `core/test/notices.test.ts`

**Interfaces:**
- Consumes: `Notice` (tâche 1), `shapeOf` (tâche 1).
- Produces: `NOTICES_KEY`, `readNotices(storage, now)`, `writeNotices(storage, notices)`.

- [ ] **Step 1: Écrire les tests qui échouent**

Ajouter à `core/test/notices.test.ts` :

```ts
import {
	NOTICES_KEY,
	readNotices,
	writeNotices
} from '../../frontend/src/lib/notices/persist.js';

/** Un stockage de test, sans navigateur. */
function fakeStorage(initial: Record<string, string> = {}) {
	const data = new Map(Object.entries(initial));
	return {
		data,
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => void data.set(key, value),
		removeItem: (key: string) => void data.delete(key)
	};
}

const RAW = { id: 'a', kind: 'raw', params: { message: 'un' }, at: 10 };

test('ce qui est ecrit se relit', () => {
	const storage = fakeStorage();

	writeNotices(storage, [RAW]);

	assert.deepEqual(readNotices(storage, 100), [RAW]);
});

test('une echeance depassee ne ressort pas', () => {
	const storage = fakeStorage();
	writeNotices(storage, [{ ...RAW, expiresAt: 50 }]);

	assert.deepEqual(readNotices(storage, 51), []);
});

test('un kind qui depend d une session vivante ne ressort pas', () => {
	// La socket est morte avec l onglet : la reposer, c est offrir un bouton
	// qui ne peut plus rien declencher.
	const storage = fakeStorage();
	writeNotices(storage, [{ ...RAW, kind: 'share-offer' }]);

	assert.deepEqual(readNotices(storage, 100), []);
});

test('un kind que cette version ne connait plus ne ressort pas', () => {
	const storage = fakeStorage();
	writeNotices(storage, [{ ...RAW, kind: 'ce-kind-a-ete-supprime' }]);

	assert.deepEqual(readNotices(storage, 100), []);
});

test('un stockage illisible rend une liste vide et s efface', () => {
	const storage = fakeStorage({ [NOTICES_KEY]: '{ pas du json' });

	assert.deepEqual(readNotices(storage, 100), []);
	assert.equal(storage.data.has(NOTICES_KEY), false);
});

test('ecrire une liste vide efface l entree', () => {
	const storage = fakeStorage();
	writeNotices(storage, [RAW]);

	writeNotices(storage, []);

	assert.equal(storage.data.has(NOTICES_KEY), false);
});
```

> `share-offer` n'existera comme `kind` qu'à la tâche 7. Ce test passe dès
> maintenant parce qu'un `kind` inconnu est purgé par la même règle ; il
> continuera de passer quand le `kind` existera, grâce à son `live: true`.
> C'est voulu : la règle est testée des deux côtés de son arrivée.

- [ ] **Step 2: Le lancer pour le voir échouer**

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun test core/test/notices.test.ts
```

Attendu : `Cannot find module '../../frontend/src/lib/notices/persist.js'`.

- [ ] **Step 3: Écrire la persistance**

`frontend/src/lib/notices/persist.ts` :

```ts
/**
 * Ce qui, du centre, traverse un rechargement.
 *
 * Prend son stockage plutôt que d'attraper `localStorage`, comme les
 * préférences de `stores/` : testable sans navigateur, et sans rien à faire
 * du rendu côté serveur.
 *
 * Purge à la LECTURE et non à l'écriture, délibérément : ce qui décide -
 * l'heure qu'il est, les `kind` que cette version connaît - n'est vrai qu'au
 * moment de relire. Une entrée écrite valide peut devenir périmée dans le
 * stockage sans que personne n'ait rien écrit.
 */

import type { Notice } from './notice.js';
import { shapeOf } from './shapes.js';

export const NOTICES_KEY = 'psnes-notices';

interface Storage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function usable(notice: Notice, now: number): boolean {
  const shape = shapeOf(notice.kind);
  // Un kind que cette version ne connaît plus n'a ni texte ni boutons : la
  // reposer afficherait une ligne vide que rien ne peut fermer.
  if (!shape) return false;
  // Ce qui vit sur une socket n'a plus d'interlocuteur après un rechargement.
  if (shape.live) return false;
  if (notice.expiresAt !== undefined && notice.expiresAt <= now) return false;
  return true;
}

export function readNotices(storage: Storage, now: number): Notice[] {
  const stored = storage.getItem(NOTICES_KEY);
  if (!stored) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    // Effacée plutôt que laissée : une entrée illisible ne le deviendra pas,
    // et la relire à chaque démarrage coûte un try/catch pour rien.
    storage.removeItem(NOTICES_KEY);
    return [];
  }

  if (!Array.isArray(parsed)) {
    storage.removeItem(NOTICES_KEY);
    return [];
  }

  return (parsed as Notice[]).filter((notice) => notice?.kind && usable(notice, now));
}

export function writeNotices(storage: Storage, notices: readonly Notice[]): void {
  if (notices.length === 0) {
    storage.removeItem(NOTICES_KEY);
    return;
  }
  storage.setItem(NOTICES_KEY, JSON.stringify(notices));
}
```

- [ ] **Step 4: Vérifier que ça passe**

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun test core/test/notices.test.ts
```

Attendu : 15 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/notices/persist.ts core/test/notices.test.ts
git commit -m "Retrouver ce qu'on n'a pas lu, et rien de ce qui ne vaut plus"
```

---

## Task 4: La couche de compatibilité, et les deux toasts maison

**Files:**
- Create: `frontend/src/lib/notices/actions.ts`
- Modify: `frontend/src/lib/services/notification.ts`
- Modify: `frontend/src/routes/+page.svelte`
- Modify: `frontend/src/routes/room/[id]/+page.svelte`
- Modify: `core/test/notices.test.ts`

**Interfaces:**
- Consumes: `createNotices` (tâche 2), `readNotices`/`writeNotices` (tâche 3).
- Produces: `registerNoticeActions(kind, actions)`, `actionsOf(kind)`, `hasActions(kind)` ; et le singleton `notices` plus le store de compatibilité `notifications` exporté par `services/notification.ts`.

- [ ] **Step 1: Écrire les tests qui échouent**

Ajouter à `core/test/notices.test.ts` :

```ts
import {
	actionsOf,
	hasActions,
	registerNoticeActions
} from '../../frontend/src/lib/notices/actions.js';

test('un kind sans boutons enregistres n en a pas', () => {
	assert.equal(hasActions('raw'), false);
	assert.deepEqual(actionsOf('raw'), []);
});

test('des boutons enregistres se retrouvent par leur kind', () => {
	const run = () => {};
	registerNoticeActions('essai', [{ label: 'cancel', run }]);

	assert.equal(hasActions('essai'), true);
	assert.equal(actionsOf('essai').length, 1);
});
```

> Ce test pose une globale de module (`essai`) : `bun` partage le processus
> entre fichiers, donc ne jamais enregistrer sous un `kind` réel depuis un
> test, sous peine de le voir agir dans un autre fichier.

- [ ] **Step 2: Le lancer pour le voir échouer**

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun test core/test/notices.test.ts
```

Attendu : `Cannot find module '../../frontend/src/lib/notices/actions.js'`.

- [ ] **Step 3: Écrire le registre d'actions**

`frontend/src/lib/notices/actions.ts` :

```ts
/**
 * Les boutons, séparés du texte parce qu'ils ne se testent pas de la même
 * façon.
 *
 * `shapes.ts` est pur et se lit sous Bun. Les actions, elles, appellent
 * `acceptInvitation`, `sharing().accept` ou `offer.decline` - qui veulent la
 * socket, `$app/environment` et IndexedDB. Les importer depuis le registre
 * ferait entrer tout cela dans la suite de tests par un import transitif.
 *
 * Elles s'enregistrent donc à l'exécution, depuis `bridges.ts`, qui ne tourne
 * que dans un navigateur. Dans un test, la table est vide et le centre rend
 * des notifications sans boutons - ce qui est exactement ce qu'on veut y
 * tester.
 */

import type { NoticeAction } from './notice.js';

const table = new Map<string, readonly NoticeAction[]>();

export function registerNoticeActions(kind: string, actions: readonly NoticeAction[]): void {
  table.set(kind, actions);
}

export function actionsOf(kind: string): readonly NoticeAction[] {
  return table.get(kind) ?? [];
}

export function hasActions(kind: string): boolean {
  return actionsOf(kind).length > 0;
}
```

- [ ] **Step 4: Vérifier que ça passe**

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun test core/test/notices.test.ts
```

Attendu : 17 pass, 0 fail.

- [ ] **Step 5: Réécrire `services/notification.ts` en couche de compatibilité**

Remplacer tout le contenu de `frontend/src/lib/services/notification.ts` par :

```ts
/**
 * L'API que huit fichiers appellent, au-dessus du centre.
 *
 * Elle ne bouge pas : `show(message, type, duration)` rend un identifiant,
 * `dismiss` le reprend, et le store reste un tableau d'objets portant `id`,
 * `message` et `type` - c'est ce que `VrShell` lit pour peindre le bandeau du
 * casque, et aucun test ne verrait cette forme se casser.
 *
 * Ce qui change est dessous : le message devient une notification de `kind`
 * `'raw'`, retenue par le centre après que le toast a disparu.
 */

import { derived, get } from 'svelte/store';
import { createNotices } from '$lib/notices/store';
import { hasActions } from '$lib/notices/actions';
import { readNotices, writeNotices } from '$lib/notices/persist';
import type { Notice } from '$lib/notices/notice';

export type NotificationType = 'success' | 'error' | 'info' | 'warning';

export interface Notification {
  id: string;
  message: string;
  type: NotificationType;
}

/** Le centre de cette session. Un seul, contrairement à la fabrique. */
export const notices = createNotices({ hasActions });

/** Le stockage, ou rien quand il est refusé - navigation privée, par exemple. */
function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Ce que le rechargement a laissé. Appelée une fois, depuis le layout. */
export function restoreNotices(): void {
  const store = storage();
  if (store) notices.hydrate(readNotices(store, Date.now()));
}

// Écrit à chaque changement plutôt qu'au déchargement : `beforeunload` n'est
// pas tenu sur mobile, et un onglet tué n'en dit rien.
notices.list.subscribe((list) => {
  const store = storage();
  if (store) writeNotices(store, list);
});

/**
 * Le tableau que les appelants historiques lisent.
 *
 * Seules les notifications de `kind` `'raw'` y figurent : c'est la forme que
 * cette API sait décrire, et le bandeau VR n'a que faire d'une invitation
 * qu'il ne peut pas peindre.
 */
export const notifications = {
  subscribe: derived(notices.list, (list: Notice[]) =>
    list
      .filter((notice) => notice.kind === 'raw')
      .map((notice) => ({
        id: notice.id,
        message: String(notice.params.message ?? ''),
        type: (notice.params.tone ?? 'info') as NotificationType
      }))
  ).subscribe,

  /**
   * `duration` est un temps d'ÉCRAN, et non une durée de vie.
   *
   * C'est le seul endroit où ce plan corrige le sens d'un paramètre existant,
   * et il faut le dire : `show()` retirait la notification après sa durée.
   * Garder ce comportement viderait le centre de tout ce qu'il est censé
   * rattraper - une notification effacée trois secondes après sa naissance
   * n'est jamais lue par quelqu'un qui regardait ailleurs.
   *
   * Le compte à rebours appartient donc au toast, qui cesse de la peindre ;
   * elle, reste jusqu'à la fermeture du centre.
   */
  show(message: string, type: NotificationType = 'info', duration: number = 3000): string {
    return notices.post('raw', { message, tone: type, seconds: duration / 1000 });
  },

  dismiss(id: string): void {
    notices.dismiss(id);
  },

  clear(): void {
    for (const notice of get(notices.list)) notices.dismiss(notice.id);
  }
};
```

> **Attention, régression à ne pas introduire :** `show()` rendait un `number`
> et rend maintenant un `string`. `TopBar.svelte` l. 267-271 garde le retour
> dans une variable `toast` et le repasse à `dismiss`. Vérifier que
> `svelte-check` reste à 0 erreur après cette étape ; si la variable est
> annotée `number`, corriger l'annotation, pas le type rendu.

- [ ] **Step 6: Supprimer le toast maison de l'accueil**

Dans `frontend/src/routes/+page.svelte` : supprimer `showToast`, `toastMessage`,
`toastType` (l. 125-127), le corps de `showNotification` (l. 357-361) et le
bloc `{#if showToast}` (l. 798 et suivantes) ainsi que les règles `.toast`,
`.toast-content`, `.toast-icon`, `.toast-message` de son `<style>`.
Remplacer le corps de `showNotification` par un appel :

```ts
  import { notifications } from '$lib/services/notification';

  function showNotification(message: string, type: 'success' | 'error' = 'success') {
    notifications.show(message, type);
  }
```

> Garder la fonction plutôt que réécrire ses appelants : elle est appelée
> depuis plusieurs endroits de la page, et la tâche est de supprimer une
> réimplémentation, pas de renommer des appels.

- [ ] **Step 7: Supprimer le toast maison du salon**

Même opération dans `frontend/src/routes/room/[id]/+page.svelte` : `showToast`,
`toastMessage`, `toastType` (l. 52-54), le corps de `showNotification`
(l. 314-319), le bloc `{#if showToast}` (l. 983) et les règles `.toast` de son
`<style>`. Ce fichier importe déjà `notifications` (il l'appelle l. 532) : ne
pas ajouter un second import.

Le commentaire de la l. 526 décrit l'ancien mécanisme (« `showNotification`
writes to a `showToast` this page renders itself ») — le réécrire, ne pas le
laisser mentir.

- [ ] **Step 8: Vérifier**

```bash
export PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$HOME/.bun/bin:$PATH"
bun run test:ui
cd frontend && bun run check
```

Attendu : **1268 pass**, et `svelte-check` à **0 erreur**. Le nombre
d'avertissements doit rester à 14 ou baisser ; s'il monte, c'est du CSS devenu
inutilisé qu'on a oublié de supprimer aux étapes 6 et 7.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/lib/notices/actions.ts frontend/src/lib/services/notification.ts frontend/src/routes/+page.svelte "frontend/src/routes/room/[id]/+page.svelte" core/test/notices.test.ts
git commit -m "Ramener les deux toasts maison sur le store qu'ils recopiaient"
```

---

## Task 5: Le toast

**Files:**
- Create: `frontend/src/lib/components/NoticeToast.svelte`
- Modify: `frontend/src/lib/notices/shapes.ts`
- Modify: `core/test/notices.test.ts`
- Modify: `frontend/src/routes/+layout.svelte`
- Modify: `frontend/src/lib/i18n/translations.ts`

**Interfaces:**
- Consumes: `notices` et `restoreNotices` (tâche 4), `shapeOf` (tâche 1), `actionsOf` (tâche 4).
- Produces: `screenSeconds(notice)` dans `shapes.ts` ; le composant `NoticeToast`, monté une fois dans le layout.

Le rendu ne se teste pas ici — ce dépôt n'a pas d'outillage pour ça. La règle
qui décide ce qui reste à l'écran, elle, est une fonction pure et se teste :
c'est la première étape.

- [ ] **Step 1: Écrire le test du temps d'écran**

Ajouter à `core/test/notices.test.ts` :

```ts
import { screenSeconds } from '../../frontend/src/lib/notices/shapes.js';

const AT = { id: 'x', params: {}, at: 0 };

test('sans rien de dit, une notification tient six secondes a l ecran', () => {
	assert.equal(screenSeconds({ ...AT, kind: 'raw' }), 6);
});

test('la duree passee a show l emporte sur la valeur par defaut', () => {
	assert.equal(screenSeconds({ ...AT, kind: 'raw', params: { seconds: 5 } }), 5);
});

test('un kind qui se repond ne s efface pas tout seul', () => {
	// `keep-rom` arrive a la tache 7 ; jusque-la un kind inconnu tombe sur la
	// valeur par defaut, ce que le premier test dit deja.
	assert.equal(screenSeconds({ ...AT, kind: 'raw', params: { seconds: 0 } }), 0);
});
```

- [ ] **Step 2: Le lancer pour le voir échouer**

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun test core/test/notices.test.ts
```

Attendu : `screenSeconds is not a function`.

- [ ] **Step 3: Écrire la fonction**

Ajouter à `frontend/src/lib/notices/shapes.ts` :

```ts
/** Six secondes : de quoi lire une phrase sans avoir à la relire. */
export const DEFAULT_SECONDS = 6;

/**
 * Combien de temps une notification reste à l'écran. Zéro = jusqu'à réponse.
 *
 * Un temps d'écran, et non une durée de vie : passé ce délai la notification
 * quitte le toast et reste dans le centre. Confondre les deux viderait le
 * centre de tout ce qu'il est censé rattraper.
 */
export function screenSeconds(notice: Pick<Notice, 'kind' | 'params'>): number {
  const declared = notice.params.seconds ?? shapeOf(notice.kind)?.seconds ?? DEFAULT_SECONDS;
  return Number(declared);
}
```

Ajouter `import type { Notice, NoticeShape } from './notice.js';` en tête du
fichier, en remplacement de l'import de type existant.

- [ ] **Step 4: Vérifier que ça passe**

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun test core/test/notices.test.ts
```

Attendu : 20 pass, 0 fail.

- [ ] **Step 5: Écrire le composant**

`frontend/src/lib/components/NoticeToast.svelte` :

```svelte
<script lang="ts">
  /**
   * Ce qui passe à l'écran, et qui remplace `NotificationToast`.
   *
   * Une seule pile, en haut à droite, où six surfaces se tenaient. Un toast
   * porte maintenant des boutons quand son `kind` en a : c'est ce qui permet
   * de répondre à une invitation en un clic, comme la carte épinglée le
   * permettait, sans garder la carte épinglée.
   */
  import { onMount, onDestroy } from 'svelte';
  import { fly } from 'svelte/transition';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import { inGame } from '$lib/stores/in-game';
  import { notices } from '$lib/services/notification';
  import { shapeOf, screenSeconds } from '$lib/notices/shapes';
  import { actionsOf } from '$lib/notices/actions';
  import type { Notice } from '$lib/notices/notice';

  const list = notices.list;

  let now = Date.now();
  let clock: ReturnType<typeof setInterval> | undefined;

  onMount(() => {
    clock = setInterval(() => (now = Date.now()), 500);
  });

  onDestroy(() => clearInterval(clock));

  /**
   * Ce qui a le droit d'être à l'écran en ce moment.
   *
   * Le compte à rebours part de `at`, la naissance de la notification, et non
   * du moment où ce composant l'a vue. C'est ce qui fait qu'une notification
   * revenue du stockage ne resurgit pas à l'écran au rechargement : son `at`
   * est déjà loin, elle est donc directement dans le centre - ce qu'on veut
   * d'un rattrapage.
   *
   * Rien pendant une partie, sauf ce qui porte `duringGame` : un panneau
   * au-dessus d'un émulateur vole un clic, et accepter une invitation ferait
   * sortir le joueur de son match. La notification n'est pas perdue pour
   * autant - elle est dans le centre, et la pastille le dit.
   *
   * `now` et `$list` sont nommés DANS l'expression réactive, jamais seulement
   * lus au fond d'une fonction : en Svelte 4, une dépendance cachée dans un
   * corps de fonction ne redéclenche rien, et ce fichier a besoin de battre.
   */
  $: shown = $list.filter((notice: Notice) => {
    const shape = shapeOf(notice.kind);
    if (!shape) return false;
    if ($inGame && shape.duringGame !== true) return false;

    const seconds = screenSeconds(notice);
    return seconds === 0 || now < notice.at + seconds * 1000;
  });

  async function act(notice: Notice, index: number) {
    // Retirée d'abord : `run` peut attendre le réseau, et un second clic sur
    // un bouton déjà pressé enverrait deux réponses.
    notices.dismiss(notice.id);
    await actionsOf(notice.kind)[index]?.run(notice.params);
  }
</script>

{#if shown.length > 0}
  <div class="toasts">
    {#each shown as notice (notice.id)}
      {@const shape = shapeOf(notice.kind)}
      {@const actions = actionsOf(notice.kind)}
      <div class="toast toast-{shape?.tone ?? 'info'}" role="alert" transition:fly={{ y: -20, duration: 300 }}>
        <span class="toast-text">{shape?.text(notice.params, $language) ?? ''}</span>
        {#if actions.length > 0}
          <div class="toast-actions">
            {#each actions as action, index}
              <button class:primary={action.primary} on:click={() => act(notice, index)}>
                {t($language, action.label)}
              </button>
            {/each}
          </div>
        {:else}
          <button class="close" aria-label={t($language, 'close')} on:click={() => notices.dismiss(notice.id)}>
            ×
          </button>
        {/if}
      </div>
    {/each}
  </div>
{/if}

<style>
  .toasts {
    position: fixed;
    top: 20px;
    right: 20px;
    z-index: 9999;
    display: flex;
    flex-direction: column;
    gap: 10px;
    max-width: min(26rem, calc(100vw - 2rem));
  }

  .toast {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 0.75rem;
    padding: 0.75rem 1rem;
    border-radius: 0.75rem;
    background: rgba(20, 20, 30, 0.92);
    border: 1px solid #2c2c3c;
    color: #e6e6f0;
    font-size: 0.85rem;
  }

  .toast-text {
    flex: 1;
    min-width: 10rem;
  }

  .toast-actions {
    display: flex;
    gap: 0.5rem;
  }

  .toast-info { border-left: 3px solid #6f8bff; }
  .toast-success { border-left: 3px solid #3c8c64; }
  .toast-error { border-left: 3px solid #b8455a; }
  .toast-warning { border-left: 3px solid #b8934a; }

  button {
    padding: 0.35rem 0.8rem;
    border-radius: 999px;
    border: 1px solid #2c2c3c;
    background: #1b1b28;
    color: #e6e6f0;
    font-size: 0.8rem;
    cursor: pointer;
  }

  button.primary {
    background: #2f6f4f;
    border-color: #3c8c64;
  }

  button:hover { filter: brightness(1.15); }

  button:focus-visible {
    outline: 2px solid #6f8bff;
    outline-offset: 2px;
  }

  .close {
    border: none;
    background: transparent;
    padding: 0 0.25rem;
    font-size: 1.25rem;
    line-height: 1;
  }
</style>
```

- [ ] **Step 6: Ajouter la clé `close` si elle manque**

```bash
grep -n "    close:" frontend/src/lib/i18n/translations.ts
```

Si elle n'existe pas, l'ajouter dans les deux locales — `close: 'Close'` et
`close: 'Fermer'` — à côté de `cancel` (l. 155 et l. 745).

- [ ] **Step 7: Monter le nouveau toast dans le layout**

Dans `frontend/src/routes/+layout.svelte` : remplacer l'import et l'usage de
`NotificationToast` par `NoticeToast`, et appeler `restoreNotices()` dans le
`onMount` existant.

```svelte
  import NoticeToast from '$lib/components/NoticeToast.svelte';
  import { restoreNotices } from '$lib/services/notification';
```

```svelte
<NoticeToast />
```

Garder le commentaire qui explique pourquoi le toast est monté ici — « a toast
has to outlive the screen that raised it » — il reste vrai.

- [ ] **Step 8: Vérifier**

```bash
export PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$HOME/.bun/bin:$PATH"
cd frontend && bun run check
```

Attendu : 0 erreur.

- [ ] **Step 9: Regarder à l'écran**

Monter la pile jetable du worktree — la recette est dans la mémoire du projet
« Running the app from a worktree » : liens `node_modules` racine et
`backend/`, vrai dossier vide pour `frontend/node_modules`, backend sur
**:3000** avec `FRONTEND_URL=http://localhost:5273`, front sur 5273 via un
`vite.worktree.config.ts` jetable.

Déclencher une notification (une sauvegarde rapide suffit) et vérifier :
la pile s'affiche en haut à droite, le texte est lisible dans les deux langues,
le bouton de fermeture fonctionne, et **rien ne s'affiche pendant une partie**.

- [ ] **Step 10: Commit**

```bash
git add frontend/src/lib/components/NoticeToast.svelte frontend/src/lib/notices/shapes.ts frontend/src/routes/+layout.svelte frontend/src/lib/i18n/translations.ts core/test/notices.test.ts
git commit -m "Une seule pile là où six surfaces se tenaient"
```

---

## Task 6: La cloche, la pastille et le centre

**Files:**
- Create: `frontend/src/lib/components/NoticeCentre.svelte`
- Modify: `frontend/src/lib/components/TopBar.svelte`
- Modify: `frontend/src/lib/i18n/translations.ts`

**Interfaces:**
- Consumes: `notices` (tâche 4), `shapeOf` (tâche 1), `actionsOf` (tâche 4).
- Produces: le composant `NoticeCentre`, monté dans `TopBar`.

- [ ] **Step 1: Écrire le centre**

`frontend/src/lib/components/NoticeCentre.svelte` :

```svelte
<script lang="ts">
  /**
   * La cloche et ce qu'elle ouvre.
   *
   * Dans la barre du haut, donc absente de l'accueil déconnecté et d'une
   * partie en plein écran - c'est pourquoi `keep-rom` ne compte pas sur elle
   * et garde un toast qui ne s'efface pas.
   *
   * Le vidage a lieu à la FERMETURE : vidé à l'ouverture, le centre
   * s'effacerait sous les yeux de qui vient le lire. Ce qui arrive pendant la
   * lecture s'y ajoute, visiblement, et part avec le reste.
   */
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import { notices } from '$lib/services/notification';
  import { shapeOf } from '$lib/notices/shapes';
  import { actionsOf } from '$lib/notices/actions';
  import type { Notice } from '$lib/notices/notice';

  const list = notices.list;
  const open = notices.open;
  const count = notices.count;

  function toggle() {
    if ($open) notices.closeCentre();
    else notices.openCentre();
  }

  async function act(notice: Notice, index: number) {
    notices.dismiss(notice.id);
    await actionsOf(notice.kind)[index]?.run(notice.params);
  }
</script>

<!-- La cloche reste quand il n'y a rien : un élément de barre qui apparaît et
     disparaît fait sauter la mise en page, et une cloche muette dit « rien de
     nouveau », ce qui est une information. -->
<div class="bell-wrap">
  <button
    class="bell"
    aria-label={t($language, 'notices')}
    aria-expanded={$open}
    on:click={toggle}
  >
    <!-- SVG et non emoji : un caractère de cloche s'affiche en carré vide
         selon la police du système, comme la corbeille de la fiche du jeu. -->
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        d="M12 3a5 5 0 0 0-5 5v3.6L5.5 14.5h13L17 11.6V8a5 5 0 0 0-5-5Zm0 18a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 21Z"
        fill="currentColor"
      />
    </svg>
    {#if $count > 0}
      <span class="badge">{$count}</span>
    {/if}
  </button>

  {#if $open}
    <div class="panel" role="dialog" aria-label={t($language, 'notices')}>
      {#if $list.length === 0}
        <p class="empty">{t($language, 'noticesEmpty')}</p>
      {:else}
        <ul>
          {#each $list as notice (notice.id)}
            {@const shape = shapeOf(notice.kind)}
            {@const actions = actionsOf(notice.kind)}
            <li>
              <span class="text">{shape?.text(notice.params, $language) ?? ''}</span>
              {#if actions.length > 0}
                <div class="row-actions">
                  {#each actions as action, index}
                    <button class:primary={action.primary} on:click={() => act(notice, index)}>
                      {t($language, action.label)}
                    </button>
                  {/each}
                </div>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</div>

<style>
  .bell-wrap { position: relative; }

  .bell {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2.25rem;
    height: 2.25rem;
    border-radius: 8px;
    background: transparent;
    border: 1px solid #3d3d52;
    color: #b7b7cc;
    cursor: pointer;
  }

  .bell:hover { border-color: var(--edge); color: var(--label); }

  .badge {
    position: absolute;
    top: -0.35rem;
    right: -0.35rem;
    min-width: 1.1rem;
    padding: 0 0.25rem;
    border-radius: 999px;
    background: #b8455a;
    color: #fff;
    font-size: 0.68rem;
    line-height: 1.1rem;
    font-weight: 600;
  }

  .panel {
    position: absolute;
    top: calc(100% + 0.5rem);
    right: 0;
    z-index: 1000;
    width: min(24rem, calc(100vw - 2rem));
    max-height: 60vh;
    overflow-y: auto;
    padding: 0.5rem;
    border-radius: 0.75rem;
    background: rgba(20, 20, 30, 0.97);
    border: 1px solid #2c2c3c;
  }

  ul { list-style: none; margin: 0; padding: 0; }

  li {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem 0.75rem;
    align-items: center;
    padding: 0.6rem 0.5rem;
    border-bottom: 1px solid #24243a;
    color: #e6e6f0;
    font-size: 0.82rem;
  }

  li:last-child { border-bottom: none; }

  .text { flex: 1; min-width: 9rem; }

  .empty {
    margin: 0;
    padding: 1rem 0.5rem;
    color: #8b8ba3;
    font-size: 0.82rem;
    text-align: center;
  }

  .row-actions { display: flex; gap: 0.4rem; }

  button.primary { background: #2f6f4f; border-color: #3c8c64; }

  .row-actions button {
    padding: 0.3rem 0.7rem;
    border-radius: 999px;
    border: 1px solid #2c2c3c;
    background: #1b1b28;
    color: #e6e6f0;
    font-size: 0.78rem;
    cursor: pointer;
  }

  button:focus-visible { outline: 2px solid #6f8bff; outline-offset: 2px; }
</style>
```

- [ ] **Step 2: Ajouter les deux clés**

Dans `frontend/src/lib/i18n/translations.ts`, aux deux locales :

```ts
    notices: 'Notifications',
    noticesEmpty: 'Nothing new.',
```

```ts
    notices: 'Notifications',
    noticesEmpty: 'Rien de nouveau.',
```

- [ ] **Step 3: Monter la cloche dans la barre**

Dans `frontend/src/lib/components/TopBar.svelte`, importer `NoticeCentre` et
le placer dans la rangée de droite, avant le sélecteur de langue.

- [ ] **Step 4: Vérifier**

```bash
export PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$HOME/.bun/bin:$PATH"
bun run test:ui
cd frontend && bun run check
```

Attendu : 1271 pass, 0 erreur.

- [ ] **Step 5: Regarder à l'écran**

Avec la pile jetable : déclencher trois notifications, vérifier que la pastille
dit **3**, ouvrir le centre, vérifier que **la liste tient pendant la lecture**,
fermer, vérifier que la pastille retombe à zéro et que la cloche reste. Vérifier
au passage que la barre ne saute pas quand la pastille apparaît.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/components/NoticeCentre.svelte frontend/src/lib/components/TopBar.svelte frontend/src/lib/i18n/translations.ts
git commit -m "Rattraper ce qu'on a manqué, derrière une cloche"
```

---

## Task 7: Les trois demandes, et la fin des trois cartes

**Files:**
- Create: `frontend/src/lib/notices/bridges.ts`
- Modify: `frontend/src/lib/notices/shapes.ts`
- Modify: `frontend/src/routes/+layout.svelte`
- Modify: `frontend/src/lib/i18n/translations.ts`
- Modify: `core/test/notices.test.ts`
- Delete: `frontend/src/lib/components/InvitationCard.svelte`, `ShareOffer.svelte`, `KeepRomOffer.svelte`, `NotificationToast.svelte`

**Interfaces:**
- Consumes: `invitations`, `acceptInvitation`, `declineInvitation` de `lib/lobby/invitations.ts` ; `sharing()` de `lib/stores/sharing.ts` ; l'instance `KeepOffer` que `LockstepRoom` et `P2PRoom` construisent.
- Produces: `startNoticeBridges()`, appelée une fois depuis le layout.

- [ ] **Step 1: Écrire les tests des formes qui échouent**

Ajouter à `core/test/notices.test.ts` :

```ts
test('l invitation se nomme par celui qui invite et par le jeu', () => {
	const shape = shapeOf('invitation');

	assert.ok(shape);
	assert.match(shape.text({ name: 'Bob', title: 'Umihara Kawase' }, 'fr'), /Bob/);
	assert.equal(shape.duringGame ?? false, false, 'une invitation ne coupe pas une partie');
});

test('l offre de jeu depend d une session vivante', () => {
	assert.equal(shapeOf('share-offer')?.live, true);
});

test('garder la ROM se repond pendant une partie, et ne s efface pas', () => {
	// La barre du haut - donc la cloche - n existe pas en plein ecran : une
	// question posee pendant une partie doit tenir jusqu a la reponse.
	const shape = shapeOf('keep-rom');

	assert.equal(shape?.duringGame, true);
	assert.equal(shape?.seconds, 0);
	assert.equal(shape?.live, true);
});
```

- [ ] **Step 2: Le lancer pour le voir échouer**

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun test core/test/notices.test.ts
```

Attendu : trois échecs sur `shapeOf(...)` rendant `null`.

- [ ] **Step 3: Ajouter les trois formes**

Dans `frontend/src/lib/notices/shapes.ts`, à l'intérieur de `NOTICE_SHAPES` :

```ts
  /** « Bob t'invite sur Umihara Kawase ». Dix minutes, puis elle s'en va seule. */
  invitation: {
    text: (params, lang) =>
      params.title
        ? t(lang, 'invitationWithGame', { name: String(params.name), title: String(params.title) })
        : t(lang, 'invitationNoGame', { name: String(params.name) }),
    tone: 'info',
    live: true
  },

  /** « Bob veut t'envoyer Umihara Kawase ». La phrase que `ShareOffer` portait. */
  'share-offer': {
    text: (params, lang) =>
      t(lang, 'shareOffer', { name: String(params.name), title: String(params.title) }),
    tone: 'info',
    live: true
  },

  /**
   * « Le garder sur cet appareil ? », posée pendant que la partie tourne.
   *
   * `seconds: 0` et `duringGame` vont ensemble : la cloche n'existe pas en
   * plein écran, donc une question qui s'efface là serait sans recours.
   */
  'keep-rom': {
    text: (params, lang) =>
      `${params.title ? `${params.title} — ` : ''}${t(lang, 'keepRom')}`,
    tone: 'info',
    live: true,
    duringGame: true,
    seconds: 0
  }
```

- [ ] **Step 4: Ajouter les deux clés d'invitation**

`shareOffer` et `keepRom` existent déjà. Ajouter aux deux locales :

```ts
    invitationWithGame: '{name} invites you to play {title}',
    invitationNoGame: '{name} invites you to play',
```

```ts
    invitationWithGame: '{name} t\'invite à jouer à {title}',
    invitationNoGame: '{name} t\'invite à jouer',
```

- [ ] **Step 5: Vérifier que les tests passent**

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun test core/test/notices.test.ts
```

Attendu : 23 pass, 0 fail.

- [ ] **Step 6: Écrire les ponts**

`frontend/src/lib/notices/bridges.ts` :

```ts
/**
 * Ce qui pose et retire les notifications à boutons.
 *
 * Un pont par source. Chacune garde sa logique - `lobby/invitations.ts`,
 * `stores/sharing.ts`, `roms/keep-offer.ts` sont inchangés - et perd seulement
 * son rendu propre.
 *
 * Navigateur uniquement : c'est ici que les alias `$lib` et la socket entrent,
 * et c'est pourquoi le reste de `notices/` n'en connaît rien.
 */

import { get } from 'svelte/store';
import {
  invitations,
  acceptInvitation,
  declineInvitation,
  type Invitation
} from '$lib/lobby/invitations';
import { sharing } from '$lib/stores/sharing';
import { myRoom } from '$lib/rooms/my-room';
import { notices } from '$lib/services/notification';
import { registerNoticeActions } from '$lib/notices/actions';

let started = false;

export function startNoticeBridges(): void {
  // Le layout se remonte à chaque navigation côté client ; deux ponts sur une
  // source poseraient chaque notification deux fois.
  if (started) return;
  started = true;

  registerNoticeActions('invitation', [
    { label: 'accept', primary: true, run: (params) => acceptInvitation(String(params.id)) },
    { label: 'decline', run: (params) => declineInvitation(String(params.id)) }
  ]);

  registerNoticeActions('share-offer', [
    { label: 'shareAccept', primary: true, run: () => sharing().accept() },
    { label: 'keepRomNo', run: () => sharing().decline() }
  ]);

  /**
   * Les invitations arrivent en liste, pas une par une.
   *
   * Le serveur pousse `lobby:invitations` à la connexion puis une liste
   * complète à chaque changement. On pose ce qui est nouveau et on retire ce
   * qui n'y est plus - une invitation annulée, acceptée, ou périmée côté
   * serveur.
   */
  const posted = new Map<string, string>();

  invitations.subscribe((list: Invitation[]) => {
    const live = new Set(list.map((i) => i.id));

    for (const [invitationId, noticeId] of posted) {
      if (!live.has(invitationId)) {
        notices.dismiss(noticeId);
        posted.delete(invitationId);
      }
    }

    for (const invitation of list) {
      if (posted.has(invitation.id)) continue;
      const noticeId = notices.post(
        'invitation',
        {
          id: invitation.id,
          name: invitation.fromPseudo,
          title: invitation.gameTitle ?? ''
        },
        { expiresAt: new Date(invitation.expiresAt).getTime() }
      );
      posted.set(invitation.id, noticeId);
    }
  });

  /** L'offre de jeu : une seule à la fois, donc un seul identifiant à retenir. */
  let offerNotice: string | null = null;

  sharing().offered.subscribe((offer) => {
    if (offerNotice) {
      notices.dismiss(offerNotice);
      offerNotice = null;
    }
    if (!offer) return;

    // Le pseudo vient du salon : le relais ne transporte qu'un identifiant.
    const name =
      get(myRoom)?.players?.find((p: { userId: string }) => p.userId === offer.from)?.pseudo ?? '';

    offerNotice = notices.post('share-offer', { name, title: offer.title });
  });

  // L'horloge des échéances, que `InvitationCard` tenait pour elle seule : une
  // invitation périmée doit quitter l'écran sans qu'aucun message ne l'annonce,
  // puisqu'il ne s'est rien passé sur le serveur.
  setInterval(() => notices.sweep(Date.now()), 15_000);
}
```

> `keep-rom` n'est pas branché ici : son `KeepOffer` est construit par
> `LockstepRoom` et `P2PRoom`, pas au niveau du layout. L'étape 8 le branche
> là où il est construit.

- [ ] **Step 7: Ajouter les libellés des boutons**

Vérifier lesquels existent déjà :

```bash
grep -nE "^    (accept|decline|shareAccept|keepRomNo|keepRomYes):" frontend/src/lib/i18n/translations.ts
```

`shareAccept`, `keepRomNo` et `keepRomYes` existent. Ajouter `accept` et
`decline` aux deux locales s'ils manquent — `'Accept'` / `'Decline'`,
`'Accepter'` / `'Refuser'`.

- [ ] **Step 8: Brancher `keep-rom` là où il est construit**

Les deux salons montent la même ligne, avec les mêmes noms —
`LockstepRoom.svelte:1366` et `P2PRoom.svelte:1033` :

```svelte
<KeepRomOffer offer={keepOffer} title={gameTitle} />
```

La supprimer dans les deux, ainsi que l'import `KeepRomOffer`
(`LockstepRoom.svelte:36`, `P2PRoom.svelte:8`), et poser à la place, à côté de
la construction du `keepOffer` :

```ts
  import { notices } from '$lib/services/notification';
  import { registerNoticeActions } from '$lib/notices/actions';

  registerNoticeActions('keep-rom', [
    { label: 'keepRomYes', primary: true, run: () => keepOffer.accept() },
    { label: 'keepRomNo', run: () => keepOffer.decline() }
  ]);

  let keepNotice: string | null = null;

  const stopKeepWatch = keepOffer.asked.subscribe((checksum) => {
    if (keepNotice) {
      notices.dismiss(keepNotice);
      keepNotice = null;
    }
    if (checksum) keepNotice = notices.post('keep-rom', { title: gameTitle ?? '' });
  });

  onDestroy(stopKeepWatch);
```

> `onDestroy` est déjà importé dans les deux salons ; ne pas l'ajouter une
> seconde fois. Et se désabonner vraiment : ces deux composants se montent et
> se démontent à chaque partie, et un abonnement laissé derrière reposerait la
> question au salon suivant.

- [ ] **Step 9: Démarrer les ponts et supprimer les quatre composants**

Dans `frontend/src/routes/+layout.svelte` :
- appeler `startNoticeBridges()` dans le `onMount` existant, après
  `restoreNotices()` ;
- supprimer les imports et les montages de `InvitationCard` et `ShareOffer`, et
  les commentaires qui expliquaient pourquoi ils étaient montés là — réécrire
  celui du toast pour qu'il dise la même chose du centre.

Puis :

```bash
git rm frontend/src/lib/components/InvitationCard.svelte frontend/src/lib/components/ShareOffer.svelte frontend/src/lib/components/KeepRomOffer.svelte frontend/src/lib/components/NotificationToast.svelte
grep -rn "InvitationCard\|ShareOffer\|KeepRomOffer\|NotificationToast" frontend/src core e2e
```

Le `grep` doit ne rien rendre. S'il rend quelque chose dans `e2e/`, corriger la
spec concernée : son sélecteur vise une carte qui n'existe plus.

- [ ] **Step 10: Vérifier**

```bash
export PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$HOME/.bun/bin:$PATH"
bun run test:ui
bun run test:backend
cd frontend && bun run check
```

Attendu : 1274 pass sur `test:ui`, backend inchangé, 0 erreur de typage. Les
avertissements de `svelte-check` doivent **baisser** — quatre composants
supprimés, dont ceux qui portaient des règles CSS inutilisées.

- [ ] **Step 11: Commit**

```bash
git add -u
git add frontend/src/lib/notices/bridges.ts
git commit -m "Faire des trois cartes trois notifications, et retirer leurs coins"
```

> `git add -u` et non `git add -A` : d'autres sessions partagent cet arbre de
> travail, et les liens `node_modules` y sont non suivis.

---

## Task 8: La vérification de bout en bout

**Files:**
- Modify: `e2e/` — la spec qui couvre l'invitation, si elle existe.

- [ ] **Step 1: Trouver ce qui couvre déjà ces gestes**

```bash
grep -rln "invitation\|invite\|rom:offer" e2e/
```

- [ ] **Step 2: Adapter les sélecteurs**

Les specs qui visaient la carte épinglée doivent viser le toast, puis la cloche.
Ne pas ajouter de `data-testid` si un rôle accessible suffit : le toast porte
`role="alert"`, la cloche un `aria-label`.

- [ ] **Step 3: Jouer la suite sur base neuve**

La suite e2e **n'est pas rejouable sur la même base** — supprimer `e2e.db*`,
`redis-cli FLUSHALL`, rejouer les migrations (`bun src/db/migrate-cli.ts`), puis :

```bash
export PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$PATH"
E2E_API_URL=http://localhost:3000 E2E_APP_URL=http://localhost:5273 npx playwright test --config e2e/playwright.config.ts
```

Attendu : le même nombre de specs qu'avant le chantier. Deux ou trois échecs
qui changent d'une fois sur l'autre sont un symptôme de base sale, pas une
régression — recommencer sur base neuve avant d'y croire.

- [ ] **Step 4: Vérifier les deux gestes à la main, à deux navigateurs**

La recette est dans la mémoire du projet « Driving two players ». Vérifier :
une invitation envoyée apparaît en toast chez l'autre, s'accepte **en un clic**
depuis le toast, et disparaît du centre des deux côtés ; un jeu envoyé depuis la
fiche pose l'offre chez l'ami, et « Le recevoir » déclenche bien le transfert —
`requestPermission` a besoin d'une activation transitoire, donc ce clic doit
être le vrai clic, sans `await` avant lui.

- [ ] **Step 5: Commit**

```bash
git add -u
git commit -m "Suivre les deux gestes jusqu'au bout, sélecteurs compris"
```

---

## Ce que ce plan ne fait pas

- **La VR.** `VrShell` continue de lire `$notifications.at(-1)?.message` ; la
  contrainte globale l'exige, et rien d'autre n'est prévu pour le casque.
- **Le compte plutôt que l'appareil.** Retrouver ses notifications ailleurs
  demande une table, une route et une migration. Le spec l'écarte.
- **Les notifications système du navigateur.** Rien ne les demande.
