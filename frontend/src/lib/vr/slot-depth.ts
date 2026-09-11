/**
 * A preset turned into the one array the stack of planes can consume.
 *
 * This file used to carry its own table of distances and its own scale, which
 * made two answers to "how far forward is this slot" - this one and
 * `relief-preset.ts`. They were written in parallel and they agreed by luck;
 * the first per-game preset written through the panel would have ended that,
 * silently, with the panel showing one number and the picture standing at
 * another. `relief-preset.ts` won because it is the one with the ladders, the
 * per-game storage and the tests. Nothing here decides a distance any more.
 *
 * What is left is the conversion the renderer needs and the preset has no
 * business knowing: metres per slot KEY become metres per slot INDEX. Indexed
 * because that is what the stack reads - the mask holds `VR_SLOT_KEYS`
 * indices, so the plane drawing slot `i` takes entry `i` and there is no
 * lookup that can disagree with the one the shader is doing.
 *
 * Offsets toward the player from the screen surface, never distances from the
 * eye: the screen's own distance is the player's setting and can be anything
 * from 2 to 4 m, so a depth expressed from the eye would silently change the
 * relief every time somebody moved the screen. An offset survives that.
 */

import { VR_SLOT_KEYS } from './layer-map';
import { slotDistances, DEFAULT_RELIEF, type ReliefPreset } from './relief-preset';

/**
 * The preset's metres, one per slot index, spacing already applied.
 *
 * The clamp is the whole of the defensive work, and it stands in for three
 * failures that all end the same way. `readReliefPreset` refuses anything off
 * the ladder, so nothing here can go wrong via storage - but `setRelief` takes
 * an object, and an object can be built by hand.
 *
 * NaN is the one that must not get through: it reaches `mesh.position.z` and
 * takes the plane's whole world matrix with it, so the layer VANISHES, and an
 * invisible layer inside a headset looks like the game not drawing it, which
 * is a long way from a bad number in a preset. A negative depth is the other:
 * there is no rung below zero (`RELIEF_DISTANCES` starts there, and its header
 * says why), so a negative value can only come from a negative spacing, which
 * turns the whole stack inside out - sprites behind the backdrop.
 *
 * Both land on 0, which is the glass. That is the safe mistake, the same one
 * `layerTable` makes for a byte it does not recognise: a pixel that did not
 * move rather than one that jumped to the front or left the world.
 */
export function slotDepths(preset: ReliefPreset = DEFAULT_RELIEF): number[] {
	const metres = slotDistances(preset);
	return VR_SLOT_KEYS.map((key) => {
		const depth = metres[key];
		return Number.isFinite(depth) && depth > 0 ? depth : 0;
	});
}
