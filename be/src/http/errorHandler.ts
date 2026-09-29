import type { NextFunction, Request, Response } from "express";
import { AppError } from "../errors/AppError.js";

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: { code: "ROUTE_NOT_FOUND", message: `No route for ${req.method} ${req.path}` },
  });
}

/**
 * body-parser (express.json()) throws plain http-errors-style objects for
 * malformed JSON (status 400) and oversized payloads (status 413) — they
 * carry a numeric `status`/`statusCode` but are not AppError instances.
 * Without this, both previously fell through to a misleading generic 500;
 * found while load-testing with an intentionally oversized request body.
 */
function middlewareHttpStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const candidate = err as { status?: unknown; statusCode?: unknown };
  if (typeof candidate.status === "number") return candidate.status;
  if (typeof candidate.statusCode === "number") return candidate.statusCode;
  return undefined;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- must keep 4 args for Express to treat this as error middleware
export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  if (err instanceof AppError) {
    res.status(err.httpStatus).json(err.toResponseBody());
    return;
  }

  const status = middlewareHttpStatus(err);
  if (status === 400) {
    res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Malformed request body" } });
    return;
  }
  if (status === 413) {
    res.status(413).json({ error: { code: "PAYLOAD_TOO_LARGE", message: "Request body exceeds the size limit" } });
    return;
  }
  if (status !== undefined && status >= 400 && status < 500) {
    const message = err instanceof Error ? err.message : "Invalid request";
    res.status(status).json({ error: { code: "REQUEST_ERROR", message } });
    return;
  }

  console.error(err);
  res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Something went wrong" } });
}
