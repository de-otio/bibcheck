# T26 — Docs & README reframe (existence as the core)

**Phase:** 5 (Hallucination-hardening)
**Complexity:** low
**Depends on:** T20–T25
**Blocks:** —

## Scope

Re-frame the user-facing story around the primary goal — **preventing
hallucinated sources in AI-assisted research** — and document the new contract.
Today the README calls existence "a thin convenience layer … defer to dedicated
tools," which describes the core mission as a side feature. This ticket fixes the
framing and writes the semantics the schema now encodes.

No verification theatre: document what bibcheck *does* and *does not* assert;
don't oversell.

## Files

- `README.md` — reframe.
- `docs/usage.md` — hallucination-prevention quick start; exit-code semantics per finding; suppression workflow.
- `docs/configuration.md` — `[source_types]` gating rules; per-entry allow-with-reason; WorldCat removed; `--offline` removed.
- `docs/output-schema.md` — regenerate from the `0.2.0` Zod schema; document `evidence` / `checkedFor` / `notCheckedFor`, the `identifiers` layer, and the new summary counters.
- `SECURITY.md` — correct the SSRF claim to match the implemented control (coordinate with the SSRF hardening if/when it lands; see 01-blockers B5). Do not overclaim.

## Content requirements

1. **Lead with the use case**: "catch citations an LLM invented — fabricated DOIs,
   non-existent ISBNs, plausible-but-wrong identifiers — before they reach your
   bibliography or your readers."
2. **Existence is first-class and default-gating.** Replace the "commodity
   convenience layer / defer to dedicated tools" framing.
3. **State the verification boundary explicitly** (the Q2 decision in prose):
   - "Verified" means *the work exists in CrossRef/OpenAlex/OpenLibrary* and its
     metadata agrees — necessary, not sufficient.
   - bibcheck does **not** check whether the source supports the prose's claim
     (`notCheckedFor: ['claim-support']`); that's the manual worklist's job.
   - **No confidence scores** — bibcheck reports discrete, defined evidence
     states, not a calibrated probability.
4. **Exit-code table**: for `check`, which findings gate (not-found, malformed id,
   unresolved linkage, …) and how to exempt them.
5. **Suppression workflow** (from T23): source-type rules + per-entry
   allow-with-reason, with the "why a secure default needs precise suppression"
   rationale stated briefly.
6. **Internet required** (T24): bibcheck needs network access; document the failure mode.
7. **Known limitations**: i18n / non-Latin titles (roadmap R5), single bibliography
   (R6), no PDF / quote-text / claim-support (correctly out of scope).

## Acceptance criteria

- [ ] README no longer describes existence as a convenience layer; leads with hallucination prevention.
- [ ] The exists-vs-claim-support boundary is stated in README and `output-schema.md`.
- [ ] `output-schema.md` regenerated from the `0.2.0` schema and matches `src/schema/output.ts`.
- [ ] No references to WorldCat or `--offline` remain in any doc.
- [ ] SECURITY.md SSRF description matches the implemented behaviour (no overclaim).
- [ ] Docs are link-checked (DoD item 8 from the v0.1 plan).
- [ ] No verification-theatre language (no uncalibrated scores, no diff-paraphrase filler).
