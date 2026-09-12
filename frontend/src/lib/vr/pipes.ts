/**
 * Se baisser, et descendre dans un tuyau pour ressortir par un autre.
 *
 * Le geste le plus Mario du lobby, et celui qui demande le plus de précautions
 * : une téléportation est un déplacement que le corps ne sent pas du tout,
 * donc le SEUL moment où elle est confortable est celui où l'on ne voit rien.
 * D'où la forme en trois temps - on s'enfonce, le noir tombe, on ressort -
 * plutôt qu'un saut instantané d'un tuyau à l'autre.
 *
 * Sans three et sans état caché : la machine est une valeur qu'on fait
 * avancer, donc elle se vérifie sous Bun image par image.
 */

/** Un tuyau où l'on peut entrer : où il est, et à quelle hauteur son bord. */
export interface Pipe {
  readonly at: readonly [number, number];
  /** La hauteur de sa lèvre au-dessus du sol. */
  readonly top: number;
}

/**
 * De combien on s'enfonce avant de disparaître, en mètres.
 *
 * Assez pour que la tête passe sous la lèvre - sinon on se téléporte les yeux
 * dehors, et le noir arrive sans raison visible.
 */
export const PIPE_DIP = 1.2;

/** La durée d'une descente, et celle d'une remontée, en secondes. */
export const PIPE_PHASE = 0.35;

/**
 * De combien le stick baisse le joueur quand on le pousse vers le bas.
 *
 * Un demi-mètre : assez pour passer sous une rangée de blocs `?` et pour que
 * le geste se sente, pas assez pour perdre le comptoir de vue.
 */
export const CROUCH_DEPTH = 0.5;

/** Sous ce débattement vers le bas, on ne se baisse pas. */
export const CROUCH_THRESHOLD = 0.6;

export type Travel =
  | { readonly kind: 'none' }
  | { readonly kind: 'down'; readonly t: number; readonly from: Pipe; readonly to: Pipe }
  | { readonly kind: 'up'; readonly t: number; readonly to: Pipe };

export const NOT_TRAVELLING: Travel = { kind: 'none' };

/**
 * De combien le joueur s'accroupit, en mètres.
 *
 * L'axe Y d'un stick est POSITIF vers le bas - l'inverse de la marche, et
 * c'est la même convention lue dans l'autre sens. Le seuil est franc plutôt
 * que progressif : s'accroupir à moitié n'a pas de sens, et un accroupissement
 * qui suivrait le pouce ferait osciller la tête du joueur.
 */
export function crouch(stickY: number): number {
  return stickY >= CROUCH_THRESHOLD ? CROUCH_DEPTH : 0;
}

/** Le tuyau sous les pieds du joueur, s'il y en a un. */
export function pipeUnder(
  at: readonly [number, number],
  feet: number,
  pipes: readonly Pipe[]
): Pipe | null {
  for (const pipe of pipes) {
    if (Math.abs(feet - pipe.top) > 0.1) continue;
    // Un demi-mètre autour du centre : la lèvre d'un tuyau fait 1,25 m de
    // large, donc on est dessus bien avant d'en toucher le bord.
    if (Math.hypot(at[0] - pipe.at[0], at[1] - pipe.at[1]) > 0.6) continue;
    return pipe;
  }
  return null;
}

/**
 * Entrer dans un tuyau, si on est dessus et qu'on se baisse.
 *
 * La destination est le tuyau SUIVANT, en tournant. Avec deux tuyaux, c'est
 * l'aller-retour ; avec trois, une boucle. Rien ici ne suppose qu'il y en a
 * deux, parce que le décor peut en gagner un troisième sans que ce fichier
 * l'apprenne.
 */
export function enter(
  at: readonly [number, number],
  feet: number,
  crouching: boolean,
  pipes: readonly Pipe[]
): Travel {
  if (!crouching || pipes.length < 2) return NOT_TRAVELLING;
  const from = pipeUnder(at, feet, pipes);
  if (!from) return NOT_TRAVELLING;
  const index = pipes.indexOf(from);
  return { kind: 'down', t: 0, from, to: pipes[(index + 1) % pipes.length] };
}

/** Une image de voyage. */
export function advance(travel: Travel, dt: number): Travel {
  if (travel.kind === 'none') return travel;
  const t = travel.t + Math.max(0, dt) / PIPE_PHASE;
  if (t < 1) return { ...travel, t };
  // La descente finie, on ressort par l'autre bout - c'est le seul endroit où
  // le joueur est déplacé, et il ne voit rien à ce moment-là.
  if (travel.kind === 'down') return { kind: 'up', t: 0, to: travel.to };
  return NOT_TRAVELLING;
}

/** Où le joueur se trouve pendant le voyage, ou `null` s'il n'en fait pas. */
export function travelling(travel: Travel): { at: readonly [number, number]; y: number } | null {
  if (travel.kind === 'none') return null;
  const pipe = travel.kind === 'down' ? travel.from : travel.to;
  // On s'enfonce, puis on ressort : la même course, lue dans un sens ou dans
  // l'autre.
  const sunk = travel.kind === 'down' ? travel.t : 1 - travel.t;
  return { at: pipe.at, y: pipe.top - PIPE_DIP * sunk };
}

/**
 * Le monde doit-il être masqué ?
 *
 * Vrai dès que la tête est sous la lèvre. C'est ce qui rend la téléportation
 * supportable : un déplacement que le corps ne sent pas est acceptable
 * exactement tant qu'on ne le VOIT pas.
 */
export function hidden(travel: Travel): boolean {
  const where = travelling(travel);
  if (!where || travel.kind === 'none') return false;
  const pipe = travel.kind === 'down' ? travel.from : travel.to;
  return where.y < pipe.top - PIPE_DIP / 2;
}
