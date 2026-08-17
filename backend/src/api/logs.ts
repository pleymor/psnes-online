import { Router } from 'express';
import { User } from '../types/index.js';
import { requireAuth } from '../middleware/auth.js';
import { createLogger } from '../utils/logger.js';
import { asyncHandler } from '../middleware/async-handler.js';

const logger = createLogger('client');

export const logsRouter = Router();

logsRouter.use(requireAuth);

const LEVELS = new Set(['info', 'warn', 'error']);
const MAX_ENTRIES = 100;
const MAX_MESSAGE = 2000;
const MAX_DATA = 8000;

/**
 * Ingests browser logs.
 *
 * Diagnosing the netplay modes from console output relayed by hand is slow and
 * lossy: the interesting lines are long, they happen on two machines at once,
 * and the ones that matter are usually the ones that got truncated. This puts
 * both players' logs into one ordered stream on the server.
 *
 * Field names follow the Elastic Common Schema, so pointing pino at Loki or
 * Elastic later is a transport change and nothing more - no client work, no
 * reformatting of what is already stored.
 */
logsRouter.post('/', asyncHandler(async (req, res) => {
  const user = req.user as User;
  const { sessionId, labels, entries } = req.body ?? {};

  if (!Array.isArray(entries)) {
    return res.status(400).json({ error: 'entries must be an array' });
  }

  // Everything below is attacker-controlled: it arrives from a browser and
  // ends up in the log pipeline, so it is capped rather than trusted.
  for (const entry of entries.slice(0, MAX_ENTRIES)) {
    const level = LEVELS.has(entry?.level) ? entry.level : 'info';
    const line = {
      '@timestamp': typeof entry?.timestamp === 'string' ? entry.timestamp : new Date().toISOString(),
      'log.logger': String(entry?.context ?? 'unknown').slice(0, 120),
      'event.dataset': 'psnes.client',
      'user.id': user.id,
      'user.name': user.displayName,
      'trace.id': String(sessionId ?? '').slice(0, 32),
      labels: sanitiseLabels(labels),
      data: truncate(entry?.data, MAX_DATA)
    };

    const message = String(entry?.message ?? '').slice(0, MAX_MESSAGE);
    if (level === 'error') logger.error(line, message);
    else if (level === 'warn') logger.warn(line, message);
    else logger.info(line, message);
  }

  res.status(204).end();
}));

function sanitiseLabels(labels: unknown): Record<string, string> {
  if (!labels || typeof labels !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels as Record<string, unknown>).slice(0, 10)) {
    out[key.slice(0, 40)] = String(value).slice(0, 200);
  }
  return out;
}

function truncate(value: unknown, limit: number): unknown {
  if (value === undefined) return undefined;
  const text = JSON.stringify(value);
  if (text === undefined) return undefined;
  return text.length <= limit ? value : `${text.slice(0, limit)}…[truncated]`;
}
