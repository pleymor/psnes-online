/**
 * A restricted reader for libretro's `.glslp` preset format.
 *
 * The app offers six shaders, and between them they use exactly five
 * directives. This reads those five and refuses everything else BY NAME.
 *
 * That refusal is the point of the module, not a safety afterthought.
 * `xbrz-freescale` was dropped from the app's shader list because its
 * viewport-relative scaling produced WebGL framebuffer errors - which the
 * player experienced as a black screen with no message. Naming the directive
 * we cannot honour turns that into a fallback plus an explanation.
 *
 * Pure by design: no DOM, no fetch, no globals. Everything here is decided
 * from a string, which is what makes it the only unit-testable part of the
 * WebGL path.
 */

/** The whole supported vocabulary. `shaderN` and friends match by prefix. */
export const SUPPORTED_DIRECTIVES: readonly string[] = [
	'shaders',
	'shader',
	'filter_linear',
	'scale_type',
	'scale'
];

export interface PresetPass {
	/** As written in the preset - relative to the preset's own URL. */
	shaderPath: string;
	/** GL_LINEAR when true, GL_NEAREST when false. Absent directive means false. */
	filterLinear: boolean;
	/**
	 * Multiplier on the input size for this pass's render target, or null when
	 * the preset gives none. The final pass ignores it: it draws to the canvas.
	 */
	scale: number | null;
}

export interface Preset {
	passes: PresetPass[];
}

export type PresetResult =
	| { ok: true; preset: Preset }
	| { ok: false; directive: string; reason: string };

/** Splits `filter_linear0` into `['filter_linear', 0]`; null when there is no index. */
function splitIndexed(key: string): { base: string; index: number } | null {
	const match = /^([a-z_]+?)(\d+)$/.exec(key);
	if (!match) return null;
	return { base: match[1], index: Number(match[2]) };
}

function unquote(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

/** RetroArch writes booleans as true/false and as 1/0; both appear in the wild. */
function readBool(value: string): boolean | null {
	if (value === 'true' || value === '1') return true;
	if (value === 'false' || value === '0') return false;
	return null;
}

function refuse(directive: string, reason: string): PresetResult {
	return { ok: false, directive, reason };
}

export function parsePreset(source: string): PresetResult {
	const entries = new Map<string, string>();

	for (const rawLine of source.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#') || line.startsWith('//')) continue;

		const eq = line.indexOf('=');
		if (eq === -1) {
			return refuse(line, 'not a key = value line');
		}
		entries.set(line.slice(0, eq).trim(), unquote(line.slice(eq + 1)));
	}

	const shadersRaw = entries.get('shaders');
	if (shadersRaw === undefined) {
		return refuse('shaders', 'the preset declares no pass count');
	}
	const passCount = Number(shadersRaw);
	if (!Number.isInteger(passCount) || passCount < 1) {
		return refuse('shaders', `pass count must be a positive integer, got "${shadersRaw}"`);
	}

	// Reject unknown or out-of-range directives before reading anything, so a
	// preset can never be half-honoured.
	for (const key of entries.keys()) {
		if (key === 'shaders') continue;

		const indexed = splitIndexed(key);
		if (!indexed || !SUPPORTED_DIRECTIVES.includes(indexed.base)) {
			return refuse(key, 'directive is outside the supported subset');
		}
		if (indexed.index >= passCount) {
			return refuse(key, `refers to pass ${indexed.index}, but the preset declares ${passCount}`);
		}
	}

	const passes: PresetPass[] = [];

	for (let i = 0; i < passCount; i++) {
		const shaderPath = entries.get(`shader${i}`);
		if (shaderPath === undefined || shaderPath === '') {
			return refuse(`shader${i}`, `pass ${i} has no shader file`);
		}

		let filterLinear = false;
		const filterRaw = entries.get(`filter_linear${i}`);
		if (filterRaw !== undefined) {
			const parsed = readBool(filterRaw);
			if (parsed === null) {
				return refuse(`filter_linear${i}`, `expected true or false, got "${filterRaw}"`);
			}
			filterLinear = parsed;
		}

		const scaleTypeRaw = entries.get(`scale_type${i}`);
		if (scaleTypeRaw !== undefined && scaleTypeRaw !== 'source') {
			return refuse(
				`scale_type${i}`,
				`only "source" is supported, got "${scaleTypeRaw}" - viewport and absolute scaling need a framebuffer policy this renderer does not have`
			);
		}

		let scale: number | null = null;
		const scaleRaw = entries.get(`scale${i}`);
		if (scaleRaw !== undefined) {
			const parsed = Number(scaleRaw);
			if (!Number.isFinite(parsed) || parsed <= 0) {
				return refuse(`scale${i}`, `expected a positive number, got "${scaleRaw}"`);
			}
			scale = parsed;
		}

		passes.push({ shaderPath, filterLinear, scale });
	}

	return { ok: true, preset: { passes } };
}

/**
 * Resolves a preset's shader path against the preset's own URL.
 *
 * Presets name their files relatively - `shaders/6xbrz.glsl`, and
 * `../stock.glsl` for a second pass that lives one level up. Plain URL
 * resolution handles both, which is why this needs no table of special cases.
 */
export function resolveShaderUrl(presetUrl: string, shaderPath: string): string {
	return new URL(shaderPath, presetUrl).toString();
}
