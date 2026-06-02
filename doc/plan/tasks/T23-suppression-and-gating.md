# T23 — Suppression & source-type gating

**Phase:** 5 (Hallucination-hardening)
**Complexity:** medium
**Depends on:** T20 (schema), T22 (existence gating)
**Blocks:** T26 (docs)

## Scope

Make the secure default (Q1) **usable**. Gating `not-found-in-databases` by
default turns every legitimately-unverifiable pre-DOI primary source into a CI
failure; without a precise escape hatch, users disable the check wholesale and
catch zero hallucinations. This ticket adds the two-layer suppression model from
open-question 7:

1. **Source-type gating rules** — the broad, declarative case. Pre-DOI /
   archival source types don't gate on `not-found` because no DOI was ever
   expected.
2. **Per-entry allow-with-reason** — the specific case. A single entry can be
   exempted, in-repo, with a recorded justification that survives in the diff.

Optionally (stretch): a **baseline file** for adopting bibcheck onto a large
existing bibliography (fail only on *new* findings).

## Files

- `src/config.ts` — extend `[source_types]` schema with gating rules.
- `src/suppression.ts` — pure resolution of (finding, config, allows) → gated?.
- `src/check.ts` — apply suppression in `checkExitReasons` + summary.
- `test/suppression.test.ts`, `test/config.test.ts`, `test/check.test.ts`.
- `docs/configuration.md` — document the model (or defer prose to T26).

## Design

### Source-type gating (config)

```toml
[source_types]
# Per CSL type or a bibcheck source-class. `gate_not_found = false` means a
# not-found / unverifiable result for entries of this type does NOT fail check.
manuscript      = { gate_not_found = false }   # archival; no DOI expected
"classic-text"  = { gate_not_found = false }   # pre-DOI primary source
article-journal = { gate_not_found = true }    # modern; absence is a real signal (default)
```

Default for unlisted types: **gate = true** (secure default). Resolution keys off
the CSL `type` (and, where the worklist already derives a host-based class,
reuse that — pin the derivation, resolving 03-nits N1).

### Per-entry allow-with-reason

A reviewable, reason-bearing acknowledgement carried with the entry. Two
candidate carriers — **pick one and document it**:

- A CSL `note` convention: `note: "bibcheck-allow: not-found (reason: 1680 pamphlet, Bodleian shelfmark X, verified 2026-05)"`.
- A sidecar `bibcheck-allow.toml` keyed by citekey + finding type + reason.

Requirements regardless of carrier:
- **Per-finding** (silence *this* entry's *this* finding, not the whole check).
- **Reason mandatory** — an allow without a non-empty reason is itself a warning.
- **Distinct from un-triaged** — suppressed findings are reported as
  `acknowledged` (informational), never silently dropped, mirroring the existing
  `phrases` `bibcheck-allow` semantics.

### Suppression resolution (pure)

```ts
export interface SuppressionInput {
  citekey: string;
  findingType: 'not-found' | 'malformed-identifier' | 'canonical-issue' | 'metadata-mismatch';
  cslType: string | undefined;
  config: Config;
  allows: ParsedAllow[];   // from the chosen carrier
}
export function isGated(input: SuppressionInput): { gated: boolean; reason: 'default' | 'source-type' | 'allow'; };
```

Pure function; no I/O. `check.ts` calls it for each finding and only counts
gated findings toward the non-zero exit.

## Acceptance criteria

- [ ] Unlisted source type with a not-found entry → **gated** (exit 1) by default.
- [ ] `manuscript` entry (gate_not_found = false) with not-found → **not gated**; still reported (informational).
- [ ] Per-entry allow-with-reason suppresses that entry's finding; output marks it `acknowledged`, not dropped.
- [ ] An allow with an empty/missing reason emits a warning.
- [ ] Suppression resolution is a pure function with unit tests covering the default/source-type/allow precedence.
- [ ] (Stretch) baseline file: only findings absent from the baseline gate.

## Tests

- Default-gate, source-type-exempt, and per-entry-allow paths each toggle the exit code as specified.
- Reason-required enforcement.
- Acknowledged findings appear in output with the right status and are excluded from the gating count but included in totals.
- Coverage ≥ 80%.
