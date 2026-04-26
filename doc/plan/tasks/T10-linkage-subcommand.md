# T10 — `bibcheck linkage` subcommand

**Phase:** 2b (Subcommand modules)
**Complexity:** small
**Depends on:** T03 (markdown utilities)
**Blocks:** T13 (check orchestrator), T15 (CLI)

## Scope

Implement the `linkage` subcommand: verify that every `@citekey` reference in the markdown documents resolves to an entry in the bibliography. Surface unresolved keys with `file:line` anchors.

This is the deterministic CI-time equivalent of `pandoc --citeproc`'s render-time warning.

## Files

- `src/linkage.ts` — `runLinkage` function.
- `test/linkage.test.ts` — unit tests.

## Interfaces

### Imports

- `./markdown/citekeys.js` — `extractCitekeys`, `CitekeyReference` from T03.
- `./markdown/glob.js` — `findFiles` from T03.
- `./schema/output.js` — `LinkageEntry`, `LinkageReference`, `LinkageStatus`.
- `./config.js` — `Config`.

### Exports

```ts
export interface RunLinkageDeps {
  config: Config;
  bibliography: CslEntry[];      // already-parsed CSL JSON
  readFile: (path: string) => Promise<string>;
  cwd: string;
}

export interface RunLinkageResult {
  linkage: LinkageEntry[];
}

export async function runLinkage(deps: RunLinkageDeps): Promise<RunLinkageResult>;
```

## Algorithm

1. Build a `Set<string>` of citekeys from the bibliography (`bibliography.map(e => e.id)`).
2. For each markdown file matching `Config.docs.include` (minus excludes):
   - Read content via `readFile`.
   - Call `extractCitekeys(filePath, content)` (T03) → `CitekeyReference[]`.
3. Aggregate references per unique citekey (across all files).
4. For each citekey that appears in any reference, emit a `LinkageEntry`:
   - `status: 'resolved'` if the citekey is in the bibliography Set.
   - `status: 'unresolved'` otherwise.
   - `references`: array of `{ file, line }` for every occurrence.

## Implementation notes

- **Prose-line walking**: use T03's `extractProseLines(content)` to walk markdown text outside code blocks. Then apply a citekey regex (`@[a-zA-Z0-9_:-]+`) to each prose line. Citekeys inside code blocks (e.g., inside a literal markdown example) are NOT counted as references — T03's helper handles this exclusion automatically.
- **Bibliography keys**: a citekey in markdown is `@key`. The corresponding bibliography entry has `id: 'key'` (no `@` prefix). Strip the `@` when comparing.
- **Reference deduplication**: if the same citekey appears multiple times on the same line, keep all occurrences (each is a separate `LinkageReference`). Don't deduplicate within a line.
- **Path normalisation**: `LinkageReference.file` is relative to `cwd`.
- **`--via-pandoc` flag**: out of scope for v0.1 to actually delegate to pandoc; document that the flag is reserved but not implemented.

## Acceptance criteria

- [ ] All resolved citekeys return `status: 'resolved'`.
- [ ] All unresolved citekeys return `status: 'unresolved'` with file:line anchors.
- [ ] Multiple references to the same citekey aggregate into one `LinkageEntry` with multiple `references`.
- [ ] Citekeys that exist in the bibliography but are never referenced in docs are NOT emitted (linkage tracks references, not bibliography coverage).
- [ ] File paths are relative to `cwd`.
- [ ] Citekey `@example` inside a fenced code block is NOT counted as a reference.
- [ ] Multiple citekeys on one line each get their own `LinkageReference` entry.

## Tests

`test/linkage.test.ts`:

- Single file, single citekey, resolved.
- Single file, single citekey, unresolved.
- Multiple files referencing the same citekey: one aggregate `LinkageEntry`.
- Mixed: some resolved, some unresolved.
- Empty docs directory: empty `linkage` array.
- Empty bibliography + non-empty docs: all citekeys unresolved.
- Citekey occurs multiple times on the same line: multiple `references` entries.
- Citekey inside a code block: NOT counted (this is T03's responsibility but worth a smoke test here).

Coverage target: ≥ 80% line + branch for `src/linkage.ts`.

## New dependencies

None.
