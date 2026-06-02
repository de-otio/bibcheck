/**
 * `bibcheck check` orchestrator.
 *
 * Composes all five subcommands (existence, canonical, linkage, phrases,
 * worklist) and assembles the top-level Output.
 *
 * Design notes:
 * - Subcommands run sequentially for deterministic log output.
 * - Each subcommand runs with its own 5-minute deadline.
 * - If a subcommand throws, the error is caught, logged, and a degraded
 *   (error-flavored) result is emitted for that layer; the run continues.
 * - The final Output is validated against OutputSchema before return.
 */

import { readFile as nodeReadFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import type { Config } from './config.js';
import type { CslEntry } from './schema/csl.js';
import type { CompiledPattern } from './phrases/load.js';
import type { HttpClient } from './http.js';
import type { Cache } from './cache/fs-cache.js';
import type {
  Output,
  Entry,
  ExistenceLayer,
  CanonicalLayer,
  IdentifiersLayer,
} from './schema/output.js';
import { OutputSchema, SCHEMA_VERSION } from './schema/output.js';

import { loadBibliography, BibliographyParseError } from './schema/csl.js';
import { loadDenylist, PhraseLoaderError } from './phrases/load.js';
import { createFsCache } from './cache/fs-cache.js';
import { createHttpClient } from './http.js';
import {
  createCrossRefClient,
  createOpenAlexClient,
  createOpenLibraryClient,
} from './databases/index.js';

import { runExistence } from './existence.js';
import type { RunExistenceDeps, RunExistenceResult } from './existence.js';
import { runIdentifiers } from './identifiers.js';

import { runCanonical } from './canonical.js';
import type { RunCanonicalDeps, RunCanonicalResult } from './canonical.js';

import { runLinkage } from './linkage.js';
import type { RunLinkageDeps, RunLinkageResult } from './linkage.js';

import { runPhrases } from './phrases.js';
import type { RunPhrasesDeps, RunPhrasesResult } from './phrases.js';

import { runWorklist } from './worklist.js';
import type { RunWorklistDeps, RunWorklistResult } from './worklist.js';

// ---------------------------------------------------------------------------
// Logger interface
// ---------------------------------------------------------------------------

export interface Logger {
  info(event: string, ctx?: Record<string, unknown>): void;
  warn(event: string, ctx?: Record<string, unknown>): void;
  error(event: string, ctx?: Record<string, unknown>): void;
}

const noopLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

// ---------------------------------------------------------------------------
// RunCheckDeps
// ---------------------------------------------------------------------------

export interface RunCheckDeps {
  config: Config;
  cwd: string;
  bibliography: CslEntry[];
  patterns: CompiledPattern[];       // empty array if no denylist configured
  http: HttpClient;
  cache: Cache;
  logger: Logger;
  signal: AbortSignal;
  // Skip selection (used by per-subcommand CLI invocations)
  skip?: ReadonlySet<'existence' | 'canonical' | 'linkage' | 'phrases' | 'worklist'>;
  // Optional injection point for readFile (for tests)
  readFile?: (path: string) => Promise<string>;
  // Optional injectable subcommand functions (for tests)
  _runExistence?: (deps: RunExistenceDeps) => Promise<RunExistenceResult>;
  _runCanonical?: (deps: RunCanonicalDeps) => Promise<RunCanonicalResult>;
  _runLinkage?: (deps: RunLinkageDeps) => Promise<RunLinkageResult>;
  _runPhrases?: (deps: RunPhrasesDeps) => Promise<RunPhrasesResult>;
  _runWorklist?: (deps: RunWorklistDeps) => Promise<RunWorklistResult>;
}

// ---------------------------------------------------------------------------
// BuildCheckDepsOptions
// ---------------------------------------------------------------------------

export interface BuildCheckDepsOptions {
  config: Config;
  cwd: string;
  signal: AbortSignal;
  logger?: Logger;
  userAgent?: string;
}

// ---------------------------------------------------------------------------
// buildCheckDeps
// ---------------------------------------------------------------------------

export async function buildCheckDeps(opts: BuildCheckDepsOptions): Promise<RunCheckDeps> {
  const {
    config,
    cwd,
    signal,
    userAgent,
  } = opts;
  const logger = opts.logger ?? noopLogger;

  // Load bibliography
  let bibliography: CslEntry[];
  try {
    bibliography = await loadBibliography({ path: config.bibliography.file, cwd });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('bibliography.load_failed', { error: message });
    throw err instanceof BibliographyParseError ? err : new BibliographyParseError(message, err);
  }

  // Load phrase denylist (failures are non-fatal)
  let patterns: CompiledPattern[] = [];
  if (config.phrases.file !== null) {
    try {
      patterns = await loadDenylist({ path: config.phrases.file, cwd });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('phrases.load_failed', { error: message });
      if (!(err instanceof PhraseLoaderError)) {
        logger.warn('phrases.unexpected_error', { error: message });
      }
      patterns = [];
    }
  }

  // Create cache
  const cache = createFsCache({
    dir: path.resolve(cwd, config.cache.dir),
    maxSizeMb: config.cache.max_size_mb ?? null,
  });

  // Create HTTP client
  const http = createHttpClient({
    userAgent: userAgent ?? 'bibcheck/0.0.0',
    defaultTimeoutMs: 10_000,
    maxRetries: 2,
    perOriginConcurrency: 2,
  });

  return {
    config,
    cwd,
    bibliography,
    patterns,
    http,
    cache,
    logger,
    signal,
  };
}

// ---------------------------------------------------------------------------
// Degraded result builders
// ---------------------------------------------------------------------------

function degradedExistenceLayer(message: string): ExistenceLayer {
  return {
    status: 'unverifiable',
    evidence: 'unverifiable',
    checkedFor: [],
    notCheckedFor: ['existence', 'metadata', 'canonical-url', 'claim-support'],
    checks: [{ source: 'crossref', result: 'error', evidence: { error: message } }],
    error: message,
  };
}

function degradedCanonicalLayer(): CanonicalLayer {
  return { status: 'not-applicable', url: null };
}

// ---------------------------------------------------------------------------
// Tool version
// ---------------------------------------------------------------------------

async function readPackageVersion(): Promise<string> {
  try {
    const thisFile = fileURLToPath(import.meta.url);
    // Traverse up from dist/ or src/ to find package.json
    let dir = path.dirname(thisFile);
    for (let i = 0; i < 4; i++) {
      const candidate = path.join(dir, 'package.json');
      try {
        const raw = await nodeReadFile(candidate, 'utf-8');
        const parsed = JSON.parse(raw) as { version?: string };
        if (typeof parsed.version === 'string') return parsed.version;
      } catch {
        // not found at this level
      }
      dir = path.dirname(dir);
    }
  } catch {
    // ignore
  }
  return '0.0.0';
}

// ---------------------------------------------------------------------------
// runCheck
// ---------------------------------------------------------------------------

/**
 * Orchestrates all five subcommands and assembles the validated Output.
 *
 * Subcommands run sequentially. Each has a 5-minute deadline via
 * `AbortSignal.any([deps.signal, AbortSignal.timeout(300_000)])`.
 *
 * If a subcommand throws (including timeout), the error is caught, logged,
 * and a degraded result is emitted for that layer. The run continues with
 * remaining subcommands.
 */
export async function runCheck(deps: RunCheckDeps): Promise<Output> {
  const {
    config,
    cwd,
    bibliography,
    patterns,
    http,
    cache,
    logger,
    signal,
    skip,
    readFile = (p: string) => nodeReadFile(p, 'utf-8'),
    _runExistence: doRunExistence = runExistence,
    _runCanonical: doRunCanonical = runCanonical,
    _runLinkage: doRunLinkage = runLinkage,
    _runPhrases: doRunPhrases = runPhrases,
    _runWorklist: doRunWorklist = runWorklist,
  } = deps;

  const SUBCOMMAND_TIMEOUT_MS = 300_000; // 5 minutes

  function subSignal(): AbortSignal {
    return AbortSignal.any([signal, AbortSignal.timeout(SUBCOMMAND_TIMEOUT_MS)]);
  }

  // Per-entry maps: citekey → layer result
  const identifiersMap = new Map<string, IdentifiersLayer | null>();
  const existenceMap = new Map<string, ExistenceLayer | null>();
  const canonicalMap = new Map<string, CanonicalLayer | null>();

  // Pre-populate maps with null (skipped) for all bibliography entries
  for (const entry of bibliography) {
    identifiersMap.set(entry.citekey, null);
    existenceMap.set(entry.citekey, null);
    canonicalMap.set(entry.citekey, null);
  }

  // --- identifiers (Layer 0: pure, local, pre-network well-formedness) ---
  // Always run when existence runs: a malformed/bad-checksum identifier is a
  // cheap fabrication signal that both gates (summary.malformedIdentifiers)
  // and short-circuits the network existence call. Skipped only when the
  // existence layer itself is skipped (no point validating ids we won't use).
  const identifierInvalid = new Set<string>();
  if (!skip?.has('existence')) {
    const idResult = runIdentifiers({ bibliography });
    for (const e of idResult.entries) {
      identifiersMap.set(e.citekey, e.identifiers);
      const ids = e.identifiers;
      // A DOI/ISBN that is present but malformed/bad-checksum cannot be looked
      // up. (A bad URL does not block existence — existence keys off DOI/ISBN/
      // title — but still counts toward malformedIdentifiers in the summary.)
      if (
        ids.doi === 'malformed' ||
        ids.isbn === 'malformed' ||
        ids.isbn === 'bad-checksum'
      ) {
        identifierInvalid.add(e.citekey);
      }
    }
  }

  // --- existence ---
  if (!skip?.has('existence')) {
    try {
      const crossref = createCrossRefClient({
        http,
        cache,
        mailto: config.apis.crossref_mailto ?? undefined,
        baseUrl: config.apis.crossref_base,
      });
      const openalex = createOpenAlexClient({
        http,
        cache,
        mailto: config.apis.openalex_mailto ?? undefined,
        baseUrl: config.apis.openalex_base,
      });
      const openlibrary = createOpenLibraryClient({
        http,
        cache,
        baseUrl: config.apis.openlibrary_base,
      });

      const existenceDeps: RunExistenceDeps = {
        bibliography,
        clients: { crossref, openalex, openlibrary },
        identifierInvalid,
        signal: subSignal(),
      };

      const result = await doRunExistence(existenceDeps);
      for (const e of result.entries) {
        existenceMap.set(e.citekey, e.existence);
      }

      // Surface transport failures explicitly. An entry whose existence checks
      // are *all* transport errors (DNS/connect failure, 5xx after retries)
      // must not be silently treated as a clean "unverifiable" pass. We emit a
      // clear, actionable top-level message so the failure is not masked as
      // success. Entries deliberately skipped for a malformed identifier are
      // excluded — their all-error checks are an intentional short-circuit,
      // not a connectivity problem.
      const transportFailed = result.entries.filter(
        (e) =>
          !identifierInvalid.has(e.citekey) &&
          e.existence.checks.length > 0 &&
          e.existence.checks.every((c) => c.result === 'error'),
      );
      if (transportFailed.length > 0) {
        logger.error('existence.transport_failure', {
          message:
            'Could not reach one or more bibliographic databases. ' +
            'Existence could not be verified — this is a connectivity error, ' +
            'not a confirmation that the works are absent. Check your network ' +
            'connection and the [apis] base URLs in bibcheck.toml.',
          affectedEntries: transportFailed.map((e) => e.citekey),
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('existence.failed', { error: message });
      // Emit degraded existence for all entries
      for (const entry of bibliography) {
        existenceMap.set(entry.citekey, degradedExistenceLayer(message));
      }
    }
  }

  // --- canonical ---
  if (!skip?.has('canonical')) {
    try {
      const canonicalDeps: RunCanonicalDeps = {
        config,
        bibliography,
        http,
        cache,
        signal: subSignal(),
      };

      const result = await doRunCanonical(canonicalDeps);
      for (const e of result.entries) {
        canonicalMap.set(e.citekey, e.canonical ?? null);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('canonical.failed', { error: message });
      // Emit degraded canonical for all entries
      for (const entry of bibliography) {
        canonicalMap.set(entry.citekey, degradedCanonicalLayer());
      }
    }
  }

  // --- linkage ---
  let linkageResult: RunLinkageResult = { linkage: [] };
  if (!skip?.has('linkage')) {
    try {
      const linkageDeps: RunLinkageDeps = {
        config,
        cwd,
        bibliography,
        readFile,
        signal: subSignal(),
      };
      linkageResult = await doRunLinkage(linkageDeps);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('linkage.failed', { error: message });
    }
  }

  // --- phrases ---
  let phrasesResult: RunPhrasesResult = { phraseFlags: [] };
  if (!skip?.has('phrases')) {
    try {
      const phrasesDeps: RunPhrasesDeps = {
        config,
        cwd,
        patterns,
        readFile,
        signal: subSignal(),
      };
      phrasesResult = await doRunPhrases(phrasesDeps);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('phrases.failed', { error: message });
    }
  }

  // --- worklist ---
  let worklistResult: RunWorklistResult = { worklist: [] };
  if (!skip?.has('worklist')) {
    try {
      const worklistDeps: RunWorklistDeps = {
        config,
        cwd,
        bibliography,
        readFile,
        signal: subSignal(),
      };
      worklistResult = await doRunWorklist(worklistDeps);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('worklist.failed', { error: message });
    }
  }

  // --- Assemble entries ---
  const entries: Entry[] = bibliography.map((bib) => ({
    citekey: bib.citekey,
    identifiers: identifiersMap.get(bib.citekey) ?? null,
    existence: existenceMap.get(bib.citekey) ?? null,
    canonical: canonicalMap.get(bib.citekey) ?? null,
  }));

  // --- Compute summary ---
  const CANONICAL_ISSUE_STATUSES = new Set([
    'wrong-host',
    'dead-url',
    'live-url-not-archived-snapshot',
    'no-url-on-pre-doi-entry',
  ] as const);

  const totalEntries = bibliography.length;

  // The four existence buckets PARTITION the entries: every entry lands in
  // exactly one, so they reconcile to totalEntries (T20 invariant, enforced by
  // OutputSchema). An entry whose existence layer was not run (null, e.g.
  // existence skipped) is treated as `unverifiable` for the partition — we
  // could not place it in any database, so it is not verified/mismatched/absent.
  let verified = 0;
  let metadataMismatches = 0;
  let notFoundInDatabases = 0;
  let unverifiable = 0;
  let malformedIdentifiers = 0;
  let canonicalIssues = 0;

  for (const entry of entries) {
    const ex = entry.existence;
    const can = entry.canonical;
    const ids = entry.identifiers;

    const status = ex?.status ?? 'unverifiable';
    switch (status) {
      case 'verified':
        verified += 1;
        break;
      case 'metadata-mismatch':
        metadataMismatches += 1;
        break;
      case 'not-found-in-databases':
        notFoundInDatabases += 1;
        break;
      case 'unverifiable':
        unverifiable += 1;
        break;
    }

    // Malformed-identifier count (T21): any entry with a malformed/bad-checksum
    // DOI/ISBN/URL. Overlaps the existence buckets (those entries are
    // unverifiable) — it is a separate fabrication-signal counter, not a fifth
    // bucket. Gates by default.
    if (
      ids !== null &&
      (ids.doi === 'malformed' ||
        ids.isbn === 'malformed' ||
        ids.isbn === 'bad-checksum' ||
        ids.url === 'malformed')
    ) {
      malformedIdentifiers += 1;
    }

    if (
      can !== null &&
      CANONICAL_ISSUE_STATUSES.has(
        can.status as typeof CANONICAL_ISSUE_STATUSES extends Set<infer T> ? T : never,
      )
    ) {
      canonicalIssues += 1;
    }
  }

  const linkageFailures = linkageResult.linkage.filter((l) => l.status === 'unresolved').length;
  const phraseFlags = phrasesResult.phraseFlags.filter((f) => f.status === 'flagged').length;
  const worklistItems = worklistResult.worklist.length;

  const summary = {
    totalEntries,
    verified,
    metadataMismatches,
    notFoundInDatabases,
    malformedIdentifiers,
    unverifiable,
    canonicalIssues,
    linkageFailures,
    phraseFlags,
    worklistItems,
  };

  // --- Tool info ---
  const version = await readPackageVersion();

  const output: Output = {
    schemaVersion: SCHEMA_VERSION,
    tool: { name: 'bibcheck', version },
    summary,
    entries,
    linkage: linkageResult.linkage,
    phraseFlags: phrasesResult.phraseFlags,
    worklist: worklistResult.worklist,
  };

  // --- Validate ---
  const parsed = OutputSchema.safeParse(output);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const msg = firstIssue
      ? `${firstIssue.path.join('.')}: ${firstIssue.message}`
      : parsed.error.message;
    logger.error('output.schema_invalid', { error: msg });
    throw new Error(`Output failed schema validation (bibcheck bug): ${msg}`);
  }

  return parsed.data;
}

// ---------------------------------------------------------------------------
// CHECK_NON_ZERO_REASON
// ---------------------------------------------------------------------------

export const CHECK_NON_ZERO_REASON = {
  flagged_phrase: 'flagged_phrase',
  unresolved_linkage: 'unresolved_linkage',
  canonical_issue: 'canonical_issue',
  metadata_mismatch: 'metadata_mismatch',
  // NEW in 0.2.0 (T22): secure-default gating (Q1). Both fire unconditionally
  // until T23 layers source-type exemptions and per-finding suppression on top.
  not_found_in_databases: 'not_found_in_databases',
  malformed_identifier: 'malformed_identifier',
} as const;

// ---------------------------------------------------------------------------
// checkExitReasons
// ---------------------------------------------------------------------------

const CANONICAL_EXIT_STATUSES = new Set([
  'dead-url',
  'wrong-host',
  'no-url-on-pre-doi-entry',
  'live-url-not-archived-snapshot',
]);

/**
 * Returns the list of finding kinds that should cause a non-zero exit.
 * Empty array → exit 0.
 *
 * Rules:
 *   - 'flagged_phrase' if any phraseFlags[].status === 'flagged'
 *   - 'unresolved_linkage' if any linkage[].status === 'unresolved'
 *   - 'canonical_issue' if any entry's canonical.status is in the problem set
 *   - 'metadata_mismatch' if any entry's existence.status === 'metadata-mismatch'
 *   - 'not_found_in_databases' if any entry's existence.status ===
 *     'not-found-in-databases' (B1 fix — absence is a fabrication signal and
 *     gates by default per Q1)
 *   - 'malformed_identifier' if summary.malformedIdentifiers > 0 (a malformed
 *     DOI/ISBN/URL is a cheap fabrication signal and gates by default)
 *
 * Does NOT trigger non-zero exit:
 *   - acknowledged phrases
 *   - worklist items
 *   - unverifiable existence (graceful degradation)
 *
 * T23 SEAM: the not-found / malformed gates are unconditional here. T23 layers
 * source-type exemptions (e.g. pre-DOI primary sources) and a per-finding
 * allow-with-reason suppression mechanism on top of these two reasons — it
 * will filter which entries reach the `some(...)` predicates below (e.g. via a
 * suppression set / source-type policy passed into this function), NOT remove
 * the gate itself. Until T23 lands, every not-found / malformed finding gates.
 */
export function checkExitReasons(output: Output): string[] {
  const reasons: string[] = [];

  if (output.phraseFlags.some((f) => f.status === 'flagged')) {
    reasons.push(CHECK_NON_ZERO_REASON.flagged_phrase);
  }

  if (output.linkage.some((l) => l.status === 'unresolved')) {
    reasons.push(CHECK_NON_ZERO_REASON.unresolved_linkage);
  }

  if (
    output.entries.some(
      (e) => e.canonical !== null && CANONICAL_EXIT_STATUSES.has(e.canonical.status),
    )
  ) {
    reasons.push(CHECK_NON_ZERO_REASON.canonical_issue);
  }

  if (output.entries.some((e) => e.existence !== null && e.existence.status === 'metadata-mismatch')) {
    reasons.push(CHECK_NON_ZERO_REASON.metadata_mismatch);
  }

  // --- T23 SEAM (Q1 secure default): not-found + malformed gate by default ---
  if (
    output.entries.some(
      (e) => e.existence !== null && e.existence.status === 'not-found-in-databases',
    )
  ) {
    reasons.push(CHECK_NON_ZERO_REASON.not_found_in_databases);
  }

  if (output.summary.malformedIdentifiers > 0) {
    reasons.push(CHECK_NON_ZERO_REASON.malformed_identifier);
  }

  return reasons;
}
