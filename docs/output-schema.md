# Output schema

bibcheck's JSON output is a versioned contract for downstream consumers: LLM
agents, CI tooling, and editor extensions.

The authoritative schema definition is in
[`src/schema/output.ts`](../src/schema/output.ts), which uses Zod. This
document is hand-maintained and reflects the `0.3.0` schema exactly.

## Schema version pinning

bibcheck's output schema is versioned via `schemaVersion` (currently `0.3.0`).
The runtime emits the current `SCHEMA_VERSION` constant from
`src/schema/output.ts`.

Validation accepts any `0.x.y` document. Consumers should pin to a major
(currently `0.x`). Minor bumps are additive and backward-compatible. Major
bumps (1.0.0+) are breaking.

Concretely:
- A consumer that validates `schemaVersion` against `/^0\.\d+\.\d+$/` will
  accept any v0.x output.
- A consumer that requires exact equality to `"0.3.0"` will need updating on
  minor bumps.

## Verification boundary

**Reading `"verified"` does not mean the source supports the prose's claim.**
A `verified` status means the work exists in CrossRef/OpenAlex/OpenLibrary and
its recorded metadata (title, first author) agrees with the bibliography entry.
That is a necessary check, not a sufficient one.

bibcheck never checks whether a cited source supports the prose's assertion.
That is a human judgment. The `notCheckedFor: ["claim-support"]` field on
every existence layer makes this explicit and machine-readable: an LLM-agent
consumer that reads the JSON cannot mistake `verified` for "claim is sound."

There are no numeric confidence scores in this schema. The `evidence`
vocabulary (`exists-metadata-match`, `exists-metadata-mismatch`, `absent`,
`unverifiable`) is the calibrated alternative: discrete, defined states.

## Top-level shape

```json
{
  "schemaVersion": "0.3.0",
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

The schema version, independent of the package version. Consumers should use
this to decide how to parse the rest of the document.

### `tool`

Type: object

| Field | Type | Description |
|-------|------|-------------|
| `name` | `"bibcheck"` (literal) | Always `"bibcheck"`. |
| `version` | string | The installed package version (e.g., `"0.1.0"`). |

### `summary`

Type: object

Aggregate counts across all entries and checks. The four existence buckets
(`verified`, `metadataMismatches`, `notFoundInDatabases`, `unverifiable`) are
mutually exclusive and must sum to `totalEntries` (enforced by the schema).

| Field | Type | Description |
|-------|------|-------------|
| `totalEntries` | integer >= 0 | Number of entries in the bibliography. |
| `verified` | integer >= 0 | Entries with `existence.status = "verified"`. |
| `metadataMismatches` | integer >= 0 | Entries with `existence.status = "metadata-mismatch"`. |
| `notFoundInDatabases` | integer >= 0 | Entries absent from all applicable databases. A fabrication signal; gates by default. **NEW in 0.2.0.** |
| `malformedIdentifiers` | integer >= 0 | Entries with at least one malformed/bad-checksum identifier in the `identifiers` layer. A cheap fabrication signal; gates by default. **NEW in 0.2.0.** |
| `unverifiable` | integer >= 0 | Entries with `existence.status = "unverifiable"`. |
| `canonicalIssues` | integer >= 0 | Entries with a canonical status other than `"verified-canonical"` or `"not-applicable"`. |
| `linkageFailures` | integer >= 0 | Count of unresolved citekey references. Must equal `linkage.filter(l => l.status === "unresolved").length`. Orphans (`status = "orphan"`) are NOT counted here. |
| `phraseFlags` | integer >= 0 | Count of phrase flags with `status = "flagged"` (acknowledged matches excluded). |
| `worklistItems` | integer >= 0 | Count of worklist items. Must equal `worklist.length`. |
| `orphanedEntries` | integer >= 0 (optional) | Count of bibliography entries never cited in any doc (`linkage.filter(l => l.status === "orphan").length`). **Informational — does NOT gate** the build. Optional and additive. **NEW in 0.3.0.** |

### `entries`

Type: array of `Entry` objects

One entry per bibliography record. Indexed by `citekey`.

#### `Entry`

| Field | Type | Description |
|-------|------|-------------|
| `citekey` | string (non-empty) | The CSL-JSON `id` field used to cite this entry. |
| `identifiers` | `IdentifiersLayer` or null | Local identifier well-formedness findings (pre-network). Null when not run. **NEW in 0.2.0.** |
| `existence` | `ExistenceLayer` or null | Existence check findings. Null when the existence subcommand was not run. |
| `canonical` | `CanonicalLayer` or null | Canonical-edition URL findings. Null when the canonical subcommand was not run. |

#### `IdentifiersLayer`

Layer 0: local, pre-network well-formedness validation. Runs before any
network call; a malformed or bad-checksum identifier short-circuits the
existence lookup and gates by default. **NEW in 0.2.0.**

| Field | Type | Description |
|-------|------|-------------|
| `doi` | `IdentifierStatus` | `"malformed"` if the DOI fails the `^10.\d{4,}/\S+$` pattern. |
| `isbn` | `IdentifierStatus` | `"bad-checksum"` for a failed ISBN-10/13 check digit; `"malformed"` for bad shape. |
| `url` | `IdentifierStatus` | `"malformed"` if the URL is not a well-formed http/https URL. |

#### `ExistenceLayer`

| Field | Type | Description |
|-------|------|-------------|
| `status` | `ExistenceStatus` | Aggregate existence status (see enum table below). |
| `evidence` | `ExistenceEvidence` | Defined evidence vocabulary (see enum table below). Distinct from the bare `status` rollup; prevents LLM-agent consumers from reading `verified` as "claim is sound." **NEW in 0.2.0.** |
| `checkedFor` | `CheckDimension[]` | Dimensions that were checked, e.g. `["existence","metadata"]`. **NEW in 0.2.0.** |
| `notCheckedFor` | `CheckDimension[]` | Dimensions that were NOT checked. Always includes `"claim-support"` (bibcheck never verifies whether the source supports the prose's claim; that is the manual worklist's job). **NEW in 0.2.0.** |
| `checks` | `ExistenceCheck[]` | Per-source check results. |
| `error` | string or null | Set when the layer crashed (all sources were transport errors), so consumers can distinguish "we ran and found nothing applicable" from "we failed to run." Null when the layer ran cleanly. **NEW in 0.2.0.** |

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

One entry per citekey encountered in the scanned markdown files, plus one
`orphan` entry per bibliography citekey that no document references (reverse
linkage). **NEW in 0.3.0:** orphan entries.

#### `LinkageEntry`

| Field | Type | Description |
|-------|------|-------------|
| `citekey` | string (non-empty) | The citekey (referenced in prose, in the bibliography, or both). |
| `status` | `LinkageStatus` | `resolved`, `unresolved`, or `orphan` (see enum table). |
| `references` | array of `LinkageReference` | All locations in markdown where this citekey appears. Empty for `orphan` entries (they are never cited). |

##### `LinkageReference`

| Field | Type | Description |
|-------|------|-------------|
| `file` | string (non-empty) | Relative path to the markdown file. |
| `line` | integer > 0 | Line number where the `@citekey` reference appears. |
| `locator` | string or null (optional) | Citation locator, e.g. `"p. 42"`, `"pp. 33–35"`. **NEW in 0.2.0.** |
| `authorSuppressed` | boolean (optional) | True when the citation suppressed the author, e.g. `-@key`. **NEW in 0.2.0.** |

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
Each item carries `notCheckedFor: ["claim-support"]` on its associated
existence layer, stating explicitly that whether the source supports the prose's
claim is not automated.

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
| `locator` | string or null (optional) | Citation locator, e.g. `"p. 42"`, `"pp. 33–35"`. **NEW in 0.2.0.** |

---

## Enum tables

### `IdentifierStatus`

| Value | Description |
|-------|-------------|
| `"ok"` | Identifier is present and well-formed. |
| `"malformed"` | Identifier is present but fails structural validation (DOI pattern, URL scheme). |
| `"bad-checksum"` | ISBN is structurally valid but check-digit verification fails. |
| `"not-applicable"` | No identifier of this type is present on the entry. |

### `ExistenceStatus`

| Value | Description |
|-------|-------------|
| `"verified"` | At least one database confirmed the entry exists and metadata matches. |
| `"metadata-mismatch"` | A database found the DOI/ISBN but title/author metadata does not agree. |
| `"not-found-in-databases"` | No database returned a positive match; absence is a fabrication signal and gates by default. |
| `"unverifiable"` | The entry has no DOI or ISBN and no title search returned a confident match. Does not gate. |

### `ExistenceEvidence`

Defined evidence vocabulary distinct from the bare `status` rollup. Prevents
an LLM-agent consumer from reading `"verified"` as "the citation's claim is
sound." There is no numeric confidence score. **NEW in 0.2.0.**

| Value | Description |
|-------|-------------|
| `"exists-metadata-match"` | Found in a database and metadata (title, first author) agrees. |
| `"exists-metadata-mismatch"` | Found in a database, but metadata does not agree. |
| `"absent"` | Confirmed not found in all applicable databases. A fabrication signal. |
| `"unverifiable"` | No applicable identifier, or all sources returned transport errors. |

### `CheckDimension`

The verification dimensions bibcheck can report on. Used by `checkedFor` and
`notCheckedFor` to state explicitly what was and was not checked. **NEW in
0.2.0.**

| Value | Description |
|-------|-------------|
| `"existence"` | Whether the work exists in a database. |
| `"metadata"` | Whether the database's title and first-author agree with the bibliography entry. |
| `"canonical-url"` | Whether the entry's URL points to a trusted canonical-edition host. |
| `"claim-support"` | Whether the source supports the prose's assertion. Always in `notCheckedFor`; this is the manual worklist's job. |

### `ExistenceCheckSource`

| Value | Description |
|-------|-------------|
| `"crossref"` | CrossRef DOI registry. |
| `"openalex"` | OpenAlex bibliographic metadata. |
| `"openlibrary"` | Open Library ISBN catalogue. |

### `ExistenceCheckResult`

| Value | Description |
|-------|-------------|
| `"no-doi"` | The entry has no DOI or ISBN and no applicable identifier; this source was not queried. |
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
| `"resolved"` | The citekey appears in prose AND in the bibliography. |
| `"unresolved"` | The citekey appears in prose but NOT in the bibliography. Gates the build. |
| `"orphan"` | The citekey appears in the bibliography but is never referenced in any doc (reverse linkage). Informational; does NOT gate. **NEW in 0.3.0.** |

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

- **Additive changes** (new optional fields, new enum members on otherwise-open
  types) bump the **minor** part and remain backward-compatible. Consumers
  pinning to `/^0\.\d+\.\d+$/` continue to validate.
- **Renames, removals, or changed semantics** bump the **major** part.
  Consumers pinning a major version are insulated from such changes.

The `schemaVersion` field is independent of the package version. A patch
release of the bibcheck package may carry no schema change; a minor schema
change may be shipped in a patch package release if it is purely additive.

---

## What changed in 0.3.0

- **`orphan` linkage status** added to `LinkageStatus`. A bibliography citekey
  that is never referenced in any document is emitted as a `LinkageEntry` with
  `status = "orphan"` and an empty `references` array (the inverse of
  `unresolved`). It catches LLM-padded reference lists.
- **`orphanedEntries` summary counter** added (optional, additive): the count
  of `orphan` linkage entries.
- **Orphans are informational and do NOT gate `bibcheck check`.** An uncited
  bibliography entry is a smell, not proof of fabrication, and gating it would
  train users to disable the check. The `linkageFailures` invariant continues
  to count only `unresolved` entries.

## What changed in 0.2.0

- **`identifiers` layer** added to each `Entry`: local, pre-network
  well-formedness validation of DOI (pattern), ISBN (check digit), and URL
  (scheme). Runs before any network call; a malformed identifier short-circuits
  the existence lookup.
- **`existence` layer expanded**: added `evidence` (discrete evidence
  vocabulary), `checkedFor`, `notCheckedFor`, and `error` fields. The
  `notCheckedFor: ["claim-support"]` annotation is machine-readable proof that
  existence verification does not imply claim support.
- **`summary` counters added**: `notFoundInDatabases` and `malformedIdentifiers`
  (both gate by default). The four existence buckets (`verified`,
  `metadataMismatches`, `notFoundInDatabases`, `unverifiable`) are now required
  to sum to `totalEntries`.
- **`ExistenceCheckSource` reduced**: the keyless OCLC Classify endpoint
  (previously used for ISBN classification) was decommissioned in 2019 and has
  been removed. ISBN existence is covered by OpenLibrary. The valid sources are
  now `"crossref"`, `"openalex"`, and `"openlibrary"` only.
- **`LinkageReference` and `WorklistItem`** gained optional `locator` and
  `authorSuppressed` fields to capture Pandoc-style citation syntax.
