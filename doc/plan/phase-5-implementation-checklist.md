# Phase 5 — parallel implementation checklist

Execution plan for building Phase 5 ([phase-5-hallucination-hardening.md](phase-5-hallucination-hardening.md))
with multiple agents in parallel. Defines waves, model assignments, file-ownership
conflicts, and the coverage gates that keep the suite at ≥ 80%.

---

## 0. Pre-flight (do once, before any agent starts)

- [ ] **Approve new runtime dependencies** (coordination protocol — no agent adds a dep without this):
  - `isbn3` (T21 — ISBN parse/normalize/check-digit)
  - `@benrbray/remark-cite` (T25 — Pandoc citation AST)
  - a token-set / Jaro-Winkler string-match lib, e.g. `string-comparison` (T22 — title metric). *(If declined, T22 hand-rolls token-set ratio.)*
- [ ] **Branch**: cut `phase-5` off `main`. Each agent works in an **isolated git worktree** (`isolation: "worktree"`) so parallel file writes don't collide; merge at each wave barrier.
- [ ] **Baseline**: confirm `main` is green — `npm run typecheck` + `npm test` (661 tests) pass — so any new red is attributable to Phase 5.
- [ ] **Record coverage baseline**: `npx vitest run --coverage` → note current line/branch %. The gate is "≥ 80% and not below baseline."

---

## 1. Model assignment

Principle: **Opus** for high-stakes correctness and design judgment (the frozen
contract, the gating semantics that decide pass/fail, the suppression model);
**Sonnet** for well-specified implementation against clear acceptance criteria;
**Haiku** reserved for purely mechanical follow-ups (none load-bearing here).

| Ticket | Model | Why this tier |
|--------|-------|---------------|
| T20 schema revision | **Opus** | The contract every other ticket reads; subtle `superRefine` reconciliation invariant; a mistake here propagates everywhere. |
| T21 identifiers | **Sonnet** | Pure, bounded, table-/property-testable; check-digit logic is mechanical and well-specified. |
| T22 existence overhaul | **Opus** | Fixes B1 (the silent-pass) — the core mission; couples evidence mapping + gating + WorldCat removal + title metric; correctness is the whole point. |
| T23 suppression & gating | **Opus** | Design judgment (carrier choice, precedence rules); this is what makes the secure default safe vs. unusable. |
| T24 remove offline | **Sonnet** | Mostly deletion + reworking a test to inject a mock; low ambiguity. |
| T25 remark-cite swap | **Sonnet** | Library integration with explicit acceptance criteria; the plugin does the grammar heavy-lifting. Escalate to Opus only if locator/multi-key edge cases fight back. |
| T26 docs reframe | **Sonnet** | Prose against a settled spec; accuracy matters, so not Haiku. |

---

## 2. Waves (dependency-ordered; barrier between each)

```
Wave 0:  T20 (Opus)   ‖  T24 (Sonnet)          ← T20 gates everything; T24 is independent
Wave 1:  T21 (Sonnet) ‖  T25 (Sonnet)          ← both need only T20
Wave 2:  T22 (Opus)                            ← needs T20 + T21
Wave 3:  T23 (Opus)                            ← needs T20 + T22
Wave 4:  T26 (Sonnet)                          ← needs T20–T25
```

At every `‖` the agents run concurrently in separate worktrees. **Do not start a
wave until the previous wave's barrier (§4) is green.**

### Wave 0 — contract + offline removal

**T20 (Opus)** — owns `src/schema/output.ts`, `test/schema.test.ts`
- [ ] Implement all six schema changes from the ticket; `SCHEMA_VERSION = '0.2.0'`.
- [ ] `superRefine`: existence buckets sum to `totalEntries`; new counters bounded.
- [ ] Restore the freeze note.
- [ ] `npx vitest run --coverage test/schema.test.ts` → schema ≥ 80% line+branch.
- [ ] `npm run typecheck` clean.

**T24 (Sonnet)** — owns `src/cli.ts` (offline parts), `src/doctor.ts` (offline branch only), `test/integration/check.test.ts` (doctor cases), `docs/usage.md`/`configuration.md` (offline refs)
- [ ] Remove `--offline` everywhere; revert the earlier session doctor-offline fix.
- [ ] Rework doctor integration test to inject a **mock HttpClient** (no real network).
- [ ] Network-failure path → one clear error + non-zero exit.
- [ ] `npx vitest run --coverage` on changed modules ≥ 80%; previously-flaky doctor test now stable.

> ⚠️ T24 edits `doctor.ts` (offline branch) and T22 (Wave 2) also edits `doctor.ts` (removes `worldcat-connectivity`). T24 finishes two waves earlier, so the edits are sequenced — but T22's agent must rebase on the merged T24 result. See §3.

### Wave 1 — identifiers + citation parser

**T21 (Sonnet)** — owns `src/identifiers.ts`, `test/identifiers.test.ts`
- [ ] Pure validators + `runIdentifiers`; zero I/O.
- [ ] Property-based ISBN test (fast-check): one flipped digit never yields `ok`.
- [ ] Expose normalized ISBN for T22's cache key (coordinate the seam).
- [ ] Coverage ≥ 80% line+branch on `src/identifiers.ts`.

**T25 (Sonnet)** — owns `src/markdown/citekeys.ts`, `src/linkage.ts`, `src/worklist.ts`, their tests
- [ ] Reimplement extraction on remark-cite AST; locators + multi-key + `-@key`.
- [ ] Document-order determinism + stable secondary sorts (also fixes worklist ordering S4).
- [ ] Code spans not scanned (assert).
- [ ] Coverage ≥ 80% on all three changed modules.

### Wave 2 — existence overhaul

**T22 (Opus)** — owns `src/existence.ts`, `src/check.ts`, deletes `src/databases/worldcat.ts`, edits `src/databases/index.ts`, `src/doctor.ts` (worldcat check), tests
- [ ] Rebase worktree on merged Wave 0+1.
- [ ] Evidence mapping; `notCheckedFor` always includes `claim-support`.
- [ ] Count `notFoundInDatabases`; **gate it + malformed-id by default** (unconditional until T23).
- [ ] Delete WorldCat from code, doctor, default run.
- [ ] Token-set title metric; fixture proves no subtitle/word-order false-mismatch.
- [ ] Sanitized `error` field; no mailto/key leak.
- [ ] Coverage ≥ 80% on `existence.ts` + `check.ts`.

### Wave 3 — suppression

**T23 (Opus)** — owns `src/suppression.ts`, `src/config.ts` (source_types), `src/check.ts` (gating application), tests
- [ ] Source-type gating rules; default gate = true.
- [ ] Per-entry allow-with-reason (pick + document carrier); reason mandatory; `acknowledged` not dropped.
- [ ] Pure `isGated` with precedence unit tests.
- [ ] Coverage ≥ 80% on `suppression.ts` + changed `check.ts`/`config.ts` paths.

### Wave 4 — docs

**T26 (Sonnet)** — owns `README.md`, `docs/*.md`, `SECURITY.md`
- [ ] Reframe; verification-boundary prose; exit-code table; suppression workflow; internet-required note.
- [ ] Regenerate `docs/output-schema.md` from the `0.2.0` schema; matches `output.ts`.
- [ ] No WorldCat / `--offline` references remain anywhere.
- [ ] Link-check passes.

---

## 3. File-ownership conflict matrix

Shared files must be edited by exactly one agent per wave; later editors rebase.

| File | Touched by | Resolution |
|------|-----------|------------|
| `src/schema/output.ts` | T20 only | T20 is solo in its lane; frozen after. |
| `src/check.ts` | T22 (Wave 2), T23 (Wave 3) | Sequential by wave; T23 rebases on T22. |
| `src/doctor.ts` | T24 (offline branch, Wave 0), T22 (worldcat check, Wave 2) | Sequential by wave; T22 rebases on merged T24. |
| `docs/configuration.md`, `docs/usage.md` | T24 (remove offline refs), T22 (worldcat refs), T26 (final prose) | T24/T22 do **minimal stop-gap** removals; **T26 owns all doc prose** and is authoritative. Prefer deferring doc edits to T26 where the ticket allows. |
| `src/linkage.ts`, `src/worklist.ts` | T25 only | No overlap with T22 (existence/check). |
| `src/config.ts` | T23 only (source_types) | T20 does not touch config. |

If an agent discovers it needs a file it doesn't own → **stop and surface**, per
the original coordination protocol. Do not silently edit another ticket's file.

---

## 4. Per-wave barrier (the merge gate — run after each wave)

Before opening the next wave:

- [ ] Merge the wave's worktrees into `phase-5`.
- [ ] `npm run typecheck` — clean (both `tsconfig` + `tsconfig.test`).
- [ ] `npm test` — **all** tests pass (not just the wave's).
- [ ] `npx vitest run --coverage` — **aggregate ≥ 80% line AND branch**, and not below the pre-flight baseline.
- [ ] `node dist/cli.js --help` runs; spot-check one real command end-to-end.
- [ ] Resolve any conflict surfaced by §3 before proceeding.

A wave is **not done** until this barrier is green. Coverage regressions block the
next wave — fix tests in the owning ticket, don't defer.

---

## 5. Coverage strategy (how 80% is actually guaranteed)

Three enforcement layers, not just hope:

1. **Per-module, in-ticket** — every ticket's acceptance criteria require ≥ 80%
   line + branch on the modules it owns; the agent runs
   `npx vitest run --coverage <module test>` before declaring done.
2. **Per-wave aggregate** — the §4 barrier runs full-suite coverage; a wave that
   drops aggregate below 80% (or below baseline) does not advance.
3. **CI threshold (already exists, T16/T17)** — `vitest.config.ts` carries the
   80% line+branch thresholds and CI fails under them. Confirm the new modules
   (`identifiers.ts`, `suppression.ts`) are **included** in the coverage `include`
   glob — a new file silently outside the glob is the classic way coverage
   "passes" while real coverage drops. **Add this check to T21 and T23.**

Branch coverage specifically: the gating logic (T22/T23) and the validators (T21)
are branch-dense. Tests must hit **both** sides of every gate decision
(gated/not-gated, source-type-exempt/not, reason-present/absent) and every
validator verdict — not just the happy path. This is called out in each ticket's
test list; the barrier's branch-coverage number is the backstop.

---

## 6. Final Phase-5 verification (before the v0.1 tag)

- [ ] All eight DoD items in [phase-5-hallucination-hardening.md](phase-5-hallucination-hardening.md) satisfied.
- [ ] End-to-end: a fixture with a **fabricated DOI** and a **bad-checksum ISBN** → `bibcheck check` exits **1**; a `manuscript`-type not-found entry with a reasoned allow → exits **0**.
- [ ] Schema re-frozen at `0.2.0`; `docs/output-schema.md` regenerated and matching.
- [ ] No `worldcat` / `--offline` strings anywhere in `src/` or `docs/`.
- [ ] Full suite green; aggregate coverage ≥ 80% line + branch.
- [ ] `package.json` version bumped off `0.0.0` (separate release step).
