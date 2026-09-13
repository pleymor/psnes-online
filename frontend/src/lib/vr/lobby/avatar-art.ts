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
