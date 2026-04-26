# bibcheck

Humanities-aware citation verification for CSL-JSON bibliographies. Canonical-edition URL verification, Pandoc-citeproc-style linkage check, structured human-triage worklist generation, and an opt-in project-supplied phrase denylist.

> **Status: v0.1 — initial release.** CLI surface, JSON output schema, and configuration grammar are stable within the v0.x major; minor bumps are additive.

## What it does

Four differentiated functions:

- **Canonical-edition URL verification.** For pre-DOI primary sources, checks that each bibliography entry carries a `url:` pointing to a trusted canonical-edition host (HathiTrust, Internet Archive, Liberty Fund OLL, Stanford Encyclopedia of Philosophy archives, PhilPapers, national-library catalogues), and that the URL is live.
- **Pandoc-citeproc-style linkage check.** Every `@citekey` reference in markdown documents resolves to an entry in the bibliography, surfaced with `file:line` anchors. Deterministic CI-safe alternative to `pandoc --citeproc`'s render-time warning.
- **Structured human-triage worklist.** Emits manual-verification items (direct quotations, page-cited paraphrases, citations to contested-coverage source-types, citations using non-canonical editions where canonical ones exist) with pre-filled verification URLs.
- **Versioned structured output.** JSON / Markdown / SARIF, schema versioned with semver. Designed for consumption by humans, LLM agents, CI pipelines, and editor extensions.

A thin convenience layer over CrossRef + OpenAlex + OpenLibrary is included for DOI/ISBN existence checks. For richer existence verification (PDF input, multi-source LLM judging) defer to dedicated tools.

bibcheck also exposes an **opt-in phrase denylist** (`bibcheck phrases`): a regex pass over prose against patterns the project supplies via `[phrases] file = "..."` in `bibcheck.toml`. Useful for style-guide deprecations, retracted-source wording, or in-house terminology drift. bibcheck does not ship a curated baseline — the feature is a configurable lint, not curated guidance, since any baseline would be both incomplete (a tiny slice of the misattribution universe) and reputationally load-bearing (a single bad pattern would taint the rest). Acknowledge an intentional match with `<!-- bibcheck-allow: <key> -->`.

## What it does not do

- Render bibliography output. Use `pandoc --citeproc` or `citation-js` directly.
- Take PDF input. Use FiCi / ValiRef / cite_verify_cli for that.
- Verify quotation wording or whether the cited source supports the prose's claim. Manual; emitted as worklist instead.
- Edit bibliography or docs. Reports findings; does not modify files.

## Status

v0.1. All seven subcommands are implemented. The output schema is at v0.1.0. See [docs/usage.md](docs/usage.md) for usage and [docs/output-schema.md](docs/output-schema.md) for the JSON contract.

## Documentation

- [docs/usage.md](docs/usage.md) — installation, quick start, subcommands, CI integration, pre-commit hooks.
- [docs/configuration.md](docs/configuration.md) — full `bibcheck.toml` reference.
- [docs/output-schema.md](docs/output-schema.md) — JSON output schema contract for downstream consumers.
- [docs/extending.md](docs/extending.md) — adding database clients, output formats, and subcommands.
- [SECURITY.md](SECURITY.md) — security policy, data handling, and vulnerability reporting.
- [RELEASING.md](RELEASING.md) — maintainer release checklist including OIDC/npm Trusted Publishing notes.

## Development

```sh
npm install
npm run build       # compile TypeScript to dist/
npm test            # run vitest
npm run typecheck   # tsc --noEmit
```

## License

[MIT](LICENSE).
