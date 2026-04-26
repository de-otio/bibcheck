# T11 — `bibcheck worklist` subcommand

**Phase:** 2b (Subcommand modules)
**Complexity:** medium
**Depends on:** T03 (markdown utilities), T01 (config — for source-type rules and edition-discipline)
**Blocks:** T13 (check orchestrator), T15 (CLI)

## Scope

Generate the manual-triage worklist for Layer 2 / Layer 3 verification items. The worklist is the bridge between bibcheck's automated layers and the human-verification layer; it converts ambient anxiety ("there might be quote-wording errors somewhere") into a finite, prioritised list with pre-filled verification URLs.

## Files

- `src/worklist.ts` — `runWorklist` function.
- `test/worklist.test.ts` — unit tests.

## Interfaces

### Imports

- `./markdown/citekeys.js` — citekey extraction from T03.
- `./markdown/blocks.js` — blockquote / direct-quote extraction from T03.
- `./markdown/glob.js` — file discovery from T03.
- `./schema/output.js` — `WorklistItem`, `WorklistItemType`.
- `./config.js` — `Config`.

### Exports

```ts
export interface RunWorklistDeps {
  config: Config;
  bibliography: CslEntry[];
  readFile: (path: string) => Promise<string>;
  cwd: string;
}

export interface RunWorklistResult {
  worklist: WorklistItem[];
}

export async function runWorklist(deps: RunWorklistDeps): Promise<RunWorklistResult>;
```

## Algorithm — what to emit

For each markdown file:

### 1. Direct quotations (`type: 'direct-quotation'`)

Use `extractDirectQuotes` (T03). For each quote that has a `nearbyCitation` (a citekey within 2 lines after the quote):

- Generate a verification URL based on the cited work's metadata. Templates:
  - **Internet Archive search**: `https://archive.org/search?query=<title>+%22<quoted-phrase>%22`
  - **HathiTrust full-text search**: `https://catalog.hathitrust.org/Search/Home?lookfor=...`
  - **Google Books search**: `https://www.google.com/search?tbm=bks&q=%22<quoted-phrase>%22+<title>`
  - Pick the most appropriate based on the bibliography entry's `URL` host (if `archive.org`, use IA; if `oll.libertyfund.org`, use a Liberty Fund search; otherwise Google Books).

- Emit:
  ```
  {
    type: 'direct-quotation',
    file, line, citation,
    snippet: <surrounding prose, ~80 chars>,
    verificationUrl: <generated>,
    recommendedAction: 'Verify wording against source.',
  }
  ```

### 2. Paraphrase with page reference (`type: 'paraphrase-with-page-ref'`)

For each `CitekeyReference` whose `pageRef` is non-null:

- Verification URL: same templates as above, but search for the surrounding prose rather than a quoted phrase.
- `recommendedAction: 'Verify the cited page supports the surrounding claim.'`

### 3. Contested-coverage source-type (`type: 'contested-source-type'`)

For each citekey reference where the bibliography entry's `type` (CSL field) or `URL` host falls into a contested-coverage category per `Config.source_types`:

- E.g., entry with `URL: https://en.wikipedia.org/...` and `source_types.wikipedia.warn_load_bearing = true` → flag.
- E.g., entry with `type: "post-weblog"` and `source_types.blog.warn_load_bearing = true` → flag.

- `recommendedAction: 'Source type "<type>" warrants explicit weighting in prose.'`
- `verificationUrl: null` (no automatic verification available).

### 4. Non-canonical edition (`type: 'non-canonical-edition'`)

Hardest of the four. For each bibliography entry referenced in prose:

- If `Config.edition_discipline` has an entry for the work's author (lookup by surname), AND the bibliography entry's `note` field doesn't match the canonical edition signal, flag.
- E.g., a Mill citation that uses Penguin Classics page numbers when `config.edition_discipline.mill = "toronto-cw"`.
- `recommendedAction: 'Use the <canonical-edition> for this work.'`
- `verificationUrl: null`.

This check is best-effort in v0.1; if it generates too many false-positives in real use, it will be refined.

## Implementation notes

- **Prose-line walking**: use T03's `extractProseLines(content)` to walk markdown text. Direct quotations are detected as text inside markdown blockquote (`> ...`) syntax — T03 keeps blockquote markers in the AST so this works at the mdast level. Page-cited paraphrases use a regex like `\(p\.?\s*\d+\)` against prose lines.
- **Snippet extraction**: ~80 characters of prose around the citation, stripped of markdown syntax. Truncate with ellipsis on either side.
- **URL templating**: keep the templates simple. The agent and the human reviewer can navigate from the pre-filled search URL to the actual passage.
- **Performance**: worklist generation is per-file streaming; no global aggregation needed except final concatenation.
- **Exit-code behaviour**: worklist items are *informational* — they do NOT cause `bibcheck check` to exit non-zero. The exit-code rule is owned by T13 (Wave 0.9 decision).

## Acceptance criteria

- [ ] Direct quotations near a citation are emitted with type `direct-quotation`.
- [ ] Page-ref paraphrases are emitted with type `paraphrase-with-page-ref`.
- [ ] Contested source-types are flagged per config rules.
- [ ] Non-canonical-edition cases are flagged per `edition_discipline` config.
- [ ] Each item has a relevant `verificationUrl` (or null when not applicable).
- [ ] A worklist item's `verificationUrl` is `null` when no useful URL can be pre-filled (e.g., for `paraphrase-with-page-ref` without a clear edition).
- [ ] Snippets are bounded length (≤ 200 chars).
- [ ] File paths are relative to `cwd`.

## Tests

`test/worklist.test.ts`:

- Direct quote near citation → emitted with appropriate URL template.
- Direct quote not near any citation → not emitted (no citation to anchor to).
- Page-ref citation `[@key, p. 47]` → emitted as paraphrase-with-page-ref.
- Bare citation `[@key]` → not emitted as paraphrase (no page ref).
- Wikipedia URL in bibliography + load-bearing config → emitted as contested-source-type.
- Non-canonical edition: Mill citation with Penguin URL when config says toronto-cw → emitted.
- Snippet truncation at 200 chars.
- URL templating: archive.org-hosted entry → IA search URL; OLL-hosted → Liberty Fund search.

Coverage target: ≥ 80% line + branch for `src/worklist.ts`.

## New dependencies

None.
