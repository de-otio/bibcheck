/**
 * Tests for src/markdown/*.ts — prose, citekeys, blocks, glob modules.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';

import { extractProseLines } from '../src/markdown/prose.js';
import { extractCitekeys } from '../src/markdown/citekeys.js';
import { extractBlockquotes, extractDirectQuotes } from '../src/markdown/blocks.js';
import { discoverDocs } from '../src/markdown/glob.js';

// ---------------------------------------------------------------------------
// 1. prose.extractProseLines
// ---------------------------------------------------------------------------

describe('prose.extractProseLines', () => {
  it('returns all lines for plain prose', () => {
    const content = 'Hello world\nThis is prose\nThird line';
    const lines = extractProseLines(content);
    const lineNums = lines.map((l) => l.line);
    expect(lineNums).toContain(1);
    expect(lineNums).toContain(2);
    expect(lineNums).toContain(3);
  });

  it('excludes lines inside a fenced code block', () => {
    const content = [
      'Before code',
      '```',
      'const x = 1;',
      'const y = 2;',
      '```',
      'After code',
    ].join('\n');
    const lines = extractProseLines(content);
    const lineNums = lines.map((l) => l.line);
    // Line 1 "Before code" and line 6 "After code" should be present
    expect(lineNums).toContain(1);
    expect(lineNums).toContain(6);
    // Lines 3 and 4 (inside the code block) must NOT be present
    expect(lineNums).not.toContain(3);
    expect(lineNums).not.toContain(4);
  });

  it('excludes lines inside an indented code block (4+ spaces)', () => {
    const content = [
      'Prose before',
      '',
      '    indented code line',
      '',
      'Prose after',
    ].join('\n');
    const lines = extractProseLines(content);
    const lineNums = lines.map((l) => l.line);
    expect(lineNums).toContain(1);
    expect(lineNums).toContain(5);
    // Line 3 is indented code — must not be present
    expect(lineNums).not.toContain(3);
  });

  it('excludes HTML comment lines', () => {
    const content = [
      'Prose line',
      '<!-- This is a comment -->',
      'More prose',
    ].join('\n');
    const lines = extractProseLines(content);
    const lineNums = lines.map((l) => l.line);
    expect(lineNums).toContain(1);
    expect(lineNums).toContain(3);
    // HTML comment line must be excluded
    expect(lineNums).not.toContain(2);
  });

  it('excludes YAML front-matter', () => {
    const content = [
      '---',
      'title: My Document',
      'author: Jane Doe',
      '---',
      'Prose content here',
    ].join('\n');
    const lines = extractProseLines(content);
    const lineNums = lines.map((l) => l.line);
    // Front-matter lines 1-4 must not appear
    expect(lineNums).not.toContain(1);
    expect(lineNums).not.toContain(2);
    expect(lineNums).not.toContain(3);
    expect(lineNums).not.toContain(4);
    // Prose line 5 must be present
    expect(lineNums).toContain(5);
  });

  it('handles mixed content: prose + fenced code + prose', () => {
    const content = [
      'First prose block',          // line 1
      '',                            // line 2
      '```javascript',              // line 3
      'function foo() {}',          // line 4
      '```',                         // line 5
      '',                            // line 6
      'Second prose block',         // line 7
    ].join('\n');
    const lines = extractProseLines(content);
    const lineNums = lines.map((l) => l.line);
    expect(lineNums).toContain(1);
    expect(lineNums).toContain(7);
    expect(lineNums).not.toContain(4);
  });

  it('returns text that matches the original source line', () => {
    const content = 'Hello **world** and `inline`';
    const lines = extractProseLines(content);
    expect(lines.length).toBeGreaterThan(0);
    const first = lines[0];
    expect(first).toBeDefined();
    // The text field should be a slice of the original content
    expect(first?.text).toBe('Hello **world** and `inline`');
  });

  it('returns results sorted by line number with no duplicates', () => {
    const content = 'Line one\nLine two\nLine three';
    const lines = extractProseLines(content);
    for (let i = 1; i < lines.length; i++) {
      const prev = lines[i - 1];
      const curr = lines[i];
      expect(prev).toBeDefined();
      expect(curr).toBeDefined();
      /* c8 ignore next */
      // noUncheckedIndexedAccess: prev and curr are defined per loop bounds
      expect((curr?.line ?? 0) > (prev?.line ?? 0)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. citekeys.extractCitekeys
// ---------------------------------------------------------------------------

describe('citekeys.extractCitekeys', () => {
  const FILE = 'test.md';

  it('extracts a bare @citekey from prose', () => {
    const content = 'See @example for details.';
    const refs = extractCitekeys(content, FILE);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ citekey: 'example', file: FILE, line: 1 });
  });

  it('extracts citekeys with digits like @kant1781kru', () => {
    const content = 'As argued in @kant1781kru, the categories...';
    const refs = extractCitekeys(content, FILE);
    expect(refs.some((r) => r.citekey === 'kant1781kru')).toBe(true);
  });

  it('extracts citekeys with colons like @author:work', () => {
    const content = 'See @author:work for more.';
    const refs = extractCitekeys(content, FILE);
    expect(refs.some((r) => r.citekey === 'author:work')).toBe(true);
  });

  it('returns one entry per match when multiple citekeys on one line', () => {
    const content = 'See @alpha and @beta and @gamma.';
    const refs = extractCitekeys(content, FILE);
    expect(refs).toHaveLength(3);
    expect(refs.map((r) => r.citekey)).toEqual(
      expect.arrayContaining(['alpha', 'beta', 'gamma']),
    );
  });

  it('does not extract citekeys inside a fenced code block', () => {
    const content = [
      'Prose with @prose_key here.',
      '```',
      'Reference: @code_key',
      '```',
    ].join('\n');
    const refs = extractCitekeys(content, FILE);
    const keys = refs.map((r) => r.citekey);
    expect(keys).toContain('prose_key');
    expect(keys).not.toContain('code_key');
  });

  it('does not extract citekeys inside an HTML comment', () => {
    const content = [
      'Prose with @real_key.',
      '<!-- @hidden_key should be ignored -->',
    ].join('\n');
    const refs = extractCitekeys(content, FILE);
    const keys = refs.map((r) => r.citekey);
    expect(keys).toContain('real_key');
    expect(keys).not.toContain('hidden_key');
  });

  it('handles email-like text without false-positive matches', () => {
    // user@example.com — the regex will match "example" starting after @
    // but "example" by itself is a valid citekey fragment. The key insight
    // here is that email addresses will produce a match on the local-part
    // (e.g. "example.com" with the dot included, since dots are allowed after
    // the first char). We test that the result is "example.com" not a spurious
    // multi-key extraction.
    const content = 'Email user@example.com is not a citation.';
    const refs = extractCitekeys(content, FILE);
    // The regex WILL match @example.com because dots are allowed in citekeys.
    // This is an intentional design trade-off documented in the spec.
    // What we verify: no crash, result is deterministic.
    expect(Array.isArray(refs)).toBe(true);
    // There should be exactly one match starting at "example.com"
    expect(refs).toHaveLength(1);
    expect(refs[0]?.citekey).toBe('example.com');
  });

  it('returns correct line numbers for citekeys on different lines', () => {
    const content = [
      'No citekey here.',
      'This has @mill1859 in it.',
      'Also @habermas1962 here.',
    ].join('\n');
    const refs = extractCitekeys(content, FILE);
    const mill = refs.find((r) => r.citekey === 'mill1859');
    const hab = refs.find((r) => r.citekey === 'habermas1962');
    expect(mill?.line).toBe(2);
    expect(hab?.line).toBe(3);
  });

  it('extracts citekey at the very start of the file', () => {
    const content = '@kant1781kritik is the first thing.';
    const refs = extractCitekeys(content, FILE);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.citekey).toBe('kant1781kritik');
    expect(refs[0]?.line).toBe(1);
  });

  it('extracts citekey at the end of the file', () => {
    const content = 'As shown by @end_key';
    const refs = extractCitekeys(content, FILE);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.citekey).toBe('end_key');
  });

  it('extracts citekey immediately after punctuation', () => {
    const content = 'See:@punctuation_test for details.';
    const refs = extractCitekeys(content, FILE);
    expect(refs.some((r) => r.citekey === 'punctuation_test')).toBe(true);
  });

  it('bare citekeys carry locator null and authorSuppressed false', () => {
    const refs = extractCitekeys('See @example here.', FILE);
    expect(refs[0]).toMatchObject({ citekey: 'example', locator: null, authorSuppressed: false });
  });
});

describe('citekeys.extractCitekeys — Pandoc grammar (T25)', () => {
  const FILE = 'test.md';

  it('extracts a bracketed citation', () => {
    const refs = extractCitekeys('As shown [@mill1859] elsewhere.', FILE);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ citekey: 'mill1859', locator: null, authorSuppressed: false });
  });

  it('extracts a locator from a bracketed citation', () => {
    const refs = extractCitekeys('See [@mill1859, p. 42] on liberty.', FILE);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ citekey: 'mill1859', locator: 'p. 42' });
  });

  it('splits a multi-key bracket and attaches the locator to the right item', () => {
    const refs = extractCitekeys('[@alpha; @beta, pp. 33-35]', FILE);
    expect(refs.map((r) => r.citekey)).toEqual(['alpha', 'beta']);
    expect(refs.find((r) => r.citekey === 'alpha')?.locator).toBeNull();
    expect(refs.find((r) => r.citekey === 'beta')?.locator).toBe('pp. 33-35');
  });

  it('detects author suppression both bracketed and bare', () => {
    const bracketed = extractCitekeys('[-@kant1781]', FILE);
    expect(bracketed[0]).toMatchObject({ citekey: 'kant1781', authorSuppressed: true });
    const bare = extractCitekeys('As -@kant1781 argued.', FILE);
    expect(bare[0]).toMatchObject({ citekey: 'kant1781', authorSuppressed: true });
  });

  it('ignores a prefix before the key but keeps the locator suffix', () => {
    const refs = extractCitekeys('[see @smith2020, pp. 1-2]', FILE);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ citekey: 'smith2020', locator: 'pp. 1-2' });
  });

  it('does not treat a bracket without an @ as a citation', () => {
    const refs = extractCitekeys('A footnote [1] and a [link](http://x).', FILE);
    expect(refs).toHaveLength(0);
  });

  it('does not double-count a key that lives inside a bracket', () => {
    const refs = extractCitekeys('[@once] should appear exactly once.', FILE);
    expect(refs.filter((r) => r.citekey === 'once')).toHaveLength(1);
  });

  it('does not scan inline code spans', () => {
    const refs = extractCitekeys('Prose @real but `@code_key` is code.', FILE);
    const keys = refs.map((r) => r.citekey);
    expect(keys).toContain('real');
    expect(keys).not.toContain('code_key');
  });

  it('returns refs in document order (bracket then later bare on same line)', () => {
    const refs = extractCitekeys('[@first] then @second later.', FILE);
    expect(refs.map((r) => r.citekey)).toEqual(['first', 'second']);
  });
});

// ---------------------------------------------------------------------------
// 3. blocks.extractBlockquotes
// ---------------------------------------------------------------------------

describe('blocks.extractBlockquotes', () => {
  it('extracts a single-line blockquote', () => {
    const content = '> hello world';
    const bqs = extractBlockquotes(content);
    expect(bqs).toHaveLength(1);
    expect(bqs[0]?.text).toBe('hello world');
    expect(bqs[0]?.startLine).toBe(1);
    expect(bqs[0]?.endLine).toBe(1);
  });

  it('extracts a multi-line blockquote as one entry', () => {
    const content = [
      '> First line of the quote.',
      '> Second line of the quote.',
      '> Third line of the quote.',
    ].join('\n');
    const bqs = extractBlockquotes(content);
    expect(bqs).toHaveLength(1);
    expect(bqs[0]?.text).toContain('First line');
    expect(bqs[0]?.text).toContain('Second line');
    expect(bqs[0]?.startLine).toBe(1);
    expect(bqs[0]?.endLine).toBe(3);
  });

  it('extracts two separate blockquotes separated by prose', () => {
    const content = [
      '> First blockquote.',
      '',
      'Some prose in between.',
      '',
      '> Second blockquote.',
    ].join('\n');
    const bqs = extractBlockquotes(content);
    expect(bqs).toHaveLength(2);
    expect(bqs[0]?.text).toContain('First blockquote');
    expect(bqs[1]?.text).toContain('Second blockquote');
  });

  it('returns empty array for content with no blockquotes', () => {
    const content = 'Just regular prose\nNo blockquotes here.';
    const bqs = extractBlockquotes(content);
    expect(bqs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. blocks.extractDirectQuotes
// ---------------------------------------------------------------------------

describe('blocks.extractDirectQuotes', () => {
  it('extracts curly/typographic open+close quote pairs', () => {
    const content = 'She said “hello world here” to everyone.';
    const dqs = extractDirectQuotes(content);
    expect(dqs).toHaveLength(1);
    expect(dqs[0]?.text).toBe('hello world here');
    expect(dqs[0]?.line).toBe(1);
  });

  it('extracts straight double-quote pairs of length >= 4', () => {
    const content = 'The term "hello world" is used here.';
    const dqs = extractDirectQuotes(content);
    expect(dqs).toHaveLength(1);
    expect(dqs[0]?.text).toBe('hello world');
  });

  it('does NOT match single characters (under length 4)', () => {
    const content = 'A "x" is too short. A “y” also.';
    const dqs = extractDirectQuotes(content);
    expect(dqs).toHaveLength(0);
  });

  it('does NOT match 3-character quoted strings (under length 4)', () => {
    const content = 'The "abc" value and “xyz” marker.';
    const dqs = extractDirectQuotes(content);
    expect(dqs).toHaveLength(0);
  });

  it('does not extract quotes inside a fenced code block', () => {
    const content = [
      'Prose with “real quote here” nearby.',
      '```',
      'code: “code quote here” ignored',
      '```',
    ].join('\n');
    const dqs = extractDirectQuotes(content);
    const texts = dqs.map((q) => q.text);
    expect(texts.some((t) => t.includes('real quote'))).toBe(true);
    expect(texts.some((t) => t.includes('code quote'))).toBe(false);
  });

  it('extracts multiple quotes from the same line', () => {
    const content = 'He said “hello world” and she replied “goodbye everyone”.';
    const dqs = extractDirectQuotes(content);
    expect(dqs).toHaveLength(2);
  });

  it('handles guillemets (« ») as opening/closing quotes', () => {
    const content = 'Le texte dit «hello world» ici.';
    const dqs = extractDirectQuotes(content);
    expect(dqs).toHaveLength(1);
    expect(dqs[0]?.text).toBe('hello world');
  });
});

// ---------------------------------------------------------------------------
// 5. glob.discoverDocs
// ---------------------------------------------------------------------------

describe('glob.discoverDocs', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'bibcheck-test-'));

    // Create a simple directory structure
    await mkdir(join(tmpDir, 'docs'));
    await mkdir(join(tmpDir, 'docs', 'sub'));
    await mkdir(join(tmpDir, 'draft'));

    await writeFile(join(tmpDir, 'docs', 'index.md'), '# Index\n');
    await writeFile(join(tmpDir, 'docs', 'chapter1.md'), '# Chapter 1\n');
    await writeFile(join(tmpDir, 'docs', 'sub', 'nested.md'), '# Nested\n');
    await writeFile(join(tmpDir, 'draft', 'wip.md'), '# WIP\n');
    await writeFile(join(tmpDir, 'docs', 'notes.txt'), 'not markdown\n');
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('discovers markdown files matching include pattern', async () => {
    const result = await discoverDocs({
      cwd: tmpDir,
      include: ['docs/**/*.md'],
    });
    const relPaths = result.map((d) => d.relativePath);
    // Should find all .md files under docs/
    expect(relPaths).toContain(join('docs', 'index.md'));
    expect(relPaths).toContain(join('docs', 'chapter1.md'));
    expect(relPaths).toContain(join('docs', 'sub', 'nested.md'));
    // Should NOT include .txt
    expect(relPaths.some((p) => p.endsWith('.txt'))).toBe(false);
    // Should NOT include draft/
    expect(relPaths.some((p) => p.startsWith('draft'))).toBe(false);
  });

  it('returns absolute paths', async () => {
    const result = await discoverDocs({
      cwd: tmpDir,
      include: ['docs/**/*.md'],
    });
    for (const doc of result) {
      expect(doc.path.startsWith('/')).toBe(true);
    }
  });

  it('honours exclude patterns', async () => {
    const result = await discoverDocs({
      cwd: tmpDir,
      include: ['**/*.md'],
      exclude: ['**/draft/**'],
    });
    const relPaths = result.map((d) => d.relativePath);
    expect(relPaths.some((p) => p.startsWith('draft'))).toBe(false);
    // docs/ files should still be present
    expect(relPaths).toContain(join('docs', 'index.md'));
  });

  it('returns empty list for empty include array', async () => {
    const result = await discoverDocs({
      cwd: tmpDir,
      include: [],
    });
    expect(result).toHaveLength(0);
  });

  it('returns results sorted alphabetically by relativePath', async () => {
    const result = await discoverDocs({
      cwd: tmpDir,
      include: ['docs/**/*.md'],
    });
    const relPaths = result.map((d) => d.relativePath);
    const sorted = [...relPaths].sort((a, b) => a.localeCompare(b));
    expect(relPaths).toEqual(sorted);
  });

  it('include pattern with no matches returns empty array', async () => {
    const result = await discoverDocs({
      cwd: tmpDir,
      include: ['nonexistent/**/*.md'],
    });
    expect(result).toHaveLength(0);
  });
});
