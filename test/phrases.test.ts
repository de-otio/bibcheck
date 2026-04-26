/**
 * Tests for src/phrases.ts — `bibcheck phrases` subcommand.
 *
 * CompiledPattern objects are constructed directly using RE2JS.compile so
 * tests do not depend on the filesystem for pattern loading.
 *
 * The `readFile` and `discoverDocs` dependencies are mocked via vitest's
 * module mocking and inline factory functions respectively.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RE2JS } from 're2js';
import { runPhrases } from '../src/phrases.js';
import type { RunPhrasesDeps } from '../src/phrases.js';
import type { CompiledPattern } from '../src/phrases/load.js';
import type { Config } from '../src/config.js';

// ---------------------------------------------------------------------------
// Mock discoverDocs so tests don't need real files on disk.
// ---------------------------------------------------------------------------

vi.mock('../src/markdown/glob.js', () => ({
  discoverDocs: vi.fn(),
}));

import { discoverDocs } from '../src/markdown/glob.js';
const mockDiscoverDocs = vi.mocked(discoverDocs);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal Config with the given include/exclude patterns. */
function makeConfig(
  include: string[] = ['docs/**/*.md'],
  exclude: string[] = [],
): Config {
  return {
    bibliography: { file: 'docs/sources.json' },
    docs: { include, exclude },
    trusted_hosts: { hosts: [] },
    phrases: { file: null },
    source_types: {},
    edition_discipline: {},
    apis: { crossref_mailto: null, openalex_mailto: null, worldcat_key_env: null },
    cache: { dir: '.bibcheck-cache', max_size_mb: 256 },
  };
}

/** Build a CompiledPattern from a plain string regex. */
function makePattern(
  key: string,
  regex: string,
  flags = 0,
  referenceUrl: string | null = null,
): CompiledPattern {
  return {
    key,
    regex,
    flags: '',
    compiled: RE2JS.compile(regex, flags),
    referenceUrl,
    description: undefined,
  };
}

/** Build a minimal AbortSignal that is not yet aborted. */
function liveSignal(): AbortSignal {
  return new AbortController().signal;
}

/** Build a deps object with sensible defaults. */
function makeDeps(overrides: Partial<RunPhrasesDeps> = {}): RunPhrasesDeps {
  return {
    config: makeConfig(),
    cwd: '/project',
    patterns: [],
    readFile: vi.fn().mockResolvedValue(''),
    signal: liveSignal(),
    ...overrides,
  };
}

/** Configure mockDiscoverDocs to return a set of virtual docs. */
function setupDocs(docs: Array<{ path: string; relativePath: string }>): void {
  mockDiscoverDocs.mockResolvedValue(docs);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

describe('runPhrases', () => {
  // 1. Empty patterns array → returns empty result without any I/O.
  it('returns empty phraseFlags and performs no I/O when patterns is empty', async () => {
    const readFile = vi.fn();
    const deps = makeDeps({ patterns: [], readFile });
    const result = await runPhrases(deps);
    expect(result.phraseFlags).toEqual([]);
    // discoverDocs and readFile must NOT be called.
    expect(mockDiscoverDocs).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });

  // 2. Single pattern, single match in prose → one 'flagged' result.
  it('returns one flagged PhraseFlag when a single pattern matches prose', async () => {
    const pattern = makePattern('bad-phrase', 'badphrase', RE2JS.CASE_INSENSITIVE);
    setupDocs([{ path: '/project/docs/file.md', relativePath: 'docs/file.md' }]);

    const content = 'This line contains badphrase text.';
    const readFile = vi.fn().mockResolvedValue(content);

    const result = await runPhrases(makeDeps({ patterns: [pattern], readFile }));

    expect(result.phraseFlags).toHaveLength(1);
    const flag = result.phraseFlags[0];
    expect(flag?.status).toBe('flagged');
    expect(flag?.patternKey).toBe('bad-phrase');
    expect(flag?.file).toBe('docs/file.md');
    expect(flag?.line).toBe(1);
    expect(flag?.matchedText).toBe('badphrase');
    expect(flag?.referenceUrl).toBeNull();
  });

  // 3. Match inside a fenced code block → NOT flagged.
  it('does not flag matches inside fenced code blocks', async () => {
    const pattern = makePattern('bad-phrase', 'badphrase');
    setupDocs([{ path: '/project/docs/file.md', relativePath: 'docs/file.md' }]);

    const content = [
      'Normal prose here.',
      '',
      '```',
      'badphrase is inside a code block',
      '```',
      '',
      'More prose without the term.',
    ].join('\n');

    const readFile = vi.fn().mockResolvedValue(content);
    const result = await runPhrases(makeDeps({ patterns: [pattern], readFile }));

    // The code block line must NOT produce a flag.
    expect(result.phraseFlags).toHaveLength(0);
  });

  // 4. Match inside HTML comment → NOT flagged (extractProseLines excludes html nodes).
  it('does not flag matches inside HTML comments', async () => {
    const pattern = makePattern('bad-phrase', 'badphrase');
    setupDocs([{ path: '/project/docs/file.md', relativePath: 'docs/file.md' }]);

    // An HTML comment is excluded by extractProseLines (html node type).
    const content = '<!-- badphrase is inside a comment -->\nClean prose.';
    const readFile = vi.fn().mockResolvedValue(content);
    const result = await runPhrases(makeDeps({ patterns: [pattern], readFile }));
    expect(result.phraseFlags).toHaveLength(0);
  });

  // 5. Multiple matches on one line → multiple flags.
  it('emits one flag per match when a line has multiple occurrences', async () => {
    const pattern = makePattern('bad-phrase', 'bad');
    setupDocs([{ path: '/project/docs/file.md', relativePath: 'docs/file.md' }]);

    const content = 'bad things and more bad things on the same line';
    const readFile = vi.fn().mockResolvedValue(content);
    const result = await runPhrases(makeDeps({ patterns: [pattern], readFile }));

    expect(result.phraseFlags).toHaveLength(2);
    expect(result.phraseFlags.every((f) => f.patternKey === 'bad-phrase')).toBe(true);
    expect(result.phraseFlags.every((f) => f.matchedText === 'bad')).toBe(true);
  });

  // 6. Two different patterns matching the same line → two flags, distinct patternKey.
  it('emits one flag per pattern when two patterns match the same line', async () => {
    const patternA = makePattern('term-a', 'alpha');
    const patternB = makePattern('term-b', 'beta');
    setupDocs([{ path: '/project/docs/file.md', relativePath: 'docs/file.md' }]);

    const content = 'The words alpha and beta appear together.';
    const readFile = vi.fn().mockResolvedValue(content);
    const result = await runPhrases(makeDeps({ patterns: [patternA, patternB], readFile }));

    expect(result.phraseFlags).toHaveLength(2);
    const keys = result.phraseFlags.map((f) => f.patternKey).sort();
    expect(keys).toEqual(['term-a', 'term-b']);
  });

  // 7. bibcheck-allow on the same line → status 'acknowledged'.
  it('sets status to acknowledged when allow comment is on the same line', async () => {
    const pattern = makePattern('bad-phrase', 'badphrase');
    setupDocs([{ path: '/project/docs/file.md', relativePath: 'docs/file.md' }]);

    const content = 'Use badphrase here. <!-- bibcheck-allow: bad-phrase -->';
    const readFile = vi.fn().mockResolvedValue(content);
    const result = await runPhrases(makeDeps({ patterns: [pattern], readFile }));

    expect(result.phraseFlags).toHaveLength(1);
    expect(result.phraseFlags[0]?.status).toBe('acknowledged');
  });

  // 8. bibcheck-allow on the preceding line → status 'acknowledged'.
  it('sets status to acknowledged when allow comment is on the preceding line', async () => {
    const pattern = makePattern('bad-phrase', 'badphrase');
    setupDocs([{ path: '/project/docs/file.md', relativePath: 'docs/file.md' }]);

    const content = [
      '<!-- bibcheck-allow: bad-phrase -->',
      'badphrase appears on this line.',
    ].join('\n');

    const readFile = vi.fn().mockResolvedValue(content);
    const result = await runPhrases(makeDeps({ patterns: [pattern], readFile }));

    expect(result.phraseFlags).toHaveLength(1);
    expect(result.phraseFlags[0]?.status).toBe('acknowledged');
  });

  // 9. bibcheck-allow key mismatch → status 'flagged'.
  it('leaves status as flagged when allow comment key does not match pattern key', async () => {
    const pattern = makePattern('bad-phrase', 'badphrase');
    setupDocs([{ path: '/project/docs/file.md', relativePath: 'docs/file.md' }]);

    const content = 'Use badphrase here. <!-- bibcheck-allow: some-other-key -->';
    const readFile = vi.fn().mockResolvedValue(content);
    const result = await runPhrases(makeDeps({ patterns: [pattern], readFile }));

    expect(result.phraseFlags).toHaveLength(1);
    expect(result.phraseFlags[0]?.status).toBe('flagged');
  });

  // 10. Pattern not matching any line → no flag.
  it('emits no flags when the pattern does not match any prose', async () => {
    const pattern = makePattern('not-present', 'neverappears');
    setupDocs([{ path: '/project/docs/file.md', relativePath: 'docs/file.md' }]);

    const content = 'This document does not contain the forbidden term.';
    const readFile = vi.fn().mockResolvedValue(content);
    const result = await runPhrases(makeDeps({ patterns: [pattern], readFile }));
    expect(result.phraseFlags).toHaveLength(0);
  });

  // 11. Empty docs list → returns empty.
  it('returns empty phraseFlags when no docs are discovered', async () => {
    const pattern = makePattern('bad-phrase', 'badphrase');
    setupDocs([]);

    const readFile = vi.fn();
    const result = await runPhrases(makeDeps({ patterns: [pattern], readFile }));

    expect(result.phraseFlags).toHaveLength(0);
    expect(readFile).not.toHaveBeenCalled();
  });

  // 12. AbortSignal already aborted → throws before any work.
  it('throws signal.reason immediately when signal is already aborted', async () => {
    const pattern = makePattern('bad-phrase', 'badphrase');
    const controller = new AbortController();
    const reason = new Error('aborted early');
    controller.abort(reason);

    const readFile = vi.fn();

    await expect(
      runPhrases(makeDeps({ patterns: [pattern], readFile, signal: controller.signal })),
    ).rejects.toThrow(reason);

    // No I/O should have happened.
    expect(mockDiscoverDocs).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });

  // 13. Multiple files → results aggregated, file paths reflect each.
  it('aggregates results across multiple files with correct file paths', async () => {
    const pattern = makePattern('bad-phrase', 'badphrase');
    setupDocs([
      { path: '/project/docs/a.md', relativePath: 'docs/a.md' },
      { path: '/project/docs/b.md', relativePath: 'docs/b.md' },
    ]);

    const readFile = vi.fn().mockImplementation(async (path: string) => {
      if (path === '/project/docs/a.md') return 'This has badphrase in it.';
      if (path === '/project/docs/b.md') return 'This also has badphrase.';
      return '';
    });

    const result = await runPhrases(makeDeps({ patterns: [pattern], readFile }));

    expect(result.phraseFlags).toHaveLength(2);
    const files = result.phraseFlags.map((f) => f.file).sort();
    expect(files).toEqual(['docs/a.md', 'docs/b.md']);
  });

  // Additional: empty file → no flags.
  it('returns no flags for an empty file', async () => {
    const pattern = makePattern('bad-phrase', 'badphrase');
    setupDocs([{ path: '/project/docs/empty.md', relativePath: 'docs/empty.md' }]);

    const readFile = vi.fn().mockResolvedValue('');
    const result = await runPhrases(makeDeps({ patterns: [pattern], readFile }));
    expect(result.phraseFlags).toHaveLength(0);
  });

  // Additional: file with only code blocks → no flags.
  it('returns no flags for a file that consists entirely of code blocks', async () => {
    const pattern = makePattern('bad-phrase', 'badphrase');
    setupDocs([{ path: '/project/docs/code.md', relativePath: 'docs/code.md' }]);

    const content = ['```', 'badphrase', '```'].join('\n');
    const readFile = vi.fn().mockResolvedValue(content);
    const result = await runPhrases(makeDeps({ patterns: [pattern], readFile }));
    expect(result.phraseFlags).toHaveLength(0);
  });

  // Additional: match at line 1 (edge: no preceding line).
  it('handles a match on line 1 without crashing (no preceding line)', async () => {
    const pattern = makePattern('bad-phrase', 'badphrase');
    setupDocs([{ path: '/project/docs/file.md', relativePath: 'docs/file.md' }]);

    const content = 'badphrase is on the very first line.';
    const readFile = vi.fn().mockResolvedValue(content);
    const result = await runPhrases(makeDeps({ patterns: [pattern], readFile }));

    expect(result.phraseFlags).toHaveLength(1);
    expect(result.phraseFlags[0]?.line).toBe(1);
    expect(result.phraseFlags[0]?.status).toBe('flagged');
  });

  // Additional: referenceUrl is preserved.
  it('includes the referenceUrl from the pattern in each flag', async () => {
    const pattern = makePattern(
      'has-ref',
      'badphrase',
      0,
      'https://example.org/style#bad-phrase',
    );
    setupDocs([{ path: '/project/docs/file.md', relativePath: 'docs/file.md' }]);

    const content = 'Use badphrase in this document.';
    const readFile = vi.fn().mockResolvedValue(content);
    const result = await runPhrases(makeDeps({ patterns: [pattern], readFile }));

    expect(result.phraseFlags).toHaveLength(1);
    expect(result.phraseFlags[0]?.referenceUrl).toBe('https://example.org/style#bad-phrase');
  });

  // Additional: abort between documents (signal becomes aborted mid-run).
  it('throws when the signal is aborted between documents', async () => {
    const pattern = makePattern('bad-phrase', 'badphrase');
    const controller = new AbortController();
    const reason = new Error('mid-run abort');

    setupDocs([
      { path: '/project/docs/a.md', relativePath: 'docs/a.md' },
      { path: '/project/docs/b.md', relativePath: 'docs/b.md' },
    ]);

    let callCount = 0;
    const readFile = vi.fn().mockImplementation(async (path: string) => {
      callCount++;
      if (callCount === 1) {
        // After reading the first file, abort the signal.
        controller.abort(reason);
      }
      return path === '/project/docs/a.md' ? 'no match here' : 'no match here either';
    });

    await expect(
      runPhrases(
        makeDeps({ patterns: [pattern], readFile, signal: controller.signal }),
      ),
    ).rejects.toThrow(reason);
  });

  // Additional: bibcheck-allow comment is case-insensitive for the directive keyword.
  it('recognises bibcheck-allow regardless of case in the comment directive', async () => {
    const pattern = makePattern('bad-phrase', 'badphrase');
    setupDocs([{ path: '/project/docs/file.md', relativePath: 'docs/file.md' }]);

    const content = 'Use badphrase here. <!-- BIBCHECK-ALLOW: bad-phrase -->';
    const readFile = vi.fn().mockResolvedValue(content);
    const result = await runPhrases(makeDeps({ patterns: [pattern], readFile }));

    expect(result.phraseFlags).toHaveLength(1);
    expect(result.phraseFlags[0]?.status).toBe('acknowledged');
  });

  // Additional: preceding line is a non-prose (raw HTML) line that contains allow comment.
  it('acknowledges a match when the allow comment is on the raw preceding line even if not a prose line', async () => {
    const pattern = makePattern('bad-phrase', 'badphrase');
    setupDocs([{ path: '/project/docs/file.md', relativePath: 'docs/file.md' }]);

    // Line 1 is an HTML comment (excluded by extractProseLines).
    // Line 2 is the matching prose line.
    const content = [
      '<!-- bibcheck-allow: bad-phrase -->',
      'badphrase appears here.',
    ].join('\n');

    const readFile = vi.fn().mockResolvedValue(content);
    const result = await runPhrases(makeDeps({ patterns: [pattern], readFile }));

    expect(result.phraseFlags).toHaveLength(1);
    expect(result.phraseFlags[0]?.status).toBe('acknowledged');
  });

  // Additional: inline code spans on a line that also has prose — the raw
  // source line is returned by extractProseLines (the inlineCode AST node is
  // skipped, but the surrounding text nodes on the same line still cause the
  // raw line to be included). Matches inside backtick spans ARE therefore
  // visible in the raw text. A line that is ONLY an inline code span with
  // no surrounding prose produces no prose line and hence no flag.
  it('does not flag when a line consists solely of an inline code span', async () => {
    const pattern = makePattern('bad-phrase', 'badphrase');
    setupDocs([{ path: '/project/docs/file.md', relativePath: 'docs/file.md' }]);

    // A paragraph with ONLY an inline code span: no surrounding text nodes
    // cause extractProseLines to emit a prose line, so there is nothing to match.
    // Wrap in a list item to create an isolated inlineCode-only leaf context
    // — or just test that a dedicated code block (fenced) produces no flags,
    // which is already covered above.  Here we verify a doc with ONLY inline
    // code (no prose words at all) yields no flags.
    const content = '`badphrase`';
    const readFile = vi.fn().mockResolvedValue(content);
    const result = await runPhrases(makeDeps({ patterns: [pattern], readFile }));
    expect(result.phraseFlags).toHaveLength(0);
  });
});
