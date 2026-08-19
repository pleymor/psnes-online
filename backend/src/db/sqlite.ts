import BetterSqlite3 from 'better-sqlite3';

export type Database = BetterSqlite3.Database;

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
  const db = new BetterSqlite3(file);
  // SQLite ships with foreign keys off. Deleting a Game relies on the cascade
  // to take its Saves with it, so this is load-bearing, not hygiene.
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  return db;
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
