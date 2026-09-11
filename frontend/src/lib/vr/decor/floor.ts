/**
 * À quelle hauteur poser le sol.
 *
 * La session demande `local` seulement, dont l'origine est la tête à
 * l'ouverture : il n'y a donc AUCUNE hauteur de sol dans cette scène, et
 * `layout.ts` en fait une vertu pour les panneaux, qui sont mesurés depuis
 * les yeux. Un sol, lui, a besoin du nombre.
 *
 * `xr-session.ts` avait mesuré `local-floor: NotSupportedError` le
 * 2026-09-07, mais son propre commentaire dit pourquoi : « That is the
 * conformant refusal for a feature that was not asked for. » La session ne
 * négociait aucune feature. On la demande maintenant en OPTIONNELLE, et
 * uniquement pour mesurer - l'ancrage ne change pas d'un iota, three continue
 * de travailler dans son propre `local`.
 *
 * Toute incertitude répond la même chose : le repli. Un sol un peu faux fait
 * un monde qui paraît un peu plus grand ; un sol au plafond, ou à trois
 * mètres, fait une scène que le joueur lit comme cassée. Les bornes ci-dessous
 * séparent les deux, et attrapent au passage l'erreur la plus plausible de
 * cette plomberie - le signe inversé, qui est invisible autrement.
 *
 * UNE seule incertitude ne se replie pas : « le suivi n'est pas encore prêt ».
 * La pose n'existe qu'à l'intérieur d'une image XR, et les premières d'une
 * session peuvent n'en porter aucune. Répondre le repli là ferait de 1,20 m le
 * cas NORMAL plutôt que le cas dégradé. Elle répond donc `null`, qui veut dire
 * « redemande à la prochaine image » - et l'appelant ne construit le décor
 * qu'une fois qu'il a un nombre.
 */
import { FLOOR_FALLBACK } from './composition';

/** Les hauteurs d'œil plausibles, assis compris. */
const MIN_HEIGHT = 0.6;
const MAX_HEIGHT = 2.2;

export interface FloorPorts {
  /** L'espace `local-floor` si le casque l'a accordé, sinon `null`. */
  floorSpace(): unknown | null;
  /**
   * La pose de `space` dans l'espace de référence de la scène, ou `null` si
   * le suivi n'est pas prêt. Seul le `y` est lu : c'est l'origine du sol
   * exprimée depuis l'œil, donc un nombre négatif.
   */
  poseOf(space: unknown): { y: number } | null;
}

/** Mètres sous l'œil, toujours positif. `null` : redemander à la prochaine image. */
export function measureFloor(ports: FloorPorts): number | null {
  try {
    const space = ports.floorSpace();
    // Rien à attendre : le casque a refusé. Redemander ne le ferait jamais
    // apparaître, et le décor ne serait jamais construit.
    if (!space) return FLOOR_FALLBACK;

    const pose = ports.poseOf(space);
    if (!pose) return null;

    const height = -pose.y;
    if (!Number.isFinite(height)) return FLOOR_FALLBACK;
    if (height < MIN_HEIGHT || height > MAX_HEIGHT) return FLOOR_FALLBACK;
    return height;
  } catch {
    return FLOOR_FALLBACK;
  }
}
