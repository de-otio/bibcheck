/**
 * bibcheck worklist subcommand.
 *
 * Generates the manual-triage worklist for Layer 2 / Layer 3 verification.
 * Each citation in the prose is examined for four categories:
 *   A. direct-quotation
 *   B. paraphrase-with-page-ref
 *   C. contested-source-type
 *   D. non-canonical-edition
 *
 * Items are informational — they do NOT cause a non-zero exit code.
 */

import type { CslEntry } from './schema/csl.js';
import type { WorklistItem } from './schema/output.js';
import type { Config } from './config.js';
import { discoverDocs } from './markdown/glob.js';
import { extractCitekeys } from './markdown/citekeys.js';
import { extractBlockquotes, extractDirectQuotes } from './markdown/blocks.js';
import { extractProseLines } from './markdown/prose.js';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface RunWorklistDeps {
  config: Config;
  cwd: string;
  bibliography: CslEntry[];
  readFile: (path: string) => Promise<string>;
  signal: AbortSignal;
}

export interface RunWorklistResult {
  worklist: WorklistItem[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Regex matching page references like (p. 42), (pp. 42-44), (p.42), etc. */
const PAGE_REF_RE = /\(\s*pp?\.?\s*\d+(?:[-–]\d+)?\s*\)/;

/** Snippet target length in characters. */
const SNIPPET_TARGET = 80;

/** Source types treated as contested when warn_load_bearing is not explicitly false. */
const CONTESTED_TYPES = new Set(['webpage', 'blog', 'preprint', 'wikipedia']);

/** URL hosts that are considered archive/canonical for verificationUrl passthrough. */
const CANONICAL_URL_HOSTS_RE =
  /archive\.org|hathitrust\.org|oll\.libertyfund\.org|plato\.stanford\.edu/i;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the first author's family name (surname) from a CSL entry, or
 * undefined if no author information is available.
 */
export function getFirstAuthorSurname(entry: CslEntry): string | undefined {
  const authors = entry.author;
  if (!Array.isArray(authors) || authors.length === 0) return undefined;
  const first = authors[0];
  if (first === undefined) return undefined;
  if (typeof first.family === 'string' && first.family.trim() !== '') {
    return first.family.trim();
  }
  // Fall back to literal name — take the last word as surname
  if (typeof first.literal === 'string' && first.literal.trim() !== '') {
    const parts = first.literal.trim().split(/\s+/);
    return parts[parts.length - 1];
  }
  return undefined;
}

/**
 * Build a ~80-char snippet of surrounding prose around the citation on the
 * given line. Strips the leading markdown blockquote marker (`> `) if present.
 */
function buildSnippet(text: string, target = SNIPPET_TARGET): string {
  // Strip leading blockquote markers
  const cleaned = text.replace(/^(?:>\s*)+/, '').trim();
  if (cleaned.length <= target) return cleaned;
  // Trim to target length with ellipsis on the right
  return cleaned.slice(0, target - 1) + '…';
}

/**
 * Returns a verification URL for the entry, or a Google Books fallback search
 * URL using `quoteText` as the search term.
 */
function buildVerificationUrl(
  entry: CslEntry,
  quoteText: string,
): string | null {
  const entryUrl = entry.url;
  if (typeof entryUrl === 'string' && entryUrl.trim() !== '') {
    if (CANONICAL_URL_HOSTS_RE.test(entryUrl)) {
      return entryUrl;
    }
  }
  // Build a Google Books search URL using the first ~10 chars of the quote text
  const searchTerm = quoteText.slice(0, 60).trim();
  if (searchTerm === '') return null;
  return `https://www.google.com/search?tbm=bks&q=${encodeURIComponent(searchTerm)}`;
}

// ---------------------------------------------------------------------------
// Per-file processing
// ---------------------------------------------------------------------------

function processFile(
  filePath: string,
  content: string,
  bibMap: Map<string, CslEntry>,
  config: Config,
): WorklistItem[] {
  const items: WorklistItem[] = [];

  const citekeys = extractCitekeys(content, filePath);
  if (citekeys.length === 0) return items;

  // Build lookup structures for blockquote ranges and direct-quote lines
  const blockquotes = extractBlockquotes(content);
  const directQuotes = extractDirectQuotes(content);
  const directQuoteLines = new Set(directQuotes.map((dq) => dq.line));

  // Build a map from line number → prose text for snippet extraction
  const proseLines = extractProseLines(content);
  const proseMap = new Map<number, string>(proseLines.map((pl) => [pl.line, pl.text]));

  for (const ref of citekeys) {
    const entry = bibMap.get(ref.citekey);
    if (entry === undefined) {
      // Not in bibliography — linkage handles this, skip
      continue;
    }

    const lineText = proseMap.get(ref.line) ?? '';
    const snippet = buildSnippet(lineText);

    // Determine if line is inside a blockquote
    const inBlockquote = blockquotes.some(
      (bq) => ref.line >= bq.startLine && ref.line <= bq.endLine,
    );

    // Determine if line has a direct typographic/quoted span
    const inDirectQuote = directQuoteLines.has(ref.line);

    let isDirectQuotation = false;

    // --- A. direct-quotation ---
    if (inBlockquote || inDirectQuote) {
      isDirectQuotation = true;

      // For the verification URL, try to use the first direct quote text on this
      // line as the search term, otherwise use the snippet
      const quoteText =
        directQuotes.find((dq) => dq.line === ref.line)?.text ?? snippet;

      const verificationUrl = buildVerificationUrl(entry, quoteText);

      items.push({
        type: 'direct-quotation',
        file: filePath,
        line: ref.line,
        citation: ref.citekey,
        snippet,
        verificationUrl,
        recommendedAction:
          'Verify quotation wording verbatim against the named edition.',
      });
    }

    // --- B. paraphrase-with-page-ref ---
    // Only emit if not already classified as a direct quotation. Fires when the
    // prose line has a page reference OR the parsed citation carries a locator.
    if (!isDirectQuotation && (ref.locator !== null || PAGE_REF_RE.test(lineText))) {
      const pageMatch = PAGE_REF_RE.exec(lineText);
      const locator = ref.locator ?? (pageMatch !== null ? pageMatch[0] : null);
      const pageRef = locator ?? '';

      const verificationUrl = buildVerificationUrl(entry, snippet);

      items.push({
        type: 'paraphrase-with-page-ref',
        file: filePath,
        line: ref.line,
        citation: ref.citekey,
        snippet,
        verificationUrl,
        locator,
        recommendedAction: `Verify paraphrase against page ${pageRef} of the named edition.`,
      });
    }

    // --- C. contested-source-type ---
    const entryType = entry.type ?? '';
    if (
      CONTESTED_TYPES.has(entryType) &&
      config.source_types[entryType]?.warn_load_bearing !== false
    ) {
      items.push({
        type: 'contested-source-type',
        file: filePath,
        line: ref.line,
        citation: ref.citekey,
        snippet,
        verificationUrl: entry.url ?? null,
        recommendedAction: `${entryType} citation; confirm the claim is supported and the source is appropriate.`,
      });
    }

    // --- D. non-canonical-edition ---
    const surname = getFirstAuthorSurname(entry);
    if (surname !== undefined) {
      const lowerSurname = surname.toLowerCase();
      const canonicalEdition = config.edition_discipline[lowerSurname];
      if (canonicalEdition !== undefined) {
        const noteText = entry.note ?? '';
        if (!noteText.toLowerCase().includes(canonicalEdition.toLowerCase())) {
          items.push({
            type: 'non-canonical-edition',
            file: filePath,
            line: ref.line,
            citation: ref.citekey,
            snippet,
            verificationUrl: null,
            recommendedAction: `Use the ${canonicalEdition} for this author.`,
          });
        }
      }
    }
  }

  return items;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function runWorklist(
  deps: RunWorklistDeps,
): Promise<RunWorklistResult> {
  const { config, cwd, bibliography, readFile, signal } = deps;

  if (signal.aborted) {
    throw new Error('AbortSignal already aborted before runWorklist started');
  }

  // Build O(1) bibliography lookup map
  const bibMap = new Map<string, CslEntry>(
    bibliography.map((entry) => [entry.citekey, entry]),
  );

  // Discover markdown documents
  const docs = await discoverDocs({
    cwd,
    include: config.docs.include,
    exclude: config.docs.exclude,
  });

  const worklist: WorklistItem[] = [];

  for (const doc of docs) {
    if (signal.aborted) {
      throw new Error('Operation aborted');
    }

    const content = await readFile(doc.path);
    const items = processFile(doc.relativePath, content, bibMap, config);
    worklist.push(...items);
  }

  // Deterministic output order (file, line, type) — stable CI diffs.
  worklist.sort(
    (a, b) =>
      a.file.localeCompare(b.file) || a.line - b.line || a.type.localeCompare(b.type),
  );

  return { worklist };
}
