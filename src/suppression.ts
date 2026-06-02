/**
 * Suppression & source-type gating (T23).
 *
 * Makes the secure default (Q1 — `not-found-in-databases` and malformed
 * identifiers gate `bibcheck check` unconditionally) *usable* by giving a
 * reviewer two precise, auditable escape hatches that suppress a single
 * finding without disabling the whole check:
 *
 *   1. Source-type gating rules (broad, declarative). A CSL `type` can opt out
 *      of the not-found gate via `[source_types] <type> = { gate_not_found =
 *      false }` — e.g. a pre-DOI manuscript for which no DOI was ever expected.
 *   2. Per-entry allow-with-reason (specific). An entry's CSL `note` carries a
 *      `bibcheck-allow: <finding-type> (reason: ...)` convention, mirroring the
 *      phrases `<!-- bibcheck-allow: <key> -->` mechanism.
 *
 * This module is PURE: no I/O, no clock, no network. `check.ts` parses the CSL
 * notes into `ParsedAllow[]` and calls `isGated` once per finding; only gated
 * findings count toward the non-zero exit. Suppressed findings are NOT dropped
 * from the output document — they remain in the entries/summary and are
 * reported as `acknowledged` (informational), exactly like an acknowledged
 * phrase.
 */

import type { Config } from './config.js';

// ---------------------------------------------------------------------------
// Finding-type vocabulary
// ---------------------------------------------------------------------------

/**
 * The gating finding kinds a suppression can target. Mirrors the gateable
 * reasons in `check.ts` (`CHECK_NON_ZERO_REASON`):
 *   - 'not-found'            → existence.status === 'not-found-in-databases'
 *   - 'malformed-identifier' → summary.malformedIdentifiers (per entry)
 *   - 'canonical-issue'      → canonical.status in the problem set
 *   - 'metadata-mismatch'    → existence.status === 'metadata-mismatch'
 */
export const FINDING_TYPES = [
  'not-found',
  'malformed-identifier',
  'canonical-issue',
  'metadata-mismatch',
] as const;

export type FindingType = (typeof FINDING_TYPES)[number];

function isFindingType(value: string): value is FindingType {
  return (FINDING_TYPES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Per-entry allow (parsed from the CSL `note` carrier)
// ---------------------------------------------------------------------------

/**
 * A single parsed `bibcheck-allow` directive from an entry's CSL `note`.
 *
 * `reason` is the trimmed text inside `(reason: ...)`. An allow with an empty
 * or missing reason is NOT a valid suppression — it is captured here with
 * `reason: null` so the caller can emit a warning and decline to suppress
 * (reason is MANDATORY; see `parseAllows` / `isGated`).
 */
export interface ParsedAllow {
  citekey: string;
  findingType: FindingType;
  reason: string | null;
  /** The raw directive text, for diagnostics. */
  raw: string;
}

// ---------------------------------------------------------------------------
// Note parsing
//
// Convention (documented in docs/configuration.md):
//   note: "bibcheck-allow: not-found (reason: 1680 pamphlet, Bodleian shelfmark X)"
//
// A single note may carry several directives (one per gateable finding). The
// finding-type token is matched against the known vocabulary; an unknown token
// is reported back so the caller can warn (a typo'd finding type must not
// silently suppress nothing AND must not crash).
// ---------------------------------------------------------------------------

const ALLOW_DIRECTIVE_RE =
  /bibcheck-allow:\s*([\w-]+)\s*(?:\(\s*reason:\s*([^)]*)\)\s*)?/gi;

export interface ParseAllowsResult {
  allows: ParsedAllow[];
  /** Directives whose finding-type token is not a known FindingType. */
  unknownTypes: { citekey: string; token: string; raw: string }[];
}

/**
 * Parse every `bibcheck-allow` directive out of one entry's CSL `note`.
 *
 * Pure. Returns both the valid allows (which may still have `reason: null` when
 * the reason was omitted — the caller decides how to warn) and any directives
 * whose finding-type token is unrecognised.
 */
export function parseAllows(citekey: string, note: string | undefined): ParseAllowsResult {
  const allows: ParsedAllow[] = [];
  const unknownTypes: ParseAllowsResult['unknownTypes'] = [];
  if (note === undefined || note === '') {
    return { allows, unknownTypes };
  }

  for (const m of note.matchAll(ALLOW_DIRECTIVE_RE)) {
    const token = m[1];
    if (token === undefined) continue;
    const raw = m[0].trim();
    if (!isFindingType(token)) {
      unknownTypes.push({ citekey, token, raw });
      continue;
    }
    // m[2] is the reason capture (only present when `(reason: ...)` matched).
    const reasonRaw = m[2];
    const reason =
      reasonRaw !== undefined && reasonRaw.trim() !== '' ? reasonRaw.trim() : null;
    allows.push({ citekey, findingType: token, reason, raw });
  }

  return { allows, unknownTypes };
}

/**
 * Parse allows across a whole bibliography. Convenience wrapper used by
 * `check.ts`; aggregates the per-entry results.
 */
export function parseAllowsForBibliography(
  entries: { citekey: string; note?: string | undefined }[],
): ParseAllowsResult {
  const allows: ParsedAllow[] = [];
  const unknownTypes: ParseAllowsResult['unknownTypes'] = [];
  for (const e of entries) {
    const r = parseAllows(e.citekey, e.note);
    allows.push(...r.allows);
    unknownTypes.push(...r.unknownTypes);
  }
  return { allows, unknownTypes };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface SuppressionInput {
  citekey: string;
  findingType: FindingType;
  cslType: string | undefined;
  config: Config;
  allows: ParsedAllow[];
}

export type GateReason = 'default' | 'source-type' | 'allow';

export interface GateResult {
  gated: boolean;
  reason: GateReason;
}

/**
 * Decide whether a single finding gates the build.
 *
 * Precedence (an explicit allow or a source-type exemption beats the default
 * gate):
 *
 *   1. A valid per-entry allow (matching citekey + findingType, with a
 *      NON-EMPTY reason) → NOT gated, `reason: 'allow'`. Reason is mandatory:
 *      an allow with an empty/missing reason does NOT suppress (it is dropped
 *      here and warned about by the caller), so it falls through to the gate.
 *   2. For `not-found` only, a source-type exemption
 *      (`[source_types] <cslType> = { gate_not_found = false }`) → NOT gated,
 *      `reason: 'source-type'`. Source-type rules govern only the not-found
 *      gate (no DOI was ever expected for the type); they do not exempt
 *      malformed identifiers, canonical issues, or metadata mismatches.
 *   3. Otherwise the secure default applies → gated, `reason: 'default'`.
 *
 * Pure: depends only on its inputs.
 */
export function isGated(input: SuppressionInput): GateResult {
  const { citekey, findingType, cslType, config, allows } = input;

  // 1. Per-entry allow with a valid (non-empty) reason wins.
  const hasValidAllow = allows.some(
    (a) => a.citekey === citekey && a.findingType === findingType && a.reason !== null,
  );
  if (hasValidAllow) {
    return { gated: false, reason: 'allow' };
  }

  // 2. Source-type exemption — applies to the not-found gate only.
  if (findingType === 'not-found' && cslType !== undefined) {
    const rule = config.source_types[cslType];
    if (rule?.gate_not_found === false) {
      return { gated: false, reason: 'source-type' };
    }
  }

  // 3. Secure default.
  return { gated: true, reason: 'default' };
}
