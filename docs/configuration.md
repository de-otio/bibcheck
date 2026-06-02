# Configuration reference

bibcheck reads `bibcheck.toml` from the project root (or from the path given
by `--config`). All sections and fields are optional; sensible defaults allow
bibcheck to run in a project with no config file at all.

## `.gitignore` snippet

Add these entries to your project's `.gitignore`:

```
.bibcheck-cache/
*.sarif
```

`.bibcheck-cache/` holds API response caches and is regenerable. `*.sarif`
files are output artifacts and should not be committed.

---

## `[bibliography]`

Locates the CSL-JSON bibliography file.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `file` | string | `"docs/sources.json"` | Path to the CSL-JSON bibliography, relative to `bibcheck.toml`. |

```toml
[bibliography]
file = "docs/sources.json"
```

---

## `[docs]`

Controls which markdown files are scanned for citekey references and phrase
matches.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `include` | string[] | `["docs/**/*.md"]` | Glob patterns for markdown files to include. |
| `exclude` | string[] | `[]` | Glob patterns for markdown files to exclude. |

```toml
[docs]
include = ["docs/**/*.md", "chapters/**/*.md"]
exclude = ["docs/archive/**"]
```

---

## `[trusted_hosts]`

Defines the trusted-canonical-edition host whitelist used by the `canonical`
subcommand.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `hosts` | string[] | *(see below)* | Hostnames (without scheme) trusted as canonical-edition sources. |

**Important:** setting `hosts` overrides the default list entirely. It does not
merge with the defaults. To add a single host, you must repeat the full default
list plus your addition.

The default list is:

```
hathitrust.org
archive.org
oll.libertyfund.org
plato.stanford.edu
philpapers.org
loc.gov
dnb.de
bnf.fr
```

```toml
[trusted_hosts]
hosts = [
  "hathitrust.org",
  "archive.org",
  "oll.libertyfund.org",
  "plato.stanford.edu",
  "philpapers.org",
  "loc.gov",
  "dnb.de",
  "bnf.fr",
  "gallica.bnf.fr",          # your addition
]
```

To propose adding a host to the default list, see
[docs/extending.md](extending.md#trusted-host-whitelist).

---

## `[phrases]`

Configures the project-supplied phrase denylist for the `phrases` subcommand.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `file` | string or null | `null` | Path to the phrase-denylist TOML file, relative to `bibcheck.toml`. |

When `file` is `null` (the default), the `phrases` subcommand is a no-op.

```toml
[phrases]
file = "config/phrase-denylist.toml"
```

---

## `[source_types]`

Per-source-type gating rules. Keys are source-type strings matching the `type`
field of CSL-JSON entries (e.g., `"webpage"`, `"article-journal"`, `"book"`).

### Why source-type exemptions exist

By default, `not-found-in-databases` gates `bibcheck check` — absence from
CrossRef/OpenAlex/OpenLibrary is treated as a fabrication signal. This is the
right default for DOI-era journal articles and books. It is the wrong default
for pre-DOI primary sources such as manuscripts or classical texts that predate
the DOI system entirely; absence from modern scholarly databases is expected
and carries no fabrication signal.

Rather than disabling the check for the whole bibliography, source-type
exemptions let you opt specific CSL types out of the not-found gate
declaratively, preserving the gate for every other entry.

| Sub-field | Type | Default | Description |
|-----------|------|---------|-------------|
| `warn_load_bearing` | boolean | *(unset)* | Emit a worklist item when an entry of this type is cited in a load-bearing context. |
| `allow_load_bearing` | boolean | *(unset)* | Suppress the load-bearing worklist item for this type. |
| `gate_not_found` | boolean | `true` | When `false`, a `not-found-in-databases` result for an entry of this type does **not** fail `bibcheck check`. The finding is still reported (informational), never dropped. Governs only the not-found gate — malformed identifiers always gate regardless of source type. |

```toml
[source_types]

[source_types.webpage]
warn_load_bearing = true

[source_types."article-journal"]
allow_load_bearing = true

# Pre-DOI primary sources: absence from the databases is not a fabrication
# signal, so don't fail the build on it.
[source_types.manuscript]
gate_not_found = false

[source_types."classic-text"]
gate_not_found = false
```

### Per-entry suppression: `bibcheck-allow` in a CSL `note`

Source-type rules are broad — they exempt every entry of a type. To suppress a
single finding for one specific entry, add a `bibcheck-allow` directive to
that entry's CSL-JSON `note` field (mirroring the
`<!-- bibcheck-allow: <key> -->` mechanism used for phrases):

```json
{
  "id": "anon1680pamphlet",
  "type": "article-journal",
  "title": "A True Relation …",
  "note": "bibcheck-allow: not-found (reason: 1680 pamphlet, Bodleian shelfmark Vet. A3 e.123)"
}
```

- **Finding type** is one of `not-found`, `malformed-identifier`,
  `canonical-issue`, `metadata-mismatch`. The directive suppresses only *that*
  finding for *that* entry.
- **A reason is mandatory.** An allow without a non-empty `(reason: …)` is
  reported as a warning and does **not** suppress — the finding still gates.
  This is intentional: a reason-less suppression would be invisible in review
  and defeat the audit trail.
- A suppressed finding is reported as an **acknowledged** (informational) item,
  not dropped: it stays in the summary totals and entries, and is logged via
  `check.acknowledged_finding`. It just does not drive the non-zero exit code.
- An explicit allow takes precedence over a source-type exemption, which in
  turn takes precedence over the secure default.

A single `note` may carry multiple directives:

```json
{
  "id": "mill1843logic",
  "note": "bibcheck-allow: not-found (reason: pre-DOI classical text) bibcheck-allow: canonical-issue (reason: using BnF scan; HathiTrust scan is incomplete)"
}
```

---

## `[edition_discipline]`

Maps author identifiers to canonical-edition disciplines. Used by the
`canonical` and `worklist` subcommands to generate per-author canonical-edition
verification URLs.

Keys and values are both strings. The key is an author identifier (e.g., a
citekey prefix or normalized author name); the value is a discipline label used
for lookup.

```toml
[edition_discipline]
"Mill, John Stuart" = "political-economy"
"Aristotle" = "classics"
```

---

## `[apis]`

Configures API credentials and polite-pool identifiers.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `crossref_mailto` | string or null | `null` | Email address for the CrossRef polite pool. |
| `openalex_mailto` | string or null | `null` | Email address for the OpenAlex polite pool. |

### Polite-pool email transparency note

Setting `crossref_mailto` or `openalex_mailto` causes the address to be sent
as a `User-Agent` header (and `?mailto=` query parameter as fallback) to
api.crossref.org and api.openalex.org. It is optional but recommended: you
join those services' polite request pool with higher rate limits.

The address is transmitted to the API providers over HTTPS. It does not appear
in the output JSON (it is stripped before caching). Linked policies:
- CrossRef polite pool: https://crossref.org/documentation/retrieve-metadata/rest-api/tips-for-using-the-rest-api/
- OpenAlex polite pool: https://docs.openalex.org/how-to-use-the-api/rate-limits-and-authentication

```toml
[apis]
crossref_mailto = "you@example.org"
openalex_mailto = "you@example.org"
```

### ISBN coverage

ISBN existence is covered by OpenLibrary (openlibrary.org). No additional
configuration is required for ISBN checks.

---

## `[cache]`

Controls the filesystem cache for API responses.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `dir` | string | `".bibcheck-cache"` | Directory for cached API responses, relative to `bibcheck.toml`. |
| `max_size_mb` | number or null | `256` | Maximum cache directory size in megabytes. Set to `null` for unlimited. |

### Cache eviction

When the cache directory exceeds `max_size_mb`, bibcheck evicts the oldest
entries (by file mtime) on each `set` operation to bring the size back under
the limit. Eviction is per-entry, not bulk; a single large check run that
produces many new entries will evict older entries incrementally.

Set `max_size_mb = null` to disable eviction entirely (cache grows without
bound). This is appropriate for CI environments where the cache directory is
discarded after the run.

Run `bibcheck doctor` to see the current cache directory size and entry count.

```toml
[cache]
dir = ".bibcheck-cache"
max_size_mb = 512
```

---

## Annotated complete example

```toml
[bibliography]
file = "docs/sources.json"

[docs]
include = ["docs/**/*.md"]
exclude = ["docs/archive/**"]

[trusted_hosts]
hosts = [
  "hathitrust.org",
  "archive.org",
  "oll.libertyfund.org",
  "plato.stanford.edu",
  "philpapers.org",
  "loc.gov",
  "dnb.de",
  "bnf.fr",
]

[phrases]
file = "config/phrase-denylist.toml"

[source_types]

[source_types.webpage]
warn_load_bearing = true

# Pre-DOI primary sources: exempt from the not-found gate
[source_types.manuscript]
gate_not_found = false

[apis]
crossref_mailto = "you@example.org"
openalex_mailto = "you@example.org"

[cache]
dir = ".bibcheck-cache"
max_size_mb = 256
```
