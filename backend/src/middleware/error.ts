import { Request, Response, NextFunction } from 'express';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('Error');

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
