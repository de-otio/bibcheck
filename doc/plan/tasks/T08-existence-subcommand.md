# T08 — `bibcheck existence` subcommand

**Phase:** 2b (Subcommand modules)
**Complexity:** medium
**Depends on:** T05 (database clients)
**Blocks:** T13 (check orchestrator), T15 (CLI)

## Scope

Implement the `existence` subcommand: thin commodity-layer existence check against CrossRef, OpenAlex, OpenLibrary, and (optionally) WorldCat. Per the design, this is the *commodity convenience layer*, not a competitive feature — for richer needs, defer to dedicated tools.

## Files

- `src/existence.ts` — `runExistence` function.
- `test/existence.test.ts` — unit tests.

## Interfaces

### Imports

- `./databases/index.js` — the four database clients from T05.
- `./schema/output.js` — `ExistenceLayer`, `ExistenceCheck`, `ExistenceStatus`.
- `./config.js` — `Config`.
- `citation-js` (new dependency — confirm before adding) — for parsing the CSL JSON bibliography.

### Exports

```ts
export interface RunExistenceDeps {
  config: Config;
  bibliography: CslEntry[];    // already-parsed CSL JSON
  clients: {
    crossref: CrossRefClient;
    openalex: OpenAlexClient;
    openlibrary: OpenLibraryClient;
    worldcat?: WorldCatClient;     // optional; missing if no API key
  };
}

export interface RunExistenceResult {
  entries: Array<{
    citekey: string;
    existence: ExistenceLayer;
  }>;
}

export async function runExistence(deps: RunExistenceDeps): Promise<RunExistenceResult>;

// Type for CSL entry (subset; loosely typed since CSL has many optional fields)
export interface CslEntry {
  id: string;
  type?: string;
  DOI?: string;
  ISBN?: string;
  title?: string;
  author?: Array<{ family?: string; given?: string; literal?: string }>;
  issued?: { 'date-parts'?: number[][] };
  // many other optional fields...
}
```

## Algorithm

For each bibliography entry:

1. **DOI route**: if `entry.DOI` is set:
   - Call `clients.crossref.lookupByDoi(entry.DOI)`.
   - If `found: true`: compare metadata (title fuzzy match + first-author surname match). If mismatch within tolerance → `metadata-mismatch`. If match → `verified`. Add `ExistenceCheck` for crossref.
   - If `found: false`: add `ExistenceCheck` with `not-found`. Status → `not-found-in-databases` if no other route succeeds.

2. **ISBN route**: else if `entry.ISBN` is set:
   - Call `clients.openlibrary.lookupByIsbn(entry.ISBN)`.
   - If `found: true`: compare metadata. Status accordingly.
   - If `found: false`: try `clients.worldcat?.lookupByIsbn(entry.ISBN)` if available.
   - Add `ExistenceCheck` for each tried backend.

3. **Title-search route**: else if `entry.title` is set:
   - Call `clients.openalex.searchByTitleAuthor(entry.title, authors)`.
   - If `found: true`: compare. Status accordingly.
   - If `found: false`: status `not-found-in-databases`.

4. **No identifier**: if entry has no DOI, ISBN, or title, status is `unverifiable`. Add a single `ExistenceCheck` with `result: 'no-doi'` indicating nothing was tried. (Note: `'no-isbn'` is not a separate status — it has been removed from the schema in Wave 0.12.)

The existence-check status semantics:

- `verified` — at least one backend returned `found: true` with matching metadata.
- `metadata-mismatch` — backend returned `found: true` but metadata differs from bibliography entry.
- `not-found-in-databases` — all attempted backends returned `found: false`.
- `unverifiable` — no backend was applicable; entry has no usable identifier or title; OR all retries against every applicable database exhausted (see retry-exhaustion rule below).

Note: `'no-isbn'` is NOT a valid status — it has been removed from the schema in Wave 0.12.

### Retry-exhaustion and graceful degradation

When T05's `HttpClient` signals retries-exhausted for a given database source, the result for THAT source is `result: 'error'` with `evidence: { error: HttpError.message }` (sanitized — strip any API key or mailto before recording). If ALL sources for an entry exhaust retries without a successful response, the entry's `ExistenceLayer.status` becomes `'unverifiable'`, NOT `'not-found-in-databases'`.

**Graceful degradation**: if only some sources fail (e.g., CrossRef errors but OpenLibrary succeeds), the entry's status reflects the best successful source. The CrossRef error is logged but does not abort the per-entry check. Per-host concurrency limits and retry policy are owned by T06 (HttpClient) — T08 inherits them transparently.

## Metadata mismatch tolerance

For "same work?" comparison:

- **Title**: case-insensitive Levenshtein-distance / 2 ≤ 25% of length, OR token-set fuzzy match. (Implementer's choice; document the rule.)
- **First author**: surname comparison case-insensitive; tolerate "von Habermas" / "Habermas" prefix variation.
- **Year**: if both are present and differ by more than 1 (translation cases — German + English year), flag as mismatch.

These tolerances are deliberately lenient — humanities databases have notorious metadata slop (CrossRef especially). False-mismatch is more annoying than false-match, since the user is reviewing the worklist anyway.

A small fuzzy-match library (`fastest-levenshtein` or hand-rolled) is fine. Confirm new dep before adding.

## Implementation notes

- **Concurrency**: limit to 4 in-flight database calls at once. Use `p-queue` or a hand-rolled limiter (`p-queue` is lightweight; confirm before adding).
- **AbortSignal**: pass through.
- **Cache**: clients already cache; `existence` doesn't need its own cache layer.
- **Error handling**: per-entry errors (e.g., one entry's CrossRef call fails) should not abort the whole run. Catch and emit an `ExistenceCheck` with `result: 'error'`; status `unverifiable` with a noted error.

## Acceptance criteria

- [ ] DOI route hits CrossRef.
- [ ] ISBN route hits OpenLibrary, then WorldCat if first fails and key present.
- [ ] Title-only route hits OpenAlex.
- [ ] Status transitions are correct per the table above.
- [ ] Metadata mismatch tolerance is documented and tested.
- [ ] Per-entry errors don't abort the run.
- [ ] Concurrency is bounded to 4 (or configurable).
- [ ] Per-entry CrossRef 503-then-503-then-503 → entry's `existence.status = 'unverifiable'`, `existence.checks` contains a `result: 'error'` entry, run continues to next entry.
- [ ] Per-entry: CrossRef errors but OpenLibrary returns found → entry's `existence.status = 'verified'` (best source wins).

## Tests

`test/existence.test.ts`:

Use mocked database clients (vi.fn-based stubs that return canned `DatabaseLookupResult`s).

- DOI entry, CrossRef found+match → `verified`.
- DOI entry, CrossRef found+mismatch → `metadata-mismatch`.
- DOI entry, CrossRef not found → `not-found-in-databases`.
- ISBN entry, OpenLibrary found → `verified`.
- ISBN entry, OpenLibrary not found, WorldCat present and found → `verified`.
- ISBN entry, both fail → `not-found-in-databases`.
- Title-only entry, OpenAlex found → `verified`.
- No-identifier entry → `unverifiable`.
- Mixed bibliography (10 entries spanning all routes) → correct aggregate.
- Per-entry CrossRef throws → that entry's `result: 'error'`, others succeed.
- Title fuzzy-match passes (tolerance test): "Strukturwandel der Öffentlichkeit" ↔ "strukturwandel der oeffentlichkeit" matches.
- Year-mismatch detection.

Coverage target: ≥ 80% line + branch for `src/existence.ts`.

## New dependencies to confirm

- `citation-js` — CSL JSON parser.
- `p-queue` — concurrency limiter (or hand-roll).
- `fastest-levenshtein` — fuzzy string match (or hand-roll).
