import { logger } from '../utils/logger.js';

/**
 * Fail fast rather than silently falling back to a well-known default: a
 * guessable SESSION_SECRET makes every session cookie forgeable. Placeholder
 * values are rejected too, since the shipped .env.example values would
 * otherwise satisfy a mere presence check.
 */
export function assertUsableEnvironment(isProduction: boolean): void {
  if (!isProduction) return;

  const REQUIRED_SECRETS = ['SESSION_SECRET'];
  const PLACEHOLDER_PATTERN = /change|your-|example|secret-key|generate-with/i;

  const unusable = REQUIRED_SECRETS.filter(key => {
    const value = process.env[key];
    return !value || value.length < 32 || PLACEHOLDER_PATTERN.test(value);
  });

  if (unusable.length > 0) {
    logger.fatal(
      { unusable },
      'Refusing to start in production: required secrets are missing, too short (<32 chars), or still set to a placeholder'
    );
    process.exit(1);
  }

  if (process.env.AUTH_MODE === 'dev') {
    logger.fatal('AUTH_MODE=dev is not permitted in production');
    process.exit(1);
  }
}
