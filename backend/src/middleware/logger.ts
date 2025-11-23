import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger.js';

export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();
  const originalSend = res.send;

  res.send = function (data) {
    const duration = Date.now() - start;
    const user = (req as any).user;
    const isAuthError = res.statusCode === 401 || res.statusCode === 403;
    const shouldLog = process.env.NODE_ENV === 'development' || duration > 100 || res.statusCode >= 400;

    if (isAuthError || shouldLog) {
      const logData = {
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        duration: `${duration}ms`,
        user: user ? user.id || user.email : 'guest',
        query: Object.keys(req.query).length > 0 ? req.query : undefined,
        ip: isAuthError ? req.ip || req.socket.remoteAddress : undefined
      };

      if (isAuthError) {
        logger.warn(logData, 'Auth error');
      } else if (res.statusCode >= 400) {
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
