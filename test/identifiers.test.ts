import { describe, it, expect } from 'vitest';
import {
  validateDoi,
  validateIsbn,
  validateUrl,
  normalizeIsbn,
  identifiersFor,
  runIdentifiers,
} from '../src/identifiers.js';
import type { CslEntry } from '../src/schema/csl.js';

// Build a minimal CslEntry for tests (the real type carries many optional fields).
function entry(partial: Partial<CslEntry> & { citekey: string }): CslEntry {
  return partial as CslEntry;
}

describe('validateDoi', () => {
  it.each([
    ['10.1086/684640', 'ok'],
    ['10.1000/xyz123', 'ok'],
    ['https://doi.org/10.1086/684640', 'ok'],
    ['http://dx.doi.org/10.1086/684640', 'ok'],
    ['doi:10.1086/684640', 'ok'],
    ['10.1/short', 'malformed'], // registrant < 4 digits
    ['10.1086', 'malformed'], // no suffix
    ['https://example.com/foo', 'malformed'],
    ['not-a-doi', 'malformed'],
    ['', 'malformed'],
  ])('validateDoi(%s) -> %s', (input, expected) => {
    expect(validateDoi(input)).toBe(expected);
  });
});

describe('validateIsbn', () => {
  it('accepts a valid ISBN-13', () => {
    expect(validateIsbn('9780306406157')).toBe('ok');
    expect(validateIsbn('978-0-306-40615-7')).toBe('ok'); // hyphenated
  });

  it('accepts a valid ISBN-10 (including trailing X)', () => {
    expect(validateIsbn('0306406152')).toBe('ok');
    expect(validateIsbn('0-306-40615-2')).toBe('ok');
    expect(validateIsbn('097522980X')).toBe('ok'); // valid X check digit
  });

  it('returns bad-checksum for a transposed digit (right shape)', () => {
    expect(validateIsbn('9780306406158')).toBe('bad-checksum'); // last digit wrong
    expect(validateIsbn('0306406153')).toBe('bad-checksum');
  });

  it('returns malformed for wrong length / shape', () => {
    expect(validateIsbn('123456789')).toBe('malformed'); // 9 digits
    expect(validateIsbn('97803064061570')).toBe('malformed'); // 14 digits
    expect(validateIsbn('978030640615X')).toBe('malformed'); // X not allowed in 13
    expect(validateIsbn('abcdefghij')).toBe('malformed');
    expect(validateIsbn('')).toBe('malformed');
  });

  // Stands in for property-based testing (fast-check is not a dependency):
  // exhaustively flipping any single digit of a valid ISBN-13 to a different
  // value must never yield 'ok' (it stays 13 digits, so checksum -> bad-checksum).
  it('any single-digit change to a valid ISBN-13 is never ok', () => {
    const valid = '9780306406157';
    for (let i = 0; i < valid.length; i++) {
      const original = Number(valid[i]);
      for (let d = 0; d <= 9; d++) {
        if (d === original) continue;
        const mutated = valid.slice(0, i) + String(d) + valid.slice(i + 1);
        const verdict = validateIsbn(mutated);
        expect(verdict, `flip pos ${i} -> ${d} (${mutated})`).toBe('bad-checksum');
        expect(verdict).not.toBe('ok');
      }
    }
  });
});

describe('normalizeIsbn', () => {
  it('strips hyphens/spaces and upper-cases X', () => {
    expect(normalizeIsbn('978-0-306-40615-7')).toBe('9780306406157');
    expect(normalizeIsbn('0 97522 980x')).toBe('097522980X');
  });
  it('returns null for non-ISBN shapes', () => {
    expect(normalizeIsbn('123')).toBeNull();
    expect(normalizeIsbn('not an isbn')).toBeNull();
  });
});

describe('validateUrl', () => {
  it.each([
    ['https://www.gutenberg.org/ebooks/1', 'ok'],
    ['http://archive.org/details/x', 'ok'],
    ['javascript:alert(1)', 'malformed'],
    ['file:///etc/passwd', 'malformed'],
    ['ftp://example.com/x', 'malformed'],
    ['not a url', 'malformed'],
    ['', 'malformed'],
  ])('validateUrl(%s) -> %s', (input, expected) => {
    expect(validateUrl(input)).toBe(expected);
  });
});

describe('identifiersFor', () => {
  it('marks absent identifiers not-applicable', () => {
    expect(identifiersFor(entry({ citekey: 'a' }))).toEqual({
      doi: 'not-applicable',
      isbn: 'not-applicable',
      url: 'not-applicable',
    });
  });

  it('treats empty/whitespace identifiers as not-applicable', () => {
    expect(identifiersFor(entry({ citekey: 'a', doi: '', url: '   ' }))).toEqual({
      doi: 'not-applicable',
      isbn: 'not-applicable',
      url: 'not-applicable',
    });
  });

  it('validates each present identifier independently', () => {
    expect(
      identifiersFor(
        entry({
          citekey: 'mix',
          doi: '10.1086/684640',
          isbn: '9780306406158', // bad checksum
          url: 'javascript:x', // malformed
        }),
      ),
    ).toEqual({ doi: 'ok', isbn: 'bad-checksum', url: 'malformed' });
  });
});

describe('runIdentifiers', () => {
  it('produces one layer per entry, in input order', () => {
    const result = runIdentifiers({
      bibliography: [
        entry({ citekey: 'good', doi: '10.1086/684640' }),
        entry({ citekey: 'badisbn', isbn: '123456789' }),
        entry({ citekey: 'none' }),
      ],
    });
    expect(result.entries.map((e) => e.citekey)).toEqual(['good', 'badisbn', 'none']);
    expect(result.entries[0]?.identifiers.doi).toBe('ok');
    expect(result.entries[1]?.identifiers.isbn).toBe('malformed');
    expect(result.entries[2]?.identifiers).toEqual({
      doi: 'not-applicable',
      isbn: 'not-applicable',
      url: 'not-applicable',
    });
  });

  it('handles an empty bibliography', () => {
    expect(runIdentifiers({ bibliography: [] }).entries).toEqual([]);
  });
});
