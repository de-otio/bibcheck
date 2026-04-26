/**
 * Block extraction from markdown: blockquotes and direct (typographic) quotes.
 *
 * extractBlockquotes walks the mdast for blockquote nodes.
 * extractDirectQuotes uses extractProseLines and searches each prose line
 * for curly/typographic quote pairs or straight-quote pairs of length >= 4.
 */

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { toString as mdastToString } from 'mdast-util-to-string';
import type { Root, Blockquote as MdastBlockquote } from 'mdast';
import { extractProseLines } from './prose.js';

export type Blockquote = {
  text: string;      // full text of the blockquote
  startLine: number; // 1-based, line of first `>`
  endLine: number;
};

export type DirectQuote = {
  text: string;
  line: number; // 1-based
};

export function extractBlockquotes(content: string): Blockquote[] {
  const tree = unified().use(remarkParse).parse(content) as Root;
  const results: Blockquote[] = [];

  for (const node of tree.children) {
    if (node.type === 'blockquote') {
      const bq = node as MdastBlockquote;
      const pos = bq.position;
      if (pos !== undefined && pos !== null) {
        results.push({
          text: mdastToString(bq),
          startLine: pos.start.line,
          endLine: pos.end.line,
        });
      }
    }
  }

  return results;
}

// Opening typographic quote characters (Unicode):
//   U+201C  LEFT DOUBLE QUOTATION MARK  "
//   U+201E  DOUBLE LOW-9 QUOTATION MARK  „
//   U+00AB  LEFT-POINTING DOUBLE ANGLE QUOTATION MARK  <<
// Closing typographic quote characters (Unicode):
//   U+201D  RIGHT DOUBLE QUOTATION MARK  "
//   U+00BB  RIGHT-POINTING DOUBLE ANGLE QUOTATION MARK  >>
//
// Negated inner class excludes both opening and closing curly quotes so the
// match stops at the first closing typographic quote.
//
// Using \u escapes to avoid any editor/file-write smart-quote substitution.
// eslint-disable-next-line no-misleading-character-class
const TYPOGRAPHIC_RE = new RegExp(
  '[“„«]([^“”„«»]{4,})[”»]',
  'g',
);

// Straight double-quote pairs: "..." where inner content is >= 4 chars.
// Uses ASCII 0x22 for the quote characters — no smart-quote ambiguity.
const STRAIGHT_RE = /"([^"]{4,})"/g;

export function extractDirectQuotes(content: string): DirectQuote[] {
  const proseLines = extractProseLines(content);
  const results: DirectQuote[] = [];

  for (const { line, text } of proseLines) {
    TYPOGRAPHIC_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = TYPOGRAPHIC_RE.exec(text)) !== null) {
      const quoted = match[1];
      if (quoted !== undefined) {
        results.push({ text: quoted, line });
      }
    }

    STRAIGHT_RE.lastIndex = 0;
    while ((match = STRAIGHT_RE.exec(text)) !== null) {
      const quoted = match[1];
      if (quoted !== undefined) {
        results.push({ text: quoted, line });
      }
    }
  }

  return results;
}
