/**
 * Fetches a libretro shader preset and its shader sources.
 *
 * Same repository and same pinned commit as the RetroArch path in
 * `frontend/src/lib/emulator/libs/options.ts`, on purpose: both renderers must
 * show the SAME shader, or the one setting would look different depending on
 * which mode you are playing in.
 *
 * What this does NOT do is reuse that file's `resolveShader`, which carries a
 * hardcoded table of special cases for the three xBRZ presets. A preset names
 * its own files, relative to itself, so ordinary URL resolution covers every
 * preset in the subset - including `shader1 = ../stock.glsl` - and needs no
 * table at all.
 *
 * All the networking for this feature lives here. Everything decidable from a
 * string lives in `preset.ts`, which is why that file has tests and this one
 * does not.
 */

import { parsePreset, resolveShaderUrl } from './preset.js';

/** Pinned to the same commit the RetroArch path uses. */
export const SHADER_BASE_URL =
	'https://cdn.jsdelivr.net/gh/libretro/glsl-shaders@468f67b6f6788e2719d1dd28dfb2c9b7c3db3cc7';

export interface LoadedPass {
	/** The full .glsl text, both stages, still carrying its COMPAT macros. */
	source: string;
	filterLinear: boolean;
	scale: number | null;
}

export interface LoadedPreset {
	passes: LoadedPass[];
}

export type LoadResult = { ok: true; preset: LoadedPreset } | { ok: false; reason: string };

/** `xbrz/6xbrz-linear` becomes the pinned URL of `xbrz/6xbrz-linear.glslp`. */
export function presetUrl(shaderId: string): string {
	return `${SHADER_BASE_URL}/${shaderId}.glslp`;
}

async function fetchText(url: string, fetchImpl: typeof fetch): Promise<string> {
	const res = await fetchImpl(url);
	if (!res.ok) throw new Error(`${res.status} fetching ${url}`);
	return res.text();
}

/**
 * Resolves a shader id into ready-to-compile sources.
 *
 * Failure is a returned reason, never a throw: the caller's job on failure is
 * to keep the 2D renderer, which is a normal outcome and not an error the
 * player needs to see as a crash.
 *
 * @param fetchImpl injectable so a caller can supply a cache or a stub
 */
export async function loadShaderPreset(
	shaderId: string,
	fetchImpl: typeof fetch = fetch
): Promise<LoadResult> {
	if (!shaderId) return { ok: false, reason: 'no shader selected' };

	const url = presetUrl(shaderId);

	let presetText: string;
	try {
		presetText = await fetchText(url, fetchImpl);
	} catch (err) {
		return { ok: false, reason: `could not fetch the preset: ${(err as Error).message}` };
	}

	const parsed = parsePreset(presetText);
	if (!parsed.ok) {
		// Name the directive. A preset we cannot honour is the xbrz-freescale
		// case, and the whole point of naming it is that the next person does
		// not have to bisect a black screen to find out why.
		return { ok: false, reason: `unsupported preset directive "${parsed.directive}": ${parsed.reason}` };
	}

	try {
		const passes = await Promise.all(
			parsed.preset.passes.map(async (pass): Promise<LoadedPass> => ({
				source: await fetchText(resolveShaderUrl(url, pass.shaderPath), fetchImpl),
				filterLinear: pass.filterLinear,
				scale: pass.scale
			}))
		);
		return { ok: true, preset: { passes } };
	} catch (err) {
		return { ok: false, reason: `could not fetch a shader: ${(err as Error).message}` };
	}
}
