/**
 * Un faux backend pour regarder les fonds de la bibliothèque, et rien d'autre.
 *
 * Le vrai serveur demande Redis ; pour juger d'un papier peint il suffit de ce
 * que la bibliothèque lit au montage : qui est connecté, ses jeux, ses
 * salons, ses amis, et une socket qui se tait. Les jeux sont inventés et
 * leurs jaquettes dessinées ici même, en SVG : aucune image d'un vrai jeu.
 *
 * `crc32: null` sur chaque jeu, et c'est ce qui les montre tous :
 * `deviceLibrary` garde toujours une entrée sans checksum, faute de pouvoir
 * dire qu'elle n'est pas sur l'appareil.
 *
 * Lancé par `node tools/bg-preview/mock-backend.mjs`, sur le port 3000 - celui
 * que `api/socket.ts` vise en dev, quoi que dise le proxy de Vite. Puis, dans
 * `frontend/`, `vite dev --port 5190`, et `http://localhost:5190/?bg=a` :
 * le sélecteur en bas à droite passe d'un fond à l'autre.
 */

import http from 'node:http';
import { Server } from 'socket.io';

const PORT = Number(process.env.PORT || 3000);

const GAMES = [
  ['Galaxie Turbo', '#1b1f5e', '#f8d030', 'Action'],
  ['Donjon des Brumes', '#3b2a4d', '#b9e0ff', 'RPG'],
  ['Kart Cosmique', '#c42f1c', '#ffffff', 'Course'],
  ['Ninja Pixel', '#101018', '#e85a44', 'Action'],
  ['Super Taupe', '#2f8420', '#f7efd2', 'Plateforme'],
  ['Rallye Lunaire', '#5647cb', '#ffd6f0', 'Course'],
  ['Tennis 16', '#e8a33c', '#1d1d1d', 'Sport'],
  ['Les Dinos Farceurs', '#1e7a6e', '#ffe28a', 'Plateforme'],
  ['Chevalier de Fer', '#6b5b3c', '#f7efd2', 'RPG'],
  ['Pirates du Ciel', '#1d4a86', '#ffffff', 'Aventure'],
  ['Robo Boxe', '#7a1c10', '#f8d030', 'Combat'],
  ['Mystère Maya', '#0e5a3a', '#f8d030', 'Aventure'],
  ['Hockey Glacial', '#dfefff', '#1d4a86', 'Sport'],
  ['Puzzle Planète', '#8f3fa8', '#ffffff', 'Réflexion']
].map(([title, bg, fg, genre], i) => {
  const id = `demo-${i + 1}`;
  return {
    id,
    title,
    filename: `${id}.sfc`,
    coverUrl: `/covers/${id}.svg`,
    uploadedAt: new Date(2026, 0, i + 1).toISOString(),
    saves: [],
    crc32: null,
    genre,
    publisher: 'Studio Imaginaire',
    releaseDate: String(1991 + (i % 6)),
    players: i % 3 === 0 ? '1-2' : '1',
    _art: { bg, fg }
  };
});

function escape(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

/** Une boîte PAL couchée, 10/7 : un bandeau, un titre, une forme. */
function cover({ title, _art: { bg, fg } }, i) {
  const shapes = [
    `<circle cx="250" cy="210" r="70" fill="${fg}" opacity=".85"/>`,
    `<polygon points="250,120 330,290 170,290" fill="${fg}" opacity=".85"/>`,
    `<rect x="185" y="140" width="130" height="130" rx="18" fill="${fg}" opacity=".85"/>`,
    `<path d="M150 280 Q250 90 350 280Z" fill="${fg}" opacity=".85"/>`
  ];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 350">
  <rect width="500" height="350" fill="${bg}"/>
  <rect width="500" height="44" fill="#000" opacity=".35"/>
  <text x="18" y="30" font-family="Arial Black,Arial" font-weight="900" font-size="20" fill="#fff" opacity=".8">PSNES · DÉMO</text>
  ${shapes[i % shapes.length]}
  <text x="250" y="330" text-anchor="middle" font-family="Arial Black,Arial" font-weight="900" font-size="34" fill="${fg}" stroke="#000" stroke-width="1.5" paint-order="stroke">${escape(title)}</text>
</svg>`;
}

const ME = {
  id: 'demo-user',
  pseudo: 'Opérateur',
  discriminator: '0420',
  needsPseudo: false,
  isAnonymous: false
};

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;

  if (path === '/health') return send(res, 200, { ok: true });
  if (path === '/auth/me') return send(res, 200, ME);
  if (path === '/auth/mode') return send(res, 200, { mode: 'dev' });
  if (path === '/api/games') {
    return send(res, 200, GAMES.map(({ _art, ...game }) => game));
  }
  const coverMatch = path.match(/^\/covers\/(demo-\d+)\.svg$/);
  if (coverMatch) {
    const i = GAMES.findIndex((g) => g.id === coverMatch[1]);
    if (i >= 0) return send(res, 200, cover(GAMES[i], i), 'image/svg+xml');
  }
  if (path.startsWith('/api/')) {
    // Le reste - salons, amis, sauvegardes, journaux - est vide, et c'est ce
    // qu'un compte neuf verrait. Un objet pour ce qui n'est pas une liste.
    const list = /\/(rooms|friends|requests|saves|invites|notices)$/.test(path);
    return send(res, 200, req.method === 'GET' && list ? [] : {});
  }
  send(res, 404, { error: 'not found' });
});

const io = new Server(server, { cors: { origin: true, credentials: true } });
io.on('connection', (sock) => {
  sock.emit('rooms:list', []);
  sock.on('friends:getOnlineStatus', () => sock.emit('friends:online', []));
});

server.listen(PORT, () => console.log(`mock backend on http://localhost:${PORT}`));
