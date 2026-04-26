# T03 — Markdown utilities

**Phase:** 1 (Foundation)
**Complexity:** medium
**Depends on:** none
**Blocks:** T07 (phrases), T10 (linkage), T11 (worklist)

## Scope

Three small modules for parsing markdown documents:

1. Citekey extraction — find `@citekey` references, with file:line:col anchors. Handles Pandoc-citeproc syntax.
2. Block extraction — find blockquotes and inline direct-quote heuristics.
3. File globbing — discover markdown files using include/exclude patterns from config.

## Files

- `src/markdown/citekeys.ts` — citekey extraction.
- `src/markdown/blocks.ts` — blockquote and direct-quote extraction.
- `src/markdown/glob.ts` — file discovery.
- `test/markdown.test.ts` — unit tests for all three.

## Interfaces

### Imports

- `tinyglobby` (new dependency — confirm before adding; replaces any `glob` or `node:fs/promises fs.glob` alternative).
- `unified` + `remark-parse` + `mdast-util-to-string` (new dependencies — confirm before adding). These are mandatory; the hand-rolled regex alternative is dropped.

### Exports

```ts
// citekeys.ts
export interface CitekeyReference {
  citekey: string;
  file: string;
  line: number;          // 1-indexed
  column: number;        // 1-indexed
  raw: string;           // original text matched, e.g., "[@key, p. 47]"
  pageRef: string | null;  // "p. 47" if present, else null
}

export async function extractCitekeys(filePath: string, content: string): Promise<CitekeyReference[]>;

// blocks.ts
export interface Blockquote {
  text: string;
  file: string;
  startLine: number;
  endLine: number;
}

export interface DirectQuote {
  text: string;
  file: string;
  line: number;
  nearbyCitation: string | null;     // citekey of the citation closest after the quote, if any
}

export async function extractBlockquotes(filePath: string, content: string): Promise<Blockquote[]>;
export async function extractDirectQuotes(filePath: string, content: string): Promise<DirectQuote[]>;

// glob.ts
export interface FindFilesOptions {
  cwd: string;
  include: string[];
  exclude?: string[];
}

export async function findFiles(opts: FindFilesOptions): Promise<string[]>;

// prose-lines.ts (new helper, consumed by T07, T10, T11)
export function extractProseLines(content: string): { line: number; text: string }[];
```

`extractProseLines` returns text lines OUTSIDE code blocks (fenced triple-backtick, indented 4-space, inline `<pre>`, HTML comments `<!-- ... -->`, and YAML front-matter). Walks the mdast AST and visits text nodes, dropping anything inside `code`, `inlineCode`, `html`, `yaml`, and `toml` node types. Returns one entry per markdown line containing prose, with the 1-based line number.

T07, T10, and T11 will consume `extractProseLines` rather than re-implementing code-block exclusion. T03 owns this helper.

## Implementation notes

### Citekey extraction

Pandoc-citeproc citekey syntax:
- `[@key]` — basic
- `[@key, p. 47]` — with locator
- `[@key1; @key2]` — multiple in one bracket group
- `@key` — bare (less common; supported)
- `[-@key]` — suppress author
- `\@key` — escaped (NOT a citation)
- Citekeys inside `code spans` or fenced code blocks — NOT citations.

Recommended: parse the markdown with `remark` to get an AST, walk the AST and only inspect text nodes (skipping `code` and `inlineCode` nodes), then run a citekey regex against text nodes. This is robust to code-block escaping for free.

Citekey regex (over text nodes only): `/(?<!\\)@([a-zA-Z][\w:.#$%&+?<>~/-]*)/g`

Locator regex within bracketed citation: `/,\s*((?:p\.|pp\.|chap\.|sec\.)\s*[\w\s.\-,–]+)/`

### Block extraction

- Blockquotes: AST nodes of type `'blockquote'`. Aggregate their text content; track start/end lines.
- Direct quotes: heuristic — sequences of `“…”`, `"…"`, or single `‘…’` of length > 20 chars within a paragraph. Pair with the nearest citekey reference *after* the quote on the same or next 2 lines.

The direct-quote heuristic is intentionally fuzzy. False positives are tolerable; the worklist (T11) is a triage tool, not a verification result.

### Glob

Use `tinyglobby` for include/exclude patterns. Honour `bibcheck.toml`'s `[docs]` section. Return absolute paths.

## Acceptance criteria

- [ ] `extractCitekeys` returns all `@citekey` references with accurate `file`, `line`, `column`.
- [ ] Citekeys inside fenced code blocks are NOT returned.
- [ ] Citekeys inside inline code are NOT returned.
- [ ] Escaped citekeys (`\@key`) are NOT returned.
- [ ] Page-locator parsing populates `pageRef` correctly.
- [ ] Multiple citekeys in one `[@key1; @key2]` group are returned as separate entries.
- [ ] `extractBlockquotes` returns aggregated text for `>` blocks with correct line numbers.
- [ ] `extractDirectQuotes` returns quoted strings of length > 20, with the closest-following citation when present.
- [ ] `findFiles` honours include/exclude patterns and returns absolute paths.
- [ ] `extractProseLines` correctly excludes fenced code blocks.
- [ ] `extractProseLines` correctly excludes HTML comments.
- [ ] `extractProseLines` correctly excludes YAML front-matter.
- [ ] `extractProseLines` preserves 1-based line numbers.

## Tests

`test/markdown.test.ts`:

- Citekey: bare `@key`, bracketed `[@key]`, with locator `[@key, p. 47]`, multiple in one group, escaped `\@key`.
- Citekey: code-block containment — fenced and inline code spans must NOT match.
- Citekey: line / column tracking on multi-line files.
- Citekey: edge cases — citekey at start of file, end of file, immediately after punctuation.
- Blockquote: single-line, multi-line, nested blockquotes (treat as one).
- Direct quote: typographic (curly) quotes, straight quotes, mixed.
- Direct quote: pairing with nearest citation.
- Glob: include + exclude; absolute paths returned.

Use a fixtures folder at `test/fixtures/markdown/` for sample markdown files; or inline strings in tests.

Coverage target: ≥ 80% line + branch for `src/markdown/**/*.ts`.

## New dependencies to confirm

- `tinyglobby` — file globbing (replaces `glob`).
- `unified` + `remark-parse` — markdown AST. Mandatory; regex alternative is dropped.
- `mdast-util-to-string` — flatten AST node trees into text.

Confirm all four before adding to `package.json` `dependencies`.
