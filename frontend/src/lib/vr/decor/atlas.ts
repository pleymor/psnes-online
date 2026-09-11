/**
 * Tout l'art du monde dans une seule texture.
 *
 * Trois bénéfices, dont un décisif. Un seul téléversement et un seul bind.
 * Ajouter un motif ne touche pas le code de rendu, puisqu'il suffit de
 * l'inscrire au registre. Et surtout : **tout l'art est visible d'un coup dans
 * un seul PNG**, ce qui est la planche de référence du développement - sans
 * casque, c'est le seul instrument qui montre ce qu'on dessine.
 *
 * Un corollaire qui n'est pas évident : animer un sprite devient gratuit.
 * Changer d'image, c'est décaler deux UV - aucun redessin de canvas, aucun
 * téléversement. À comparer avec l'avertissement de `panel-mesh.ts` sur le
 * coût d'une re-rasterisation à 72 Hz.
 *
 * Le rangement est en étagères, trié par hauteur décroissante : c'est
 * l'algorithme le plus simple qui ne gaspille pas, et le gaspillage n'a de
 * toute façon aucune importance ici - quelques dizaines de motifs de seize à
 * soixante-quatre pixels tiennent dans une texture de 256 ou 512.
 */
import { rasterise, type Art } from './pixels';

/**
 * Un pixel de garde autour de chaque motif.
 *
 * Pas une précaution contre le filtrage - l'atlas est en `NearestFilter`, il
 * n'interpole rien. C'est contre l'arrondi : une UV qui tombe exactement sur
 * une frontière peut, selon le pilote, retomber d'un texel du mauvais côté, et
 * on verrait alors un liseré du motif voisin. Un pixel transparent de marge le
 * rend impossible.
 */
const PADDING = 1;

const FIRST_SIZE = 256;
const MAX_SIZE = 2048;

export interface AtlasRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Atlas {
  readonly width: number;
  readonly height: number;
  readonly rects: Readonly<Record<string, AtlasRect>>;
}

export interface Uv {
  readonly u0: number;
  readonly v0: number;
  readonly u1: number;
  readonly v1: number;
}

function tryPack(
  sized: readonly { name: string; width: number; height: number }[],
  size: number
): Record<string, AtlasRect> | null {
  const rects: Record<string, AtlasRect> = {};
  let shelfY = PADDING;
  let shelfHeight = 0;
  let cursorX = PADDING;

  for (const item of sized) {
    if (cursorX + item.width + PADDING > size) {
      // Étagère suivante.
      shelfY += shelfHeight + PADDING;
      shelfHeight = 0;
      cursorX = PADDING;
    }
    // Les DEUX axes, après le passage d'étagère et non avant : un motif plus
    // large que l'atlas trébuche sur le contrôle du dessus, repart sur une
    // étagère neuve, et sans cette seconde ligne serait posé quand même -
    // `tryPack` rendrait alors un plan hors bornes au lieu de demander une
    // texture plus grande. L'axe des hauteurs n'a jamais eu ce trou parce que
    // son contrôle, lui, s'exécute à chaque tour.
    if (cursorX + item.width + PADDING > size) return null;
    if (shelfY + item.height + PADDING > size) return null;

    rects[item.name] = { x: cursorX, y: shelfY, width: item.width, height: item.height };
    cursorX += item.width + PADDING;
    if (item.height > shelfHeight) shelfHeight = item.height;
  }
  return rects;
}

export function packAtlas(art: Readonly<Record<string, Art>>): Atlas {
  // Trié par hauteur décroissante puis par nom : la hauteur est ce qui rend
  // les étagères efficaces, le nom est ce qui rend le résultat déterministe -
  // sans lui, l'ordre des clés de l'objet déciderait, et une planche de
  // référence changerait de disposition sans raison entre deux exécutions.
  const sized = Object.entries(art)
    .map(([name, one]) => {
      const raster = rasterise(one);
      return { name, width: raster.width, height: raster.height };
    })
    .sort((a, b) => b.height - a.height || a.name.localeCompare(b.name));

  for (let size = FIRST_SIZE; size <= MAX_SIZE; size *= 2) {
    const rects = tryPack(sized, size);
    if (rects) return { width: size, height: size, rects };
  }
  throw new Error(`l'art du décor ne tient pas dans ${MAX_SIZE} pixels`);
}

/**
 * Les UV d'un motif, dans la convention de three.
 *
 * `flipY` vaut true par défaut sur une `CanvasTexture`, donc la ligne du HAUT
 * du canvas se retrouve en v = 1. C'est l'inversion ci-dessous, et l'oublier
 * donne un monde entier à l'envers - ce qui se remarque, mais seulement après
 * avoir cherché ailleurs.
 */
export function uvOf(atlas: Atlas, name: string): Uv {
  const rect = atlas.rects[name];
  if (!rect) throw new Error(`motif absent de l'atlas : ${name}`);
  return {
    u0: rect.x / atlas.width,
    u1: (rect.x + rect.width) / atlas.width,
    v0: 1 - (rect.y + rect.height) / atlas.height,
    v1: 1 - rect.y / atlas.height
  };
}
