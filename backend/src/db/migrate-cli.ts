import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getDb } from './sqlite.js';
import { migrate, SchemaDriftError } from './migrate.js';

const here = dirname(fileURLToPath(import.meta.url));
// dist/db/migrate-cli.js -> /app/migrations
const migrationsDir = join(here, '../../migrations');

try {
  const result = migrate(getDb(), migrationsDir);
  for (const name of result.baselined) {
    console.log(`baselined ${name} (schema already present and matching)`);
  }
  for (const name of result.applied) {
    console.log(`applied ${name}`);
  }
  if (result.applied.length === 0 && result.baselined.length === 0) {
    console.log('database is up to date');
  }
  process.exit(0);
} catch (error) {
  if (error instanceof SchemaDriftError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}
