/**
 * Tests for src/linkage.ts — runLinkage function.
 *
 * Uses vitest with vi.mock to stub discoverDocs so no real filesystem is
 * needed. readFile is injected via deps. Bibliography arrays are built inline.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Config } from '../src/config.js';
import type { CslEntry } from '../src/schema/csl.js';
import type { RunLinkageDeps } from '../src/linkage.js';

// ---------------------------------------------------------------------------
// Mock discoverDocs so tests are pure unit tests with no real filesystem I/O.
// ---------------------------------------------------------------------------

vi.mock('../src/markdown/glob.js', () => ({
  discoverDocs: vi.fn(),
}));

import { discoverDocs } from '../src/markdown/glob.js';
import { runLinkage } from '../src/linkage.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockDiscoverDocs = vi.mocked(discoverDocs);

/** Minimal Config with the docs section filled in. */
function makeConfig(include: string[] = ['docs/**/*.md'], exclude: string[] = []): Config {
  return {
    bibliography: { file: 'docs/sources.json' },
    docs: { include, exclude },
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
    },
    cache: { dir: '.bibcheck-cache', max_size_mb: 256 },
  };
}

/** Build a minimal CslEntry with only the fields runLinkage uses (citekey). */
function makeEntry(citekey: string): CslEntry {
  return {
    id: citekey,
    citekey,
    doi: undefined,
    isbn: undefined,
    url: undefined,
  } as unknown as CslEntry;
}

/** A never-aborted AbortSignal. */
function liveSignal(): AbortSignal {
  return new AbortController().signal;
}

/** An already-aborted AbortSignal. */
function abortedSignal(): AbortSignal {
  const ctrl = new AbortController();
  ctrl.abort();
  return ctrl.signal;
}

/** Build a readFile mock that maps absolute paths to content strings. */
function makeReadFile(files: Record<string, string>): (path: string) => Promise<string> {
  return async (path: string) => {
    const content = files[path];
    if (content === undefined) {
      throw new Error(`readFile: unexpected path ${path}`);
    }
    return content;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

describe('runLinkage', () => {

  // 1. Single doc with @kant1781kru AND bibliography contains kant1781kru →
  //    one resolved LinkageEntry.
  it('resolves a citekey present in the bibliography', async () => {
    mockDiscoverDocs.mockResolvedValue([
      { path: '/cwd/docs/chapter.md', relativePath: 'docs/chapter.md' },
    ]);

    const deps: RunLinkageDeps = {
      config: makeConfig(),
      cwd: '/cwd',
      bibliography: [makeEntry('kant1781kru')],
      readFile: makeReadFile({
        '/cwd/docs/chapter.md': 'As argued in @kant1781kru, the categories apply.\n',
      }),
      signal: liveSignal(),
    };

    const { linkage } = await runLinkage(deps);

    expect(linkage).toHaveLength(1);
    expect(linkage[0]).toMatchObject({
      citekey: 'kant1781kru',
      status: 'resolved',
      references: [{ file: 'docs/chapter.md', line: 1 }],
    });
  });

  it('propagates locator and authorSuppressed onto references (T25)', async () => {
    mockDiscoverDocs.mockResolvedValue([
      { path: '/cwd/docs/c.md', relativePath: 'docs/c.md' },
    ]);
    const deps: RunLinkageDeps = {
      config: makeConfig(),
      cwd: '/cwd',
      bibliography: [makeEntry('mill1859'), makeEntry('kant1781')],
      readFile: makeReadFile({
        '/cwd/docs/c.md': 'See [@mill1859, p. 42] and [-@kant1781].\n',
      }),
      signal: liveSignal(),
    };
    const { linkage } = await runLinkage(deps);
    const mill = linkage.find((l) => l.citekey === 'mill1859');
    const kant = linkage.find((l) => l.citekey === 'kant1781');
    expect(mill?.references[0]).toMatchObject({ file: 'docs/c.md', line: 1, locator: 'p. 42' });
    expect(kant?.references[0]).toMatchObject({ authorSuppressed: true });
  });

  // 2. Single doc with @unknownkey AND bibliography is empty → one unresolved
  //    LinkageEntry.
  it('marks a citekey unresolved when bibliography is empty', async () => {
    mockDiscoverDocs.mockResolvedValue([
      { path: '/cwd/docs/chapter.md', relativePath: 'docs/chapter.md' },
    ]);

    const deps: RunLinkageDeps = {
      config: makeConfig(),
      cwd: '/cwd',
      bibliography: [],
      readFile: makeReadFile({
        '/cwd/docs/chapter.md': 'See @unknownkey for more.\n',
      }),
      signal: liveSignal(),
    };

    const { linkage } = await runLinkage(deps);

    expect(linkage).toHaveLength(1);
    expect(linkage[0]).toMatchObject({
      citekey: 'unknownkey',
      status: 'unresolved',
      references: [{ file: 'docs/chapter.md', line: 1 }],
    });
  });

  // 3. Multiple docs referencing same citekey → one LinkageEntry with multiple
  //    LinkageReference entries.
  it('aggregates references across multiple docs for the same citekey', async () => {
    mockDiscoverDocs.mockResolvedValue([
      { path: '/cwd/docs/a.md', relativePath: 'docs/a.md' },
      { path: '/cwd/docs/b.md', relativePath: 'docs/b.md' },
    ]);

    const deps: RunLinkageDeps = {
      config: makeConfig(),
      cwd: '/cwd',
      bibliography: [makeEntry('mill1859')],
      readFile: makeReadFile({
        '/cwd/docs/a.md': 'See @mill1859 on liberty.\n',
        '/cwd/docs/b.md': '@mill1859 is also cited here.\n',
      }),
      signal: liveSignal(),
    };

    const { linkage } = await runLinkage(deps);

    expect(linkage).toHaveLength(1);
    const entry = linkage[0];
    expect(entry?.citekey).toBe('mill1859');
    expect(entry?.status).toBe('resolved');
    expect(entry?.references).toHaveLength(2);
    const files = entry?.references.map((r) => r.file).sort();
    expect(files).toEqual(['docs/a.md', 'docs/b.md']);
  });

  // 4. Same citekey on multiple lines in one doc → multiple LinkageReference
  //    entries.
  it('captures multiple references for the same citekey on different lines', async () => {
    mockDiscoverDocs.mockResolvedValue([
      { path: '/cwd/docs/essay.md', relativePath: 'docs/essay.md' },
    ]);

    const content = [
      'First mention of @habermas1962.',
      'Second mention of @habermas1962.',
      'Third: @habermas1962 is central.',
    ].join('\n');

    const deps: RunLinkageDeps = {
      config: makeConfig(),
      cwd: '/cwd',
      bibliography: [makeEntry('habermas1962')],
      readFile: makeReadFile({ '/cwd/docs/essay.md': content }),
      signal: liveSignal(),
    };

    const { linkage } = await runLinkage(deps);

    expect(linkage).toHaveLength(1);
    const entry = linkage[0];
    expect(entry?.references).toHaveLength(3);
    const lines = entry?.references.map((r) => r.line).sort((a, b) => a - b);
    expect(lines).toEqual([1, 2, 3]);
  });

  // 5. Citekey inside fenced code block → NOT counted (T03's extractCitekeys
  //    handles this).
  it('does not count citekeys inside fenced code blocks', async () => {
    mockDiscoverDocs.mockResolvedValue([
      { path: '/cwd/docs/example.md', relativePath: 'docs/example.md' },
    ]);

    const content = [
      'Prose reference to @realkey here.',
      '```',
      'In code block: @codekey is ignored.',
      '```',
    ].join('\n');

    const deps: RunLinkageDeps = {
      config: makeConfig(),
      cwd: '/cwd',
      bibliography: [makeEntry('realkey'), makeEntry('codekey')],
      readFile: makeReadFile({ '/cwd/docs/example.md': content }),
      signal: liveSignal(),
    };

    const { linkage } = await runLinkage(deps);

    const citekeys = linkage.map((e) => e.citekey);
    expect(citekeys).toContain('realkey');
    expect(citekeys).not.toContain('codekey');
  });

  // 6. No citekey references in any doc → empty linkage.
  it('returns empty linkage when no citekeys appear in any doc', async () => {
    mockDiscoverDocs.mockResolvedValue([
      { path: '/cwd/docs/plain.md', relativePath: 'docs/plain.md' },
    ]);

    const deps: RunLinkageDeps = {
      config: makeConfig(),
      cwd: '/cwd',
      bibliography: [makeEntry('mill1859')],
      readFile: makeReadFile({
        '/cwd/docs/plain.md': 'This document has no citation references.\n',
      }),
      signal: liveSignal(),
    };

    const { linkage } = await runLinkage(deps);

    expect(linkage).toHaveLength(0);
  });

  // 6b. No docs discovered → empty linkage.
  it('returns empty linkage when no docs are discovered', async () => {
    mockDiscoverDocs.mockResolvedValue([]);

    const deps: RunLinkageDeps = {
      config: makeConfig(),
      cwd: '/cwd',
      bibliography: [makeEntry('mill1859')],
      readFile: async () => { throw new Error('should not be called'); },
      signal: liveSignal(),
    };

    const { linkage } = await runLinkage(deps);

    expect(linkage).toHaveLength(0);
  });

  // 7. AbortSignal aborted → throws.
  it('throws when the AbortSignal is already aborted', async () => {
    mockDiscoverDocs.mockResolvedValue([
      { path: '/cwd/docs/a.md', relativePath: 'docs/a.md' },
    ]);

    const deps: RunLinkageDeps = {
      config: makeConfig(),
      cwd: '/cwd',
      bibliography: [],
      readFile: async () => 'content with @somekey',
      signal: abortedSignal(),
    };

    await expect(runLinkage(deps)).rejects.toThrow();
  });

  // 8. Bibliography with citekey that's NOT referenced → does NOT appear in
  //    linkage.
  it('does not emit bibliography entries that have no doc references', async () => {
    mockDiscoverDocs.mockResolvedValue([
      { path: '/cwd/docs/chapter.md', relativePath: 'docs/chapter.md' },
    ]);

    const deps: RunLinkageDeps = {
      config: makeConfig(),
      cwd: '/cwd',
      bibliography: [makeEntry('referenced'), makeEntry('unreferenced')],
      readFile: makeReadFile({
        '/cwd/docs/chapter.md': 'See @referenced for details.\n',
      }),
      signal: liveSignal(),
    };

    const { linkage } = await runLinkage(deps);

    const citekeys = linkage.map((e) => e.citekey);
    expect(citekeys).toContain('referenced');
    expect(citekeys).not.toContain('unreferenced');
  });

  // 9. Multiple distinct citekeys → multiple LinkageEntry entries, sorted
  //    alphabetically.
  it('returns multiple entries sorted alphabetically by citekey', async () => {
    mockDiscoverDocs.mockResolvedValue([
      { path: '/cwd/docs/intro.md', relativePath: 'docs/intro.md' },
    ]);

    const content = '@zebra and @apple and @middle are cited here.';

    const deps: RunLinkageDeps = {
      config: makeConfig(),
      cwd: '/cwd',
      bibliography: [makeEntry('apple'), makeEntry('middle')],
      readFile: makeReadFile({ '/cwd/docs/intro.md': content }),
      signal: liveSignal(),
    };

    const { linkage } = await runLinkage(deps);

    expect(linkage).toHaveLength(3);
    const citekeys = linkage.map((e) => e.citekey);
    expect(citekeys).toEqual(['apple', 'middle', 'zebra']);
    // apple and middle are resolved; zebra is unresolved
    expect(linkage[0]?.status).toBe('resolved');   // apple
    expect(linkage[1]?.status).toBe('resolved');   // middle
    expect(linkage[2]?.status).toBe('unresolved'); // zebra
  });

  // Extra: mixed resolved/unresolved in same doc.
  it('correctly mixes resolved and unresolved entries', async () => {
    mockDiscoverDocs.mockResolvedValue([
      { path: '/cwd/docs/mixed.md', relativePath: 'docs/mixed.md' },
    ]);

    const content = 'Citing @inbib and @notinbib in this sentence.';

    const deps: RunLinkageDeps = {
      config: makeConfig(),
      cwd: '/cwd',
      bibliography: [makeEntry('inbib')],
      readFile: makeReadFile({ '/cwd/docs/mixed.md': content }),
      signal: liveSignal(),
    };

    const { linkage } = await runLinkage(deps);

    expect(linkage).toHaveLength(2);
    const resolved = linkage.find((e) => e.citekey === 'inbib');
    const unresolved = linkage.find((e) => e.citekey === 'notinbib');
    expect(resolved?.status).toBe('resolved');
    expect(unresolved?.status).toBe('unresolved');
  });

  // Extra: same citekey appears twice on the same line → two references.
  it('keeps duplicate references when same citekey appears twice on one line', async () => {
    mockDiscoverDocs.mockResolvedValue([
      { path: '/cwd/docs/dup.md', relativePath: 'docs/dup.md' },
    ]);

    // Two occurrences of @alpha on the same line
    const content = 'See @alpha and also @alpha again on one line.';

    const deps: RunLinkageDeps = {
      config: makeConfig(),
      cwd: '/cwd',
      bibliography: [makeEntry('alpha')],
      readFile: makeReadFile({ '/cwd/docs/dup.md': content }),
      signal: liveSignal(),
    };

    const { linkage } = await runLinkage(deps);

    expect(linkage).toHaveLength(1);
    const entry = linkage[0];
    expect(entry?.references).toHaveLength(2);
    expect(entry?.references[0]?.line).toBe(1);
    expect(entry?.references[1]?.line).toBe(1);
  });

  // Extra: passes correct cwd, include, exclude to discoverDocs.
  it('passes config.docs.include and exclude to discoverDocs', async () => {
    mockDiscoverDocs.mockResolvedValue([]);

    const config = makeConfig(['custom/**/*.md'], ['**/draft/**']);
    const deps: RunLinkageDeps = {
      config,
      cwd: '/myproject',
      bibliography: [],
      readFile: async () => '',
      signal: liveSignal(),
    };

    await runLinkage(deps);

    expect(mockDiscoverDocs).toHaveBeenCalledOnce();
    expect(mockDiscoverDocs).toHaveBeenCalledWith({
      cwd: '/myproject',
      include: ['custom/**/*.md'],
      exclude: ['**/draft/**'],
    });
  });
});
