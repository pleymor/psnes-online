# Remap des contrôles en VR — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permettre au joueur de réassigner les huit boutons SNES sur les neuf entrées Touch disponibles, depuis un panneau dessiné sur l'écran courbe, sans quitter la session immersive.

**Architecture:** Le preset stocké (`'letters' | 'thumb'`) devient une permutation complète `VrPadMap`. Le module `vr/pad-scheme.ts` devient `vr/pad-map.ts` et gagne la résolution des valeurs héritées ainsi que l'échange sur conflit. `vr/pad.ts` lit la map au lieu d'une table figée et expose les entrées tenues pour la capture. Un nouveau panneau pur `vr/panels/controls.ts` dessine les huit lignes ; `VrShell` l'ouvre sur l'écran courbe et pilote la capture avec le `CaptureGate` déjà écrit pour la page plate.

**Tech Stack:** TypeScript, Svelte 4, three.js, WebXR, tests sous `bun test` depuis `core/test/`.

**Spec:** `docs/superpowers/specs/2026-09-05-vr-remap-controles-design.md`

## Global Constraints

- **Aucune modification backend.** Pas de migration, pas de version 3 de `ControlsConfig`, pas d'export portable à étendre. Un diff touchant `backend/` est une erreur de plan.
- **Stockage : `localStorage`, clé `psnes-vr-pad`**, celle qui existe déjà.
- **Discipline de stockage :** une valeur égale au défaut est *retirée*, jamais écrite. Reprise de `pad-scheme.ts`, elle-même reprise de `stores/shader-preference.ts`.
- **Défaut : `LETTERS_MAP`.** C'est le preset `'letters'` d'aujourd'hui, inchangé.
- **Les sticks et le clic du stick droit ne sont pas dans le modèle.** Aucun type, aucune région, aucune ligne ne les rend assignables.
- **Invariant : `VrPadMap` est toujours injective.** Huit boutons, huit entrées distinctes parmi neuf.
- **Tests sous `bun test`** depuis la racine, jamais sous node. Les imports dans `core/test/` sont relatifs avec l'extension `.js` (`'../../frontend/src/lib/vr/pad-map.js'`) — l'alias `$lib` n'y est pas résolu.
- **Chaque nouveau fichier de test doit être ajouté à `test:ui` dans `package.json`.** Un test non listé ne tourne jamais en CI.
- **Parité i18n obligatoire :** toute clé ajoutée à `en` doit l'être à `fr`. `core/test/i18n-parity.test.ts` échoue sinon.

---

### Task 1 : le modèle et son stockage

**Files:**
- Create: `frontend/src/lib/vr/pad-map.ts`
- Delete: `frontend/src/lib/vr/pad-scheme.ts` (à la fin de la tâche seulement)
- Test: `core/test/vr-pad-map.test.ts`
- Modify: `package.json` (ajouter le test à `test:ui`)

**Interfaces:**
- Consumes: `PreferenceStorage` depuis `$lib/stores/shader-preference` — l'interface que `pad-scheme.ts` utilise déjà (`getItem`, `setItem`, `removeItem`).
- Produces: `XrInput`, `VrButton`, `VrPadMap`, `LETTERS_MAP`, `THUMB_MAP`, `VR_PAD_KEY`, `readPadMap(storage)`, `writePadMap(storage, map)`, `assignInput(map, button, input)`.

- [ ] **Step 1: Écrire le test qui échoue**

Créer `core/test/vr-pad-map.test.ts` :

```ts
/**
 * Le mapping VR : une permutation, pas un preset.
 *
 * L'invariant que ce fichier existe pour tenir est l'injectivité. Huit boutons
 * SNES, neuf entrées Touch, et jamais deux boutons sur la même : un bouton sans
 * entrée est injouable, et un casque n'a ni console ni logs lisibles pour le
 * dire. C'est pourquoi le conflit s'échange au lieu de voler.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  LETTERS_MAP,
  THUMB_MAP,
  VR_PAD_KEY,
  readPadMap,
  writePadMap,
  assignInput,
  type VrPadMap
} from '../../frontend/src/lib/vr/pad-map.js';

/** Le `PreferenceStorage` minimal, en mémoire. */
function storage(initial: Record<string, string> = {}) {
  const held = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => held.get(key) ?? null,
    setItem: (key: string, value: string) => { held.set(key, value); },
    removeItem: (key: string) => { held.delete(key); },
    held
  };
}

const BUTTONS = ['a', 'b', 'x', 'y', 'l', 'r', 'start', 'select'] as const;

function isInjective(map: VrPadMap): boolean {
  return new Set(BUTTONS.map((b) => map[b])).size === BUTTONS.length;
}

test('les deux presets sont des permutations complètes', () => {
  for (const [name, map] of [['letters', LETTERS_MAP], ['thumb', THUMB_MAP]] as const) {
    assert.equal(Object.keys(map).length, 8, `${name} n'a pas huit lignes`);
    assert.ok(isInjective(map), `${name} assigne deux boutons à la même entrée`);
  }
});

test('assigner une entrée libre ne déplace rien', () => {
  // Le clic du stick gauche est la neuvième entrée, celle qu'aucun preset
  // n'utilise. La prendre ne peut rien déloger.
  const next = assignInput(LETTERS_MAP, 'a', 'XrLeftStickClick');
  assert.equal(next.a, 'XrLeftStickClick');
  for (const button of BUTTONS) {
    if (button === 'a') continue;
    assert.equal(next[button], LETTERS_MAP[button], `${button} a bougé sans raison`);
  }
});

test('assigner une entrée déjà prise échange les deux lignes', () => {
  const held = LETTERS_MAP.r;
  const gave = LETTERS_MAP.a;
  const next = assignInput(LETTERS_MAP, 'a', held);

  assert.equal(next.a, held, "la ligne demandée n'a pas reçu son entrée");
  assert.equal(next.r, gave, "l'ancienne ligne n'a pas reçu l'entrée libérée");
  assert.ok(isInjective(next), "l'échange a cassé l'injectivité");
});

test('assigner à un bouton ce qu il a déjà ne change rien', () => {
  const next = assignInput(LETTERS_MAP, 'a', LETTERS_MAP.a);
  assert.deepEqual(next, LETTERS_MAP);
});

test('aucune suite d assignations ne peut casser l injectivité', () => {
  // Exhaustif plutôt qu'anecdotique : c'est l'invariant du modèle, et une
  // seule paire (bouton, entrée) qui le casse rend un bouton injouable.
  const INPUTS = [
    'XrLeftTrigger', 'XrRightTrigger', 'XrLeftSqueeze', 'XrRightSqueeze',
    'XrLeftFaceUpper', 'XrRightFaceUpper', 'XrLeftFaceLower', 'XrRightFaceLower',
    'XrLeftStickClick'
  ] as const;

  let map: VrPadMap = LETTERS_MAP;
  for (const button of BUTTONS) {
    for (const input of INPUTS) {
      map = assignInput(map, button, input);
      assert.equal(map[button], input, `${button} n'a pas pris ${input}`);
      assert.ok(isInjective(map), `${button} := ${input} a cassé l'injectivité`);
    }
  }
});

test('rien de stocké rend le défaut', () => {
  assert.deepEqual(readPadMap(storage()), LETTERS_MAP);
});

test('une valeur héritée letters ou thumb se résout vers sa map', () => {
  // Des joueurs ont déjà ces chaînes sous la clé : les rejeter leur reprendrait
  // le réglage qu'ils avaient choisi.
  assert.deepEqual(readPadMap(storage({ [VR_PAD_KEY]: 'letters' })), LETTERS_MAP);
  assert.deepEqual(readPadMap(storage({ [VR_PAD_KEY]: 'thumb' })), THUMB_MAP);
});

test('une valeur illisible est retirée et rend le défaut', () => {
  for (const junk of ['{', 'nonsense', '{"a":"XrNope"}', '{"a":"XrLeftTrigger"}']) {
    const store = storage({ [VR_PAD_KEY]: junk });
    assert.deepEqual(readPadMap(store), LETTERS_MAP, `${junk} n'a pas rendu le défaut`);
    assert.equal(store.held.has(VR_PAD_KEY), false, `${junk} est resté stocké`);
  }
});

test('une map non injective stockée à la main est refusée', () => {
  const broken = { ...LETTERS_MAP, a: LETTERS_MAP.r };
  const store = storage({ [VR_PAD_KEY]: JSON.stringify(broken) });
  assert.deepEqual(readPadMap(store), LETTERS_MAP);
  assert.equal(store.held.has(VR_PAD_KEY), false);
});

test('le défaut est retiré plutôt qu écrit', () => {
  const store = storage({ [VR_PAD_KEY]: 'thumb' });
  writePadMap(store, LETTERS_MAP);
  assert.equal(store.held.has(VR_PAD_KEY), false, "le défaut ne doit pas être stocké");
});

test('une map non-défaut est écrite et se relit identique', () => {
  const store = storage();
  const custom = assignInput(LETTERS_MAP, 'a', 'XrLeftStickClick');
  writePadMap(store, custom);
  assert.deepEqual(readPadMap(store), custom);
});
```

- [ ] **Step 2: Lancer le test et vérifier qu'il échoue**

Run: `bun test core/test/vr-pad-map.test.ts`
Expected: FAIL — `Cannot find module '../../frontend/src/lib/vr/pad-map.js'`.

- [ ] **Step 3: Écrire l'implémentation minimale**

Créer `frontend/src/lib/vr/pad-map.ts` :

```ts
/**
 * Quelle entrée Touch porte quel bouton SNES.
 *
 * Ce module remplace `pad-scheme.ts`, dont l'en-tête disait que choisir entre
 * deux presets était « toute la rectification » du fait de ne pas offrir de
 * réglage de contrôles. Ce n'est plus la conclusion retenue, mais le
 * raisonnement tient toujours : le losange SNES (X haut, Y gauche, A droite,
 * B bas) doit se plier sur deux paires verticales, aucun pliage n'est gratuit,
 * et les deux presets restent les deux bonnes réponses par défaut. Ils sont
 * désormais des points de départ plutôt que le choix entier.
 *
 * Neuf entrées assignables pour huit boutons. Les sticks (la croix) et le clic
 * du stick droit (le menu, seul recours : le bouton Quest est réservé par le
 * système) ne sont pas dans le modèle - c'est ce qui les rend inaltérables par
 * construction plutôt que par une garde qu'on peut oublier.
 *
 * La discipline de stockage est celle de `stores/shader-preference.ts`, citée
 * là-bas : « Removing rather than storing an empty string means no reader has
 * to treat '' and absent as the same thing. »
 *
 * localStorage plutôt que le compte : le coût assumé est deux casques, deux
 * réglages, pesé contre une version 3 de `ControlsConfig` dont le normaliseur
 * jetterait silencieusement tout champ qu'il ne connaît pas.
 */

import type { PreferenceStorage } from '$lib/stores/shader-preference';

/** Les neuf entrées assignables. Ni les sticks ni le clic du stick droit. */
export type XrInput =
  | 'XrLeftTrigger'
  | 'XrRightTrigger'
  | 'XrLeftSqueeze'
  | 'XrRightSqueeze'
  | 'XrLeftFaceUpper'
  | 'XrRightFaceUpper'
  | 'XrLeftFaceLower'
  | 'XrRightFaceLower'
  /** La neuvième, qu'aucun preset n'utilise. */
  | 'XrLeftStickClick';

export const XR_INPUTS: readonly XrInput[] = [
  'XrLeftTrigger', 'XrRightTrigger',
  'XrLeftSqueeze', 'XrRightSqueeze',
  'XrLeftFaceUpper', 'XrRightFaceUpper',
  'XrLeftFaceLower', 'XrRightFaceLower',
  'XrLeftStickClick'
];

/** Les huit boutons assignables. La croix n'en est pas : elle est sur les
 *  sticks, et sur les deux - voir `steer` dans `pad.ts`. */
export type VrButton = 'a' | 'b' | 'x' | 'y' | 'l' | 'r' | 'start' | 'select';

export const VR_BUTTONS: readonly VrButton[] = [
  'a', 'b', 'x', 'y', 'l', 'r', 'start', 'select'
];

export type VrPadMap = Record<VrButton, XrInput>;

export const VR_PAD_KEY = 'psnes-vr-pad';

/**
 * Le preset qui garde la lettre imprimée honnête.
 *
 * C'était `FACE.letters` dans `pad.ts` : `left: [PAD.Y, PAD.X]`,
 * `right: [PAD.B, PAD.A]`, où le premier de chaque paire est le bouton HAUT.
 */
export const LETTERS_MAP: VrPadMap = {
  y: 'XrLeftFaceUpper',
  x: 'XrLeftFaceLower',
  b: 'XrRightFaceUpper',
  a: 'XrRightFaceLower',
  l: 'XrLeftTrigger',
  r: 'XrRightTrigger',
  select: 'XrLeftSqueeze',
  start: 'XrRightSqueeze'
};

/**
 * Le preset qui met B (sauter) et Y (courir) sous les pouces au repos.
 *
 * C'était `FACE.thumb` : `left: [PAD.X, PAD.Y]`, `right: [PAD.A, PAD.B]`.
 */
export const THUMB_MAP: VrPadMap = {
  x: 'XrLeftFaceUpper',
  y: 'XrLeftFaceLower',
  a: 'XrRightFaceUpper',
  b: 'XrRightFaceLower',
  l: 'XrLeftTrigger',
  r: 'XrRightTrigger',
  select: 'XrLeftSqueeze',
  start: 'XrRightSqueeze'
};

/** Celui qu'un joueur obtient sans rien demander. */
const DEFAULT_MAP = LETTERS_MAP;

function sameMap(a: VrPadMap, b: VrPadMap): boolean {
  return VR_BUTTONS.every((button) => a[button] === b[button]);
}

/**
 * Assigne `input` à `button`, en échangeant plutôt qu'en volant.
 *
 * Si une autre ligne détient `input`, elle reçoit ce que `button` avait. C'est
 * la seule des trois règles examinées qui garantit qu'aucun bouton SNES ne peut
 * se retrouver sans entrée - et un bouton injouable est précisément la panne
 * qu'un casque ne sait pas diagnostiquer.
 *
 * Quand `input` est libre (la neuvième entrée), rien n'est déplacé.
 */
export function assignInput(map: VrPadMap, button: VrButton, input: XrInput): VrPadMap {
  const displaced = VR_BUTTONS.find((other) => other !== button && map[other] === input);
  const next: VrPadMap = { ...map, [button]: input };
  if (displaced) next[displaced] = map[button];
  return next;
}

/** Un objet quelconque est-il une permutation complète des huit boutons ? */
function isValidMap(raw: unknown): raw is VrPadMap {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const source = raw as Record<string, unknown>;
  const seen = new Set<string>();
  for (const button of VR_BUTTONS) {
    const value = source[button];
    if (typeof value !== 'string') return false;
    if (!(XR_INPUTS as readonly string[]).includes(value)) return false;
    // L'injectivité est vérifiée à la lecture, pas seulement à l'écriture :
    // rien n'empêche un joueur d'éditer son localStorage à la main, et une map
    // non injective laisse un bouton silencieusement mort.
    if (seen.has(value)) return false;
    seen.add(value);
  }
  return true;
}

/**
 * La map stockée, ou le défaut.
 *
 * Accepte les deux valeurs héritées `'letters'` et `'thumb'` : ce sont les
 * chaînes que `writePadScheme` écrivait, elles sont déjà dans le localStorage
 * de joueurs réels, et les rejeter leur reprendrait le réglage qu'ils avaient
 * choisi. Tout le reste d'illisible est retiré plutôt que gardé, pour qu'une
 * valeur qu'aucun lecteur ne comprend ne survive pas à sa lecture.
 */
export function readPadMap(storage: PreferenceStorage): VrPadMap {
  const stored = storage.getItem(VR_PAD_KEY);
  if (!stored) return DEFAULT_MAP;

  if (stored === 'letters') return LETTERS_MAP;
  if (stored === 'thumb') return THUMB_MAP;

  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    storage.removeItem(VR_PAD_KEY);
    return DEFAULT_MAP;
  }

  if (!isValidMap(parsed)) {
    storage.removeItem(VR_PAD_KEY);
    return DEFAULT_MAP;
  }

  // Reconstruite plutôt que rendue telle quelle : l'objet parsé peut porter des
  // clés en plus, et rien en aval ne doit avoir à s'en soucier.
  const map = {} as VrPadMap;
  for (const button of VR_BUTTONS) map[button] = parsed[button];
  return map;
}

export function writePadMap(storage: PreferenceStorage, map: VrPadMap): void {
  if (!isValidMap(map)) return;
  if (sameMap(map, DEFAULT_MAP)) {
    storage.removeItem(VR_PAD_KEY);
    return;
  }
  const ordered = {} as VrPadMap;
  for (const button of VR_BUTTONS) ordered[button] = map[button];
  storage.setItem(VR_PAD_KEY, JSON.stringify(ordered));
}
```

- [ ] **Step 4: Lancer le test et vérifier qu'il passe**

Run: `bun test core/test/vr-pad-map.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Enregistrer le test dans `test:ui`**

Dans `package.json`, ajouter `core/test/vr-pad-map.test.ts` à la fin de la liste `test:ui`. Un test absent de cette liste ne tourne jamais.

Run: `bun run test:ui`
Expected: la suite entière passe, et le compte de fichiers a augmenté de un.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/vr/pad-map.ts core/test/vr-pad-map.test.ts package.json
git commit -m "Turn the VR pad preset into a mapping that can be edited"
```

Note : `pad-scheme.ts` n'est pas encore supprimé — il a encore des appelants. La tâche 3 l'enlève.

---

### Task 2 : lire la map, et exposer les entrées tenues

**Files:**
- Modify: `frontend/src/lib/vr/pad.ts`
- Test: `core/test/vr-pad.test.ts` (étendu), `core/test/vr-pad-scheme.test.ts` (supprimé, remplacé par `vr-pad-map.test.ts`)
- Modify: `package.json` (retirer `vr-pad-scheme.test.ts` de `test:ui`)

**Interfaces:**
- Consumes: `VrPadMap`, `VrButton`, `XrInput`, `VR_BUTTONS` de la tâche 1.
- Produces: `readVrPad(sources, map, visibility)` — même signature, `VrPadMap` au lieu de `VrPadScheme` ; `activeXrInputs(sources): XrInput[]`.

- [ ] **Step 1: Écrire le test qui échoue**

Ajouter à la fin de `core/test/vr-pad.test.ts` :

```ts
import {
  LETTERS_MAP,
  THUMB_MAP,
  assignInput
} from '../../frontend/src/lib/vr/pad-map.js';
import { activeXrInputs } from '../../frontend/src/lib/vr/pad.js';

/** Une manette dont seuls les indices listés sont pressés. */
function hand(handedness: 'left' | 'right', pressed: number[] = []) {
  return {
    handedness,
    gamepad: {
      buttons: Array.from({ length: 6 }, (_, i) => ({ pressed: pressed.includes(i) })),
      axes: [0, 0, 0, 0]
    }
  };
}

test('une map personnalisée décide du masque, là où le preset décidait', () => {
  // A sur le clic du stick gauche : une entrée qu'aucun preset n'utilise, donc
  // un masque que l'ancienne table ne pouvait pas produire.
  const map = assignInput(LETTERS_MAP, 'a', 'XrLeftStickClick');
  const mask = readVrPad([hand('left', [3])], map, 'visible');
  assert.equal(mask, PAD.A, 'le clic du stick gauche ne portait pas A');
});

test('les deux presets restent lisibles comme des maps', () => {
  // Le bouton de face BAS de la manette droite : A en letters, B en thumb.
  assert.equal(readVrPad([hand('right', [4])], LETTERS_MAP, 'visible'), PAD.A);
  assert.equal(readVrPad([hand('right', [4])], THUMB_MAP, 'visible'), PAD.B);
});

test('activeXrInputs rend les entrées tenues, et rien d autre', () => {
  const held = activeXrInputs([hand('left', [0, 1]), hand('right', [5])]);
  assert.deepEqual(
    [...held].sort(),
    ['XrLeftSqueeze', 'XrLeftTrigger', 'XrRightFaceUpper'].sort()
  );
});

test('activeXrInputs ignore les sticks et le clic du stick droit', () => {
  // Hors modèle : ils ne peuvent pas être capturés, donc pas être proposés.
  const held = activeXrInputs([hand('right', [3])]);
  assert.deepEqual(held, [], 'le clic du stick droit est le menu, pas une entrée');
});

test('activeXrInputs ne rend rien quand rien n est tenu', () => {
  assert.deepEqual(activeXrInputs([hand('left'), hand('right')]), []);
});
```

- [ ] **Step 2: Lancer le test et vérifier qu'il échoue**

Run: `bun test core/test/vr-pad.test.ts`
Expected: FAIL — `activeXrInputs` n'existe pas, et les tests de map échouent parce que `readVrPad` indexe encore `FACE[scheme]`.

- [ ] **Step 3: Écrire l'implémentation minimale**

Dans `frontend/src/lib/vr/pad.ts` :

Remplacer l'import `import type { VrPadScheme } from './pad-scheme';` par :

```ts
import { VR_BUTTONS, type VrButton, type VrPadMap, type XrInput } from './pad-map';
```

Supprimer la table `FACE` et son commentaire (le commentaire migre vers `pad-map.ts`, où vivent désormais les deux presets), puis ajouter :

```ts
/** Le masque SNES que porte chaque bouton assignable. */
const MASK: Record<VrButton, number> = {
  a: PAD.A, b: PAD.B, x: PAD.X, y: PAD.Y,
  l: PAD.L, r: PAD.R, start: PAD.START, select: PAD.SELECT
};

/**
 * Quelle entrée physique est quel index, par main.
 *
 * Le clic du stick DROIT est absent, et c'est le modèle : il porte le menu, et
 * une entrée hors table ne peut être ni capturée ni assignée. Le gauche y est,
 * lui : c'est la neuvième entrée, libre.
 */
const INPUT_AT: Record<'left' | 'right', ReadonlyArray<[number, XrInput]>> = {
  left: [
    [TRIGGER, 'XrLeftTrigger'],
    [SQUEEZE, 'XrLeftSqueeze'],
    [FACE_UPPER, 'XrLeftFaceUpper'],
    [FACE_LOWER, 'XrLeftFaceLower'],
    [STICK_CLICK, 'XrLeftStickClick']
  ],
  right: [
    [TRIGGER, 'XrRightTrigger'],
    [SQUEEZE, 'XrRightSqueeze'],
    [FACE_UPPER, 'XrRightFaceUpper'],
    [FACE_LOWER, 'XrRightFaceLower']
  ]
};

/**
 * Les entrées assignables actuellement tenues.
 *
 * Distincte de `readVrPad` parce qu'elle répond à une autre question : non pas
 * « quel masque SNES » mais « quelles entrées physiques ». Les deux ne
 * coïncident que par accident, et c'est `CaptureGate` qui consomme celle-ci.
 *
 * L'accumulateur s'appelle `found` et non `held` : `held` est déjà le nom de
 * la fonction locale qui teste un bouton, quelques lignes plus haut.
 */
export function activeXrInputs(sources: Iterable<PadLikeSource>): XrInput[] {
  const found: XrInput[] = [];
  for (const source of sources) {
    if (!source.gamepad) continue;
    if (source.handedness !== 'left' && source.handedness !== 'right') continue;
    for (const [index, input] of INPUT_AT[source.handedness]) {
      if (held(source, index)) found.push(input);
    }
  }
  return found;
}
```

Puis réécrire `readVrPad` :

```ts
export function readVrPad(
  sources: Iterable<PadLikeSource>,
  map: VrPadMap,
  visibility: string
): PadMask {
  // Le menu système laisse la boucle d'animation tourner et cesse de livrer
  // l'entrée. Un bouton tenu à cet instant resterait tenu tout le reste de la
  // session.
  if (visibility !== 'visible') return 0;

  // Inversée une fois par appel : la map dit bouton → entrée, la lecture a
  // besoin de entrée → masque.
  const byInput = new Map<XrInput, number>();
  for (const button of VR_BUTTONS) byInput.set(map[button], MASK[button]);

  let mask = 0;

  for (const source of sources) {
    if (!source.gamepad) continue;
    if (source.handedness !== 'left' && source.handedness !== 'right') continue;

    // Les deux sticks steerent. Le droit aussi, pour que le pouce GAUCHE soit
    // libre pour X et Y - c'est tout l'objet du double appel.
    mask |= steer(source.gamepad);

    for (const [index, input] of INPUT_AT[source.handedness]) {
      if (held(source, index)) mask |= byInput.get(input) ?? 0;
    }
  }

  return mask;
}
```

- [ ] **Step 4: Lancer le test et vérifier qu'il passe**

Run: `bun test core/test/vr-pad.test.ts`
Expected: PASS. Si des tests existants de `vr-pad.test.ts` passaient `'letters'` ou `'thumb'` en second argument, les remplacer par `LETTERS_MAP` / `THUMB_MAP` — c'est le même comportement sous un autre nom.

- [ ] **Step 5: Retirer l'ancien test de preset**

```bash
git rm core/test/vr-pad-scheme.test.ts
```

Retirer `core/test/vr-pad-scheme.test.ts` de `test:ui` dans `package.json`. Ses assertions sont couvertes par `vr-pad-map.test.ts` : le défaut, la valeur illisible retirée, le défaut non stocké.

Run: `bun run test:ui`
Expected: la suite passe.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/vr/pad.ts core/test/vr-pad.test.ts package.json
git commit -m "Read the pad from a mapping, and say which inputs are held"
```

---

### Task 3 : brancher `VrShell` sur la map, sans encore de panneau

Cette tâche ne fait rien de visible. Elle existe pour que la suppression de `pad-scheme.ts` et le renommage traversent le composant en une fois, avec une suite verte à chaque bout — plutôt que d'être mêlés au panneau, où un échec ne dirait pas lequel des deux l'a causé.

**Files:**
- Modify: `frontend/src/lib/components/VrShell.svelte:59, 148-154, 299, 507-511, 694, 1014, 1370`
- Delete: `frontend/src/lib/vr/pad-scheme.ts`
- Modify: `frontend/src/lib/vr/panels/profile.ts` (le type de `ProfileState.scheme`)
- Test: `core/test/vr-panel-profile.test.ts`

**Interfaces:**
- Consumes: `readPadMap`, `writePadMap`, `LETTERS_MAP`, `THUMB_MAP`, `VrPadMap` de la tâche 1 ; `readVrPad(sources, map, visibility)` de la tâche 2.
- Produces: rien de nouveau. `ProfileState.scheme: VrPadScheme` devient `ProfileState.map: VrPadMap`.

- [ ] **Step 1: Écrire le test qui échoue**

Le panneau profil montre aujourd'hui deux cartes de preset et marque celle qui est active. Avec une map, « active » veut dire « égale à ce preset ». Ajouter à `core/test/vr-panel-profile.test.ts` :

```ts
import { LETTERS_MAP, THUMB_MAP, assignInput } from '../../frontend/src/lib/vr/pad-map.js';

test('la carte de preset active est celle que la map égale', () => {
  const onLetters = { ...IDLE, map: LETTERS_MAP };
  const onThumb = { ...IDLE, map: THUMB_MAP };

  const a = recordingContext();
  drawProfilePanel(a, onLetters, layoutProfilePanel(onLetters), { labels: LABELS, hoverId: null });
  const b = recordingContext();
  drawProfilePanel(b, onThumb, layoutProfilePanel(onThumb), { labels: LABELS, hoverId: null });

  assert.notDeepEqual(a.calls, b.calls, 'rien ne distingue les deux presets');
});

test('une map personnalisée ne prétend être aucun des deux presets', () => {
  // Sinon le joueur qui a remappé un bouton voit « lettres » coché et croit
  // que son réglage a été perdu.
  const custom = { ...IDLE, map: assignInput(LETTERS_MAP, 'a', 'XrLeftStickClick') };
  const onLetters = { ...IDLE, map: LETTERS_MAP };

  const a = recordingContext();
  drawProfilePanel(a, custom, layoutProfilePanel(custom), { labels: LABELS, hoverId: null });
  const b = recordingContext();
  drawProfilePanel(b, onLetters, layoutProfilePanel(onLetters), { labels: LABELS, hoverId: null });

  assert.notDeepEqual(a.calls, b.calls, 'une map remappée passe pour le preset letters');
});
```

Remplacer aussi la constante `IDLE` du fichier : `scheme: 'letters' as const` devient `map: LETTERS_MAP`.

- [ ] **Step 2: Lancer le test et vérifier qu'il échoue**

Run: `bun test core/test/vr-panel-profile.test.ts`
Expected: FAIL — `ProfileState` n'a pas de `map`, et `drawCard` lit encore `state.scheme`.

- [ ] **Step 3: Écrire l'implémentation minimale**

Dans `frontend/src/lib/vr/panels/profile.ts` :

```ts
import { LETTERS_MAP, THUMB_MAP, VR_BUTTONS, type VrPadMap } from '../pad-map';
```

`ProfileState.scheme: VrPadScheme` devient :

```ts
  /** Le mapping courant. Une carte de preset est « active » quand la map lui
   *  est égale - et une map remappée n'en égale aucun, ce qui est la vérité à
   *  montrer plutôt qu'un preset coché par défaut. */
  map: VrPadMap;
```

Ajouter le prédicat, et l'utiliser dans le `switch` de dessin :

```ts
function sameAs(map: VrPadMap, preset: VrPadMap): boolean {
  return VR_BUTTONS.every((button) => map[button] === preset[button]);
}
```

```ts
      case 'scheme:letters':
        drawCard(ctx, region, opts.labels.letters, DIAGRAM.letters, sameAs(state.map, LETTERS_MAP), hovered);
        break;
      case 'scheme:thumb':
        drawCard(ctx, region, opts.labels.thumb, DIAGRAM.thumb, sameAs(state.map, THUMB_MAP), hovered);
        break;
```

Dans `frontend/src/lib/components/VrShell.svelte` :

Ligne 59 :
```ts
  import { readPadMap, writePadMap, LETTERS_MAP, THUMB_MAP, type VrPadMap } from '$lib/vr/pad-map';
```

Ligne 154, en gardant le commentaire du dessus qui explique pourquoi ce n'est pas réactif (il reste vrai mot pour mot, aux noms près) :
```ts
  let padMap: VrPadMap = LETTERS_MAP;
```

Ligne 299, dans `repaintProfile` : `scheme: padScheme` devient `map: padMap`.

Lignes 507-511, dans `activate` :
```ts
      if (id === 'scheme:letters' || id === 'scheme:thumb') {
        writePadMap(localStorage, id === 'scheme:thumb' ? THUMB_MAP : LETTERS_MAP);
        // Relu plutôt que supposé : `readPadMap` est la seule chose qui
        // décide, et un preset écrit et non stocké (le défaut est retiré, pas
        // stocké) doit tout de même se relire correctement.
        padMap = readPadMap(localStorage);
        repaintProfile();
        return;
      }
```

Lignes 694 et 1014 : `padScheme` devient `padMap` dans les deux appels à `readVrPad`.

Ligne 1370 : `padScheme = readPadScheme(localStorage)` devient `padMap = readPadMap(localStorage)`.

Puis :
```bash
git rm frontend/src/lib/vr/pad-scheme.ts
```

- [ ] **Step 4: Lancer les tests et le typecheck**

Run: `bun run test:ui`
Expected: PASS.

Run: `cd frontend && PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH" npm run check`
Expected: 0 erreur. C'est l'étape qui prouve qu'aucune référence à `pad-scheme` ne subsiste — `bun test` ne typecheck pas.

- [ ] **Step 5: Commit**

```bash
git add -u frontend/src/lib/components/VrShell.svelte frontend/src/lib/vr/panels/profile.ts frontend/src/lib/vr/pad-scheme.ts core/test/vr-panel-profile.test.ts
git commit -m "Carry the mapping through the shell, and retire the preset type"
```

---

### Task 4 : le panneau de remap

**Files:**
- Create: `frontend/src/lib/vr/panels/controls.ts`
- Test: `core/test/vr-panel-controls.test.ts`
- Modify: `package.json` (ajouter le test à `test:ui`)

**Interfaces:**
- Consumes: `VrPadMap`, `VrButton`, `XrInput`, `VR_BUTTONS` de la tâche 1 ; `PanelSize`, `Region` de `../panel`.
- Produces: `CONTROLS_PANEL_SIZE`, `layoutControlsPanel(state)`, `drawControlsPanel(ctx, state, regions, opts)`, `ControlsState`, `ControlsLabels`.

- [ ] **Step 1: Écrire le test qui échoue**

Créer `core/test/vr-panel-controls.test.ts` :

```ts
/**
 * Le panneau de remap, sur l'écran courbe.
 *
 * Deux règles portantes, toutes deux héritées de pannes réelles ailleurs dans
 * ce dossier.
 *
 * La ligne qui écoute est marquée par autre chose qu'une couleur : deux états
 * ne différant que par un remplissage produisent un jeu de `fillText`
 * identique, et le test « l'état est visible » n'aurait rien à comparer -
 * exactement le piège où étaient tombées les cartes de preset du pupitre.
 *
 * Les entrées non assignables sont nommées quelque part. Un joueur qui ne voit
 * la croix ni le menu nulle part les croit cassées, et la seule chose qu'il
 * puisse en conclure est que le remap les a mangées.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  CONTROLS_PANEL_SIZE,
  layoutControlsPanel,
  drawControlsPanel,
  type ControlsLabels,
  type ControlsState
} from '../../frontend/src/lib/vr/panels/controls.js';
import { LETTERS_MAP, assignInput } from '../../frontend/src/lib/vr/pad-map.js';

const LABELS: ControlsLabels = {
  heading: 'Contrôles',
  press: 'Pressez un bouton — clic du stick droit pour annuler',
  presetLetters: 'Preset lettres',
  presetThumb: 'Preset pouce',
  fixedDpad: 'Croix directionnelle : les deux sticks',
  fixedMenu: 'Menu : clic du stick droit',
  button: { a: 'A', b: 'B', x: 'X', y: 'Y', l: 'L', r: 'R', start: 'START', select: 'SELECT' },
  input: {
    XrLeftTrigger: 'Gauche — gâchette',
    XrRightTrigger: 'Droite — gâchette',
    XrLeftSqueeze: 'Gauche — grip',
    XrRightSqueeze: 'Droite — grip',
    XrLeftFaceUpper: 'Gauche — bouton haut',
    XrRightFaceUpper: 'Droite — bouton haut',
    XrLeftFaceLower: 'Gauche — bouton bas',
    XrRightFaceLower: 'Droite — bouton bas',
    XrLeftStickClick: 'Gauche — clic du stick'
  }
};

function state(over: Partial<ControlsState> = {}): ControlsState {
  return { map: LETTERS_MAP, listeningFor: null, ...over };
}

function recordingContext() {
  const texts: string[] = [];
  const calls: string[] = [];
  return {
    texts, calls,
    font: '', fillStyle: '', strokeStyle: '', lineWidth: 0,
    textAlign: 'left', textBaseline: 'alphabetic',
    save() {}, restore() {}, clearRect() {},
    fillRect() { calls.push('fillRect'); },
    strokeRect() { calls.push('strokeRect'); },
    beginPath() {}, arc() { calls.push('arc'); }, fill() {}, stroke() {},
    drawImage() { calls.push('drawImage'); },
    fillText(text: string) { texts.push(text); calls.push(`fillText:${text}`); },
    measureText(text: string) { return { width: text.length * 9 }; }
  } as unknown as CanvasRenderingContext2D & { texts: string[]; calls: string[] };
}

function draw(s: ControlsState, hoverId: string | null = null) {
  const ctx = recordingContext();
  drawControlsPanel(ctx, s, layoutControlsPanel(s), { labels: LABELS, hoverId });
  return ctx;
}

test('les huit boutons ont chacun leur région', () => {
  const ids = layoutControlsPanel(state()).map((r) => r.id);
  for (const button of ['a', 'b', 'x', 'y', 'l', 'r', 'start', 'select']) {
    assert.ok(ids.includes(`bind:${button}`), `${button} n'est pas cliquable`);
  }
});

test('les deux presets sont offerts', () => {
  const ids = layoutControlsPanel(state()).map((r) => r.id);
  assert.ok(ids.includes('preset:letters'));
  assert.ok(ids.includes('preset:thumb'));
});

test('chaque ligne nomme son bouton et l entrée qui le porte', () => {
  const drawn = draw(state()).texts.join('\n');
  assert.ok(drawn.includes('START'), 'le bouton START n est pas nommé');
  assert.ok(
    drawn.includes(LABELS.input[LETTERS_MAP.start]),
    "l'entrée qui porte START n'est pas nommée"
  );
});

test('la ligne qui écoute est marquée autrement que par une couleur', () => {
  const idle = draw(state()).calls;
  const listening = draw(state({ listeningFor: 'a' })).calls;
  assert.notDeepEqual(idle, listening, "rien sur le canvas ne dit qu'une ligne écoute");
});

test('l invite d annulation est dite pendant la capture, et pas avant', () => {
  // Sans elle, un joueur qui a ouvert une capture par erreur n'a aucun moyen de
  // savoir qu'il peut en sortir : tous les autres boutons sont capturables.
  assert.ok(!draw(state()).texts.includes(LABELS.press));
  assert.ok(draw(state({ listeningFor: 'a' })).texts.includes(LABELS.press));
});

test('aucune ligne n est cliquable pendant une capture', () => {
  // Sinon la pression qui lie A peut aussi être lue comme un clic sur B.
  const ids = layoutControlsPanel(state({ listeningFor: 'a' })).map((r) => r.id);
  assert.deepEqual(ids, [], 'le panneau reste cliquable pendant la capture');
});

test('les entrées non assignables sont nommées', () => {
  const drawn = draw(state()).texts.join('\n');
  assert.ok(drawn.includes(LABELS.fixedDpad), 'la croix n est expliquée nulle part');
  assert.ok(drawn.includes(LABELS.fixedMenu), 'le menu n est expliqué nulle part');
});

test('une map remappée est ce qui est dessiné, pas le preset', () => {
  const custom = assignInput(LETTERS_MAP, 'a', 'XrLeftStickClick');
  const drawn = draw(state({ map: custom })).texts.join('\n');
  assert.ok(drawn.includes(LABELS.input.XrLeftStickClick), 'le remap n est pas montré');
});

test('aucune région ne sort du panneau ni n en chevauche une autre', () => {
  for (const listeningFor of [null, 'a', 'select'] as const) {
    const regions = layoutControlsPanel(state({ listeningFor }));
    for (const r of regions) {
      assert.ok(r.x >= 0 && r.y >= 0, `${r.id} commence hors panneau`);
      assert.ok(r.x + r.w <= CONTROLS_PANEL_SIZE.width, `${r.id} déborde à droite`);
      assert.ok(r.y + r.h <= CONTROLS_PANEL_SIZE.height, `${r.id} déborde en bas`);
    }
    for (let i = 0; i < regions.length; i++) {
      for (let j = i + 1; j < regions.length; j++) {
        const a = regions[i];
        const b = regions[j];
        const apart =
          a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        assert.ok(apart, `${a.id} chevauche ${b.id}`);
      }
    }
  }
});
```

- [ ] **Step 2: Lancer le test et vérifier qu'il échoue**

Run: `bun test core/test/vr-panel-controls.test.ts`
Expected: FAIL — `Cannot find module '.../vr/panels/controls.js'`.

- [ ] **Step 3: Écrire l'implémentation minimale**

Créer `frontend/src/lib/vr/panels/controls.ts` :

```ts
/**
 * Le remap, sur l'écran courbe.
 *
 * Sur l'écran plutôt que sur un pupitre pour la raison qui a déjà donné cette
 * surface à l'écran de lancement : c'est la seule droit devant, et les pupitres
 * sont à plus ou moins soixante degrés - un panneau entier y était passé
 * inaperçu au premier essai sur casque.
 *
 * Deux règles que la mise en page tient plutôt qu'elle ne les honore :
 *
 *   - Pendant une capture, AUCUNE région n'existe. Tous les boutons sont
 *     capturables, donc la pression qui lie A serait aussi lue comme un clic
 *     sur la ligne visée - et le seul recours est le clic du stick droit, qui
 *     est hors modèle et annule.
 *   - La ligne qui écoute porte un glyphe, pas seulement un fond. Deux états
 *     ne différant que par une couleur dessinent le même jeu de `fillText`, et
 *     le test « l'état est visible » n'aurait rien à comparer.
 */

import type { PanelSize, Region } from '../panel';
import { VR_BUTTONS, type VrButton, type VrPadMap, type XrInput } from '../pad-map';

/** La surface de l'écran courbe, la même que l'écran de lancement. */
export const CONTROLS_PANEL_SIZE: PanelSize = { width: 1024, height: 768 };

const PAD = 40;
const TITLE_Y = 56;

const ROW_X = PAD;
const ROW_Y = 112;
const ROW_W = 640;
const ROW_H = 64;
const ROW_GAP = 8;
/** Où commence la colonne de droite d'une ligne : le nom de l'entrée. */
const INPUT_X = 200;

const PRESET_X = 720;
const PRESET_W = 264;
const PRESET_H = 72;
const PRESET_Y = 112;
const PRESET_GAP = 16;

/** Le rappel des entrées hors modèle, sous les presets. */
const FIXED_Y = 320;

export interface ControlsState {
  map: VrPadMap;
  /** Le bouton dont on attend la nouvelle entrée, ou null. */
  listeningFor: VrButton | null;
}

export interface ControlsLabels {
  heading: string;
  /** L'invite pendant la capture. Dit aussi comment annuler : c'est la seule
   *  information qu'un joueur ne peut deviner, tous les boutons étant pris. */
  press: string;
  presetLetters: string;
  presetThumb: string;
  fixedDpad: string;
  fixedMenu: string;
  button: Record<VrButton, string>;
  input: Record<XrInput, string>;
}

export function layoutControlsPanel(state: ControlsState): Region[] {
  // Rien n'est cliquable pendant une capture. Voir l'en-tête.
  if (state.listeningFor) return [];

  const regions: Region[] = VR_BUTTONS.map((button, index) => ({
    id: `bind:${button}`,
    x: ROW_X,
    y: ROW_Y + index * (ROW_H + ROW_GAP),
    w: ROW_W,
    h: ROW_H
  }));

  regions.push({ id: 'preset:letters', x: PRESET_X, y: PRESET_Y, w: PRESET_W, h: PRESET_H });
  regions.push({
    id: 'preset:thumb',
    x: PRESET_X,
    y: PRESET_Y + PRESET_H + PRESET_GAP,
    w: PRESET_W,
    h: PRESET_H
  });

  return regions;
}

function truncate(ctx: CanvasRenderingContext2D, text: string, width: number): string {
  if (ctx.measureText(text).width <= width) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > width) {
    cut = cut.slice(0, -1);
  }
  return `${cut}…`;
}

function drawButtonBox(
  ctx: CanvasRenderingContext2D,
  region: Region,
  label: string,
  hovered: boolean
): void {
  ctx.fillStyle = '#1c1c26';
  ctx.fillRect(region.x, region.y, region.w, region.h);
  ctx.fillStyle = '#ffffff';
  ctx.font = '600 22px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, region.x + region.w / 2, region.y + region.h / 2);
  if (hovered) {
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.strokeRect(region.x - 3, region.y - 3, region.w + 6, region.h + 6);
  }
}

export function drawControlsPanel(
  ctx: CanvasRenderingContext2D,
  state: ControlsState,
  regions: readonly Region[],
  opts: { labels: ControlsLabels; hoverId: string | null }
): void {
  const { width, height } = CONTROLS_PANEL_SIZE;
  const { labels } = opts;

  ctx.save();
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#101018';
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = '#ffffff';
  ctx.font = '600 34px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(labels.heading, PAD, TITLE_Y);

  const byId = new Map(regions.map((region) => [region.id, region]));

  // Dessinées depuis les boutons, pas depuis les régions : les lignes existent
  // pendant la capture, où il n'y a aucune région.
  VR_BUTTONS.forEach((button, index) => {
    const region = byId.get(`bind:${button}`) ?? {
      id: `bind:${button}`,
      x: ROW_X,
      y: ROW_Y + index * (ROW_H + ROW_GAP),
      w: ROW_W,
      h: ROW_H
    };
    const listening = state.listeningFor === button;

    ctx.fillStyle = listening ? '#232a44' : '#1c1c26';
    ctx.fillRect(region.x, region.y, region.w, region.h);

    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const middle = region.y + region.h / 2;

    ctx.font = '600 24px system-ui, sans-serif';
    ctx.fillStyle = '#e8e8f0';
    ctx.fillText(labels.button[button], region.x + 16, middle);

    if (listening) {
      // Un glyphe, pas seulement le fond. Voir l'en-tête.
      ctx.font = '22px system-ui, sans-serif';
      ctx.fillStyle = '#7aa2ff';
      ctx.fillText('◀', region.x + INPUT_X, middle);
      ctx.fillStyle = '#9a9aac';
      ctx.fillText(
        truncate(ctx, labels.press, region.w - INPUT_X - 48),
        region.x + INPUT_X + 32,
        middle
      );
    } else {
      ctx.font = '22px system-ui, sans-serif';
      ctx.fillStyle = '#9a9aac';
      ctx.fillText(
        truncate(ctx, labels.input[state.map[button]], region.w - INPUT_X - 16),
        region.x + INPUT_X,
        middle
      );
    }

    if (opts.hoverId === `bind:${button}`) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.strokeRect(region.x - 3, region.y - 3, region.w + 6, region.h + 6);
    }
  });

  const letters = byId.get('preset:letters');
  const thumb = byId.get('preset:thumb');
  if (letters) {
    drawButtonBox(ctx, letters, labels.presetLetters, opts.hoverId === 'preset:letters');
  }
  if (thumb) {
    drawButtonBox(ctx, thumb, labels.presetThumb, opts.hoverId === 'preset:thumb');
  }

  // Hors modèle, donc nommées : un joueur qui ne les voit nulle part les croit
  // mangées par le remap.
  ctx.font = '20px system-ui, sans-serif';
  ctx.fillStyle = '#79798a';
  ctx.textAlign = 'left';
  // `width - PRESET_X - PAD`, soit la place réellement disponible à droite de
  // PRESET_X : ces deux lignes partent de là et ne peuvent pas dépasser le bord.
  const fixedW = width - PRESET_X - PAD;
  ctx.fillText(truncate(ctx, labels.fixedDpad, fixedW), PRESET_X, FIXED_Y);
  ctx.fillText(truncate(ctx, labels.fixedMenu, fixedW), PRESET_X, FIXED_Y + 32);

  ctx.restore();
}
```

- [ ] **Step 4: Lancer le test et vérifier qu'il passe**

Run: `bun test core/test/vr-panel-controls.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Enregistrer le test et vérifier la suite**

Ajouter `core/test/vr-panel-controls.test.ts` à `test:ui` dans `package.json`.

Run: `bun run test:ui`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/vr/panels/controls.ts core/test/vr-panel-controls.test.ts package.json
git commit -m "Draw the eight rows a player can rebind"
```

---

### Task 5 : les libellés

**Files:**
- Modify: `frontend/src/lib/i18n/translations.ts`

**Interfaces:**
- Consumes: rien.
- Produces: les clés `vrRemap`, `vrRemapHeading`, `vrRemapPress`, `vrFixedDpad`, `vrFixedMenu`, `vrXrLeftTrigger`, `vrXrRightTrigger`, `vrXrLeftSqueeze`, `vrXrRightSqueeze`, `vrXrLeftFaceUpper`, `vrXrRightFaceUpper`, `vrXrLeftFaceLower`, `vrXrRightFaceLower`, `vrXrLeftStickClick`.

- [ ] **Step 1: Écrire les deux blocs**

`vrRemap` est le libellé du bouton du pupitre profil. Il **ne peut pas** réutiliser la clé `controls`, qui existe déjà dans `ProfileLabels` et titre le rappel des touches fixes du pupitre : un même mot désignerait un titre et un bouton sur le même panneau.

Dans le bloc `en`, à côté de `vrStopGame` :

```ts
    vrRemap: 'Rebind buttons',
    vrRemapHeading: 'Controls',
    vrRemapPress: 'Press a button — right stick click to cancel',
    vrFixedDpad: 'D-pad: either thumbstick',
    vrFixedMenu: 'Menu: right stick click',
    vrXrLeftTrigger: 'Left — trigger',
    vrXrRightTrigger: 'Right — trigger',
    vrXrLeftSqueeze: 'Left — grip',
    vrXrRightSqueeze: 'Right — grip',
    vrXrLeftFaceUpper: 'Left — upper button',
    vrXrRightFaceUpper: 'Right — upper button',
    vrXrLeftFaceLower: 'Left — lower button',
    vrXrRightFaceLower: 'Right — lower button',
    vrXrLeftStickClick: 'Left — stick click',
```

Dans le bloc `fr`, au même endroit relatif :

```ts
    vrRemap: 'Réassigner les boutons',
    vrRemapHeading: 'Contrôles',
    vrRemapPress: 'Pressez un bouton — clic du stick droit pour annuler',
    vrFixedDpad: 'Croix directionnelle : les deux sticks',
    vrFixedMenu: 'Menu : clic du stick droit',
    vrXrLeftTrigger: 'Gauche — gâchette',
    vrXrRightTrigger: 'Droite — gâchette',
    vrXrLeftSqueeze: 'Gauche — grip',
    vrXrRightSqueeze: 'Droite — grip',
    vrXrLeftFaceUpper: 'Gauche — bouton haut',
    vrXrRightFaceUpper: 'Droite — bouton haut',
    vrXrLeftFaceLower: 'Gauche — bouton bas',
    vrXrRightFaceLower: 'Droite — bouton bas',
    vrXrLeftStickClick: 'Gauche — clic du stick',
```

- [ ] **Step 2: Vérifier la parité**

Run: `bun test core/test/i18n-parity.test.ts`
Expected: PASS. Une clé ajoutée d'un seul côté fait échouer ce test — c'est ce à quoi il sert.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/i18n/translations.ts
git commit -m "Name the nine Touch inputs in both languages"
```

---

### Task 6 : ouvrir le panneau, et capturer

La tâche qui rend tout le reste atteignable.

**Files:**
- Modify: `frontend/src/lib/vr/panels/profile.ts` (région `remap`, libellé)
- Modify: `frontend/src/lib/components/VrShell.svelte`
- Test: `core/test/vr-panel-profile.test.ts`

**Interfaces:**
- Consumes: tout ce que produisent les tâches 1, 2, 4 et 5.
- Produces: rien de nouveau à l'extérieur.

- [ ] **Step 1: Écrire le test qui échoue**

Ajouter à `core/test/vr-panel-profile.test.ts`, et ajouter `remap: 'Réassigner les boutons'` à la constante `LABELS` du fichier :

```ts
test('le remap est offert dans tous les états', () => {
  // Y compris pendant une partie : c'est en jouant qu'on découvre qu'un
  // mapping est mauvais, et l'écran courbe peut tenir contre un jeu qui tourne.
  for (const playing of [false, true]) {
    const ids = layoutProfilePanel({ ...IDLE, playing }).map((r) => r.id);
    assert.ok(ids.includes('remap'), `pas de remap avec playing=${playing}`);
  }
});

test('le remap a son propre libellé, distinct du titre des touches fixes', () => {
  const state = { ...IDLE, playing: true };
  const ctx = recordingContext();
  drawProfilePanel(ctx, state, layoutProfilePanel(state), { labels: LABELS, hoverId: null });
  assert.ok(ctx.texts.includes(LABELS.remap), 'le bouton de remap est sans libellé');
});
```

- [ ] **Step 2: Lancer le test et vérifier qu'il échoue**

Run: `bun test core/test/vr-panel-profile.test.ts`
Expected: FAIL — aucune région `remap`.

- [ ] **Step 3: Écrire l'implémentation minimale**

Dans `frontend/src/lib/vr/panels/profile.ts`, ajouter à `ProfileLabels` :

```ts
  /** Le bouton qui ouvre le remap. Distinct de `controls`, qui titre le rappel
   *  des touches fixes : un même mot pour un titre et un bouton sur le même
   *  panneau est un mot qui n'identifie plus rien. */
  remap: string;
```

Dans `layoutProfilePanel`, **avant** le bloc `if (state.playing)`, à côté de `quit` — donc toujours présent :

```ts
  regions.push({
    id: 'remap',
    x: PAD + IDENTITY_W,
    y: PROFILE_PANEL_SIZE.height - PAD - SMALL_H,
    w: CARD_W,
    h: SMALL_H
  });
```

Vérifier avec le test de non-chevauchement existant que cette région ne croise ni les cartes de preset (`CARD_Y` à `CARD_Y + CARD_H`, soit 60..210) ni le rappel des touches fixes. Si elle chevauche, la déplacer et relancer — c'est ce test qui tranche, pas le raisonnement.

Dans le `switch` de dessin :

```ts
      case 'remap':
        drawButton(ctx, region, opts.labels.remap, false, hovered);
        break;
```

Dans `frontend/src/lib/components/VrShell.svelte` :

Imports :
```ts
  import {
    CONTROLS_PANEL_SIZE, layoutControlsPanel, drawControlsPanel,
    type ControlsLabels
  } from '$lib/vr/panels/controls';
  import { activeXrInputs } from '$lib/vr/pad';
  import { assignInput, type VrButton } from '$lib/vr/pad-map';
  import { CaptureGate } from '$lib/controls/capture-gate';
```

État, à côté de `launchFor` :
```ts
  /** Vrai quand l'écran courbe porte le remap. Exclusif de `launchFor` : une
   *  seule surface, un seul contenu. */
  let remapOpen = false;
  /** Le bouton dont on attend la nouvelle entrée, ou null. */
  let listeningFor: VrButton | null = null;
  const captureGate = new CaptureGate();
```

Le repaint :
```ts
  function repaintControls(): void {
    if (!scene || !remapOpen) return;
    const state = { map: padMap, listeningFor };
    const regions = layoutControlsPanel(state);
    // Remplacées sur place : `scene.aimedAt` tient ce même tableau.
    scene.screen.regions.length = 0;
    scene.screen.regions.push(...regions);
    scene.screen.paintPanel(CONTROLS_PANEL_SIZE, (ctx) =>
      drawControlsPanel(ctx, state, regions, {
        labels: controlsLabels(),
        hoverId: hovered?.panel === 'screen' ? hovered.region.id : null
      })
    );
  }

  function controlsLabels(): ControlsLabels {
    return {
      heading: t($language, 'vrRemapHeading'),
      press: t($language, 'vrRemapPress'),
      presetLetters: t($language, 'vrPresetLetters'),
      presetThumb: t($language, 'vrPresetThumb'),
      fixedDpad: t($language, 'vrFixedDpad'),
      fixedMenu: t($language, 'vrFixedMenu'),
      button: {
        a: 'A', b: 'B', x: 'X', y: 'Y',
        l: 'L', r: 'R',
        start: 'START', select: 'SELECT'
      },
      input: {
        XrLeftTrigger: t($language, 'vrXrLeftTrigger'),
        XrRightTrigger: t($language, 'vrXrRightTrigger'),
        XrLeftSqueeze: t($language, 'vrXrLeftSqueeze'),
        XrRightSqueeze: t($language, 'vrXrRightSqueeze'),
        XrLeftFaceUpper: t($language, 'vrXrLeftFaceUpper'),
        XrRightFaceUpper: t($language, 'vrXrRightFaceUpper'),
        XrLeftFaceLower: t($language, 'vrXrLeftFaceLower'),
        XrRightFaceLower: t($language, 'vrXrRightFaceLower'),
        XrLeftStickClick: t($language, 'vrXrLeftStickClick')
      }
    };
  }

  /** Ferme le remap et rend l'écran à ce qu'il portait. */
  function closeRemap(): void {
    remapOpen = false;
    listeningFor = null;
    captureGate.reset();
    if (scene) scene.screen.regions.length = 0;
    if (engine) {
      scene?.screen.showPicture();
    } else {
      backToLaunchScreen();
    }
  }
```

Les noms des boutons SNES sont des littéraux et non des clés i18n : « A » et « START » sont sérigraphiés sur la manette, identiques dans les deux langues, et les traduire inventerait une divergence entre l'écran et le plastique.

Dans `activate`, branche `profile` :
```ts
      if (id === 'remap') {
        // L'écran courbe ne porte qu'une chose : le remap remplace l'écran de
        // lancement, et `closeRemap` le rendra.
        launchFor = null;
        remapOpen = true;
        listeningFor = null;
        captureGate.reset();
        repaintControls();
        return;
      }
```

Dans `activate`, branche `screen` — **avant** la logique existante de l'écran de lancement, car les deux partagent `scene.screen.regions` :
```ts
    if (target.panel === 'screen' && remapOpen) {
      const id = target.region.id;
      if (id.startsWith('bind:')) {
        listeningFor = id.slice('bind:'.length) as VrButton;
        // Repart de zéro : la gâchette qui vient de cliquer cette ligne est
        // tenue à cet instant, et `CaptureGate` doit la voir comme consommée
        // pour ne pas la lier immédiatement au bouton visé.
        captureGate.reset();
        captureGate.tick(activeXrInputs(scene?.inputSources() ?? []));
        repaintControls();
        return;
      }
      if (id === 'preset:letters' || id === 'preset:thumb') {
        writePadMap(localStorage, id === 'preset:thumb' ? THUMB_MAP : LETTERS_MAP);
        padMap = readPadMap(localStorage);
        repaintControls();
        repaintProfile();
        return;
      }
      return;
    }
```

Dans la boucle de frame, là où `menuPressed` est déjà consulté, ajouter la capture **avant** la bascule des panneaux :

```ts
    if (remapOpen && listeningFor) {
      const sources = scene.inputSources();
      // Le clic du stick droit annule au lieu de basculer les panneaux : c'est
      // la seule entrée hors modèle, donc le seul recours possible - tous les
      // autres boutons sont capturables.
      if (menuPressed(sources)) {
        listeningFor = null;
        captureGate.reset();
        repaintControls();
        return;
      }
      const taken = captureGate.tick(activeXrInputs(sources));
      if (taken) {
        padMap = assignInput(padMap, listeningFor, taken);
        writePadMap(localStorage, padMap);
        // Relu, pour la même raison que les presets : `readPadMap` est la
        // seule chose qui décide, et le défaut est retiré plutôt qu'écrit.
        padMap = readPadMap(localStorage);
        listeningFor = null;
        repaintControls();
        repaintProfile();
      }
      return;
    }
```

Dans `teardown`, à côté de `covers.clear()` :
```ts
    remapOpen = false;
    listeningFor = null;
    captureGate.reset();
```

Et dans la branche `resume` de `activate`, ainsi que dans `backToLaunchScreen`, s'assurer que `remapOpen` est remis à `false` — sinon l'écran porterait deux contenus à la fois.

- [ ] **Step 4: Lancer les tests et le typecheck**

Run: `bun run test:ui`
Expected: PASS.

Run: `cd frontend && PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH" npm run check`
Expected: 0 erreur.

- [ ] **Step 5: Vérifier le bundle**

Run: `cd frontend && PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH" npm run build`
Expected: exit 0.

Ni `npm run check` ni `bun run test:ui` n'invoque le bundler, et le déploiement est `vite build` : une branche a déjà passé six tâches avec zéro erreur et 226 tests verts pendant que `vite build` échouait.

- [ ] **Step 6: Commit**

```bash
git add -u frontend/src/lib/components/VrShell.svelte frontend/src/lib/vr/panels/profile.ts core/test/vr-panel-profile.test.ts
git commit -m "Open the remap panel, and let a pressed button land in it"
```

---

### Task 7 : épingler la garde qui existe déjà

**Files:**
- Test: `core/test/vr-pad.test.ts`

**Interfaces:**
- Consumes: `readVrPad` de la tâche 2.
- Produces: rien.

Le spec ajoutait à l'origine un argument `capturing` à `readVrPad`. Vérification faite, il serait inutile : les deux appels (`VrShell.svelte:694` pour le solo, `:1014` pour le lockstep) sont déjà gardés par `!scene.arePanelsVisible()`, et la capture n'est atteignable que panneaux levés. Un second verrou pour la même porte est un verrou dont personne ne saura lequel ouvre.

Mais **cette garde n'a aujourd'hui aucun test**. Rien n'empêcherait un futur appelant de l'oublier, et la panne serait qu'un bouton pressé pour être lié parte aussi dans le jeu.

- [ ] **Step 1: Écrire le test**

Ajouter à `core/test/vr-pad.test.ts` :

```ts
test('un masque nul est ce que produit une session non visible, boutons tenus ou non', () => {
  /*
   * La garde que les deux appelants portent déjà - `!scene.arePanelsVisible()`
   * dans `VrShell` - repose sur celle-ci : le menu système laisse la boucle
   * d'animation tourner et cesse de livrer l'entrée, et un bouton tenu à cet
   * instant resterait tenu tout le reste de la session.
   *
   * C'est aussi ce qui rend inutile un argument `capturing` : la capture n'est
   * atteignable que panneaux levés, où les appelants rendent déjà zéro.
   */
  const allHeld = [hand('left', [0, 1, 3, 4, 5]), hand('right', [0, 1, 4, 5])];
  for (const visibility of ['hidden', 'visible-blurred', '']) {
    assert.equal(
      readVrPad(allHeld, LETTERS_MAP, visibility),
      0,
      `visibility=${visibility} a laissé passer un masque`
    );
  }
  assert.notEqual(
    readVrPad(allHeld, LETTERS_MAP, 'visible'),
    0,
    'le test ne prouverait rien si visible rendait zéro aussi'
  );
});
```

La dernière assertion est ce qui empêche ce test de passer pour une mauvaise raison : sans elle, un `readVrPad` qui rendrait toujours zéro le satisferait.

- [ ] **Step 2: Lancer le test**

Run: `bun test core/test/vr-pad.test.ts`
Expected: PASS. Ce test ne passe pas par un cycle rouge : il épingle un comportement existant et correct, ce qui est son objet. Pour vérifier qu'il mord, retirer temporairement la ligne `if (visibility !== 'visible') return 0;` de `readVrPad`, constater l'échec, puis la remettre.

- [ ] **Step 3: Vérifier qu'il mord**

Retirer la garde, lancer, constater l'échec, remettre la garde, relancer.

Run: `bun test core/test/vr-pad.test.ts`
Expected: FAIL sans la garde, PASS avec.

- [ ] **Step 4: Commit**

```bash
git add core/test/vr-pad.test.ts
git commit -m "Pin the guard that keeps a bound button out of the game"
```

---

### Task 8 : réécrire ce que la décision a rendu faux

**Files:**
- Modify: `frontend/src/lib/vr/panels/profile.ts` (en-tête)
- Modify: `docs/superpowers/specs/2026-09-02-vr-meta-quest-design.md` (note de renvoi)

**Interfaces:** aucune.

- [ ] **Step 1: Corriger l'en-tête du panneau profil**

Il porte aujourd'hui :

> *What is deliberately absent: the ROM source (there is no file picker in an immersive session), the portable config (files), account deletion (a destructive action behind a confirmation), and per-button rebinding (the issue's own line, and the presets are the whole of the rectification).*

La dernière clause est devenue fausse. La remplacer par :

```
 * What is deliberately absent: the ROM source (there is no file picker in an
 * immersive session), the portable config (files), and account deletion (a
 * destructive action behind a confirmation).
 *
 * Per-button rebinding used to be on that list, with the two presets as "the
 * whole of the rectification". It is not any more - `panels/controls.ts` binds
 * all eight buttons - but the presets did not become pointless: they are the
 * two starting points, and the reasoning that produced them still holds. The
 * SNES diamond has to fold onto two vertical pairs and no folding is free.
```

- [ ] **Step 2: Laisser une trace dans le spec d'origine**

Dans `docs/superpowers/specs/2026-09-02-vr-meta-quest-design.md`, sous le titre, ajouter :

```markdown
> **Révisé le 2026-09-05 :** la conclusion sur les contrôles — deux presets
> plutôt qu'un remap — a été reprise. Voir
> `2026-09-05-vr-remap-controles-design.md`.
```

Un spec dont une conclusion a été renversée sans que rien ne le dise est un spec qui induit en erreur le prochain lecteur, et c'est le premier document qu'il ouvrira.

- [ ] **Step 3: Vérifier que rien n'est cassé**

Run: `bun run test:ui`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/vr/panels/profile.ts docs/superpowers/specs/2026-09-02-vr-meta-quest-design.md
git commit -m "Correct the two comments this rebinding made untrue"
```

---

## Vérification finale

Avant de déclarer le travail fini :

```bash
bun run test:all
cd frontend && PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH" npm run check
cd frontend && PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH" npm run build
```

Les trois doivent passer : la suite entière verte, zéro erreur svelte-check, `vite build` en exit 0.

**Ce qui restera invérifiable ici :** le rendu et l'ergonomie dans un casque. WebXR demande un appareil et Playwright ne peut pas ouvrir de session immersive. Ce que ces commandes prouvent est la géométrie, le modèle et l'absence de régression — pas qu'une ligne se lit à 2,5 m ni qu'une capture se fait sans y penser. À vérifier au prochain passage sur le Quest, et à dire comme tel plutôt que comme « terminé ».
