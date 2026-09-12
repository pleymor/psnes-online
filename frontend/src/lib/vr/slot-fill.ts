/**
 * Ce qu'il faut mettre dans les trous de chaque calque, en un seul atlas.
 *
 * LE PROBLÈME, redit en une phrase : chaque pixel de l'image appartient à UN
 * seul calque, donc le plan qui ne l'a pas gagné n'a rien à cet endroit. Tant
 * que les plans sont superposés, l'union les recouvre exactement et on ne voit
 * aucun trou. Dès que le relief les écarte, le plan qui glisse découvre
 * l'endroit qu'il occupait - et derrière, personne n'a jamais rien dessiné.
 *
 * `slot-memory.ts` fait l'arithmétique. Ce module-ci prend les décisions :
 * quels calques méritent une mémoire, où elles vivent, et quand on les jette.
 *
 * QUELS CALQUES. Les fonds seulement - jamais les sprites, jamais la toile de
 * fond. C'est la décision qui évite le pire contresens possible, et une mesure
 * la justifie : sur une image de jeu réelle, le plan des sprites ne possède
 * que 9 % de l'écran. Ses 91 % de « trou » ne sont pas un défaut, c'est sa
 * transparence - il n'y a pas de sprite là. Les combler peindrait un aplat
 * opaque en travers de l'image. Le plan de fond, lui, en possède 89 % et ses
 * 11 % de trou ont exactement la forme des sprites qui passent devant : ceux-là
 * sont le défaut, et ce sont les seuls.
 *
 * Cette règle tombe d'elle-même du recalage : un calque sans défilement n'a
 * rien à recaler. Les sprites bougent chacun pour soi, et la toile de fond est
 * un aplat. Il n'y a donc pas de seuil réglé à la main ici, et c'est voulu.
 *
 * ET CE QUI EST VRAIMENT TRANSPARENT RESTE TRANSPARENT, sans qu'on ait à le
 * distinguer : un pixel où le fond n'a jamais rien dessiné n'est gagné par lui
 * dans AUCUNE image, donc sa mémoire reste vierge et son alpha à zéro. Le
 * drapeau « déjà vu » fait le tri tout seul, ce que l'octet de priorité ne
 * permettrait pas - il confond « ce calque était caché » et « ce calque était
 * vide ».
 *
 * Sans three : l'atlas est un tableau d'octets, que `screen.ts` téléverse dans
 * une `DataArrayTexture`. Tout ce qui décide est donc vérifiable sous Bun.
 */

import { VR_SLOT_KEYS } from './layer-map';
import { SLOT_COUNT } from './slot-mask';
import {
  createMemory,
  forget,
  reproject,
  scrollDelta,
  stamp,
  trustworthy,
  type Memory
} from './slot-memory';

/**
 * Le fond dont ce calque tire son défilement, ou -1 s'il n'en a pas.
 *
 * L'index est celui de `PPU.BG[n]`, donc celui que `scrollSurface()` range par
 * paires. Les deux moitiés d'un fond - haute et basse priorité - partagent le
 * même défilement, ce qui est la définition même d'un fond : une seule surface
 * dessinée à deux priorités.
 */
export function backgroundOfSlot(slot: number): number {
  const key = VR_SLOT_KEYS[slot];
  if (!key) return -1;
  const match = /^bg([1-4])\./.exec(key);
  return match ? Number(match[1]) - 1 : -1;
}

export interface SlotFill {
  /** L'atlas, `width * height * 4` octets par couche, alpha = « déjà vu ». */
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  /** Combien de couches l'atlas porte réellement. */
  readonly layers: number;
  /** Par calque, sa couche dans l'atlas, ou -1 s'il n'en a pas. */
  readonly layerOf: Int8Array;
  /** Par calque, si sa mémoire a tenu sa promesse cette image. */
  readonly trusted: boolean[];
}

export interface SlotFiller {
  build(
    picture: Uint8Array | Uint8ClampedArray,
    mask: Uint8Array,
    present: number,
    width: number,
    height: number,
    stride: number,
    scroll: Uint16Array
  ): SlotFill;
  /** Tout oublier : un changement de jeu, une reprise de sauvegarde. */
  reset(): void;
}

export function createSlotFiller(): SlotFiller {
  let atlas = new Uint8ClampedArray(0);
  let memories: (Memory | null)[] = new Array(SLOT_COUNT).fill(null);
  const layerOf = new Int8Array(SLOT_COUNT).fill(-1);
  const trusted: boolean[] = new Array(SLOT_COUNT).fill(false);
  /** Le défilement de l'image précédente, pour savoir de combien recaler. */
  let previous: Uint16Array | null = null;
  let shape = '';

  function reset(): void {
    atlas = new Uint8ClampedArray(0);
    memories = new Array(SLOT_COUNT).fill(null);
    layerOf.fill(-1);
    trusted.fill(false);
    previous = null;
    shape = '';
  }

  /**
   * (Re)construit l'atlas pour cet ensemble de calques et cette forme.
   *
   * Rare par construction : la forme change à un changement de mode, et
   * l'ensemble des calques présents à un changement de scène. Jamais à une
   * image ordinaire, ce qui est ce qui rend acceptable de tout réallouer ici.
   */
  function reshape(present: number, width: number, height: number): void {
    const wanted: number[] = [];
    for (let slot = 0; slot < SLOT_COUNT; slot++) {
      if (present & (1 << slot) && backgroundOfSlot(slot) >= 0) wanted.push(slot);
    }
    const key = `${width}x${height}:${wanted.join(',')}`;
    if (key === shape) return;
    shape = key;

    const plane = width * height * 4;
    atlas = new Uint8ClampedArray(plane * Math.max(1, wanted.length));
    layerOf.fill(-1);
    memories = new Array(SLOT_COUNT).fill(null);
    wanted.forEach((slot, layer) => {
      layerOf[slot] = layer;
      memories[slot] = createMemory(width, height, atlas.subarray(layer * plane, (layer + 1) * plane));
    });
    /*
     * Le défilement précédent est oublié AVEC la forme.
     *
     * Une mémoire vierge n'a rien à recaler, et garder l'ancien défilement
     * ferait appliquer à la première image un décalage hérité de la scène
     * d'avant - un décalage juste pour une mémoire qui n'existe plus.
     */
    previous = null;
  }

  return {
    reset,
    build(picture, mask, present, width, height, stride, scroll): SlotFill {
      reshape(present, width, height);
      trusted.fill(false);

      for (let slot = 0; slot < SLOT_COUNT; slot++) {
        const memory = memories[slot];
        if (!memory) continue;
        const bg = backgroundOfSlot(slot);

        if (previous) {
          /*
           * Le tour à 1024 se démêle AVANT la soustraction, sur chaque axe.
           *
           * `scrollDelta` rend le chemin le plus court, et `shiftFor` prendrait
           * l'opposé - mais il travaille sur des valeurs brutes, donc un
           * passage de 1023 à 0 lui ferait voir mille pixels. On lui donne donc
           * un défilement déjà démêlé, exprimé relativement au précédent.
           */
          const dh = scrollDelta(previous[bg * 2], scroll[bg * 2]);
          const dv = scrollDelta(previous[bg * 2 + 1], scroll[bg * 2 + 1]);
          reproject(memory, -dh, -dv);
        }

        const verdict = stamp(memory, picture, mask, slot, stride);
        /*
         * Un calque qui n'a RIEN gagné cette image ne se juge pas.
         *
         * `trustworthy` répond non quand il n'y a rien à comparer, et c'est la
         * bonne réponse à « peut-on vérifier ? » - mais pas à « faut-il
         * jeter ? ». Un calque entièrement caché pendant quelques images est
         * exactement le cas où sa mémoire sert le plus ; la jeter pour n'avoir
         * pas pu la vérifier reviendrait à n'avoir jamais de mémoire.
         */
        if (verdict.compared === 0) {
          trusted[slot] = true;
          continue;
        }
        trusted[slot] = trustworthy(verdict.disagreements, verdict.compared);
        if (!trusted[slot]) {
          forget(memory);
          // Réappris tout de suite : les pixels de CETTE image sont justes par
          // définition, et repartir totalement vierge ferait clignoter le
          // remplissage une image sur deux quand le verdict hésite.
          stamp(memory, picture, mask, slot, stride);
        }
      }

      previous = previous ?? new Uint16Array(8);
      previous.set(scroll.subarray(0, 8));

      return {
        data: atlas,
        width,
        height,
        layers: Math.max(1, atlas.length / Math.max(1, width * height * 4)),
        layerOf,
        trusted: trusted.slice()
      };
    }
  };
}
