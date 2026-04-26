/**
 * Phrase denylist loader.
 *
 * Reads a project-supplied TOML file, validates it with Zod, compiles each
 * pattern with RE2JS (linear-time guarantees; ReDoS-safe), and returns the
 * resulting CompiledPattern[].
 */

import { z } from 'zod';
import { parse as parseToml } from 'smol-toml';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RE2JS } from 're2js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DenylistEntry {
  key: string;
  regex: string;
  flags: string;
  referenceUrl: string | null;
  description?: string;
}

export interface CompiledPattern {
  key: string;
  regex: string;
  flags: string;
  compiled: ReturnType<typeof RE2JS.compile>;
  referenceUrl: string | null;
  description?: string;
}

export interface LoadDenylistOptions {
  path: string;
  cwd?: string;
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class PhraseLoaderError extends Error {
  override name = 'PhraseLoaderError' as const;

  constructor(message: string, public override readonly cause?: unknown) {
    super(message);
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, PhraseLoaderError);
    }
  }
}

// ---------------------------------------------------------------------------
// Zod schema
// ---------------------------------------------------------------------------

const DenylistEntrySchema = z.object({
  key: z.string().min(1),
  regex: z.string().min(1),
  flags: z.string().optional(),
  reference_url: z.string().url().nullable().optional(),
  description: z.string().optional(),
});

const DenylistFileSchema = z.object({
  patterns: z.array(DenylistEntrySchema).optional(),
});

// ---------------------------------------------------------------------------
// Prototype-pollution guard
// ---------------------------------------------------------------------------

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function checkPollution(node: unknown, filePath: string): void {
  if (node === null || typeof node !== 'object') return;
  for (const key of Object.keys(node as Record<string, unknown>)) {
    if (DANGEROUS_KEYS.has(key)) {
      throw new PhraseLoaderError(`Prototype pollution attempt: ${filePath}`);
    }
    checkPollution((node as Record<string, unknown>)[key], filePath);
  }
}

// ---------------------------------------------------------------------------
// Flag translation
// ---------------------------------------------------------------------------

function translateFlags(flags: string, key: string): number {
  let bits = 0;
  for (const ch of flags) {
    if (ch === 'i') {
      bits |= RE2JS.CASE_INSENSITIVE;
    } else if (ch === 'm') {
      bits |= RE2JS.MULTILINE;
    } else if (ch === 's') {
      bits |= RE2JS.DOTALL;
    } else {
      throw new PhraseLoaderError(
        `Pattern ${key} has unknown flag '${ch}': only 'i', 'm', 's' are supported`,
      );
    }
  }
  return bits;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loadDenylist(opts: LoadDenylistOptions): Promise<CompiledPattern[]> {
  const cwd = opts.cwd ?? process.cwd();
  const resolvedPath = join(cwd, opts.path);

  let contents: string;
  try {
    contents = await readFile(resolvedPath, 'utf-8');
  } catch (err) {
    throw new PhraseLoaderError(`denylist file not found: ${resolvedPath}`, err);
  }

  let raw: unknown;
  try {
    raw = parseToml(contents);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new PhraseLoaderError(`TOML parse error in ${resolvedPath}: ${reason}`, err);
  }

  // Prototype-pollution guard before Zod validation
  checkPollution(raw, resolvedPath);

  let parsed: z.infer<typeof DenylistFileSchema>;
  try {
    parsed = DenylistFileSchema.parse(raw);
  } catch (err) {
    if (err instanceof z.ZodError) {
      const first = err.issues[0];
      if (first !== undefined) {
        const fieldPath = first.path.join('.');
        throw new PhraseLoaderError(
          `Denylist validation error at ${fieldPath}: ${first.message}`,
          err,
        );
      }
      /* c8 ignore next */
      // unreachable: ZodError always has at least one issue
      throw new PhraseLoaderError(`Denylist validation failed: ${err.message}`, err);
    }
    throw err;
  }

  const entries = parsed.patterns ?? [];

  // Duplicate-key detection
  const seenKeys = new Set<string>();
  for (const entry of entries) {
    if (seenKeys.has(entry.key)) {
      throw new PhraseLoaderError(`Duplicate key '${entry.key}' in denylist: ${resolvedPath}`);
    }
    seenKeys.add(entry.key);
  }

  // Compile each pattern
  const result: CompiledPattern[] = [];
  for (const entry of entries) {
    const flagsStr = entry.flags ?? '';
    const flagBits = translateFlags(flagsStr, entry.key);

    let compiled: ReturnType<typeof RE2JS.compile>;
    try {
      compiled = RE2JS.compile(entry.regex, flagBits);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new PhraseLoaderError(
        `Pattern ${entry.key} is not RE2-safe (no backreferences or lookahead): ${reason}`,
        err,
      );
    }

    result.push({
      key: entry.key,
      regex: entry.regex,
      flags: flagsStr,
      compiled,
      referenceUrl: entry.reference_url ?? null,
      description: entry.description,
    });
  }

  return result;
}
