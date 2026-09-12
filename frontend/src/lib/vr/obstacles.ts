/**
 * Ce qui barre le passage au joueur, déduit de ce qui le dessine.
 *
 * AUCUNE SECONDE LISTE, et c'est tout l'objet de ce module : le comptoir vient
 * de `counterRuns`, les objets proches de `props()`, et leurs tailles de leur
 * art. Un tuyau déplacé déplace donc son obstacle, et un objet ajouté au décor
 * devient solide sans que personne y pense. Une liste d'obstacles écrite à la
 * main aurait dérivé au premier déplacement - c'est la leçon que `placement.ts`
 * tire déjà de ses propres tailles, qu'il refuse d'écrire.
 */
import { rasterise } from './decor/pixels';
import { ALL_ART } from './decor/art';
import { ART_PIXELS_PER_METRE } from './decor/composition';
import { props } from './decor/placement';
import { counterRuns, COUNTER_BLOCK_WIDTH, COUNTER_DEPTH, type SceneLayout } from './layout';
import { BODY_HEIGHT, type Obstacle } from './collide';
import type { Pipe } from './pipes';

export function lobbyObstacles(layout: SceneLayout, floorHeight: number): Obstacle[] {
  const out: Obstacle[] = [];

  for (const box of props()) {
    /*
     * Ce qui est entièrement au-dessus d'un corps debout ne barre rien : on
     * passe dessous. C'est ce qui laisse la rangée de blocs `?` à 2,40 m hors
     * de cette liste sans avoir à la nommer - et le jour où elle descendra,
     * elle deviendra solide toute seule.
     */
    if (box.standing >= BODY_HEIGHT) continue;
    const raster = rasterise(ALL_ART[box.front]);
    out.push({
      at: [box.radius * Math.sin(box.azimuth), -box.radius * Math.cos(box.azimuth)],
      halfWidth: raster.width / ART_PIXELS_PER_METRE / 2,
      halfDepth: box.depth / 2,
      yaw: box.azimuth,
      // `standing` est la hauteur du BAS ; le sommet est donc plus haut de tout
      // le dessin, la règle des seize pixels par mètre servant une fois de plus.
      top: box.standing + raster.height / ART_PIXELS_PER_METRE
    });
  }

  // Le comptoir : trois blocs d'un mètre, à l'endroit exact où ils sont posés.
  for (const run of counterRuns(layout)) {
    out.push({
      at: [run.top[0], run.top[2]],
      halfWidth: COUNTER_BLOCK_WIDTH / 2,
      halfDepth: COUNTER_DEPTH / 2,
      yaw: run.facing,
      /*
       * `run.top` est mesuré depuis l'ŒIL, comme tout ce que `layout.ts`
       * produit, alors que les obstacles parlent en hauteur au-dessus du SOL.
       * La hauteur du plancher fait le pont, et c'est le seul endroit du
       * lobby où les deux conventions se rencontrent.
       */
      top: floorHeight + run.top[1]
    });
  }

  return out;
}

/**
 * Les tuyaux où l'on peut entrer, déduits des mêmes données.
 *
 * Un tuyau est fait de DEUX boîtes - le fût et la lèvre - posées au même
 * azimut, donc on les regroupe par azimut et on garde le sommet le plus haut :
 * la lèvre. Compter sur le nom de l'art plutôt que sur la forme serait plus
 * court et plus fragile ; le jour où un tuyau gagne une troisième pièce, ce
 * code n'a rien à apprendre.
 */
export function lobbyPipes(): Pipe[] {
  const byAzimuth = new Map<number, Pipe>();
  for (const box of props()) {
    if (!box.front.startsWith('pipe')) continue;
    const top = box.standing + rasterise(ALL_ART[box.front]).height / ART_PIXELS_PER_METRE;
    const known = byAzimuth.get(box.azimuth);
    if (known && known.top >= top) continue;
    byAzimuth.set(box.azimuth, {
      at: [box.radius * Math.sin(box.azimuth), -box.radius * Math.cos(box.azimuth)],
      top
    });
  }
  return [...byAzimuth.values()];
}
