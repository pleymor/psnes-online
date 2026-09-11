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
 */

/** L'image courante d'une boucle, à la cadence demandée. */
export function spriteFrame(t: number, o: { frames: number; hz: number }): number {
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
  const phase = ((t % o.period) + o.period) % o.period;
  if (phase >= o.outFor) return 0;
  if (phase < o.rise) return (phase / o.rise) * o.travel;
  const falling = o.outFor - o.rise;
  if (phase > falling) return ((o.outFor - phase) / o.rise) * o.travel;
  return o.travel;
}
