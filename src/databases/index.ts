/**
 * Barrel re-export for all four bibliographic database clients.
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

export { createWorldCatClient } from './worldcat.js';
export type { WorldCatClientOptions, WorldCatClient } from './worldcat.js';
