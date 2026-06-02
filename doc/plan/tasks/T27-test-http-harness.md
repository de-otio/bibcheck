# T27 — Hermetic test HTTP harness, configurable endpoints, remove `--offline`

**Phase:** 5 (Hallucination-hardening)
**Complexity:** high
**Depends on:** —  (Wave 0 foundation; runs parallel to T20)
**Blocks:** T22 (its integration tests use this harness), T25, T26
**Supersedes:** T24

## Why

Decision Q3 removes offline mode and requires a network connection. But
`--offline` is the backbone of integration-test determinism — ~20 invocations in
`test/integration/check.test.ts` use it so network-bound checks (`existence`,
`canonical`, `check`) run without hitting CrossRef/OpenAlex. Removing the flag
without a replacement would either make the suite hit the real network (flaky)
or delete real coverage. This ticket builds the replacement: a **hermetic
localhost stub** the CLI can be pointed at via **configurable endpoint base
URLs**, then removes `--offline`.

This is the seam that makes the rest of Phase 5 testable — e.g. T22 asserting a
fabricated DOI yields exit 1 requires controlling what the API "returns."

## Files (owned)

- `src/config.ts` — add `[apis]` base-URL fields (additive; do NOT touch
  `[source_types]`, owned by T23).
- `src/databases/crossref.ts`, `openalex.ts`, `openlibrary.ts` — read base URL
  from config instead of hardcoding. (Do **not** touch `worldcat.ts`/`index.ts`
  beyond what compiles — T22 deletes WorldCat.)
- `src/doctor.ts` — connectivity-check URLs from config; remove the `offline`
  field + branch (the earlier session fix).
- `src/cli.ts` — remove `--offline` flag and all `offline` plumbing.
- `src/check.ts` — remove offline plumbing (`makeOfflineHttp`, `deps.offline`,
  `effectiveHttp`). Network-bound subcommands always use the real `http`.
- `test/helpers/stub-server.ts` — **new**: localhost HTTP stub.
- `test/integration/check.test.ts`, `test/integration/cli.test.ts`,
  `test/check.test.ts`, `test/cli.test.ts` — migrate off `--offline`.
- `test/fixtures/known-bad/.bibcheck-cache/cache.json` — delete (stale
  "offline mode" cache entry) or regenerate.

> Coordination: T27 edits `config.ts`, `check.ts`, the three live DB clients, and
> `doctor.ts`. T22 (Wave 2) and T23 (Wave 3) rebase on the merged T27 result.
> Touch only the files above; if you need another, stop and surface it.

## Work

### 1. Configurable endpoints
Add optional config under `[apis]`, defaulting to the real public URLs:
```toml
[apis]
crossref_base   = "https://api.crossref.org"
openalex_base   = "https://api.openalex.org"
openlibrary_base = "https://openlibrary.org"
```
Doctor connectivity targets derive from the same config. Keep existing
`crossref_mailto` / key handling. Database clients build request URLs from the
configured base. Validate as URLs in the Zod config schema.

### 2. Remove `--offline`, require network
- Delete the flag from `addGlobalOptions` and every `offline:` pass-through.
- Delete the offline HTTP-blocking path in `check.ts` and the `offline` field on
  doctor deps + its branch.
- **Transport failure ≠ not-found.** When a network-bound request fails because
  the network/host is unreachable (DNS/connect error), surface it as a clear
  error (existing `error` result / a top-level actionable message), NOT as a
  silent `unverifiable` pass and NOT as `not-found-in-databases`. (T22 owns the
  gating semantics; T27 just must not mask transport failure as success.)

### 3. Stub server helper
`test/helpers/stub-server.ts`: start an `http.createServer` on an ephemeral
localhost port; register canned responses per path (CrossRef `/works/...`,
OpenAlex `/works?...`, OpenLibrary `/api/books?...`); return JSON. Provide a
helper that writes a `bibcheck.toml` (or extends the fixture config) pointing the
`*_base` URLs at `http://localhost:<port>`. Tear down after each test.

### 4. Migrate tests off `--offline`
- Integration `check`/`doctor` tests: drive via the stub server; choose canned
  responses that **preserve current pass/fail outcomes** (e.g. stub returns a
  matching record for the good fixture so `check` still exits 0). Do not encode
  new gating semantics — that's T22; just keep the suite green and deterministic.
- `test/check.test.ts` offline-mode unit tests: remove (offline mode is gone) or
  re-express as "network-bound subcommand uses injected http".
- `test/cli.test.ts` / `test/integration/cli.test.ts`: assert `--offline` is
  **not** a recognized option (replaces the old "has --offline option" tests).
- Remove the stale offline cache fixture.

## Acceptance criteria

- [ ] `[apis] *_base` configurable; DB clients + doctor honor it; defaults are the real URLs.
- [ ] `--offline` is gone from code, `--help`, and docs-in-scope; invoking it errors as unknown option.
- [ ] Network/transport failure produces a clear error, never a silent pass.
- [ ] `test/helpers/stub-server.ts` exists and is used by the migrated integration tests; **no migrated test makes a real outbound request** (verifiable: tests pass with networking disabled).
- [ ] Full suite green and deterministic; the previously-flaky doctor connectivity test is stable.
- [ ] Coverage ≥ 80% line+branch on every changed `src/` module.

## Tests

- Stub-backed `check` against the good fixture → exit 0; against a fixture the
  stub reports problems for → exit 1 (placeholder; T22 refines).
- Doctor connectivity against the stub → `ok`; against a stub that refuses
  connections → `fail`, deterministic, fast (< 1s).
- `--offline` unknown-option assertion.
- Config: `*_base` override parsed and used; invalid base URL rejected.
