# T25 — Citation-parser swap to `@benrbray/remark-cite`

**Phase:** 5 (Hallucination-hardening)
**Complexity:** medium
**Depends on:** T20 (schema — locator fields)
**Blocks:** T26 (docs)

## Scope

Replace the hand-rolled, line-regex citekey extractor with a real Pandoc-citation
parser. The current extractor (`src/markdown/citekeys.ts`) runs `CITEKEY_RE` over
raw prose lines and is structurally incapable of representing the Pandoc citation
grammar: it loses **locators** (`[@key, pp. 33-35]`), collapses **multiple keys
per bracket** (`[@a; @b]`), and silently normalizes **author-suppression**
(`-@key`) to a bare key. For a tool that markets itself as a Pandoc-citeproc-style
linkage checker — and that needs reliable locators for the worklist's page-ref
items — this is the load-bearing gap. Adopt `@benrbray/remark-cite`, an mdast
plugin that drops into the existing `unified` + `remark-parse` pipeline.

## Files

- `src/markdown/citekeys.ts` — reimplement on top of the remark-cite AST.
- `src/linkage.ts` — consume the richer reference records (locator, suppression).
- `src/worklist.ts` — use parsed locators for `paraphrase-with-page-ref` items.
- `test/markdown.test.ts`, `test/linkage.test.ts`, `test/worklist.test.ts`.
- `package.json` — add `@benrbray/remark-cite` (+ its peer, if any).

## Interfaces

Extend the extracted reference to carry the new structure (schema fields defined
in T20):

```ts
export interface CitekeyReference {
  citekey: string;
  file: string;
  line: number;
  locator: string | null;        // 'p. 42', 'pp. 33-35', etc.
  authorSuppressed: boolean;     // true for -@key
}

export function extractCitekeys(opts: {
  markdown: string;
  file: string;
}): CitekeyReference[];
```

Each key within a multi-key bracket yields its own `CitekeyReference` (so
`[@a; @b, p. 5]` → two records, with the locator attached to `@b`). Line numbers
come from the mdast node `position`.

## Implementation notes

- Run remark-cite in the existing unified pipeline; walk `cite` nodes and their
  `citeItems` (each has `key`, optional `suffix`/`locator`, and a
  suppress-author marker).
- Preserve the current public surface of `extractCitekeys` where possible so the
  blast radius in `linkage.ts` / `worklist.ts` is small; additive fields only.
- **Determinism**: emit references in document order (by node position), and have
  `linkage`/`worklist` apply stable secondary sorts (citekey, then file/line) —
  pairs with the worklist-ordering fix (02-should-fix S4).
- Locator parsing: remark-cite gives the raw suffix; extract the locator portion
  (strip leading punctuation/label) into `locator`. Don't over-engineer page-range
  *validation* here — that's roadmap R1; T25 only surfaces the locator string.

## Acceptance criteria

- [ ] `[@a; @b]` yields two references; `[@a, p. 5]` attaches `locator: 'p. 5'`.
- [ ] `-@key` sets `authorSuppressed: true` and still resolves linkage.
- [ ] Locators flow into worklist `paraphrase-with-page-ref` items and the `locator` schema field.
- [ ] Existing linkage behaviour (resolved/unresolved, file:line) is preserved for simple `@key` cases.
- [ ] Reference ordering is deterministic across runs.
- [ ] No remaining use of the old line-regex extractor for citation parsing.

## Tests

`test/markdown.test.ts`:
- Single key, multi-key bracket, locator, author-suppression, prefix/suffix text.
- A key adjacent to punctuation / inside prose (`(see [@x]).`).
- Code spans / fenced code are NOT scanned for citekeys (remark gives this for free — assert it).
- Document-order determinism.

Coverage ≥ 80% for changed modules.

## New dependencies to confirm

- `@benrbray/remark-cite` (mdast citation plugin).
