/**
 * bibcheck configuration schema and loader.
 *
 * Reads `bibcheck.toml` from the project root, validates it against the
 * Zod schema, and returns a frozen typed Config. Returns defaults when no
 * config file is present.
 */

import { z } from 'zod';
import { parse as parseToml } from 'smol-toml';
import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Schema sections
// ---------------------------------------------------------------------------

const BibliographySchema = z.object({
  file: z.string().default('docs/sources.json'),
});

const DocsSchema = z.object({
  include: z.array(z.string()).default(['docs/**/*.md']),
  exclude: z.array(z.string()).default([]),
});

const TrustedHostsSchema = z.object({
  hosts: z.array(z.string()).default([
    'hathitrust.org',
    'archive.org',
    'oll.libertyfund.org',
    'plato.stanford.edu',
    'philpapers.org',
    'loc.gov',
    'dnb.de',
    'bnf.fr',
  ]),
});

const PhrasesSchema = z.object({
  file: z.string().nullable().default(null),
});

const SourceTypeEntrySchema = z.object({
  warn_load_bearing: z.boolean().optional(),
  allow_load_bearing: z.boolean().optional(),
  /**
   * T23 — source-type gating rule. When `false`, a `not-found-in-databases`
   * (unverifiable-absence) result for an entry of this CSL type does NOT gate
   * `bibcheck check` — e.g. a pre-DOI manuscript / archival source for which no
   * DOI was ever expected. The finding is still reported (informational), never
   * dropped. Omitted / `true` ⇒ the Q1 secure default (gate). Governs only the
   * not-found gate; malformed identifiers, canonical issues, and metadata
   * mismatches always gate (use a per-entry `bibcheck-allow` note for those).
   */
  gate_not_found: z.boolean().optional(),
});

const ApisSchema = z.object({
  crossref_mailto: z.string().nullable().default(null),
  openalex_mailto: z.string().nullable().default(null),
  // Base URLs for each bibliographic database. When omitted, each DB client
  // and the doctor connectivity check fall back to the real public endpoint
  // (see API_BASE_DEFAULTS). Overridable (e.g. to a localhost stub) for
  // hermetic testing. Validated as URLs when present; a trailing slash is
  // tolerated (clients strip it). Kept optional so the effective default lives
  // in one place (API_BASE_DEFAULTS) and consumers stay tolerant of an absent
  // value.
  crossref_base: z.string().url().optional(),
  openalex_base: z.string().url().optional(),
  openlibrary_base: z.string().url().optional(),
});

/**
 * Effective default base URLs for the bibliographic database APIs. These are
 * the real public endpoints used whenever the corresponding `[apis] *_base`
 * config field is omitted. (WorldCat / OCLC Classify was removed in 0.2.0.)
 */
export const API_BASE_DEFAULTS = {
  crossref: 'https://api.crossref.org',
  openalex: 'https://api.openalex.org',
  openlibrary: 'https://openlibrary.org',
} as const;

const CacheSchema = z.object({
  dir: z.string().default('.bibcheck-cache'),
  max_size_mb: z.number().nullable().default(256),
});

// ---------------------------------------------------------------------------
// Top-level schema
// ---------------------------------------------------------------------------

export const ConfigSchema = z.object({
  bibliography: BibliographySchema.default({}),
  docs: DocsSchema.default({}),
  trusted_hosts: TrustedHostsSchema.default({}),
  phrases: PhrasesSchema.default({}),
  source_types: z.record(z.string(), SourceTypeEntrySchema).default({}),
  edition_discipline: z.record(z.string(), z.string()).default({}),
  apis: ApisSchema.default({}),
  cache: CacheSchema.default({}),
});

export type Config = z.infer<typeof ConfigSchema>;

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ConfigError);
    }
  }
}

// ---------------------------------------------------------------------------
// Prototype-pollution guard
// ---------------------------------------------------------------------------

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function checkPollution(node: unknown, path: string): void {
  if (node === null || typeof node !== 'object') return;

  for (const key of Object.keys(node as Record<string, unknown>)) {
    const childPath = path ? `${path}.${key}` : key;
    if (DANGEROUS_KEYS.has(key)) {
      throw new ConfigError(`Prototype pollution attempt: ${childPath}`);
    }
    checkPollution((node as Record<string, unknown>)[key], childPath);
  }
}

// ---------------------------------------------------------------------------
// Deep freeze helper
// ---------------------------------------------------------------------------

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  Object.freeze(value);
  for (const v of Object.values(value as Record<string, unknown>)) {
    deepFreeze(v);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export interface LoadConfigOptions {
  path?: string;
  cwd?: string;
}

export async function loadConfig(opts?: LoadConfigOptions): Promise<Config> {
  const cwd = opts?.cwd ?? process.cwd();
  const configPath = opts?.path ? join(cwd, opts.path) : join(cwd, 'bibcheck.toml');

  let raw: Record<string, unknown>;

  try {
    await access(configPath);
  } catch {
    // File does not exist — return defaults
    return deepFreeze(ConfigSchema.parse({}));
  }

  let contents: string;
  try {
    contents = await readFile(configPath, 'utf-8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ConfigError(`Failed to read config file: ${message}`);
  }

  // Empty file is valid — treat as all-defaults
  if (contents.trim() === '') {
    return deepFreeze(ConfigSchema.parse({}));
  }

  try {
    raw = parseToml(contents) as Record<string, unknown>;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ConfigError(`TOML parse error in ${configPath}: ${message}`);
  }

  // Prototype-pollution guard
  checkPollution(raw, '');

  try {
    return deepFreeze(ConfigSchema.parse(raw));
  } catch (err) {
    if (err instanceof z.ZodError) {
      const first = err.issues[0];
      if (first !== undefined) {
        const fieldPath = first.path.join('.');
        throw new ConfigError(`${fieldPath}: ${first.message}`);
      }
      /* c8 ignore next */
      // unreachable: ZodError always has at least one issue
      throw new ConfigError(`Configuration validation failed: ${err.message}`);
    }
    throw err;
  }
}
