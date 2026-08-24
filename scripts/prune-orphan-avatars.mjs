#!/usr/bin/env node
/**
 * Deletes avatar files no User row points at any more.
 *
 * Avatars used to be named md5(googleId). That is not the Google account id in
 * the clear, but it is a stable fingerprint of it, and the URL is served to
 * every friend - so anyone already holding that Google id could confirm the
 * account belonged to the same person. Sign-in now hashes the internal id
 * instead, a UUID that exists nowhere else.
 *
 * The old files do not disappear on their own: each is replaced only when its
 * owner next signs in, and until then the User row still points at it. So this
 * is a deliberate second step, to run some weeks after the deploy, once
 * everyone has been back.
 *
 * A migration cannot do this - migrations are .sql and cannot touch the disk.
 *
 * Idempotent and re-runnable. Pass --dry-run to list without deleting.
 *
 *   node scripts/prune-orphan-avatars.mjs [--dry-run] [--db path] [--dir path]
 */

import { readdir, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

function option(name, fallback) {
  const at = args.indexOf(name);
  return at === -1 || at === args.length - 1 ? fallback : args[at + 1];
}

const dbPath = resolve(option('--db', 'backend/data/prod.db'));
const avatarsDir = resolve(option('--dir', 'backend/avatars'));

const db = new Database(dbPath, { readonly: true });

/**
 * The set of filenames still spoken for.
 *
 * User.avatar holds either `/api/avatars/<file>` or, when the download failed
 * at sign-in, the Google URL it fell back to. Only the first shape names a
 * local file; anything else simply contributes nothing, which is correct.
 */
const referenced = new Set(
  db.prepare(`SELECT avatar FROM "User" WHERE avatar IS NOT NULL`)
    .all()
    .map(row => row.avatar)
    .filter(value => value.startsWith('/api/avatars/'))
    .map(value => value.slice('/api/avatars/'.length))
);

const present = await readdir(avatarsDir);
const orphans = present.filter(name => !referenced.has(name));

console.log(`${present.length} files, ${referenced.size} referenced, ${orphans.length} orphaned`);

for (const name of orphans) {
  if (dryRun) {
    console.log(`would delete ${name}`);
  } else {
    await unlink(resolve(avatarsDir, name));
    console.log(`deleted ${name}`);
  }
}

db.close();
