/**
 * Quel signe de recalage colle à la réalité ?
 *
 * Ce dépôt s'est trompé cinq fois sur un signe en devinant au lieu de mesurer,
 * et `slot-memory.ts` en porte la trace dans ses commentaires. Voici la mesure,
 * pour que la sixième fois soit réglée en dix minutes plutôt qu'en trois
 * allers-retours avec le casque.
 *
 * Le cœur est le juge et il n'a pas d'opinion : on compare ce que la mémoire
 * PRÉVOYAIT à ce que le calque vient de dessiner. Le bon signe minimise le
 * désaccord. Il n'est pas nécessaire d'atteindre une partie jouée - il suffit
 * d'images où le défilement change, et un menu animé en fournit.
 *
 *     PSNES_TEST_ROM=<une ROM> bun run tools/vr-relief/scroll-sign.ts
 *
 * Sur Kirby Super Deluxe, 366 images où ça bouge :
 *
 *     opposé du défilement (retenu)   désaccord 13,81 %
 *     sens du défilement              désaccord 19,31 %
 *     aucun recalage                  désaccord 18,94 %
 *
 * Le mauvais signe fait PIRE que ne rien faire, et c'est sa signature : il
 * déplace la mémoire du double de l'erreur au lieu de l'annuler. Un écart aussi
 * net ne demande pas d'interprétation.
 */
import { makeCore, findTestRom } from '../../core/test/helpers.js';
import { createSlotMaskBuilder, SLOT_COUNT } from '../../frontend/src/lib/vr/slot-mask.js';
import {
	createMemory,
	reproject,
	stamp,
	scrollDelta
} from '../../frontend/src/lib/vr/slot-memory.js';
import { backgroundOfSlot } from '../../frontend/src/lib/vr/slot-fill.js';

const START = 1 << 3;
const A = 1 << 8;
const B = 1 << 0;
const RIGHT = 1 << 7;
const DOWN = 1 << 5;
const core = await makeCore();
core.loadRom(findTestRom()!.data);

const builder = createSlotMaskBuilder();
const VARIANTS = [
  { name: 'opposé du défilement (retenu)', k: -1 },
  { name: 'sens du défilement', k: +1 },
  { name: 'aucun recalage', k: 0 }
];
const memories = VARIANTS.map(() => new Map<number, ReturnType<typeof createMemory>>());
const tally = VARIANTS.map(() => ({ d: 0, c: 0 }));
let previous: Uint16Array | null = null;
let scrolling = 0;

for (let f = 0; f < 6000; f++) {
  let pad = 0;
  if (f < 900) pad = f % 24 < 12 ? START : A;
  else pad = RIGHT | B | (f % 56 < 5 ? A : 0) | (f % 90 < 8 ? DOWN : 0);
  core.runFrame(pad, 0);
  const video = core.videoSurface();
  const mask = builder.build(core.depthSurface());
  const scroll = core.scrollSurface();
  const moved = previous && Array.from(scroll).some((v, i) => v !== previous![i]);

  for (let v = 0; v < VARIANTS.length; v++) {
    for (let slot = 0; slot < SLOT_COUNT; slot++) {
      const bg = backgroundOfSlot(slot);
      if (bg < 0 || !(mask.present & (1 << slot))) continue;
      let memory = memories[v].get(slot);
      if (!memory) { memory = createMemory(video.width, video.height); memories[v].set(slot, memory); }
      if (previous) {
        const dh = scrollDelta(previous[bg * 2], scroll[bg * 2]);
        const dv = scrollDelta(previous[bg * 2 + 1], scroll[bg * 2 + 1]);
        reproject(memory, VARIANTS[v].k * dh, VARIANTS[v].k * dv);
      }
      const verdict = stamp(memory, video.data, mask.data, slot, video.stride);
      // Seules les images où ça BOUGE départagent les signes : à l_arrêt, les
      // trois variantes font rigoureusement la même chose.
      if (moved) { tally[v].d += verdict.disagreements; tally[v].c += verdict.compared; }
    }
  }
  if (moved) scrolling++;
  previous = scroll.slice();
}

console.log(`images où un défilement change : ${scrolling}`);
for (let v = 0; v < VARIANTS.length; v++) {
  const { d, c } = tally[v];
  console.log(`  ${VARIANTS[v].name.padEnd(32)} désaccord ${(100 * d / c).toFixed(2)}% sur ${c} pixels`);
}
