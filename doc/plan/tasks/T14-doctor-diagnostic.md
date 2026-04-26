# T14 — `bibcheck doctor` diagnostic

**Phase:** 3 (Integration)
**Complexity:** small
**Depends on:** T01 (config), T05 (database clients — for connectivity checks)
**Blocks:** T15 (CLI)

## Scope

`bibcheck doctor` validates that the project's bibcheck setup is sound:

- `sources.json` (or wherever `Config.bibliography.file` points) exists and is valid CSL JSON.
- `bibcheck.toml` (if present) is valid.
- Optional external tools (`pandoc`) installed if features depending on them are enabled.
- Network access to configured databases is working.
- Node version satisfies the `engines.node` constraint.

This is the onboarding diagnostic — a first-time user runs `bibcheck doctor` to confirm the project is set up correctly before running `bibcheck check`.

## Files

- `src/doctor.ts` — `runDoctor` function.
- `test/doctor.test.ts` — unit tests.

## Interfaces

### Imports

- `./config.js` — `Config`.
- `./databases/index.js` — clients (for connectivity ping).
- `citation-js` — for CSL JSON validation.

### Exports

```ts
export interface DoctorDeps {
  config: Config;
  http: HttpClient;
  readFile: (path: string) => Promise<string>;
  cwd: string;
  nodeVersion: string;          // e.g., process.version
}

export type DoctorCheck =
  | { name: string; status: 'ok'; details?: string }
  | { name: string; status: 'warn'; details: string }
  | { name: string; status: 'fail'; details: string };

export interface RunDoctorResult {
  checks: DoctorCheck[];
  exitCode: 0 | 1;              // 0 if no fail; 1 if any fail
}

export async function runDoctor(deps: DoctorDeps): Promise<RunDoctorResult>;
```

## Checks

Run these in sequence (independent; can be parallelised but ordering aids readability):

1. **Node version**: parse `nodeVersion` and confirm ≥ 20. `fail` if not.
2. **Bibliography file exists**: `readFile(Config.bibliography.file)`. `fail` on ENOENT.
3. **Bibliography valid CSL JSON**: parse via `citation-js`. `fail` on parse error.
4. **`bibcheck.toml` valid** (if present): `loadConfig` will have already validated; this check is informational. `ok` if config object exists, `warn` if no toml file (using defaults).
5. **Phrase denylist file** (if configured): `readFile(Config.phrases.file)`. `warn` if missing — bibcheck still runs but the phrases subcommand will fail when invoked.
6. **Pandoc present** (informational): try `which pandoc` (or `node:child_process` with a try-catch). `ok` if found; `warn` if not (pandoc is optional).
7. **CrossRef connectivity** (if `Config.apis.crossref_mailto` is set, otherwise skip): `http.head('https://api.crossref.org/works')`. `ok` on 200, `warn` on network error.
8. **OpenAlex connectivity** (similar): `http.head('https://api.openalex.org/works')`.
9. **OpenLibrary connectivity**: `http.head('https://openlibrary.org/api/books')`.
10. **WorldCat connectivity** (only if API key configured): a GET to a known endpoint, `warn` if not.
11. **Cache directory writable**: try to write a probe file in the configured cache dir; `warn` if not writable. Report the path and available free space.
12. **Cache size**: report current cache size on disk. `warn` if the size is approaching `config.cache.max_size_mb`.

Each check returns a `DoctorCheck`. Exit code is `1` if any check returns `fail`, else `0`.

## Implementation notes

- **Output**: doctor's output is rendered by the same renderers as `check` (T12), but with a `Doctor` shape. Easier: doctor returns a structured result, and the CLI (T15) renders it as text — for v0.1, doctor doesn't need full schema integration.
- **Network checks should have short timeouts** (5s). Don't block onboarding for half a minute.
- **Don't fail-fast**: run all checks and report all results, even if early checks fail.
- **Secret safety**: API key values and polite-pool email addresses MUST NOT appear in any doctor output line. Doctor reports per-API status as `'ok'` / `'fail (HTTP <code>)'` / `'fail (network)'`. The request URL itself is NEVER printed (it would leak `?mailto=` or a key in the path).

## `--clear-cache` flag

`bibcheck doctor --clear-cache` clears the entire cache directory. Requires confirmation from the user unless `--yes` is also passed.

## Acceptance criteria

- [ ] All 12 checks implemented (or marked skipped explicitly).
- [ ] Each check's status reflects the underlying condition.
- [ ] Exit code 0 when no fail; 1 when any fail.
- [ ] Doctor doesn't depend on the bibliography being non-empty (works in a fresh project).
- [ ] Network-bound checks have short timeouts.
- [ ] Doctor never prints API key or polite-pool email.
- [ ] Doctor reports cache size + writability.
- [ ] `bibcheck doctor --clear-cache --yes` removes the cache directory contents.

## Tests

`test/doctor.test.ts`:

Mock dependencies (in-memory filesystem, mock HttpClient).

- All checks pass on a known-good fixture.
- `fail` on Node 18 (mock `nodeVersion: 'v18.0.0'`).
- `fail` on missing bibliography file.
- `fail` on malformed CSL JSON.
- `warn` on missing `bibcheck.toml`.
- `warn` on missing pandoc.
- `warn` on network errors for database checks.
- Exit code: 0 if no fail, 1 if any fail.

Coverage target: ≥ 80% line + branch for `src/doctor.ts`.

## New dependencies

None beyond what other tasks introduce.
