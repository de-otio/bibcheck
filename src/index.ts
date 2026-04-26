/**
 * bibcheck — humanities-aware citation verification for CSL-JSON bibliographies.
 *
 * Library entry point. Re-exports the output schema for programmatic consumers.
 * For CLI use, see `cli.ts` and the `bibcheck` binary.
 */

export {
  SCHEMA_VERSION,
  ToolInfoSchema,
  SummarySchema,
  ExistenceCheckSourceSchema,
  ExistenceCheckResultSchema,
  ExistenceCheckSchema,
  ExistenceStatusSchema,
  ExistenceLayerSchema,
  CanonicalStatusSchema,
  CanonicalLayerSchema,
  EntrySchema,
  LinkageStatusSchema,
  LinkageReferenceSchema,
  LinkageEntrySchema,
  PhraseFlagStatusSchema,
  PhraseFlagSchema,
  WorklistItemTypeSchema,
  WorklistItemSchema,
  OutputSchema,
} from './schema/output.js';
export type {
  ToolInfo,
  Summary,
  ExistenceCheckSource,
  ExistenceCheckResult,
  ExistenceCheck,
  ExistenceStatus,
  ExistenceLayer,
  CanonicalStatus,
  CanonicalLayer,
  Entry,
  LinkageStatus,
  LinkageReference,
  LinkageEntry,
  PhraseFlagStatus,
  PhraseFlag,
  WorklistItemType,
  WorklistItem,
  Output,
} from './schema/output.js';
