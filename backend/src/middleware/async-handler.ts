import { Request, Response, NextFunction, RequestHandler } from 'express';

type AsyncRequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction
) => Promise<unknown>;

/**
 * Express 4 does not observe promises returned by route handlers, so a
 * rejected await (a failing Redis call, for instance) surfaces as an
 * unhandledRejection and terminates the whole process — one bad query takes
 * the server down for every connected player.
 *
 * Wrapping a handler routes its rejection to next(), where the error
 * middleware can turn it into a 500 and keep the process alive.
 */
export function asyncHandler(fn: AsyncRequestHandler): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
