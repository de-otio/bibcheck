# T22 — Existence overhaul (evidence, not-found gating, WorldCat removal)

**Phase:** 5 (Hallucination-hardening)
**Complexity:** medium
**Depends on:** T20 (schema), T21 (identifiers)
**Blocks:** T23 (suppression & gating)

## Scope

Bring the existence path up to the primary goal. Three coupled changes:

1. **Emit the evidence vocabulary** (`evidence`, `checkedFor`, `notCheckedFor`,
   `error`) from T20 alongside the existing `status`.
2. **Count and gate `not-found-in-databases`** — fix B1, the silent-pass bug.
3. **Remove WorldCat** — the dead OCLC Classify source (see
   [`../../tmp/design-review/worldcat.md`](../../tmp/design-review/worldcat.md)).

Also: skip the network existence call entirely when T21 has flagged the
identifier `malformed`/`bad-checksum` (a malformed id can't be looked up, and is
already a gating finding) — record `evidence: 'unverifiable'`,
`status: 'unverifiable'`, with a note that identifier validation failed.

## Files

- `src/existence.ts` — `runExistence` (extend).
- `src/check.ts` — orchestrator: summary counting + exit-reason gating.
- `src/databases/worldcat.ts` — **delete**.
- `src/databases/index.ts` — drop the WorldCat barrel export.
- `src/doctor.ts` — drop the `worldcat-connectivity` check.
- `docs/configuration.md` — remove WorldCat references (or defer to T26).
- `test/existence.test.ts`, `test/check.test.ts`, `test/doctor.test.ts` — update.

## Changes

### Evidence mapping

Map the existing status to the new evidence vocabulary:

| status | evidence | checkedFor | notCheckedFor |
|---|---|---|---|
| `verified` | `exists-metadata-match` | `['existence','metadata']` | `['claim-support']` |
| `metadata-mismatch` | `exists-metadata-mismatch` | `['existence','metadata']` | `['claim-support']` |
| `not-found-in-databases` | `absent` | `['existence']` | `['claim-support']` |
| `unverifiable` | `unverifiable` | `[]` | `['existence','metadata','claim-support']` |

`notCheckedFor` always includes `claim-support`. When a source errors, set
`error` to the sanitized message (strip mailto/API key — reuse `sanitizeMailto`).

### Not-found counting + gating (B1)

- `check.ts` summary: increment `notFoundInDatabases` for each entry whose
  existence `status === 'not-found-in-databases'`; ensure the four existence
  buckets sum to `totalEntries` (matches the T20 invariant).
- `checkExitReasons`: **`not-found-in-databases` and `malformedIdentifiers` are
  build-gating by default.** A fabricated/malformed DOI now fails `bibcheck check`
  (exit 1). The actual gate is mediated by T23's suppression/source-type rules —
  T22 makes them gate; T23 makes the exemptions possible. Until T23 lands, gate
  unconditionally.

### WorldCat removal

- Delete `worldcat.ts`; remove from `RunExistenceDeps.clients` (drop the optional
  `worldcat?` field) and from the ISBN route (OpenLibrary is the ISBN source).
- Remove `worldcat-connectivity` from `doctor.ts`.
- Remove `[apis].worldcat_*` config references from docs (T26 may finalize docs).

### Title metric (H3, recommended within this ticket)

Replace raw Levenshtein title comparison with a **token-set ratio** (or
Jaro-Winkler) so reordered words / subtitle presence don't cause false
`metadata-mismatch`. Keep Levenshtein as a tiebreaker. If pulling a library
(`talisman`/`string-comparison`), confirm the dep. Tune against fixtures.

## Acceptance criteria

- [ ] Every `ExistenceLayer` carries `evidence`, `checkedFor`, `notCheckedFor`; `notCheckedFor` always includes `claim-support`.
- [ ] An entry with a fabricated DOI (CrossRef not-found) → `status: not-found-in-databases`, counted in `summary.notFoundInDatabases`, and `bibcheck check` exits **1**.
- [ ] A `malformed`/`bad-checksum` identifier (from T21) skips the network call and is gating.
- [ ] `worldcat` is gone from source code, doctor, and the source enum; ISBN entries verify via OpenLibrary.
- [ ] Title comparison no longer false-mismatches on subtitle/word-order (fixture test).
- [ ] Sanitized `error` field populated on source errors; no mailto/key leaks into output.

## Tests

- DOI not-found → `absent` evidence, counted, exit 1.
- malformed ISBN (T21) → existence skipped, `unverifiable`, gating.
- ISBN verified via OpenLibrary with WorldCat absent from the client set.
- Token-set title match: "Liberty" ↔ "Liberty: A Study" no longer mismatches.
- `summary` existence buckets sum to `totalEntries` (reconciliation).
- Coverage ≥ 80% for changed modules.
