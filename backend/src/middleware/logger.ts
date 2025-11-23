import { Request, Response, NextFunction } from 'express';

export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();
  const originalSend = res.send;

  res.send = function (data) {
    const duration = Date.now() - start;
    const user = (req as any).user;
    const isAuthError = res.statusCode === 401 || res.statusCode === 403;
    const shouldLog = process.env.NODE_ENV === 'development' || duration > 100 || res.statusCode >= 400;

    if (isAuthError || shouldLog) {
      const userInfo = user ? ` - User: ${user.id || user.email}` : ' - Guest';
      const queryInfo = Object.keys(req.query).length > 0 ? ` - Query: ${JSON.stringify(req.query)}` : '';
      const ipInfo = isAuthError ? ` - IP: ${req.ip || req.socket.remoteAddress}` : '';
      const prefix = isAuthError ? '⚠️  ' : '';

      console.log(`${prefix}[${new Date().toISOString()}] ${req.method} ${req.path} - ${res.statusCode} - ${duration}ms${userInfo}${queryInfo}${ipInfo}`);
    }

    return originalSend.call(this, data);
  };

  next();
}
