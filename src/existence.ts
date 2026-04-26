/**
 * Existence subcommand — commodity convenience layer.
 *
 * For each CSL-JSON bibliography entry, performs DOI/ISBN/title-search
 * lookups against CrossRef, OpenAlex, OpenLibrary, and WorldCat, then
 * assigns an ExistenceStatus based on the best result across all tried
 * sources.
 *
 * Metadata-match rule (title):
 *   normalised Levenshtein ratio = 1 - distance(a, b) / max(|a|, |b|)
 *   Strings are lowercased and punctuation/whitespace collapsed before
 *   comparison. Ratio ≥ 0.85 → match.
 *
 * First-author match:
 *   Case-insensitive substring of first-author surname in any metadata
 *   author string.
 */

import { distance } from 'fastest-levenshtein';
import { HttpError } from './http.js';
import type { CslEntry } from './schema/csl.js';
import type {
  ExistenceCheck,
  ExistenceLayer,
  ExistenceStatus,
} from './schema/output.js';
import type { CrossRefClient } from './databases/crossref.js';
import type { OpenAlexClient } from './databases/openalex.js';
import type { OpenLibraryClient } from './databases/openlibrary.js';
import type { WorldCatClient } from './databases/worldcat.js';
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
    worldcat: WorldCatClient;
  };
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
// Title normalisation and fuzzy match
// ---------------------------------------------------------------------------

/**
 * Normalise a title for fuzzy comparison: lowercase, strip non-alphanumeric
 * runs (punctuation + whitespace), collapse to single spaces.
 */
function normaliseTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Returns true if the two title strings are close enough to be the same work.
 * Uses normalised Levenshtein ratio ≥ 0.85.
 */
export function titlesMatch(a: string, b: string): boolean {
  const na = normaliseTitle(a);
  const nb = normaliseTitle(b);
  if (na === nb) return true;
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
      return { source, result: 'error', evidence: { error: err.message } };
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
// Per-entry processing
// ---------------------------------------------------------------------------

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
    // ISBN route: OpenLibrary + WorldCat in parallel.
    const [olCheck, wcCheck] = await Promise.all([
      safeCall('openlibrary', () => clients.openlibrary.lookupByIsbn(entry.isbn!, signal), entry),
      safeCall('worldcat', () => clients.worldcat.lookupByIsbn(entry.isbn!, signal), entry),
    ]);
    checks.push(olCheck, wcCheck);
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

  const status = deriveStatus(checks);
  return { status, checks };
}

// ---------------------------------------------------------------------------
// runExistence
// ---------------------------------------------------------------------------

export async function runExistence(deps: RunExistenceDeps): Promise<RunExistenceResult> {
  const { bibliography, clients, signal } = deps;
  const entries: RunExistenceResult['entries'] = [];

  for (const entry of bibliography) {
    if (signal.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error('Aborted');
    }
    const existence = await processEntry(entry, clients, signal);
    entries.push({ citekey: entry.citekey, existence });
  }

  return { entries };
}
