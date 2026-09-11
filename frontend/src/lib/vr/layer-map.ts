/**
 * Which layer drew a pixel, from the priority byte the PPU left behind.
 *
 * `pn_depth()` gives one byte per pixel: snes9x writes `D + priority` while it
 * composites, and that byte is the only record of which of the SNES's five
 * planes won each pixel. It is not, on its own, the name of a layer - the
 * priority a background is given depends on the BG mode, so the same byte is
 * BG1 in mode 1 and BG2 in mode 3. Hence the mode travels with the plane
 * (`pn_depth_bg_mode()`), and hence this module rather than a constant table.
 *
 * Naming the layer is what lets a depth setting be written down per game and
 * still mean something: "BG2 at 10 cm" survives a mode change and can be read
 * by a person, where "byte 42 at 10 cm" does neither.
 *
 * Every constant here is the DO_BG table in snes9x's `gfx.cpp`, plus the two
 * Mode 7 renderers in `tile.c` (BG1 at D+7, BG2 at D+11 or D+3).
 */

export const VR_LAYERS = ['backdrop', 'bg1', 'bg2', 'bg3', 'bg4', 'sprite'] as const;

export type VrLayer = (typeof VR_LAYERS)[number];

/**
 * A layer is not fine enough to place in space, because one layer can be in
 * two places at once.
 *
 * Each background is drawn at two priorities, high and low, and the SNES
 * composites them at very different points in the order: in mode 1 BG3 is at
 * 3 and 7 - behind almost everything - unless BG3Priority moves its high half
 * to 17, in front of everything. Super Mario All-Stars uses exactly that: its
 * clouds and its status bar are both BG3, and they must not end up at the same
 * distance. So the unit a distance is assigned to is the pair.
 *
 * Sprites keep their four hardware priorities collapsed into one slot. They
 * are actors on the same stage; splitting them buys nothing a person would
 * want to set by hand.
 */
export interface VrSlot {
	layer: VrLayer;
	/** False for the backdrop and for sprites, where the distinction is unused. */
	high: boolean;
}

/** Stable order, back to front in the PPU's own compositing terms. */
export const VR_SLOT_KEYS = [
	'backdrop',
	'bg4.lo',
	'bg4.hi',
	'bg3.lo',
	'bg3.hi',
	'bg2.lo',
	'bg2.hi',
	'bg1.lo',
	'bg1.hi',
	'sprite'
] as const;

export type VrSlotKey = (typeof VR_SLOT_KEYS)[number];

export function slotKey(slot: VrSlot): VrSlotKey {
	if (slot.layer === 'backdrop' || slot.layer === 'sprite') return slot.layer;
	return `${slot.layer}.${slot.high ? 'hi' : 'lo'}` as VrSlotKey;
}

/**
 * The priority a sprite is given: `D + 4 + 4 * priority`, for the four
 * hardware sprite priorities. Shared by every mode.
 */
const SPRITE_PRIORITIES = [4, 8, 12, 16];

/**
 * Per mode, the priorities each background is drawn at, high then low.
 *
 * Mode 1's BG3 has a third form: with BG3Priority set it moves from 7 to 17,
 * which is the trick games use to float a status bar over everything. It is
 * handled separately because the flag is not part of the mode.
 */
const BACKGROUNDS: Record<number, Partial<Record<VrLayer, number[]>>> = {
	0: { bg1: [15, 11], bg2: [14, 10], bg3: [7, 3], bg4: [6, 2] },
	1: { bg1: [15, 11], bg2: [14, 10], bg3: [7, 3] },
	2: { bg1: [15, 7], bg2: [11, 3] },
	3: { bg1: [15, 7], bg2: [11, 3] },
	4: { bg1: [15, 7], bg2: [11, 3] },
	5: { bg1: [15, 7], bg2: [11, 3] },
	6: { bg1: [15, 7] },
	7: { bg1: [7], bg2: [11, 3] }
};

/**
 * The base snes9x added to the priority.
 *
 * 32 on the main screen, always. On the subscreen it is `($2130 & 2) << 4`,
 * which is 32 or 0 - so a byte below 32 is a subscreen pixel from a frame
 * where that bit was clear, and its priorities start from zero. Games that
 * composite through colour maths are common enough that ignoring the low form
 * makes them read as one flat sheet.
 */
function baseOf(priority: number): number {
	return priority >= 32 ? 32 : 0;
}

/**
 * @param priority the byte from `pn_depth()`
 * @param mode the BG mode the frame ended in, from `pn_depth_bg_mode()`
 * @param bg3Priority whether $2105 bit 3 was set, from `pn_depth_bg3_prio()`
 * @returns the layer, or null for a byte the PPU does not produce in this mode
 */
export function slotOf(priority: number, mode: number, bg3Priority: boolean): VrSlot | null {
	if (!Number.isInteger(priority) || priority < 0 || priority > 255) return null;

	// The backdrop renderer writes a literal 1 and never adds D, so it is the
	// one value that needs no mode and no base.
	if (priority === 1) return { layer: 'backdrop', high: false };

	const relative = priority - baseOf(priority);

	if (SPRITE_PRIORITIES.includes(relative)) return { layer: 'sprite', high: false };

	if (mode === 1 && bg3Priority && relative === 17) return { layer: 'bg3', high: true };

	const backgrounds = BACKGROUNDS[mode];
	if (!backgrounds) return null;

	for (const layer of VR_LAYERS) {
		const priorities = backgrounds[layer];
		if (!priorities) continue;
		const index = priorities.indexOf(relative);
		// The table lists high first, then low.
		if (index >= 0) return { layer, high: index === 0 && priorities.length > 1 };
	}
	return null;
}

/** The layer alone, for callers that do not care where in it the pixel sat. */
export function layerOf(priority: number, mode: number, bg3Priority: boolean): VrLayer | null {
	return slotOf(priority, mode, bg3Priority)?.layer ?? null;
}

/**
 * The same answer for all 256 bytes at once, as indices into `VR_LAYERS`.
 *
 * Built per frame and handed to the shader, so the per-pixel work stays on the
 * GPU: a 256-entry lookup is cheaper to upload than a remapped 57 KB plane is
 * to compute in JavaScript sixty times a second.
 *
 * A byte that names no layer is given the backdrop. That is the safe mistake -
 * the backdrop is the far plane, so an unexpected value produces a pixel that
 * did not move rather than one that jumps to the front.
 */
export function layerTable(mode: number, bg3Priority: boolean): Uint8Array {
	const backdrop = VR_LAYERS.indexOf('backdrop');
	const table = new Uint8Array(256).fill(backdrop);
	for (let byte = 0; byte < 256; byte++) {
		const layer = layerOf(byte, mode, bg3Priority);
		if (layer) table[byte] = VR_LAYERS.indexOf(layer);
	}
	return table;
}

/** The same, at the granularity a distance is actually assigned to. */
export function slotTable(mode: number, bg3Priority: boolean): Uint8Array {
	const backdrop = VR_SLOT_KEYS.indexOf('backdrop');
	const table = new Uint8Array(256).fill(backdrop);
	for (let byte = 0; byte < 256; byte++) {
		const slot = slotOf(byte, mode, bg3Priority);
		if (slot) table[byte] = VR_SLOT_KEYS.indexOf(slotKey(slot));
	}
	return table;
}
