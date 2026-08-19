import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from './sqlite.js';
import { openDatabase } from './sqlite.js';

export interface MigrationResult {
  /** Migrations whose SQL was executed. */
  applied: string[];
  /** Migrations recorded as already present, because the schema was there. */
  baselined: string[];
}

export class SchemaDriftError extends Error {
  constructor(public readonly differences: string[]) {
    super(
      'The database schema does not match what the migrations produce. ' +
      'Refusing to start rather than record a baseline that is not true.\n\n' +
      differences.join('\n')
    );
    this.name = 'SchemaDriftError';
  }
}

function ensureBookkeeping(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);
}

function listMigrations(dir: string): string[] {
  return readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
}

function alreadyRecorded(db: Database): Set<string> {
  const rows = db.prepare(`SELECT name FROM schema_migrations`).all() as { name: string }[];
  return new Set(rows.map(r => r.name));
}

/** The schema as SQLite itself describes it, normalised so whitespace does not matter. */
function schemaOf(db: Database): Map<string, string> {
  const rows = db.prepare(`
    SELECT name, sql FROM sqlite_master
    WHERE sql IS NOT NULL
      AND name NOT LIKE 'sqlite_%'
      AND name NOT IN ('_prisma_migrations', 'schema_migrations')
  `).all() as { name: string; sql: string }[];

  return new Map(rows.map(r => [r.name, r.sql.replace(/\s+/g, ' ').trim()]));
}

/** Does this database already carry a schema, or is it blank? */
function hasExistingSchema(db: Database): boolean {
  return schemaOf(db).size > 0;
}

/**
 * What the baseline alone would produce, built in memory so nothing on disk is
 * touched by the check. This goes through `openDatabase`, not a bare
 * `better-sqlite3` handle: the point of the probe is to compare like with
 * like, and `openDatabase` is what every real database - the one being
 * compared against - was built with. `foreign_keys = ON` cannot change what
 * `sqlite_master.sql` records for a CREATE TABLE, but `journal_mode = WAL`
 * silently downgrades to `memory` on an in-memory database rather than
 * erroring, so there is no cost to going through the same door as everyone
 * else.
 */
function expectedBaselineSchema(baselineSql: string): Map<string, string> {
  const probe = openDatabase(':memory:');
  try {
    probe.exec(baselineSql);
    return schemaOf(probe);
  } finally {
    probe.close();
  }
}

function diffSchemas(live: Map<string, string>, expected: Map<string, string>): string[] {
  const differences: string[] = [];
  for (const [name, sql] of expected) {
    if (!live.has(name)) {
      differences.push(`missing from the database: ${name}`);
    } else if (live.get(name) !== sql) {
      differences.push(
        `different definition for ${name}:\n  database:   ${live.get(name)}\n  migrations: ${sql}`
      );
    }
  }
  for (const name of live.keys()) {
    if (!expected.has(name)) {
      differences.push(`present in the database but not in the migrations: ${name}`);
    }
  }
  return differences;
}

/**
 * Brings the database up to date.
 *
 * On a blank database every migration runs. On a database that already
 * carries a schema - the one Prisma left behind with `db push
 * --accept-data-loss`, which reconciles and records nothing - the baseline is
 * compared against what it would actually produce, and recorded only if they
 * match; a mismatch throws rather than being stamped over. That refusal is
 * the point: the old process was never wrong for applying a schema, it was
 * wrong for never checking that the live database matched the files. Baseline
 * blindly here and that same hole reopens, just with a different tool doing
 * the stamping.
 */
export function migrate(db: Database, migrationsDir: string): MigrationResult {
  const files = listMigrations(migrationsDir);
  if (files.length === 0) {
    throw new Error(`No migrations found in ${migrationsDir}`);
  }

  const needsBaseline = !db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'`)
    .get() && hasExistingSchema(db);

  ensureBookkeeping(db);

  const result: MigrationResult = { applied: [], baselined: [] };
  const recorded = alreadyRecorded(db);
  const [baselineFile, ...rest] = files;

  if (needsBaseline) {
    const baselineSql = readFileSync(join(migrationsDir, baselineFile), 'utf-8');
    const differences = diffSchemas(schemaOf(db), expectedBaselineSchema(baselineSql));
    if (differences.length > 0) {
      throw new SchemaDriftError(differences);
    }
    db.prepare(`INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)`)
      .run(baselineFile, Date.now());
    result.baselined.push(baselineFile);
    recorded.add(baselineFile);
  }

  for (const file of [baselineFile, ...rest]) {
    if (recorded.has(file)) continue;
    const sql = readFileSync(join(migrationsDir, file), 'utf-8');
    // Each migration is its own transaction: a failure rolls back that
    // migration and leaves the ones before it recorded.
    //
    // That guarantee does not hold for a script that leans on
    // `PRAGMA foreign_keys=OFF` for a table rebuild. SQLite makes that
    // pragma a silent no-op inside an already-open transaction, so
    // enforcement stays on throughout. Tested against the real
    // Prisma table-rebuild pattern (create new_X, copy rows, DROP TABLE X,
    // rename): with enforcement still on, the DROP fires each surviving
    // `ON DELETE CASCADE` against the dropped table, silently deleting rows
    // in *other* tables that a real, non-transactional run would have kept -
    // no exception raised, the migration "succeeds". None of the migrations
    // in this repo do a table rebuild yet (0001_baseline.sql carries no
    // pragmas), so this has not bitten. The first one that does will need to
    // run outside a transaction, deliberately trading atomicity for pragmas
    // that actually take effect - not something to paper over here.
    const run = db.transaction(() => {
      db.exec(sql);
      db.prepare(`INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)`)
        .run(file, Date.now());
    });
    run();
    result.applied.push(file);
  }

  return result;
}
