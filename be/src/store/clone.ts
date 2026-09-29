/**
 * Services return this instead of raw store references, so a caller
 * mutating a returned object can never corrupt state that only `exec()`
 * should be allowed to touch.
 */
export function clone<T>(value: T): T {
  return structuredClone(value);
}
