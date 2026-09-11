/**
 * Le mouvement du décor : `t` en secondes, et rien d'autre.
 *
 * Aucune de ces fonctions ne garde d'état. Le temps vient du runtime XR, et un
 * compteur incrémenté par image dériverait de lui dès la première image
 * sautée - un goomba qui dérive finit par sortir de sa plate-forme, une plante
 * par rester dehors. Ici, une image en retard rattrape toute seule.
 *
 * Les trois règles de confort de la spec vivent dans les APPELANTS - les
 * vitesses et les rayons - pas ici. Ce module ne sait pas ce qu'est un degré
 * par seconde ; il sait faire un triangle et un modulo.
 *
 * TOUT CE QUI EST DOUTEUX JETTE, en nommant le coupable, comme `box.ts` et
 * `pixels.ts`. La raison est précise : ces fonctions divisent par des nombres
 * écrits à la main dans `placement.ts`, et un zéro y rend `Infinity` ou
 * `NaN`. Un `NaN` dans une position three ne fait pas une créature mal
 * placée, il la fait DISPARAÎTRE - le défaut le plus coûteux à diagnostiquer
 * de ce lot, parce que rien n'en parle et que l'objet semble n'avoir jamais
 * été ajouté. Le coût par image est nul en pratique : des comparaisons,
 * aucune allocation.
 */

/** L'image courante d'une boucle, à la cadence demandée. */
export function spriteFrame(t: number, o: { frames: number; hz: number }): number {
  // Un compte d'images nul rend `NaN` par le modulo, et l'appelant s'en sert
  // pour indexer : `frames[NaN]` est `undefined`, donc la lecture de ses uv
  // jette bien plus loin que la cause.
  if (!Number.isInteger(o.frames) || o.frames < 1) {
    throw new Error(`nombre d'images invalide : ${o.frames}`);
  }
  if (!(o.hz > 0)) throw new Error(`cadence invalide : ${o.hz}`);
  const ticks = Math.floor(Math.max(0, t) * o.hz);
  return ticks % o.frames;
}

/**
 * Un va-et-vient entre deux bornes : une onde triangulaire.
 *
 * Part de `from`, ce qui n'est pas indifférent - `patrol(0)` doit être le
 * point où l'objet a été POSÉ dans `placement.ts`, sinon tout saute à la
 * première image.
 */
export function patrol(
  t: number,
  o: { from: number; to: number; speed: number }
): { at: number; facing: 1 | -1 } {
  if (!(o.speed > 0)) throw new Error(`vitesse invalide : ${o.speed}`);
  // Bornes égales : période nulle, donc un modulo par zéro. Bornes inversées :
  // la faute de signe, qui ferait marcher l'objet hors de son segment au lieu
  // de le faire disparaître - donc la plus discrète des deux.
  if (!(o.to > o.from)) throw new Error(`segment invalide : de ${o.from} à ${o.to}`);
  const span = o.to - o.from;
  const period = (2 * span) / o.speed;
  const phase = ((t % period) + period) % period;
  const travelled = phase * o.speed;
  return travelled <= span
    ? { at: o.from + travelled, facing: 1 }
    : { at: o.to - (travelled - span), facing: -1 };
}

/** Une dérive qui repasse par zéro plutôt que de s'éloigner sans fin. */
export function drift(t: number, o: { start: number; speed: number; wrap: number }): number {
  if (!(o.wrap > 0)) throw new Error(`longueur de boucle invalide : ${o.wrap}`);
  const at = o.start + t * o.speed;
  return ((at % o.wrap) + o.wrap) % o.wrap;
}

/**
 * La plante carnivore : dehors un moment, rentrée le reste du temps.
 *
 * Rendue en hauteur au-dessus de sa position rentrée, donc zéro veut dire
 * « invisible dans le tuyau ». La montée et la descente prennent `rise`
 * chacune, ce qui évite l'apparition instantanée - le seul mouvement de ce
 * décor qui serait brusque.
 */
export function piranha(
  t: number,
  o: { period: number; outFor: number; travel: number; rise: number }
): number {
  if (!(o.period > 0)) throw new Error(`période invalide : ${o.period}`);
  if (!(o.rise > 0)) throw new Error(`montée invalide : ${o.rise}`);
  if (!(o.travel > 0)) throw new Error(`course invalide : ${o.travel}`);
  if (o.outFor > o.period) {
    throw new Error(`fenêtre de sortie de ${o.outFor} s dans une période de ${o.period} s`);
  }
  // Sans cette dernière : les deux rampes se chevauchent, et la tête SAUTE au
  // lieu de monter - le seul mouvement brusque que ce décor pourrait produire.
  if (2 * o.rise > o.outFor) {
    throw new Error(`rampes de ${o.rise} s × 2 dans une fenêtre de ${o.outFor} s`);
  }
  const phase = ((t % o.period) + o.period) % o.period;
  if (phase >= o.outFor) return 0;
  if (phase < o.rise) return (phase / o.rise) * o.travel;
  const falling = o.outFor - o.rise;
  if (phase > falling) return ((o.outFor - phase) / o.rise) * o.travel;
  return o.travel;
}
