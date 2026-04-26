# Output schema

bibcheck's JSON output is a versioned contract for downstream consumers: LLM agents, CI tooling, and editor extensions.

The authoritative schema definition is in [`src/schema/output.ts`](../src/schema/output.ts), which uses Zod. This document is hand-maintained for v0.1; keeping it in sync with `src/schema/output.ts` is a manual step. A generator script (`scripts/generate-schema-doc.ts`) is planned for a future release to automate this.

## Schema version pinning

bibcheck's output schema is versioned via `schemaVersion` (currently `0.1.0`). The runtime emits the current `SCHEMA_VERSION` constant from `src/schema/output.ts`.

Validation accepts any `0.x.y` document. Consumers should pin to a major (currently `0.x`). Minor bumps are additive and backward-compatible. Major bumps (1.0.0+) are breaking.

Concretely:
- A consumer that validates `schemaVersion` against `/^0\.\d+\.\d+$/` will accept any v0.x output.
- A consumer that requires exact equality to `"0.1.0"` will need updating on minor bumps.

## Top-level shape

```json
{
  "schemaVersion": "0.1.0",
  "tool": {
    "name": "bibcheck",
    "version": "0.1.0"
  },
  "summary": { ... },
  "entries": [ ... ],
  "linkage": [ ... ],
  "phraseFlags": [ ... ],
  "worklist": [ ... ]
}
```

## Field descriptions

### `schemaVersion`

Type: `string` (matches `/^0\.\d+\.\d+$/` for v0.x documents)

The schema version, independent of the package version. Consumers should use this to decide how to parse the rest of the document.

### `tool`

Type: object

| Field | Type | Description |
|-------|------|-------------|
| `name` | `"bibcheck"` (literal) | Always `"bibcheck"`. |
| `version` | string | The installed package version (e.g., `"0.1.0"`). |

### `summary`

Type: object

Aggregate counts across all entries and checks.

| Field | Type | Description |
|-------|------|-------------|
| `totalEntries` | integer >= 0 | Number of entries in the bibliography. |
| `verified` | integer >= 0 | Entries with `existence.status = "verified"`. |
| `metadataMismatches` | integer >= 0 | Entries with `existence.status = "metadata-mismatch"`. |
| `unverifiable` | integer >= 0 | Entries with `existence.status = "unverifiable"`. |
| `canonicalIssues` | integer >= 0 | Entries with a canonical status other than `"verified-canonical"` or `"not-applicable"`. |
| `linkageFailures` | integer >= 0 | Count of unresolved citekey references (must equal `linkage.filter(l => l.status === "unresolved").length`). |
| `phraseFlags` | integer >= 0 | Count of phrase flags with `status = "flagged"` (acknowledged matches are excluded). |
| `worklistItems` | integer >= 0 | Count of worklist items (must equal `worklist.length`). |

### `entries`

Type: array of `Entry` objects

One entry per bibliography record. Indexed by `citekey`.

#### `Entry`

| Field | Type | Description |
|-------|------|-------------|
| `citekey` | string (non-empty) | The CSL-JSON `id` field used to cite this entry. |
| `existence` | `ExistenceLayer` or null | Existence check findings. Null when the existence subcommand was not run. |
| `canonical` | `CanonicalLayer` or null | Canonical-edition URL findings. Null when the canonical subcommand was not run. |

#### `ExistenceLayer`

| Field | Type | Description |
|-------|------|-------------|
| `status` | `ExistenceStatus` | Aggregate existence status (see enum table below). |
| `checks` | array of `ExistenceCheck` | Per-source check results. |

##### `ExistenceCheck`

| Field | Type | Description |
|-------|------|-------------|
| `source` | `ExistenceCheckSource` | Which database was queried. |
| `result` | `ExistenceCheckResult` | Result from that database (see enum table below). |
| `evidence` | unknown or null | Raw (sanitized) API response fragment. Shape varies by source. |

#### `CanonicalLayer`

| Field | Type | Description |
|-------|------|-------------|
| `status` | `CanonicalStatus` | Canonical-edition URL status (see enum table below). |
| `url` | string (http/https URL) or null | The URL that was checked, or null if no URL was present. |
| `redirectChain` | array of strings (optional) | Redirect chain followed during the HEAD request, in order. |

### `linkage`

Type: array of `LinkageEntry` objects

One entry per citekey encountered in the scanned markdown files.

#### `LinkageEntry`

| Field | Type | Description |
|-------|------|-------------|
| `citekey` | string (non-empty) | The citekey referenced in prose. |
| `status` | `LinkageStatus` | Whether the citekey resolves to a bibliography entry. |
| `references` | array of `LinkageReference` | All locations in markdown where this citekey appears. |

##### `LinkageReference`

| Field | Type | Description |
|-------|------|-------------|
| `file` | string (non-empty) | Relative path to the markdown file. |
| `line` | integer > 0 | Line number where the `@citekey` reference appears. |

### `phraseFlags`

Type: array of `PhraseFlag` objects

One entry per phrase-denylist match found in the scanned markdown files.

#### `PhraseFlag`

| Field | Type | Description |
|-------|------|-------------|
| `status` | `PhraseFlagStatus` | Whether the match is flagged or acknowledged. |
| `patternKey` | string (non-empty) | Stable key naming the denylist pattern that matched. |
| `referenceUrl` | string (http/https URL) or null | Optional project-supplied URL explaining why this phrase is denylisted. |
| `file` | string (non-empty) | Relative path to the markdown file where the match was found. |
| `line` | integer > 0 | Line number of the match. |
| `matchedText` | string (non-empty) | The substring of the prose that matched the denylist pattern. |

### `worklist`

Type: array of `WorklistItem` objects

Items requiring manual verification, generated by the `worklist` subcommand.

#### `WorklistItem`

| Field | Type | Description |
|-------|------|-------------|
| `type` | `WorklistItemType` | Category of manual verification required. |
| `file` | string (non-empty) | Relative path to the markdown file. |
| `line` | integer > 0 | Line number of the citation or match. |
| `citation` | string (non-empty) | The citation invocation as it appears in the prose (e.g., `@mill1859onliberty`). |
| `snippet` | string (non-empty) | Excerpt of prose around the citation, for context. |
| `verificationUrl` | string (http/https URL) or null | Pre-filled URL the human can use to perform the manual check. |
| `recommendedAction` | string (non-empty) | Human-readable description of what the manual check should establish. |

---

## Enum tables

### `ExistenceStatus`

| Value | Description |
|-------|-------------|
| `"verified"` | At least one database confirmed the entry exists and metadata matches. |
| `"metadata-mismatch"` | A database found the DOI/ISBN but metadata (title, authors, year) does not match. |
| `"not-found-in-databases"` | No database returned a positive match. |
| `"unverifiable"` | The entry has no DOI or ISBN and no title search returned a confident match. |

### `ExistenceCheckSource`

| Value | Description |
|-------|-------------|
| `"crossref"` | CrossRef DOI registry. |
| `"openalex"` | OpenAlex bibliographic metadata. |
| `"openlibrary"` | Open Library ISBN catalogue. |
| `"worldcat"` | WorldCat Classify ISBN classification (keyless legacy endpoint in v0.1). |

### `ExistenceCheckResult`

| Value | Description |
|-------|-------------|
| `"no-doi"` | The entry has no DOI; this source was not queried. |
| `"found"` | Record found and metadata matches. |
| `"not-found"` | Record not found in this source's index. |
| `"metadata-mismatch"` | Record found but metadata does not match the bibliography entry. |
| `"error"` | A network or API error prevented the check from completing. |

### `CanonicalStatus`

| Value | Description |
|-------|-------------|
| `"verified-canonical"` | URL is live and points to a trusted canonical-edition host. |
| `"wrong-host"` | URL is live but the host is not on the trusted-host whitelist. |
| `"dead-url"` | HEAD request returned a non-2xx status or a network error. |
| `"live-url-not-archived-snapshot"` | URL is live and on a trusted host but is not an archival snapshot URL. |
| `"no-url-on-pre-doi-entry"` | Entry has no DOI and no `url:` field; canonical edition cannot be verified. |
| `"not-applicable"` | Entry has a DOI; canonical-edition check does not apply. |

### `LinkageStatus`

| Value | Description |
|-------|-------------|
| `"resolved"` | The citekey appears in the bibliography. |
| `"unresolved"` | The citekey does not appear in the bibliography. |

### `PhraseFlagStatus`

| Value | Description |
|-------|-------------|
| `"flagged"` | Match requires attention; no acknowledgement comment found in the prose. |
| `"acknowledged"` | Match has been acknowledged with `<!-- bibcheck-allow: <key> -->` in the prose. |

### `WorklistItemType`

| Value | Description |
|-------|-------------|
| `"direct-quotation"` | A direct quotation needs to be verified verbatim against the source. |
| `"paraphrase-with-page-ref"` | A paraphrase attached to a page or section reference needs to be checked. |
| `"contested-source-type"` | Cited source is on a contested-coverage source type (e.g., Wikipedia, blog, preprint). |
| `"non-canonical-edition"` | Citation references a non-canonical edition where a canonical one exists. |

---

## Bumping rules

From the module-level JSDoc in `src/schema/output.ts`:

- **Additive changes** (new optional fields, new enum members on otherwise-open types) bump the **minor** part and remain backward-compatible. Consumers pinning to `/^0\.\d+\.\d+$/` continue to validate.
- **Renames, removals, or changed semantics** bump the **major** part. Consumers pinning a major version are insulated from such changes.

The `schemaVersion` field is independent of the package version. A patch release of the bibcheck package may carry no schema change; a minor schema change may be shipped in a patch package release if it is purely additive.

---

## v0.1 limitation

For v0.1, this file is hand-maintained. The intended workflow (generating this document from the Zod schemas via `scripts/generate-schema-doc.ts`) is planned for a future release. Until then, keep this document in sync with `src/schema/output.ts` when making schema changes.
