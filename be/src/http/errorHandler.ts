import type { NextFunction, Request, Response } from "express";
import { AppError } from "../errors/AppError.js";

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: { code: "ROUTE_NOT_FOUND", message: `No route for ${req.method} ${req.path}` },
  });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- must keep 4 args for Express to treat this as error middleware
export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  if (err instanceof AppError) {
    res.status(err.httpStatus).json(err.toResponseBody());
    return;
  }
  if (err instanceof SyntaxError && "body" in err) {
    res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Malformed JSON body" } });
    return;
  }
  console.error(err);
  res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Something went wrong" } });
}
