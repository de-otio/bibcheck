/**
 * Existence subcommand — commodity convenience layer.
 *
 * For each CSL-JSON bibliography entry, performs DOI/ISBN/title-search
 * lookups against CrossRef, OpenAlex, and OpenLibrary, then assigns an
 * ExistenceStatus based on the best result across all tried sources. Each
 * layer also carries the Q2 evidence vocabulary (`evidence` / `checkedFor` /
 * `notCheckedFor`) and a sanitized `error` string when a source crashed.
 *
 * Title metadata-match rule (H3): a hand-rolled token-set ratio over the
 * normalised title tokens, so subtitle presence ("Liberty" vs "Liberty: A
 * Study") and word reordering do not cause a false metadata-mismatch.
 * Normalised Levenshtein is kept only as a tiebreaker for near-identical
 * titles where the token sets diverge. Ratio ≥ 0.85 → match.
 *
 * First-author match:
 *   Case-insensitive substring of first-author surname in any metadata
 *   author string.
 *
 * Identifier short-circuit (T21/T22): a malformed or bad-checksum DOI/ISBN is
 * a strong, cheap fabrication signal and cannot be looked up; callers pass
 * `identifierInvalid` so the network call is skipped and the entry is recorded
 * as `unverifiable` with a note (it is already gating via
 * `summary.malformedIdentifiers`).
 *
 * WorldCat (OCLC Classify) was removed in 0.2.0 — the endpoint was
 * decommissioned in 2019 (see tmp/design-review/worldcat.md). ISBN existence
 * is covered by OpenLibrary.
 */

import { distance } from 'fastest-levenshtein';
import { HttpError } from './http.js';
import type { CslEntry } from './schema/csl.js';
import type {
  CheckDimension,
  ExistenceCheck,
  ExistenceEvidence,
  ExistenceLayer,
  ExistenceStatus,
} from './schema/output.js';
import type { CrossRefClient } from './databases/crossref.js';
import type { OpenAlexClient } from './databases/openalex.js';
import type { OpenLibraryClient } from './databases/openlibrary.js';
import type { DatabaseLookupResult } from './databases/crossref.js';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface RunExistenceDeps {
  bibliography: CslEntry[];
  clients: {
    crossref: CrossRefClient;
    openalex: OpenAlexClient;
    openlibrary: OpenLibraryClient;
  };
  /**
   * Citekeys whose local identifier validation (T21) failed
   * (malformed/bad-checksum DOI or ISBN). These SKIP the network existence
   * call and are recorded as `unverifiable` — a malformed identifier cannot
   * be looked up and is already a gating finding via
   * `summary.malformedIdentifiers`.
   */
  identifierInvalid?: ReadonlySet<string>;
  signal: AbortSignal;
}

export interface RunExistenceResult {
  entries: Array<Pick<{ citekey: string; existence: ExistenceLayer }, 'citekey' | 'existence'>>;
}

// ---------------------------------------------------------------------------
// Author helpers
// ---------------------------------------------------------------------------

export function getFirstAuthorSurname(entry: CslEntry): string | undefined {
  const first = entry.author?.[0];
  if (first === undefined) return undefined;
  return first.family ?? first.literal?.split(/\s+/).pop();
}

export function getAllAuthorNames(entry: CslEntry): string[] {
  return (entry.author ?? []).map((a) => a.family ?? a.literal ?? '').filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// Title normalisation and fuzzy match (H3: token-set ratio)
// ---------------------------------------------------------------------------

/**
 * Normalise a title for comparison: lowercase, strip non-alphanumeric runs
 * (punctuation + whitespace), collapse to single spaces.
 */
function normaliseTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Split a normalised title into a de-duplicated set of word tokens. */
function tokenSet(t: string): Set<string> {
  const norm = normaliseTitle(t);
  if (norm === '') return new Set();
  return new Set(norm.split(' '));
}

/**
 * Token-set ratio: |intersection| / |smaller set|. This is deliberately
 * asymmetric in favour of subset relationships — when one title is a subset of
 * the other (e.g. "Liberty" ⊂ "Liberty A Study"), every token of the smaller
 * set is present, so the ratio is 1.0 and the titles match. Word reordering
 * has no effect because sets are unordered.
 */
function tokenSetRatio(a: Set<string>, b: Set<string>): number {
  const smaller = a.size <= b.size ? a : b;
  const larger = a.size <= b.size ? b : a;
  if (smaller.size === 0) return larger.size === 0 ? 1 : 0;
  let inter = 0;
  for (const tok of smaller) {
    if (larger.has(tok)) inter += 1;
  }
  return inter / smaller.size;
}

/**
 * Returns true if the two title strings are close enough to be the same work.
 *
 * Primary metric is the token-set ratio (≥ 0.85), which is robust to subtitle
 * presence and word reordering. As a tiebreaker (e.g. single-token titles with
 * a small typo, where the token sets are disjoint but the strings are close),
 * the normalised Levenshtein ratio (≥ 0.85) is consulted.
 */
export function titlesMatch(a: string, b: string): boolean {
  const na = normaliseTitle(a);
  const nb = normaliseTitle(b);
  if (na === nb) return true;

  const setA = tokenSet(a);
  const setB = tokenSet(b);
  if (tokenSetRatio(setA, setB) >= 0.85) return true;

  // Levenshtein tiebreaker: catches near-identical titles whose tokenisation
  // diverges (typos, hyphenation differences across single tokens).
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return true;
  const d = distance(na, nb);
  const ratio = 1 - d / maxLen;
  return ratio >= 0.85;
}

/**
 * Returns true if the first-author surname of the entry appears (case-
 * insensitively) as a substring in at least one of the metadata author strings.
 */
function authorsMatch(surname: string, metaAuthors: string[]): boolean {
  const lower = surname.toLowerCase();
  return metaAuthors.some((a) => a.toLowerCase().includes(lower));
}

// ---------------------------------------------------------------------------
// Metadata comparison
// ---------------------------------------------------------------------------

type MatchResult = 'found' | 'metadata-mismatch';

function compareMetadata(entry: CslEntry, meta: DatabaseLookupResult['metadata']): MatchResult {
  if (meta === null) return 'metadata-mismatch';

  const entryTitle = entry.title;
  const metaTitle = meta.title;
  const titleOk =
    entryTitle === undefined || metaTitle === undefined || titlesMatch(entryTitle, metaTitle);

  const surname = getFirstAuthorSurname(entry);
  const metaAuthors = meta.authors ?? [];
  const authorOk =
    surname === undefined || metaAuthors.length === 0 || authorsMatch(surname, metaAuthors);

  return titleOk && authorOk ? 'found' : 'metadata-mismatch';
}

// ---------------------------------------------------------------------------
// Per-source check builders
// ---------------------------------------------------------------------------

function lookupResultToCheck(
  source: ExistenceCheck['source'],
  entry: CslEntry,
  lookup: DatabaseLookupResult,
): ExistenceCheck {
  if (!lookup.found) {
    return { source, result: 'not-found', evidence: null };
  }
  const matchResult = compareMetadata(entry, lookup.metadata);
  return {
    source,
    result: matchResult,
    evidence: lookup.metadata as unknown ?? null,
  };
}

/**
 * Strip `mailto=<value>` query params from any URL embedded in a free-text
 * error message, so the polite-pool email never reaches the output. We cannot
 * rely on `sanitizeMailto` here because that only rewrites strings that ARE a
 * URL; an HttpError message like "GET https://…?mailto=x failed" is a sentence
 * with a URL inside it.
 */
function sanitizeErrorMessage(message: string): string {
  return message.replace(/([?&])mailto=[^&\s]*/gi, (_m, sep: string) =>
    sep === '?' ? '?' : '',
  );
}

async function safeCall(
  source: ExistenceCheck['source'],
  fn: () => Promise<DatabaseLookupResult>,
  entry: CslEntry,
): Promise<ExistenceCheck> {
  try {
    const result = await fn();
    return lookupResultToCheck(source, entry, result);
  } catch (err) {
    if (err instanceof HttpError) {
      // Sanitize so a ?mailto= / API key in the message cannot leak into output.
      const message = sanitizeErrorMessage(err.message);
      return { source, result: 'error', evidence: { error: message } };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Status derivation
// ---------------------------------------------------------------------------

function deriveStatus(checks: ExistenceCheck[]): ExistenceStatus {
  const results = new Set(checks.map((c) => c.result));

  if (results.has('found')) return 'verified';
  if (results.has('metadata-mismatch')) return 'metadata-mismatch';
  if (results.has('not-found')) {
    // Only 'not-found' (and possibly 'error') entries — but at least one confirmed absence.
    if ([...results].every((r) => r === 'not-found' || r === 'error')) {
      // If there is at least one 'not-found', report that even if some errored.
      return 'not-found-in-databases';
    }
  }
  // All 'error' or all 'no-doi'.
  return 'unverifiable';
}

// ---------------------------------------------------------------------------
// Evidence vocabulary (Q2)
// ---------------------------------------------------------------------------

/**
 * Map an existence status to its evidence vocabulary: the discrete
 * evidence level plus the explicit checkedFor / notCheckedFor dimensions.
 * `claim-support` is ALWAYS in notCheckedFor (bibcheck never verifies whether
 * the source supports the prose's claim — that is the manual worklist's job).
 */
const ALL_DIMENSIONS: readonly CheckDimension[] = [
  'existence',
  'metadata',
  'canonical-url',
  'claim-support',
];

function evidenceFor(status: ExistenceStatus): {
  evidence: ExistenceEvidence;
  checkedFor: CheckDimension[];
} {
  switch (status) {
    case 'verified':
      return { evidence: 'exists-metadata-match', checkedFor: ['existence', 'metadata'] };
    case 'metadata-mismatch':
      return { evidence: 'exists-metadata-mismatch', checkedFor: ['existence', 'metadata'] };
    case 'not-found-in-databases':
      return { evidence: 'absent', checkedFor: ['existence'] };
    case 'unverifiable':
      return { evidence: 'unverifiable', checkedFor: [] };
  }
}

/**
 * Build a complete ExistenceLayer from the per-source checks: derive the
 * status, attach the evidence vocabulary, and surface a sanitized top-level
 * error when EVERY check crashed (vs. a clean unverifiable result).
 */
function buildLayer(checks: ExistenceCheck[]): ExistenceLayer {
  const status = deriveStatus(checks);
  const { evidence, checkedFor } = evidenceFor(status);
  const notCheckedFor = ALL_DIMENSIONS.filter((d) => !checkedFor.includes(d));

  // Surface a top-level error only when the layer failed to run cleanly: all
  // checks were transport errors. (A mix of error + not-found is a real
  // not-found-in-databases result and is not flagged as an error.)
  let error: string | null = null;
  if (checks.length > 0 && checks.every((c) => c.result === 'error')) {
    const first = checks.find((c) => c.result === 'error');
    const ev = first?.evidence;
    if (ev !== null && typeof ev === 'object' && 'error' in ev) {
      error = String((ev as { error: unknown }).error);
    } else {
      error = 'All existence sources failed.';
    }
  }

  return { status, evidence, checkedFor, notCheckedFor, checks, error };
}

// ---------------------------------------------------------------------------
// Per-entry processing
// ---------------------------------------------------------------------------

/**
 * Build the unverifiable layer for an entry whose local identifier validation
 * (T21) failed. The network existence call is skipped entirely.
 */
function identifierInvalidLayer(): ExistenceLayer {
  const checks: ExistenceCheck[] = [
    {
      source: 'crossref',
      result: 'error',
      evidence: { error: 'Identifier validation failed; existence lookup skipped.' },
    },
  ];
  const { evidence, checkedFor } = evidenceFor('unverifiable');
  const notCheckedFor = ALL_DIMENSIONS.filter((d) => !checkedFor.includes(d));
  return {
    status: 'unverifiable',
    evidence,
    checkedFor,
    notCheckedFor,
    checks,
    error: 'Identifier validation failed; existence lookup skipped.',
  };
}

async function processEntry(
  entry: CslEntry,
  clients: RunExistenceDeps['clients'],
  signal: AbortSignal,
): Promise<ExistenceLayer> {
  const checks: ExistenceCheck[] = [];

  if (entry.doi !== undefined && entry.doi !== '') {
    // DOI route: CrossRef + OpenAlex in parallel.
    const [crCheck, oaCheck] = await Promise.all([
      safeCall('crossref', () => clients.crossref.lookupByDoi(entry.doi!, signal), entry),
      safeCall('openalex', () => clients.openalex.lookupByDoi(entry.doi!, signal), entry),
    ]);
    checks.push(crCheck, oaCheck);
  } else if (entry.isbn !== undefined && entry.isbn !== '') {
    // ISBN route: OpenLibrary (the keyless ISBN source; WorldCat removed).
    const olCheck = await safeCall(
      'openlibrary',
      () => clients.openlibrary.lookupByIsbn(entry.isbn!, signal),
      entry,
    );
    checks.push(olCheck);
  } else if (entry.title !== undefined && entry.title !== '') {
    // Title-search route: OpenAlex only.
    const authors = getAllAuthorNames(entry);
    const oaCheck = await safeCall(
      'openalex',
      () => clients.openalex.searchByTitleAuthor(entry.title!, authors, signal),
      entry,
    );
    checks.push(oaCheck);
  } else {
    // No identifier — unverifiable.
    checks.push({ source: 'crossref', result: 'no-doi', evidence: null });
  }

  return buildLayer(checks);
}

// ---------------------------------------------------------------------------
// runExistence
// ---------------------------------------------------------------------------

export async function runExistence(deps: RunExistenceDeps): Promise<RunExistenceResult> {
  const { bibliography, clients, identifierInvalid, signal } = deps;
  const entries: RunExistenceResult['entries'] = [];

  for (const entry of bibliography) {
    if (signal.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error('Aborted');
    }
    // Skip the network call when local identifier validation already failed.
    const existence =
      identifierInvalid?.has(entry.citekey) === true
        ? identifierInvalidLayer()
        : await processEntry(entry, clients, signal);
    entries.push({ citekey: entry.citekey, existence });
  }

  return { entries };
}
