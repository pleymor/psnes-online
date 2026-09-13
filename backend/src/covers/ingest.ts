/**
 * One cover, from a remote URL to the two renditions we serve.
 *
 * Every failure is a reason rather than a throw: 1415 rows are ingested in one
 * pass, 60 of them have no cover at all, and libretro renames files. One row
 * that cannot be had must not stop the other 1414.
 */

import { readCoverBody } from './source.js';
import { renderCover, type Rendition } from './render.js';

export interface FetchedBody {
  ok: boolean;
  status: number;
  bytes: Buffer;
}

export type Fetcher = (url: string) => Promise<FetchedBody>;

export type Ingested = { ok: true; rendition: Rendition } | { ok: false; reason: string };

/**
 * One hop, not a walk.
 *
 * Named_Boxarts symlinks point at real files. A chain means something we do not
 * understand about the source, and following it is how a fetch loop starts.
 */
const MAX_HOPS = 1;

export async function ingestCover(url: string, fetcher: Fetcher): Promise<Ingested> {
  let target = url;

  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    let fetched: FetchedBody;
    try {
      fetched = await fetcher(target);
    } catch (error) {
      return { ok: false, reason: `fetch failed: ${(error as Error).message}` };
    }
    if (!fetched.ok) return { ok: false, reason: `HTTP ${fetched.status}` };

    const body = readCoverBody(target, fetched.bytes);
    if (body.kind === 'unusable') return { ok: false, reason: 'not an image, and not a symlink' };
    if (body.kind === 'symlink') {
      target = body.url;
      continue;
    }

    try {
      return { ok: true, rendition: await renderCover(body.bytes, body.mime) };
    } catch (error) {
      return { ok: false, reason: `${body.mime} did not decode: ${(error as Error).message}` };
    }
  }

  return { ok: false, reason: 'symlink chain longer than one hop' };
}
