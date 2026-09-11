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
