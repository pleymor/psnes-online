/**
 * A still frame for previewing shaders, generated rather than shipped.
 *
 * Two reasons it is not a game screenshot. The application tells its own users
 * they must own the games their ROMs come from, so embedding a frame of one as
 * an asset would contradict that. And a screenshot is a worse comparison than
 * this: what separates these shaders is how they treat hard diagonals, single
 * pixels and smooth ramps, so the pattern puts one of each side by side
 * instead of hoping a chosen frame happens to contain all three.
 *
 * Read the result at the size a preview shows it. The checkerboard is there to
 * be destroyed - a bilinear filter should turn it flat grey, and a
 * pixel-preserving one should keep it crisp. That difference is the point.
 */

import type { VideoSurface } from './core.js';

/** The SNES's usual progressive mode, which is what a preview should show. */
export const PREVIEW_WIDTH = 256;
export const PREVIEW_HEIGHT = 224;

function write(
	data: Uint8Array,
	stride: number,
	x: number,
	y: number,
	r: number,
	g: number,
	b: number
): void {
	const at = (y * stride + x) * 4;
	data[at] = r;
	data[at + 1] = g;
	data[at + 2] = b;
	data[at + 3] = 255;
}

/**
 * Builds the pattern.
 *
 * `stride` defaults to the width, which is all a preview needs; the emulator's
 * own surfaces are wider than their frame and the renderer handles either.
 */
export function previewSurface(stride: number = PREVIEW_WIDTH): VideoSurface {
	const width = PREVIEW_WIDTH;
	const height = PREVIEW_HEIGHT;
	const data = new Uint8Array(stride * height * 4);

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			// Four horizontal bands, each aimed at one thing a shader does.
			const band = Math.floor((y / height) * 4);

			if (band === 0) {
				// Hard diagonal edges: what an edge-reconstructing shader such as
				// xBRZ visibly rounds and a blur visibly softens.
				const above = x > y * 4;
				write(data, stride, x, y, above ? 240 : 30, above ? 180 : 40, above ? 60 : 90);
			} else if (band === 1) {
				// Single-pixel checkerboard: survives a nearest-neighbour scale,
				// collapses to flat grey under a linear one.
				const on = (x + y) % 2 === 0;
				const v = on ? 235 : 25;
				write(data, stride, x, y, v, v, v);
			} else if (band === 2) {
				// A smooth ramp, where banding and colour handling show up.
				const t = x / (width - 1);
				write(data, stride, x, y, Math.round(40 + t * 200), Math.round(90 - t * 40), 200);
			} else {
				// Sprite-like blocks with hard corners and one-pixel gaps, the
				// shape most SNES art actually is.
				const cell = 16;
				const inBlock = Math.floor(x / cell) % 2 === Math.floor(y / cell) % 2;
				const gap = x % cell === 0 || y % cell === 0;
				if (gap) write(data, stride, x, y, 10, 10, 15);
				else if (inBlock) write(data, stride, x, y, 90, 200, 150);
				else write(data, stride, x, y, 35, 45, 70);
			}
		}
	}

	return { data, width, height, stride };
}
