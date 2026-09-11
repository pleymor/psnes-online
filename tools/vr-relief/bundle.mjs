/**
 * Bundles the probe page. three is pulled from the workspace, so the page has
 * no network dependency and no import map to keep in step.
 */

import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

await build({
	entryPoints: [path.join(HERE, 'page', 'demo.ts')],
	outfile: path.join(HERE, 'page', 'demo.js'),
	bundle: true,
	format: 'iife',
	target: 'chrome120',
	logLevel: 'info'
});
