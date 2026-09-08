/**
 * Une manette Bluetooth, en plus des manettes Touch.
 *
 * Demandé depuis le casque : « ce serait super de pouvoir paramétrer une
 * manette bluetooth, en alternative aux manettes d'origine ». En plus, et non
 * à la place : rien à basculer, les deux marchent en même temps.
 *
 * Le canal ne se devine pas, il est écrit dans la spec. Le module Gamepads de
 * WebXR interdit d'exposer comme source d'entrée XR un périphérique qui
 * n'appartient pas au casque - « the majority of traditional gamepads » y est
 * nommément - donc une manette Bluetooth n'arrive jamais dans
 * `session.inputSources`. Et réciproquement, les manettes Touch n'arrivent
 * jamais dans `navigator.getGamepads()`. Les deux canaux sont DISJOINTS par
 * construction, et c'est ce qui rend la fusion des deux masques sûre : aucun
 * bouton ne peut être compté deux fois, sans garde à écrire ni à oublier.
 *
 * Ce que ce module n'invente pas, c'est le mapping. Il lit `PadConfig` - la
 * table de la page plate, que le joueur configure sur grand écran et que son
 * compte porte - et jamais `VrPadMap`, qui n'a que huit boutons parce que la
 * croix y vit sur les sticks (`pad.ts`, `steer`). C'est exactement ce qui fait
 * marcher les directions : la table plate en a douze, et son défaut
 * `STANDARD_PAD` lie chaque direction à la croix ET au stick gauche. Une table
 * bâtie sur le modèle VR aurait laissé une manette Bluetooth sans croix.
 *
 * Reste un inconnu qu'aucune documentation ne lève : si le navigateur du Quest
 * continue de livrer les événements Gamepad à la page PENDANT une session
 * immersive. C'est un fait d'implémentation - la spec, les issues
 * d'immersive-web et MDN n'en disent rien - donc le panneau des contrôles
 * affiche ce que ce module voit (`bluetoothPadName`), et un joueur dont la
 * manette n'est pas vue le lit au lieu de le supposer.
 *
 * Pur, et il ne va rien chercher : les manettes, la table et la visibilité de
 * la session arrivent en arguments, comme dans `pad.ts` et pour la même
 * raison - c'est ce qui rend tout ceci testable sous Bun.
 */

import { BUTTONS, parsePadCode, type PadConfig } from '$lib/controls/binding';
import { BUTTON_BITS, readPadCode, sanitisePad } from '$lib/znet/input';
import type { PadMask } from '$lib/znet/protocol';

/**
 * La part de `Gamepad` que ceci lit.
 *
 * Plus étroite que le type du navigateur pour que les tests puissent en
 * fabriquer une, et parce qu'aucun autre champ n'entre dans la décision.
 */
export interface BtPadLike {
  connected: boolean;
  /** Ce que le casque annonce. Montré au joueur, jamais interprété. */
  id: string;
  buttons: readonly { pressed: boolean }[];
  axes: readonly number[];
  /**
   * `'standard'`, `'xr-standard'` ou vide.
   *
   * Lu pour une seule raison : écarter `'xr-standard'`. La spec interdit qu'une
   * manette XR apparaisse ici, mais si un navigateur l'y mettait quand même,
   * les indices de `PadConfig` seraient appliqués à une manette Touch et
   * produiraient des pressées fantômes que personne ne pourrait diagnostiquer
   * - le masque serait juste faux, sans erreur ni trace.
   *
   * Écarter `'xr-standard'` plutôt qu'exiger `'standard'` : une manette
   * exotique annonce une chaîne vide, ses indices sont alors inconnus, et
   * c'est exactement le cas que le joueur règle à la main sur la page plate.
   * L'exiger reprendrait ce que la page plate accepte déjà.
   */
  mapping?: string;
}

/** Les manettes réellement là, dans l'ordre où le navigateur les donne. */
function connected(pads: Iterable<BtPadLike | null>): BtPadLike[] {
  const found: BtPadLike[] = [];
  for (const pad of pads) {
    /*
     * `getGamepads()` garde ses créneaux.
     *
     * Une manette éteinte ou débranchée reste dans le tableau, avec l'état de
     * ses boutons au moment où elle est partie. Sans ce filtre, une manette
     * dont la pile lâche pendant qu'un bouton est enfoncé le tiendrait pour le
     * reste de la partie - et rien à l'écran ne dirait pourquoi le personnage
     * court tout seul.
     */
    if (!pad?.connected) continue;
    // Voir `mapping` : une manette XR ici serait une violation de la spec, et
    // la lire ferait double emploi avec `readVrPad`.
    if (pad.mapping === 'xr-standard') continue;
    found.push(pad);
  }
  return found;
}

export function readBluetoothPad(
  pads: Iterable<BtPadLike | null>,
  config: PadConfig,
  visibility: string
): PadMask {
  // Le menu système laisse la boucle tourner et cesse de livrer les entrées.
  // La même règle que `readVrPad`, et pour la même panne : un bouton tenu à
  // cet instant resterait tenu.
  if (visibility !== 'visible') return 0;

  let mask = 0;
  for (const pad of connected(pads)) {
    for (const button of BUTTONS) {
      for (const code of config[button]) {
        const described = parsePadCode(code);
        // Une table peut porter des codes de clavier : `PadConfig` ne parle que
        // manette, mais un fichier de configuration importé n'est pas tenu de
        // le respecter, et `parsePadCode` rend null plutôt que de deviner.
        if (described && readPadCode(pad, described)) mask |= BUTTON_BITS[button];
      }
    }
  }

  /*
   * Assaini ici, alors que `readVrPad` laisse passer les directions opposées.
   *
   * Ce n'est pas une incohérence : la lecture Touch les laisse passer parce
   * que deux sticks poussés à l'opposé sont un geste délibéré, et que du vrai
   * matériel fait la même chose. Mais l'appelant fusionne les deux sources, et
   * une manette poussée à gauche pendant qu'un stick Touch traîne à droite
   * n'est pas un geste : c'est un accident qui arrêterait net le personnage,
   * sans rien pour l'expliquer. `sanitisePad` est la décision de la page
   * plate, importée plutôt que réécrite.
   */
  return sanitisePad(mask);
}

/**
 * Le nom de la manette détectée, ou null.
 *
 * La première connectée : le panneau n'a la place que d'un nom, et personne ne
 * joue à deux manettes sur un casque. C'est l'instrument qui répond à
 * l'inconnu de l'en-tête - le joueur lit si sa manette est vue.
 */
export function bluetoothPadName(pads: Iterable<BtPadLike | null>): string | null {
  return connected(pads)[0]?.id ?? null;
}
