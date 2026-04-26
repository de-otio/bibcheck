/**
 * Comprehensive test suite for bibcheck's output schema.
 *
 * SCHEMA_VERSION semver-shape note: The regex /^0\.\d+\.\d+$/ is intentionally
 * "loose" in that it allows multi-digit patch/minor segments (e.g. '0.99.99')
 * and does not enforce SemVer pre-release/build-metadata syntax. Strings like
 * '0.1.0-rc' are rejected because the trailing '-rc' breaks the terminal `$`.
 * Leading zeros on major ('00.0.0') are also rejected. This is a deliberate
 * trade-off: strict SemVer parsing would require a larger regex or an external
 * library, and the only invariant that matters for this schema is major === 0.
 */

import { describe, it, expect } from 'vitest';
import type { Output } from '../src/schema/output.js';
import {
  SCHEMA_VERSION,
  OutputSchema,
  CanonicalLayerSchema,
  PhraseFlagSchema,
  WorklistItemSchema,
  ExistenceCheckSourceSchema,
  ExistenceCheckResultSchema,
  ExistenceStatusSchema,
  CanonicalStatusSchema,
  LinkageStatusSchema,
  PhraseFlagStatusSchema,
  WorklistItemTypeSchema,
  SummarySchema,
  LinkageReferenceSchema,
  EntrySchema,
  LinkageEntrySchema,
} from '../src/schema/output.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const BASE_SUMMARY = {
  totalEntries: 0,
  verified: 0,
  metadataMismatches: 0,
  unverifiable: 0,
  canonicalIssues: 0,
  linkageFailures: 0,
  phraseFlags: 0,
  worklistItems: 0,
} satisfies Output['summary'];

function makeOutput(overrides: Partial<Output> = {}): Output {
  return {
    schemaVersion: SCHEMA_VERSION,
    tool: { name: 'bibcheck', version: '0.0.1' },
    summary: BASE_SUMMARY,
    entries: [],
    linkage: [],
    phraseFlags: [],
    worklist: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Minimal valid output
// ---------------------------------------------------------------------------

describe('OutputSchema — minimal valid output', () => {
  it('accepts a fully empty output', () => {
    const result = OutputSchema.parse(makeOutput());
    expect(result.schemaVersion).toBe(SCHEMA_VERSION);
    expect(result.entries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Schema version validation
// ---------------------------------------------------------------------------

describe('OutputSchema — schemaVersion', () => {
  it.each([
    ['0.1.0', true],
    ['0.1.5', true],
    ['0.99.99', true],
    ['0.0.1', true],
    // Reject major !== 0
    ['1.0.0', false],
    ['2.0.0', false],
    // Reject malformed strings
    ['0.1', false],
    ['0.1.0-rc', false],
    ['a.b.c', false],
    // Leading zero on major — not a valid major-0 document
    ['00.0.0', false],
  ])('schemaVersion %s → accepts: %s', (version, shouldAccept) => {
    const raw = makeOutput({ schemaVersion: version as Output['schemaVersion'] });
    if (shouldAccept) {
      expect(() => OutputSchema.parse(raw)).not.toThrow();
    } else {
      expect(() => OutputSchema.parse(raw)).toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Enum exhaustiveness
// ---------------------------------------------------------------------------

describe('ExistenceCheckSourceSchema', () => {
  it.each([
    ['crossref', true],
    ['openalex', true],
    ['openlibrary', true],
    ['worldcat', true],
    // Removed member
    ['doi-url', false],
    ['bogus', false],
  ])('value %s → valid: %s', (value, shouldAccept) => {
    if (shouldAccept) {
      expect(() => ExistenceCheckSourceSchema.parse(value)).not.toThrow();
    } else {
      expect(() => ExistenceCheckSourceSchema.parse(value)).toThrow();
    }
  });
});

describe('ExistenceCheckResultSchema', () => {
  it.each([
    ['no-doi', true],
    ['found', true],
    ['not-found', true],
    ['metadata-mismatch', true],
    ['error', true],
    // Removed member
    ['no-isbn', false],
    ['bogus', false],
  ])('value %s → valid: %s', (value, shouldAccept) => {
    if (shouldAccept) {
      expect(() => ExistenceCheckResultSchema.parse(value)).not.toThrow();
    } else {
      expect(() => ExistenceCheckResultSchema.parse(value)).toThrow();
    }
  });
});

describe('ExistenceStatusSchema', () => {
  it.each([
    ['verified', true],
    ['metadata-mismatch', true],
    ['not-found-in-databases', true],
    ['unverifiable', true],
    ['bogus', false],
  ])('value %s → valid: %s', (value, shouldAccept) => {
    if (shouldAccept) {
      expect(() => ExistenceStatusSchema.parse(value)).not.toThrow();
    } else {
      expect(() => ExistenceStatusSchema.parse(value)).toThrow();
    }
  });
});

describe('CanonicalStatusSchema', () => {
  it.each([
    ['verified-canonical', true],
    ['wrong-host', true],
    ['dead-url', true],
    ['live-url-not-archived-snapshot', true],
    ['no-url-on-pre-doi-entry', true],
    ['not-applicable', true],
    ['bogus', false],
  ])('value %s → valid: %s', (value, shouldAccept) => {
    if (shouldAccept) {
      expect(() => CanonicalStatusSchema.parse(value)).not.toThrow();
    } else {
      expect(() => CanonicalStatusSchema.parse(value)).toThrow();
    }
  });
});

describe('LinkageStatusSchema', () => {
  it.each([
    ['resolved', true],
    ['unresolved', true],
    ['bogus', false],
  ])('value %s → valid: %s', (value, shouldAccept) => {
    if (shouldAccept) {
      expect(() => LinkageStatusSchema.parse(value)).not.toThrow();
    } else {
      expect(() => LinkageStatusSchema.parse(value)).toThrow();
    }
  });
});

describe('PhraseFlagStatusSchema', () => {
  it.each([
    ['flagged', true],
    ['acknowledged', true],
    ['bogus', false],
  ])('value %s → valid: %s', (value, shouldAccept) => {
    if (shouldAccept) {
      expect(() => PhraseFlagStatusSchema.parse(value)).not.toThrow();
    } else {
      expect(() => PhraseFlagStatusSchema.parse(value)).toThrow();
    }
  });
});

describe('WorklistItemTypeSchema', () => {
  it.each([
    ['direct-quotation', true],
    ['paraphrase-with-page-ref', true],
    ['contested-source-type', true],
    ['non-canonical-edition', true],
    ['bogus', false],
  ])('value %s → valid: %s', (value, shouldAccept) => {
    if (shouldAccept) {
      expect(() => WorklistItemTypeSchema.parse(value)).not.toThrow();
    } else {
      expect(() => WorklistItemTypeSchema.parse(value)).toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. URL scheme constraints (httpUrl helper)
// ---------------------------------------------------------------------------

const ACCEPT_URLS = [
  'https://example.org',
  'http://example.org/path',
  'https://archive.org/details/mill1859onliberty',
  'https://plato.stanford.edu/archives/win2023/entries/liberty/',
];

const REJECT_URLS = [
  'javascript:alert(1)',
  'file:///etc/passwd',
  'data:text/html,<script>',
  'ftp://example.org',
  'not-a-url-at-all',
];

describe('httpUrl — CanonicalLayerSchema.url', () => {
  it.each(ACCEPT_URLS)('accepts %s', (url) => {
    expect(() =>
      CanonicalLayerSchema.parse({ status: 'verified-canonical', url })
    ).not.toThrow();
  });
  it('accepts null url', () => {
    expect(() =>
      CanonicalLayerSchema.parse({ status: 'not-applicable', url: null })
    ).not.toThrow();
  });
  it.each(REJECT_URLS)('rejects %s', (url) => {
    expect(() =>
      CanonicalLayerSchema.parse({ status: 'verified-canonical', url })
    ).toThrow();
  });
});

describe('httpUrl — PhraseFlagSchema.referenceUrl', () => {
  const baseFlag = {
    status: 'flagged' as const,
    patternKey: 'deprecated-term',
    file: 'docs/chapter1.md',
    line: 10,
    matchedText: 'some phrase',
  };
  it.each(ACCEPT_URLS)('accepts %s', (url) => {
    expect(() => PhraseFlagSchema.parse({ ...baseFlag, referenceUrl: url })).not.toThrow();
  });
  it('accepts null referenceUrl', () => {
    expect(() => PhraseFlagSchema.parse({ ...baseFlag, referenceUrl: null })).not.toThrow();
  });
  it.each(REJECT_URLS)('rejects %s', (url) => {
    expect(() => PhraseFlagSchema.parse({ ...baseFlag, referenceUrl: url })).toThrow();
  });
});

describe('httpUrl — WorklistItemSchema.verificationUrl', () => {
  const baseItem = {
    type: 'direct-quotation' as const,
    file: 'docs/chapter1.md',
    line: 55,
    citation: '@mill1859onliberty',
    snippet: 'The only purpose for which power can be rightfully exercised...',
    recommendedAction: 'Verify verbatim against named edition.',
  };
  it.each(ACCEPT_URLS)('accepts %s', (url) => {
    expect(() =>
      WorklistItemSchema.parse({ ...baseItem, verificationUrl: url })
    ).not.toThrow();
  });
  it('accepts null verificationUrl', () => {
    expect(() =>
      WorklistItemSchema.parse({ ...baseItem, verificationUrl: null })
    ).not.toThrow();
  });
  it.each(REJECT_URLS)('rejects %s', (url) => {
    expect(() =>
      WorklistItemSchema.parse({ ...baseItem, verificationUrl: url })
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 5. Empty-string rejection (.min(1) fields)
// ---------------------------------------------------------------------------

describe('Empty-string rejection', () => {
  it('EntrySchema.citekey rejects empty string', () => {
    expect(() =>
      EntrySchema.parse({ citekey: '', existence: null, canonical: null })
    ).toThrow();
  });

  it('LinkageReferenceSchema.file rejects empty string', () => {
    expect(() =>
      LinkageReferenceSchema.parse({ file: '', line: 1 })
    ).toThrow();
  });

  it('LinkageEntrySchema.citekey rejects empty string', () => {
    expect(() =>
      LinkageEntrySchema.parse({ citekey: '', status: 'resolved', references: [] })
    ).toThrow();
  });

  it('PhraseFlagSchema.patternKey rejects empty string', () => {
    expect(() =>
      PhraseFlagSchema.parse({
        status: 'flagged',
        patternKey: '',
        referenceUrl: null,
        file: 'docs/a.md',
        line: 1,
        matchedText: 'phrase',
      })
    ).toThrow();
  });

  it('PhraseFlagSchema.file rejects empty string', () => {
    expect(() =>
      PhraseFlagSchema.parse({
        status: 'flagged',
        patternKey: 'key',
        referenceUrl: null,
        file: '',
        line: 1,
        matchedText: 'phrase',
      })
    ).toThrow();
  });

  it('PhraseFlagSchema.matchedText rejects empty string', () => {
    expect(() =>
      PhraseFlagSchema.parse({
        status: 'flagged',
        patternKey: 'key',
        referenceUrl: null,
        file: 'docs/a.md',
        line: 1,
        matchedText: '',
      })
    ).toThrow();
  });

  it('WorklistItemSchema.file rejects empty string', () => {
    expect(() =>
      WorklistItemSchema.parse({
        type: 'direct-quotation',
        file: '',
        line: 1,
        citation: '@cite',
        snippet: 'some text',
        verificationUrl: null,
        recommendedAction: 'Check it.',
      })
    ).toThrow();
  });

  it('WorklistItemSchema.citation rejects empty string', () => {
    expect(() =>
      WorklistItemSchema.parse({
        type: 'direct-quotation',
        file: 'docs/a.md',
        line: 1,
        citation: '',
        snippet: 'some text',
        verificationUrl: null,
        recommendedAction: 'Check it.',
      })
    ).toThrow();
  });

  it('WorklistItemSchema.snippet rejects empty string', () => {
    expect(() =>
      WorklistItemSchema.parse({
        type: 'direct-quotation',
        file: 'docs/a.md',
        line: 1,
        citation: '@cite',
        snippet: '',
        verificationUrl: null,
        recommendedAction: 'Check it.',
      })
    ).toThrow();
  });

  it('WorklistItemSchema.recommendedAction rejects empty string', () => {
    expect(() =>
      WorklistItemSchema.parse({
        type: 'direct-quotation',
        file: 'docs/a.md',
        line: 1,
        citation: '@cite',
        snippet: 'some text',
        verificationUrl: null,
        recommendedAction: '',
      })
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 6. Numeric boundary tests
// ---------------------------------------------------------------------------

describe('SummarySchema numeric boundaries', () => {
  const fields = [
    'totalEntries',
    'verified',
    'metadataMismatches',
    'unverifiable',
    'canonicalIssues',
    'linkageFailures',
    'phraseFlags',
    'worklistItems',
  ] as const;

  it.each(fields)('field %s: rejects -1', (field) => {
    expect(() => SummarySchema.parse({ ...BASE_SUMMARY, [field]: -1 })).toThrow();
  });

  it.each(fields)('field %s: rejects 1.5', (field) => {
    expect(() => SummarySchema.parse({ ...BASE_SUMMARY, [field]: 1.5 })).toThrow();
  });

  it.each(fields)('field %s: accepts 0', (field) => {
    expect(() => SummarySchema.parse({ ...BASE_SUMMARY, [field]: 0 })).not.toThrow();
  });

  it.each(fields)('field %s: accepts 1', (field) => {
    expect(() => SummarySchema.parse({ ...BASE_SUMMARY, [field]: 1 })).not.toThrow();
  });
});

describe('Line number boundaries', () => {
  it('LinkageReferenceSchema.line rejects 0', () => {
    expect(() => LinkageReferenceSchema.parse({ file: 'a.md', line: 0 })).toThrow();
  });
  it('LinkageReferenceSchema.line rejects -1', () => {
    expect(() => LinkageReferenceSchema.parse({ file: 'a.md', line: -1 })).toThrow();
  });
  it('LinkageReferenceSchema.line rejects 1.5', () => {
    expect(() => LinkageReferenceSchema.parse({ file: 'a.md', line: 1.5 })).toThrow();
  });
  it('LinkageReferenceSchema.line accepts 1', () => {
    expect(() => LinkageReferenceSchema.parse({ file: 'a.md', line: 1 })).not.toThrow();
  });

  it('PhraseFlagSchema.line rejects 0', () => {
    expect(() =>
      PhraseFlagSchema.parse({
        status: 'flagged',
        patternKey: 'k',
        referenceUrl: null,
        file: 'a.md',
        line: 0,
        matchedText: 'phrase',
      })
    ).toThrow();
  });
  it('PhraseFlagSchema.line rejects -1', () => {
    expect(() =>
      PhraseFlagSchema.parse({
        status: 'flagged',
        patternKey: 'k',
        referenceUrl: null,
        file: 'a.md',
        line: -1,
        matchedText: 'phrase',
      })
    ).toThrow();
  });
  it('PhraseFlagSchema.line rejects 1.5', () => {
    expect(() =>
      PhraseFlagSchema.parse({
        status: 'flagged',
        patternKey: 'k',
        referenceUrl: null,
        file: 'a.md',
        line: 1.5,
        matchedText: 'phrase',
      })
    ).toThrow();
  });
  it('PhraseFlagSchema.line accepts 1', () => {
    expect(() =>
      PhraseFlagSchema.parse({
        status: 'flagged',
        patternKey: 'k',
        referenceUrl: null,
        file: 'a.md',
        line: 1,
        matchedText: 'phrase',
      })
    ).not.toThrow();
  });

  it('WorklistItemSchema.line rejects 0', () => {
    expect(() =>
      WorklistItemSchema.parse({
        type: 'direct-quotation',
        file: 'a.md',
        line: 0,
        citation: '@cite',
        snippet: 'text',
        verificationUrl: null,
        recommendedAction: 'Check.',
      })
    ).toThrow();
  });
  it('WorklistItemSchema.line rejects -1', () => {
    expect(() =>
      WorklistItemSchema.parse({
        type: 'direct-quotation',
        file: 'a.md',
        line: -1,
        citation: '@cite',
        snippet: 'text',
        verificationUrl: null,
        recommendedAction: 'Check.',
      })
    ).toThrow();
  });
  it('WorklistItemSchema.line rejects 1.5', () => {
    expect(() =>
      WorklistItemSchema.parse({
        type: 'direct-quotation',
        file: 'a.md',
        line: 1.5,
        citation: '@cite',
        snippet: 'text',
        verificationUrl: null,
        recommendedAction: 'Check.',
      })
    ).toThrow();
  });
  it('WorklistItemSchema.line accepts 1', () => {
    expect(() =>
      WorklistItemSchema.parse({
        type: 'direct-quotation',
        file: 'a.md',
        line: 1,
        citation: '@cite',
        snippet: 'text',
        verificationUrl: null,
        recommendedAction: 'Check.',
      })
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 7. Populated LinkageEntry (resolved and unresolved)
// ---------------------------------------------------------------------------

describe('LinkageEntrySchema — populated entries', () => {
  it('accepts a resolved entry with references', () => {
    expect(() =>
      LinkageEntrySchema.parse({
        citekey: 'mill1859onliberty',
        status: 'resolved',
        references: [
          { file: 'docs/chapter1.md', line: 42 },
          { file: 'docs/chapter3.md', line: 17 },
        ],
      })
    ).not.toThrow();
  });

  it('accepts an unresolved entry with references', () => {
    expect(() =>
      LinkageEntrySchema.parse({
        citekey: 'habermas1962strukturwandel',
        status: 'unresolved',
        references: [
          { file: 'docs/intro.md', line: 5 },
        ],
      })
    ).not.toThrow();
  });

  it('accepts a resolved entry with empty references', () => {
    expect(() =>
      LinkageEntrySchema.parse({
        citekey: 'kant1781kritik',
        status: 'resolved',
        references: [],
      })
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 8. redirectChain with populated https URLs
// ---------------------------------------------------------------------------

describe('CanonicalLayerSchema — redirectChain', () => {
  it('accepts a redirect chain with 3 https URLs', () => {
    expect(() =>
      CanonicalLayerSchema.parse({
        status: 'verified-canonical',
        url: 'https://archive.org/details/mill1859onliberty',
        redirectChain: [
          'https://archive.org/details/mill1859onliberty',
          'https://archive.org/details/mill1859onliberty/mode/2up',
          'https://archive.org/stream/mill1859onliberty/mill1859onliberty_djvu.txt',
        ],
      })
    ).not.toThrow();
  });

  it('rejects a redirect chain containing a non-http URL', () => {
    expect(() =>
      CanonicalLayerSchema.parse({
        status: 'verified-canonical',
        url: 'https://archive.org/details/example',
        redirectChain: [
          'https://archive.org/details/example',
          'ftp://archive.org/details/example',
        ],
      })
    ).toThrow();
  });

  it('accepts CanonicalLayer with no redirectChain field', () => {
    expect(() =>
      CanonicalLayerSchema.parse({
        status: 'not-applicable',
        url: null,
      })
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 9. Cross-field invariants (superRefine)
// ---------------------------------------------------------------------------

describe('OutputSchema — superRefine cross-field invariants', () => {
  it('rejects when summary.verified > summary.totalEntries', () => {
    expect(() =>
      OutputSchema.parse(
        makeOutput({ summary: { ...BASE_SUMMARY, totalEntries: 1, verified: 2 } })
      )
    ).toThrow();
  });

  it('accepts when summary.verified === summary.totalEntries', () => {
    expect(() =>
      OutputSchema.parse(
        makeOutput({ summary: { ...BASE_SUMMARY, totalEntries: 2, verified: 2 } })
      )
    ).not.toThrow();
  });

  it('rejects when summary.metadataMismatches > summary.totalEntries', () => {
    expect(() =>
      OutputSchema.parse(
        makeOutput({ summary: { ...BASE_SUMMARY, totalEntries: 0, metadataMismatches: 1 } })
      )
    ).toThrow();
  });

  it('rejects when summary.unverifiable > summary.totalEntries', () => {
    expect(() =>
      OutputSchema.parse(
        makeOutput({ summary: { ...BASE_SUMMARY, totalEntries: 0, unverifiable: 1 } })
      )
    ).toThrow();
  });

  it('rejects when summary.canonicalIssues > summary.totalEntries', () => {
    expect(() =>
      OutputSchema.parse(
        makeOutput({ summary: { ...BASE_SUMMARY, totalEntries: 0, canonicalIssues: 1 } })
      )
    ).toThrow();
  });

  it('rejects when summary.phraseFlags does not equal count of flagged entries', () => {
    const flag = {
      status: 'flagged' as const,
      patternKey: 'deprecated-term',
      referenceUrl: null,
      file: 'docs/a.md',
      line: 1,
      matchedText: 'deprecated',
    };
    // phraseFlags says 0 but there is 1 flagged entry
    expect(() =>
      OutputSchema.parse(
        makeOutput({
          summary: { ...BASE_SUMMARY, phraseFlags: 0 },
          phraseFlags: [flag],
        })
      )
    ).toThrow();
  });

  it('accepts when summary.phraseFlags equals count of flagged (not acknowledged) entries', () => {
    const flagged = {
      status: 'flagged' as const,
      patternKey: 'deprecated-term',
      referenceUrl: null,
      file: 'docs/a.md',
      line: 1,
      matchedText: 'deprecated',
    };
    const acknowledged = {
      status: 'acknowledged' as const,
      patternKey: 'another-term',
      referenceUrl: null,
      file: 'docs/b.md',
      line: 5,
      matchedText: 'another phrase',
    };
    // 1 flagged + 1 acknowledged = summary.phraseFlags must be 1
    expect(() =>
      OutputSchema.parse(
        makeOutput({
          summary: { ...BASE_SUMMARY, phraseFlags: 1 },
          phraseFlags: [flagged, acknowledged],
        })
      )
    ).not.toThrow();
  });

  it('rejects when summary.worklistItems does not equal worklist.length', () => {
    const item = {
      type: 'direct-quotation' as const,
      file: 'docs/a.md',
      line: 10,
      citation: '@mill1859onliberty',
      snippet: 'The only purpose for which power...',
      verificationUrl: null,
      recommendedAction: 'Verify verbatim.',
    };
    expect(() =>
      OutputSchema.parse(
        makeOutput({
          summary: { ...BASE_SUMMARY, worklistItems: 0 },
          worklist: [item],
        })
      )
    ).toThrow();
  });

  it('accepts when summary.worklistItems equals worklist.length', () => {
    const item = {
      type: 'direct-quotation' as const,
      file: 'docs/a.md',
      line: 10,
      citation: '@mill1859onliberty',
      snippet: 'The only purpose for which power...',
      verificationUrl: null,
      recommendedAction: 'Verify verbatim.',
    };
    expect(() =>
      OutputSchema.parse(
        makeOutput({
          summary: { ...BASE_SUMMARY, worklistItems: 1 },
          worklist: [item],
        })
      )
    ).not.toThrow();
  });

  it('rejects when summary.linkageFailures does not equal count of unresolved linkage entries', () => {
    const unresolved = {
      citekey: 'habermas1962strukturwandel',
      status: 'unresolved' as const,
      references: [{ file: 'docs/intro.md', line: 3 }],
    };
    expect(() =>
      OutputSchema.parse(
        makeOutput({
          summary: { ...BASE_SUMMARY, linkageFailures: 0 },
          linkage: [unresolved],
        })
      )
    ).toThrow();
  });

  it('accepts when summary.linkageFailures equals count of unresolved linkage entries', () => {
    const resolved = {
      citekey: 'mill1859onliberty',
      status: 'resolved' as const,
      references: [{ file: 'docs/ch1.md', line: 1 }],
    };
    const unresolved = {
      citekey: 'habermas1962strukturwandel',
      status: 'unresolved' as const,
      references: [{ file: 'docs/intro.md', line: 3 }],
    };
    expect(() =>
      OutputSchema.parse(
        makeOutput({
          summary: { ...BASE_SUMMARY, linkageFailures: 1 },
          linkage: [resolved, unresolved],
        })
      )
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 10. Required-field rejection breadth
// ---------------------------------------------------------------------------

describe('OutputSchema — required top-level fields', () => {
  const base = makeOutput();
  it.each([
    'schemaVersion',
    'tool',
    'summary',
    'entries',
    'linkage',
    'phraseFlags',
    'worklist',
  ] as const)('rejects output missing %s', (field) => {
    const { [field]: _omit, ...incomplete } = base;
    expect(() => OutputSchema.parse(incomplete)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 11. Acknowledged phrase flag
// ---------------------------------------------------------------------------

describe('OutputSchema — acknowledged phrase flag', () => {
  it('accepts an acknowledged flag (counted separately from flagged)', () => {
    const acknowledged = {
      status: 'acknowledged' as const,
      patternKey: 'legacy-phrasing',
      referenceUrl: 'https://example.org/style-guide#legacy',
      file: 'docs/chapter2.md',
      line: 88,
      matchedText: 'legacy phrasing example',
    };
    // summary.phraseFlags counts only flagged, so 0 here
    expect(() =>
      OutputSchema.parse(
        makeOutput({
          summary: { ...BASE_SUMMARY, phraseFlags: 0 },
          phraseFlags: [acknowledged],
        })
      )
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 12. SCHEMA_VERSION shape
// ---------------------------------------------------------------------------

describe('SCHEMA_VERSION', () => {
  // Loose regex: major.minor.patch, numeric segments only, major must be 0.
  // Does not enforce SemVer pre-release/build-metadata; that is intentional.
  it('matches the major-0 pattern /^0\\.\\d+\\.\\d+$/', () => {
    expect(SCHEMA_VERSION).toMatch(/^0\.\d+\.\d+$/);
  });

  it('is the string "0.1.0"', () => {
    expect(SCHEMA_VERSION).toBe('0.1.0');
  });
});

// ---------------------------------------------------------------------------
// Integration: populated output with existence and canonical layers
// ---------------------------------------------------------------------------

describe('OutputSchema — populated integration test', () => {
  it('accepts a realistic populated output document', () => {
    const output: Output = {
      schemaVersion: SCHEMA_VERSION,
      tool: { name: 'bibcheck', version: '0.1.0' },
      summary: {
        totalEntries: 2,
        verified: 1,
        metadataMismatches: 0,
        unverifiable: 1,
        canonicalIssues: 0,
        linkageFailures: 1,
        phraseFlags: 1,
        worklistItems: 1,
      },
      entries: [
        {
          citekey: 'mill1859onliberty',
          existence: {
            status: 'verified',
            checks: [
              { source: 'openlibrary', result: 'found', evidence: { olid: 'OL7353613M' } },
              { source: 'worldcat', result: 'found', evidence: null },
            ],
          },
          canonical: {
            status: 'verified-canonical',
            url: 'https://archive.org/details/onliberty00millgoog',
            redirectChain: [
              'https://archive.org/details/onliberty00millgoog',
              'https://archive.org/details/onliberty00millgoog/mode/2up',
            ],
          },
        },
        {
          citekey: 'habermas1962strukturwandel',
          existence: {
            status: 'unverifiable',
            checks: [
              { source: 'crossref', result: 'no-doi', evidence: null },
              { source: 'openalex', result: 'not-found', evidence: null },
            ],
          },
          canonical: {
            status: 'not-applicable',
            url: null,
          },
        },
      ],
      linkage: [
        {
          citekey: 'mill1859onliberty',
          status: 'resolved',
          references: [{ file: 'docs/chapter1.md', line: 42 }],
        },
        {
          citekey: 'missing-citekey',
          status: 'unresolved',
          references: [{ file: 'docs/chapter2.md', line: 7 }],
        },
      ],
      phraseFlags: [
        {
          status: 'flagged',
          patternKey: 'deprecated-term',
          referenceUrl: 'https://example.org/style-guide',
          file: 'docs/chapter1.md',
          line: 15,
          matchedText: 'deprecated phrase',
        },
        {
          status: 'acknowledged',
          patternKey: 'historical-usage',
          referenceUrl: null,
          file: 'docs/chapter2.md',
          line: 30,
          matchedText: 'historical phrase',
        },
      ],
      worklist: [
        {
          type: 'direct-quotation',
          file: 'docs/chapter1.md',
          line: 42,
          citation: '@mill1859onliberty',
          snippet: 'Mill argues that the only purpose for which power can be rightfully exercised...',
          verificationUrl: 'https://archive.org/details/onliberty00millgoog',
          recommendedAction: 'Verify the quoted passage verbatim against the named edition, page 22.',
        },
      ],
    };
    expect(() => OutputSchema.parse(output)).not.toThrow();
  });
});
