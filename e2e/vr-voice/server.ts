/**
 * Le serveur du banc d'essai de la voix : le vrai relais, trois comptes, zéro base.
 *
 * Lancé par `vr-voice.config.ts` sous Bun. Il sert une page qui embarque le
 * vrai `voice-chat.ts` et branche le vrai `registerVrVoice` sur socket.io ;
 * seules les amitiés sont écrites à la main, parce qu'elles sont la donnée du
 * test et non ce qu'il éprouve : Alice et Bob sont amis, Carol ne l'est de
 * personne.
 */
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { Server } from 'socket.io';
import { registerVrVoice } from '../../backend/src/websocket/vr-voice';
import type { Room } from '../../backend/src/types/index';

const PORT = Number(process.env.E2E_VOICE_PORT || 4391);
const here = import.meta.dir;
const lib = resolve(here, '../../frontend/src/lib');

const built = await Bun.build({
  entrypoints: [resolve(here, 'harness.ts')],
  target: 'browser',
  define: {
    'import.meta.env.PROD': 'false',
    'import.meta.env.DEV': 'false',
    'process.env.NODE_ENV': '"production"'
  },
  plugins: [{
    name: 'lib-alias',
    setup(build) {
      // Les paquets npm que `polyfills.ts` importe, et non les substituts
      // intégrés de Bun, qui n'ont pas l'export par défaut que Vite fournit.
      build.onResolve({ filter: /^(process|buffer)$/ }, (args) => ({
        path: Bun.resolveSync(args.path === 'process' ? 'process/browser.js' : 'buffer/index.js', lib)
      }));
      build.onResolve({ filter: /^\$lib\// }, (args) => {
        const bare = resolve(lib, args.path.slice('$lib/'.length));
        for (const candidate of [bare, `${bare}.ts`, `${bare}/index.ts`]) {
          if (Bun.file(candidate).size > 0) return { path: candidate };
        }
        return { path: `${bare}.ts` };
      });
    }
  }]
});
if (!built.success) {
  console.error(built.logs);
  process.exit(1);
}
const bundle = await built.outputs[0].text();

const page = `<!doctype html><meta charset="utf-8"><title>voix VR</title>
<script>window.global = window;</script><script type="module" src="/harness.js"></script>`;

const friends: Record<string, string[]> = { alice: ['bob'], bob: ['alice'], carol: [] };
const rooms = new Map<string, Room>();
rooms.set('salon-ab', {
  id: 'salon-ab',
  hostId: 'alice',
  createdBy: 'alice',
  players: [
    { userId: 'alice', pseudo: 'Alice', port: 1, isReady: true, emulationReady: true, keyConfig: {} },
    { userId: 'bob', pseudo: 'Bob', port: 2, isReady: true, emulationReady: true, keyConfig: {} }
  ],
  status: 'playing'
} as unknown as Room);

const http = createServer((req, res) => {
  if (req.url?.startsWith('/harness.js')) {
    res.writeHead(200, { 'content-type': 'text/javascript' });
    res.end(bundle);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(page);
});

const io = new Server(http);
const voice = registerVrVoice(io, rooms, { friendIdsOf: (id) => new Set(friends[id] ?? []) });
io.on('connection', (socket) => {
  const id = String(socket.handshake.auth.userId ?? '');
  voice.attach(socket, { id, pseudo: id } as never);
});

http.listen(PORT, () => console.log(`vr voice harness on ${PORT}`));
