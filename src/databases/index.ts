/**
 * Barrel re-export for the bibliographic database clients (CrossRef,
 * OpenAlex, OpenLibrary). WorldCat / OCLC Classify was removed in 0.2.0
 * (decommissioned endpoint; see tmp/design-review/worldcat.md).
 */

export {
  createCrossRefClient,
  stripMailto,
  sanitizeMailto,
} from './crossref.js';
export type {
  DatabaseLookupResult,
  DatabaseClient,
  CrossRefClientOptions,
  CrossRefClient,
} from './crossref.js';

export { createOpenAlexClient } from './openalex.js';
export type { OpenAlexClientOptions, OpenAlexClient } from './openalex.js';

export { createOpenLibraryClient } from './openlibrary.js';
export type { OpenLibraryClientOptions, OpenLibraryClient } from './openlibrary.js';
