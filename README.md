# bibcheck

Catch citations an LLM invented — fabricated DOIs, non-existent ISBNs,
plausible-but-wrong identifiers — before they reach your bibliography or your
readers. bibcheck verifies that the works your sources describe actually exist
in scholarly databases, that their identifiers are well-formed, and that URLs
for pre-DOI primary sources point to trusted canonical editions.

> **Status: v0.1 — initial release.** CLI surface, JSON output schema, and
> configuration grammar are stable within the v0.x major; minor bumps are
> additive.

## Why bibcheck

AI-assisted research workflows regularly produce citations that look real but
aren't: a DOI where the last four digits are transposed, an ISBN whose check
digit is wrong, a journal article that was never published. These hallucinations
pass a spell-check and a format linter. They do not pass bibcheck.

bibcheck's existence check is default-gating: if a DOI or ISBN that your
bibliography records is absent from CrossRef, OpenAlex, and OpenLibrary, the
build fails. A malformed identifier — one that fails the structural rules
before any network call — fails even faster. The aim is to make fabricated
citations fail CI before they reach a reader.

## Verification boundary

**"Verified" means**: the work exists in CrossRef/OpenAlex/OpenLibrary and its
recorded metadata (title, first author) agrees with what your bibliography
says. That is a necessary check, not a sufficient one.

**bibcheck does not check** whether the cited source supports the claim your
prose is making. That is a human judgment, and bibcheck surfaces it as a manual
worklist item (`notCheckedFor: ["claim-support"]` in the JSON output). The
worklist is the bridge between automated and manual verification.

There are no numeric confidence scores anywhere in bibcheck's output. The
output carries a defined evidence vocabulary (`exists-metadata-match`,
`exists-metadata-mismatch`, `absent`, `unverifiable`) so downstream consumers
— including LLM agents — cannot read `"verified"` as "the citation's claim is
sound."

## What it does

- **Existence verification (default-gating).** For each bibliography entry,
  checks DOI/ISBN/title against CrossRef, OpenAlex, and OpenLibrary. Absence
  from all applicable databases is treated as a fabrication signal and fails
  `bibcheck check` by default.
- **Identifier well-formedness (default-gating, pre-network).** Validates DOI
  structure, ISBN check digits, and URL scheme locally, before any network
  call. A malformed identifier short-circuits the existence lookup and is a
  strong, cheap fabrication signal.
- **Canonical-edition URL verification.** For pre-DOI primary sources, checks
  that each entry carries a `url:` pointing to a trusted canonical-edition host
  (HathiTrust, Internet Archive, Liberty Fund OLL, Stanford Encyclopedia of
  Philosophy archives, PhilPapers, national-library catalogues) and that the
  URL is live.
- **Pandoc-citeproc-style linkage check.** Every `@citekey` reference in your
  markdown documents resolves to an entry in the bibliography. Deterministic
  CI-safe alternative to `pandoc --citeproc`'s render-time warning.
- **Structured human-triage worklist.** Emits manual-verification items —
  direct quotations, page-cited paraphrases, citations to contested-coverage
  source types, non-canonical editions — with pre-filled verification URLs and
  explicit `notCheckedFor: ["claim-support"]` annotations.
- **Versioned structured output.** JSON / Markdown / SARIF, schema versioned at
  `0.2.0`. Designed for LLM agents, CI pipelines, and editor extensions.

bibcheck also exposes an **opt-in phrase denylist** (`bibcheck phrases`): a
regex pass over prose against patterns the project supplies via
`[phrases] file = "..."` in `bibcheck.toml`. Useful for style-guide
deprecations, retracted-source wording, or in-house terminology drift.
bibcheck does not ship a curated baseline — the feature is a configurable
lint, not curated guidance. Acknowledge an intentional match with
`<!-- bibcheck-allow: <key> -->` in the prose.

## What it does not do

- Render bibliography output. Use `pandoc --citeproc` or `citation-js` directly.
- Take PDF input. Use FiCi / ValiRef / cite_verify_cli for that.
- Verify quotation wording or whether the cited source supports the prose's
  claim. This is surfaced as a manual worklist item, not automated.
- Run without a network connection. bibcheck requires internet access to
  perform existence checks. See [docs/usage.md](docs/usage.md) for the failure
  mode.
- Edit bibliography or docs. Reports findings; does not modify files.

## Internet required

bibcheck requires a live internet connection to verify existence. Running
without network access produces a clear error (transport failure logged
against affected entries); it does not silently degrade to "unverifiable."

## Status

v0.1. All seven subcommands are implemented. The output schema is at `0.2.0`.
See [docs/usage.md](docs/usage.md) for usage and
[docs/output-schema.md](docs/output-schema.md) for the JSON contract.

## Documentation

- [docs/usage.md](docs/usage.md) — installation, quick start, subcommands, CI
  integration, exit codes, suppression workflow.
- [docs/configuration.md](docs/configuration.md) — full `bibcheck.toml`
  reference including gating rules and per-entry suppression.
- [docs/output-schema.md](docs/output-schema.md) — JSON output schema contract
  for downstream consumers (schema `0.2.0`).
- [docs/extending.md](docs/extending.md) — adding database clients, output
  formats, and subcommands.
- [SECURITY.md](SECURITY.md) — security policy, data handling, and
  vulnerability reporting.
- [RELEASING.md](RELEASING.md) — maintainer release checklist including
  OIDC/npm Trusted Publishing notes.

## Development

```sh
npm install
npm run build       # compile TypeScript to dist/
npm test            # run vitest
npm run typecheck   # tsc --noEmit
```

## License

[MIT](LICENSE).
