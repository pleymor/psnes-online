/**
 * The SQLite handle, on `bun:sqlite`.
 *
 * This used to be `better-sqlite3`. It cannot be any more: better-sqlite3 is a
 * V8-ABI native addon, and Bun refuses it outright -- `require('better-sqlite3')`
 * under Bun 1.3 throws `ERR_DLOPEN_FAILED: 'better-sqlite3' is not yet supported
 * in Bun` before any binding is even dlopen'd, prebuild or not. There is no
 * per-ABI prebuild that fixes that, so scripts/fetch-better-sqlite3-prebuild.sh
 * and its trustedDependencies exclusion are gone with it.
 *
 * `strict: true` is not optional. Without it `bun:sqlite` requires the sigil in
 * the *keys* of a bound object (`{ '@id': ... }` for `VALUES (@id)`) and, given
 * plain keys, binds NULL to every parameter and reports success -- 105 prepared
 * statements in this directory pass plain keys, so the difference between
 * strict and not is silent data loss. In strict mode plain keys bind correctly
 * and a missing parameter throws.
 */
import { Database as BunDatabase } from 'bun:sqlite';

export type Database = BunDatabase;

/**
 * Prisma addressed the database through a `file:` URL. The environment still
 * carries that form in DATABASE_URL, in compose files and in deployments we do
 * not control, so we keep reading it rather than asking every deployment to
 * change on the same day as the driver.
 */
export function databaseFileFromUrl(url: string): string {
  return url.startsWith('file:') ? url.slice('file:'.length) : url;
}

export function openDatabase(file: string): Database {
  const db = new BunDatabase(file, { strict: true });
  // SQLite ships with foreign keys off. Deleting a Game relies on the cascade
  // to take its Saves with it, so this is load-bearing, not hygiene.
  // (better-sqlite3 spelled these `db.pragma(...)`; bun:sqlite has no such
  // method, and a PRAGMA is just SQL.)
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA journal_mode = WAL');
  return db;
}

/**
 * A BLOB column as a `Buffer`.
 *
 * better-sqlite3 handed BLOBs back as `Buffer`; `bun:sqlite` hands back a plain
 * `Uint8Array`, which is not the same thing to the code downstream of here -
 * `.equals()`, `.toString('base64')` and `res.send()` all behave differently or
 * not at all. Every row type in this directory declares `Buffer`, so the
 * conversion belongs at the point the row leaves the driver rather than in each
 * of the handlers that consume one. It is a view, not a copy.
 */
export function asBuffer(value: Uint8Array): Buffer;
export function asBuffer(value: Uint8Array | null | undefined): Buffer | null;
export function asBuffer(value: Uint8Array | null | undefined): Buffer | null {
  if (value === null || value === undefined) return null;
  return Buffer.isBuffer(value)
    ? value
    : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

let instance: Database | null = null;

export function getDb(): Database {
  if (!instance) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error('DATABASE_URL is not set');
    }
    instance = openDatabase(databaseFileFromUrl(url));
  }
  return instance;
}

/**
 * Forgets the handle `getDb()` is caching, without closing it.
 *
 * `node --test` gave every test file its own process, so a file could set
 * DATABASE_URL at the top and be sure `getDb()` would open *its* database.
 * `bun test` runs every file in one process with one module registry: the
 * second file to try that gets back the first file's handle - already closed by
 * its `afterAll`, pointing at a deleted temp directory either way. Three files
 * do exactly that, so they call this after setting DATABASE_URL and before
 * their first `getDb()`.
 *
 * It deliberately does not close: whoever opened the handle still owns it and
 * closes it in its own teardown. Closing here would double-close.
 */
export function forgetDbForTest(): void {
  instance = null;
}
