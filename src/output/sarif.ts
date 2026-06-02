/**
 * SARIF v2.1.0 renderer for bibcheck output.
 *
 * Uses node-sarif-builder for the structural boilerplate (tool/driver, rules,
 * results) and then post-processes the resulting object to add:
 *   - originalUriBaseIds so that relative artifact URIs resolve correctly
 *   - partialFingerprints (sha256-based, stable across runs) for deduplication
 *
 * The library does not expose a first-class API for those two fields, so they
 * are injected directly onto the mutable run/result objects that the builders
 * expose as public properties (`.run` and `.result`). This is the documented
 * escape hatch in node-sarif-builder.
 *
 * Worklist items are NOT emitted as SARIF results. They are informational and
 * would cause spurious CI failures if surfaced as findings.
 */

import { createHash } from 'node:crypto';
import {
  SarifBuilder,
  SarifRunBuilder,
  SarifResultBuilder,
  SarifRuleBuilder,
} from 'node-sarif-builder';
import type { Output } from '../schema/output.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INFORMATION_URI = 'https://github.com/de-otio/bibcheck';
const DOCS_BASE = 'https://github.com/de-otio/bibcheck/blob/main/docs/output-schema.md';

// ---------------------------------------------------------------------------
// Rule definitions
// ---------------------------------------------------------------------------

interface RuleDef {
  id: string;
  shortDescription: string;
  anchor: string;
}

const STATIC_RULES: RuleDef[] = [
  {
    id: 'bibcheck/existence/metadata-mismatch',
    shortDescription: 'Existence check found a metadata mismatch against the databases.',
    anchor: 'existence-metadata-mismatch',
  },
  {
    id: 'bibcheck/existence/not-found-in-databases',
    shortDescription: 'The entry was not found in any applicable bibliographic database (a fabrication signal).',
    anchor: 'existence-not-found-in-databases',
  },
  {
    id: 'bibcheck/existence/unverifiable',
    shortDescription: 'Existence of the entry could not be verified in any database.',
    anchor: 'existence-unverifiable',
  },
  {
    id: 'bibcheck/identifiers/malformed',
    shortDescription: 'A DOI/ISBN/URL identifier is malformed or has a bad checksum (a fabrication signal).',
    anchor: 'identifiers-malformed',
  },
  {
    id: 'bibcheck/canonical/dead-url',
    shortDescription: 'The canonical URL for this entry is dead (no response).',
    anchor: 'canonical-dead-url',
  },
  {
    id: 'bibcheck/canonical/wrong-host',
    shortDescription: 'The canonical URL points to a non-approved host.',
    anchor: 'canonical-wrong-host',
  },
  {
    id: 'bibcheck/canonical/live-url-not-archived-snapshot',
    shortDescription: 'The URL is live but is not a stable archived snapshot.',
    anchor: 'canonical-live-url-not-archived-snapshot',
  },
  {
    id: 'bibcheck/canonical/no-url-on-pre-doi-entry',
    shortDescription: 'A pre-DOI entry is missing a canonical URL.',
    anchor: 'canonical-no-url-on-pre-doi-entry',
  },
  {
    id: 'bibcheck/linkage/unresolved',
    shortDescription: 'A @citekey reference in the prose has no matching bibliography entry.',
    anchor: 'linkage-unresolved',
  },
  {
    id: 'bibcheck/linkage/orphan',
    shortDescription: 'A bibliography entry is never cited in any document (informational; reverse linkage).',
    anchor: 'linkage-orphan',
  },
];

// ---------------------------------------------------------------------------
// Fingerprint helper
// ---------------------------------------------------------------------------

function fingerprint(ruleId: string, fileUri: string, startLine: number, messageText: string): string {
  const payload = JSON.stringify({ ruleId, fileUri, startLine, messageText });
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Result builders
// ---------------------------------------------------------------------------

/** Add a result to the run with a partialFingerprint attached. */
function addResult(
  sarifRunBuilder: SarifRunBuilder,
  opts: {
    ruleId: string;
    level: 'error' | 'warning' | 'note';
    messageText: string;
    fileUri: string;
    /** undefined → no region (bibliography-level finding) */
    startLine?: number;
  }
): void {
  const builder = new SarifResultBuilder();
  const initOpts: Parameters<typeof builder.initSimple>[0] = {
    level: opts.level,
    messageText: opts.messageText,
    ruleId: opts.ruleId,
    fileUri: opts.fileUri,
  };
  // startLine must be >= 1 for the library; 0 means "no line info"
  if (opts.startLine != null && opts.startLine >= 1) {
    initOpts.startLine = opts.startLine;
  }
  builder.initSimple(initOpts);

  // Inject uriBaseId so the relative URI resolves against PROJECTROOT.
  const physLoc = builder.result.locations?.[0]?.physicalLocation;
  if (physLoc?.artifactLocation) {
    physLoc.artifactLocation.uriBaseId = 'PROJECTROOT';
  }

  // Inject partialFingerprints for deduplication.
  const fp = fingerprint(
    opts.ruleId,
    opts.fileUri,
    opts.startLine ?? 0,
    opts.messageText
  );
  (builder.result as unknown as Record<string, unknown>)['partialFingerprints'] = {
    bibcheckV1: fp,
  };

  sarifRunBuilder.addResult(builder);
}

// ---------------------------------------------------------------------------
// Existence findings
// ---------------------------------------------------------------------------

function addExistenceResults(output: Output, sarifRunBuilder: SarifRunBuilder): void {
  for (const entry of output.entries) {
    const existence = entry.existence;
    if (existence == null) continue;

    if (existence.status === 'metadata-mismatch') {
      addResult(sarifRunBuilder, {
        ruleId: 'bibcheck/existence/metadata-mismatch',
        level: 'error',
        messageText: `Existence metadata mismatch for @${entry.citekey}: database records do not match the bibliography entry.`,
        fileUri: 'sources.json',
      });
    } else if (existence.status === 'not-found-in-databases') {
      // Absence is a fabrication signal and gates by default (Q1).
      addResult(sarifRunBuilder, {
        ruleId: 'bibcheck/existence/not-found-in-databases',
        level: 'error',
        messageText: `@${entry.citekey} was not found in any applicable bibliographic database.`,
        fileUri: 'sources.json',
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Identifier findings (T21/T22): malformed/bad-checksum local identifiers
// ---------------------------------------------------------------------------

function addIdentifierResults(output: Output, sarifRunBuilder: SarifRunBuilder): void {
  for (const entry of output.entries) {
    const ids = entry.identifiers;
    if (ids == null) continue;
    const problems: string[] = [];
    if (ids.doi === 'malformed') problems.push('DOI malformed');
    if (ids.isbn === 'malformed') problems.push('ISBN malformed');
    if (ids.isbn === 'bad-checksum') problems.push('ISBN bad checksum');
    if (ids.url === 'malformed') problems.push('URL malformed');
    if (problems.length === 0) continue;
    addResult(sarifRunBuilder, {
      ruleId: 'bibcheck/identifiers/malformed',
      level: 'error',
      messageText: `Malformed identifier for @${entry.citekey}: ${problems.join(', ')}.`,
      fileUri: 'sources.json',
    });
  }
}

// ---------------------------------------------------------------------------
// Canonical findings
// ---------------------------------------------------------------------------

const CANONICAL_ERROR_STATUSES = new Set([
  'dead-url',
  'wrong-host',
  'live-url-not-archived-snapshot',
  'no-url-on-pre-doi-entry',
] as const);

type CanonicalErrorStatus =
  | 'dead-url'
  | 'wrong-host'
  | 'live-url-not-archived-snapshot'
  | 'no-url-on-pre-doi-entry';

function addCanonicalResults(output: Output, sarifRunBuilder: SarifRunBuilder): void {
  for (const entry of output.entries) {
    const canonical = entry.canonical;
    if (canonical == null) continue;
    if (!CANONICAL_ERROR_STATUSES.has(canonical.status as CanonicalErrorStatus)) continue;

    const urlPart = canonical.url != null ? ` (${canonical.url})` : '';
    addResult(sarifRunBuilder, {
      ruleId: `bibcheck/canonical/${canonical.status}`,
      level: 'error',
      messageText: `Canonical URL issue [${canonical.status}] for @${entry.citekey}${urlPart}.`,
      fileUri: 'sources.json',
    });
  }
}

// ---------------------------------------------------------------------------
// Linkage findings
// ---------------------------------------------------------------------------

function addLinkageResults(output: Output, sarifRunBuilder: SarifRunBuilder): void {
  for (const entry of output.linkage) {
    if (entry.status !== 'unresolved') continue;
    const sortedRefs = [...entry.references].sort((a, b) => {
      const fc = a.file.localeCompare(b.file);
      return fc !== 0 ? fc : a.line - b.line;
    });
    for (const ref of sortedRefs) {
      addResult(sarifRunBuilder, {
        ruleId: 'bibcheck/linkage/unresolved',
        level: 'error',
        messageText: `Unresolved @${entry.citekey} reference — no matching bibliography entry.`,
        fileUri: ref.file,
        startLine: ref.line,
      });
    }
  }
}

/**
 * Orphaned bibliography entries (reverse linkage, H2). Emitted at `note` level
 * so they surface in Code Scanning as informational annotations and never
 * cause a CI failure. Bibliography-level, so anchored to sources.json.
 */
function addOrphanResults(output: Output, sarifRunBuilder: SarifRunBuilder): void {
  for (const entry of output.linkage) {
    if (entry.status !== 'orphan') continue;
    addResult(sarifRunBuilder, {
      ruleId: 'bibcheck/linkage/orphan',
      level: 'note',
      messageText: `@${entry.citekey} is in the bibliography but is never cited in any document (informational).`,
      fileUri: 'sources.json',
    });
  }
}

// ---------------------------------------------------------------------------
// Phrase flag findings
// ---------------------------------------------------------------------------

function addPhraseFlagResults(output: Output, sarifRunBuilder: SarifRunBuilder): void {
  for (const flag of output.phraseFlags) {
    if (flag.status !== 'flagged') continue;
    addResult(sarifRunBuilder, {
      ruleId: `bibcheck/phrase/${flag.patternKey}`,
      level: 'warning',
      messageText: `phrase: "${flag.matchedText}"`,
      fileUri: flag.file,
      startLine: flag.line,
    });
  }
}

// ---------------------------------------------------------------------------
// Dynamic rule collection (phrase pattern rules)
// ---------------------------------------------------------------------------

function collectPhraseRules(output: Output): RuleDef[] {
  const seen = new Set<string>();
  const rules: RuleDef[] = [];
  for (const flag of output.phraseFlags) {
    const id = `bibcheck/phrase/${flag.patternKey}`;
    if (!seen.has(id)) {
      seen.add(id);
      rules.push({
        id,
        shortDescription: `Phrase denylist match for pattern key "${flag.patternKey}".`,
        anchor: `phrase-${flag.patternKey}`,
      });
    }
  }
  return rules;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render a validated Output as a SARIF v2.1.0 JSON string.
 *
 * The SARIF document contains one run with:
 * - tool.driver with all applicable rules defined
 * - originalUriBaseIds.PROJECTROOT so relative file URIs resolve correctly
 * - one result per finding (existence mismatches, canonical errors, linkage
 *   unresolved, phrase flags), with partialFingerprints for deduplication
 *
 * Worklist items are not emitted as SARIF results (they are informational).
 * Acknowledged phrase flags are not emitted (only status: 'flagged' entries).
 */
export function renderSarif(output: Output): string {
  // Collect dynamic rules from phrase flags.
  const phraseRules = collectPhraseRules(output);
  const allRuleDefs = [...STATIC_RULES, ...phraseRules];

  // Build the run.
  const version = output.tool.version;
  const sarifRunBuilder = new SarifRunBuilder().initSimple({
    toolDriverName: 'bibcheck',
    toolDriverVersion: version,
    url: INFORMATION_URI,
  });

  // Add semanticVersion directly (node-sarif-builder doesn't expose a setter).
  (sarifRunBuilder.run.tool.driver as unknown as Record<string, unknown>)['semanticVersion'] =
    version;

  // Register all rules.
  for (const ruleDef of allRuleDefs) {
    const ruleBuilder = new SarifRuleBuilder().initSimple({
      ruleId: ruleDef.id,
      shortDescriptionText: ruleDef.shortDescription,
      helpUri: `${DOCS_BASE}#${ruleDef.anchor}`,
    });
    sarifRunBuilder.addRule(ruleBuilder);
  }

  // Add findings.
  addIdentifierResults(output, sarifRunBuilder);
  addExistenceResults(output, sarifRunBuilder);
  addCanonicalResults(output, sarifRunBuilder);
  addLinkageResults(output, sarifRunBuilder);
  addOrphanResults(output, sarifRunBuilder);
  addPhraseFlagResults(output, sarifRunBuilder);

  // Inject originalUriBaseIds so relative URIs resolve to the project root.
  (sarifRunBuilder.run as unknown as Record<string, unknown>)['originalUriBaseIds'] = {
    PROJECTROOT: { uri: 'file:///$PROJECT_ROOT/' },
  };

  // Build the top-level SARIF document.
  const sarifBuilder = new SarifBuilder();
  sarifBuilder.addRun(sarifRunBuilder);
  const sarifObj = sarifBuilder.buildSarifOutput() as unknown as Record<string, unknown>;

  // Override $schema to use https (the library defaults to http).
  sarifObj['$schema'] = 'https://json.schemastore.org/sarif-2.1.0.json';

  return JSON.stringify(sarifObj, null, 2) + '\n';
}
