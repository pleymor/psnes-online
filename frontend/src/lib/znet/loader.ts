/**
 * Loads the deterministic core in the browser.
 *
 * The wasm is fetched at runtime from /psnes-core/ rather than bundled. It is
 * a build artefact of core/build.sh, and a checkout that has not run that
 * script yet should still be able to build and run the rest of the app - a
 * static import would turn a missing core into a broken `vite build`.
 */

import { PsnesCore, type PsnesCoreFactory } from './core.js';

const DEFAULT_URL = '/psnes-core/psnes_core.mjs';

let cached: Promise<PsnesCoreFactory> | null = null;

function loadFactory(url: string): Promise<PsnesCoreFactory> {
	if (!cached) {
		cached = import(/* @vite-ignore */ url)
			.then((mod) => (mod.default ?? mod) as PsnesCoreFactory)
			.catch((err) => {
				cached = null;
				throw new Error(
					`Could not load the netplay core from ${url}. Run ./core/build.sh to build it. (${err})`
				);
			});
	}
	return cached;
}

/**
 * Creates a fresh core instance. Each call gets its own wasm memory, so two
 * cores in one tab (useful for local sync debugging) never share state.
 */
export async function loadCore(url = DEFAULT_URL): Promise<PsnesCore> {
	const factory = await loadFactory(url);
	return PsnesCore.create(factory);
}

export async function coreAvailable(url = DEFAULT_URL): Promise<boolean> {
	try {
		await loadFactory(url);
		return true;
	} catch {
		return false;
	}
}
