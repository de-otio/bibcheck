/**
 * bibcheck output JSON schema — the contract consumers (LLM agents, CI tools,
 * editor integrations) read.
 *
 * Versioned independently of the package version via `SCHEMA_VERSION` below.
 * Bumping rules:
 *   - Additive changes (new optional fields, new enum members on otherwise-open
 *     types) bump the minor part and remain backward-compatible.
 *   - Renames, removals, or changed semantics bump the major part; consumers
 *     pinning a major version are insulated.
 *
 * Authoritative documentation is the Zod schemas in this file. The published
 * JSON Schema in `docs/output-schema.md` (when generated) is derived from
 * these definitions, not maintained by hand.
 */

import { z } from 'zod';

/** Current bibcheck output schema version. Independent of the package version. */
export const SCHEMA_VERSION = '0.1.0' as const;

/**
 * Accepts any URL whose scheme is http or https. Rejects non-web schemes
 * such as `javascript:`, `file://`, `data:`, and `ftp://`.
 */
const httpUrl = () =>
  z.string().url().refine((u) => /^https?:\/\//i.test(u), {
    message: 'Only http/https URLs are accepted',
  });

// ---------------------------------------------------------------------------
// Tool info
// ---------------------------------------------------------------------------

export const ToolInfoSchema = z.object({
  name: z.literal('bibcheck'),
  version: z.string().min(1),
});
export type ToolInfo = z.infer<typeof ToolInfoSchema>;

// ---------------------------------------------------------------------------
// Summary counts
// ---------------------------------------------------------------------------

export const SummarySchema = z.object({
  totalEntries: z.number().int().nonnegative(),
  verified: z.number().int().nonnegative(),
  metadataMismatches: z.number().int().nonnegative(),
  unverifiable: z.number().int().nonnegative(),
  canonicalIssues: z.number().int().nonnegative(),
  linkageFailures: z.number().int().nonnegative(),
  phraseFlags: z.number().int().nonnegative(),
  worklistItems: z.number().int().nonnegative(),
});
export type Summary = z.infer<typeof SummarySchema>;

// ---------------------------------------------------------------------------
// Layer 1: existence (commodity convenience layer)
//
// DOI / ISBN / title-search lookup against CrossRef, OpenAlex, OpenLibrary,
// WorldCat. A thin direct-fetch wrapper, not a heavyweight resolver.
// ---------------------------------------------------------------------------

export const ExistenceCheckSourceSchema = z.enum([
  'crossref',
  'openalex',
  'openlibrary',
  'worldcat',
]);
export type ExistenceCheckSource = z.infer<typeof ExistenceCheckSourceSchema>;

export const ExistenceCheckResultSchema = z.enum([
  'no-doi',
  'found',
  'not-found',
  'metadata-mismatch',
  'error',
]);
export type ExistenceCheckResult = z.infer<typeof ExistenceCheckResultSchema>;

export const ExistenceCheckSchema = z.object({
  source: ExistenceCheckSourceSchema,
  result: ExistenceCheckResultSchema,
  /** Source-specific evidence. Shape varies per source; not strictly typed. */
  evidence: z.unknown().nullable(),
});
export type ExistenceCheck = z.infer<typeof ExistenceCheckSchema>;

export const ExistenceStatusSchema = z.enum([
  'verified',
  'metadata-mismatch',
  'not-found-in-databases',
  'unverifiable',
]);
export type ExistenceStatus = z.infer<typeof ExistenceStatusSchema>;

export const ExistenceLayerSchema = z.object({
  status: ExistenceStatusSchema,
  checks: z.array(ExistenceCheckSchema),
});
export type ExistenceLayer = z.infer<typeof ExistenceLayerSchema>;

// ---------------------------------------------------------------------------
// Layer 1: canonical-edition URL verification (differentiated)
//
// For pre-DOI primary sources, checks that each entry's `url:` field points
// to a trusted canonical-edition host (HathiTrust, Internet Archive, Liberty
// Fund OLL, plato.stanford.edu/archives, PhilPapers, national-library
// catalogues, project-extensible) and that the URL is live.
// ---------------------------------------------------------------------------

export const CanonicalStatusSchema = z.enum([
  'verified-canonical',
  'wrong-host',
  'dead-url',
  'live-url-not-archived-snapshot',
  'no-url-on-pre-doi-entry',
  'not-applicable',
]);
export type CanonicalStatus = z.infer<typeof CanonicalStatusSchema>;

export const CanonicalLayerSchema = z.object({
  status: CanonicalStatusSchema,
  url: httpUrl().nullable(),
  /** Redirect chain, in order, if HEAD followed redirects. */
  redirectChain: z.array(httpUrl()).optional(),
});
export type CanonicalLayer = z.infer<typeof CanonicalLayerSchema>;

// ---------------------------------------------------------------------------
// Per-entry record
// ---------------------------------------------------------------------------

export const EntrySchema = z.object({
  citekey: z.string().min(1),
  /** Layer 1 existence findings (commodity layer). Null when not run. */
  existence: ExistenceLayerSchema.nullable(),
  /** Layer 1 canonical-edition findings (differentiated layer). Null when not run. */
  canonical: CanonicalLayerSchema.nullable(),
});
export type Entry = z.infer<typeof EntrySchema>;

// ---------------------------------------------------------------------------
// Layer 1 (structural): linkage
//
// Every `@citekey` reference in the docs has an entry in the bibliography.
// Deterministic equivalent of pandoc-citeproc's render-time warning.
// ---------------------------------------------------------------------------

export const LinkageStatusSchema = z.enum(['resolved', 'unresolved']);
export type LinkageStatus = z.infer<typeof LinkageStatusSchema>;

export const LinkageReferenceSchema = z.object({
  file: z.string().min(1),
  line: z.number().int().positive(),
});
export type LinkageReference = z.infer<typeof LinkageReferenceSchema>;

export const LinkageEntrySchema = z.object({
  citekey: z.string().min(1),
  status: LinkageStatusSchema,
  references: z.array(LinkageReferenceSchema),
});
export type LinkageEntry = z.infer<typeof LinkageEntrySchema>;

// ---------------------------------------------------------------------------
// Phrase denylist matches
//
// Regex pass over prose against a project-supplied phrase denylist (loaded
// via `[phrases] file = "..."` in bibcheck.toml). bibcheck does not ship a
// baseline; the feature is a configurable lint, not curated guidance.
//
// A match without an explicit `<!-- bibcheck-allow: <key> -->` acknowledgement
// is reported as `flagged`; matches with the acknowledgement are reported as
// `acknowledged` (informational).
// ---------------------------------------------------------------------------

export const PhraseFlagStatusSchema = z.enum([
  'flagged',
  'acknowledged',
]);
export type PhraseFlagStatus = z.infer<typeof PhraseFlagStatusSchema>;

export const PhraseFlagSchema = z.object({
  status: PhraseFlagStatusSchema,
  /** Stable key naming the denylist pattern that matched. */
  patternKey: z.string().min(1),
  /** Optional project-supplied URL — typically a doc explaining why this phrase is denylisted. */
  referenceUrl: httpUrl().nullable(),
  file: z.string().min(1),
  line: z.number().int().positive(),
  /** The substring of the prose that matched the pattern. */
  matchedText: z.string().min(1),
});
export type PhraseFlag = z.infer<typeof PhraseFlagSchema>;

// ---------------------------------------------------------------------------
// Layer 2 / Layer 3: human-triage worklist
//
// Items emitted by bibcheck for manual verification. The tool does not
// attempt to resolve these; the worklist is the bridge between automated
// and manual layers of the policy.
// ---------------------------------------------------------------------------

export const WorklistItemTypeSchema = z.enum([
  /** A direct quotation needs to be verified verbatim against the source. */
  'direct-quotation',
  /** A paraphrase attached to a page or section reference needs to be checked. */
  'paraphrase-with-page-ref',
  /** Cited source is on a contested-coverage source-type (Wikipedia, blog, preprint). */
  'contested-source-type',
  /** Citation references a non-canonical edition where a canonical one exists. */
  'non-canonical-edition',
]);
export type WorklistItemType = z.infer<typeof WorklistItemTypeSchema>;

export const WorklistItemSchema = z.object({
  type: WorklistItemTypeSchema,
  file: z.string().min(1),
  line: z.number().int().positive(),
  /** The citation invocation in the prose, e.g., `@mill1859onliberty`. */
  citation: z.string().min(1),
  /** Excerpt of prose around the citation, for context. */
  snippet: z.string().min(1),
  /** Pre-filled URL the human can use to perform the manual check. */
  verificationUrl: httpUrl().nullable(),
  /** Human-readable description of what the manual check should establish. */
  recommendedAction: z.string().min(1),
});
export type WorklistItem = z.infer<typeof WorklistItemSchema>;

// ---------------------------------------------------------------------------
// Top-level output
//
// schemaVersion: Validation accepts any `0.x.y` document; the runtime tool
// emits the current `SCHEMA_VERSION`. Bumping rules: additive minor bump
// remains backward-compatible (consumers continue to validate); a major bump
// (1.x.y) breaks pinned consumers.
// ---------------------------------------------------------------------------

export const OutputSchema = z
  .object({
    schemaVersion: z.string().regex(/^0\.\d+\.\d+$/, 'Major version 0 expected'),
    tool: ToolInfoSchema,
    summary: SummarySchema,
    entries: z.array(EntrySchema),
    linkage: z.array(LinkageEntrySchema),
    phraseFlags: z.array(PhraseFlagSchema),
    worklist: z.array(WorklistItemSchema),
  })
  .superRefine((o, ctx) => {
    if (o.summary.verified > o.summary.totalEntries) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['summary', 'verified'],
        message: `verified (${o.summary.verified}) cannot exceed totalEntries (${o.summary.totalEntries})`,
      });
    }
    if (o.summary.metadataMismatches > o.summary.totalEntries) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['summary', 'metadataMismatches'],
        message: `metadataMismatches (${o.summary.metadataMismatches}) cannot exceed totalEntries (${o.summary.totalEntries})`,
      });
    }
    if (o.summary.unverifiable > o.summary.totalEntries) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['summary', 'unverifiable'],
        message: `unverifiable (${o.summary.unverifiable}) cannot exceed totalEntries (${o.summary.totalEntries})`,
      });
    }
    if (o.summary.canonicalIssues > o.summary.totalEntries) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['summary', 'canonicalIssues'],
        message: `canonicalIssues (${o.summary.canonicalIssues}) cannot exceed totalEntries (${o.summary.totalEntries})`,
      });
    }
    if (o.summary.phraseFlags !== o.phraseFlags.filter(f => f.status === 'flagged').length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['summary', 'phraseFlags'],
        message: `summary.phraseFlags (${o.summary.phraseFlags}) must equal the count of flagged (not acknowledged) entries in phraseFlags array`,
      });
    }
    if (o.summary.worklistItems !== o.worklist.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['summary', 'worklistItems'],
        message: `summary.worklistItems must equal worklist.length`,
      });
    }
    if (o.summary.linkageFailures !== o.linkage.filter(l => l.status === 'unresolved').length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['summary', 'linkageFailures'],
        message: `summary.linkageFailures must equal the count of unresolved linkage entries`,
      });
    }
  });
export type Output = z.infer<typeof OutputSchema>;
