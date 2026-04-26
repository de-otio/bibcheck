/**
 * Citekey extraction from markdown prose.
 *
 * Uses extractProseLines to skip code blocks and HTML, then runs the
 * citekey regex against each prose line. Returns one CitekeyReference
 * per regex match.
 */

import { extractProseLines } from './prose.js';

export type CitekeyReference = {
  citekey: string; // without the leading @
  file: string;    // file path passed in
  line: number;    // 1-based
};

// Citekey grammar: starts with alpha/digit/underscore/colon; can contain
// dots and hyphens after the first character, but must end with an
// alphanumeric char, underscore, or colon (never a trailing dot or hyphen).
// This matches Pandoc citeproc behaviour where trailing punctuation belongs
// to the surrounding sentence, not the citekey.
const CITEKEY_RE = /@([a-zA-Z0-9_:][a-zA-Z0-9_:.-]*[a-zA-Z0-9_:]|[a-zA-Z0-9_:])/g;

export function extractCitekeys(content: string, file: string): CitekeyReference[] {
  const proseLines = extractProseLines(content);
  const results: CitekeyReference[] = [];

  for (const { line, text } of proseLines) {
    CITEKEY_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CITEKEY_RE.exec(text)) !== null) {
      const citekey = match[1];
      if (citekey !== undefined) {
        results.push({ citekey, file, line });
      }
    }
  }

  return results;
}
