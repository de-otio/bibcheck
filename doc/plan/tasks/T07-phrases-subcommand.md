# T07 — `bibcheck phrases` subcommand

**Phase:** 2b (Subcommand modules)
**Complexity:** small
**Depends on:** T03 (markdown utilities), T04 (phrase denylist loader)
**Blocks:** T13 (check orchestrator), T15 (CLI)

## Scope

Implement the `phrases` subcommand: regex pass over markdown prose against a project-supplied phrase denylist, with `<!-- bibcheck-allow: <key> -->` acknowledgement-comment detection.

This is a generic linting primitive. bibcheck does not ship denylist content; the subcommand is a no-op when the user has not configured `[phrases].file` in `bibcheck.toml`.

## Files

- `src/phrases.ts` — `runPhrases` function.
- `test/phrases.test.ts` — subcommand unit tests (T07 owns this file; T04 owns `test/phrases-loader.test.ts` for the denylist-loader tests).

## Interfaces

### Imports

- `./phrases/load.js` — `Pattern[]` from T04.
- `./markdown/glob.js` — file discovery from T03.
- `./schema/output.js` — `PhraseFlag` type.
- `./config.js` — `Config` from T01.

### Exports

```ts
export interface RunPhrasesDeps {
  config: Config;
  patterns: Pattern[];           // already-loaded denylist; may be empty
  readFile: (path: string) => Promise<string>;
  cwd: string;
}

export interface RunPhrasesResult {
  flags: PhraseFlag[];
}

export async function runPhrases(deps: RunPhrasesDeps): Promise<RunPhrasesResult>;
```

When `patterns` is empty, `runPhrases` returns `{ flags: [] }` immediately without reading any files.

## Algorithm

For each markdown file matching `Config.docs.include` (minus excludes):

1. Read the file as text.
2. Consume `extractProseLines(content)` from T03's markdown utilities. This returns only prose lines, automatically excluding fenced code blocks, inline code spans, HTML comments, and YAML front-matter.
3. For each prose line, run each compiled `RE2JS` pattern against the line text using `RE2JS.compile(pattern).exec(line)`.
4. For each match:
   a. Determine if there's an associated `<!-- bibcheck-allow: <key> -->` acknowledgement — search the same line and the immediately preceding line.
   b. Status:
      - `acknowledged` if the acknowledgement exists and the key matches the pattern that fired.
      - `flagged` if no acknowledgement, or one exists but its key doesn't match this pattern.
   c. Construct a `PhraseFlag` record per the schema:
      - `patternKey`: from the matched pattern.
      - `referenceUrl`: from the matched pattern (or `null` if absent).
      - `file`: relative path from cwd.
      - `line`: the line number as returned by `extractProseLines` (1-indexed, referring to position in the original file).
      - `matchedText`: the captured string from `RE2JS.compile(pattern).exec(line)`.

Patterns are compiled once at the start of the run via `RE2JS.compile(pattern.regex)`, not per line.

## Implementation notes

- **Code-block and inline-code exclusion**: handled entirely by T03's `extractProseLines(content)`. Code blocks, inline code spans, HTML comments, and YAML front-matter are excluded automatically — no `inCodeBlock` tracking is needed in `runPhrases`.
- **Acknowledgement comment detection**: the `<!-- bibcheck-allow: <key> -->` comment is HTML. A simple regex `/<!--\s*bibcheck-allow:\s*([\w-]+)\s*-->/` extracts the key. Check both the current prose line and the immediately preceding prose line.
- **Multiple matches per line**: a single line may match multiple patterns. Iterate all patterns; emit one `PhraseFlag` per (pattern, line) pair.
- **Partial overlap**: don't try to deduplicate overlapping matches; emit each separately. The user / agent / human review handles them.
- **Empty patterns array shortcut**: skip file globbing entirely when `patterns.length === 0`.

## Acceptance criteria

- [ ] `runPhrases` returns `PhraseFlag[]` shaped per the schema.
- [ ] Empty `patterns` array → no findings, no file reads.
- [ ] Patterns from `patterns` are compiled once per run, not per file.
- [ ] Patterns inside fenced code blocks are NOT flagged (verified via fixture with a deprecated term inside a `` ``` `` block).
- [ ] Patterns inside inline code spans do NOT trigger matches.
- [ ] `<!-- bibcheck-allow: <key> -->` on the same line marks the match as `acknowledged`.
- [ ] `<!-- bibcheck-allow: <key> -->` on the preceding line marks the match as `acknowledged` (status is `acknowledged`, not `flagged`).
- [ ] Mismatched acknowledgement key → `flagged`.
- [ ] No acknowledgement → `flagged`.
- [ ] File paths in output are relative to `cwd`.

## Tests

`test/phrases.test.ts` (subcommand portion):

- Empty `patterns` array → empty result, no I/O.
- Plain prose containing a configured-pattern match → flagged.
- Prose with `<!-- bibcheck-allow: <key> -->` → acknowledged.
- Pattern inside a fenced code block → not matched.
- Pattern inside an inline code span → not matched.
- Pattern with mismatched acknowledgement key → flagged.
- Multiple patterns matching one line → multiple flags emitted.
- Multi-file fixture: matches from each file are aggregated.
- Patterns at line 1 / EOF.
- Acknowledgement on the line above the match → acknowledged.

Tests construct synthetic `patterns` arrays directly; they do not depend on a baseline file (there isn't one).

Coverage target: ≥ 80% line + branch for `src/phrases.ts`.

## New dependencies

None.
