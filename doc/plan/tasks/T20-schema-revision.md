# T20 — Output-schema revision (and re-freeze)

**Phase:** 5 (Hallucination-hardening)
**Complexity:** medium
**Depends on:** —
**Blocks:** T21, T22, T23, T25, T26

## Scope

Revise `src/schema/output.ts` — the contract every renderer and consumer reads —
to support the Phase 5 changes, then re-freeze it. This ticket **only** touches
the schema (+ its tests and the generated docs stub); behaviour lands in the
dependent tickets. Because v0.1 is **unreleased**, there are no pinned consumers
to break: incorporate all changes directly into the v0.1 contract rather than
carrying compatibility shims. Bump `SCHEMA_VERSION` to `0.2.0` to mark the
revision (the package version is independent).

> This ticket lifts the "schema is frozen for v0.1" rule for the duration of
> Phase 5. Re-assert the freeze note at the end (see acceptance criteria).

## Files

- `src/schema/output.ts` — the schema.
- `test/schema.test.ts` — schema unit tests (extend).
- `docs/output-schema.md` — regenerate/annotate (or leave a TODO for T26).

## Changes

### 1. Remove WorldCat from the source enum (see T22, `worldcat.md`)

```ts
export const ExistenceCheckSourceSchema = z.enum([
  'crossref',
  'openalex',
  'openlibrary',
  // 'worldcat' REMOVED — OCLC Classify retired 2019; see tmp/design-review/worldcat.md
]);
```

### 2. Evidence vocabulary + verification-boundary fields (Q2)

Add a defined evidence enum and explicit "what was / wasn't checked" arrays to
the existence layer, so an LLM-agent consumer cannot read `verified` as
"the citation's claim is sound." **No numeric confidence score** (barred by the
project's design defaults).

```ts
export const ExistenceEvidenceSchema = z.enum([
  'exists-metadata-match',     // found + metadata agrees
  'exists-metadata-mismatch',  // found, but metadata differs
  'absent',                    // confirmed not-found in all applicable databases
  'unverifiable',              // no applicable identifier, or all sources errored
]);
export type ExistenceEvidence = z.infer<typeof ExistenceEvidenceSchema>;

export const CheckDimensionSchema = z.enum([
  'existence', 'metadata', 'canonical-url', 'claim-support',
]);

export const ExistenceLayerSchema = z.object({
  status: ExistenceStatusSchema,            // unchanged; gating-relevant rollup
  evidence: ExistenceEvidenceSchema,        // NEW: defined vocabulary
  checkedFor: z.array(CheckDimensionSchema),     // NEW: e.g. ['existence','metadata']
  notCheckedFor: z.array(CheckDimensionSchema),  // NEW: always includes 'claim-support'
  checks: z.array(ExistenceCheckSchema),
  error: z.string().nullable().optional(),  // NEW (also S1): distinguish crash from clean
});
```

`notCheckedFor` MUST always contain `'claim-support'` for v0.1 — bibcheck never
checks whether the source supports the prose's claim; that's the manual worklist.

### 3. New identifiers layer (Q5 / T21)

A per-entry layer for local (pre-network) identifier well-formedness, distinct
from existence. Sibling to `existence` and `canonical` on `EntrySchema`.

```ts
export const IdentifierStatusSchema = z.enum([
  'ok', 'malformed', 'bad-checksum', 'not-applicable',
]);

export const IdentifiersLayerSchema = z.object({
  doi: IdentifierStatusSchema,   // 'malformed' if fails ^10\.\d{4,}/\S+$
  isbn: IdentifierStatusSchema,  // 'bad-checksum' for failed ISBN-10/13 check digit
  url: IdentifierStatusSchema,   // 'malformed' if not a well-formed http/https URL
});
export type IdentifiersLayer = z.infer<typeof IdentifiersLayerSchema>;

export const EntrySchema = z.object({
  citekey: z.string().min(1),
  identifiers: IdentifiersLayerSchema.nullable(),  // NEW; null when not run
  existence: ExistenceLayerSchema.nullable(),
  canonical: CanonicalLayerSchema.nullable(),
});
```

### 4. Summary: count not-found, reconcile (Q1 / B1)

```ts
export const SummarySchema = z.object({
  totalEntries: z.number().int().nonnegative(),
  verified: z.number().int().nonnegative(),
  metadataMismatches: z.number().int().nonnegative(),
  notFoundInDatabases: z.number().int().nonnegative(),  // NEW
  malformedIdentifiers: z.number().int().nonnegative(),  // NEW (T21)
  unverifiable: z.number().int().nonnegative(),
  canonicalIssues: z.number().int().nonnegative(),
  linkageFailures: z.number().int().nonnegative(),
  phraseFlags: z.number().int().nonnegative(),
  worklistItems: z.number().int().nonnegative(),
});
```

Extend the `superRefine` block: add an invariant that
`verified + metadataMismatches + notFoundInDatabases + unverifiable === totalEntries`
(every entry lands in exactly one existence bucket), and that
`notFoundInDatabases` / `malformedIdentifiers` do not exceed `totalEntries`.

### 5. Locator fields for the citation-parser swap (T25)

Define the optional fields now so the frozen contract is ready; T25 populates them.

```ts
export const LinkageReferenceSchema = z.object({
  file: z.string().min(1),
  line: z.number().int().positive(),
  locator: z.string().nullable().optional(),         // NEW: 'p. 42', 'pp. 33-35'
  authorSuppressed: z.boolean().optional(),          // NEW: '-@key'
});
```

Add an optional `locator: z.string().nullable().optional()` to `WorklistItemSchema`.

### 6. Re-freeze

Update the header comment: bump `SCHEMA_VERSION` to `'0.2.0'`, document the new
fields in the bump-rules block, and restore the "frozen — changes require a
surfaced design decision" note.

## Acceptance criteria

- [ ] `worldcat` removed from `ExistenceCheckSourceSchema`.
- [ ] `evidence`, `checkedFor`, `notCheckedFor`, `error` added to `ExistenceLayerSchema`; `notCheckedFor` documented to always include `claim-support`.
- [ ] `IdentifiersLayerSchema` added and wired into `EntrySchema` (nullable).
- [ ] `notFoundInDatabases` + `malformedIdentifiers` summary counters added; reconciliation invariant enforced in `superRefine`.
- [ ] `locator` / `authorSuppressed` optional fields added to linkage + worklist.
- [ ] `SCHEMA_VERSION === '0.2.0'`; freeze note restored.
- [ ] No numeric confidence/score field anywhere.

## Tests

`test/schema.test.ts`:

- A valid `0.2.0` document round-trips through `OutputSchema`.
- The existence reconciliation invariant rejects a doc whose buckets don't sum to `totalEntries`.
- `notFoundInDatabases` exceeding `totalEntries` is rejected.
- An `IdentifiersLayer` with `isbn: 'bad-checksum'` validates.
- A doc carrying a stray `confidence` numeric field is **not** silently accepted (schema is strict/closed where it matters).
