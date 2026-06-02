/**
 * Compact text renderer for bibcheck output.
 *
 * Produces one line per finding in the format:
 *   <file>:<line>: <level>: <message>
 *
 * For findings without a specific file/line (existence-layer results tied to
 * the bibliography source, not a prose file), uses "sources.json:0" as a
 * stand-in artifact location.
 *
 * A summary line is appended at the end:
 *   <n> errors, <m> warnings, <k> notes
 */

import type { Output } from '../schema/output.js';

type Level = 'error' | 'warning' | 'note';

interface Finding {
  file: string;
  line: number;
  level: Level;
  message: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt(f: Finding): string {
  return `${f.file}:${f.line}: ${f.level}: ${f.message}`;
}

// ---------------------------------------------------------------------------
// Finding collectors
// ---------------------------------------------------------------------------

function collectExistenceFindings(output: Output): Finding[] {
  const findings: Finding[] = [];
  for (const entry of output.entries) {
    if (entry.existence?.status === 'metadata-mismatch') {
      findings.push({
        file: 'sources.json',
        line: 0,
        level: 'error',
        message: `existence metadata-mismatch for @${entry.citekey}`,
      });
    } else if (entry.existence?.status === 'not-found-in-databases') {
      // Absence is a fabrication signal and gates by default (Q1).
      findings.push({
        file: 'sources.json',
        line: 0,
        level: 'error',
        message: `existence not-found-in-databases for @${entry.citekey}`,
      });
    } else if (entry.existence?.status === 'unverifiable') {
      findings.push({
        file: 'sources.json',
        line: 0,
        level: 'note',
        message: `existence unverifiable for @${entry.citekey}`,
      });
    }
  }
  return findings;
}

/** Malformed/bad-checksum local identifiers (T21/T22). Gating → error level. */
function collectIdentifierFindings(output: Output): Finding[] {
  const findings: Finding[] = [];
  for (const entry of output.entries) {
    const ids = entry.identifiers;
    if (ids === null || ids === undefined) continue;
    const problems: string[] = [];
    if (ids.doi === 'malformed') problems.push('doi malformed');
    if (ids.isbn === 'malformed') problems.push('isbn malformed');
    if (ids.isbn === 'bad-checksum') problems.push('isbn bad-checksum');
    if (ids.url === 'malformed') problems.push('url malformed');
    if (problems.length === 0) continue;
    findings.push({
      file: 'sources.json',
      line: 0,
      level: 'error',
      message: `identifier ${problems.join(', ')} for @${entry.citekey}`,
    });
  }
  return findings;
}

function collectCanonicalFindings(output: Output): Finding[] {
  const findings: Finding[] = [];
  const errorStatuses = new Set([
    'dead-url',
    'wrong-host',
    'live-url-not-archived-snapshot',
    'no-url-on-pre-doi-entry',
  ]);
  for (const entry of output.entries) {
    const canon = entry.canonical;
    if (canon == null) continue;
    if (errorStatuses.has(canon.status)) {
      const urlPart = canon.url != null ? ` (${canon.url})` : '';
      findings.push({
        file: 'sources.json',
        line: 0,
        level: 'error',
        message: `canonical ${canon.status} for @${entry.citekey}${urlPart}`,
      });
    }
  }
  return findings;
}

function collectLinkageFindings(output: Output): Finding[] {
  const findings: Finding[] = [];
  for (const entry of output.linkage) {
    if (entry.status !== 'unresolved') continue;
    const sortedRefs = [...entry.references].sort((a, b) => {
      const fc = a.file.localeCompare(b.file);
      return fc !== 0 ? fc : a.line - b.line;
    });
    for (const ref of sortedRefs) {
      findings.push({
        file: ref.file,
        line: ref.line,
        level: 'error',
        message: `unresolved linkage @${entry.citekey}`,
      });
    }
  }
  return findings;
}

function collectPhraseFlagFindings(output: Output): Finding[] {
  const findings: Finding[] = [];
  for (const flag of output.phraseFlags) {
    if (flag.status !== 'flagged') continue;
    findings.push({
      file: flag.file,
      line: flag.line,
      level: 'warning',
      message: `phrase [${flag.patternKey}]: "${flag.matchedText}"`,
    });
  }
  return findings;
}

function collectWorklistFindings(output: Output): Finding[] {
  const findings: Finding[] = [];
  for (const item of output.worklist) {
    findings.push({
      file: item.file,
      line: item.line,
      level: 'note',
      message: `worklist [${item.type}] ${item.citation} — ${item.recommendedAction}`,
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render a validated Output as a compact text string.
 *
 * Format: one line per finding as `<file>:<line>: <level>: <message>`,
 * followed by a summary line with counts.
 *
 * Level mapping (same as SARIF):
 * - error: existence metadata-mismatch, canonical dead-url/wrong-host/etc, linkage unresolved
 * - warning: phrase flags (flagged, not acknowledged)
 * - note: existence unverifiable, worklist items
 */
export function renderText(output: Output): string {
  const allFindings: Finding[] = [
    ...collectIdentifierFindings(output),
    ...collectExistenceFindings(output),
    ...collectCanonicalFindings(output),
    ...collectLinkageFindings(output),
    ...collectPhraseFlagFindings(output),
    ...collectWorklistFindings(output),
  ];

  // Sort for determinism: file, line, level, message.
  allFindings.sort((a, b) => {
    const fc = a.file.localeCompare(b.file);
    if (fc !== 0) return fc;
    if (a.line !== b.line) return a.line - b.line;
    if (a.level !== b.level) return a.level.localeCompare(b.level);
    return a.message.localeCompare(b.message);
  });

  const errors = allFindings.filter((f) => f.level === 'error').length;
  const warnings = allFindings.filter((f) => f.level === 'warning').length;
  const notes = allFindings.filter((f) => f.level === 'note').length;

  const lines = allFindings.map(fmt);
  lines.push(`${errors} errors, ${warnings} warnings, ${notes} notes`);

  return lines.join('\n') + '\n';
}
