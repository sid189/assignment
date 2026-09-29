export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus: number,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
  }

  static badRequest(code: string, message: string, details?: Record<string, unknown>): AppError {
    return new AppError(code, 400, message, details);
  }

  static notFound(code: string, message: string, details?: Record<string, unknown>): AppError {
    return new AppError(code, 404, message, details);
  }

  static conflict(code: string, message: string, details?: Record<string, unknown>): AppError {
    return new AppError(code, 409, message, details);
  }

  static paymentRequired(code: string, message: string, details?: Record<string, unknown>): AppError {
    return new AppError(code, 402, message, details);
  }

  toResponseBody(): { error: { code: string; message: string; details?: Record<string, unknown> } } {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}
