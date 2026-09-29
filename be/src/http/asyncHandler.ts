import type { NextFunction, Request, RequestHandler, Response } from "express";

type Handler = (req: Request, res: Response) => Promise<void> | void;

/** Routes are written as plain async functions; this forwards any throw/rejection to Express's error pipeline. */
export function asyncHandler(fn: Handler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
}
