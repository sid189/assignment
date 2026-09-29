import { AppError } from "../errors/AppError.js";

export function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw AppError.badRequest("VALIDATION_ERROR", `${field} is required and must be a non-empty string`);
  }
  return value;
}

export function requireNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw AppError.badRequest("VALIDATION_ERROR", `${field} is required and must be a number`);
  }
  return value;
}

export function optionalString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") {
    throw AppError.badRequest("VALIDATION_ERROR", "expected a string field");
  }
  return value;
}

export function headerString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}
