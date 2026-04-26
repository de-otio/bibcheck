# T12 — Output renderers (JSON, Markdown, SARIF, text)

**Phase:** 2b (Output)
**Complexity:** medium
**Depends on:** schema (already scaffolded)
**Blocks:** T13 (check uses output renderers), T15 (CLI uses output renderers)

## Scope

Four pure-function renderers that take a validated `Output` object and produce a string in the requested format.

## Files

- `src/output/json.ts` — JSON renderer.
- `src/output/markdown.ts` — human-readable Markdown.
- `src/output/sarif.ts` — SARIF for CI / PR-annotation.
- `src/output/text.ts` — compact text for CLI.
- `test/output.test.ts` — unit tests.

## Interfaces

### Imports

- `./schema/output.js` — `Output`, `OutputSchema`.

### Exports

```ts
export function renderJson(output: Output, opts?: { pretty?: boolean }): string;
export function renderMarkdown(output: Output): string;
export function renderSarif(output: Output): string;
export function renderText(output: Output): string;
```

All four are pure functions: same input → same output. No I/O, no environment-dependence, no time-dependence (don't include timestamps in renderer output unless the input already has them).

## Per-renderer notes

### JSON (`renderJson`)

- `JSON.stringify(output, null, opts?.pretty ? 2 : 0)`.
- Always validates the input through `OutputSchema.parse` first to guarantee output is on-contract.
- Pretty-printed by default for human inspection; minified when `pretty: false`.

### Markdown (`renderMarkdown`)

- Sectioned report:
  - `# bibcheck report`
  - `## Summary` — table of summary counts.
  - `## Bibliography entries` — table per entry showing existence + canonical status.
  - `## Linkage` — only show unresolved keys.
  - `## Phrase flags` — flagged matches with file:line, pattern key, optional reference URL.
  - `## Worklist` — grouped by type.
- Use markdown tables. Use `[file](path/to/file)` link syntax for file:line anchors so they're clickable in IDEs / GitHub.
- Empty sections include a "No findings." line rather than being omitted.

### SARIF (`renderSarif`)

Use `node-sarif-builder` to construct the SARIF document. Do NOT hand-roll the SARIF JSON structure.

SARIF 2.1.0 JSON schema. Reference: https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html

**Required `tool.driver` fields:**

- `tool.driver.name` = `'bibcheck'`
- `tool.driver.version` = package version (from `package.json`)
- `tool.driver.semanticVersion` = package version (same value; SARIF requires this field separately)
- `tool.driver.informationUri` = `'https://github.com/de-otio/bibcheck'`
- `tool.driver.rules[]` — one entry per rule:
  - `bibcheck/canonical/dead-url`
  - `bibcheck/canonical/wrong-host`
  - `bibcheck/linkage/unresolved`
  - `bibcheck/phrase/<patternKey>` (one rule per distinct pattern key encountered)
  - `bibcheck/existence/metadata-mismatch`
  - `bibcheck/existence/unverifiable`
  - Each rule entry includes `helpUri` pointing to `https://github.com/de-otio/bibcheck/blob/main/docs/output-schema.md#<anchor>`.

**Required `runs[]` fields:**

- `runs[].originalUriBaseIds` = `{ "PROJECTROOT": { "uri": "file:///$PROJECT_ROOT/" } }` so that `physicalLocation.artifactLocation.uri` values can be relative paths.
- `results[].partialFingerprints` — for deduplication. Use a stable hash of `{ ruleId, physicalLocation.uri, region.startLine, message.text }`.

**SARIF level mapping:**

- `phraseFlags` (lint-style) → `level: 'warning'`
- Hard violations (`dead-url`, `wrong-host`, `linkage unresolved`, `existence metadata-mismatch`) → `level: 'error'`
- Worklist items → NOT emitted as SARIF results. Worklist items are informational, not findings; including them as SARIF results would cause spurious CI failures and noise in PR annotations. They appear only in the JSON and Markdown renderers.

**SARIF message text:**

- `message.text` MUST be plain text. Strip any HTML or markdown formatting from bibliography fields (title, author, etc.) before insertion into SARIF message strings.

Rules are described in the `rules` array with a stable `id`, `shortDescription`, and `helpUri`. Output is a single SARIF JSON document rendered as a string.

### Text (`renderText`)

- Compact, single-line-per-finding output suitable for piping or quick inspection.
- Format: `<file>:<line>: <level>: <message>`.
- Levels: `error` / `warning` / `note`. Same mapping as SARIF.
- A summary line at the bottom: `<n> errors, <m> warnings, <k> notes`.

## Acceptance criteria

- [ ] `renderJson` produces output that round-trips through `OutputSchema.parse`.
- [ ] `renderMarkdown` produces well-formed markdown with all sections.
- [ ] `renderSarif` produces a SARIF 2.1.0 document that validates against the official SARIF JSON schema (validated using `ajv` + the published schema).
- [ ] `renderText` produces parseable line-per-finding output.
- [ ] Empty `Output` (no entries, no findings) renders cleanly in all four formats.
- [ ] All renderers are deterministic (same input → identical output).
- [ ] `originalUriBaseIds` is set; relative paths are used in `physicalLocation.artifactLocation.uri`.
- [ ] `partialFingerprints` are deterministic across runs (same input → same fingerprint).
- [ ] Phrase flags map to SARIF `level: 'warning'`; hard violations (`dead-url`, `wrong-host`, `linkage unresolved`, `existence metadata-mismatch`) map to `level: 'error'`; worklist items do not appear in SARIF output.

## Tests

`test/output.test.ts`:

- Round-trip test (JSON): a well-formed `Output` rendered via `renderJson` and parsed back via `OutputSchema.parse` produces the same object.
- Determinism: render the same input twice; assert byte-identical output for all four renderers.
- Markdown: snapshot test against a fixture-built `Output` with at least one finding per category.
- SARIF: render output, parse the result as JSON, verify it has the required SARIF top-level structure (`version`, `runs[].tool`, `runs[].results`). Optionally validate against the SARIF JSON schema (npm: `@microsoft/sarif-multitool` or hand-rolled minimal schema check).
- Text: format conforms to `<file>:<line>: <level>: <message>` regex; summary line correct.
- Empty output: each renderer produces a non-empty but minimal-finding output.

Coverage target: ≥ 80% line + branch for `src/output/**/*.ts`.

## New dependencies

- `node-sarif-builder` — required runtime dependency for the SARIF renderer. Replaces any hand-rolled SARIF JSON construction.
- `ajv` — devDependency, for validating SARIF output against the official 2.1.0 JSON schema in tests.
