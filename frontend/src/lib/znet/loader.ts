/**
 * Loads the deterministic core in the browser.
 *
 * The wasm is fetched at runtime from /psnes-core/ rather than bundled. It is
 * a build artefact of core/build.sh, and a checkout that has not run that
 * script yet should still be able to build and run the rest of the app - a
 * static import would turn a missing core into a broken `vite build`.
 */

import { PsnesCore, type PsnesCoreFactory } from './core.js';

const DEFAULT_MODULE_URL = '/psnes-core/psnes_core.mjs';
const DEFAULT_WASM_URL = '/psnes-core/psnes_core.wasm';

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
export async function loadCore(
	moduleUrl = DEFAULT_MODULE_URL,
	wasmUrl = DEFAULT_WASM_URL
): Promise<PsnesCore> {
	const factory = await loadFactory(moduleUrl);
	// The glue normally locates its wasm relative to its own URL. Ours is now a
	// blob:, which resolves nowhere, so the path is passed in explicitly.
	return PsnesCore.create(factory, { locateFile: () => wasmUrl });
}

export async function coreAvailable(url = DEFAULT_MODULE_URL): Promise<boolean> {
	try {
		await loadFactory(url);
		return true;
	} catch {
		return false;
	}
}
