/**
 * L'écran au repos : une vitre, pas une mire.
 *
 * Ce qu'il remplace et ce que ça coûte, dit une fois ici plutôt que découvert
 * plus tard. `test-pattern.ts` peignait un damier avec une croix centrale et
 * une marge magenta, et ce n'était pas une décoration : il existait pour juger
 * la géométrie, la distance et les proportions de l'écran AVANT qu'une ROM
 * soit en jeu, et sa marge criait quand `uMax` était faux. Le propriétaire l'a
 * vu dans le casque et l'a trouvé laid ; l'instrument passe donc derrière le
 * lobby. Il n'est pas supprimé - `test-pattern.ts` reste, avec ses six tests -
 * et un réglage d'écran qui redemanderait une règle le retrouve intact.
 *
 * Ce qui le remplace laisse voir le monde à travers l'écran : un voile sombre
 * translucide, un grain fin, un reflet par le haut. Le même dépoli que les
 * pupitres (`chrome.ts`), pour que les deux surfaces de verre du lobby soient
 * la même matière.
 *
 * Il n'y a AUCUN flou, et il ne peut pas y en avoir : la texture est composée
 * par-dessus la scène, donc ses pixels ne voient jamais ceux du décor. Un vrai
 * flou demanderait de rendre la scène dans une cible puis de l'échantillonner
 * dans un shader - une passe de plus par œil, à 72 Hz, à côté de l'émulateur.
 */
import { drawField } from './chrome';

export function drawIdleGlass(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number
): void {
  ctx.clearRect(0, 0, width, height);
  drawField(ctx, width, height, 'frost');
}
