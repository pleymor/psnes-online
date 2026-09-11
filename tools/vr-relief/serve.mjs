/**
 * Serves the probe page and the captured frames.
 *
 * Over HTTP rather than file://, because a WebGL texture built from a file://
 * image taints the canvas and the upload throws.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.VR_RELIEF_PORT ?? 5275);

const TYPES = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.png': 'image/png'
};

/** `/generated/...` comes from the capture, everything else from `page/`. */
function resolve(url) {
	const requested = decodeURIComponent(url.split('?')[0]);
	const relative = requested === '/' ? '/index.html' : requested;
	const root = relative.startsWith('/generated/') ? HERE : path.join(HERE, 'page');
	const file = path.join(root, relative);
	return file.startsWith(HERE) ? file : null;
}

createServer(async (req, res) => {
	const file = resolve(req.url ?? '/');
	if (!file) {
		res.writeHead(403).end('forbidden');
		return;
	}
	try {
		const body = await readFile(file);
		res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
		res.end(body);
	} catch {
		res.writeHead(404).end('not found');
	}
}).listen(PORT, '0.0.0.0', () => {
	console.log(`relief probe on http://localhost:${PORT}`);
});
