/**
 * Ce qu'un calque a déjà montré, et où ça se trouve maintenant.
 *
 * Le problème que ce module résout, en une phrase : un calque n'est dessiné
 * que là où il a gagné le pixel, donc tout ce qui est devant lui y laisse un
 * trou - et un trou est exactement ce que le joueur voit à travers quand les
 * plans du relief s'écartent. La couleur du fond derrière un sprite n'a jamais
 * été calculée : le PPU compose, et seul le vainqueur survit.
 *
 * Mais elle a été calculée AVANT. Ce qui est caché maintenant était visible il
 * y a quelques images, et le défilement du calque dit de combien ça a bougé.
 * Garder ce qu'on a vu, le recaler, et s'en servir pour les trous : c'est tout.
 *
 * Sans three et sans texture : ce module ne fait que l'arithmétique - de
 * combien décaler, et si l'on peut y croire. `screen.ts` en tire des passes de
 * rendu.
 */

/** Le défilement d'un calque, en pixels, tel que le cœur le rend. */
export interface Scroll {
  readonly h: number;
  readonly v: number;
}

/**
 * Le décalage à appliquer à la mémoire pour la recaler sur cette image.
 *
 * LE SENS EST CELUI QUI SE TROMPE. Quand un calque défile vers la droite - son
 * `HOffset` augmente - la caméra avance dans le décor, donc ce qui était au
 * pixel 100 se retrouve au pixel 100 moins le delta. La mémoire se décale donc
 * de l'OPPOSÉ du défilement, et ce dépôt a payé cinq erreurs de signe pour
 * avoir deviné ce genre de chose au lieu de l'écrire.
 *
 * Le résultat est arrondi : un décalage d'un demi-pixel n'a pas de sens pour
 * une mémoire qui est une grille de pixels, et l'arrondi vaut mieux que
 * l'interpolation - qui étalerait la mémoire un peu plus à chaque image
 * jusqu'à la rendre floue.
 */
export function shiftFor(previous: Scroll, current: Scroll): { dx: number; dy: number } {
  /*
   * Soustrait dans CET ordre plutôt que nié après coup, et ce n'est pas une
   * coquetterie : `-Math.round(0)` vaut `-0`, que `Object.is` et les
   * comparaisons profondes distinguent de `0`. Un zéro négatif qui traverse
   * une frontière de module finit toujours par faire échouer une égalité que
   * personne ne soupçonne.
   */
  return {
    dx: Math.round(previous.h - current.h),
    dy: Math.round(previous.v - current.v)
  };
}

/**
 * Le défilement des SNES boucle à 1024, et un passage par zéro n'est pas un
 * saut de mille pixels.
 *
 * Sans ça, un calque qui repasse de 1023 à 0 produirait un décalage énorme, la
 * mémoire serait jetée, et le joueur verrait le trou noir réapparaître une
 * image sur mille - un défaut intermittent, c'est-à-dire le pire.
 */
export const SCROLL_WRAP = 1024;

/** Le delta le plus court entre deux défilements, en tenant compte du tour. */
export function scrollDelta(previous: number, current: number): number {
  let delta = (current - previous) % SCROLL_WRAP;
  if (delta > SCROLL_WRAP / 2) delta -= SCROLL_WRAP;
  if (delta < -SCROLL_WRAP / 2) delta += SCROLL_WRAP;
  return delta;
}

/**
 * La mémoire est-elle encore digne de foi ?
 *
 * C'est la question qui rend cette approche tenable, et elle a une raison
 * précise d'exister : le cœur rend UN défilement par image, alors que le HDMA
 * en change en cours d'écran - c'est ainsi que se font les parallaxes par
 * ligne et le ciel dégradé de Super Mario World. Une seule valeur par calque
 * ne décrit donc pas ces images-là.
 *
 * Plutôt que d'y croire, on vérifie : les pixels que le calque vient RÉELLEMENT
 * de gagner sont comparés à ce que la mémoire prévoyait au même endroit. S'ils
 * s'accordent, le défilement était juste et la mémoire vaut pour les trous.
 * S'ils divergent, elle est jetée et l'appelant retombe sur la dilatation.
 *
 * `sampled` et `remembered` sont des couleurs empaquetées en RVBA ; on ne
 * compare que le nombre de désaccords, parce que c'est la FORME du désaccord
 * qui compte - quelques pixels de bruit ne disent rien, la moitié de l'écran
 * dit que la prédiction est fausse.
 */
export const TRUST_THRESHOLD = 0.15;

export function trustworthy(disagreements: number, compared: number): boolean {
  if (compared === 0) return false;
  return disagreements / compared <= TRUST_THRESHOLD;
}

/**
 * Un pixel de la mémoire recalée retombe-t-il dans le cadre ?
 *
 * Ce qui sort ne revient pas par l'autre bord : la mémoire d'un calque n'est
 * pas un monde torique, et un décor qui reviendrait par la gauche après être
 * sorti par la droite serait plus troublant qu'un trou.
 */
export function inside(
  x: number,
  y: number,
  width: number,
  height: number
): boolean {
  return x >= 0 && y >= 0 && x < width && y < height;
}

/**
 * Ce qu'un calque a montré, pixel par pixel, et ce qu'on n'a jamais vu.
 *
 * UN SEUL TABLEAU, et l'alpha porte le « déjà vu ». Ce n'est pas une économie
 * de mémoire, c'est une économie de vérité : avec un second tableau de
 * drapeaux, il y a deux endroits qui peuvent se contredire, et le recalage
 * avait déjà ce défaut - il effaçait les drapeaux en laissant l'alpha périmé
 * dans les couleurs. Un pixel jamais vu n'est pas un pixel noir, il n'a pas de
 * couleur du tout, et une alpha de zéro dit exactement ça - au shader comme à
 * nous, sans conversion.
 *
 * Les couleurs peuvent être une VUE sur un tampon plus grand, ce qui laisse
 * `slot-fill.ts` ranger les mémoires de tous les calques dans un seul atlas et
 * le téléverser d'un bloc, sans recopie.
 */
export interface Memory {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  /** Un tampon de travail, pour ne pas en allouer un par image. */
  readonly scratch: Uint8ClampedArray;
}

export function createMemory(
  width: number,
  height: number,
  backing?: Uint8ClampedArray
): Memory {
  const data = backing ?? new Uint8ClampedArray(width * height * 4);
  if (data.length < width * height * 4) {
    throw new Error(`mémoire trop courte : ${data.length} pour ${width}x${height}`);
  }
  return { data, width, height, scratch: new Uint8ClampedArray(width * height * 4) };
}

/** A-t-on déjà vu ce pixel ? L'alpha le dit, et rien d'autre. */
export function sawPixel(memory: Memory, at: number): boolean {
  return memory.data[at * 4 + 3] !== 0;
}

/**
 * Oublie tout.
 *
 * Seules les alphas sont remises à zéro : les couleurs restent, mais plus
 * personne ne les croit, et les réécrire coûterait trois fois plus pour le
 * même résultat.
 */
export function forget(memory: Memory): void {
  const { data, width, height } = memory;
  for (let i = 3; i < width * height * 4; i += 4) data[i] = 0;
}

/**
 * Recale la mémoire de `dx`, `dy` pixels.
 *
 * Ce qui sort du cadre est perdu, et ce qui entre est marqué NON VU : une
 * mémoire n'est pas un monde torique, et un décor qui reviendrait par la
 * gauche après être sorti par la droite serait plus troublant qu'un trou.
 */
export function reproject(memory: Memory, dx: number, dy: number): void {
  if (dx === 0 && dy === 0) return;
  const { data, scratch, width, height } = memory;
  scratch.set(data.subarray(0, width * height * 4));

  for (let y = 0; y < height; y++) {
    const from = y - dy;
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const dst = (row + x) * 4;
      const sx = x - dx;
      if (from < 0 || from >= height || sx < 0 || sx >= width) {
        data[dst + 3] = 0;
        continue;
      }
      const src = (from * width + sx) * 4;
      data[dst] = scratch[src];
      data[dst + 1] = scratch[src + 1];
      data[dst + 2] = scratch[src + 2];
      data[dst + 3] = scratch[src + 3];
    }
  }
}

/**
 * Écrit ce que le calque vient de gagner, ET juge la prédiction au passage.
 *
 * Les deux dans la même passe parce que c'est la même boucle : un pixel que le
 * calque vient de dessiner est à la fois ce qu'il faut retenir et ce qui
 * permet de savoir si la mémoire disait vrai à cet endroit. Les séparer
 * coûterait un second parcours pour la même information.
 *
 * Rend de quoi appeler `trustworthy`. Le désaccord se mesure sur les pixels
 * DÉJÀ VUS seulement : un pixel neuf ne prédit rien, donc il ne peut pas se
 * tromper.
 */
export function stamp(
  memory: Memory,
  picture: Uint8Array | Uint8ClampedArray,
  mask: Uint8Array,
  slot: number,
  stride: number
): { disagreements: number; compared: number } {
  const { data, width, height } = memory;
  let disagreements = 0;
  let compared = 0;

  for (let y = 0; y < height; y++) {
    const source = y * stride;
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (mask[source + x] !== slot) continue;
      const from = (source + x) * 4;
      const at = (row + x) * 4;
      const r = picture[from];
      const g = picture[from + 1];
      const b = picture[from + 2];

      if (data[at + 3] !== 0) {
        compared++;
        // Une tolérance par canal : la même couleur peut différer d'un bit
        // après un aller-retour par une texture, et compter ça comme un
        // désaccord ferait jeter une mémoire parfaitement bonne.
        if (
          Math.abs(data[at] - r) > 8 ||
          Math.abs(data[at + 1] - g) > 8 ||
          Math.abs(data[at + 2] - b) > 8
        ) {
          disagreements++;
        }
      }

      data[at] = r;
      data[at + 1] = g;
      data[at + 2] = b;
      data[at + 3] = 255;
    }
  }

  return { disagreements, compared };
}
