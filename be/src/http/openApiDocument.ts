import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse } from "yaml";

// This file lives at src/http/ (dev) or dist/http/ (built) — both are two
// levels under the package root, where openapi.yaml lives alongside
// package.json. Resolving relative to import.meta.url (not process.cwd())
// keeps this correct regardless of where the process is launched from.
const openApiPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "openapi.yaml");

/** Parsed once at module load — the spec file doesn't change at runtime. */
export const openApiDocument: Record<string, unknown> = parse(readFileSync(openApiPath, "utf-8"));
