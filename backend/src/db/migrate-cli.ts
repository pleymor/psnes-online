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
  // Anything else - a missing migrations directory, an unreadable database, a
  // migration statement that fails - would otherwise reach the operator as a
  // bare, unframed Node stack trace full of dist/ paths. The exit code was
  // already non-zero either way; what was missing was any signal that it was
  // *the migration runner* that failed, not the container's next command.
  console.error('The migration runner failed:', error);
  process.exit(1);
}
