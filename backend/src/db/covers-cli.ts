/**
 * Converts every cover the catalogue points at into the two files we serve.
 *
 * Run on purpose, never at startup -- the same rule `refreshGameMetadata`
 * states and for the same reason: a catalogue that rewrites itself whenever a
 * container restarts is a catalogue nobody can build on. A warming pass reaches
 * out to 1415 third-party URLs, and doing that on every deploy would be both
 * rude and slow.
 *
 *   docker compose exec backend bun dist/db/covers-cli.js
 *   docker compose exec backend bun dist/db/covers-cli.js --rebuild
 *
 * `warm` is idempotent and resumable: a row already served is skipped, so an
 * interrupted pass is finished by running it again. `--rebuild` does the work
 * again for every row, which is how a codec change or a lost volume is
 * recovered from -- the files are derived, the catalogue URL and the uploaded
 * BLOB are the sources.
 *
 * Measured on 2026-09-13, on thirty real catalogue rows: 231 KB of PNG each
 * become 41 KB of WebP and a 7.9 KB thumbnail, 5.6x lighter.
 *
 * It takes a while. The pass is network-bound, not codec-bound -- 2.2 s a row
 * against 50 ms of encoding -- so the full catalogue is roughly fifty minutes,
 * one row at a time. That is deliberate: fetching 1415 files from someone
 * else's host in parallel is how a probe got itself rate-limited while this
 * was being measured. It is a gesture you run once, not something on a
 * deploy's critical path, and `--rebuild` aside it never needs running twice.
 */

import { getDb } from './sqlite.js';
import { warmCovers } from '../covers/warm.js';

const rebuild = process.argv.includes('--rebuild');

try {
  const report = await warmCovers(getDb(), {
    rebuild,
    onProgress: (done, total) => {
      // Every fiftieth row: enough to see it moving, few enough that the
      // container log stays readable afterwards.
      if (done % 50 === 0 || done === total) console.log(`  ${done}/${total}`);
    }
  });

  console.log(
    `covers ${rebuild ? 'rebuilt' : 'warmed'}: ` +
    `${report.ingested} ingested, ${report.skipped} already served, ` +
    `${report.nothing} with no cover, ${report.failed.length} failed`
  );

  // Named, not just counted: a failure here is almost always one title whose
  // file libretro renamed, and the name is what makes it fixable.
  for (const { title, reason } of report.failed) console.log(`  failed: ${title} - ${reason}`);

  process.exit(0);
} catch (error) {
  // As in the migration runner: a bare stack trace full of dist/ paths does not
  // say which of the container's commands failed.
  console.error('The cover warming failed:', error);
  process.exit(1);
}
