# Phases and parallelism

How tasks are sequenced. Tasks in the same phase can run in parallel; later phases depend on earlier ones.

## Phase overview

```
Phase 1 ─ Foundation
   T01 Config        T02 Cache        T03 Markdown utils
        ↓                 ↓                  ↓
Phase 2a ─ Modules without subcommand integration
   T04 Phrase loader T05 Databases   T06 HTTP utility
        ↓                 ↓                  ↓
Phase 2b ─ Subcommand modules (parallel)
   T07 Phrases  T08 Existence  T09 Canonical  T10 Linkage  T11 Worklist  T12 Output
                                          ↓
Phase 3 ─ Integration
   T13 Check       T14 Doctor      T15 CLI
                                          ↓
Phase 4 ─ Quality + release
   T16 Fixtures+integration tests
   T17 CI         T18 Release        T19 Docs
```

## Phase 1 — Foundation (parallel, ~3 agents)

**Goal:** stable utilities and types for everything downstream.

Tasks:

- **T01 — Config**. `src/config.ts`. Zod schema for `bibcheck.toml`; loader; sensible defaults.
- **T02 — Cache**. `src/cache/fs-cache.ts`. Filesystem TTL cache for API responses; in-memory mock for tests.
- **T03 — Markdown utils**. `src/markdown/{citekeys,blocks,glob}.ts`. Citekey extraction, blockquote/direct-quote detection, glob-based file discovery.

These three are fully independent — three agents can work them simultaneously.

**Phase 1 completes when** all three modules are merged, exporting the interfaces documented in their tickets, with their unit tests at ≥ 80% coverage.

## Phase 2a — Module utilities (parallel, ~3 agents)

**Goal:** the database, HTTP, and phrase-denylist primitives that subcommand modules need.

Tasks:

- **T04 — Phrase denylist loader**. `src/phrases/load.ts`. Parses and validates a project-supplied phrase-denylist TOML file. No baseline ships with bibcheck.
- **T05 — Database clients**. `src/databases/{crossref,openalex,openlibrary,worldcat}.ts`. Each implements a common `Client` interface; each is independently testable with mocked HTTP.
- **T06 — HTTP utility**. `src/http.ts`. HEAD with redirect-chain tracking; trusted-host whitelist matching.

Independent of each other. T04 has no external dependencies; T05 and T06 use Node's built-in `fetch` + the cache from T02.

**Phase 2a completes when** all three modules are merged with their unit tests at ≥ 80% coverage.

## Phase 2b — Subcommand modules (parallel, ~6 agents)

**Goal:** each of the five subcommand modules + the four output renderers.

Tasks:

- **T07 — `phrases.ts`**. Depends on: T03 (markdown utils), T04 (phrase denylist loader).
- **T08 — `existence.ts`**. Depends on: T05 (database clients).
- **T09 — `canonical.ts`**. Depends on: T06 (HTTP utility), T01 (config — for trusted-host whitelist).
- **T10 — `linkage.ts`**. Depends on: T03 (markdown utils).
- **T11 — `worklist.ts`**. Depends on: T03 (markdown utils), T01 (config — for source-type rules).
- **T12 — Output renderers**. Depends on: schema only (already scaffolded).

The five subcommand modules and the output renderers are independent of each other — they all consume Phase 1 / 2a outputs and the schema, and produce schema-shaped data. Six agents can work them simultaneously.

**Phase 2b completes when** all six modules are merged with their unit tests at ≥ 80% coverage.

## Phase 3 — Integration (mostly parallel, ~3 agents)

**Goal:** wire the subcommands together and expose the CLI.

Tasks:

- **T13 — `check.ts`**. Orchestrator. Imports all five subcommand modules. Composes their outputs into the top-level `Output` object. Validates against `OutputSchema`.
- **T14 — `doctor.ts`**. Diagnostic. Lightweight; checks config validity, API connectivity, Node version. Independent of subcommands.
- **T15 — `cli.ts`**. Commander setup; subcommand dispatch; flags (`--format`, `--output`, `--no-cache`, `--config`); help text. Imports all subcommand modules + `check.ts` + `doctor.ts` + output renderers.

T13 and T14 are independent of each other. T15 depends on both. Two agents can work T13 and T14 in parallel; T15 starts when both are done.

**Phase 3 completes when** `node dist/cli.js --help` works and all seven subcommands dispatch correctly.

## Phase 4 — Quality + release (parallel where possible, ~4 agents)

**Goal:** end-to-end tests, CI, release pipeline, user-facing docs.

Tasks:

- **T16 — Test fixtures + integration tests**. `test/fixtures/**`, `test/integration/check.test.ts`, `vitest.config.ts` with coverage thresholds. Verifies `bibcheck check` end-to-end against realistic CSL JSON + markdown fixtures.
- **T17 — CI workflow**. `.github/workflows/ci.yml`. Setup-node, npm ci, typecheck, test (with coverage gate ≥ 80%), build.
- **T18 — Release workflow**. `.github/workflows/release.yml`. npm Trusted Publishing on tag push; Node 24; provenance; the four OIDC gotchas encoded inline.
- **T19 — User-facing docs**. `docs/usage.md`, `docs/configuration.md`, `docs/output-schema.md` (auto-generated from Zod), `docs/extending.md`.

T16 / T17 / T18 / T19 are largely independent. T17 depends on T16's fixtures because the CI step runs the integration tests; T18 is independent.

**Phase 4 completes when** the v0.1 definition-of-done in [`README.md`](README.md) is satisfied.

## Critical-path estimate

If each phase is bottlenecked on its slowest task, the v0.1 critical path is:

1. Phase 1: ~1 day (foundation utilities, well-bounded).
2. Phase 2a: ~1 day (databases need real CrossRef / OpenAlex shape work).
3. Phase 2b: ~2 days (canonical and worklist are the substantive ones).
4. Phase 3: ~1 day (CLI integration and end-to-end wiring).
5. Phase 4: ~1 day (CI / release / docs in parallel).

Aggregate: ~6 days of agent-work assuming reasonable parallelism. Solo path is closer to ~12–14 days because most of Phase 2b can't be sequentialised in parallel with itself.

## Confirmed runtime dependencies (v0.1)

The following packages are approved for use as runtime dependencies. No other runtime dependency may be added without explicit confirmation per the coordination protocol below.

- `zod` (already present): runtime validation + type derivation
- `smol-toml@^1`: TOML config + phrase-denylist parsing (T01, T04)
- `commander@^12`: CLI argument parsing (T15)
- `tinyglobby`: file discovery (T03)
- `unified` + `remark-parse` + `mdast-util-to-string`: markdown AST (T03)
- `keyv` + `keyv-file`: filesystem cache (T02)
- `re2js`: ReDoS-safe regex engine for user-supplied phrase patterns (T04)
- `node-sarif-builder`: SARIF v2.1.0 output (T12)
- `p-queue`: per-host concurrency limiting (T05, T06)
- `fastest-levenshtein`: title-fuzzy match for metadata-mismatch detection (T05)
- (built-in) `undici.request`: HTTP HEAD with redirect history; already inside Node 20's `fetch` (T06)

Adding any other runtime dependency requires explicit confirmation per the coordination protocol below.

## Coordination protocol

- Each task ticket lists the **files it owns**. If you need to touch a file owned by another task, stop and surface the issue.
- `package.json` is shared. Adding a dependency (`zod` is already there; new deps need explicit confirmation from a coordinator before the agent adds them).
- `src/schema/output.ts` is **frozen for v0.1**. Do not modify. If a fundamental issue is found, raise it.
- Cross-cutting standards (TypeScript strictness, test discipline, error handling) are documented in [`coding-standards.md`](coding-standards.md). Read those first.
- When a task is complete, the agent should run `npm run typecheck && npm test -- <module>` and confirm both pass before marking done.
