# bibcheck v0.1 — implementation plan

This folder is a detailed, ticket-form implementation plan for the v0.1 release of `bibcheck`. It is organised so that multiple agents can work independent units in parallel without stepping on each other.

## What v0.1 ships

A working CLI implementing the seven subcommands designed in the README of the repo:

- `bibcheck canonical` — canonical-edition URL verification (differentiated)
- `bibcheck linkage` — `@citekey` resolution against the bibliography (differentiated, weakly)
- `bibcheck worklist` — Layer 2 / Layer 3 manual-triage worklist (differentiated)
- `bibcheck phrases` — project-supplied phrase denylist lint (opt-in; no shipped baseline)
- `bibcheck existence` — DOI / ISBN / title-search existence check (commodity convenience layer)
- `bibcheck check` — orchestrator: runs all of the above; CI build gate
- `bibcheck doctor` — diagnostic for onboarding

Plus:

- A complete output JSON schema under [`src/schema/output.ts`](../../src/schema/output.ts) (already scaffolded), versioned `0.1.0`.
- Four output formats: JSON, Markdown, SARIF, text.
- A `bibcheck.toml` configuration loader.
- A persistent filesystem cache for API responses (default 30-day TTL, configurable).
- Test coverage ≥ 80% (line + branch), enforced in CI.
- CI workflow (lint + typecheck + test + coverage gate on every push/PR).
- Release workflow (npm Trusted Publishing on tag push, Node 24 + provenance).
- User-facing docs at `docs/usage.md`, `docs/configuration.md`, `docs/output-schema.md`, `docs/extending.md`.

Out of scope for v0.1 (deferred to later versions or sister tools):

- PDF input.
- Quote-text matching against full-text corpora (see Mündig's [`docs/source-verifier/quote-verification.md`](../../../muendig/docs/source-verifier/quote-verification.md) for the deferred sister-tool design).
- LLM-driven content judgment.
- Automatic editing of bibliographies or docs.
- Bibliography rendering (use `pandoc --citeproc` or `citation-js` directly).

## Definition of done

A v0.1 tag can be cut when **all** of the following are true:

1. All seven subcommands implemented, tested, and behave per their task specs.
2. `bibcheck check --format json` against the fixtures in `test/fixtures/` produces output that validates against `OutputSchema` and matches expected fixtures.
3. `bibcheck check --format sarif` produces SARIF that uploads cleanly to GitHub's PR-annotation surface.
4. `vitest run --coverage` passes with ≥ 80% line coverage and ≥ 80% branch coverage.
5. `npm run build` produces a `dist/` directory; `node dist/cli.js --help` prints help; `npx --yes <local tarball> --help` works for an installed consumer.
6. The CI workflow at `.github/workflows/ci.yml` passes on a green PR.
7. The release workflow at `.github/workflows/release.yml` is reviewed and tested in dry-run; first tag uses it.
8. User-facing docs are written and link-checked.
9. `README.md` updated from "pre-alpha" to v0.1 status.

## How to use this plan

If you are an agent picking up implementation work:

1. **Read the cross-cutting docs first**, in order:
   - [`architecture.md`](architecture.md) — module structure, interfaces, dependency graph.
   - [`phases.md`](phases.md) — what depends on what, what can be parallel.
   - [`coding-standards.md`](coding-standards.md) — TS conventions, error handling, module hygiene.
   - [`testing-strategy.md`](testing-strategy.md) — the 80% coverage approach.
   - [`release.md`](release.md) — CI/release pipeline (only relevant for T17/T18).
2. **Find your task** in [`tasks/`](tasks/). Each task is a self-contained ticket with scope, file ownership, interfaces, acceptance criteria, and test requirements.
3. **Check the dependency line** at the top of your task. If your task depends on another, confirm that one is done before starting.
4. **Touch only the files your task owns.** If you discover you need to change a file owned by another task, stop and surface the issue rather than touching it silently — that file may be in another agent's working set.
5. **Implement to the acceptance criteria**, not beyond. Don't add features the ticket doesn't ask for.
6. **Tests are part of the deliverable**, not optional. Each task specifies its test requirements.

## Plan file map

Cross-cutting:

- [`README.md`](README.md) — this file: scope, definition of done, how to use the plan.
- [`architecture.md`](architecture.md) — module structure, public interfaces, dependency graph.
- [`phases.md`](phases.md) — phase sequencing and parallelism.
- [`coding-standards.md`](coding-standards.md) — TS conventions and module hygiene.
- [`testing-strategy.md`](testing-strategy.md) — 80% coverage approach, fixture conventions.
- [`release.md`](release.md) — CI workflow, release workflow, npm Trusted Publishing details.

External `../../muendig/...` references in this plan are dev-only context for the source-verifier ecosystem; never propagate them into `src/` or user-facing `docs/`. T19's acceptance criteria already enforce this for `docs/`.

Tasks (in [`tasks/`](tasks/)):

| ID  | Title | Phase |
|---|---|---|
| T01 | Configuration schema and loader | 1 |
| T02 | Filesystem cache | 1 |
| T03 | Markdown utilities (citekey extraction, blockquote detection) | 1 |
| T04 | Phrase denylist loader | 2a |
| T05 | Database clients (CrossRef, OpenAlex, OpenLibrary, WorldCat) | 2a |
| T06 | HTTP utility for URL verification | 2a |
| T07 | `bibcheck phrases` subcommand | 2b |
| T08 | `bibcheck existence` subcommand | 2b |
| T09 | `bibcheck canonical` subcommand | 2b |
| T10 | `bibcheck linkage` subcommand | 2b |
| T11 | `bibcheck worklist` subcommand | 2b |
| T12 | Output renderers (JSON, Markdown, SARIF, text) | 2b |
| T13 | `bibcheck check` orchestrator | 3 |
| T14 | `bibcheck doctor` diagnostic | 3 |
| T15 | CLI entry point and commander setup | 3 |
| T16 | Test fixtures and integration tests | 4 |
| T17 | CI workflow | 4 |
| T18 | Release workflow (npm Trusted Publishing) | 4 |
| T19 | User-facing documentation | 4 |
