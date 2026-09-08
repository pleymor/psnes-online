/**
 * Quelle entrée Touch porte quel bouton SNES.
 *
 * Ce module remplace `pad-scheme.ts`, dont l'en-tête disait que choisir entre
 * deux presets était « toute la rectification » du fait de ne pas offrir de
 * réglage de contrôles. Ce n'est plus la conclusion retenue, mais le
 * raisonnement tient toujours : le losange SNES (X haut, Y gauche, A droite,
 * B bas) doit se plier sur deux paires verticales, et aucun pliage n'est
 * gratuit. Ce qui a changé une seconde fois, c'est la conclusion qu'on en
 * tirait : le défaut n'est plus un pliage du losange du tout, mais la
 * permutation que le propriétaire a fini par jouer (voir `DEFAULT_MAP`). Les
 * deux presets d'origine ne survivent que pour les joueurs qui en avaient un
 * de stocké.
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
 * L'entrée qui porte l'accéléré tant qu'aucun bouton SNES ne l'a prise.
 *
 * Nommée ici, dans le modèle, et pas là où l'accéléré est appliqué : « si ce
 * bouton est assigné, alors c'est le bouton assigné qui gagne » est une règle
 * SUR la carte, et c'est la carte qui doit pouvoir répondre. Le geste vit
 * dans `fastForwardHeld` (`pad.ts`), et le panneau ne le nomme au joueur que
 * quand `fastForwardClaimed` est faux - annoncer un raccourci qu'un remap
 * vient d'emporter est pire que ne rien annoncer.
 */
export const FAST_FORWARD_INPUT: XrInput = 'XrLeftStickClick';

/** Un bouton SNES a-t-il réclamé l'entrée de l'accéléré ? */
export function fastForwardClaimed(map: VrPadMap): boolean {
  return VR_BUTTONS.some((button) => map[button] === FAST_FORWARD_INPUT);
}

/**
 * Le preset qui garde la lettre imprimée honnête.
 *
 * C'était `FACE.letters` dans `pad.ts` : `left: [PAD.Y, PAD.X]`,
 * `right: [PAD.B, PAD.A]`, où le premier de chaque paire est le bouton HAUT.
 *
 * Il a été le défaut jusqu'au 2026-09-08. Il ne l'est plus, mais il reste
 * exporté : `'letters'` est déjà sous la clé chez de vrais joueurs, et
 * `readPadMap` doit continuer à leur rendre CE pliage-là plutôt que le
 * nouveau. Un défaut qui change ne doit pas déplacer un choix explicite.
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

/**
 * Celui qu'un joueur obtient sans rien demander, et il n'est ni l'un ni
 * l'autre des deux presets ci-dessus.
 *
 * Il vient du jeu réel : le propriétaire a passé les soirées à rebinder dans
 * le casque, s'est arrêté sur cette permutation, et l'a dictée bouton par
 * bouton. C'est la seule justification qu'elle a besoin d'avoir - aucun
 * raisonnement sur le losange SNES ne bat des heures de manette en main - mais
 * elle en a une seconde, structurelle, qui explique pourquoi les presets
 * dérivés du losange ne pouvaient pas y arriver : ici les gâchettes ne portent
 * PAS les boutons L/R. Les grips le font, là où une gâchette d'index tombe
 * naturellement sur une détente et où un majeur tombe sur une gâchette
 * d'épaule. Les deux gâchettes libérées prennent alors A et X, les deux
 * boutons qu'on presse le plus, et les quatre boutons de face se répartissent
 * en deux paires : B et Y à droite (le saut et la course de Mario, sous le
 * pouce qui ne bouge pas), Start et Select à gauche (ceux qu'on presse entre
 * deux parties, loin de tout).
 *
 * Le clic du stick gauche - la neuvième entrée - reste libre, et ce n'est pas
 * un reste : c'est ce qui rend l'accéléré (`fastForwardHeld` dans `pad.ts`)
 * disponible sans réglage. Un joueur qui l'assigne quand même récupère son
 * bouton, et perd l'accéléré : la règle est « le bouton assigné gagne ».
 */
export const DEFAULT_MAP: VrPadMap = {
  a: 'XrRightTrigger',
  x: 'XrLeftTrigger',
  l: 'XrLeftSqueeze',
  r: 'XrRightSqueeze',
  y: 'XrRightFaceUpper',
  b: 'XrRightFaceLower',
  start: 'XrLeftFaceUpper',
  select: 'XrLeftFaceLower'
};

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
