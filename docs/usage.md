# Usage

bibcheck is a humanities-aware citation verification tool for CSL-JSON
bibliographies. Its primary purpose is catching citations an LLM invented —
fabricated DOIs, non-existent ISBNs, plausible-but-wrong identifiers — before
they reach your bibliography or your readers.

## Internet required

bibcheck requires a live internet connection to perform existence checks
against CrossRef, OpenAlex, and OpenLibrary. If the databases are unreachable,
bibcheck logs a clear transport-failure error against the affected entries
and does not silently treat them as "unverifiable." Run `bibcheck doctor` to
confirm connectivity before a large check.

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

See [docs/configuration.md](configuration.md) for the full `bibcheck.toml`
reference.

## Subcommands

All subcommands accept `--help` for a full flag listing.

### `check`

Run all checks in one pass: existence, canonical-edition, linkage, phrase
denylist, and worklist generation. This is the primary CI build-gate command.

```sh
bibcheck check
bibcheck check --format sarif --output bibcheck.sarif
```

See the **Exit codes** section below for which findings gate the build and how
to exempt specific entries.

### `existence`

Check each bibliography entry against bibliographic databases (CrossRef,
OpenAlex, OpenLibrary) to verify DOI/ISBN records exist and metadata matches.

```sh
bibcheck existence
bibcheck existence --format json
```

### `canonical`

Verify that pre-DOI primary sources carry a `url:` field pointing to a trusted
canonical-edition host (HathiTrust, Internet Archive, Liberty Fund OLL,
Stanford Encyclopedia of Philosophy archives, PhilPapers, national library
catalogues). Performs a HEAD request to confirm the URL is live and follows
redirect chains.

```sh
bibcheck canonical
bibcheck canonical --format markdown
```

### `linkage`

Check that every `@citekey` reference in your markdown documents resolves to
an entry in the bibliography. Reports unresolved keys with `file:line` anchors.
Deterministic CI-safe alternative to `pandoc --citeproc`'s render-time
warning.

It also performs **reverse linkage**: any bibliography entry whose citekey is
never cited in a document is reported as an `orphan` (with an empty
`references` list). Orphans catch LLM-padded reference lists, but they are
**informational only and never gate the build** — an uncited entry is a smell,
not proof of fabrication.

The citation parser handles Pandoc-style multi-key citations (`[@a; @b, p.5]`)
and author-suppressed forms (`-@key`), and records any locator (`p. 42`,
`pp. 33–35`) in the JSON output.

**Known trade-off:** an email address like `email@host.example` in prose can
match the `@citekey` pattern if `host` happens to be a citekey. This is a
documented false-positive risk of the hand-rolled parser; inspect `--format
json` output if you see unexpected linkage entries.

```sh
bibcheck linkage
bibcheck linkage --format text
```

### `phrases`

Run a regex pass over prose against a project-supplied phrase denylist
(configured via `[phrases] file` in `bibcheck.toml`). This subcommand is a
no-op when no phrase file is configured. Acknowledge an intentional match with
`<!-- bibcheck-allow: <key> -->` in the prose.

```sh
bibcheck phrases
bibcheck phrases --format json
```

### `worklist`

Generate a structured human-triage worklist of items requiring manual
verification: direct quotations, page-cited paraphrases, citations to
contested-coverage source types, and citations using non-canonical editions.
Each item includes a pre-filled verification URL and an explicit
`notCheckedFor: ["claim-support"]` annotation in the JSON output — confirming
that whether the source supports your prose's claim remains a manual judgment.

```sh
bibcheck worklist
bibcheck worklist --format markdown
```

### `doctor`

Run onboarding diagnostics to verify configuration, bibliography file presence,
API connectivity, and cache health. Run this when setting up a new project or
troubleshooting.

```sh
bibcheck doctor
bibcheck doctor --clear-cache
bibcheck doctor --clear-cache --yes   # skip confirmation prompt
```

## Output formats

Pass `--format <format>` to any subcommand. The default is `text` when writing
to a terminal and `markdown` when stdout is redirected.

### `text`

Compact, human-readable output for terminal use. Not intended for downstream
parsing.

```sh
bibcheck check --format text
```

### `markdown`

Human-readable Markdown. Suitable for writing to a file and viewing in a
rendered context (pull request comments, wikis).

```sh
bibcheck check --format markdown --output report.md
```

### `json`

Machine-readable JSON matching the versioned output schema (`0.3.0`). Intended
for LLM agents, CI tooling, and editor extensions. See
[docs/output-schema.md](output-schema.md) for the full schema contract.

```sh
bibcheck check --format json --output bibcheck.json
```

### `sarif`

Static Analysis Results Interchange Format (SARIF 2.1.0). Use this format for
GitHub Code Scanning PR annotations.

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

**SARIF downstream-leakage caveat:** SARIF uploaded to a public repository's
GitHub Code Scanning surface makes any prose excerpts (snippets, matched text)
public. This includes matched phrase-denylist text, citation snippets, and
worklist item excerpts. Review the content of your bibliography fixtures and
prose before exposing your repository's SARIF output on a public Code Scanning
surface.

### Exit codes

`bibcheck check` uses a gated build model: certain findings cause a non-zero
exit by default, forcing attention before the build proceeds. Suppression
mechanisms (see below) let you exempt specific entries with a documented reason
without disabling the gate entirely.

| Code | Meaning |
|------|---------|
| 0 | All checks passed (or all findings are suppressed/acknowledged). |
| 1 | One or more gating findings are present. |
| 2 | Configuration error (malformed `bibcheck.toml`, missing bibliography file). |

#### Which findings gate by default

| Finding | Gating? | Notes |
|---------|---------|-------|
| `not-found-in-databases` | **Yes** | Absence from CrossRef/OpenAlex/OpenLibrary is a fabrication signal. Suppress per source type or per entry. |
| `malformed-identifier` | **Yes** | A DOI, ISBN, or URL that fails structural validation gates immediately. Source-type exemptions do not apply; use per-entry `bibcheck-allow`. |
| `metadata-mismatch` | **Yes** | The identifier was found, but title/author metadata does not agree. |
| `canonical-issue` | **Yes** | URL is dead, on the wrong host, or missing for a pre-DOI entry. |
| `unresolved-linkage` | **Yes** | A `@citekey` in your prose has no matching bibliography entry. |
| `flagged-phrase` | **Yes** | A denylist pattern matched prose and has no acknowledgement. |
| `unverifiable` | No | Entry has no DOI/ISBN and title search was inconclusive. Reported but does not gate. |
| `orphan` (uncited bibliography entry) | No | A bibliography entry is never cited in any doc (reverse linkage). A smell, not proof of fabrication — reported as `summary.orphanedEntries` and a `linkage` entry with `status = "orphan"`, but does NOT gate. |
| `worklist-item` | No | Manual-check items for direct quotes, page refs, etc. Informational only. |
| `acknowledged` findings | No | Explicitly suppressed findings (see Suppression below). Stay in output as informational. |

### Minimal CI example (no SARIF)

```yaml
- name: Install bibcheck
  run: npm install -g bibcheck

- name: Run citation checks
  run: bibcheck check --format text
```

## Suppression workflow

A gated check is only useful if it avoids false positives. Two suppression
mechanisms let you exempt specific findings with documented reasons, without
turning off the gate for the whole bibliography.

The design principle: the secure default (not-found and malformed identifiers
gate unconditionally) needs a precise, auditable escape hatch so users do not
resort to disabling checks wholesale. Each suppression requires a reason,
creating an audit trail.

Suppressed findings are **not dropped**. They remain in the JSON output
(entries + summary counts) and are logged as informational
`check.acknowledged_finding` events. They do not drive the non-zero exit code.

### Source-type gating rules (broad, declarative)

For pre-DOI primary sources where absence from CrossRef/OpenAlex/OpenLibrary is
expected (no DOI was ever issued), set `gate_not_found = false` for that CSL
source type in `bibcheck.toml`. This exempts every entry of that type from the
not-found gate without a per-entry declaration.

```toml
[source_types]

# Pre-DOI primary sources: absence from the databases is not a fabrication
# signal, so don't fail the build on it.
[source_types.manuscript]
gate_not_found = false

[source_types."classic-text"]
gate_not_found = false
```

Source-type exemptions apply **only** to `not-found-in-databases`. Malformed
identifiers, canonical issues, and metadata mismatches always gate regardless
of source type.

### Per-entry suppression: `bibcheck-allow` in a CSL note

To suppress a single finding for one entry, add a `bibcheck-allow` directive to
that entry's CSL-JSON `note` field:

```json
{
  "id": "anon1680pamphlet",
  "type": "article-journal",
  "title": "A True Relation …",
  "note": "bibcheck-allow: not-found (reason: 1680 pamphlet, Bodleian shelfmark Vet. A3 e.123)"
}
```

- **Finding type** is one of `not-found`, `malformed-identifier`,
  `canonical-issue`, `metadata-mismatch`. The directive suppresses only that
  finding for that entry.
- **A reason is mandatory.** An allow without a non-empty `(reason: …)` is
  reported as a warning and does **not** suppress. The finding still gates.
- A single `note` can carry multiple directives.

### Precedence

An explicit per-entry allow takes precedence over a source-type exemption,
which in turn takes precedence over the secure default gate.

## Known limitations

- **Non-Latin titles and non-ASCII citekeys.** The citation parser and title
  normaliser are tested against Latin-script inputs. Titles in Arabic, CJK,
  Cyrillic, or other scripts may produce false metadata mismatches or parser
  misses. Full i18n support is on the roadmap (R5).
- **Single bibliography per run.** bibcheck checks one CSL-JSON file per
  invocation. Multi-bibliography support is on the roadmap (R6).
- **No PDF input.** bibcheck reads CSL-JSON and markdown prose. It does not
  extract citations from PDF files.
- **No quotation text verification.** bibcheck does not check whether quoted
  text appears verbatim in the cited source; that is a manual step, surfaced
  via the worklist.
- **No claim-support verification.** Whether a cited source supports your
  prose's assertion is explicitly out of scope and permanently in
  `notCheckedFor: ["claim-support"]`.
- **Citation parser is hand-rolled.** It handles `[@a; @b, p.5]`, `-@key`, and
  locators. An `email@host` in prose can still false-match if `host` is a
  citekey (documented trade-off; inspect JSON output if needed).

## Troubleshooting

**`not-found-in-databases` for a known DOI**

The entry has a `doi:` field but no database returned a match. Possible causes:
- The DOI contains unusual characters; try `bibcheck existence --format json`
  and inspect the `evidence` field.
- The record is not yet indexed. CrossRef and OpenAlex propagate new DOIs with
  some delay.
- The `[apis] crossref_mailto` field is not set; you are in the anonymous
  rate-limit tier and may be throttled. Set the field and re-run.
- The source type is pre-DOI and never had a DOI. Use
  `[source_types] <type> = { gate_not_found = false }` to exempt the type, or
  add a per-entry `bibcheck-allow: not-found (reason: …)`.

**`dead-url` for a URL I can access in a browser**

The URL returned a non-2xx status to bibcheck's HEAD request, or the redirect
chain led to a non-trusted host. Inspect the output with `--format json` and
look at `canonical.redirectChain`. Some hosting platforms serve different
responses to automated clients; the URL may require a user agent accepted by
the host.

**Config error on startup**

`bibcheck: config error: ...` is printed to stderr with a description of the
failing field. Run `bibcheck doctor` for a guided diagnosis. Common issues:
TOML syntax errors, wrong path in `[bibliography] file`, or an invalid regex
in the phrase denylist.

**Slow first run**

bibcheck makes one HTTP request per bibliography entry (existence checks +
canonical URL HEAD). On a large bibliography, this can take a minute or more.
Subsequent runs are fast because responses are cached for 30 days.

**Transport failure / network errors**

bibcheck requires internet access. If all existence checks for an entry fail
with transport errors, bibcheck logs `existence.transport_failure` with the
affected citekeys. Check your network connection and the `[apis]` base URLs in
`bibcheck.toml`. Use `bibcheck doctor` to verify connectivity.
