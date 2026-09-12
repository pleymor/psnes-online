/**
 * Se cogner au décor plutôt que de le traverser, dans un module sans three.
 *
 * Le monde du lobby est fait de BOÎTES - le comptoir, les tuyaux, les blocs -
 * et elles portent déjà tout ce qu'il faut : une position, une largeur, une
 * profondeur et un lacet. Rien n'est à inventer ici, seulement à consulter :
 * les obstacles se déduisent de `placement.ts` et de `layout.ts`, jamais
 * d'une seconde liste qu'il faudrait tenir à jour.
 *
 * Vu de dessus, tout est un rectangle orienté. La troisième dimension ne sert
 * qu'à décider ce qui bloque : un bloc `?` flotte à 2,40 m, donc on passe
 * dessous, et il n'a rien à faire dans cette liste.
 */

/** Un obstacle vu de dessus : un rectangle orienté. */
export interface Obstacle {
  /** Le centre, dans le plan. */
  readonly at: readonly [number, number];
  /** La demi-largeur, le long de son propre axe. */
  readonly halfWidth: number;
  /** La demi-profondeur, perpendiculairement. */
  readonly halfDepth: number;
  /** Le lacet de l'obstacle, en radians. */
  readonly yaw: number;
}

/**
 * Le rayon du joueur, en mètres.
 *
 * Un joueur n'est pas un point : sans rayon, on peut coller son nez dans une
 * brique, et en VR ça se lit comme une texture plaquée sur les yeux plutôt que
 * comme un mur. Trente centimètres, soit une épaule.
 */
export const BODY_RADIUS = 0.3;

/**
 * La hauteur d'un corps debout, pour décider ce qui barre le passage.
 *
 * Ce qui est entièrement au-dessus ne bloque pas - on passe dessous - et c'est
 * ce qui laisse la rangée de blocs `?` à 2,40 m hors de la liste sans avoir à
 * la nommer.
 */
export const BODY_HEIGHT = 1.8;

/**
 * Glisser le long des obstacles au lieu de s'y arrêter net.
 *
 * Rend la position atteignable la plus proche de `to`. La résolution se fait
 * obstacle par obstacle, en repoussant le joueur le long de la normale la
 * moins profonde - la méthode du plus petit dégagement, qui donne le
 * glissement le long d'un mur sans avoir à écrire de cas particulier pour les
 * coins.
 *
 * Une butée franche se sentirait comme un bug ; un glissement se sent comme un
 * mur, et c'est la même raison qui avait fait projeter la marche sur son
 * disque quand elle en avait encore un.
 */
export function slide(
  from: readonly [number, number],
  to: readonly [number, number],
  obstacles: readonly Obstacle[]
): [number, number] {
  /*
   * Le pas est DÉCOUPÉ, parce que cette résolution ne regarde que la
   * destination.
   *
   * Un pas plus long que l'épaisseur d'un obstacle le traverse sans jamais
   * s'y trouver - le tunnel, le grand classique de la détection discrète. À
   * 1,2 m/s et 72 Hz un pas fait 1,7 cm et rien ne peut tunneler ; mais la
   * course et le saut arrivent, et le jour où quelqu'un doublera la vitesse
   * il ne pensera pas à ce fichier. Le découpage coûte quelques itérations
   * dans le seul cas où il y en a besoin.
   */
  const span = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const steps = Math.max(1, Math.ceil(span / BODY_RADIUS));
  /*
   * Chaque sous-pas part de LÀ OÙ ON EST, et non d'un point de la ligne
   * d'origine. La différence n'est pas cosmétique : en visant les points de la
   * ligne, le premier qui tombe au-delà du centre d'un obstacle se fait
   * dégager de l'AUTRE côté - le joueur traverse donc le mur en étant repoussé
   * par lui, ce qui est le comble. En avançant depuis la position résolue, un
   * joueur arrêté reste arrêté.
   */
  const dx = (to[0] - from[0]) / steps;
  const dz = (to[1] - from[1]) / steps;
  let at: [number, number] = [from[0], from[1]];
  for (let i = 0; i < steps; i++) {
    at = resolve(at, [at[0] + dx, at[1] + dz], obstacles);
  }
  return at;
}

/** Un pas court, assez pour qu'aucun obstacle ne puisse être traversé. */
function resolve(
  from: readonly [number, number],
  to: readonly [number, number],
  obstacles: readonly Obstacle[]
): [number, number] {
  let [x, z] = to;

  for (const obstacle of obstacles) {
    const cos = Math.cos(obstacle.yaw);
    const sin = Math.sin(obstacle.yaw);
    // Dans le repère de l'obstacle, où il est un rectangle droit.
    const dx = x - obstacle.at[0];
    const dz = z - obstacle.at[1];
    const along = dx * cos + dz * sin;
    const out = -dx * sin + dz * cos;

    const overWidth = obstacle.halfWidth + BODY_RADIUS - Math.abs(along);
    const overDepth = obstacle.halfDepth + BODY_RADIUS - Math.abs(out);
    // Hors de la boîte élargie sur l'un des deux axes : rien à faire.
    if (overWidth <= 0 || overDepth <= 0) continue;

    /*
     * Le plus petit dégagement gagne.
     *
     * C'est ce qui fait qu'on glisse le long d'une face plutôt que d'être
     * éjecté par le coin le plus proche : le joueur sort par où il est le
     * moins enfoncé, donc perpendiculairement à la face qu'il touche.
     */
    if (overWidth < overDepth) {
      x += Math.sign(along || 1) * overWidth * cos;
      z += Math.sign(along || 1) * overWidth * sin;
    } else {
      x += Math.sign(out || 1) * overDepth * -sin;
      z += Math.sign(out || 1) * overDepth * cos;
    }
  }

  /*
   * Si la résolution a fait plus de mal que de bien - ce qui arrive dans un
   * coin entre deux obstacles qui se repoussent l'un l'autre - on ne bouge
   * pas. Rester sur place est toujours valable ; être éjecté ne l'est pas.
   */
  const travelled = Math.hypot(x - from[0], z - from[1]);
  const wanted = Math.hypot(to[0] - from[0], to[1] - from[1]);
  return travelled > wanted + BODY_RADIUS ? [from[0], from[1]] : [x, z];
}

