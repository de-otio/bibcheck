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

import {
  isGated,
  parseAllowsForBibliography,
  type ParsedAllow,
  type FindingType,
} from './suppression.js';

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
import { createHttpClient, isPrivateApiBase } from './http.js';
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

  // Create HTTP client. If the operator has explicitly pointed any DB API base
  // at a private/loopback host (e.g. a local stub or mirror), honor that
  // deliberate config by allowing private hosts. The per-hop SSRF guard still
  // protects untrusted bibliography URLs in the default (public-API) case.
  const allowPrivateHosts =
    isPrivateApiBase(config.apis.crossref_base) ||
    isPrivateApiBase(config.apis.openalex_base) ||
    isPrivateApiBase(config.apis.openlibrary_base);
  const http = createHttpClient({
    userAgent: userAgent ?? 'bibcheck/0.0.0',
    defaultTimeoutMs: 10_000,
    maxRetries: 2,
    perOriginConcurrency: 2,
    allowPrivateHosts,
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
  // Reverse linkage (H2): bibliography citekeys never referenced in any doc.
  // Informational only — counted for visibility but NOT added to
  // checkExitReasons, so orphans never affect the exit code.
  const orphanedEntries = linkageResult.linkage.filter((l) => l.status === 'orphan').length;
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
    orphanedEntries,
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

  // --- T23 suppression: warn on reason-less allows + log acknowledged findings ---
  // Reason is MANDATORY: a `bibcheck-allow` with an empty/missing reason does
  // NOT suppress (isGated ignores it); warn so the omission is visible rather
  // than silently ineffective. An unknown finding-type token likewise warns.
  // Suppressed findings stay in the document (totals unchanged) and are logged
  // as informational acknowledgements — never silently dropped.
  {
    const ctx = buildSuppressionContext(config, bibliography);
    const { unknownTypes, reasonless } = parseAllowDiagnostics(bibliography);
    for (const u of reasonless) {
      logger.warn('suppression.allow_missing_reason', {
        citekey: u.citekey,
        findingType: u.findingType,
        message:
          `bibcheck-allow for '${u.findingType}' on @${u.citekey} has no (reason: ...); ` +
          'reason is mandatory, so this allow does NOT suppress. Add a reason to silence the finding.',
      });
    }
    for (const u of unknownTypes) {
      logger.warn('suppression.allow_unknown_type', {
        citekey: u.citekey,
        token: u.token,
        message:
          `bibcheck-allow on @${u.citekey} names unknown finding-type '${u.token}'; ` +
          'this directive suppresses nothing.',
      });
    }
    for (const ack of collectAcknowledgedFindings(output, ctx)) {
      logger.info('check.acknowledged_finding', {
        citekey: ack.citekey,
        findingType: ack.findingType,
        suppressedBy: ack.reason,
        message:
          `@${ack.citekey}: '${ack.findingType}' suppressed by ${ack.reason} ` +
          '(reported as acknowledged, excluded from the build gate).',
      });
    }
  }

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
  // NEW in 0.2.0 (T22): secure-default gating (Q1). Gate by default; T23 layers
  // source-type exemptions and per-finding suppression on top via the optional
  // SuppressionContext passed to checkExitReasons (see below).
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
 * T23 suppression context, passed through from `runCheck` to
 * `checkExitReasons`. Carries the per-entry CSL `type` (not present on the
 * frozen Output schema, but needed to resolve source-type exemptions) plus the
 * parsed per-entry `bibcheck-allow` directives and the config. Pure data.
 */
export interface SuppressionContext {
  config: Config;
  /** citekey → CSL `type` (undefined when the entry has no type). */
  cslTypeByCitekey: ReadonlyMap<string, string | undefined>;
  allows: readonly ParsedAllow[];
}

/** A finding that gated by default would have, but was suppressed (T23). */
export interface AcknowledgedFinding {
  citekey: string;
  findingType: FindingType;
  /** Why it was suppressed: a source-type rule or a per-entry allow. */
  reason: 'source-type' | 'allow';
}

/** True when an entry has any malformed/bad-checksum identifier (gating signal). */
function entryHasMalformedIdentifier(e: Entry): boolean {
  const ids = e.identifiers;
  return (
    ids !== null &&
    (ids.doi === 'malformed' ||
      ids.isbn === 'malformed' ||
      ids.isbn === 'bad-checksum' ||
      ids.url === 'malformed')
  );
}

/**
 * Returns the list of finding kinds that should cause a non-zero exit.
 * Empty array → exit 0.
 *
 * Rules:
 *   - 'flagged_phrase' if any phraseFlags[].status === 'flagged'
 *   - 'unresolved_linkage' if any linkage[].status === 'unresolved'
 *   - 'canonical_issue' if any entry's canonical.status is in the problem set
 *   - 'metadata_mismatch' if any entry's existence.status === 'metadata-mismatch'
 *   - 'not_found_in_databases' if any (non-suppressed) entry's existence.status
 *     === 'not-found-in-databases' (B1 fix — absence is a fabrication signal
 *     and gates by default per Q1)
 *   - 'malformed_identifier' if any (non-suppressed) entry has a malformed
 *     DOI/ISBN/URL (a cheap fabrication signal; gates by default)
 *
 * Does NOT trigger non-zero exit:
 *   - acknowledged phrases
 *   - worklist items
 *   - unverifiable existence (graceful degradation)
 *
 * T23: the optional `ctx` filters WHICH entries reach the gate. A not-found or
 * malformed finding does NOT gate when `isGated` resolves it to a source-type
 * exemption or a valid per-entry allow — the gate itself is unchanged, only the
 * per-entry predicate is narrowed. Suppressed findings remain in the Output
 * document (entries + summary counts) and are NOT removed; they are surfaced as
 * informational acknowledgements (see `collectAcknowledgedFindings`). When
 * `ctx` is omitted, every not-found / malformed finding gates unconditionally
 * (the pre-T23 secure default).
 */
export function checkExitReasons(output: Output, ctx?: SuppressionContext): string[] {
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

  // --- Q1 secure default + T23 suppression: not-found + malformed ---
  // Without a context, both gate unconditionally. With one, each finding is
  // routed through `isGated`; only findings that resolve to `gated: true` count.
  const gatedNotFound = output.entries.some((e) => {
    if (e.existence === null || e.existence.status !== 'not-found-in-databases') return false;
    if (ctx === undefined) return true;
    return isGated({
      citekey: e.citekey,
      findingType: 'not-found',
      cslType: ctx.cslTypeByCitekey.get(e.citekey),
      config: ctx.config,
      allows: ctx.allows as ParsedAllow[],
    }).gated;
  });
  if (gatedNotFound) {
    reasons.push(CHECK_NON_ZERO_REASON.not_found_in_databases);
  }

  const gatedMalformed = output.entries.some((e) => {
    if (!entryHasMalformedIdentifier(e)) return false;
    if (ctx === undefined) return true;
    return isGated({
      citekey: e.citekey,
      findingType: 'malformed-identifier',
      cslType: ctx.cslTypeByCitekey.get(e.citekey),
      config: ctx.config,
      allows: ctx.allows as ParsedAllow[],
    }).gated;
  });
  if (gatedMalformed) {
    reasons.push(CHECK_NON_ZERO_REASON.malformed_identifier);
  }

  return reasons;
}

/**
 * Collect the not-found / malformed findings that WOULD have gated but were
 * suppressed by a source-type exemption or a per-entry allow. These stay in the
 * Output document (totals are unchanged); this list drives the informational
 * `check.acknowledged_finding` log entries, mirroring how an acknowledged
 * phrase is reported rather than dropped. Pure.
 */
export function collectAcknowledgedFindings(
  output: Output,
  ctx: SuppressionContext,
): AcknowledgedFinding[] {
  const acks: AcknowledgedFinding[] = [];
  for (const e of output.entries) {
    const cslType = ctx.cslTypeByCitekey.get(e.citekey);
    if (e.existence !== null && e.existence.status === 'not-found-in-databases') {
      const r = isGated({
        citekey: e.citekey,
        findingType: 'not-found',
        cslType,
        config: ctx.config,
        allows: ctx.allows as ParsedAllow[],
      });
      if (!r.gated && r.reason !== 'default') {
        acks.push({ citekey: e.citekey, findingType: 'not-found', reason: r.reason });
      }
    }
    if (entryHasMalformedIdentifier(e)) {
      const r = isGated({
        citekey: e.citekey,
        findingType: 'malformed-identifier',
        cslType,
        config: ctx.config,
        allows: ctx.allows as ParsedAllow[],
      });
      if (!r.gated && r.reason !== 'default') {
        acks.push({ citekey: e.citekey, findingType: 'malformed-identifier', reason: r.reason });
      }
    }
  }
  return acks;
}

/**
 * Build the T23 suppression context from the config and the loaded
 * bibliography: the citekey → CSL-type map (the frozen Output schema does not
 * carry `type`, but it is needed to resolve source-type exemptions) and the
 * parsed per-entry `bibcheck-allow` directives. Pure. The CLI calls this and
 * passes the result to `checkExitReasons`.
 */
export function buildSuppressionContext(
  config: Config,
  bibliography: CslEntry[],
): SuppressionContext {
  const cslTypeByCitekey = new Map<string, string | undefined>();
  for (const e of bibliography) {
    cslTypeByCitekey.set(e.citekey, e.type);
  }
  const { allows } = parseAllowsForBibliography(
    bibliography.map((e) => ({ citekey: e.citekey, note: e.note })),
  );
  return { config, cslTypeByCitekey, allows };
}

/**
 * Diagnostics over the parsed allows: directives with an unknown finding-type
 * token and valid-type directives whose reason was omitted (reason is
 * mandatory; these do not suppress). Pure; drives the `runCheck` warnings.
 */
function parseAllowDiagnostics(bibliography: CslEntry[]): {
  unknownTypes: { citekey: string; token: string }[];
  reasonless: { citekey: string; findingType: FindingType }[];
} {
  const { allows, unknownTypes } = parseAllowsForBibliography(
    bibliography.map((e) => ({ citekey: e.citekey, note: e.note })),
  );
  const reasonless = allows
    .filter((a) => a.reason === null)
    .map((a) => ({ citekey: a.citekey, findingType: a.findingType }));
  return {
    unknownTypes: unknownTypes.map((u) => ({ citekey: u.citekey, token: u.token })),
    reasonless,
  };
}
