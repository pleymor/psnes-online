/**
 * Captures a few frames of a real game, with the layer plane behind each one.
 *
 * Everything the page shows comes from here, so that what is being judged is a
 * frame the emulator actually produced rather than a picture of one. Output
 * goes to `generated/`, which is not committed: it is reproducible in a minute
 * from any ROM.
 *
 * The input sequence is a blunt instrument - it mashes START and A for a while
 * to get through whatever menus the cartridge opens with, then runs right. It
 * is tuned for Super Mario All-Stars and is not expected to reach gameplay in
 * every game; when it does not, the page still works and simply shows menus.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeCore, findTestRom, coreIsBuilt } from '../../core/test/helpers.js';
import { slotTable, VR_SLOT_KEYS } from '../../frontend/src/lib/vr/layer-map.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'generated');

const START = 1 << 3;
const A = 1 << 8;
const B = 1 << 0;
const RIGHT = 1 << 7;

/* ------------------------------------------------------------------- PNG */

function crc32(buf: Uint8Array): number {
	let c = ~0;
	for (const b of buf) {
		c ^= b;
		for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
	}
	return ~c >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
	const out = new Uint8Array(12 + data.length);
	const view = new DataView(out.buffer);
	view.setUint32(0, data.length);
	for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
	out.set(data, 8);
	view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
	return out;
}

/** Straight RGBA8, filter 0 on every row. Small, and no dependency. */
function png(rgba: Uint8Array, width: number, height: number): Buffer {
	const raw = new Uint8Array(height * (1 + width * 4));
	for (let y = 0; y < height; y++) {
		raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (1 + width * 4) + 1);
	}
	const ihdr = new Uint8Array(13);
	const view = new DataView(ihdr.buffer);
	view.setUint32(0, width);
	view.setUint32(4, height);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // colour type: RGBA
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('IDAT', new Uint8Array(deflateSync(raw))),
		chunk('IEND', new Uint8Array(0))
	]);
}

function hsl(h: number, s: number, l: number): [number, number, number] {
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
	const m = l - c / 2;
	const [r, g, b] =
		h < 60 ? [c, x, 0]
		: h < 120 ? [x, c, 0]
		: h < 180 ? [0, c, x]
		: h < 240 ? [0, x, c]
		: h < 300 ? [x, 0, c]
		: [c, 0, x];
	return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/* ------------------------------------------------------------- the filling */

/**
 * Grows one layer into the pixels it does not own.
 *
 * Repeatedly, every empty pixel with a filled neighbour takes its colour. The
 * result is what stands in for the scenery the PPU never drew, and its quality
 * is the quality of that guess: fine on a tiled background, a smear where the
 * layer had a sharp edge against a hole.
 *
 * It runs here rather than on the GPU because the page shows still frames. A
 * real-time version is a different problem and is not solved by this function.
 */
function grow(picture: Uint8Array, slots: Uint8Array, slot: number, width: number, height: number) {
	const filled = new Uint8Array(width * height * 4);
	let known = new Uint8Array(width * height);

	for (let i = 0; i < slots.length; i++) {
		if (slots[i] !== slot) continue;
		known[i] = 1;
		filled.set(picture.subarray(i * 4, i * 4 + 4), i * 4);
	}

	const NEIGHBOURS = [
		[-1, 0],
		[1, 0],
		[0, -1],
		[0, 1]
	];

	for (let pass = 0; pass < 96; pass++) {
		let grew = false;
		const next = known.slice();
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				const i = y * width + x;
				if (known[i]) continue;
				for (const [dx, dy] of NEIGHBOURS) {
					const nx = x + dx;
					const ny = y + dy;
					if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
					const j = ny * width + nx;
					if (!known[j]) continue;
					filled.set(filled.subarray(j * 4, j * 4 + 4), i * 4);
					next[i] = 1;
					grew = true;
					break;
				}
			}
		}
		known = next;
		if (!grew) break;
	}

	return filled;
}

/* -------------------------------------------------------------------- run */

if (!coreIsBuilt()) {
	console.error('the wasm core is not built - run `bun run core:build` first');
	process.exit(1);
}

const rom = findTestRom();
if (!rom) {
	console.error(
		'no ROM found. Put one in core/test/roms/ or backend/roms/, or set PSNES_TEST_ROM.'
	);
	process.exit(1);
}

mkdirSync(OUT, { recursive: true });
console.log(`rom: ${rom.name}`);

const core = await makeCore();
core.loadRom(rom.data);
// The depth entry points are not on PsnesCore: this is a probe, and putting
// them there would be designing the feature from the tool.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mod = (core as any).module;

const manifest: unknown[] = [];

function capture(tag: string) {
	const width = mod._pn_video_width();
	const height = mod._pn_video_height();
	const stride = mod._pn_video_stride();
	const heap: Uint8Array = mod.HEAPU8;
	const picture = mod._pn_video();
	const depth = mod._pn_depth();

	const mode = mod._pn_depth_bg_mode();
	const bg3Priority = mod._pn_depth_bg3_prio() === 1;
	// The mode is what gives a priority byte its meaning, and it is known here
	// and nowhere downstream - so the page is handed layers, not priorities.
	const table = slotTable(mode, bg3Priority);

	const pic = new Uint8Array(width * height * 4);
	const slots = new Uint8Array(width * height);
	for (let y = 0; y < height; y++) {
		pic.set(
			heap.subarray(picture + y * stride * 4, picture + y * stride * 4 + width * 4),
			y * width * 4
		);
		for (let x = 0; x < width; x++) {
			slots[y * width + x] = table[heap[depth + y * stride + x]];
		}
	}

	const counts = new Map<number, number>();
	for (const s of slots) counts.set(s, (counts.get(s) ?? 0) + 1);
	const present = [...counts.keys()].sort((a, b) => a - b);

	console.log(`\n${tag}  ${width}x${height}  mode ${mode}${bg3Priority ? ' + BG3Priority' : ''}`);
	for (const slot of present) {
		const share = ((counts.get(slot)! / (width * height)) * 100).toFixed(1);
		console.log(`  ${VR_SLOT_KEYS[slot].padEnd(10)} ${share.padStart(5)}%`);
	}

	writeFileSync(path.join(OUT, `${tag}-picture.png`), png(pic, width, height));

	// The mask the shader samples: one slot index per pixel, in the red channel.
	const zpic = new Uint8Array(width * height * 4);
	for (let i = 0; i < slots.length; i++) {
		zpic[i * 4] = zpic[i * 4 + 1] = zpic[i * 4 + 2] = slots[i];
		zpic[i * 4 + 3] = 255;
	}
	writeFileSync(path.join(OUT, `${tag}-z.png`), png(zpic, width, height));

	// The same, for a human: one fixed hue per slot, stable across frames.
	const dpic = new Uint8Array(width * height * 4);
	for (let i = 0; i < slots.length; i++) {
		const [r, g, b] = hsl((slots[i] / VR_SLOT_KEYS.length) * 320, 0.8, 0.55);
		dpic[i * 4] = r;
		dpic[i * 4 + 1] = g;
		dpic[i * 4 + 2] = b;
		dpic[i * 4 + 3] = 255;
	}
	writeFileSync(path.join(OUT, `${tag}-slots.png`), png(dpic, width, height));

	for (const slot of present) {
		writeFileSync(
			path.join(OUT, `${tag}-filled-${VR_SLOT_KEYS[slot]}.png`),
			png(grow(pic, slots, slot, width, height), width, height)
		);
	}

	manifest.push({
		name: tag,
		mode,
		bg3Priority,
		// The index matters as much as the name: it is the value baked into
		// every pixel of the mask, and the shader compares against it.
		slots: present.map((slot) => ({ key: VR_SLOT_KEYS[slot], index: slot }))
	});
}

let frame = 0;
function advance(count: number, pad: (f: number) => number) {
	for (let i = 0; i < count; i++) core.runFrame(pad(frame++), 0);
}

const mash = (f: number) => {
	const phase = f % 60;
	if (phase < 6) return START;
	if (phase >= 30 && phase < 36) return A;
	return 0;
};

advance(400, () => 0);
advance(2400, mash);
advance(400, (f) => (f % 40 < 20 ? B | RIGHT : RIGHT));
capture('frame-1');
advance(200, (f) => (f % 40 < 20 ? B | RIGHT : RIGHT));
capture('frame-2');
advance(200, (f) => (f % 90 < 8 ? A | RIGHT : RIGHT));
capture('frame-3');

writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`\nwritten to ${path.relative(process.cwd(), OUT)}`);
