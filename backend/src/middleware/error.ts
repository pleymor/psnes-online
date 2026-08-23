import { Request, Response, NextFunction } from 'express';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('Error');

/**
 * Body-parser rejections that are the client's fault rather than ours.
 *
 * These arrive with their own status and a `type` naming what went wrong.
 * Answering 500 to all of them told a player "internal server error" for an
 * image that was merely too large — so they retried it unchanged, and the log
 * carried a server fault that never happened.
 */
const BODY_PARSER_MESSAGES: Record<string, string> = {
  'entity.too.large': 'That file is too large',
  'entity.parse.failed': 'Malformed request body',
  'entity.verify.failed': 'Malformed request body',
  'encoding.unsupported': 'Unsupported content encoding'
};

/**
 * Terminal error middleware. Must be registered after every route so that
 * anything reaching next(err) is logged with request context and answered
 * with a generic 500 — internal messages are never echoed to the client.
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction
) {
  const type = (err as { type?: string } | null)?.type;
  const status = (err as { status?: number } | null)?.status;
  if (!res.headersSent && type && BODY_PARSER_MESSAGES[type] && typeof status === 'number') {
    logger.warn({ type, status, path: req.path }, 'Rejected a malformed or oversized request body');
    return res.status(status).json({ error: BODY_PARSER_MESSAGES[type] });
  }

  const user = (req as any).user;

  logger.error(
    {
      err,
      method: req.method,
      path: req.path,
      user: user ? user.id || user.email : 'guest'
    },
    'Unhandled error while handling request'
  );

  // Headers already flushed (e.g. a stream failed mid-response): the only
  // correct move is to let Express destroy the connection.
  if (res.headersSent) {
    return next(err);
  }

  res.status(500).json({ error: 'Internal server error' });
}
