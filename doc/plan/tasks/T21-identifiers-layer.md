# T21 — Identifiers layer (local DOI / ISBN / URL validation)

**Phase:** 5 (Hallucination-hardening)
**Complexity:** low–medium
**Depends on:** T20 (schema)
**Blocks:** T22 (existence overhaul), T23 (gating)

## Scope

A pure, offline, pre-network validation pass over each bibliography entry's
identifiers. Catches the large class of AI-fabricated citations that carry a
*malformed* identifier (transposed ISBN digits, a DOI with stray punctuation, a
non-URL in `url:`) **before** any network call — the cheapest, highest-yield
hallucination signal. Emits the `IdentifiersLayer` defined in T20.

This is a functional-core module: no I/O, all inputs as arguments, fully
unit-testable without mocks.

## Files

- `src/identifiers.ts` — `runIdentifiers` + the pure validators.
- `test/identifiers.test.ts` — unit tests (property-based where the domain allows).

## Interfaces

```ts
import type { CslEntry } from './existence.js';
import type { IdentifiersLayer } from './schema/output.js';

export interface RunIdentifiersDeps {
  bibliography: CslEntry[];
}

export interface RunIdentifiersResult {
  entries: Array<{ citekey: string; identifiers: IdentifiersLayer }>;
}

export function runIdentifiers(deps: RunIdentifiersDeps): RunIdentifiersResult;

// Pure validators (exported for direct testing and reuse):
export function validateDoi(doi: string): 'ok' | 'malformed';
export function validateIsbn(isbn: string): 'ok' | 'bad-checksum' | 'malformed';
export function validateUrl(url: string): 'ok' | 'malformed';
```

## Algorithm

Per entry, produce one `IdentifiersLayer`:

- **DOI** — if `entry.DOI` present: test against `^10\.\d{4,}/\S+$` (case-insensitive,
  after trimming a leading `https://doi.org/` or `doi:` prefix). Pass → `ok`,
  fail → `malformed`. Absent → `not-applicable`.
- **ISBN** — if `entry.ISBN` present: strip hyphens/spaces; if length/shape isn't a
  valid ISBN-10 or ISBN-13 → `malformed`; if shape is right but the **check digit**
  fails → `bad-checksum`; else `ok`. Use `isbn3` (new dep — see below) for parsing,
  normalization, and check-digit validation. Absent → `not-applicable`.
- **URL** — if `entry.url` present (note: CSL uses `URL`): parse with `new URL()`;
  reject non-`http(s)` schemes and unparseable strings → `malformed`; else `ok`.
  Absent → `not-applicable`.

`runIdentifiers` is synchronous and deterministic. Entry output order matches
input order.

## Implementation notes

- **Pure & immutable**: no network, no fs, no clock. This is the functional core.
- **Normalization side-benefit**: `isbn3` normalizes ISBN-10↔13 and hyphenation.
  Expose the normalized form (e.g. via a returned canonical ISBN) so T22 can key
  the existence cache on it and fix the ISBN cache-mismatch nit (03-nits N-ISBN).
  Keep the layer's *status* output stable regardless; pass normalization to T22
  through a separate return field or a shared helper — coordinate at the seam.
- A `malformed` / `bad-checksum` identifier is a **gating** finding by default
  (T23 owns the gate); T21 only classifies.

## Acceptance criteria

- [ ] `validateDoi` accepts `10.1086/684640`, rejects `10.x/foo`, `https://example.com`, empty.
- [ ] `validateIsbn` accepts a valid ISBN-13 and ISBN-10, returns `bad-checksum` for a single transposed digit, `malformed` for wrong length.
- [ ] `validateUrl` rejects `javascript:…`, `file://…`, and non-URLs; accepts `https://…`.
- [ ] `runIdentifiers` produces one layer per entry, in input order, with `not-applicable` for absent identifiers.
- [ ] Module performs zero I/O (verifiable: no imports of `node:fs`, `node:net`, fetch).

## Tests

`test/identifiers.test.ts`:

- Table-driven valid/invalid DOI cases.
- ISBN-10 and ISBN-13 valid; transposed-digit → `bad-checksum`; 9-digit → `malformed`.
- **Property-based** (fast-check): for any valid ISBN-13, flipping one digit yields `bad-checksum` or `malformed`, never `ok`.
- URL scheme allowlist.
- Mixed bibliography → correct per-entry layers.
- Coverage ≥ 80% line + branch.

## New dependencies to confirm

- `isbn3` — ISBN parse / normalize / check-digit validation (zero-dep, maintained).
