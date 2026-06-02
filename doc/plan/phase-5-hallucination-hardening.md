# Phase 5 — Hallucination-hardening (pre-v0.1 schema revision)

This phase precedes the v0.1 tag. It re-centres bibcheck on its primary goal —
**preventing hallucinated sources in AI-assisted research** — by closing the
gaps a design review found in the verification core, and finalises the output
contract before it freezes.

It supersedes the "schema is frozen for v0.1" rule in
[`architecture.md`](architecture.md) and [`phases.md`](phases.md): the schema is
**deliberately re-opened** for this phase and re-frozen at its end (T20). The
decisions driving this phase are recorded in
[`../../tmp/design-review/06-decisions.md`](../../tmp/design-review/06-decisions.md).

## Why this phase exists

The review found that a fabricated DOI which no database can confirm currently
passes `bibcheck check` silently — the single most important hallucination
signal the tool can produce was being dropped. Three more issues degraded the
same detection path (a dead WorldCat endpoint, API throttling, a weak title
metric), and the output contract under-described what "verified" means to the
LLM agents that consume it. This phase fixes those before the contract is set.

## Tickets

| ID  | Title | Depends on | Blocks |
|-----|-------|-----------|--------|
| T20 | Output-schema revision (evidence vocabulary, identifiers layer, not-found counter, WorldCat removal, locator fields); re-freeze | — | T21–T26 |
| T21 | Identifiers layer — local DOI/ISBN/URL validation (pre-network) | T20 | T22, T23 |
| T22 | Existence overhaul — evidence vocabulary, not-found counting + default gating, WorldCat removal | T20, T21 | T23 |
| T23 | Suppression & source-type gating (makes the secure default viable) | T20, T22 | T26 |
| T24 | Remove offline mode — internet required; rework doctor test with mock HTTP | — (independent) | — |
| T25 | Citation-parser swap to `@benrbray/remark-cite` — locators, multi-key, author-suppression | T20 | T26 |
| T26 | Docs & README reframe — existence as the core; document evidence semantics and verification limits | T20–T25 | — |

## Dependency graph

```
            ┌────────────────────────────┐
            │ T20  schema revision        │  (re-opens & re-freezes the contract)
            └───┬───────────┬─────────┬───┘
                │           │         │
        ┌───────▼──┐   ┌────▼────┐  ┌─▼──────────────┐
        │ T21 ids  │   │ T25     │  │ (T24 is fully  │
        └────┬─────┘   │ remark- │  │  independent;  │
             │         │ cite    │  │  run any time) │
        ┌────▼─────┐   └────┬────┘  └────────────────┘
        │ T22      │        │
        │ existence│        │
        └────┬─────┘        │
             │              │
        ┌────▼─────┐        │
        │ T23      │        │
        │ suppress │        │
        └────┬─────┘        │
             └──────┬───────┘
              ┌─────▼─────┐
              │ T26 docs  │
              └───────────┘
```

T20 is the gate: it sets the contract every other ticket reads. T24 (offline
removal) shares no schema surface and can be done at any point. T26 lands last.

## Definition of done for Phase 5

1. A fabricated DOI / malformed identifier **fails** `bibcheck check` by default.
2. A legitimately-unverifiable pre-DOI source can be **suppressed precisely**,
   in-repo, with a recorded reason — without disabling the check.
3. The output contract makes "what was verified" and "what was NOT verified
   (claim-support)" machine-readable; no numeric confidence score.
4. WorldCat (dead Classify endpoint) is gone; ISBN coverage via OpenLibrary holds.
5. Citation parsing handles the full Pandoc grammar (locators, multi-key,
   author-suppression).
6. `--offline` is gone; the suite is green without a network dependency in tests.
7. README leads with the hallucination-prevention use case; existence is a
   first-class, default-gating check.
8. Schema re-frozen at its new version; all tests pass; coverage ≥ 80%.
