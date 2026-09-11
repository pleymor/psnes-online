/**
 * L'opacité du rideau, en fonction du temps écoulé.
 *
 * Pourquoi un fondu plutôt qu'une bascule : passer d'un ciel bleu plein champ
 * à du quasi-noir d'une image à l'autre est un à-coup de luminance sur toute
 * la rétine, et le retour est pire. Quatre dixièmes de seconde suffisent à le
 * supprimer sans faire attendre.
 *
 * Pourquoi une fonction pure plutôt qu'un état qui se décrémente : le temps
 * vient du runtime XR, et un compteur interne se désynchroniserait de lui à la
 * première image sautée. Ici, une image en retard rattrape toute seule.
 */
import { FADE_SECONDS } from './composition';

export type FadeTarget = 'dark' | 'decor';

export function curtain(
  elapsed: number,
  to: FadeTarget
): { opacity: number; done: boolean } {
  const progress = Math.min(1, Math.max(0, elapsed / FADE_SECONDS));
  const opacity = to === 'dark' ? progress : 1 - progress;
  return { opacity, done: progress >= 1 };
}

/**
 * L'instant du fondu où cette direction montre cette opacité.
 *
 * L'inverse de `curtain`, et il n'existe que pour une chose : reprendre un
 * fondu en sens inverse avant qu'il soit fini. `curtain` est pure en
 * (elapsed, target) et ne sait rien de l'opacité courante, donc repartir de
 * zéro ferait sauter le rideau à l'extrémité de l'autre courbe - un éclair
 * d'une image, exactement l'à-coup de luminance que ce module existe pour
 * supprimer. En repartant d'ici, l'opacité reste continue au revirement.
 */
export function elapsedFor(opacity: number, to: FadeTarget): number {
  const clamped = Math.min(1, Math.max(0, opacity));
  const progress = to === 'dark' ? clamped : 1 - clamped;
  return progress * FADE_SECONDS;
}

/** three passe l'horodatage XR en millisecondes ; ce module compte en
 *  secondes. */
const MILLISECONDS_PER_SECOND = 1000;

/**
 * `curtain`, mais à partir d'un horodatage XR - en millisecondes.
 *
 * La conversion vivait dans `build.ts`, le seul fichier de `decor/` qu'aucun
 * test ne peut exécuter (il importe three). Elle appartient ici : c'est ce
 * module qui compte en secondes, donc c'est lui qui doit savoir convertir.
 */
export function curtainAtMillis(
  elapsedMs: number,
  to: FadeTarget
): { opacity: number; done: boolean } {
  return curtain(elapsedMs / MILLISECONDS_PER_SECOND, to);
}
