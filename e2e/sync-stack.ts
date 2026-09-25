/**
 * Le backend de la suite `offline-sync.spec.ts` (#71), sans Docker.
 *
 * Le vrai serveur - `backend/src/index.ts`, ses routes, sa socket, sa session -
 * sur une base neuve migrée par le vrai migrateur, en mode `AUTH_MODE=dev`
 * pour que Playwright puisse ouvrir une session sans Google. Seul Redis vient
 * d'ailleurs : `offline-sync.config.ts` lance un `redis-server` à côté.
 *
 * Il sème une chose que le catalogue n'a pas : une fiche et une jaquette pour
 * la ROM fabriquée par le test, parce que ce que la suite doit montrer, c'est
 * une bibliothèque hors-ligne qui a encore ses titres et ses images.
 *
 * Lancé par `bun e2e/sync-stack.ts`. Tout ce qu'il écrit est sous
 * `e2e/.sync-stack/` (ignoré par git), refait à chaque lancement.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sramCounterRom } from './sram-counter-rom';
import { makePng } from './png-fixture';
import { crc32, normaliseRom } from '../frontend/src/lib/roms/checksum';

const root = resolve(import.meta.dirname, '.sync-stack');
rmSync(root, { recursive: true, force: true });
mkdirSync(join(root, 'covers'), { recursive: true });

const PORT = process.env.E2E_SYNC_API_PORT || '3107';
const REDIS_PORT = process.env.E2E_SYNC_REDIS_PORT || '6397';
const APP_PORT = process.env.E2E_SYNC_APP_PORT || '4176';

process.env.NODE_ENV = 'development';
process.env.PORT = PORT;
process.env.DATABASE_URL = `file:${join(root, 'e2e.db').replace(/\\/g, '/')}`;
process.env.REDIS_HOST = '127.0.0.1';
process.env.REDIS_PORT = REDIS_PORT;
process.env.AUTH_MODE = 'dev';
process.env.SESSION_SECRET = 'e2e-offline-sync-only-not-a-secret';
process.env.FRONTEND_URL = `http://localhost:${APP_PORT}`;
process.env.MAX_USERS = '100';

const { getDb } = await import('../backend/src/db/sqlite.js');
const { migrate } = await import('../backend/src/db/migrate.js');
const db = getDb();
migrate(db, resolve(import.meta.dirname, '../backend/migrations'));

// La fiche de la ROM du test, reliée par son checksum comme une contribution
// de la communauté : c'est ce que `/api/games` fusionne dans la ligne.
const CHECKSUM = crc32(normaliseRom(sramCounterRom()));
const COVER = '/covers/psnes-sram-counter.png';
writeFileSync(join(root, 'covers', 'psnes-sram-counter.png'), makePng(512, 358));
const now = Date.now();
db.query(`
  INSERT INTO "GameMetadata" (id, title, publisher, releaseDate, coverUrl, servedCoverUrl, crc32, source, createdAt, updatedAt)
  VALUES ('e2e-sram-counter', 'Compteur de démarrages', 'PSNES', '2026', ?, ?, ?, 'community', ?, ?)
`).run(COVER, COVER, CHECKSUM, now, now);
db.query(`INSERT INTO "GameMetadataChecksum" (crc32, metadataId) VALUES (?, 'e2e-sram-counter')`).run(CHECKSUM);

// `COVERS_DIR` est `process.cwd()/covers` : le serveur sert donc la jaquette
// semée ci-dessus sur `/covers/…`, comme nginx le fait en production.
process.chdir(root);
await import('../backend/src/index.ts');
