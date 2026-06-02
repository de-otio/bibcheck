/**
 * Tests for the four bibcheck output renderers: JSON, Markdown, SARIF, text.
 *
 * Each describe block corresponds to one renderer. A shared fixture helper
 * builds representative Output objects that exercise all finding categories.
 *
 * Coverage target: >= 80% line + branch for src/output/**
 */

import { describe, it, expect } from 'vitest';
import type { Output } from '../src/schema/output.js';
import { OutputSchema, SCHEMA_VERSION } from '../src/schema/output.js';
import { renderJson } from '../src/output/json.js';
import { renderMarkdown } from '../src/output/markdown.js';
import { renderSarif } from '../src/output/sarif.js';
import { renderText } from '../src/output/text.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const BASE_SUMMARY: Output['summary'] = {
  totalEntries: 0,
  verified: 0,
  metadataMismatches: 0,
  notFoundInDatabases: 0,
  malformedIdentifiers: 0,
  unverifiable: 0,
  canonicalIssues: 0,
  linkageFailures: 0,
  phraseFlags: 0,
  worklistItems: 0,
};

function makeEmptyOutput(): Output {
  return OutputSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    tool: { name: 'bibcheck', version: '0.0.0' },
    summary: BASE_SUMMARY,
    entries: [],
    linkage: [],
    phraseFlags: [],
    worklist: [],
  });
}

function makePopulatedOutput(): Output {
  return OutputSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    tool: { name: 'bibcheck', version: '0.0.0' },
    summary: {
      totalEntries: 3,
      verified: 1,
      metadataMismatches: 1,
      notFoundInDatabases: 0,
      malformedIdentifiers: 0,
      unverifiable: 1,
      canonicalIssues: 2,
      linkageFailures: 1,
      phraseFlags: 1,
      worklistItems: 1,
    },
    entries: [
      {
        citekey: 'mill1859onliberty',
        identifiers: { doi: 'not-applicable', isbn: 'ok', url: 'not-applicable' },
        existence: {
          status: 'verified',
          evidence: 'exists-metadata-match',
          checkedFor: ['existence', 'metadata'],
          notCheckedFor: ['canonical-url', 'claim-support'],
          checks: [{ source: 'openlibrary', result: 'found', evidence: null }],
          error: null,
        },
        canonical: {
          status: 'verified-canonical',
          url: 'https://archive.org/details/onliberty00millgoog',
        },
      },
      {
        citekey: 'habermas1962strukturwandel',
        identifiers: { doi: 'ok', isbn: 'not-applicable', url: 'not-applicable' },
        existence: {
          status: 'metadata-mismatch',
          evidence: 'exists-metadata-mismatch',
          checkedFor: ['existence', 'metadata'],
          notCheckedFor: ['canonical-url', 'claim-support'],
          checks: [{ source: 'crossref', result: 'metadata-mismatch', evidence: null }],
          error: null,
        },
        canonical: {
          status: 'dead-url',
          url: 'https://example.org/habermas',
        },
      },
      {
        citekey: 'kant1781kritik',
        identifiers: { doi: 'not-applicable', isbn: 'not-applicable', url: 'not-applicable' },
        existence: {
          status: 'unverifiable',
          evidence: 'unverifiable',
          checkedFor: [],
          notCheckedFor: ['existence', 'metadata', 'canonical-url', 'claim-support'],
          checks: [{ source: 'crossref', result: 'no-doi', evidence: null }],
          error: null,
        },
        canonical: {
          status: 'wrong-host',
          url: 'https://bad-host.example.com/kant',
        },
      },
    ],
    linkage: [
      {
        citekey: 'mill1859onliberty',
        status: 'resolved',
        references: [{ file: 'docs/chapter1.md', line: 10 }],
      },
      {
        citekey: 'missing-key',
        status: 'unresolved',
        references: [
          { file: 'docs/chapter2.md', line: 42 },
          { file: 'docs/intro.md', line: 5 },
        ],
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
        snippet: 'The only purpose for which power can be rightfully exercised...',
        verificationUrl: 'https://archive.org/details/onliberty00millgoog',
        recommendedAction: 'Verify verbatim against named edition.',
      },
    ],
  });
}

/**
 * Output exercising the 0.2.0 gating-finding renderer branches:
 * a not-found-in-databases existence entry and entries with each
 * identifier-problem variant (malformed DOI, malformed ISBN, bad-checksum
 * ISBN, malformed URL).
 */
function makeGatingOutput(): Output {
  return OutputSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    tool: { name: 'bibcheck', version: '0.0.0' },
    summary: {
      totalEntries: 3,
      verified: 0,
      metadataMismatches: 0,
      notFoundInDatabases: 1,
      malformedIdentifiers: 3,
      unverifiable: 2,
      canonicalIssues: 0,
      linkageFailures: 0,
      phraseFlags: 0,
      worklistItems: 0,
    },
    entries: [
      {
        citekey: 'fabricated2099',
        identifiers: { doi: 'ok', isbn: 'not-applicable', url: 'not-applicable' },
        existence: {
          status: 'not-found-in-databases',
          evidence: 'absent',
          checkedFor: ['existence'],
          notCheckedFor: ['metadata', 'canonical-url', 'claim-support'],
          checks: [{ source: 'crossref', result: 'not-found', evidence: null }],
          error: null,
        },
        canonical: { status: 'not-applicable', url: null },
      },
      {
        citekey: 'baddoi',
        identifiers: { doi: 'malformed', isbn: 'bad-checksum', url: 'malformed' },
        existence: {
          status: 'unverifiable',
          evidence: 'unverifiable',
          checkedFor: [],
          notCheckedFor: ['existence', 'metadata', 'canonical-url', 'claim-support'],
          checks: [{ source: 'crossref', result: 'error', evidence: { error: 'skipped' } }],
          error: 'Identifier validation failed; existence lookup skipped.',
        },
        canonical: { status: 'not-applicable', url: null },
      },
      {
        citekey: 'badisbnshape',
        identifiers: { doi: 'not-applicable', isbn: 'malformed', url: 'not-applicable' },
        existence: {
          status: 'unverifiable',
          evidence: 'unverifiable',
          checkedFor: [],
          notCheckedFor: ['existence', 'metadata', 'canonical-url', 'claim-support'],
          checks: [{ source: 'crossref', result: 'error', evidence: { error: 'skipped' } }],
          error: 'Identifier validation failed; existence lookup skipped.',
        },
        canonical: { status: 'not-applicable', url: null },
      },
    ],
    linkage: [],
    phraseFlags: [],
    worklist: [],
  });
}

/**
 * Output exercising the 0.3.0 reverse-linkage (orphan) renderer branches: an
 * orphan bibliography entry alongside a resolved and an unresolved one.
 */
function makeOrphanOutput(): Output {
  return OutputSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    tool: { name: 'bibcheck', version: '0.0.0' },
    summary: {
      ...BASE_SUMMARY,
      totalEntries: 0,
      linkageFailures: 1,
      orphanedEntries: 1,
    },
    entries: [],
    linkage: [
      { citekey: 'cited2000', status: 'resolved', references: [{ file: 'docs/a.md', line: 4 }] },
      { citekey: 'missing2001', status: 'unresolved', references: [{ file: 'docs/b.md', line: 9 }] },
      { citekey: 'uncited1999', status: 'orphan', references: [] },
    ],
    phraseFlags: [],
    worklist: [],
  });
}

// ---------------------------------------------------------------------------
// JSON renderer
// ---------------------------------------------------------------------------

describe('renderJson', () => {
  it('empty output produces parseable JSON', () => {
    const text = renderJson(makeEmptyOutput());
    expect(() => JSON.parse(text)).not.toThrow();
  });

  it('empty output JSON ends with a trailing newline', () => {
    const text = renderJson(makeEmptyOutput());
    expect(text.endsWith('\n')).toBe(true);
  });

  it('empty output round-trips through OutputSchema', () => {
    const original = makeEmptyOutput();
    const text = renderJson(original);
    const parsed = OutputSchema.parse(JSON.parse(text));
    expect(parsed).toEqual(original);
  });

  it('populated output produces parseable JSON', () => {
    const text = renderJson(makePopulatedOutput());
    expect(() => JSON.parse(text)).not.toThrow();
  });

  it('populated output round-trips through OutputSchema', () => {
    const original = makePopulatedOutput();
    const text = renderJson(original);
    const parsed = OutputSchema.parse(JSON.parse(text));
    expect(parsed).toEqual(original);
  });

  it('pretty-printed by default (2-space indent)', () => {
    const text = renderJson(makeEmptyOutput());
    expect(text).toContain('  ');
  });

  it('minified when pretty:false', () => {
    const text = renderJson(makeEmptyOutput(), { pretty: false });
    // Minified JSON has no newlines except the trailing one.
    expect(text.trim().split('\n')).toHaveLength(1);
  });

  it('explicit pretty:true produces indented output', () => {
    const text = renderJson(makeEmptyOutput(), { pretty: true });
    expect(text).toContain('  ');
  });

  it('is deterministic — two renders of the same input are identical', () => {
    const output = makePopulatedOutput();
    expect(renderJson(output)).toBe(renderJson(output));
  });

  it('throws when passed an invalid object (superRefine violation)', () => {
    const bad = {
      schemaVersion: SCHEMA_VERSION,
      tool: { name: 'bibcheck', version: '0.0.0' },
      summary: { ...BASE_SUMMARY, verified: 99, totalEntries: 0 },
      entries: [],
      linkage: [],
      phraseFlags: [],
      worklist: [],
    };
    // We cast to satisfy TS; OutputSchema.parse will reject it.
    expect(() => renderJson(bad as Output)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Markdown renderer
// ---------------------------------------------------------------------------

describe('renderMarkdown', () => {
  it('empty output contains the top-level heading', () => {
    const md = renderMarkdown(makeEmptyOutput());
    expect(md).toContain('# bibcheck report');
  });

  it('empty output contains all section headings', () => {
    const md = renderMarkdown(makeEmptyOutput());
    expect(md).toContain('## Summary');
    expect(md).toContain('## Bibliography entries');
    expect(md).toContain('## Linkage');
    expect(md).toContain('## Phrase flags');
    expect(md).toContain('## Worklist');
  });

  it('empty output shows "No findings." in each content section', () => {
    const md = renderMarkdown(makeEmptyOutput());
    // Count occurrences: should appear in each of the 4 content sections.
    const count = (md.match(/No findings\./g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(4);
  });

  it('summary table contains schema version and tool', () => {
    const md = renderMarkdown(makeEmptyOutput());
    expect(md).toContain(`**Schema version:** ${SCHEMA_VERSION}`);
    expect(md).toContain('**Tool:** bibcheck@0.0.0');
  });

  it('populated output includes entry citekeys in the table', () => {
    const md = renderMarkdown(makePopulatedOutput());
    expect(md).toContain('mill1859onliberty');
    expect(md).toContain('habermas1962strukturwandel');
    expect(md).toContain('kant1781kritik');
  });

  it('populated output includes unresolved linkage citekey', () => {
    const md = renderMarkdown(makePopulatedOutput());
    expect(md).toContain('@missing-key');
  });

  it('populated output includes linkage reference file links', () => {
    const md = renderMarkdown(makePopulatedOutput());
    expect(md).toContain('docs/chapter2.md');
    expect(md).toContain('docs/intro.md');
  });

  it('populated output includes flagged phrase pattern key', () => {
    const md = renderMarkdown(makePopulatedOutput());
    expect(md).toContain('deprecated-term');
  });

  it('populated output does NOT include acknowledged phrase pattern key in Phrase flags section', () => {
    const md = renderMarkdown(makePopulatedOutput());
    // The acknowledged flag's patternKey should not appear in the phrase flags section.
    // It might appear in the entries table section, so check context.
    const phraseFlagsSection = md.split('## Phrase flags')[1]?.split('##')[0] ?? '';
    expect(phraseFlagsSection).not.toContain('historical-usage');
  });

  it('populated output includes flagged phrase matched text', () => {
    const md = renderMarkdown(makePopulatedOutput());
    expect(md).toContain('"deprecated phrase"');
  });

  it('populated output includes phrase reference URL', () => {
    const md = renderMarkdown(makePopulatedOutput());
    expect(md).toContain('https://example.org/style-guide');
  });

  it('populated output includes worklist item', () => {
    const md = renderMarkdown(makePopulatedOutput());
    expect(md).toContain('direct-quotation');
    expect(md).toContain('@mill1859onliberty');
    expect(md).toContain('Verify verbatim against named edition.');
  });

  it('worklist verification URL is present', () => {
    const md = renderMarkdown(makePopulatedOutput());
    expect(md).toContain('https://archive.org/details/onliberty00millgoog');
  });

  it('is deterministic — two renders produce identical output', () => {
    const output = makePopulatedOutput();
    expect(renderMarkdown(output)).toBe(renderMarkdown(output));
  });

  it('canonical dead-url status appears in entries table', () => {
    const md = renderMarkdown(makePopulatedOutput());
    expect(md).toContain('dead-url');
  });

  it('canonical wrong-host status appears in entries table', () => {
    const md = renderMarkdown(makePopulatedOutput());
    expect(md).toContain('wrong-host');
  });

  it('entries are sorted alphabetically by citekey', () => {
    const md = renderMarkdown(makePopulatedOutput());
    const tableSection = md.split('## Bibliography entries')[1]?.split('##')[0] ?? '';
    const hIdx = tableSection.indexOf('habermas1962strukturwandel');
    const kIdx = tableSection.indexOf('kant1781kritik');
    const mIdx = tableSection.indexOf('mill1859onliberty');
    // h < k < m alphabetically
    expect(hIdx).toBeGreaterThanOrEqual(0);
    expect(kIdx).toBeGreaterThanOrEqual(0);
    expect(mIdx).toBeGreaterThanOrEqual(0);
    expect(hIdx).toBeLessThan(kIdx);
    expect(kIdx).toBeLessThan(mIdx);
  });

  it('snapshot test: empty output structure is stable', () => {
    const md = renderMarkdown(makeEmptyOutput());
    expect(md).toMatchSnapshot();
  });

  it('snapshot test: populated output structure is stable', () => {
    const md = renderMarkdown(makePopulatedOutput());
    expect(md).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// Text renderer
// ---------------------------------------------------------------------------

describe('renderText', () => {
  it('empty output produces a summary line only', () => {
    const text = renderText(makeEmptyOutput());
    expect(text.trim()).toBe('0 errors, 0 warnings, 0 notes');
  });

  it('output ends with a trailing newline', () => {
    const text = renderText(makeEmptyOutput());
    expect(text.endsWith('\n')).toBe(true);
  });

  it('each finding line matches the <file>:<line>: <level>: <message> format', () => {
    const text = renderText(makePopulatedOutput());
    const lines = text.split('\n').filter(Boolean);
    // All but last line are findings; last is summary.
    const findingLines = lines.slice(0, -1);
    const pattern = /^[^:]+:\d+: (error|warning|note): .+$/;
    for (const line of findingLines) {
      expect(line).toMatch(pattern);
    }
  });

  it('SUMMARY line is the last line', () => {
    const text = renderText(makePopulatedOutput());
    const lines = text.split('\n').filter(Boolean);
    const lastLine = lines[lines.length - 1];
    expect(lastLine).toMatch(/^\d+ errors, \d+ warnings, \d+ notes$/);
  });

  it('dead-url canonical finding → error level', () => {
    const text = renderText(makePopulatedOutput());
    const lines = text.split('\n');
    const deadUrlLine = lines.find((l) => l.includes('dead-url'));
    expect(deadUrlLine).toBeDefined();
    expect(deadUrlLine).toContain(': error:');
  });

  it('wrong-host canonical finding → error level', () => {
    const text = renderText(makePopulatedOutput());
    const lines = text.split('\n');
    const wrongHostLine = lines.find((l) => l.includes('wrong-host'));
    expect(wrongHostLine).toBeDefined();
    expect(wrongHostLine).toContain(': error:');
  });

  it('metadata-mismatch existence finding → error level', () => {
    const text = renderText(makePopulatedOutput());
    const lines = text.split('\n');
    const mismatchLine = lines.find((l) => l.includes('metadata-mismatch'));
    expect(mismatchLine).toBeDefined();
    expect(mismatchLine).toContain(': error:');
  });

  it('unresolved linkage finding → error level', () => {
    const text = renderText(makePopulatedOutput());
    const lines = text.split('\n');
    const unresolvedLine = lines.find((l) => l.includes('unresolved linkage'));
    expect(unresolvedLine).toBeDefined();
    expect(unresolvedLine).toContain(': error:');
  });

  it('phrase flag finding → warning level', () => {
    const text = renderText(makePopulatedOutput());
    const lines = text.split('\n');
    const phraseLine = lines.find((l) => l.includes('deprecated-term'));
    expect(phraseLine).toBeDefined();
    expect(phraseLine).toContain(': warning:');
  });

  it('acknowledged phrase flag → NOT in output', () => {
    const text = renderText(makePopulatedOutput());
    expect(text).not.toContain('historical-usage');
  });

  it('worklist finding → note level', () => {
    const text = renderText(makePopulatedOutput());
    const lines = text.split('\n');
    const worklistLine = lines.find((l) => l.includes('worklist') && l.includes('direct-quotation'));
    expect(worklistLine).toBeDefined();
    expect(worklistLine).toContain(': note:');
  });

  it('unverifiable existence → note level', () => {
    const text = renderText(makePopulatedOutput());
    const lines = text.split('\n');
    const unverifLine = lines.find((l) => l.includes('unverifiable'));
    expect(unverifLine).toBeDefined();
    expect(unverifLine).toContain(': note:');
  });

  it('summary counts are correct', () => {
    const text = renderText(makePopulatedOutput());
    const lines = text.split('\n').filter(Boolean);
    const summaryLine = lines[lines.length - 1] ?? '';
    // Check that summary has expected format with nonzero counts.
    expect(summaryLine).toMatch(/\d+ errors, \d+ warnings, \d+ notes/);
    // There should be errors and warnings in the populated fixture.
    const [errPart, warnPart] = summaryLine.split(',');
    const errCount = parseInt(errPart ?? '0', 10);
    const warnCount = parseInt((warnPart ?? '0').trim(), 10);
    expect(errCount).toBeGreaterThan(0);
    expect(warnCount).toBeGreaterThan(0);
  });

  it('is deterministic — two renders produce identical output', () => {
    const output = makePopulatedOutput();
    expect(renderText(output)).toBe(renderText(output));
  });

  it('unresolved linkage generates one line per reference location', () => {
    const text = renderText(makePopulatedOutput());
    const lines = text.split('\n').filter((l) => l.includes('unresolved linkage'));
    // missing-key has 2 references.
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// SARIF renderer
// ---------------------------------------------------------------------------

describe('renderSarif', () => {
  function parseSarif(output: Output): Record<string, unknown> {
    const text = renderSarif(output);
    return JSON.parse(text) as Record<string, unknown>;
  }

  // -- Structural invariants (avoid full schema validation to keep tests fast) --

  it('empty output produces parseable JSON', () => {
    const text = renderSarif(makeEmptyOutput());
    expect(() => JSON.parse(text)).not.toThrow();
  });

  it('output ends with a trailing newline', () => {
    const text = renderSarif(makeEmptyOutput());
    expect(text.endsWith('\n')).toBe(true);
  });

  it('top-level version is "2.1.0"', () => {
    const doc = parseSarif(makeEmptyOutput());
    expect(doc['version']).toBe('2.1.0');
  });

  it('$schema is the https JSON schema URL', () => {
    const doc = parseSarif(makeEmptyOutput());
    expect(doc['$schema']).toBe('https://json.schemastore.org/sarif-2.1.0.json');
  });

  it('runs is an array', () => {
    const doc = parseSarif(makeEmptyOutput());
    expect(Array.isArray(doc['runs'])).toBe(true);
  });

  it('runs[0].tool.driver.name is "bibcheck"', () => {
    const doc = parseSarif(makeEmptyOutput());
    const runs = doc['runs'] as Array<Record<string, unknown>>;
    const driver = (runs[0]?.['tool'] as Record<string, unknown>)?.['driver'] as Record<string, unknown>;
    expect(driver?.['name']).toBe('bibcheck');
  });

  it('runs[0].tool.driver.informationUri is a string', () => {
    const doc = parseSarif(makeEmptyOutput());
    const runs = doc['runs'] as Array<Record<string, unknown>>;
    const driver = (runs[0]?.['tool'] as Record<string, unknown>)?.['driver'] as Record<string, unknown>;
    expect(typeof driver?.['informationUri']).toBe('string');
  });

  it('runs[0].results is an array', () => {
    const doc = parseSarif(makeEmptyOutput());
    const runs = doc['runs'] as Array<Record<string, unknown>>;
    expect(Array.isArray(runs[0]?.['results'])).toBe(true);
  });

  it('empty output has zero results', () => {
    const doc = parseSarif(makeEmptyOutput());
    const runs = doc['runs'] as Array<Record<string, unknown>>;
    expect((runs[0]?.['results'] as unknown[]).length).toBe(0);
  });

  it('originalUriBaseIds.PROJECTROOT is present', () => {
    const doc = parseSarif(makeEmptyOutput());
    const runs = doc['runs'] as Array<Record<string, unknown>>;
    const uriBaseIds = runs[0]?.['originalUriBaseIds'] as Record<string, unknown> | undefined;
    expect(uriBaseIds?.['PROJECTROOT']).toBeDefined();
  });

  it('rules array is present on driver', () => {
    const doc = parseSarif(makePopulatedOutput());
    const runs = doc['runs'] as Array<Record<string, unknown>>;
    const driver = (runs[0]?.['tool'] as Record<string, unknown>)?.['driver'] as Record<string, unknown>;
    expect(Array.isArray(driver?.['rules'])).toBe(true);
  });

  // -- Finding-level assertions --

  it('dead-url canonical → SARIF result with ruleId bibcheck/canonical/dead-url', () => {
    const doc = parseSarif(makePopulatedOutput());
    const runs = doc['runs'] as Array<Record<string, unknown>>;
    const results = runs[0]?.['results'] as Array<Record<string, unknown>>;
    const found = results.find((r) => r['ruleId'] === 'bibcheck/canonical/dead-url');
    expect(found).toBeDefined();
  });

  it('dead-url canonical → level: error', () => {
    const doc = parseSarif(makePopulatedOutput());
    const runs = doc['runs'] as Array<Record<string, unknown>>;
    const results = runs[0]?.['results'] as Array<Record<string, unknown>>;
    const found = results.find((r) => r['ruleId'] === 'bibcheck/canonical/dead-url');
    expect(found?.['level']).toBe('error');
  });

  it('wrong-host canonical → SARIF result with ruleId bibcheck/canonical/wrong-host', () => {
    const doc = parseSarif(makePopulatedOutput());
    const runs = doc['runs'] as Array<Record<string, unknown>>;
    const results = runs[0]?.['results'] as Array<Record<string, unknown>>;
    const found = results.find((r) => r['ruleId'] === 'bibcheck/canonical/wrong-host');
    expect(found).toBeDefined();
    expect(found?.['level']).toBe('error');
  });

  it('flagged phrase → SARIF result with level: warning (not error)', () => {
    const doc = parseSarif(makePopulatedOutput());
    const runs = doc['runs'] as Array<Record<string, unknown>>;
    const results = runs[0]?.['results'] as Array<Record<string, unknown>>;
    const found = results.find((r) =>
      (r['ruleId'] as string)?.startsWith('bibcheck/phrase/')
    );
    expect(found).toBeDefined();
    expect(found?.['level']).toBe('warning');
  });

  it('flagged phrase ruleId includes the pattern key', () => {
    const doc = parseSarif(makePopulatedOutput());
    const runs = doc['runs'] as Array<Record<string, unknown>>;
    const results = runs[0]?.['results'] as Array<Record<string, unknown>>;
    const found = results.find((r) => r['ruleId'] === 'bibcheck/phrase/deprecated-term');
    expect(found).toBeDefined();
  });

  it('acknowledged phrase → NOT in SARIF results', () => {
    const doc = parseSarif(makePopulatedOutput());
    const runs = doc['runs'] as Array<Record<string, unknown>>;
    const results = runs[0]?.['results'] as Array<Record<string, unknown>>;
    const found = results.find((r) => r['ruleId'] === 'bibcheck/phrase/historical-usage');
    expect(found).toBeUndefined();
  });

  it('worklist item → NOT in SARIF results', () => {
    const doc = parseSarif(makePopulatedOutput());
    const runs = doc['runs'] as Array<Record<string, unknown>>;
    const results = runs[0]?.['results'] as Array<Record<string, unknown>>;
    const worklist = results.find((r) =>
      (r['ruleId'] as string)?.startsWith('bibcheck/worklist/')
    );
    expect(worklist).toBeUndefined();
  });

  it('unresolved linkage → SARIF result with ruleId bibcheck/linkage/unresolved', () => {
    const doc = parseSarif(makePopulatedOutput());
    const runs = doc['runs'] as Array<Record<string, unknown>>;
    const results = runs[0]?.['results'] as Array<Record<string, unknown>>;
    const found = results.find((r) => r['ruleId'] === 'bibcheck/linkage/unresolved');
    expect(found).toBeDefined();
    expect(found?.['level']).toBe('error');
  });

  it('existence metadata-mismatch → SARIF result with correct ruleId', () => {
    const doc = parseSarif(makePopulatedOutput());
    const runs = doc['runs'] as Array<Record<string, unknown>>;
    const results = runs[0]?.['results'] as Array<Record<string, unknown>>;
    const found = results.find((r) => r['ruleId'] === 'bibcheck/existence/metadata-mismatch');
    expect(found).toBeDefined();
    expect(found?.['level']).toBe('error');
  });

  it('results have partialFingerprints.bibcheckV1 field', () => {
    const doc = parseSarif(makePopulatedOutput());
    const runs = doc['runs'] as Array<Record<string, unknown>>;
    const results = runs[0]?.['results'] as Array<Record<string, unknown>>;
    for (const result of results) {
      const fp = result['partialFingerprints'] as Record<string, unknown> | undefined;
      expect(fp).toBeDefined();
      expect(typeof fp?.['bibcheckV1']).toBe('string');
      expect((fp?.['bibcheckV1'] as string).length).toBe(16);
    }
  });

  it('partialFingerprints are deterministic across two renders', () => {
    const output = makePopulatedOutput();
    const doc1 = parseSarif(output);
    const doc2 = parseSarif(output);
    const results1 = (doc1['runs'] as Array<Record<string, unknown>>)[0]?.['results'] as Array<Record<string, unknown>>;
    const results2 = (doc2['runs'] as Array<Record<string, unknown>>)[0]?.['results'] as Array<Record<string, unknown>>;
    expect(results1.length).toBe(results2.length);
    for (let i = 0; i < results1.length; i++) {
      const fp1 = (results1[i]?.['partialFingerprints'] as Record<string, unknown>)?.['bibcheckV1'];
      const fp2 = (results2[i]?.['partialFingerprints'] as Record<string, unknown>)?.['bibcheckV1'];
      expect(fp1).toBe(fp2);
    }
  });

  it('is deterministic — two renders of the same input are byte-identical', () => {
    const output = makePopulatedOutput();
    expect(renderSarif(output)).toBe(renderSarif(output));
  });

  it('phrase flag message text is plain text (contains matchedText)', () => {
    const doc = parseSarif(makePopulatedOutput());
    const runs = doc['runs'] as Array<Record<string, unknown>>;
    const results = runs[0]?.['results'] as Array<Record<string, unknown>>;
    const found = results.find((r) => r['ruleId'] === 'bibcheck/phrase/deprecated-term');
    const messageText = (found?.['message'] as Record<string, unknown>)?.['text'] as string;
    expect(messageText).toContain('deprecated phrase');
  });

  it('phrase flag physical location points to the correct file and line', () => {
    const doc = parseSarif(makePopulatedOutput());
    const runs = doc['runs'] as Array<Record<string, unknown>>;
    const results = runs[0]?.['results'] as Array<Record<string, unknown>>;
    const found = results.find((r) => r['ruleId'] === 'bibcheck/phrase/deprecated-term');
    const locations = found?.['locations'] as Array<Record<string, unknown>> | undefined;
    const physLoc = locations?.[0]?.['physicalLocation'] as Record<string, unknown> | undefined;
    const artifactLoc = physLoc?.['artifactLocation'] as Record<string, unknown> | undefined;
    expect(artifactLoc?.['uri']).toBe('docs/chapter1.md');
    const region = physLoc?.['region'] as Record<string, unknown> | undefined;
    expect(region?.['startLine']).toBe(15);
  });

  it('linkage unresolved physical location has uriBaseId PROJECTROOT', () => {
    const doc = parseSarif(makePopulatedOutput());
    const runs = doc['runs'] as Array<Record<string, unknown>>;
    const results = runs[0]?.['results'] as Array<Record<string, unknown>>;
    const found = results.find((r) => r['ruleId'] === 'bibcheck/linkage/unresolved');
    const locations = found?.['locations'] as Array<Record<string, unknown>> | undefined;
    const physLoc = locations?.[0]?.['physicalLocation'] as Record<string, unknown> | undefined;
    const artifactLoc = physLoc?.['artifactLocation'] as Record<string, unknown> | undefined;
    expect(artifactLoc?.['uriBaseId']).toBe('PROJECTROOT');
  });

  it('bibliography-level findings use sources.json as artifact URI', () => {
    const doc = parseSarif(makePopulatedOutput());
    const runs = doc['runs'] as Array<Record<string, unknown>>;
    const results = runs[0]?.['results'] as Array<Record<string, unknown>>;
    const found = results.find((r) => r['ruleId'] === 'bibcheck/existence/metadata-mismatch');
    const locations = found?.['locations'] as Array<Record<string, unknown>> | undefined;
    const physLoc = locations?.[0]?.['physicalLocation'] as Record<string, unknown> | undefined;
    const artifactLoc = physLoc?.['artifactLocation'] as Record<string, unknown> | undefined;
    expect(artifactLoc?.['uri']).toBe('sources.json');
  });

  it('static rules include all canonical and linkage rule IDs', () => {
    const doc = parseSarif(makePopulatedOutput());
    const runs = doc['runs'] as Array<Record<string, unknown>>;
    const driver = (runs[0]?.['tool'] as Record<string, unknown>)?.['driver'] as Record<string, unknown>;
    const rules = driver?.['rules'] as Array<Record<string, unknown>>;
    const ruleIds = rules.map((r) => r['id'] as string);
    expect(ruleIds).toContain('bibcheck/canonical/dead-url');
    expect(ruleIds).toContain('bibcheck/canonical/wrong-host');
    expect(ruleIds).toContain('bibcheck/linkage/unresolved');
    expect(ruleIds).toContain('bibcheck/existence/metadata-mismatch');
    // Dynamic rule from phrase flag.
    expect(ruleIds).toContain('bibcheck/phrase/deprecated-term');
  });
});

// ---------------------------------------------------------------------------
// 0.2.0 gating findings across all renderers (not-found-in-databases +
// malformed/bad-checksum identifiers). These exercise the renderer branches
// added in T22.
// ---------------------------------------------------------------------------

describe('renderers — 0.2.0 gating findings', () => {
  it('text: not-found-in-databases is an error finding', () => {
    const text = renderText(makeGatingOutput());
    const line = text.split('\n').find((l) => l.includes('not-found-in-databases'));
    expect(line).toBeDefined();
    expect(line).toContain(': error:');
    expect(line).toContain('@fabricated2099');
  });

  it('text: malformed/bad-checksum identifiers are error findings naming each problem', () => {
    const text = renderText(makeGatingOutput());
    const doiLine = text.split('\n').find((l) => l.includes('@baddoi'));
    expect(doiLine).toBeDefined();
    expect(doiLine).toContain(': error:');
    expect(doiLine).toContain('doi malformed');
    expect(doiLine).toContain('isbn bad-checksum');
    expect(doiLine).toContain('url malformed');
    const shapeLine = text.split('\n').find((l) => l.includes('@badisbnshape'));
    expect(shapeLine).toContain('isbn malformed');
  });

  it('markdown: summary table reports the new counters and the evidence column', () => {
    const md = renderMarkdown(makeGatingOutput());
    expect(md).toContain('| Not found in databases | 1 |');
    expect(md).toContain('| Malformed identifiers | 3 |');
    expect(md).toContain('| Citekey | Existence status | Evidence | Canonical status | Canonical URL |');
    expect(md).toContain('absent');
  });

  it('sarif: emits not-found-in-databases and malformed-identifier results (error level)', () => {
    const doc = JSON.parse(renderSarif(makeGatingOutput())) as Record<string, unknown>;
    const runs = doc['runs'] as Array<Record<string, unknown>>;
    const results = runs[0]?.['results'] as Array<Record<string, unknown>>;
    const notFound = results.find((r) => r['ruleId'] === 'bibcheck/existence/not-found-in-databases');
    expect(notFound).toBeDefined();
    expect(notFound?.['level']).toBe('error');
    const malformed = results.filter((r) => r['ruleId'] === 'bibcheck/identifiers/malformed');
    expect(malformed.length).toBe(2);
    expect(malformed[0]?.['level']).toBe('error');
    // The corresponding rules are registered on the driver.
    const driver = (runs[0]?.['tool'] as Record<string, unknown>)?.['driver'] as Record<string, unknown>;
    const ruleIds = (driver?.['rules'] as Array<Record<string, unknown>>).map((r) => r['id']);
    expect(ruleIds).toContain('bibcheck/existence/not-found-in-databases');
    expect(ruleIds).toContain('bibcheck/identifiers/malformed');
  });

  it('json: round-trips the gating output', () => {
    const original = makeGatingOutput();
    const parsed = OutputSchema.parse(JSON.parse(renderJson(original)));
    expect(parsed).toEqual(original);
  });
});

// ---------------------------------------------------------------------------
// 0.3.0 reverse-linkage (orphan) findings across all renderers. Orphans are
// informational and must not crash any renderer.
// ---------------------------------------------------------------------------

describe('renderers — 0.3.0 orphan (reverse linkage) findings', () => {
  it('json: round-trips an output with an orphan linkage entry', () => {
    const original = makeOrphanOutput();
    const parsed = OutputSchema.parse(JSON.parse(renderJson(original)));
    expect(parsed).toEqual(original);
    expect(parsed.linkage.find((l) => l.citekey === 'uncited1999')?.status).toBe('orphan');
  });

  it('text: orphan is an informational note, not an error', () => {
    const text = renderText(makeOrphanOutput());
    const line = text.split('\n').find((l) => l.includes('uncited1999'));
    expect(line).toBeDefined();
    expect(line).toContain(': note:');
    expect(line).toContain('orphaned bibliography entry @uncited1999');
    // The orphan must not inflate the error count.
    const summaryLine = text.trim().split('\n').pop() ?? '';
    const errCount = parseInt(summaryLine.split(',')[0] ?? '0', 10);
    // Only the unresolved linkage is an error.
    expect(errCount).toBe(1);
  });

  it('markdown: summary row and an Orphaned entries listing', () => {
    const md = renderMarkdown(makeOrphanOutput());
    expect(md).toContain('| Orphaned entries (informational) | 1 |');
    expect(md).toContain('## Orphaned entries (informational)');
    const orphanSection = md.split('## Orphaned entries (informational)')[1]?.split('##')[0] ?? '';
    expect(orphanSection).toContain('@uncited1999');
    // The resolved/unresolved keys do not appear in the orphan listing.
    expect(orphanSection).not.toContain('@cited2000');
  });

  it('markdown: empty output shows "No findings." in the Orphaned entries section', () => {
    const md = renderMarkdown(makeEmptyOutput());
    const orphanSection = md.split('## Orphaned entries (informational)')[1]?.split('##')[0] ?? '';
    expect(orphanSection).toContain('No findings.');
  });

  it('sarif: orphan is a note-level result under bibcheck/linkage/orphan', () => {
    const doc = JSON.parse(renderSarif(makeOrphanOutput())) as Record<string, unknown>;
    const runs = doc['runs'] as Array<Record<string, unknown>>;
    const results = runs[0]?.['results'] as Array<Record<string, unknown>>;
    const orphan = results.find((r) => r['ruleId'] === 'bibcheck/linkage/orphan');
    expect(orphan).toBeDefined();
    expect(orphan?.['level']).toBe('note');
    // The rule is registered on the driver.
    const driver = (runs[0]?.['tool'] as Record<string, unknown>)?.['driver'] as Record<string, unknown>;
    const ruleIds = (driver?.['rules'] as Array<Record<string, unknown>>).map((r) => r['id']);
    expect(ruleIds).toContain('bibcheck/linkage/orphan');
  });

  it('is deterministic across renderers', () => {
    const o = makeOrphanOutput();
    expect(renderMarkdown(o)).toBe(renderMarkdown(o));
    expect(renderText(o)).toBe(renderText(o));
    expect(renderSarif(o)).toBe(renderSarif(o));
  });
});
