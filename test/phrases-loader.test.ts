/**
 * Tests for src/phrases/load.ts — phrase denylist loader.
 *
 * Each test writes real TOML files to an isolated temporary directory;
 * no filesystem mocking is required.
 *
 * Design choice: when the TOML file has no `patterns` key at all, the loader
 * returns [] (lenient / empty-default), since the feature is opt-in and an
 * absent patterns array is a valid empty denylist.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { loadDenylist, PhraseLoaderError } from '../src/phrases/load.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTempDir(): Promise<string> {
  const dir = join(tmpdir(), `bibcheck-phrases-test-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function writeToml(dir: string, content: string, filename = 'phrases.toml'): Promise<string> {
  const filePath = join(dir, filename);
  await writeFile(filePath, content, 'utf-8');
  return filePath;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(async () => {
  tempDir = await makeTempDir();
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('loadDenylist', () => {
  // 1. Happy path: valid TOML with multiple patterns
  it('returns CompiledPatterns for a valid TOML file with two patterns', async () => {
    await writeToml(
      tempDir,
      `
[[patterns]]
key = "term-a"
regex = "\\\\bterm-a\\\\b"
flags = "i"
reference_url = "https://example.org/style#term-a"
description = "Do not use term-a."

[[patterns]]
key = "term-b"
regex = "term-b"
`,
    );
    const patterns = await loadDenylist({ path: 'phrases.toml', cwd: tempDir });
    expect(patterns).toHaveLength(2);
    expect(patterns[0]?.key).toBe('term-a');
    expect(patterns[0]?.flags).toBe('i');
    expect(patterns[0]?.referenceUrl).toBe('https://example.org/style#term-a');
    expect(patterns[0]?.description).toBe('Do not use term-a.');
    expect(patterns[1]?.key).toBe('term-b');
    expect(patterns[1]?.referenceUrl).toBeNull();
  });

  // 2. Compiled regex matches correctly
  it('returns compiled patterns that can match text', async () => {
    await writeToml(
      tempDir,
      `
[[patterns]]
key = "cat-pattern"
regex = "cat"
flags = "i"
`,
    );
    const patterns = await loadDenylist({ path: 'phrases.toml', cwd: tempDir });
    expect(patterns).toHaveLength(1);
    const pat = patterns[0];
    expect(pat).toBeDefined();
    // RE2JS compiled pattern test
    expect(pat!.compiled.test('I have a Cat')).toBe(true);
    expect(pat!.compiled.test('no animals here')).toBe(false);
  });

  // 3. Empty patterns array returns empty array
  it('returns [] for patterns = []', async () => {
    await writeToml(tempDir, 'patterns = []\n');
    const patterns = await loadDenylist({ path: 'phrases.toml', cwd: tempDir });
    expect(patterns).toEqual([]);
  });

  // 4. No patterns key returns empty array (lenient)
  it('returns [] when the TOML file has no patterns key', async () => {
    await writeToml(tempDir, '# no patterns key here\ntitle = "test"\n');
    const patterns = await loadDenylist({ path: 'phrases.toml', cwd: tempDir });
    expect(patterns).toEqual([]);
  });

  // 5. Missing key field throws PhraseLoaderError with field path
  it('throws PhraseLoaderError with field path when an entry has no key', async () => {
    await writeToml(
      tempDir,
      `
[[patterns]]
regex = "some-pattern"
`,
    );
    await expect(loadDenylist({ path: 'phrases.toml', cwd: tempDir })).rejects.toThrow(
      PhraseLoaderError,
    );
    await expect(loadDenylist({ path: 'phrases.toml', cwd: tempDir })).rejects.toThrow(
      /patterns/,
    );
  });

  // 6. Missing regex field throws PhraseLoaderError
  it('throws PhraseLoaderError when an entry has no regex', async () => {
    await writeToml(
      tempDir,
      `
[[patterns]]
key = "missing-regex"
`,
    );
    await expect(loadDenylist({ path: 'phrases.toml', cwd: tempDir })).rejects.toThrow(
      PhraseLoaderError,
    );
    await expect(loadDenylist({ path: 'phrases.toml', cwd: tempDir })).rejects.toThrow(
      /patterns/,
    );
  });

  // 7. Duplicate key throws PhraseLoaderError naming the duplicate
  it('throws PhraseLoaderError naming the duplicate key', async () => {
    await writeToml(
      tempDir,
      `
[[patterns]]
key = "dup-key"
regex = "first"

[[patterns]]
key = "dup-key"
regex = "second"
`,
    );
    const err = await loadDenylist({ path: 'phrases.toml', cwd: tempDir }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PhraseLoaderError);
    expect((err as PhraseLoaderError).message).toMatch(/dup-key/);
  });

  // 8. Unknown flag character throws PhraseLoaderError
  it('throws PhraseLoaderError for an unknown flag character', async () => {
    await writeToml(
      tempDir,
      `
[[patterns]]
key = "bad-flag"
regex = "pattern"
flags = "x"
`,
    );
    await expect(loadDenylist({ path: 'phrases.toml', cwd: tempDir })).rejects.toThrow(
      PhraseLoaderError,
    );
    await expect(loadDenylist({ path: 'phrases.toml', cwd: tempDir })).rejects.toThrow(/bad-flag/);
  });

  // 9. RE2-unsafe pattern (backreference) throws PhraseLoaderError mentioning "RE2-safe"
  it('throws PhraseLoaderError with "RE2-safe" for a backreference pattern', async () => {
    await writeToml(
      tempDir,
      `
[[patterns]]
key = "backref-pattern"
regex = "(.)\\\\1"
`,
    );
    await expect(loadDenylist({ path: 'phrases.toml', cwd: tempDir })).rejects.toThrow(
      PhraseLoaderError,
    );
    await expect(loadDenylist({ path: 'phrases.toml', cwd: tempDir })).rejects.toThrow(/RE2-safe/);
  });

  // 10. RE2-unsafe pattern (lookahead) throws PhraseLoaderError
  it('throws PhraseLoaderError for a lookahead pattern', async () => {
    await writeToml(
      tempDir,
      `
[[patterns]]
key = "lookahead-pattern"
regex = "foo(?=bar)"
`,
    );
    await expect(loadDenylist({ path: 'phrases.toml', cwd: tempDir })).rejects.toThrow(
      PhraseLoaderError,
    );
    await expect(loadDenylist({ path: 'phrases.toml', cwd: tempDir })).rejects.toThrow(/RE2-safe/);
  });

  // 11. Invalid TOML syntax throws PhraseLoaderError
  it('throws PhraseLoaderError for invalid TOML syntax', async () => {
    await writeToml(tempDir, '[[patterns\nkey = "bad toml"');
    await expect(loadDenylist({ path: 'phrases.toml', cwd: tempDir })).rejects.toThrow(
      PhraseLoaderError,
    );
    await expect(loadDenylist({ path: 'phrases.toml', cwd: tempDir })).rejects.toThrow(
      /TOML parse error/,
    );
  });

  // 12. File not found throws PhraseLoaderError mentioning the path
  it('throws PhraseLoaderError mentioning the path when file is missing', async () => {
    const err = await loadDenylist({
      path: 'does-not-exist.toml',
      cwd: tempDir,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PhraseLoaderError);
    expect((err as PhraseLoaderError).message).toMatch(/does-not-exist\.toml/);
    expect((err as PhraseLoaderError).message).toMatch(/denylist file not found/);
  });

  // 13. Prototype pollution via quoted key throws PhraseLoaderError
  it('throws PhraseLoaderError for a quoted __proto__ key at top level', async () => {
    // smol-toml allows quoted __proto__ as a key; our guard must catch it
    await writeToml(tempDir, '"__proto__" = "x"\n');
    await expect(loadDenylist({ path: 'phrases.toml', cwd: tempDir })).rejects.toThrow(
      PhraseLoaderError,
    );
    await expect(loadDenylist({ path: 'phrases.toml', cwd: tempDir })).rejects.toThrow(
      /Prototype pollution attempt/,
    );
  });

  it('throws PhraseLoaderError for a [constructor] table in the TOML', async () => {
    await writeToml(tempDir, '[constructor]\nevil = true\n');
    await expect(loadDenylist({ path: 'phrases.toml', cwd: tempDir })).rejects.toThrow(
      PhraseLoaderError,
    );
    await expect(loadDenylist({ path: 'phrases.toml', cwd: tempDir })).rejects.toThrow(
      /Prototype pollution attempt/,
    );
  });

  it('throws PhraseLoaderError for a [__proto__] table in the TOML', async () => {
    await writeToml(tempDir, '[__proto__]\npolluted = true\n');
    await expect(loadDenylist({ path: 'phrases.toml', cwd: tempDir })).rejects.toThrow(
      PhraseLoaderError,
    );
    await expect(loadDenylist({ path: 'phrases.toml', cwd: tempDir })).rejects.toThrow(
      /Prototype pollution attempt/,
    );
  });

  // 14. Catastrophic regex (a+)+b compiles via RE2JS and runs in bounded time
  it('handles catastrophic regex (a+)+b in bounded time via RE2 engine', async () => {
    await writeToml(
      tempDir,
      `
[[patterns]]
key = "catastrophic"
regex = "(a+)+b"
`,
    );
    const patterns = await loadDenylist({ path: 'phrases.toml', cwd: tempDir });
    expect(patterns).toHaveLength(1);
    const pat = patterns[0];
    expect(pat).toBeDefined();
    // RE2 handles this in linear time — verify correct match behavior
    expect(pat!.compiled.test('aaab')).toBe(true);
    // A long non-matching string that would catastrophically backtrack in JS
    const longInput = 'a'.repeat(30) + 'c';
    const start = Date.now();
    expect(pat!.compiled.test(longInput)).toBe(false);
    // RE2 must handle this in well under 1 second (linear time)
    expect(Date.now() - start).toBeLessThan(500);
  });

  // 15. Reference URL is preserved
  it('preserves the reference URL when set', async () => {
    await writeToml(
      tempDir,
      `
[[patterns]]
key = "url-test"
regex = "sample"
reference_url = "https://example.org/style#url-test"
`,
    );
    const patterns = await loadDenylist({ path: 'phrases.toml', cwd: tempDir });
    expect(patterns).toHaveLength(1);
    expect(patterns[0]?.referenceUrl).toBe('https://example.org/style#url-test');
  });

  // Additional: invalid referenceUrl (not a valid URL) throws PhraseLoaderError
  it('throws PhraseLoaderError when reference_url is not a valid URL', async () => {
    await writeToml(
      tempDir,
      `
[[patterns]]
key = "bad-url"
regex = "pattern"
reference_url = "not-a-url"
`,
    );
    await expect(loadDenylist({ path: 'phrases.toml', cwd: tempDir })).rejects.toThrow(
      PhraseLoaderError,
    );
  });

  // PhraseLoaderError identity checks
  it('PhraseLoaderError has name set to PhraseLoaderError', async () => {
    const err = await loadDenylist({ path: 'no-file.toml', cwd: tempDir }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PhraseLoaderError);
    expect((err as PhraseLoaderError).name).toBe('PhraseLoaderError');
  });

  it('PhraseLoaderError is an instance of Error', async () => {
    const err = await loadDenylist({ path: 'no-file.toml', cwd: tempDir }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
  });

  // flags edge cases
  it('compiles a pattern with no flags (empty string)', async () => {
    await writeToml(
      tempDir,
      `
[[patterns]]
key = "no-flags"
regex = "CaseSensitive"
flags = ""
`,
    );
    const patterns = await loadDenylist({ path: 'phrases.toml', cwd: tempDir });
    expect(patterns).toHaveLength(1);
    // Case-sensitive: should NOT match lower-cased version
    expect(patterns[0]?.compiled.test('casesensitive')).toBe(false);
    expect(patterns[0]?.compiled.test('CaseSensitive')).toBe(true);
  });

  it('compiles a pattern with multiline flag "m"', async () => {
    await writeToml(
      tempDir,
      `
[[patterns]]
key = "multiline"
regex = "^cat"
flags = "m"
`,
    );
    const patterns = await loadDenylist({ path: 'phrases.toml', cwd: tempDir });
    expect(patterns).toHaveLength(1);
    expect(patterns[0]?.compiled.test('dog\ncat')).toBe(true);
    expect(patterns[0]?.compiled.test('dog\nnotcat')).toBe(false);
  });

  it('compiles a pattern with dotall flag "s"', async () => {
    await writeToml(
      tempDir,
      `
[[patterns]]
key = "dotall"
regex = "a.b"
flags = "s"
`,
    );
    const patterns = await loadDenylist({ path: 'phrases.toml', cwd: tempDir });
    expect(patterns).toHaveLength(1);
    expect(patterns[0]?.compiled.test('a\nb')).toBe(true);
    expect(patterns[0]?.compiled.test('axb')).toBe(true);
  });

  it('combines multiple flags correctly', async () => {
    await writeToml(
      tempDir,
      `
[[patterns]]
key = "multi-flag"
regex = "^cat"
flags = "im"
`,
    );
    const patterns = await loadDenylist({ path: 'phrases.toml', cwd: tempDir });
    expect(patterns).toHaveLength(1);
    expect(patterns[0]?.compiled.test('dog\nCat')).toBe(true);
  });

  it('returns patterns with correct regex source string', async () => {
    await writeToml(
      tempDir,
      `
[[patterns]]
key = "source-check"
regex = "\\\\bword\\\\b"
flags = "i"
`,
    );
    const patterns = await loadDenylist({ path: 'phrases.toml', cwd: tempDir });
    expect(patterns[0]?.regex).toBe('\\bword\\b');
  });
});
