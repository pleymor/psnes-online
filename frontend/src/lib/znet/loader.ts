/**
 * Loads the deterministic core in the browser.
 *
 * The wasm is fetched at runtime from /psnes-core/ rather than bundled. It is
 * a build artefact of core/build.sh, and a checkout that has not run that
 * script yet should still be able to build and run the rest of the app - a
 * static import would turn a missing core into a broken `vite build`.
 */

import { PsnesCore, type PsnesCoreFactory } from './core.js';

const CORE_DIR = '/psnes-core';

/**
 * Les noms fixes d'avant le hachage.
 *
 * Ils ne servent plus qu'au repli : un dépôt où `core/build.sh` n'a jamais
 * tourné n'a ni manifeste ni artefacts, et il vaut mieux qu'il échoue sur un
 * 404 qui se lit que sur une exception dans la résolution d'URL.
 *
 * Ne jamais y revenir comme chemin normal : c'est leur nom fixe qui a permis
 * à un cache de garder un wasm d'une build antérieure pendant que la glu, elle,
 * était fraîche - voir `importModule` juste en dessous pour l'autre moitié de
 * la même histoire.
 */
export const LEGACY_MODULE_URL = `${CORE_DIR}/psnes_core.mjs`;
export const LEGACY_WASM_URL = `${CORE_DIR}/psnes_core.wasm`;

/** Ce que `core/build.sh` écrit à côté des artefacts qu'il vient de hacher. */
export interface CoreManifest {
	module: string;
	wasm: string;
}

/**
 * Un simple nom de fichier, dans le dossier du cœur et nulle part ailleurs.
 *
 * Le manifeste vient du réseau : un nom qui remonte d'un cran ferait charger
 * n'importe quoi à sa place, avec les droits du cœur.
 */
function safeName(value: unknown): string | null {
	if (typeof value !== 'string' || value === '') return null;
	if (value.includes('/') || value.includes('\\') || value.includes('..')) return null;
	return value;
}

/**
 * Les deux URL à charger, d'après le manifeste — ou les noms fixes à défaut.
 *
 * Pure, donc testée : c'est la seule partie de ce fichier qui décide quelque
 * chose, le reste n'est que du réseau.
 */
export function coreUrls(manifest: unknown): { moduleUrl: string; wasmUrl: string } {
	const candidate = manifest as Partial<CoreManifest> | null | undefined;
	const moduleName = safeName(candidate?.module);
	const wasmName = safeName(candidate?.wasm);

	if (!moduleName || !wasmName) {
		return { moduleUrl: LEGACY_MODULE_URL, wasmUrl: LEGACY_WASM_URL };
	}
	return { moduleUrl: `${CORE_DIR}/${moduleName}`, wasmUrl: `${CORE_DIR}/${wasmName}` };
}

let cached: Promise<PsnesCoreFactory> | null = null;

/**
 * Fetches the glue as text and imports it through a blob URL.
 *
 * `import(url)` refuses to execute a module unless the *server* labels it with
 * a JavaScript MIME type, and nginx's mime.types has no entry for `.mjs`. That
 * cost a production outage of this mode, and fixing the server did not end it:
 * browsers and the service worker had already cached the mislabelled response,
 * so the wrong Content-Type outlived the deploy that corrected it.
 *
 * Reading the bytes ourselves and choosing the type here removes the whole
 * class of failure - the app no longer depends on how any server, proxy or
 * cache along the way happens to label the file.
 */
async function importModule(url: string): Promise<PsnesCoreFactory> {
	// `reload` skips the HTTP cache; a stale copy is what made this so hard to
	// clear in the first place.
	const response = await fetch(url, { cache: 'reload' });
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} fetching ${url}`);
	}

	const source = await response.text();
	const blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
	try {
		const mod = await import(/* @vite-ignore */ blobUrl);
		return (mod.default ?? mod) as PsnesCoreFactory;
	} finally {
		URL.revokeObjectURL(blobUrl);
	}
}

function loadFactory(url: string): Promise<PsnesCoreFactory> {
	if (!cached) {
		cached = importModule(url).catch((err) => {
			cached = null;
			throw new Error(`Could not load the netplay core from ${url}: ${err}`);
		});
	}
	return cached;
}

/**
 * Creates a fresh core instance. Each call gets its own wasm memory, so two
 * cores in one tab (useful for local sync debugging) never share state.
 */
/**
 * Le manifeste, ou rien s'il n'est pas là.
 *
 * `reload` parce que c'est le SEUL fichier du cœur dont le nom ne change
 * jamais : s'il se figeait dans un cache, il désignerait éternellement les
 * artefacts d'une build passée, et le hachage n'aurait servi à rien. Il pèse
 * quelques dizaines d'octets, contrairement aux trois mégaoctets qu'il nomme.
 */
async function fetchManifest(): Promise<unknown> {
	try {
		const response = await fetch(`${CORE_DIR}/manifest.json`, { cache: 'reload' });
		if (!response.ok) return null;
		return await response.json();
	} catch {
		// Un dépôt sans build, ou un réseau qui tombe : le repli sur les noms
		// fixes dira la vraie erreur, qui sera un 404 sur l'artefact lui-même.
		return null;
	}
}

export async function loadCore(overrides?: {
	moduleUrl?: string;
	wasmUrl?: string;
}): Promise<PsnesCore> {
	const resolved = coreUrls(await fetchManifest());
	const moduleUrl = overrides?.moduleUrl ?? resolved.moduleUrl;
	const wasmUrl = overrides?.wasmUrl ?? resolved.wasmUrl;

	const factory = await loadFactory(moduleUrl);
	// The glue normally locates its wasm relative to its own URL. Ours is now a
	// blob:, which resolves nowhere, so the path is passed in explicitly.
	return PsnesCore.create(factory, { locateFile: () => wasmUrl });
}

export async function coreAvailable(url?: string): Promise<boolean> {
	if (!url) url = coreUrls(await fetchManifest()).moduleUrl;
	try {
		await loadFactory(url);
		return true;
	} catch {
		return false;
	}
}
