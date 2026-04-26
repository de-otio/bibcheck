# Usage

bibcheck is a humanities-aware citation verification tool for CSL-JSON bibliographies.

## Installation

Install globally for repeated use:

```sh
npm install -g bibcheck
```

For one-off use without a global install:

```sh
npx --yes bibcheck <subcommand>
```

## Quick start

1. Create a minimal `bibcheck.toml` in your project root:

```toml
[bibliography]
file = "docs/sources.json"

[docs]
include = ["docs/**/*.md"]
```

2. Place your CSL-JSON bibliography at `docs/sources.json`.

3. Run the full check:

```sh
bibcheck check
```

4. If you are setting up a new project, run the onboarding diagnostic first:

```sh
bibcheck doctor
```

See [docs/configuration.md](configuration.md) for the full `bibcheck.toml` reference.

## Subcommands

All subcommands accept `--help` for a full flag listing.

### `check`

Run all checks in one pass: existence, canonical-edition, linkage, phrase denylist, and worklist generation. This is the primary CI build-gate command.

```sh
bibcheck check
bibcheck check --format sarif --output bibcheck.sarif
```

Exits with code 1 if any findings require attention; exits 0 if everything is clean.

### `existence`

Check each bibliography entry against bibliographic databases (CrossRef, OpenAlex, OpenLibrary, WorldCat) to verify DOI/ISBN records exist and metadata matches.

```sh
bibcheck existence
bibcheck existence --format json
```

### `canonical`

Verify that pre-DOI primary sources carry a `url:` field pointing to a trusted canonical-edition host (HathiTrust, Internet Archive, Liberty Fund OLL, Stanford Encyclopedia of Philosophy archives, PhilPapers, national library catalogues). Performs a HEAD request to confirm the URL is live and follows redirect chains.

```sh
bibcheck canonical
bibcheck canonical --format markdown
```

### `linkage`

Check that every `@citekey` reference in your markdown documents resolves to an entry in the bibliography. Reports unresolved keys with `file:line` anchors. Deterministic CI-safe alternative to `pandoc --citeproc`'s render-time warning.

```sh
bibcheck linkage
bibcheck linkage --format text
```

### `phrases`

Run a regex pass over prose against a project-supplied phrase denylist (configured via `[phrases] file` in `bibcheck.toml`). This subcommand is a no-op when no phrase file is configured. Acknowledge an intentional match with `<!-- bibcheck-allow: <key> -->` in the prose.

```sh
bibcheck phrases
bibcheck phrases --format json
```

### `worklist`

Generate a structured human-triage worklist of items requiring manual verification: direct quotations, page-cited paraphrases, citations to contested-coverage source types, and citations using non-canonical editions. Each item includes a pre-filled verification URL.

```sh
bibcheck worklist
bibcheck worklist --format markdown
```

### `doctor`

Run onboarding diagnostics to verify configuration, bibliography file presence, API connectivity, and cache health. Run this when setting up a new project or troubleshooting.

```sh
bibcheck doctor
bibcheck doctor --clear-cache
bibcheck doctor --clear-cache --yes   # skip confirmation prompt
```

## Output formats

Pass `--format <format>` to any subcommand. The default is `text` when writing to a terminal and `markdown` when stdout is redirected.

### `text`

Compact, human-readable output for terminal use. Not intended for downstream parsing.

```sh
bibcheck check --format text
```

### `markdown`

Human-readable Markdown. Suitable for writing to a file and viewing in a rendered context (pull request comments, wikis).

```sh
bibcheck check --format markdown --output report.md
```

### `json`

Machine-readable JSON matching the versioned output schema. Intended for LLM agents, CI tooling, and editor extensions. See [docs/output-schema.md](output-schema.md) for the full schema contract.

```sh
bibcheck check --format json --output bibcheck.json
```

### `sarif`

Static Analysis Results Interchange Format (SARIF 2.1.0). Use this format for GitHub Code Scanning PR annotations.

```sh
bibcheck check --format sarif --output bibcheck.sarif
```

## CI integration

### GitHub Actions with SARIF upload

```yaml
- name: Run bibcheck
  run: npx bibcheck check --format sarif --output bibcheck.sarif

- name: Upload SARIF to GitHub Code Scanning
  uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: bibcheck.sarif
```

This surfaces bibcheck findings as inline annotations on pull requests.

**SARIF downstream-leakage caveat:** SARIF uploaded to a public repository's GitHub Code Scanning surface makes any prose excerpts (snippets, matched text) public. This includes matched phrase-denylist text, citation snippets, and worklist item excerpts. Review the content of your bibliography fixtures and prose before exposing your repository's SARIF output on a public Code Scanning surface.

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | All checks passed. |
| 1 | One or more findings require attention. |
| 2 | Configuration error (malformed `bibcheck.toml`, missing bibliography file). |

### Minimal CI example (no SARIF)

```yaml
- name: Install bibcheck
  run: npm install -g bibcheck

- name: Run citation checks
  run: bibcheck check --format text
```

## Pre-commit hooks

Use the `--offline` flag in pre-commit hooks to avoid network calls. bibcheck will serve all responses from its local filesystem cache, keeping hooks fast and avoiding polite-pool quota consumption on every commit.

The workflow is:

1. Run `bibcheck check` once (without `--offline`) after any bibliography change to populate the cache.
2. In your pre-commit hook, run with `--offline`:

```sh
bibcheck check --offline
```

Because the cache records API responses with a 30-day TTL, subsequent runs read from disk and complete in a fraction of a second per entry.

Example `.pre-commit-config.yaml` entry (using [pre-commit](https://pre-commit.com/)):

```yaml
repos:
  - repo: local
    hooks:
      - id: bibcheck
        name: bibcheck citation check
        language: node
        entry: bibcheck check --offline
        pass_filenames: false
```

Use `--no-cache` to force a fully in-memory (no-op) cache. This is useful in throwaway CI environments where you want to avoid writing to disk, but it means every run re-fetches from APIs.

## Troubleshooting

**`not-found-in-databases` for a known DOI**

The entry has a `doi:` field but no database returned a match. Possible causes:
- The DOI contains unusual characters; try `bibcheck existence --format json` and inspect the `evidence` field.
- The record is not yet indexed. CrossRef and OpenAlex propagate new DOIs with some delay.
- The `[apis] crossref_mailto` field is not set; you are in the anonymous rate-limit tier and may be throttled. Set the field and re-run.

**`dead-url` for a URL I can access in a browser**

The URL returned a non-2xx status to bibcheck's HEAD request, or the redirect chain led to a non-trusted host. Inspect the output with `--format json` and look at `canonical.redirectChain`. Some hosting platforms serve different responses to automated clients; the URL may require a user agent accepted by the host.

**Config error on startup**

`bibcheck: config error: ...` is printed to stderr with a description of the failing field. Run `bibcheck doctor` for a guided diagnosis. Common issues: TOML syntax errors, wrong path in `[bibliography] file`, or an invalid regex in the phrase denylist.

**Slow first run**

bibcheck makes one HTTP request per bibliography entry (existence checks + canonical URL HEAD). On a large bibliography, this can take a minute or more. Subsequent runs are fast because responses are cached for 30 days. Run with `--offline` after the cache is warm.
