/**
 * Citekey extraction from markdown prose.
 *
 * Uses extractProseLines to skip code blocks, inline code, and HTML, then
 * parses Pandoc-style citations on each prose line. Handles:
 *   - bracketed groups with multiple ;-separated items: `[@a; @b, pp. 33-35]`
 *   - author-suppression: `-@key` / `[-@key]`
 *   - locators (the suffix after a key within a bracket): `[@key, p. 42]`
 *   - bare in-text citations: `@key`
 *
 * Hand-rolled (no citation-parser dependency). Locators are surfaced as the
 * raw suffix string; page-range *validation* is out of scope.
 */

import { extractProseLines } from './prose.js';

export type CitekeyReference = {
  citekey: string; // without the leading @
  file: string;    // file path passed in
  line: number;    // 1-based
  locator: string | null; // e.g. 'p. 42', 'pp. 33-35'; null when none
  authorSuppressed: boolean; // true for -@key
};

// Citekey grammar: starts with alpha/digit/underscore/colon; may contain dots
// and hyphens internally; must end with an alphanumeric char, underscore, or
// colon (trailing punctuation belongs to the surrounding sentence). Matches the
// long-standing bibcheck/Pandoc behaviour.
const KEY = '[a-zA-Z0-9_:][a-zA-Z0-9_:.-]*[a-zA-Z0-9_:]|[a-zA-Z0-9_:]';

/** A citation token: optional author-suppression `-`, then `@`, then a key. */
const CITE_TOKEN_RE = new RegExp(`(-?)@(${KEY})`, 'g');

/** A bracketed group `[ ... ]`; the inner text is inspected for citations. */
const BRACKET_RE = /\[([^\]]*)\]/g;

/** Replace inline code spans (`` `...` ``) with equal-length blanks so their
 *  contents are never parsed as citations. (prose.ts already strips fenced
 *  code blocks and HTML; this covers inline spans within a prose line.) */
function maskInlineCode(text: string): string {
  return text.replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length));
}

/** Strip a leading comma/whitespace and return the locator, or null if empty. */
function extractLocator(suffix: string): string | null {
  const trimmed = suffix.replace(/^[\s,]+/, '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

type Positioned = CitekeyReference & { col: number };

/** Parse a single bracket item (e.g. `see @smith2020, pp. 33-35`). */
function parseBracketItem(
  item: string,
  file: string,
  line: number,
  col: number,
): Positioned | null {
  CITE_TOKEN_RE.lastIndex = 0;
  const m = CITE_TOKEN_RE.exec(item);
  if (m === null || m[2] === undefined) return null;
  const suffix = item.slice(m.index + m[0].length);
  return {
    citekey: m[2],
    file,
    line,
    locator: extractLocator(suffix),
    authorSuppressed: m[1] === '-',
    col,
  };
}

export function extractCitekeys(content: string, file: string): CitekeyReference[] {
  const proseLines = extractProseLines(content);
  const results: CitekeyReference[] = [];

  for (const { line, text: rawText } of proseLines) {
    const text = maskInlineCode(rawText);
    const lineRefs: Positioned[] = [];

    // 1. Bracketed citations. Record their spans so the bare-key pass below
    //    does not double-count keys that live inside a bracket.
    const spans: Array<[number, number]> = [];
    BRACKET_RE.lastIndex = 0;
    let bm: RegExpExecArray | null;
    while ((bm = BRACKET_RE.exec(text)) !== null) {
      const inner = bm[1];
      if (inner === undefined || !inner.includes('@')) continue;
      spans.push([bm.index, bm.index + bm[0].length]);
      for (const rawItem of inner.split(';')) {
        const ref = parseBracketItem(rawItem, file, line, bm.index);
        if (ref !== null) lineRefs.push(ref);
      }
    }

    // 2. Bare in-text citations, outside any bracket span.
    let masked = text;
    for (const [start, end] of spans) {
      masked = masked.slice(0, start) + ' '.repeat(end - start) + masked.slice(end);
    }
    CITE_TOKEN_RE.lastIndex = 0;
    let tm: RegExpExecArray | null;
    while ((tm = CITE_TOKEN_RE.exec(masked)) !== null) {
      if (tm[2] === undefined) continue;
      lineRefs.push({
        citekey: tm[2],
        file,
        line,
        locator: null,
        authorSuppressed: tm[1] === '-',
        col: tm.index,
      });
    }

    // Document order within the line.
    lineRefs.sort((a, b) => a.col - b.col);
    for (const { col: _col, ...ref } of lineRefs) {
      results.push(ref);
    }
  }

  return results;
}
