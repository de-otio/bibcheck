/**
 * Unit tests for src/check.ts
 *
 * All dependencies are mocked at the RunCheckDeps level.
 * No real HTTP, filesystem, or database calls are made.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  runCheck,
  checkExitReasons,
  buildSuppressionContext,
  CHECK_NON_ZERO_REASON,
  type RunCheckDeps,
  type Logger,
} from '../src/check.js';
import { OutputSchema, SCHEMA_VERSION } from '../src/schema/output.js';
import type { Config } from '../src/config.js';
import type { CslEntry } from '../src/schema/csl.js';
import type { Output, ExistenceLayer, CanonicalLayer, PhraseFlag, LinkageEntry, WorklistItem } from '../src/schema/output.js';
import type { RunExistenceResult } from '../src/existence.js';
import type { RunCanonicalResult } from '../src/canonical.js';
import type { RunLinkageResult } from '../src/linkage.js';
import type { RunPhrasesResult } from '../src/phrases.js';
import type { RunWorklistResult } from '../src/worklist.js';
import type { HttpClient } from '../src/http.js';
import type { Cache } from '../src/cache/fs-cache.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const defaultConfig: Config = {
  bibliography: { file: 'docs/sources.json' },
  docs: { include: ['docs/**/*.md'], exclude: [] },
  trusted_hosts: {
    hosts: [
      'hathitrust.org',
      'archive.org',
      'oll.libertyfund.org',
      'plato.stanford.edu',
      'philpapers.org',
      'loc.gov',
      'dnb.de',
      'bnf.fr',
    ],
  },
  phrases: { file: null },
  source_types: {},
  edition_discipline: {},
  apis: {
    crossref_mailto: null,
    openalex_mailto: null,
    crossref_base: 'https://api.crossref.org',
    openalex_base: 'https://api.openalex.org',
    openlibrary_base: 'https://openlibrary.org',
  },
  cache: { dir: '.bibcheck-cache', max_size_mb: 256 },
};

function makeMockHttp(): HttpClient {
  return {
    get: vi.fn().mockRejectedValue(new Error('unexpected http.get')),
    head: vi.fn().mockRejectedValue(new Error('unexpected http.head')),
  };
}

function makeMockCache(): Cache {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    invalidate: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
  };
}

function makeMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeEntry(citekey: string, overrides?: Partial<CslEntry>): CslEntry {
  return {
    id: citekey,
    citekey,
    doi: undefined,
    isbn: undefined,
    url: undefined,
    type: 'article-journal',
    title: `Title for ${citekey}`,
    author: [{ family: 'Smith', given: 'J.' }],
    issued: undefined,
    note: undefined,
    page: undefined,
    publisher: undefined,
    ...overrides,
  };
}

function verifiedExistence(): ExistenceLayer {
  return {
    status: 'verified',
    evidence: 'exists-metadata-match',
    checkedFor: ['existence', 'metadata'],
    notCheckedFor: ['canonical-url', 'claim-support'],
    checks: [{ source: 'crossref', result: 'found', evidence: null }],
    error: null,
  };
}

function unverifiableExistence(): ExistenceLayer {
  return {
    status: 'unverifiable',
    evidence: 'unverifiable',
    checkedFor: [],
    notCheckedFor: ['existence', 'metadata', 'canonical-url', 'claim-support'],
    checks: [{ source: 'crossref', result: 'error', evidence: { error: 'timeout' } }],
    error: 'timeout',
  };
}

function mismatchExistence(): ExistenceLayer {
  return {
    status: 'metadata-mismatch',
    evidence: 'exists-metadata-mismatch',
    checkedFor: ['existence', 'metadata'],
    notCheckedFor: ['canonical-url', 'claim-support'],
    checks: [{ source: 'crossref', result: 'metadata-mismatch', evidence: null }],
    error: null,
  };
}

function notFoundExistence(): ExistenceLayer {
  return {
    status: 'not-found-in-databases',
    evidence: 'absent',
    checkedFor: ['existence'],
    notCheckedFor: ['metadata', 'canonical-url', 'claim-support'],
    checks: [{ source: 'crossref', result: 'not-found', evidence: null }],
    error: null,
  };
}

function verifiedCanonical(): CanonicalLayer {
  return { status: 'verified-canonical', url: 'https://archive.org/foo' };
}

function notApplicableCanonical(): CanonicalLayer {
  return { status: 'not-applicable', url: null };
}

function deadUrlCanonical(): CanonicalLayer {
  return { status: 'dead-url', url: 'https://archive.org/foo' };
}

function makeBaseDeps(
  overrides?: Partial<RunCheckDeps>,
): RunCheckDeps {
  return {
    config: defaultConfig,
    cwd: '/test',
    bibliography: [],
    patterns: [],
    http: makeMockHttp(),
    cache: makeMockCache(),
    logger: makeMockLogger(),
    signal: new AbortController().signal,
    readFile: vi.fn().mockResolvedValue(''),
    _runExistence: vi.fn().mockResolvedValue({ entries: [] } satisfies RunExistenceResult),
    _runCanonical: vi.fn().mockResolvedValue({ entries: [] } satisfies RunCanonicalResult),
    _runLinkage: vi.fn().mockResolvedValue({ linkage: [] } satisfies RunLinkageResult),
    _runPhrases: vi.fn().mockResolvedValue({ phraseFlags: [] } satisfies RunPhrasesResult),
    _runWorklist: vi.fn().mockResolvedValue({ worklist: [] } satisfies RunWorklistResult),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Empty bibliography → empty Output
// ---------------------------------------------------------------------------

describe('runCheck – empty bibliography', () => {
  it('returns valid Output with all summary counts zero', async () => {
    const deps = makeBaseDeps({ bibliography: [] });
    const output = await runCheck(deps);

    expect(output.schemaVersion).toBe(SCHEMA_VERSION);
    expect(output.tool.name).toBe('bibcheck');
    expect(output.summary.totalEntries).toBe(0);
    expect(output.summary.verified).toBe(0);
    expect(output.summary.metadataMismatches).toBe(0);
    expect(output.summary.unverifiable).toBe(0);
    expect(output.summary.canonicalIssues).toBe(0);
    expect(output.summary.linkageFailures).toBe(0);
    expect(output.summary.phraseFlags).toBe(0);
    expect(output.summary.worklistItems).toBe(0);
    expect(output.entries).toHaveLength(0);
    expect(output.linkage).toHaveLength(0);
    expect(output.phraseFlags).toHaveLength(0);
    expect(output.worklist).toHaveLength(0);
    expect(() => OutputSchema.parse(output)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. One verified entry → summary.verified === 1
// ---------------------------------------------------------------------------

describe('runCheck – one verified entry', () => {
  it('sets summary.verified = 1', async () => {
    const entry = makeEntry('smith2000');
    const deps = makeBaseDeps({
      bibliography: [entry],
      _runExistence: vi.fn().mockResolvedValue({
        entries: [{ citekey: 'smith2000', existence: verifiedExistence() }],
      } satisfies RunExistenceResult),
      _runCanonical: vi.fn().mockResolvedValue({
        entries: [{ citekey: 'smith2000', canonical: notApplicableCanonical() }],
      } satisfies RunCanonicalResult),
    });

    const output = await runCheck(deps);
    expect(output.summary.verified).toBe(1);
    expect(output.summary.totalEntries).toBe(1);
    expect(() => OutputSchema.parse(output)).not.toThrow();
  });

  it('existence buckets are independent of canonical: a verified-existence entry with a canonical issue stays in the verified existence bucket and also counts a canonical issue', async () => {
    // T22/T20: the four existence buckets PARTITION the entries by existence
    // status, so they reconcile to totalEntries. A canonical issue is a
    // separate (overlapping) counter and a separate exit reason — it does not
    // move the entry out of its existence bucket.
    const entry = makeEntry('jones1990');
    const deps = makeBaseDeps({
      bibliography: [entry],
      _runExistence: vi.fn().mockResolvedValue({
        entries: [{ citekey: 'jones1990', existence: verifiedExistence() }],
      } satisfies RunExistenceResult),
      _runCanonical: vi.fn().mockResolvedValue({
        entries: [{ citekey: 'jones1990', canonical: deadUrlCanonical() }],
      } satisfies RunCanonicalResult),
    });

    const output = await runCheck(deps);
    expect(output.summary.verified).toBe(1);
    expect(output.summary.canonicalIssues).toBe(1);
    // Still gates — via the canonical issue.
    expect(checkExitReasons(output)).toContain(CHECK_NON_ZERO_REASON.canonical_issue);
    expect(() => OutputSchema.parse(output)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 3. One entry with metadata-mismatch → summary.metadataMismatches === 1
// ---------------------------------------------------------------------------

describe('runCheck – metadata-mismatch', () => {
  it('sets summary.metadataMismatches = 1', async () => {
    const entry = makeEntry('wrong2020');
    const deps = makeBaseDeps({
      bibliography: [entry],
      _runExistence: vi.fn().mockResolvedValue({
        entries: [{ citekey: 'wrong2020', existence: mismatchExistence() }],
      } satisfies RunExistenceResult),
      _runCanonical: vi.fn().mockResolvedValue({
        entries: [{ citekey: 'wrong2020', canonical: notApplicableCanonical() }],
      } satisfies RunCanonicalResult),
    });

    const output = await runCheck(deps);
    expect(output.summary.metadataMismatches).toBe(1);
    expect(output.summary.verified).toBe(0);
    expect(() => OutputSchema.parse(output)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 4. Unresolved linkage → summary.linkageFailures > 0
// ---------------------------------------------------------------------------

describe('runCheck – unresolved linkage', () => {
  it('sets summary.linkageFailures = 1', async () => {
    const unresolvedLinkage: LinkageEntry = {
      citekey: 'missing2021',
      status: 'unresolved',
      references: [{ file: 'docs/paper.md', line: 42 }],
    };
    const deps = makeBaseDeps({
      _runLinkage: vi.fn().mockResolvedValue({
        linkage: [unresolvedLinkage],
      } satisfies RunLinkageResult),
    });

    const output = await runCheck(deps);
    expect(output.summary.linkageFailures).toBe(1);
    expect(output.linkage).toHaveLength(1);
    expect(output.linkage[0]?.status).toBe('unresolved');
    expect(() => OutputSchema.parse(output)).not.toThrow();
  });

  it('resolved linkage does not count as failure', async () => {
    const resolvedLinkage: LinkageEntry = {
      citekey: 'smith2000',
      status: 'resolved',
      references: [{ file: 'docs/paper.md', line: 10 }],
    };
    const deps = makeBaseDeps({
      _runLinkage: vi.fn().mockResolvedValue({
        linkage: [resolvedLinkage],
      } satisfies RunLinkageResult),
    });

    const output = await runCheck(deps);
    expect(output.summary.linkageFailures).toBe(0);
    expect(() => OutputSchema.parse(output)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 4b. Orphan linkage (H2 reverse linkage) → summary.orphanedEntries > 0, but
//     does NOT gate (informational).
// ---------------------------------------------------------------------------

describe('runCheck – orphan linkage (reverse linkage, H2)', () => {
  it('counts orphans in summary.orphanedEntries and does NOT gate (exits 0)', async () => {
    const orphan: LinkageEntry = {
      citekey: 'uncited2000',
      status: 'orphan',
      references: [],
    };
    const resolved: LinkageEntry = {
      citekey: 'cited2000',
      status: 'resolved',
      references: [{ file: 'docs/paper.md', line: 3 }],
    };
    const deps = makeBaseDeps({
      _runLinkage: vi.fn().mockResolvedValue({
        linkage: [orphan, resolved],
      } satisfies RunLinkageResult),
    });

    const output = await runCheck(deps);

    expect(output.summary.orphanedEntries).toBe(1);
    // Orphans are NOT linkage failures.
    expect(output.summary.linkageFailures).toBe(0);
    expect(output.linkage.find((l) => l.citekey === 'uncited2000')?.status).toBe('orphan');
    // Crucially: an orphan is the ONLY finding → check still exits 0.
    expect(checkExitReasons(output)).toEqual([]);
    expect(() => OutputSchema.parse(output)).not.toThrow();
  });

  it('a resolved-only linkage reports zero orphans', async () => {
    const resolved: LinkageEntry = {
      citekey: 'cited2000',
      status: 'resolved',
      references: [{ file: 'docs/paper.md', line: 3 }],
    };
    const deps = makeBaseDeps({
      _runLinkage: vi.fn().mockResolvedValue({
        linkage: [resolved],
      } satisfies RunLinkageResult),
    });

    const output = await runCheck(deps);
    expect(output.summary.orphanedEntries).toBe(0);
    expect(checkExitReasons(output)).toEqual([]);
  });

  it('an orphan alongside an unresolved entry: only unresolved gates', async () => {
    const orphan: LinkageEntry = { citekey: 'uncited', status: 'orphan', references: [] };
    const unresolved: LinkageEntry = {
      citekey: 'missing',
      status: 'unresolved',
      references: [{ file: 'docs/a.md', line: 1 }],
    };
    const deps = makeBaseDeps({
      _runLinkage: vi.fn().mockResolvedValue({
        linkage: [orphan, unresolved],
      } satisfies RunLinkageResult),
    });

    const output = await runCheck(deps);
    expect(output.summary.orphanedEntries).toBe(1);
    expect(output.summary.linkageFailures).toBe(1);
    const reasons = checkExitReasons(output);
    expect(reasons).toContain(CHECK_NON_ZERO_REASON.unresolved_linkage);
    // The orphan itself contributes no exit reason.
    expect(reasons).toEqual([CHECK_NON_ZERO_REASON.unresolved_linkage]);
    expect(() => OutputSchema.parse(output)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 5. Flagged phrase → summary.phraseFlags > 0
// ---------------------------------------------------------------------------

describe('runCheck – flagged phrase', () => {
  it('sets summary.phraseFlags = 1 for a flagged phrase', async () => {
    const flag: PhraseFlag = {
      status: 'flagged',
      patternKey: 'bad-word',
      referenceUrl: null,
      file: 'docs/paper.md',
      line: 5,
      matchedText: 'bad word',
    };
    const deps = makeBaseDeps({
      _runPhrases: vi.fn().mockResolvedValue({
        phraseFlags: [flag],
      } satisfies RunPhrasesResult),
    });

    const output = await runCheck(deps);
    expect(output.summary.phraseFlags).toBe(1);
    expect(output.phraseFlags).toHaveLength(1);
    expect(() => OutputSchema.parse(output)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 6. Acknowledged phrase → does NOT count toward summary.phraseFlags
// ---------------------------------------------------------------------------

describe('runCheck – acknowledged phrase', () => {
  it('does not count acknowledged phrases in summary.phraseFlags', async () => {
    const acknowledged: PhraseFlag = {
      status: 'acknowledged',
      patternKey: 'bad-word',
      referenceUrl: null,
      file: 'docs/paper.md',
      line: 5,
      matchedText: 'bad word',
    };
    const deps = makeBaseDeps({
      _runPhrases: vi.fn().mockResolvedValue({
        phraseFlags: [acknowledged],
      } satisfies RunPhrasesResult),
    });

    const output = await runCheck(deps);
    expect(output.summary.phraseFlags).toBe(0);  // not counted
    expect(output.phraseFlags).toHaveLength(1);   // still in the array
    expect(() => OutputSchema.parse(output)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 7. Worklist item → summary.worklistItems > 0; does NOT trigger non-zero exit
// ---------------------------------------------------------------------------

describe('runCheck – worklist item', () => {
  it('sets summary.worklistItems = 1', async () => {
    const item: WorklistItem = {
      type: 'direct-quotation',
      file: 'docs/paper.md',
      line: 10,
      citation: 'smith2000',
      snippet: 'Some quoted text here',
      verificationUrl: 'https://archive.org/details/foo',
      recommendedAction: 'Verify quotation wording verbatim against the named edition.',
    };
    const deps = makeBaseDeps({
      _runWorklist: vi.fn().mockResolvedValue({
        worklist: [item],
      } satisfies RunWorklistResult),
    });

    const output = await runCheck(deps);
    expect(output.summary.worklistItems).toBe(1);
    expect(output.worklist).toHaveLength(1);
    // Worklist does NOT trigger non-zero exit
    expect(checkExitReasons(output)).toEqual([]);
    expect(() => OutputSchema.parse(output)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 8. Subcommand throw is contained
// ---------------------------------------------------------------------------

describe('runCheck – subcommand throw is contained', () => {
  it('existence throw → degraded result for all entries; logger.error called; run completes', async () => {
    const entry = makeEntry('smith2000');
    const logger = makeMockLogger();
    const deps = makeBaseDeps({
      bibliography: [entry],
      logger,
      _runExistence: vi.fn().mockRejectedValue(new Error('network failure')),
      _runCanonical: vi.fn().mockResolvedValue({
        entries: [{ citekey: 'smith2000', canonical: notApplicableCanonical() }],
      } satisfies RunCanonicalResult),
    });

    const output = await runCheck(deps);

    // Run completed
    expect(output.entries).toHaveLength(1);
    // Degraded existence
    const e = output.entries[0];
    expect(e?.existence?.status).toBe('unverifiable');
    expect(e?.existence?.checks[0]?.result).toBe('error');
    // Logger was called with error
    expect(logger.error).toHaveBeenCalledWith('existence.failed', expect.objectContaining({ error: 'network failure' }));
    expect(() => OutputSchema.parse(output)).not.toThrow();
  });

  it('canonical throw → degraded canonical; other subcommands still run', async () => {
    const entry = makeEntry('jones1990');
    const logger = makeMockLogger();
    const deps = makeBaseDeps({
      bibliography: [entry],
      logger,
      _runExistence: vi.fn().mockResolvedValue({
        entries: [{ citekey: 'jones1990', existence: verifiedExistence() }],
      } satisfies RunExistenceResult),
      _runCanonical: vi.fn().mockRejectedValue(new Error('canonical failed')),
    });

    const output = await runCheck(deps);

    expect(output.entries).toHaveLength(1);
    // Degraded canonical (not-applicable is the safe fallback)
    expect(output.entries[0]?.canonical).not.toBeNull();
    expect(logger.error).toHaveBeenCalledWith('canonical.failed', expect.objectContaining({ error: 'canonical failed' }));
    expect(() => OutputSchema.parse(output)).not.toThrow();
  });

  it('linkage throw → empty linkage; run completes', async () => {
    const logger = makeMockLogger();
    const deps = makeBaseDeps({
      logger,
      _runLinkage: vi.fn().mockRejectedValue(new Error('linkage fail')),
    });

    const output = await runCheck(deps);
    expect(output.linkage).toHaveLength(0);
    expect(logger.error).toHaveBeenCalledWith('linkage.failed', expect.objectContaining({ error: 'linkage fail' }));
    expect(() => OutputSchema.parse(output)).not.toThrow();
  });

  it('phrases throw → empty phraseFlags; run completes', async () => {
    const logger = makeMockLogger();
    const deps = makeBaseDeps({
      logger,
      _runPhrases: vi.fn().mockRejectedValue(new Error('phrases fail')),
    });

    const output = await runCheck(deps);
    expect(output.phraseFlags).toHaveLength(0);
    expect(logger.error).toHaveBeenCalledWith('phrases.failed', expect.objectContaining({ error: 'phrases fail' }));
    expect(() => OutputSchema.parse(output)).not.toThrow();
  });

  it('worklist throw → empty worklist; run completes', async () => {
    const logger = makeMockLogger();
    const deps = makeBaseDeps({
      logger,
      _runWorklist: vi.fn().mockRejectedValue(new Error('worklist fail')),
    });

    const output = await runCheck(deps);
    expect(output.worklist).toHaveLength(0);
    expect(logger.error).toHaveBeenCalledWith('worklist.failed', expect.objectContaining({ error: 'worklist fail' }));
    expect(() => OutputSchema.parse(output)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 9. Skip set respected
// ---------------------------------------------------------------------------

describe('runCheck – skip set', () => {
  it('skip existence → existence layers null; _runExistence not called', async () => {
    const entry = makeEntry('smith2000');
    const doRunExistence = vi.fn().mockResolvedValue({ entries: [] });
    const deps = makeBaseDeps({
      bibliography: [entry],
      skip: new Set(['existence']),
      _runExistence: doRunExistence,
      _runCanonical: vi.fn().mockResolvedValue({
        entries: [{ citekey: 'smith2000', canonical: notApplicableCanonical() }],
      } satisfies RunCanonicalResult),
    });

    const output = await runCheck(deps);
    expect(doRunExistence).not.toHaveBeenCalled();
    expect(output.entries[0]?.existence).toBeNull();
    expect(() => OutputSchema.parse(output)).not.toThrow();
  });

  it('skip canonical → canonical layers null; _runCanonical not called', async () => {
    const entry = makeEntry('smith2000');
    const doRunCanonical = vi.fn().mockResolvedValue({ entries: [] });
    const deps = makeBaseDeps({
      bibliography: [entry],
      skip: new Set(['canonical']),
      _runExistence: vi.fn().mockResolvedValue({
        entries: [{ citekey: 'smith2000', existence: verifiedExistence() }],
      } satisfies RunExistenceResult),
      _runCanonical: doRunCanonical,
    });

    const output = await runCheck(deps);
    expect(doRunCanonical).not.toHaveBeenCalled();
    expect(output.entries[0]?.canonical).toBeNull();
    expect(() => OutputSchema.parse(output)).not.toThrow();
  });

  it('skip linkage → empty linkage; _runLinkage not called', async () => {
    const doRunLinkage = vi.fn();
    const deps = makeBaseDeps({
      skip: new Set(['linkage']),
      _runLinkage: doRunLinkage,
    });

    const output = await runCheck(deps);
    expect(doRunLinkage).not.toHaveBeenCalled();
    expect(output.linkage).toHaveLength(0);
    expect(() => OutputSchema.parse(output)).not.toThrow();
  });

  it('skip phrases → empty phraseFlags; _runPhrases not called', async () => {
    const doRunPhrases = vi.fn();
    const deps = makeBaseDeps({
      skip: new Set(['phrases']),
      _runPhrases: doRunPhrases,
    });

    const output = await runCheck(deps);
    expect(doRunPhrases).not.toHaveBeenCalled();
    expect(output.phraseFlags).toHaveLength(0);
    expect(() => OutputSchema.parse(output)).not.toThrow();
  });

  it('skip worklist → empty worklist; _runWorklist not called', async () => {
    const doRunWorklist = vi.fn();
    const deps = makeBaseDeps({
      skip: new Set(['worklist']),
      _runWorklist: doRunWorklist,
    });

    const output = await runCheck(deps);
    expect(doRunWorklist).not.toHaveBeenCalled();
    expect(output.worklist).toHaveLength(0);
    expect(() => OutputSchema.parse(output)).not.toThrow();
  });

  it('skip all → all layers null / empty; no subcommands called', async () => {
    const entry = makeEntry('smith2000');
    const doRunExistence = vi.fn();
    const doRunCanonical = vi.fn();
    const doRunLinkage = vi.fn();
    const doRunPhrases = vi.fn();
    const doRunWorklist = vi.fn();
    const deps = makeBaseDeps({
      bibliography: [entry],
      skip: new Set(['existence', 'canonical', 'linkage', 'phrases', 'worklist']),
      _runExistence: doRunExistence,
      _runCanonical: doRunCanonical,
      _runLinkage: doRunLinkage,
      _runPhrases: doRunPhrases,
      _runWorklist: doRunWorklist,
    });

    const output = await runCheck(deps);
    expect(doRunExistence).not.toHaveBeenCalled();
    expect(doRunCanonical).not.toHaveBeenCalled();
    expect(doRunLinkage).not.toHaveBeenCalled();
    expect(doRunPhrases).not.toHaveBeenCalled();
    expect(doRunWorklist).not.toHaveBeenCalled();
    expect(output.entries[0]?.existence).toBeNull();
    expect(output.entries[0]?.canonical).toBeNull();
    expect(output.linkage).toHaveLength(0);
    expect(output.phraseFlags).toHaveLength(0);
    expect(output.worklist).toHaveLength(0);
    expect(() => OutputSchema.parse(output)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 10. Output validates against OutputSchema (exercised in every test above)
// ---------------------------------------------------------------------------

describe('OutputSchema validation', () => {
  it('every runCheck output passes OutputSchema.parse', async () => {
    // Mixed scenario
    const entry1 = makeEntry('smith2000');
    const entry2 = makeEntry('jones1990');
    const deps = makeBaseDeps({
      bibliography: [entry1, entry2],
      _runExistence: vi.fn().mockResolvedValue({
        entries: [
          { citekey: 'smith2000', existence: verifiedExistence() },
          { citekey: 'jones1990', existence: mismatchExistence() },
        ],
      } satisfies RunExistenceResult),
      _runCanonical: vi.fn().mockResolvedValue({
        entries: [
          { citekey: 'smith2000', canonical: notApplicableCanonical() },
          { citekey: 'jones1990', canonical: notApplicableCanonical() },
        ],
      } satisfies RunCanonicalResult),
    });

    const output = await runCheck(deps);
    expect(() => OutputSchema.parse(output)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 11. checkExitReasons returns empty for clean runs
// ---------------------------------------------------------------------------

describe('checkExitReasons – clean run', () => {
  it('returns empty array when no issues', async () => {
    const entry = makeEntry('smith2000');
    const deps = makeBaseDeps({
      bibliography: [entry],
      _runExistence: vi.fn().mockResolvedValue({
        entries: [{ citekey: 'smith2000', existence: verifiedExistence() }],
      } satisfies RunExistenceResult),
      _runCanonical: vi.fn().mockResolvedValue({
        entries: [{ citekey: 'smith2000', canonical: notApplicableCanonical() }],
      } satisfies RunCanonicalResult),
    });

    const output = await runCheck(deps);
    expect(checkExitReasons(output)).toEqual([]);
  });

  it('unverifiable existence does not cause non-zero exit', async () => {
    const entry = makeEntry('smith2000');
    const deps = makeBaseDeps({
      bibliography: [entry],
      _runExistence: vi.fn().mockResolvedValue({
        entries: [{ citekey: 'smith2000', existence: unverifiableExistence() }],
      } satisfies RunExistenceResult),
    });

    const output = await runCheck(deps);
    expect(checkExitReasons(output)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 12. checkExitReasons returns right reason codes for problematic runs
// ---------------------------------------------------------------------------

describe('checkExitReasons – problematic runs', () => {
  it('returns flagged_phrase for flagged phrases', async () => {
    const flag: PhraseFlag = {
      status: 'flagged',
      patternKey: 'bad-word',
      referenceUrl: null,
      file: 'docs/paper.md',
      line: 5,
      matchedText: 'bad word',
    };
    const deps = makeBaseDeps({
      _runPhrases: vi.fn().mockResolvedValue({ phraseFlags: [flag] } satisfies RunPhrasesResult),
    });
    const output = await runCheck(deps);
    expect(checkExitReasons(output)).toContain(CHECK_NON_ZERO_REASON.flagged_phrase);
  });

  it('returns unresolved_linkage for unresolved linkage entries', async () => {
    const unresolved: LinkageEntry = {
      citekey: 'missing',
      status: 'unresolved',
      references: [{ file: 'docs/a.md', line: 1 }],
    };
    const deps = makeBaseDeps({
      _runLinkage: vi.fn().mockResolvedValue({ linkage: [unresolved] } satisfies RunLinkageResult),
    });
    const output = await runCheck(deps);
    expect(checkExitReasons(output)).toContain(CHECK_NON_ZERO_REASON.unresolved_linkage);
  });

  it('returns canonical_issue for dead-url canonical status', async () => {
    const entry = makeEntry('oldbook1800');
    const deps = makeBaseDeps({
      bibliography: [entry],
      _runExistence: vi.fn().mockResolvedValue({
        entries: [{ citekey: 'oldbook1800', existence: unverifiableExistence() }],
      } satisfies RunExistenceResult),
      _runCanonical: vi.fn().mockResolvedValue({
        entries: [{ citekey: 'oldbook1800', canonical: { status: 'dead-url', url: 'https://archive.org/broken' } }],
      } satisfies RunCanonicalResult),
    });
    const output = await runCheck(deps);
    expect(checkExitReasons(output)).toContain(CHECK_NON_ZERO_REASON.canonical_issue);
  });

  it('returns canonical_issue for wrong-host', async () => {
    const entry = makeEntry('oldbook1800');
    const deps = makeBaseDeps({
      bibliography: [entry],
      _runCanonical: vi.fn().mockResolvedValue({
        entries: [{ citekey: 'oldbook1800', canonical: { status: 'wrong-host', url: 'https://random.example.com/foo' } }],
      } satisfies RunCanonicalResult),
    });
    const output = await runCheck(deps);
    expect(checkExitReasons(output)).toContain(CHECK_NON_ZERO_REASON.canonical_issue);
  });

  it('returns canonical_issue for no-url-on-pre-doi-entry', async () => {
    const entry = makeEntry('ancient1700');
    const deps = makeBaseDeps({
      bibliography: [entry],
      _runCanonical: vi.fn().mockResolvedValue({
        entries: [{ citekey: 'ancient1700', canonical: { status: 'no-url-on-pre-doi-entry', url: null } }],
      } satisfies RunCanonicalResult),
    });
    const output = await runCheck(deps);
    expect(checkExitReasons(output)).toContain(CHECK_NON_ZERO_REASON.canonical_issue);
  });

  it('returns canonical_issue for live-url-not-archived-snapshot', async () => {
    const entry = makeEntry('sep2020');
    const deps = makeBaseDeps({
      bibliography: [entry],
      _runCanonical: vi.fn().mockResolvedValue({
        entries: [{ citekey: 'sep2020', canonical: { status: 'live-url-not-archived-snapshot', url: 'https://plato.stanford.edu/entries/foo' } }],
      } satisfies RunCanonicalResult),
    });
    const output = await runCheck(deps);
    expect(checkExitReasons(output)).toContain(CHECK_NON_ZERO_REASON.canonical_issue);
  });

  it('returns metadata_mismatch for mismatched existence', async () => {
    const entry = makeEntry('smith2000');
    const deps = makeBaseDeps({
      bibliography: [entry],
      _runExistence: vi.fn().mockResolvedValue({
        entries: [{ citekey: 'smith2000', existence: mismatchExistence() }],
      } satisfies RunExistenceResult),
      _runCanonical: vi.fn().mockResolvedValue({
        entries: [{ citekey: 'smith2000', canonical: notApplicableCanonical() }],
      } satisfies RunCanonicalResult),
    });
    const output = await runCheck(deps);
    expect(checkExitReasons(output)).toContain(CHECK_NON_ZERO_REASON.metadata_mismatch);
  });

  it('returns multiple reason codes when multiple issues exist', async () => {
    const entry = makeEntry('bad2022');
    const flag: PhraseFlag = {
      status: 'flagged',
      patternKey: 'bad-word',
      referenceUrl: null,
      file: 'docs/paper.md',
      line: 1,
      matchedText: 'bad word',
    };
    const unresolved: LinkageEntry = {
      citekey: 'missing',
      status: 'unresolved',
      references: [{ file: 'docs/a.md', line: 1 }],
    };
    const deps = makeBaseDeps({
      bibliography: [entry],
      _runExistence: vi.fn().mockResolvedValue({
        entries: [{ citekey: 'bad2022', existence: mismatchExistence() }],
      } satisfies RunExistenceResult),
      _runCanonical: vi.fn().mockResolvedValue({
        entries: [{ citekey: 'bad2022', canonical: notApplicableCanonical() }],
      } satisfies RunCanonicalResult),
      _runLinkage: vi.fn().mockResolvedValue({ linkage: [unresolved] } satisfies RunLinkageResult),
      _runPhrases: vi.fn().mockResolvedValue({ phraseFlags: [flag] } satisfies RunPhrasesResult),
    });

    const output = await runCheck(deps);
    const reasons = checkExitReasons(output);
    expect(reasons).toContain(CHECK_NON_ZERO_REASON.flagged_phrase);
    expect(reasons).toContain(CHECK_NON_ZERO_REASON.unresolved_linkage);
    expect(reasons).toContain(CHECK_NON_ZERO_REASON.metadata_mismatch);
  });

  it('acknowledged phrase does NOT trigger flagged_phrase exit reason', async () => {
    const ack: PhraseFlag = {
      status: 'acknowledged',
      patternKey: 'bad-word',
      referenceUrl: null,
      file: 'docs/paper.md',
      line: 5,
      matchedText: 'bad word',
    };
    const deps = makeBaseDeps({
      _runPhrases: vi.fn().mockResolvedValue({ phraseFlags: [ack] } satisfies RunPhrasesResult),
    });
    const output = await runCheck(deps);
    expect(checkExitReasons(output)).not.toContain(CHECK_NON_ZERO_REASON.flagged_phrase);
  });
});

// ---------------------------------------------------------------------------
// 13. AbortSignal aborted → throws or returns partial
// ---------------------------------------------------------------------------

describe('runCheck – AbortSignal', () => {
  it('pre-aborted signal → existence receives aborted signal', async () => {
    const ac = new AbortController();
    ac.abort(new Error('cancelled by test'));

    // Existence will throw when it sees the aborted signal
    const doRunExistence = vi.fn().mockImplementation(() => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    });
    const logger = makeMockLogger();
    const entry = makeEntry('smith2000');
    const deps = makeBaseDeps({
      bibliography: [entry],
      signal: ac.signal,
      logger,
      _runExistence: doRunExistence,
    });

    // run completes with degraded existence (error is caught per subcommand)
    const output = await runCheck(deps);
    expect(output.entries[0]?.existence?.status).toBe('unverifiable');
    expect(logger.error).toHaveBeenCalledWith(
      'existence.failed',
      expect.objectContaining({ error: 'aborted' }),
    );
    expect(() => OutputSchema.parse(output)).not.toThrow();
  });

  it('signal aborted mid-run is propagated to subcommand signals', async () => {
    const ac = new AbortController();
    // abort immediately
    ac.abort();

    const doRunLinkage = vi.fn().mockRejectedValue(Object.assign(new Error('AbortError'), { name: 'AbortError' }));
    const logger = makeMockLogger();
    const deps = makeBaseDeps({
      signal: ac.signal,
      logger,
      _runLinkage: doRunLinkage,
    });

    const output = await runCheck(deps);
    expect(output.linkage).toHaveLength(0);
    expect(logger.error).toHaveBeenCalledWith('linkage.failed', expect.any(Object));
    expect(() => OutputSchema.parse(output)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Summary count assertions (broader coverage)
// ---------------------------------------------------------------------------

describe('runCheck – summary counts', () => {
  it('unverifiable existence counts in summary.unverifiable', async () => {
    const entry = makeEntry('unreachable2000');
    const deps = makeBaseDeps({
      bibliography: [entry],
      _runExistence: vi.fn().mockResolvedValue({
        entries: [{ citekey: 'unreachable2000', existence: unverifiableExistence() }],
      } satisfies RunExistenceResult),
    });

    const output = await runCheck(deps);
    expect(output.summary.unverifiable).toBe(1);
    expect(output.summary.verified).toBe(0);
    expect(() => OutputSchema.parse(output)).not.toThrow();
  });

  it('multiple entries aggregated correctly', async () => {
    const e1 = makeEntry('verified1');
    const e2 = makeEntry('mismatch1');
    const e3 = makeEntry('unverifiable1');
    const deps = makeBaseDeps({
      bibliography: [e1, e2, e3],
      _runExistence: vi.fn().mockResolvedValue({
        entries: [
          { citekey: 'verified1', existence: verifiedExistence() },
          { citekey: 'mismatch1', existence: mismatchExistence() },
          { citekey: 'unverifiable1', existence: unverifiableExistence() },
        ],
      } satisfies RunExistenceResult),
      _runCanonical: vi.fn().mockResolvedValue({
        entries: [
          { citekey: 'verified1', canonical: notApplicableCanonical() },
          { citekey: 'mismatch1', canonical: notApplicableCanonical() },
          { citekey: 'unverifiable1', canonical: notApplicableCanonical() },
        ],
      } satisfies RunCanonicalResult),
    });

    const output = await runCheck(deps);
    expect(output.summary.totalEntries).toBe(3);
    expect(output.summary.verified).toBe(1);
    expect(output.summary.metadataMismatches).toBe(1);
    expect(output.summary.unverifiable).toBe(1);
    expect(() => OutputSchema.parse(output)).not.toThrow();
  });

  it('multiple phrase flags — only flagged count in summary', async () => {
    const flagged: PhraseFlag = {
      status: 'flagged',
      patternKey: 'bad-word',
      referenceUrl: null,
      file: 'docs/a.md',
      line: 1,
      matchedText: 'bad word',
    };
    const ack: PhraseFlag = {
      status: 'acknowledged',
      patternKey: 'another-word',
      referenceUrl: null,
      file: 'docs/a.md',
      line: 2,
      matchedText: 'another word',
    };
    const deps = makeBaseDeps({
      _runPhrases: vi.fn().mockResolvedValue({
        phraseFlags: [flagged, ack],
      } satisfies RunPhrasesResult),
    });

    const output = await runCheck(deps);
    expect(output.summary.phraseFlags).toBe(1);
    expect(output.phraseFlags).toHaveLength(2);
    expect(() => OutputSchema.parse(output)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Network policy: offline mode removed (Q3). Network-bound subcommands always
// use the injected real http; transport failure must surface clearly and must
// NOT be silently masked as a clean "unverifiable" pass.
//
// These re-express the former offline-mode unit tests as injected-http tests
// (offline mode no longer exists).
// ---------------------------------------------------------------------------

describe('runCheck – transport failure is surfaced, not masked', () => {
  it('a DNS/connect failure on every existence source logs existence.transport_failure', async () => {
    const { HttpError } = await import('../src/http.js');
    const entry = makeEntry('smith2000', { doi: '10.1234/x' });
    const logger = makeMockLogger();

    // Real runExistence runs; the injected http rejects every request with a
    // transport-style HttpError (as the real client does on ENOTFOUND).
    const failingHttp: HttpClient = {
      get: vi.fn().mockRejectedValue(new HttpError('DNS resolution failed for example.com')),
      head: vi.fn().mockRejectedValue(new HttpError('DNS resolution failed for example.com')),
    };

    const deps = makeBaseDeps({
      bibliography: [entry],
      logger,
      http: failingHttp,
      // Use the real existence runner so the per-source 'error' results are produced.
      _runExistence: undefined,
      // Skip canonical so it does not also try the failing http for this DOI-bearing entry.
      skip: new Set(['canonical', 'linkage', 'phrases', 'worklist']),
    });

    const output = await runCheck(deps);

    // Existence could not be verified — but it is NOT silently passed off as a
    // clean state: a clear, actionable transport-failure message is logged.
    expect(output.entries[0]?.existence?.status).toBe('unverifiable');
    expect(logger.error).toHaveBeenCalledWith(
      'existence.transport_failure',
      expect.objectContaining({ affectedEntries: ['smith2000'] }),
    );
    // The http client (not a no-op offline stub) was actually called.
    expect(failingHttp.get).toHaveBeenCalled();
    expect(() => OutputSchema.parse(output)).not.toThrow();
  });

  it('successful existence lookups do not log a transport failure', async () => {
    const entry = makeEntry('smith2000');
    const logger = makeMockLogger();
    const deps = makeBaseDeps({
      bibliography: [entry],
      logger,
      _runExistence: vi.fn().mockResolvedValue({
        entries: [{ citekey: 'smith2000', existence: verifiedExistence() }],
      } satisfies RunExistenceResult),
    });

    await runCheck(deps);
    expect(logger.error).not.toHaveBeenCalledWith(
      'existence.transport_failure',
      expect.anything(),
    );
  });
});

// ---------------------------------------------------------------------------
// Configurable [apis] base URLs are honoured by the live DB clients.
//
// Drives the *real* runExistence through runCheck with an injected http that
// (a) records every requested URL and (b) returns canned 200/404 bodies. This
// exercises the crossref/openalex base-URL construction and their found / 404
// branches without any network. (The per-subcommand integration tests run the
// built CLI in a subprocess, which the in-process coverage instrument cannot
// see; this in-process test gives the DB clients real branch coverage.)
// ---------------------------------------------------------------------------

describe('runCheck – configurable [apis] base URLs', () => {
  function configWithBase(base: string): Config {
    return {
      ...defaultConfig,
      apis: {
        ...defaultConfig.apis,
        crossref_base: base,
        openalex_base: base,
        openlibrary_base: base,
      },
    };
  }

  function cannedHttp(handler: (url: string) => { status: number; body: unknown }): {
    http: HttpClient;
    urls: string[];
  } {
    const urls: string[] = [];
    const http: HttpClient = {
      get: vi.fn(async (url: string) => {
        urls.push(url);
        const { status, body } = handler(url);
        return { status, headers: { 'content-type': 'application/json' }, body };
      }),
      head: vi.fn(async (url: string) => {
        urls.push(url);
        return { status: 200, finalUrl: url, redirectChain: [] };
      }),
    };
    return { http, urls };
  }

  it('builds DOI lookup URLs from the configured base and verifies a found work', async () => {
    const base = 'https://stub.example.test';
    const entry = makeEntry('smith2000', { doi: '10.1234/found' });
    const { http, urls } = cannedHttp(() => ({
      // CrossRef success shape and OpenAlex work object (no title/author → match).
      status: 200,
      body: { status: 'ok', message: { DOI: '10.1234/found' } },
    }));

    const deps = makeBaseDeps({
      config: configWithBase(base),
      bibliography: [entry],
      http,
      _runExistence: undefined, // use the real runner
      skip: new Set(['canonical', 'linkage', 'phrases', 'worklist']),
    });

    const output = await runCheck(deps);

    // Every request went to the configured base, never the public endpoints.
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => u.startsWith(base))).toBe(true);
    expect(urls.some((u) => u.includes('/works/'))).toBe(true);
    // A found work with no title/author short-circuits to verified.
    expect(output.entries[0]?.existence?.status).toBe('verified');
    expect(() => OutputSchema.parse(output)).not.toThrow();
  });

  it('treats a 404 from both DOI sources as not-found-in-databases AND gates by default (B1 fix, Q1)', async () => {
    const base = 'https://stub.example.test';
    const entry = makeEntry('fake2099', { doi: '10.9999/nonexistent' });
    const { http } = cannedHttp(() => ({ status: 404, body: { status: 'error' } }));

    const deps = makeBaseDeps({
      config: configWithBase(base),
      bibliography: [entry],
      http,
      _runExistence: undefined,
      skip: new Set(['canonical', 'linkage', 'phrases', 'worklist']),
    });

    const output = await runCheck(deps);
    expect(output.entries[0]?.existence?.status).toBe('not-found-in-databases');
    expect(output.entries[0]?.existence?.evidence).toBe('absent');
    expect(output.summary.notFoundInDatabases).toBe(1);
    // Absence is a fabrication signal and gates by default (T22 secure default).
    expect(checkExitReasons(output)).toContain(CHECK_NON_ZERO_REASON.not_found_in_databases);
    expect(() => OutputSchema.parse(output)).not.toThrow();
  });

  it('builds ISBN lookup URLs (OpenLibrary, the sole ISBN source) from the configured base', async () => {
    const base = 'https://stub.example.test';
    const entry = makeEntry('book2000', { isbn: '978-0-14-043207-7' });
    const { http, urls } = cannedHttp((url) => {
      if (url.includes('/api/books')) {
        // OpenLibrary found body, no title/author → match.
        return { status: 200, body: { 'ISBN:978-0-14-043207-7': { publish_date: '2000' } } };
      }
      return { status: 404, body: {} };
    });

    const deps = makeBaseDeps({
      config: configWithBase(base),
      bibliography: [entry],
      http,
      _runExistence: undefined,
      skip: new Set(['canonical', 'linkage', 'phrases', 'worklist']),
    });

    const output = await runCheck(deps);
    expect(urls.every((u) => u.startsWith(base))).toBe(true);
    expect(urls.some((u) => u.includes('/api/books'))).toBe(true);
    // WorldCat / OCLC Classify is gone — no /classify2/api request is ever made.
    expect(urls.some((u) => u.includes('/classify2/api'))).toBe(false);
    expect(output.entries[0]?.existence?.status).toBe('verified');
    expect(() => OutputSchema.parse(output)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Identifiers wiring + malformed-identifier gating (T21/T22)
//
// Drives the *real* runExistence + runIdentifiers through runCheck to prove
// that (a) a malformed/bad-checksum identifier short-circuits the network call
// and (b) it gates by default and is counted in summary.malformedIdentifiers.
// ---------------------------------------------------------------------------

describe('runCheck – malformed identifiers (T21/T22)', () => {
  function cannedHttp(): { http: HttpClient; getCalls: () => number } {
    let calls = 0;
    const http: HttpClient = {
      get: vi.fn(async (url: string) => {
        calls += 1;
        return { status: 200, headers: { 'content-type': 'application/json' }, body: { status: 'ok', message: {} } };
      }),
      head: vi.fn(async (url: string) => ({ status: 200, finalUrl: url, redirectChain: [] })),
    };
    return { http, getCalls: () => calls };
  }

  it('a bad-checksum ISBN skips the network call, is unverifiable, counts in malformedIdentifiers, and gates', async () => {
    // 978-0-14-043207-0 transposes the final check digit of a real ISBN → bad checksum.
    const entry = makeEntry('badisbn2000', { isbn: '978-0-14-043207-0' });
    const { http, getCalls } = cannedHttp();

    const deps = makeBaseDeps({
      bibliography: [entry],
      http,
      _runExistence: undefined, // real runner
      skip: new Set(['canonical', 'linkage', 'phrases', 'worklist']),
    });

    const output = await runCheck(deps);

    // Identifier layer recorded the bad checksum.
    expect(output.entries[0]?.identifiers?.isbn).toBe('bad-checksum');
    // Network existence call was skipped entirely.
    expect(getCalls()).toBe(0);
    expect(output.entries[0]?.existence?.status).toBe('unverifiable');
    expect(output.entries[0]?.existence?.evidence).toBe('unverifiable');
    // Counted and gating.
    expect(output.summary.malformedIdentifiers).toBe(1);
    expect(checkExitReasons(output)).toContain(CHECK_NON_ZERO_REASON.malformed_identifier);
    expect(() => OutputSchema.parse(output)).not.toThrow();
  });

  it('a malformed DOI skips the network call and gates', async () => {
    const entry = makeEntry('baddoi2000', { doi: 'not-a-doi' });
    const { http, getCalls } = cannedHttp();

    const deps = makeBaseDeps({
      bibliography: [entry],
      http,
      _runExistence: undefined,
      skip: new Set(['canonical', 'linkage', 'phrases', 'worklist']),
    });

    const output = await runCheck(deps);
    expect(output.entries[0]?.identifiers?.doi).toBe('malformed');
    expect(getCalls()).toBe(0);
    expect(output.summary.malformedIdentifiers).toBe(1);
    expect(checkExitReasons(output)).toContain(CHECK_NON_ZERO_REASON.malformed_identifier);
    expect(() => OutputSchema.parse(output)).not.toThrow();
  });

  it('a well-formed identifier does NOT count as malformed and runs the network call', async () => {
    const entry = makeEntry('good2000', { doi: '10.1234/ok' });
    const { http, getCalls } = cannedHttp();

    const deps = makeBaseDeps({
      bibliography: [entry],
      http,
      _runExistence: undefined,
      skip: new Set(['canonical', 'linkage', 'phrases', 'worklist']),
    });

    const output = await runCheck(deps);
    expect(output.entries[0]?.identifiers?.doi).toBe('ok');
    expect(getCalls()).toBeGreaterThan(0);
    expect(output.summary.malformedIdentifiers).toBe(0);
    expect(() => OutputSchema.parse(output)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// CHECK_NON_ZERO_REASON constants
// ---------------------------------------------------------------------------

describe('CHECK_NON_ZERO_REASON', () => {
  it('has the expected keys', () => {
    expect(CHECK_NON_ZERO_REASON.flagged_phrase).toBe('flagged_phrase');
    expect(CHECK_NON_ZERO_REASON.unresolved_linkage).toBe('unresolved_linkage');
    expect(CHECK_NON_ZERO_REASON.canonical_issue).toBe('canonical_issue');
    expect(CHECK_NON_ZERO_REASON.metadata_mismatch).toBe('metadata_mismatch');
    expect(CHECK_NON_ZERO_REASON.not_found_in_databases).toBe('not_found_in_databases');
    expect(CHECK_NON_ZERO_REASON.malformed_identifier).toBe('malformed_identifier');
  });
});

// ---------------------------------------------------------------------------
// T23 — Suppression & source-type gating
//
// Drives checkExitReasons WITH a SuppressionContext (built by
// buildSuppressionContext) and exercises the acknowledgement logging in
// runCheck. Each gate decision is tested on BOTH sides.
// ---------------------------------------------------------------------------

describe('T23 – suppression & source-type gating', () => {
  function notFoundOutput(entry: CslEntry): Output {
    return {
      schemaVersion: SCHEMA_VERSION,
      tool: { name: 'bibcheck', version: '0.0.0' },
      summary: {
        totalEntries: 1,
        verified: 0,
        metadataMismatches: 0,
        notFoundInDatabases: 1,
        malformedIdentifiers: 0,
        unverifiable: 0,
        canonicalIssues: 0,
        linkageFailures: 0,
        phraseFlags: 0,
        worklistItems: 0,
      },
      entries: [
        {
          citekey: entry.citekey,
          identifiers: null,
          existence: notFoundExistence(),
          canonical: null,
        },
      ],
      linkage: [],
      phraseFlags: [],
      worklist: [],
    };
  }

  it('default-gates a not-found for an unlisted type (no context = unconditional)', () => {
    const entry = makeEntry('fake2099', { type: 'article-journal' });
    const output = notFoundOutput(entry);
    // No context: pre-T23 unconditional gate.
    expect(checkExitReasons(output)).toContain(CHECK_NON_ZERO_REASON.not_found_in_databases);
    // With a default context: still gates.
    const ctx = buildSuppressionContext(defaultConfig, [entry]);
    expect(checkExitReasons(output, ctx)).toContain(CHECK_NON_ZERO_REASON.not_found_in_databases);
  });

  it('source-type exemption: manuscript with gate_not_found=false does NOT gate but stays in totals', () => {
    const entry = makeEntry('manu1', { type: 'manuscript' });
    const output = notFoundOutput(entry);
    const config: Config = {
      ...defaultConfig,
      source_types: { manuscript: { gate_not_found: false } },
    };
    const ctx = buildSuppressionContext(config, [entry]);
    expect(checkExitReasons(output, ctx)).not.toContain(
      CHECK_NON_ZERO_REASON.not_found_in_databases,
    );
    // Still counted — reported, not dropped.
    expect(output.summary.notFoundInDatabases).toBe(1);
    expect(output.entries[0]?.existence?.status).toBe('not-found-in-databases');
  });

  it('per-entry allow-with-reason suppresses the finding (does not gate)', () => {
    const entry = makeEntry('manu2', {
      type: 'article-journal',
      note: 'bibcheck-allow: not-found (reason: 1680 pamphlet, Bodleian shelfmark X)',
    });
    const output = notFoundOutput(entry);
    const ctx = buildSuppressionContext(defaultConfig, [entry]);
    expect(checkExitReasons(output, ctx)).not.toContain(
      CHECK_NON_ZERO_REASON.not_found_in_databases,
    );
  });

  it('per-entry allow with a MISSING reason still gates (reason mandatory)', () => {
    const entry = makeEntry('manu3', {
      type: 'article-journal',
      note: 'bibcheck-allow: not-found',
    });
    const output = notFoundOutput(entry);
    const ctx = buildSuppressionContext(defaultConfig, [entry]);
    expect(checkExitReasons(output, ctx)).toContain(
      CHECK_NON_ZERO_REASON.not_found_in_databases,
    );
  });

  it('with two entries, only the unsuppressed one gates', () => {
    const exempt = makeEntry('manu4', { type: 'manuscript' });
    const gated = makeEntry('fake4', { type: 'article-journal' });
    const output: Output = {
      ...notFoundOutput(exempt),
      summary: {
        ...notFoundOutput(exempt).summary,
        totalEntries: 2,
        notFoundInDatabases: 2,
      },
      entries: [
        { citekey: 'manu4', identifiers: null, existence: notFoundExistence(), canonical: null },
        { citekey: 'fake4', identifiers: null, existence: notFoundExistence(), canonical: null },
      ],
    };
    const config: Config = {
      ...defaultConfig,
      source_types: { manuscript: { gate_not_found: false } },
    };
    const ctx = buildSuppressionContext(config, [exempt, gated]);
    // One entry remains gated → still fails.
    expect(checkExitReasons(output, ctx)).toContain(
      CHECK_NON_ZERO_REASON.not_found_in_databases,
    );
  });

  it('malformed-identifier source-type does NOT exempt; an allow does', () => {
    const entry = makeEntry('badid', { type: 'manuscript', doi: 'not-a-doi' });
    const output: Output = {
      schemaVersion: SCHEMA_VERSION,
      tool: { name: 'bibcheck', version: '0.0.0' },
      summary: {
        totalEntries: 1, verified: 0, metadataMismatches: 0, notFoundInDatabases: 0,
        malformedIdentifiers: 1, unverifiable: 1, canonicalIssues: 0,
        linkageFailures: 0, phraseFlags: 0, worklistItems: 0,
      },
      entries: [
        {
          citekey: 'badid',
          identifiers: { doi: 'malformed', isbn: 'not-applicable', url: 'not-applicable' },
          existence: unverifiableExistence(),
          canonical: null,
        },
      ],
      linkage: [], phraseFlags: [], worklist: [],
    };
    // Source-type exemption does NOT cover malformed identifiers → still gates.
    const exemptCfg: Config = {
      ...defaultConfig,
      source_types: { manuscript: { gate_not_found: false } },
    };
    expect(
      checkExitReasons(output, buildSuppressionContext(exemptCfg, [entry])),
    ).toContain(CHECK_NON_ZERO_REASON.malformed_identifier);

    // A per-entry allow does suppress it.
    const allowed = makeEntry('badid', {
      type: 'manuscript',
      doi: 'not-a-doi',
      note: 'bibcheck-allow: malformed-identifier (reason: legacy hand-entered DOI)',
    });
    expect(
      checkExitReasons(output, buildSuppressionContext(defaultConfig, [allowed])),
    ).not.toContain(CHECK_NON_ZERO_REASON.malformed_identifier);
  });

  it('runCheck logs acknowledged (suppressed) findings as informational and warns on reason-less allows', async () => {
    const logger = makeMockLogger();
    const exempt = makeEntry('manu5', { type: 'manuscript' });
    const reasonless = makeEntry('manu6', {
      type: 'article-journal',
      note: 'bibcheck-allow: not-found',
    });
    const config: Config = {
      ...defaultConfig,
      source_types: { manuscript: { gate_not_found: false } },
    };
    const deps = makeBaseDeps({
      config,
      logger,
      bibliography: [exempt, reasonless],
      _runExistence: vi.fn().mockResolvedValue({
        entries: [
          { citekey: 'manu5', existence: notFoundExistence() },
          { citekey: 'manu6', existence: notFoundExistence() },
        ],
      } satisfies RunExistenceResult),
    });

    const output = await runCheck(deps);
    // Suppressed source-type finding logged as informational acknowledgement.
    const infoMock = logger.info as ReturnType<typeof vi.fn>;
    const ackCalls = infoMock.mock.calls.filter((c) => c[0] === 'check.acknowledged_finding');
    expect(ackCalls).toHaveLength(1);
    expect(ackCalls[0]?.[1]).toMatchObject({ citekey: 'manu5', suppressedBy: 'source-type' });

    // Reason-less allow warned about.
    const warnMock = logger.warn as ReturnType<typeof vi.fn>;
    const warnCalls = warnMock.mock.calls.filter(
      (c) => c[0] === 'suppression.allow_missing_reason',
    );
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]?.[1]).toMatchObject({ citekey: 'manu6' });

    // Totals keep both not-found entries (never dropped).
    expect(output.summary.notFoundInDatabases).toBe(2);
    expect(() => OutputSchema.parse(output)).not.toThrow();
  });

  it('runCheck warns on an unknown finding-type token in a bibcheck-allow note', async () => {
    const logger = makeMockLogger();
    const entry = makeEntry('typo1', {
      type: 'article-journal',
      note: 'bibcheck-allow: nonexistent-finding (reason: oops)',
    });
    const deps = makeBaseDeps({
      logger,
      bibliography: [entry],
      _runExistence: vi.fn().mockResolvedValue({
        entries: [{ citekey: 'typo1', existence: verifiedExistence() }],
      } satisfies RunExistenceResult),
    });
    await runCheck(deps);
    const warnMock = logger.warn as ReturnType<typeof vi.fn>;
    const calls = warnMock.mock.calls.filter((c) => c[0] === 'suppression.allow_unknown_type');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toMatchObject({ citekey: 'typo1', token: 'nonexistent-finding' });
  });

  it('runCheck logs an acknowledged malformed-identifier when allowed-with-reason', async () => {
    const logger = makeMockLogger();
    // Real runIdentifiers detects the malformed DOI; the allow suppresses it.
    const entry = makeEntry('legacy1', {
      type: 'article-journal',
      doi: 'not-a-doi',
      note: 'bibcheck-allow: malformed-identifier (reason: legacy hand-entered DOI)',
    });
    const http: HttpClient = {
      get: vi.fn(async () => ({ status: 200, headers: {}, body: { status: 'ok', message: {} } })),
      head: vi.fn(async (url: string) => ({ status: 200, finalUrl: url, redirectChain: [] })),
    };
    const deps = makeBaseDeps({
      logger,
      http,
      bibliography: [entry],
      _runExistence: undefined, // real runner; malformed DOI short-circuits network
      skip: new Set(['canonical', 'linkage', 'phrases', 'worklist']),
    });

    const output = await runCheck(deps);
    expect(output.entries[0]?.identifiers?.doi).toBe('malformed');
    // Still counted in the summary (never dropped).
    expect(output.summary.malformedIdentifiers).toBe(1);
    // But it does not gate, and the acknowledgement is logged.
    const ctx = buildSuppressionContext(deps.config, deps.bibliography);
    expect(checkExitReasons(output, ctx)).not.toContain(
      CHECK_NON_ZERO_REASON.malformed_identifier,
    );
    const infoMock = logger.info as ReturnType<typeof vi.fn>;
    const ackCalls = infoMock.mock.calls.filter((c) => c[0] === 'check.acknowledged_finding');
    expect(ackCalls).toHaveLength(1);
    expect(ackCalls[0]?.[1]).toMatchObject({
      citekey: 'legacy1',
      findingType: 'malformed-identifier',
      suppressedBy: 'allow',
    });
  });
});
