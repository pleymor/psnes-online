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
