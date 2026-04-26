# T19 — User-facing documentation

**Phase:** 4 (Quality + release)
**Complexity:** medium
**Depends on:** T15 (CLI for usage examples), T12 (output renderers for output-schema doc)
**Blocks:** v0.1.0 tag (no shipping without docs)

## Scope

Four user-facing documentation files in `docs/` (the bibcheck repo's own docs, not the implementation plan).

## Files

- `docs/usage.md` — getting started, basic and advanced usage, invocation patterns.
- `docs/configuration.md` — `bibcheck.toml` reference, every option documented with defaults.
- `docs/output-schema.md` — the JSON output schema, **auto-generated** from the Zod definitions in `src/schema/output.ts` via `zod-to-json-schema`.
- `docs/extending.md` — how to add new database backends, how to write a project-supplied phrase denylist, new output formats. Targets contributors and project owners.
- `SECURITY.md` — security and telemetry disclosure at the repo root.
- `RELEASING.md` — release checklist at the repo root.

## docs/usage.md

Sections:

1. **Quick start** — install via `npx --yes bibcheck`; run `bibcheck doctor`; run `bibcheck check`.
2. **Subcommands** — one section each: what it does, when to use it, example invocations, sample output.
3. **CI integration** — copy-pasteable GitHub Actions snippet, including SARIF upload. Include a note near the SARIF/CI section: "SARIF uploaded to a public repository's GitHub Code Scanning surface makes any prose excerpts (snippets, matched text) public. Review fixture content before exposing your repo's SARIF output."
4. **Common workflows**:
   - Adding bibcheck to an existing project.
   - Debugging a `not-found-in-databases` finding.
   - Triaging the worklist.
   - Using `--offline` / `--cache-only` for pre-commit hooks (no outbound network; recommend after a full `bibcheck check` has populated the cache).
5. **Troubleshooting** — common issues and fixes.

Examples are derived from the integration-test fixtures (T16) — single source of truth.

## docs/configuration.md

Reference for every section / key in `bibcheck.toml`:

- For each section: purpose, full key list, types, defaults, examples.
- A complete annotated example at the end.
- Notes on environment variables (`WORLDCAT_API_KEY` etc.).
- **`[apis]` polite-pool transparency note**: "Setting `crossref_mailto` or `openalex_mailto` causes the address to be sent as a `User-Agent` header (and `?mailto=` query parameter as fallback) to api.crossref.org (US) and api.openalex.org (US/EU). It is optional. Linked policies: [CrossRef polite pool](https://www.crossref.org/documentation/metadata-plus/metadata-plus-usage-intentions/), [OpenAlex polite pool](https://docs.openalex.org/how-to-use-the-api/rate-limits-and-authentication)."
- **Cache size eviction note**: document the `cache.max_size_mb` setting, what happens when it is approached, and how `bibcheck doctor` reports current cache size.

Mirror the schema in `src/config.ts` (T01) — derive the documentation from the Zod schema descriptions where possible (Zod has `.describe()` for this).

## docs/output-schema.md

**Auto-generated.** Includes a "Schema version pinning for consumers" note: "bibcheck's output schema is versioned by `schemaVersion` major-pinned regex (`^0\\.\\d+\\.\\d+$` for v0.x). Consumers should pin to a major; minor bumps are additive and backward-compatible."

Build script:

```sh
node scripts/generate-schema-doc.ts > docs/output-schema.md
```

The script:

1. Imports `OutputSchema` from `src/schema/output.ts`.
2. Converts to JSON Schema via `zod-to-json-schema`.
3. Renders as Markdown with section per top-level field, examples per field, and the full JSON schema embedded as a code block at the end.

The script is owned by this task; lives at `scripts/generate-schema-doc.ts`.

A CI step (in T17) optionally regenerates the doc and fails if it differs from the committed version, ensuring drift is caught.

## docs/extending.md

Contributor-facing. Sections:

1. **Repo layout** — copy from the architecture doc but in user-readable form.
2. **Adding a database backend** — step-by-step (where to put the file, what interface to implement, how to wire into existence subcommand, how to add tests).
3. **Writing a project phrase denylist** — TOML schema, regex tips, how to use `<!-- bibcheck-allow: <key> -->` to acknowledge intentional matches, examples (style-guide deprecations, retracted-source wording).
4. **Adding output formats** — interface to implement, how to wire into CLI.
5. **Coding standards** — pointer to the cross-cutting standards (or copy summary).
6. **Testing requirements** — pointer to testing strategy.
7. **Trusted-host whitelist** — process for community PRs proposing additions or changes to the default trusted-host list. Criteria: hosts must serve canonical editions (university libraries, scholarly archives, recognized open-access repositories), be reasonably stable, and use HTTPS (HTTP is acceptable only for legacy archives such as Classify that have not yet migrated).

Contributions are accepted under the project's MIT license.

## SECURITY.md

One-paragraph file at the repo root:

> bibcheck collects no telemetry. The only outbound personal data is the polite-pool email address (when configured), which is sent to api.crossref.org and api.openalex.org as a User-Agent header and/or `?mailto=` query parameter. Report security issues to \<email-or-issue-tracker\>.

## RELEASING.md

Checklist file at the repo root. Contents:

- The pre-tag validation checklist from `doc/plan/release.md`.
- The five OIDC gotchas (four original + public-repo requirement) inline.
- The rollback/yank procedure from `doc/plan/release.md §"Rollback / yank story"`.

## Acceptance criteria

- [ ] All six deliverables exist (`docs/usage.md`, `docs/configuration.md`, `docs/output-schema.md`, `docs/extending.md`, `SECURITY.md`, `RELEASING.md`) and are linked from the repo's main README.
- [ ] `docs/usage.md` covers all seven subcommands with at least one example each.
- [ ] `docs/usage.md` includes the SARIF downstream-leakage caveat near the SARIF/CI section.
- [ ] `docs/usage.md` documents `--offline` / `--cache-only` for pre-commit hook usage.
- [ ] `docs/configuration.md` documents every key in the `bibcheck.toml` schema.
- [ ] `docs/configuration.md` includes the `[apis]` polite-pool transparency note.
- [ ] `docs/configuration.md` includes the `cache.max_size_mb` eviction note.
- [ ] `docs/output-schema.md` is auto-generated; the generator script lives at `scripts/generate-schema-doc.ts`.
- [ ] `docs/output-schema.md` includes the schema version pinning note.
- [ ] `docs/extending.md` walks through all five extension paths (including Trusted-host whitelist).
- [ ] `docs/extending.md` states contributions are under the project's MIT license.
- [ ] `SECURITY.md` states bibcheck collects no telemetry and explains polite-pool data flow.
- [ ] `RELEASING.md` includes the five OIDC gotchas and the rollback/yank procedure.
- [ ] All in-doc links are valid (internal markdown links + external URLs).
- [ ] No reference to Mündig in any of the user-facing docs (bibcheck is generic).

## Tests

- The generator script for `output-schema.md` has its own test (`test/scripts/generate-schema-doc.test.ts`): runs the generator, compares output to the committed `docs/output-schema.md`. Fails if they differ.
- Other docs are not unit-testable; reviewer reads them.

## New dependencies

- `zod-to-json-schema` — for the schema documentation generator.
