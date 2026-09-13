/**
 * One pass over the catalogue, turning remote covers into local files.
 *
 * The decisions live in `task.ts` and `ingest.ts`; this is the loop that walks
 * the rows and reports what happened. Every failure is counted and named
 * rather than thrown: 1481 rows went through here on the production run of
 * 2026-09-13, 61 of them with no cover at all, and libretro renames files. One row that cannot be had must not stop
 * the other 1414.
 */

import type { Database } from '../db/sqlite.js';
import { listCoverWork, setServedCover, findCover } from '../db/game-metadata.js';
import { coverTaskFor } from './task.js';
import { ingestCover, type Fetcher } from './ingest.js';
import { renderCover, type Rendition } from './render.js';
import { storeRendition, COVERS_DIR } from './store.js';
import { imageKindOf } from '../utils/image-kind.js';

export interface WarmReport {
  ingested: number;
  skipped: number;
  /** Rows with no cover to have: the sixty blanks, and stale uploaded-cover URLs. */
  nothing: number;
  failed: { title: string; reason: string }[];
}

export interface WarmOptions {
  rebuild?: boolean;
  dir?: string;
  fetcher?: Fetcher;
  /** Called after each row, so a 1481-row pass is not silent for twenty minutes. */
  onProgress?: (done: number, total: number) => void;
}

/**
 * A plain server-side fetch, following redirects.
 *
 * Measured on 2026-09-13: cache.downloadroms.io answers a 301 to another host
 * and 404s for third-party image resizers, but answers this normally - which is
 * the only reason the 463 entries behind it can be ingested at all.
 */
const httpFetcher: Fetcher = async (url) => {
  const response = await fetch(url, { redirect: 'follow' });
  return {
    ok: response.ok,
    status: response.status,
    bytes: Buffer.from(await response.arrayBuffer())
  };
};

/**
 * A cover a player uploaded.
 *
 * The BLOB stays the source of truth and never leaves the database; the files
 * on the volume are derived from it, exactly like the catalogue's are derived
 * from their remote URL. That is what makes the volume rebuildable and not
 * worth backing up.
 */
async function renderUploaded(db: Database, id: string): Promise<Rendition> {
  const uploaded = findCover(db, id);
  if (!uploaded) throw new Error('the row claims a cover it does not have');
  const mime = imageKindOf(uploaded.bytes);
  if (!mime) throw new Error('the stored bytes are not an image we serve');
  return renderCover(uploaded.bytes, mime);
}

export async function warmCovers(db: Database, options: WarmOptions = {}): Promise<WarmReport> {
  const { rebuild = false, dir = COVERS_DIR, fetcher = httpFetcher, onProgress } = options;
  const report: WarmReport = { ingested: 0, skipped: 0, nothing: 0, failed: [] };

  const rows = listCoverWork(db);
  let done = 0;

  for (const row of rows) {
    const task = coverTaskFor(row, { rebuild });

    if (task.do === 'skip') {
      report.skipped++;
    } else if (task.do === 'nothing') {
      report.nothing++;
    } else {
      try {
        let rendition: Rendition;
        if (task.do === 'upload') {
          rendition = await renderUploaded(db, row.id);
        } else {
          const result = await ingestCover(task.url, fetcher);
          if (!result.ok) throw new Error(result.reason);
          rendition = result.rendition;
        }
        setServedCover(db, row.id, await storeRendition(dir, rendition));
        report.ingested++;
      } catch (error) {
        report.failed.push({ title: row.title, reason: (error as Error).message });
      }
    }

    onProgress?.(++done, rows.length);
  }

  return report;
}
