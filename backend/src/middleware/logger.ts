import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger.js';

export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();
  const originalSend = res.send;

  res.send = function (data) {
    const duration = Date.now() - start;
    const user = (req as any).user;
    const isAuthError = res.statusCode === 401 || res.statusCode === 403;
    /**
     * A 4xx is something the client did, not something that went wrong here.
     *
     * These used to be logged at error level, which was survivable while 4xx
     * meant a genuine mistake. It stopped being survivable with the onboarding
     * gate: every player who has not chosen a pseudonym yet gets a 409 from
     * requirePseudo on every request the page makes, so a handful of accounts
     * would bury anything actually worth reading. Errors are for 5xx - the
     * cases where the server is the one at fault.
     */
    const isClientError = res.statusCode >= 400 && res.statusCode < 500;
    const shouldLog = process.env.NODE_ENV === 'development' || duration > 100 || res.statusCode >= 400;

    if (isAuthError || shouldLog) {
      const logData = {
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        duration: `${duration}ms`,
        // `user.email` used to be the fallback here. There is no email on a
        // User any more, and `id` is never absent, so the fallback was both
        // dead and a reference to a column that no longer exists.
        user: user ? user.id : 'guest',
        query: Object.keys(req.query).length > 0 ? req.query : undefined,
        ip: isAuthError ? req.ip || req.socket.remoteAddress : undefined
      };

      if (isAuthError) {
        logger.warn(logData, 'Auth error');
      } else if (isClientError) {
        logger.warn(logData, 'Request refused');
      } else if (res.statusCode >= 500) {
        logger.error(logData, 'Request error');
      } else if (duration > 100) {
        logger.warn(logData, 'Slow request');
      } else {
        logger.info(logData, 'Request');
      }
    }

    return originalSend.call(this, data);
  };

  next();
}
