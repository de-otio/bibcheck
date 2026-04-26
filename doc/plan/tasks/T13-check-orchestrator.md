# T13 — `bibcheck check` orchestrator

**Phase:** 3 (Integration)
**Complexity:** medium
**Depends on:** T07–T12 (all subcommand modules + output renderers), T01 (config), T02 (cache), T05 (database clients), T06 (HTTP)
**Blocks:** T15 (CLI), T16 (integration tests)

## Scope

The orchestrator that runs all five subcommands and assembles the top-level `Output`. This is the entry point used by `bibcheck check` (the CI build-gate command).

## Files

- `src/check.ts` — `runCheck` function and the dependency-construction helper.
- `test/check.test.ts` — unit tests; integration tests are T16's responsibility.

## Interfaces

### Imports

- All five subcommand `run*` functions.
- `./schema/output.js` — `Output`, `OutputSchema`.
- `./config.js` — `Config`.
- `./databases/index.js` — clients.
- `./http.js`, `./cache/fs-cache.js`, `./phrases/load.js` — utilities.
- `citation-js` — bibliography parsing.

### Exports

```ts
export interface RunCheckDeps {
  config: Config;
  bibliography: CslEntry[];       // loaded + Zod-validated CSL JSON
  http: HttpClient;
  cache: Cache;
  logger: Logger;
  cwd: string;
  signal: AbortSignal;
}

export interface RunCheckOptions {
  skip?: Array<'canonical' | 'phrases' | 'linkage' | 'worklist' | 'existence'>;
}

export async function runCheck(deps: RunCheckDeps, opts?: RunCheckOptions): Promise<Output>;

// Helper for the CLI to construct deps from a Config + flags (see §buildCheckDeps spec)
export function buildCheckDeps(opts: {
  config: Config;
  cwd: string;
  signal: AbortSignal;
  logger: Logger;
}): RunCheckDeps;
```

## Exit-code rule

`bibcheck check` exits non-zero iff **any** of the following conditions hold:

- Any `phraseFlags[].status === 'flagged'` (without `bibcheck-allow` acknowledgement).
- Any `linkage[].status === 'unresolved'`.
- Any entry's `canonical.status` ∈ `{'dead-url', 'wrong-host', 'no-url-on-pre-doi-entry', 'live-url-not-archived-snapshot'}`.
- Any entry's `existence.status === 'metadata-mismatch'`.

Items that do **NOT** cause non-zero exit:

- Worklist items.
- `acknowledged` phrases.
- `unverifiable` existence (graceful degradation).

## buildCheckDeps spec

```ts
export function buildCheckDeps(opts: {
  config: Config;
  cwd: string;
  signal: AbortSignal;
  logger: Logger;
}): RunCheckDeps;
```

Returns a `RunCheckDeps` containing: `config`, `bibliography` (loaded + Zod-validated CSL JSON), `http` (HttpClient with retries + concurrency), `cache` (FsCache), `logger`, and `signal`. T15 calls this once per invocation.

The `bibliography` field is loaded and validated here so that all subcommands receive a pre-validated array; each subcommand does not re-read the file.

## Algorithm

1. **Load bibliography**: read `Config.bibliography.file` via `readFile`, parse via `citation-js`, get `CslEntry[]`. Validate: bibliography file exists, valid JSON, valid CSL.
2. **Load phrase denylist**: `loadDenylist({ path: Config.phrases.file })`. Returns `[]` when no file is configured; the phrases subcommand handles the empty-patterns case.
3. **Construct database clients**: each client gets the shared `http`, `cache`, and the relevant polite-pool `mailto` from config.
4. **Run subcommands in parallel** (where possible):
   - `runCanonical`, `runExistence`, `runLinkage`, `runPhrases`, `runWorklist` are all independent. Run with `Promise.all`.
   - Some may be skipped per `opts.skip`.
5. **Aggregate results**:
   - Merge `existence` and `canonical` per-citekey results into the `Entry[]` array (one entry per citekey, with both fields).
   - `linkage` becomes the top-level `linkage` array.
   - `phrases.flags` becomes `phraseFlags`.
   - `worklist.worklist` becomes `worklist`.
6. **Compute summary** using the rules below:
   - `summary.totalEntries` = `bibliography.length`
   - `summary.verified` = entries with `existence.status === 'verified'` AND (entry.canonical is null OR `canonical.status === 'verified-canonical'` OR `canonical.status === 'not-applicable'`)
   - `summary.metadataMismatches` = entries with `existence.status === 'metadata-mismatch'`
   - `summary.unverifiable` = entries with `existence.status === 'unverifiable'`
   - `summary.canonicalIssues` = entries with `canonical.status` ∈ `{'wrong-host', 'dead-url', 'live-url-not-archived-snapshot', 'no-url-on-pre-doi-entry'}`
   - `summary.linkageFailures` = `linkage.filter(l => l.status === 'unresolved').length`
   - `summary.phraseFlags` = `phraseFlags.filter(f => f.status === 'flagged').length` (NOT including acknowledged)
   - `summary.worklistItems` = `worklist.length`
7. **Construct Output**: top-level object including `schemaVersion`, `tool`, `summary`, `entries`, `linkage`, `phraseFlags`, `worklist`.
8. **Validate against schema**: `OutputSchema.parse(output)` — guarantees the orchestrator's own output is on-contract. This is a runtime self-check; if it ever fails, that's a bibcheck bug.
9. **Return** the validated `Output`.

## Implementation notes

- **Skip flag**: useful for partial runs (`bibcheck check --skip existence`) when a user wants to run without network. The CLI exposes this as a flag.
- **AbortSignal**: pass through to all subcommands. `Promise.all` with abort needs care; on abort, all in-flight subcommands cancel.
- **Per-subcommand timeout**: `runCheck` enforces a per-subcommand deadline of **5 minutes**. If a subcommand throws or AbortError-rejects, log the error and emit a structured error indicator in its layer (e.g. `existence: { status: 'unverifiable', error: ... }`). The run continues with all remaining subcommands.
- **Per-subcommand errors**: catch-and-return rather than abort the whole check. If `runCanonical` throws, log and emit empty canonical results with an error indicator. Document this behaviour in the function-level docs.
- **`buildCheckDeps`**: factored separately so tests can construct mock deps cleanly without the CLI in the loop. The signature is `buildCheckDeps(opts: { config: Config; cwd: string; signal: AbortSignal; logger: Logger })` returning `RunCheckDeps`; T15 calls this once per invocation.

## Acceptance criteria

- [ ] `runCheck` returns a validated `Output` object.
- [ ] Subcommands run in parallel.
- [ ] `opts.skip` correctly omits subcommands.
- [ ] Aggregation: `Entry[]` correctly merges `existence` and `canonical` per citekey.
- [ ] Summary fields match the rules above (verified by snapshot test on fixtures).
- [ ] Output passes `OutputSchema.parse`.
- [ ] AbortSignal cancels in-flight subcommands.
- [ ] Per-subcommand errors don't abort the whole run.
- [ ] Exit-code rule matches Wave 0.9 (verified by integration tests against known-bad fixture).
- [ ] Per-subcommand timeout: a subcommand that hangs > 5 minutes is aborted; other subcommands still run.
- [ ] Subcommand error → corresponding layer has `error`-flavored output; run continues.

## Tests

`test/check.test.ts`:

Use mocked dependencies: an in-memory cache, a mock HttpClient, a mock filesystem.

- Minimal bibliography + minimal docs → empty findings, summary all zeros.
- Realistic bibliography + docs → output passes `OutputSchema.parse`.
- Skip canonical → no canonical findings; other subcommands run.
- Skip existence → no existence findings.
- Subcommand throws → catch-and-emit; other subcommands still run.
- AbortSignal: caller aborts; in-flight subcommands cancel; runCheck rejects with AbortError.
- Aggregation: bibliography entry with both DOI and pre-DOI URL → `Entry` has both `existence` and `canonical` populated.
- Summary counts: assert that each summary field equals the actual array length / status count.

End-to-end integration tests (running the built CLI against fixtures) are T16's responsibility, not this task.

Coverage target: ≥ 80% line + branch for `src/check.ts`.

## New dependencies

None beyond what subcommand tasks introduce.
