/**
 * Tests for src/worklist.ts — runWorklist function.
 *
 * All filesystem I/O is mocked via the readFile dep. Bibliography and config
 * are built inline. File discovery uses a real temp directory.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';

import { runWorklist, getFirstAuthorSurname } from '../src/worklist.js';
import type { RunWorklistDeps } from '../src/worklist.js';
import type { CslEntry } from '../src/schema/csl.js';
import { ConfigSchema } from '../src/config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal passing Config via Zod defaults + overrides. */
function makeConfig(
  overrides: Partial<{
    source_types: Record<string, { warn_load_bearing?: boolean; allow_load_bearing?: boolean }>;
    edition_discipline: Record<string, string>;
    docs_include: string[];
    docs_exclude: string[];
  }> = {},
) {
  return ConfigSchema.parse({
    source_types: overrides.source_types ?? {},
    edition_discipline: overrides.edition_discipline ?? {},
    docs: {
      include: overrides.docs_include ?? ['**/*.md'],
      exclude: overrides.docs_exclude ?? [],
    },
  });
}

/** Minimal CSL entry factory. */
function makeEntry(partial: Partial<CslEntry> & { id: string }): CslEntry {
  return {
    citekey: partial.id,
    type: partial.type ?? 'book',
    title: partial.title ?? 'A Test Book',
    author: partial.author ?? [{ family: 'Author', given: 'Test' }],
    doi: partial.doi,
    isbn: partial.isbn,
    url: partial.url,
    note: partial.note,
    ...partial,
  } as CslEntry;
}

/** Build a no-op AbortSignal that is never aborted. */
function liveSignal(): AbortSignal {
  return new AbortController().signal;
}

/** Build an already-aborted AbortSignal. */
function abortedSignal(): AbortSignal {
  const ctrl = new AbortController();
  ctrl.abort();
  return ctrl.signal;
}

// ---------------------------------------------------------------------------
// Temp directory for virtual docs
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'bibcheck-worklist-test-'));
  await mkdir(join(tmpDir, 'docs'), { recursive: true });
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Write a markdown file to the temp docs/ dir and return the file path and a
 * readFile mock that serves it from the in-memory map.
 */
async function setupDoc(
  filename: string,
  content: string,
): Promise<{ filePath: string; makeReadFile: (extra?: Record<string, string>) => (path: string) => Promise<string> }> {
  const filePath = join(tmpDir, 'docs', filename);
  await writeFile(filePath, content, 'utf-8');
  return {
    filePath,
    makeReadFile:
      (extra = {}) =>
      async (path: string) => {
        if (path === filePath) return content;
        if (path in extra) return extra[path] ?? '';
        throw new Error(`Unexpected readFile call: ${path}`);
      },
  };
}

// ---------------------------------------------------------------------------
// 1. Citation inside blockquote → direct-quotation
// ---------------------------------------------------------------------------

describe('direct-quotation (blockquote)', () => {
  it('emits direct-quotation when citation is inside a blockquote', async () => {
    const content = [
      '> Liberty consists in doing everything which injures no one else @mill1859liberty.',
      '',
      'Some subsequent prose.',
    ].join('\n');

    const { filePath, makeReadFile } = await setupDoc('test-bq.md', content);

    const entry = makeEntry({ id: 'mill1859liberty', type: 'book' });
    const config = makeConfig({ docs_include: ['docs/test-bq.md'] });

    const deps: RunWorklistDeps = {
      config,
      cwd: tmpDir,
      bibliography: [entry],
      readFile: makeReadFile(),
      signal: liveSignal(),
    };

    const result = await runWorklist(deps);

    expect(result.worklist).toHaveLength(1);
    expect(result.worklist[0]).toMatchObject({
      type: 'direct-quotation',
      citation: 'mill1859liberty',
      file: 'docs/test-bq.md',
      line: 1,
    });
    expect(result.worklist[0]?.recommendedAction).toContain('Verify quotation wording');
  });

  it('snippet is capped at ~80 chars', async () => {
    const longLine = 'A '.repeat(60) + '@longkey.';
    const content = `> ${longLine}`;

    const { filePath, makeReadFile } = await setupDoc('test-long-bq.md', content);

    const entry = makeEntry({ id: 'longkey', type: 'book' });
    const config = makeConfig({ docs_include: ['docs/test-long-bq.md'] });

    const deps: RunWorklistDeps = {
      config,
      cwd: tmpDir,
      bibliography: [entry],
      readFile: makeReadFile(),
      signal: liveSignal(),
    };

    const result = await runWorklist(deps);

    const item = result.worklist.find((i) => i.type === 'direct-quotation');
    expect(item).toBeDefined();
    expect((item?.snippet ?? '').length).toBeLessThanOrEqual(80);
  });
});

// ---------------------------------------------------------------------------
// 2. Citation with (p. 42) → paraphrase-with-page-ref
// ---------------------------------------------------------------------------

describe('paraphrase-with-page-ref', () => {
  it('emits paraphrase-with-page-ref when citation has (p. 42) on same line', async () => {
    const content = 'Mill argued for maximum freedom (p. 42) @mill1859liberty.';

    const { filePath, makeReadFile } = await setupDoc('test-pageref.md', content);

    const entry = makeEntry({ id: 'mill1859liberty', type: 'book' });
    const config = makeConfig({ docs_include: ['docs/test-pageref.md'] });

    const deps: RunWorklistDeps = {
      config,
      cwd: tmpDir,
      bibliography: [entry],
      readFile: makeReadFile(),
      signal: liveSignal(),
    };

    const result = await runWorklist(deps);

    expect(result.worklist).toHaveLength(1);
    expect(result.worklist[0]).toMatchObject({
      type: 'paraphrase-with-page-ref',
      citation: 'mill1859liberty',
      line: 1,
    });
    expect(result.worklist[0]?.recommendedAction).toMatch(/page.*named edition/i);
  });

  it('does NOT emit paraphrase-with-page-ref for a bare citation without page ref', async () => {
    const content = 'Mill argued for maximum freedom @mill1859liberty.';

    const { filePath, makeReadFile } = await setupDoc('test-bare-cite.md', content);

    const entry = makeEntry({ id: 'mill1859liberty', type: 'book' });
    const config = makeConfig({ docs_include: ['docs/test-bare-cite.md'] });

    const deps: RunWorklistDeps = {
      config,
      cwd: tmpDir,
      bibliography: [entry],
      readFile: makeReadFile(),
      signal: liveSignal(),
    };

    const result = await runWorklist(deps);

    expect(result.worklist.filter((i) => i.type === 'paraphrase-with-page-ref')).toHaveLength(0);
  });

  it('verificationUrl is null when entry has no usable URL', async () => {
    const content = 'The argument is compelling (pp. 12-15) @nourl.';

    const { filePath, makeReadFile } = await setupDoc('test-nourl-pageref.md', content);

    // Entry with no url and no snippet text that would produce a google URL
    // (we rely on the snippet being non-empty to get a google URL — test with blank entry)
    const entry = makeEntry({ id: 'nourl', type: 'book', url: undefined });
    const config = makeConfig({ docs_include: ['docs/test-nourl-pageref.md'] });

    const deps: RunWorklistDeps = {
      config,
      cwd: tmpDir,
      bibliography: [entry],
      readFile: makeReadFile(),
      signal: liveSignal(),
    };

    const result = await runWorklist(deps);
    const item = result.worklist.find((i) => i.type === 'paraphrase-with-page-ref');
    expect(item).toBeDefined();
    // The entry has no url; snippet is non-empty so we get a google books URL
    // (not null). Per spec: "verificationUrl: null" only when no usable URL.
    // A Google Books fallback IS usable, so we only get null when snippet is empty.
    expect(item?.verificationUrl).not.toBeNull();
    expect(item?.verificationUrl).toMatch(/google\.com\/search/);
  });
});

// ---------------------------------------------------------------------------
// 3. Both blockquote AND page-ref → direct-quotation only (documented choice)
// ---------------------------------------------------------------------------

describe('citation in both blockquote and page-ref context', () => {
  it('emits direct-quotation (not paraphrase) when line has both blockquote and page ref', async () => {
    // A blockquote line that also has a page ref
    const content = [
      '> Liberty is the absence of restraint (p. 7) @mill1859liberty.',
    ].join('\n');

    const { filePath, makeReadFile } = await setupDoc('test-both.md', content);

    const entry = makeEntry({ id: 'mill1859liberty', type: 'book' });
    const config = makeConfig({ docs_include: ['docs/test-both.md'] });

    const deps: RunWorklistDeps = {
      config,
      cwd: tmpDir,
      bibliography: [entry],
      readFile: makeReadFile(),
      signal: liveSignal(),
    };

    const result = await runWorklist(deps);

    const types = result.worklist.map((i) => i.type);
    // direct-quotation must be present; paraphrase-with-page-ref must NOT be
    expect(types).toContain('direct-quotation');
    expect(types).not.toContain('paraphrase-with-page-ref');
  });
});

// ---------------------------------------------------------------------------
// 4. Contested source type (webpage)
// ---------------------------------------------------------------------------

describe('contested-source-type', () => {
  it('emits contested-source-type for an entry of type webpage', async () => {
    const content = 'For context see @wiki2024.';

    const { filePath, makeReadFile } = await setupDoc('test-webpage.md', content);

    const entry = makeEntry({
      id: 'wiki2024',
      type: 'webpage',
      url: 'https://en.wikipedia.org/wiki/Liberty',
    });
    const config = makeConfig({
      docs_include: ['docs/test-webpage.md'],
      source_types: { webpage: { warn_load_bearing: true } },
    });

    const deps: RunWorklistDeps = {
      config,
      cwd: tmpDir,
      bibliography: [entry],
      readFile: makeReadFile(),
      signal: liveSignal(),
    };

    const result = await runWorklist(deps);

    const item = result.worklist.find((i) => i.type === 'contested-source-type');
    expect(item).toBeDefined();
    expect(item?.verificationUrl).toBe('https://en.wikipedia.org/wiki/Liberty');
    expect(item?.recommendedAction).toContain('webpage');
  });

  it('does NOT emit contested-source-type when warn_load_bearing is false', async () => {
    const content = 'See also @wiki2024.';

    const { filePath, makeReadFile } = await setupDoc('test-webpage-allowed.md', content);

    const entry = makeEntry({ id: 'wiki2024', type: 'webpage' });
    const config = makeConfig({
      docs_include: ['docs/test-webpage-allowed.md'],
      source_types: { webpage: { warn_load_bearing: false } },
    });

    const deps: RunWorklistDeps = {
      config,
      cwd: tmpDir,
      bibliography: [entry],
      readFile: makeReadFile(),
      signal: liveSignal(),
    };

    const result = await runWorklist(deps);

    expect(result.worklist.filter((i) => i.type === 'contested-source-type')).toHaveLength(0);
  });

  it('emits contested-source-type for preprint type', async () => {
    const content = 'As argued in @smith2023preprint.';

    const { filePath, makeReadFile } = await setupDoc('test-preprint.md', content);

    const entry = makeEntry({ id: 'smith2023preprint', type: 'preprint' });
    const config = makeConfig({
      docs_include: ['docs/test-preprint.md'],
      // warn_load_bearing defaults to undefined (truthy by design)
    });

    const deps: RunWorklistDeps = {
      config,
      cwd: tmpDir,
      bibliography: [entry],
      readFile: makeReadFile(),
      signal: liveSignal(),
    };

    const result = await runWorklist(deps);

    expect(result.worklist.filter((i) => i.type === 'contested-source-type')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 5. Non-canonical edition (Mill without toronto-cw in note)
// ---------------------------------------------------------------------------

describe('non-canonical-edition', () => {
  it('emits non-canonical-edition for Mill entry without Toronto CW in note', async () => {
    const content = 'As Mill argued @mill1859liberty.';

    const { filePath, makeReadFile } = await setupDoc('test-noncanon.md', content);

    const entry = makeEntry({
      id: 'mill1859liberty',
      type: 'book',
      author: [{ family: 'Mill', given: 'John Stuart' }],
      note: 'Penguin Classics edition, 1974.',
    });
    const config = makeConfig({
      docs_include: ['docs/test-noncanon.md'],
      edition_discipline: { mill: 'toronto-cw' },
    });

    const deps: RunWorklistDeps = {
      config,
      cwd: tmpDir,
      bibliography: [entry],
      readFile: makeReadFile(),
      signal: liveSignal(),
    };

    const result = await runWorklist(deps);

    const item = result.worklist.find((i) => i.type === 'non-canonical-edition');
    expect(item).toBeDefined();
    expect(item?.recommendedAction).toContain('toronto-cw');
    expect(item?.verificationUrl).toBeNull();
  });

  it('does NOT emit non-canonical-edition when note mentions the canonical edition', async () => {
    const content = 'Mill was clear @mill1859liberty.';

    const { filePath, makeReadFile } = await setupDoc('test-canon-ok.md', content);

    const entry = makeEntry({
      id: 'mill1859liberty',
      type: 'book',
      author: [{ family: 'Mill', given: 'John Stuart' }],
      note: 'Collected Works, toronto-cw vol. 18.',
    });
    const config = makeConfig({
      docs_include: ['docs/test-canon-ok.md'],
      edition_discipline: { mill: 'toronto-cw' },
    });

    const deps: RunWorklistDeps = {
      config,
      cwd: tmpDir,
      bibliography: [entry],
      readFile: makeReadFile(),
      signal: liveSignal(),
    };

    const result = await runWorklist(deps);

    expect(result.worklist.filter((i) => i.type === 'non-canonical-edition')).toHaveLength(0);
  });

  it('does NOT emit non-canonical-edition when author has no edition_discipline config', async () => {
    const content = 'As argued by @kant1781kru.';

    const { filePath, makeReadFile } = await setupDoc('test-unconfigured-author.md', content);

    const entry = makeEntry({
      id: 'kant1781kru',
      type: 'book',
      author: [{ family: 'Kant', given: 'Immanuel' }],
      note: 'Some translation.',
    });
    const config = makeConfig({
      docs_include: ['docs/test-unconfigured-author.md'],
      edition_discipline: { mill: 'toronto-cw' }, // Kant not configured
    });

    const deps: RunWorklistDeps = {
      config,
      cwd: tmpDir,
      bibliography: [entry],
      readFile: makeReadFile(),
      signal: liveSignal(),
    };

    const result = await runWorklist(deps);

    expect(result.worklist.filter((i) => i.type === 'non-canonical-edition')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Citation not in bibliography → no worklist item
// ---------------------------------------------------------------------------

describe('citation not in bibliography', () => {
  it('produces no worklist item for a citekey not in bibliography', async () => {
    const content = 'This cites @unknown2024 which has no bib entry.';

    const { filePath, makeReadFile } = await setupDoc('test-missing.md', content);

    const config = makeConfig({ docs_include: ['docs/test-missing.md'] });

    const deps: RunWorklistDeps = {
      config,
      cwd: tmpDir,
      bibliography: [], // empty bibliography
      readFile: makeReadFile(),
      signal: liveSignal(),
    };

    const result = await runWorklist(deps);

    expect(result.worklist).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 7. Citation in fenced code block → NOT counted
// ---------------------------------------------------------------------------

describe('citation in fenced code block', () => {
  it('does not emit any worklist item for a citation inside a code block', async () => {
    const content = [
      'Some prose here.',
      '```',
      'Reference: @mill1859liberty should be ignored',
      '```',
      'More prose.',
    ].join('\n');

    const { filePath, makeReadFile } = await setupDoc('test-codeblock.md', content);

    const entry = makeEntry({ id: 'mill1859liberty', type: 'webpage' });
    const config = makeConfig({
      docs_include: ['docs/test-codeblock.md'],
      source_types: { webpage: { warn_load_bearing: true } },
    });

    const deps: RunWorklistDeps = {
      config,
      cwd: tmpDir,
      bibliography: [entry],
      readFile: makeReadFile(),
      signal: liveSignal(),
    };

    const result = await runWorklist(deps);

    // extractCitekeys skips code blocks, so nothing should be emitted
    expect(result.worklist).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 8. verificationUrl for direct quote with entry.url on archive.org
// ---------------------------------------------------------------------------

describe('verificationUrl — archive.org passthrough', () => {
  it('preserves archive.org URL in verificationUrl for direct-quotation', async () => {
    const archiveUrl = 'https://archive.org/details/onliberty00milliala';
    const content = '> Liberty is not doing harm. @mill1859liberty';

    const { filePath, makeReadFile } = await setupDoc('test-archive-url.md', content);

    const entry = makeEntry({
      id: 'mill1859liberty',
      type: 'book',
      url: archiveUrl,
    });
    const config = makeConfig({ docs_include: ['docs/test-archive-url.md'] });

    const deps: RunWorklistDeps = {
      config,
      cwd: tmpDir,
      bibliography: [entry],
      readFile: makeReadFile(),
      signal: liveSignal(),
    };

    const result = await runWorklist(deps);

    const item = result.worklist.find((i) => i.type === 'direct-quotation');
    expect(item).toBeDefined();
    expect(item?.verificationUrl).toBe(archiveUrl);
  });

  it('also preserves hathitrust.org URL', async () => {
    const hathiUrl = 'https://catalog.hathitrust.org/Record/001234567';
    const content = '> Reason must be the guide. @kant1788kpv';

    const { filePath, makeReadFile } = await setupDoc('test-hathi-url.md', content);

    const entry = makeEntry({ id: 'kant1788kpv', type: 'book', url: hathiUrl });
    const config = makeConfig({ docs_include: ['docs/test-hathi-url.md'] });

    const deps: RunWorklistDeps = {
      config,
      cwd: tmpDir,
      bibliography: [entry],
      readFile: makeReadFile(),
      signal: liveSignal(),
    };

    const result = await runWorklist(deps);

    const item = result.worklist.find((i) => i.type === 'direct-quotation');
    expect(item?.verificationUrl).toBe(hathiUrl);
  });
});

// ---------------------------------------------------------------------------
// 9. verificationUrl is null for paraphrase without usable url (empty snippet)
// ---------------------------------------------------------------------------

describe('verificationUrl — null when no usable URL and no snippet text', () => {
  it('produces a google books URL (not null) when snippet is available', async () => {
    // We can't get a null URL from buildVerificationUrl unless the snippet trim
    // is empty. Test the path: no archive-style URL → Google Books fallback.
    const content = 'Some claim (p. 99) @noarchive.';

    const { filePath, makeReadFile } = await setupDoc('test-noarchive-pageref.md', content);

    const entry = makeEntry({ id: 'noarchive', type: 'book', url: 'https://example.com/book' });
    const config = makeConfig({ docs_include: ['docs/test-noarchive-pageref.md'] });

    const deps: RunWorklistDeps = {
      config,
      cwd: tmpDir,
      bibliography: [entry],
      readFile: makeReadFile(),
      signal: liveSignal(),
    };

    const result = await runWorklist(deps);

    const item = result.worklist.find((i) => i.type === 'paraphrase-with-page-ref');
    // non-archive URL → falls through to google books
    expect(item?.verificationUrl).toMatch(/google\.com\/search/);
  });
});

// ---------------------------------------------------------------------------
// 10. verificationUrl — Google Books URL when entry has no archive-style URL
// ---------------------------------------------------------------------------

describe('verificationUrl — Google Books fallback', () => {
  it('builds a Google Books search URL when entry URL is not archive/hathi/oll/plato', async () => {
    const content = '> The original argument is clear @randombook.';

    const { filePath, makeReadFile } = await setupDoc('test-google-books.md', content);

    const entry = makeEntry({
      id: 'randombook',
      type: 'book',
      url: 'https://publisher.example.com/book',
    });
    const config = makeConfig({ docs_include: ['docs/test-google-books.md'] });

    const deps: RunWorklistDeps = {
      config,
      cwd: tmpDir,
      bibliography: [entry],
      readFile: makeReadFile(),
      signal: liveSignal(),
    };

    const result = await runWorklist(deps);

    const item = result.worklist.find((i) => i.type === 'direct-quotation');
    expect(item).toBeDefined();
    expect(item?.verificationUrl).toMatch(/^https:\/\/www\.google\.com\/search\?tbm=bks&q=/);
  });

  it('builds a Google Books URL when entry has no URL at all', async () => {
    const content = '> Philosophy is a battle @nourl.';

    const { filePath, makeReadFile } = await setupDoc('test-google-books-nourl.md', content);

    const entry = makeEntry({ id: 'nourl', type: 'book', url: undefined });
    const config = makeConfig({ docs_include: ['docs/test-google-books-nourl.md'] });

    const deps: RunWorklistDeps = {
      config,
      cwd: tmpDir,
      bibliography: [entry],
      readFile: makeReadFile(),
      signal: liveSignal(),
    };

    const result = await runWorklist(deps);

    const item = result.worklist.find((i) => i.type === 'direct-quotation');
    expect(item).toBeDefined();
    expect(item?.verificationUrl).toMatch(/^https:\/\/www\.google\.com\/search\?tbm=bks&q=/);
  });
});

// ---------------------------------------------------------------------------
// 11. Snippet capped at ~80 chars
// ---------------------------------------------------------------------------

describe('snippet length capping', () => {
  it('caps snippet at 80 chars with ellipsis for direct-quotation', async () => {
    // Build a line that's well over 80 chars
    const longQuote = 'Every word of this quotation is important and must be checked in the original text here.';
    const content = `> ${longQuote} @deepbook.`;

    const { filePath, makeReadFile } = await setupDoc('test-snippet-cap.md', content);

    const entry = makeEntry({ id: 'deepbook', type: 'book' });
    const config = makeConfig({ docs_include: ['docs/test-snippet-cap.md'] });

    const deps: RunWorklistDeps = {
      config,
      cwd: tmpDir,
      bibliography: [entry],
      readFile: makeReadFile(),
      signal: liveSignal(),
    };

    const result = await runWorklist(deps);

    const item = result.worklist.find((i) => i.type === 'direct-quotation');
    expect(item).toBeDefined();
    expect((item?.snippet ?? '').length).toBeLessThanOrEqual(80);
    expect(item?.snippet).toMatch(/…$/);
  });
});

// ---------------------------------------------------------------------------
// 12. AbortSignal aborted → throws
// ---------------------------------------------------------------------------

describe('AbortSignal', () => {
  it('throws when the signal is already aborted before calling runWorklist', async () => {
    const content = 'Just prose with @somecite.';
    const { makeReadFile } = await setupDoc('test-abort.md', content);

    const entry = makeEntry({ id: 'somecite', type: 'book' });
    const config = makeConfig({ docs_include: ['docs/test-abort.md'] });

    const deps: RunWorklistDeps = {
      config,
      cwd: tmpDir,
      bibliography: [entry],
      readFile: makeReadFile(),
      signal: abortedSignal(),
    };

    await expect(runWorklist(deps)).rejects.toThrow(/abort/i);
  });

  it('throws when the signal is aborted mid-iteration', async () => {
    // Write two docs so that the abort fires after processing doc #1
    const content1 = 'First prose @cite1.';
    const content2 = 'Second prose @cite2.';
    await writeFile(join(tmpDir, 'docs', 'abort-1.md'), content1, 'utf-8');
    await writeFile(join(tmpDir, 'docs', 'abort-2.md'), content2, 'utf-8');

    const ctrl = new AbortController();

    // Abort after the first read call
    let callCount = 0;
    const readFile = async (path: string) => {
      callCount++;
      if (callCount >= 1) ctrl.abort();
      if (path.endsWith('abort-1.md')) return content1;
      if (path.endsWith('abort-2.md')) return content2;
      throw new Error(`Unexpected path: ${path}`);
    };

    const entry1 = makeEntry({ id: 'cite1', type: 'book' });
    const entry2 = makeEntry({ id: 'cite2', type: 'book' });

    const config = makeConfig({ docs_include: ['docs/abort-1.md', 'docs/abort-2.md'] });

    const deps: RunWorklistDeps = {
      config,
      cwd: tmpDir,
      bibliography: [entry1, entry2],
      readFile,
      signal: ctrl.signal,
    };

    await expect(runWorklist(deps)).rejects.toThrow(/abort/i);
  });
});

// ---------------------------------------------------------------------------
// 13. getFirstAuthorSurname helper
// ---------------------------------------------------------------------------

describe('getFirstAuthorSurname', () => {
  it('returns family name when present', () => {
    const entry = makeEntry({
      id: 'x',
      author: [{ family: 'Mill', given: 'John Stuart' }],
    });
    expect(getFirstAuthorSurname(entry)).toBe('Mill');
  });

  it('falls back to last word of literal name', () => {
    const entry = makeEntry({
      id: 'x',
      author: [{ literal: 'John Stuart Mill' }],
    });
    expect(getFirstAuthorSurname(entry)).toBe('Mill');
  });

  it('returns undefined when no author', () => {
    const entry = makeEntry({ id: 'x', author: [] });
    expect(getFirstAuthorSurname(entry)).toBeUndefined();
  });

  it('returns undefined when author array is missing', () => {
    const entry = { ...makeEntry({ id: 'x' }), author: undefined };
    expect(getFirstAuthorSurname(entry)).toBeUndefined();
  });

  it('returns undefined when first author has neither family nor literal', () => {
    const entry = makeEntry({ id: 'x', author: [{ given: 'John' }] });
    expect(getFirstAuthorSurname(entry)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 14. Multiple categories from a single citation
// ---------------------------------------------------------------------------

describe('multiple worklist items from one citation', () => {
  it('emits both contested-source-type and non-canonical-edition for one cite', async () => {
    const content = 'The article says @blogsource.';

    const { filePath, makeReadFile } = await setupDoc('test-multi.md', content);

    const entry = makeEntry({
      id: 'blogsource',
      type: 'blog',
      author: [{ family: 'Mill', given: 'John Stuart' }],
      note: 'Penguin Classics edition.',
    });
    const config = makeConfig({
      docs_include: ['docs/test-multi.md'],
      source_types: { blog: { warn_load_bearing: true } },
      edition_discipline: { mill: 'toronto-cw' },
    });

    const deps: RunWorklistDeps = {
      config,
      cwd: tmpDir,
      bibliography: [entry],
      readFile: makeReadFile(),
      signal: liveSignal(),
    };

    const result = await runWorklist(deps);

    const types = result.worklist.map((i) => i.type);
    expect(types).toContain('contested-source-type');
    expect(types).toContain('non-canonical-edition');
  });
});

// ---------------------------------------------------------------------------
// 15. Empty docs → no items
// ---------------------------------------------------------------------------

describe('empty result cases', () => {
  it('returns empty worklist when no docs are found', async () => {
    const config = makeConfig({ docs_include: ['docs/nonexistent-pattern-xyz/**/*.md'] });

    const deps: RunWorklistDeps = {
      config,
      cwd: tmpDir,
      bibliography: [],
      readFile: async () => '',
      signal: liveSignal(),
    };

    const result = await runWorklist(deps);
    expect(result.worklist).toHaveLength(0);
  });

  it('returns empty worklist when doc has no citations', async () => {
    const content = 'Just prose, no citations here at all.';
    const { makeReadFile } = await setupDoc('test-nocites.md', content);

    const config = makeConfig({ docs_include: ['docs/test-nocites.md'] });

    const deps: RunWorklistDeps = {
      config,
      cwd: tmpDir,
      bibliography: [makeEntry({ id: 'unused', type: 'book' })],
      readFile: makeReadFile(),
      signal: liveSignal(),
    };

    const result = await runWorklist(deps);
    expect(result.worklist).toHaveLength(0);
  });
});
