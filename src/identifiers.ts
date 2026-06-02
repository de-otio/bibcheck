/**
 * bibcheck identifiers — local, offline DOI / ISBN / URL well-formedness checks.
 *
 * A pure functional-core module: no I/O, all input passed as arguments. It runs
 * BEFORE any network call and catches the large class of AI-fabricated citations
 * that carry a malformed identifier (a transposed ISBN digit, a DOI with stray
 * punctuation, a non-URL in `url:`) — the cheapest, highest-yield hallucination
 * signal. Emits the `IdentifiersLayer` from the output schema.
 *
 * No runtime dependencies: ISBN check-digit validation and normalization are
 * hand-rolled (both are small, well-specified algorithms).
 */

import type { CslEntry } from './schema/csl.js';
import type { IdentifiersLayer, IdentifierStatus } from './schema/output.js';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface RunIdentifiersDeps {
  bibliography: CslEntry[];
}

export interface RunIdentifiersResult {
  entries: Array<{ citekey: string; identifiers: IdentifiersLayer }>;
}

// ---------------------------------------------------------------------------
// DOI
// ---------------------------------------------------------------------------

/** Matches a syntactically well-formed DOI after any resolver prefix is stripped. */
const DOI_RE = /^10\.\d{4,}\/\S+$/i;

/** Strip a leading resolver prefix (`https://doi.org/`, `http://dx.doi.org/`, `doi:`). */
function stripDoiPrefix(doi: string): string {
  return doi
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    .replace(/^doi:/i, '');
}

/** Validate a DOI string. */
export function validateDoi(doi: string): 'ok' | 'malformed' {
  return DOI_RE.test(stripDoiPrefix(doi)) ? 'ok' : 'malformed';
}

// ---------------------------------------------------------------------------
// ISBN
// ---------------------------------------------------------------------------

/**
 * Normalize an ISBN to its bare digit string (hyphens/spaces removed, upper-cased
 * for a trailing `X`). Returns null when the input is not a 10- or 13-character
 * ISBN shape. Exposed so callers (e.g. existence cache keys) can key on a
 * canonical form rather than the raw, variably-hyphenated string.
 */
export function normalizeIsbn(raw: string): string | null {
  const stripped = raw.replace(/[\s-]/g, '').toUpperCase();
  if (/^\d{9}[\dX]$/.test(stripped)) return stripped; // ISBN-10
  if (/^\d{13}$/.test(stripped)) return stripped; // ISBN-13
  return null;
}

/** True if a 10-char ISBN-10 string has a valid check digit. */
function isbn10CheckOk(s: string): boolean {
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    sum += (10 - i) * Number(s[i]);
  }
  const check = s[9] === 'X' ? 10 : Number(s[9]);
  return (sum + check) % 11 === 0;
}

/** True if a 13-char ISBN-13 string has a valid check digit. */
function isbn13CheckOk(s: string): boolean {
  let sum = 0;
  for (let i = 0; i < 13; i++) {
    sum += (i % 2 === 0 ? 1 : 3) * Number(s[i]);
  }
  return sum % 10 === 0;
}

/** Validate an ISBN string (10 or 13). */
export function validateIsbn(isbn: string): 'ok' | 'bad-checksum' | 'malformed' {
  const normalized = normalizeIsbn(isbn);
  if (normalized === null) return 'malformed';
  const ok = normalized.length === 10 ? isbn10CheckOk(normalized) : isbn13CheckOk(normalized);
  return ok ? 'ok' : 'bad-checksum';
}

// ---------------------------------------------------------------------------
// URL
// ---------------------------------------------------------------------------

/** Validate that a string is a well-formed http/https URL. */
export function validateUrl(url: string): 'ok' | 'malformed' {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'malformed';
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? 'ok' : 'malformed';
}

// ---------------------------------------------------------------------------
// Per-entry layer + runner
// ---------------------------------------------------------------------------

/** True for a present, non-empty identifier string. */
function present(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** Compute the identifiers layer for one entry. */
export function identifiersFor(entry: CslEntry): IdentifiersLayer {
  const doi: IdentifierStatus = present(entry.doi) ? validateDoi(entry.doi) : 'not-applicable';
  const isbn: IdentifierStatus = present(entry.isbn) ? validateIsbn(entry.isbn) : 'not-applicable';
  const url: IdentifierStatus = present(entry.url) ? validateUrl(entry.url) : 'not-applicable';
  return { doi, isbn, url };
}

/**
 * Validate every entry's identifiers. Synchronous, deterministic, no I/O.
 * Output order matches input order.
 */
export function runIdentifiers(deps: RunIdentifiersDeps): RunIdentifiersResult {
  return {
    entries: deps.bibliography.map((entry) => ({
      citekey: entry.citekey,
      identifiers: identifiersFor(entry),
    })),
  };
}
