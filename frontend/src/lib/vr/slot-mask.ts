/**
 * The per-pixel slot plane the stacked screen is cut with, in a three-free
 * module.
 *
 * The core hands over one priority byte per pixel and `layer-map.ts` turns a
 * byte into a slot - a (layer, priority) pair. What the GPU needs is that
 * answer already applied: one byte per pixel holding the slot's index, so each
 * plane of the stack can keep the pixels it won and discard the rest. That
 * remapping is the whole of this module, and it is here rather than in
 * `screen.ts` because it is arithmetic over a buffer, which is exactly the kind
 * of thing there is no way to test once it is behind a `WebGLRenderer`.
 *
 * Two properties are easy to get wrong and expensive to get wrong, so they are
 * stated here and asserted in `core/test/vr-slot-mask.test.ts`:
 *
 * - The mask keeps the video buffer's STRIDE. The shader reads it with the
 *   same `texSize` as the picture, so a tightly packed mask would slide every
 *   row sideways against the frame it describes - which reads as the layers
 *   being smeared diagonally rather than as a mask being the wrong shape.
 * - The LUT is rebuilt only when the mode or BG3Priority changes. It is 256
 *   entries built from ten string comparisons each; per frame that is pure
 *   waste, and the mode changes a handful of times in a session.
 */

import { slotTable, VR_SLOT_KEYS } from './layer-map';

/**
 * What `PsnesCore.depthSurface()` returns, restated so this module needs no
 * import from `znet`. Structural typing makes the real one assignable.
 */
export interface DepthPlane {
	data: Uint8Array;
	width: number;
	height: number;
	stride: number;
	mode: number;
	bg3Priority: boolean;
}

export interface SlotMask {
	/** `stride * height` bytes, each one an index into `VR_SLOT_KEYS`. */
	data: Uint8Array;
	/**
	 * Which slots this frame actually contains, as a bit per slot index.
	 *
	 * The stack is ten planes and a frame is rarely more than five of them, so
	 * this is what lets the rest be skipped instead of drawn full-screen and
	 * discarded pixel by pixel.
	 */
	present: number;
}

export interface SlotMaskBuilder {
	/**
	 * The mask for one frame.
	 *
	 * The returned buffer is reused, so it is only valid until the next call -
	 * the same rule `depthSurface()` states about its own view, for the same
	 * reason: this runs sixty times a second and a fresh 114 KB buffer per
	 * frame is a GC pause, which in this app is audible.
	 */
	build(depth: DepthPlane): SlotMask;
	/**
	 * The current byte -> slot LUT.
	 *
	 * Exposed so a test can hold it across frames and see that it was not
	 * rebuilt. There is no other way to observe the caching from outside, and
	 * an uncached LUT is a regression nothing else would notice.
	 */
	table(): Uint8Array;
}

export function createSlotMaskBuilder(): SlotMaskBuilder {
	/** -1 is a mode the PPU never reports, so the first frame always builds. */
	let builtFor = { mode: -1, bg3Priority: false };
	let table: Uint8Array = new Uint8Array(256);
	let data = new Uint8Array(0);

	return {
		build(depth: DepthPlane): SlotMask {
			if (depth.mode !== builtFor.mode || depth.bg3Priority !== builtFor.bg3Priority) {
				table = slotTable(depth.mode, depth.bg3Priority);
				builtFor = { mode: depth.mode, bg3Priority: depth.bg3Priority };
			}

			const size = depth.stride * depth.height;
			if (data.length !== size) data = new Uint8Array(size);

			let present = 0;
			/*
			 * Only the picture is remapped, not the padded tail of each row.
			 *
			 * The shader samples the mask through the same `uMax` clamp as the
			 * picture, so nothing past `width` is ever read - and leaving it
			 * alone keeps `present` honest. Remapping the padding would light
			 * up planes for slots that are only in memory nobody can see, and
			 * the whole point of `present` is to not draw those.
			 */
			for (let y = 0; y < depth.height; y++) {
				const row = y * depth.stride;
				for (let x = 0; x < depth.width; x++) {
					const slot = table[depth.data[row + x]];
					data[row + x] = slot;
					present |= 1 << slot;
				}
			}

			return { data, present };
		},

		table: () => table
	};
}

/** Whether a slot index is in a `present` bitmask. */
export function hasSlot(present: number, slot: number): boolean {
	return (present & (1 << slot)) !== 0;
}

/** The slot count, so the stack and the mask cannot disagree about its size. */
export const SLOT_COUNT = VR_SLOT_KEYS.length;
