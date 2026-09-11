/**
 * Les couleurs du monde Mario, nommées une fois.
 *
 * Pourquoi une table plutôt que des littéraux au fil des motifs : l'art est
 * écrit en grilles de caractères (`pixels.ts`), et un caractère y désigne un
 * NOM de couleur, pas une valeur. C'est ce qui rend le cyclage de palette du
 * bloc `?` gratuit (lot 4) - on échange une table, pas un dessin - et c'est ce
 * qui permet à un test de vérifier que tout caractère de tout motif pointe
 * quelque part.
 *
 * Les valeurs visent le nuancier SNES : des aplats francs, aucun dégradé.
 */
export const COLOURS = {
  sky: '#5c94fc',
  cloud: '#fcfcfc',
  hill: '#007800',
  hillDark: '#006000',
  grass: '#00a800',
  grassDark: '#007c00',
  brick: '#c84c0c',
  brickLight: '#e45c10',
  pipe: '#00a800',
  pipeHi: '#58d854',
  pipeSide: '#006000',
  block: '#e39a10',
  blockHi: '#fcbc3c',
  goomba: '#a04000',
  goombaFoot: '#e09050',
  outline: '#000000'
} as const;

export type ColourName = keyof typeof COLOURS;
