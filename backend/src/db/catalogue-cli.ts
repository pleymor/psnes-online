/**
 * Applies `snes-metadata.json` to a running database, on purpose.
 *
 * Nothing does this at startup any more. The refresh used to run at every
 * backend start - every deploy - and it deleted the shipped catalogue and
 * reinserted it with a fresh id per row; `GameMetadataChecksum.metadataId` is
 * `ON DELETE CASCADE`, so every game identified against a shipped entry lost
 * its identification, and every cover a player had uploaded went with the
 * row. Production on 2026-09-10 held 65 games and two surviving links.
 *
 * So the step is a gesture now, not a side effect of restarting. Run it after
 * changing the catalogue file:
 *
 *   docker compose exec backend bun dist/db/catalogue-cli.js
 *
 * `syncCatalogue` matches on title and updates in place, so ids do not move,
 * links hold, and an uploaded cover is never overwritten. Only a title the
 * file has actually dropped is removed.
 */

import { getDb } from './sqlite.js';
import { countGameMetadata } from './game-metadata.js';
import { refreshGameMetadata } from '../services/metadata-loader.js';

try {
  const db = getDb();
  const before = countGameMetadata(db, 'catalogue');

  // The reading, the transaction and the cache reload all live in there, with
  // the guarantee this command exists for: a file that cannot be read or
  // parsed leaves the catalogue exactly as it was.
  const applied = process.argv[2]
    ? await refreshGameMetadata(process.argv[2])
    : await refreshGameMetadata();

  if (!applied) {
    console.error('The catalogue was not changed; see the log above for why.');
    process.exit(1);
  }

  console.log(`catalogue synced: ${before} -> ${countGameMetadata(db, 'catalogue')} shipped entries`);
  process.exit(0);
} catch (error) {
  // The same reasoning as the migration runner: a bare stack trace full of
  // dist/ paths does not say which of the container's commands failed.
  console.error('The catalogue sync failed:', error);
  process.exit(1);
}
