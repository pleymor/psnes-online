/**
 * How far out of the picture each SNES layer slot sits, remembered per game.
 *
 * `layer-map.ts` names the slots; this says where each one goes. The two are
 * separate because naming is a property of the hardware and distance is a
 * property of the game: Super Mario All-Stars wants its clouds a few
 * centimetres out and its status bar flat, and nothing derivable from the PPU
 * could have said so. Somebody has to look at the game and decide, which is
 * why this is a remembered preset and not a formula.
 *
 * Keyed on the ROM's crc32, not on `Game.id`. The VR shell always has a crc32
 * in hand - `launchFor` is one - and only sometimes has the database UUID,
 * which is null for library entries made before local ROMs. Keying on the UUID
 * would silently lose the setting for exactly the local dumps this is for. The
 * crc32 is validated against `^[0-9A-F]{8}$`, the same shape the backend keeps
 * in `saves/archive.ts`, and a value that is not that shape is REFUSED rather
 * than used: `roms/checksum.ts` upper-cases, so a lowercase key would be
 * written once and never read back, which looks to the player like the setting
 * not sticking.
 *
 * Stored on the device, like `screen-shape.ts` and `pad-map.ts` before it and
 * for the same reason: the relief that reads well depends on the headset's
 * optics and on how far the player sits from the screen, neither of which
 * follows an account to another machine.
 *
 * Rungs, not sliders. `screen-shape.ts` gives the argument in full: the
 * pointer is a laser held at arm's length, aiming at a button is decisive
 * where dragging a handle is not, and the ends of a ladder butt rather than
 * wrap. Wrapping matters more here than there, because a slot that jumped from
 * the front of the picture to the back plane on one press too many would look
 * like the layer had vanished behind the scenery.
 *
 * The storage discipline is `shader-preference.ts`, by way of the two VR
 * modules above: storage arrives as an argument so this is testable without a
 * browser, the default is removed rather than written, and anything this build
 * cannot read is removed rather than kept.
 */

import type { PreferenceStorage } from '$lib/stores/shader-preference';
import { VR_SLOT_KEYS, type VrSlotKey } from './layer-map';

export interface ReliefPreset {
	/**
	 * How much of the ladder to apply, as a multiplier on every slot at once.
	 *
	 * One knob for the strength of the whole effect, so a player who finds the
	 * relief too strong does not have to walk back down ten ladders to say so.
	 */
	spacing: number;
	/** Metres toward the viewer from the back plane, per slot. */
	slots: Partial<Record<VrSlotKey, number>>;
}

/**
 * The distances a slot may take, in metres in front of the back plane.
 *
 * Zero is the bottom and there is nothing below it. A negative distance would
 * put a layer behind the backdrop, which inverts the order the PPU itself
 * composited in: the sky would come out in front of the ground, and no setting
 * of the other nine slots could put it back.
 *
 * 30 cm is the top, and the ceiling is the occlusion holes rather than taste.
 * A layer is only drawn where it won the pixel, so everything in front of it
 * leaves a hole in it, and `tools/vr-relief` fills those holes by dilating the
 * layer into them because the frame does not record what was really behind.
 * The fill is a smear that stays hidden while the layer in front still covers
 * it. Past roughly 30 cm of separation it stops covering it as soon as the
 * player leans, and the smear is what they see through the gap.
 *
 * The rungs are finer near the bottom because that is where the effect is
 * decided: the first few centimetres are the difference between a flat picture
 * and a diorama, while the difference between 22 and 26 cm is a matter of
 * degree.
 */
export const RELIEF_DISTANCES: readonly number[] = [
	0, 0.02, 0.05, 0.08, 0.1, 0.13, 0.15, 0.18, 0.22, 0.26, 0.3
];

/**
 * The strengths, as a multiplier on every distance.
 *
 * Zero is a rung on purpose. It flattens the picture back to the 2D image, and
 * it is the only way to compare the relief against what the game actually
 * looks like without leaving the panel and relaunching. A player who thinks
 * the effect is doing nothing can settle it in one press.
 *
 * 1.5 is the top. The distance ladder's own ceiling is where the fill smears
 * start showing, and letting spacing multiply past that would reintroduce the
 * artefact through the back door.
 */
export const RELIEF_SPACINGS: readonly number[] = [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5];

/**
 * What the probe settled on, by hand, looking at a real frame.
 *
 * backdrop 0, BG3-low 5 cm, BG2-low 10 cm, BG1-low 15 cm and sprites 18 cm are
 * the numbers `tools/vr-relief` was left at. They are not a progression anyone
 * derived; they are where the diorama stopped looking like a stack of cards.
 *
 * Two of the ten are derived rather than measured, and both deserve saying.
 *
 * The high halves sit at the same distance as their low halves, because they
 * are the same tilemap. A background is drawn at two priorities so that some of
 * its tiles composite in front of the sprites and the rest behind them; the
 * pipe Mario walks behind and then in front of is one surface with two kinds of
 * tile on it. Splitting the two would tear that surface in half, and a tile
 * that changes priority would jump between the two distances.
 *
 * BG3-high is the exception, and it is the whole reason a distance is attached
 * to a slot rather than to a layer. With BG3Priority set, that half moves to
 * the front of the compositing order and is where games put their status bar.
 * A HUD belongs painted on the glass, so it is given zero. Giving it a distance
 * does two visible wrongs at once: it slides across the picture as the player
 * moves their head, and, being in front, it cuts a glyph-shaped hole in
 * everything behind it that opens as soon as the planes separate.
 *
 * The cost of that default is a game where BG3-high is scenery rather than a
 * HUD, which comes out one rung flatter than its own low half. That is a
 * one-rung tear against a HUD that would otherwise be unreadable in every game
 * that uses the trick, and the per-game preset is the escape hatch.
 *
 * BG4 only exists in mode 0, where it is the rearmost background of the four,
 * so it takes the rung between the backdrop and BG3.
 */
const DEFAULT_SLOTS: Record<VrSlotKey, number> = {
	backdrop: 0,
	'bg4.lo': 0.02,
	'bg4.hi': 0.02,
	'bg3.lo': 0.05,
	'bg3.hi': 0,
	'bg2.lo': 0.1,
	'bg2.hi': 0.1,
	'bg1.lo': 0.15,
	'bg1.hi': 0.15,
	sprite: 0.18
};

export const DEFAULT_RELIEF: ReliefPreset = {
	spacing: 1,
	slots: DEFAULT_SLOTS
};

export const RELIEF_PREFIX = 'psnes-vr-relief:';

/** The canonical form `roms/checksum.ts` produces, and the one the backend keeps. */
const CRC32 = /^[0-9A-F]{8}$/;

/** The storage key for this game, or null when the identity is not one we can key on. */
export function reliefKeyFor(crc32: string): string | null {
	if (typeof crc32 !== 'string' || !CRC32.test(crc32)) return null;
	return `${RELIEF_PREFIX}${crc32}`;
}

function isSlotKey(key: string): key is VrSlotKey {
	return (VR_SLOT_KEYS as readonly string[]).includes(key);
}

/** The index of the rung, or the default's index when the value is not one. */
function rung(ladder: readonly number[], value: number, fallback: number): number {
	const index = ladder.indexOf(value);
	return index === -1 ? ladder.indexOf(fallback) : index;
}

function stepped(ladder: readonly number[], value: number, fallback: number, by: 1 | -1): number {
	const next = rung(ladder, value, fallback) + by;
	// Butted, not wrapped. See the header.
	if (next < 0 || next >= ladder.length) return value;
	return ladder[next];
}

/** The distance this preset gives the slot, falling back to the default. */
function distanceOf(preset: ReliefPreset, slot: VrSlotKey): number {
	const value = preset.slots[slot];
	return typeof value === 'number' ? value : DEFAULT_SLOTS[slot];
}

export function stepSlot(preset: ReliefPreset, slot: VrSlotKey, by: 1 | -1): ReliefPreset {
	// A slot key this build does not know can only come from an imported preset.
	// Returning the preset untouched keeps it from being written back out.
	if (!isSlotKey(slot)) return preset;
	return {
		...preset,
		slots: {
			...preset.slots,
			[slot]: stepped(RELIEF_DISTANCES, distanceOf(preset, slot), DEFAULT_SLOTS[slot], by)
		}
	};
}

export function stepSpacing(preset: ReliefPreset, by: 1 | -1): ReliefPreset {
	return {
		...preset,
		spacing: stepped(RELIEF_SPACINGS, preset.spacing, DEFAULT_RELIEF.spacing, by)
	};
}

/** The rung each control sits on, for drawing the position dots and knowing which end is reached. */
export function reliefRungs(preset: ReliefPreset): {
	spacing: number;
	slots: Record<VrSlotKey, number>;
} {
	const slots = {} as Record<VrSlotKey, number>;
	for (const key of VR_SLOT_KEYS) {
		slots[key] = rung(RELIEF_DISTANCES, distanceOf(preset, key), DEFAULT_SLOTS[key]);
	}
	return {
		spacing: rung(RELIEF_SPACINGS, preset.spacing, DEFAULT_RELIEF.spacing),
		slots
	};
}

/**
 * The metres each slot is actually pushed out, spacing applied.
 *
 * The one place the multiplication happens, so the panel and the scene cannot
 * end up disagreeing about whether a number already has spacing in it.
 */
export function slotDistances(preset: ReliefPreset): Record<VrSlotKey, number> {
	const metres = {} as Record<VrSlotKey, number>;
	for (const key of VR_SLOT_KEYS) metres[key] = preset.spacing * distanceOf(preset, key);
	return metres;
}

/**
 * A preset out of anything, rebuilt field by field, or null when unreadable.
 *
 * Rebuilt rather than returned as parsed, like `readScreenShape` and
 * `readPadMap`: the parsed object can carry keys from a build that is not this
 * one, and a stray slot name reaching the shader would be an index into
 * nothing.
 *
 * A field that is simply absent is back-filled rather than fatal. That is the
 * older-preset case, and taking away the nine distances a player did choose
 * over one they never saw would be gratuitous.
 *
 * A field that is PRESENT and off the ladder is fatal for the whole preset. On
 * the ladder rather than merely in range, for `screen-shape.ts`'s reason: the
 * rungs are what the panel can draw and what `-`/`+` can walk, so an in-between
 * value is a state the player cannot step out of. And the whole preset rather
 * than that one slot, because a half-applied preset leaves the picture in a
 * shape nobody chose, with one layer where it was set and its neighbour
 * silently back at the default.
 */
function normalise(raw: unknown): ReliefPreset | null {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const source = raw as Record<string, unknown>;

	const spacing = 'spacing' in source ? source.spacing : DEFAULT_RELIEF.spacing;
	if (typeof spacing !== 'number' || !RELIEF_SPACINGS.includes(spacing)) return null;

	const stored = 'slots' in source ? source.slots : {};
	if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return null;

	const slots = {} as Record<VrSlotKey, number>;
	for (const [key, value] of Object.entries(stored as Record<string, unknown>)) {
		// A slot name this build does not know is dropped rather than fatal: it is
		// a preset from a build that splits the slots more finely, and the slots
		// this build does understand are still exactly what the player set.
		if (!isSlotKey(key)) continue;
		if (typeof value !== 'number' || !RELIEF_DISTANCES.includes(value)) return null;
		slots[key] = value;
	}
	for (const key of VR_SLOT_KEYS) {
		if (!(key in slots)) slots[key] = DEFAULT_SLOTS[key];
	}

	return { spacing, slots };
}

function isDefault(preset: ReliefPreset): boolean {
	if (preset.spacing !== DEFAULT_RELIEF.spacing) return false;
	return VR_SLOT_KEYS.every((key) => distanceOf(preset, key) === DEFAULT_SLOTS[key]);
}

/** The preset remembered for this game, or the default. */
export function readReliefPreset(storage: PreferenceStorage, crc32: string): ReliefPreset {
	const key = reliefKeyFor(crc32);
	if (!key) return DEFAULT_RELIEF;

	const stored = storage.getItem(key);
	if (!stored) return DEFAULT_RELIEF;

	let parsed: unknown;
	try {
		parsed = JSON.parse(stored);
	} catch {
		storage.removeItem(key);
		return DEFAULT_RELIEF;
	}

	const preset = normalise(parsed);
	if (!preset) {
		// Removed rather than kept, as `shader-preference.ts` decided: a value this
		// build cannot read would otherwise sit in the profile for ever, meaning
		// the default while looking like a choice that had been made.
		storage.removeItem(key);
		return DEFAULT_RELIEF;
	}
	return preset;
}

/** Remembers the preset for this game. Writing the default clears the entry. */
export function writeReliefPreset(
	storage: PreferenceStorage,
	crc32: string,
	preset: ReliefPreset
): void {
	const key = reliefKeyFor(crc32);
	if (!key) return;

	const clean = normalise(preset);
	if (!clean) return;
	if (isDefault(clean)) {
		storage.removeItem(key);
		return;
	}
	storage.setItem(key, JSON.stringify(clean));
}

/**
 * `PreferenceStorage`, plus the enumeration `localStorage` also offers.
 *
 * The same shape, and for the same reason, as the one in
 * `stores/latency-preference.ts`: a preference kept under one key per game
 * cannot be read back in bulk without walking the storage. Kept apart from
 * `PreferenceStorage` so the single-game readers stay testable against the
 * smaller shape.
 */
export interface EnumerableStorage extends PreferenceStorage {
	readonly length: number;
	key(index: number): string | null;
}

/** Every remembered preset, by crc32. Unreadable entries are skipped, not repaired. */
export function listReliefPresets(storage: EnumerableStorage): Record<string, ReliefPreset> {
	const table: Record<string, ReliefPreset> = {};
	for (let index = 0; index < storage.length; index++) {
		const key = storage.key(index);
		if (!key || !key.startsWith(RELIEF_PREFIX)) continue;
		const crc32 = key.slice(RELIEF_PREFIX.length);
		if (!CRC32.test(crc32)) continue;

		const stored = storage.getItem(key);
		if (!stored) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(stored);
		} catch {
			// Skipped rather than removed: listing is a read, and walking the
			// storage would otherwise delete entries as a side effect of an export.
			continue;
		}
		const preset = normalise(parsed);
		if (preset) table[crc32] = preset;
	}
	return table;
}

/**
 * Replaces the whole remembered table with `table`.
 *
 * Replaces rather than merges, for the reason `replaceLatencyPreferences`
 * gives: an imported configuration is what the player chose to carry across,
 * and a leftover local entry for a game they also have here would mean the
 * import silently did not take effect for that one game.
 */
export function replaceReliefPresets(
	storage: EnumerableStorage,
	table: Record<string, ReliefPreset>
): void {
	const stale: string[] = [];
	for (let index = 0; index < storage.length; index++) {
		const key = storage.key(index);
		if (key && key.startsWith(RELIEF_PREFIX)) stale.push(key);
	}
	for (const key of stale) storage.removeItem(key);
	// An entry whose key is not a crc32 is dropped by `writeReliefPreset` alone,
	// so one bad line in an imported file does not cost the player the rest.
	for (const [crc32, preset] of Object.entries(table)) writeReliefPreset(storage, crc32, preset);
}
