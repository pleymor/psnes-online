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
 * Refuses a migration whose SQL contains a `PRAGMA` statement, before it ever
 * runs.
 *
 * Every migration below executes inside `db.transaction()`. SQLite silently
 * no-ops `PRAGMA foreign_keys=OFF` (and `defer_foreign_keys=ON` right beside
 * it - deferral postpones constraint *checks*, it does not suppress cascade
 * *actions*) when a transaction is already open, so foreign-key enforcement
 * stays on throughout. That is exactly the shape of a Prisma table rebuild:
 * create `new_X`, copy rows, `DROP TABLE X`, rename. With enforcement still
 * on, the `DROP TABLE` fires every surviving `ON DELETE CASCADE` against the
 * table being dropped, silently deleting rows in *other* tables that the
 * pragma was meant to protect - no exception raised, the migration reports
 * success. `prisma migrate diff` - the same command that produced this
 * repo's baseline - writes exactly this pattern by default, so the next
 * migration authored here is more likely than not to be handed one.
 *
 * Running such a script outside the transaction instead would trade
 * atomicity silently, on a regex's say-so, for precisely the migration class
 * where a half-application is most destructive: rows copied, old table
 * dropped, rename failed, ledger unwritten, and a retry re-runs a
 * partly-applied script. A refusal costs an author a few minutes; a
 * half-finished table rebuild costs a restore from backup. So a migration
 * that needs its pragmas to take effect has to be run by hand, outside
 * migrate() - deliberately, not through an opt-in flag here.
 *
 * A `PRAGMA` inside a comment or a string literal would also be rejected.
 * That is a false positive worth accepting rather than parsing SQL to avoid:
 * it costs the author a rename, whereas missing a real one costs silent data
 * loss.
 */
function assertNoPragma(file: string, sql: string): void {
  if (/\bPRAGMA\b/i.test(sql)) {
    throw new Error(
      `${file} contains a PRAGMA statement. Every migration runs inside a transaction, and ` +
      'SQLite silently ignores PRAGMA foreign_keys there, so a table rebuild\'s DROP TABLE ' +
      'fires ON DELETE CASCADE with enforcement still on - deleting rows the pragma was meant ' +
      'to protect, with no error raised. Run this migration by hand, outside migrate(), instead.'
    );
  }
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

  // ensureBookkeeping is unconditional and idempotent - CREATE TABLE IF NOT
  // EXISTS - so it is safe to run before we know whether this database needs
  // baselining. What is NOT safe is keying that decision off the table's
  // *existence*: a refused start (SchemaDriftError below) would then leave an
  // empty ledger behind, and every later run - even one where the schema has
  // since been repaired to match exactly - would see the table already there,
  // treat baselining as done, and crash trying to re-run the baseline's
  // CREATE TABLE against a schema that's already there. Keying off the
  // ledger's *row count* instead means a database that failed before ever
  // recording anything looks, correctly, exactly like one that had never been
  // touched.
  ensureBookkeeping(db);
  const recorded = alreadyRecorded(db);
  const needsBaseline = recorded.size === 0 && hasExistingSchema(db);

  const result: MigrationResult = { applied: [], baselined: [] };
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
    assertNoPragma(file, sql);
    // Each migration is its own transaction: a failure rolls back that
    // migration and leaves the ones before it recorded.
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
