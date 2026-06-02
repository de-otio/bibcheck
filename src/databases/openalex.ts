/**
 * OpenAlex works client.
 *
 * Supports DOI lookup and title+author search against the OpenAlex API
 * (https://api.openalex.org/works). Polite pool is engaged via ?mailto=.
 * Results are cached at default TTL (30 days).
 *
 * Sanitization: ?mailto= is stripped from any URL strings in the raw response.
 */

import type { HttpClient, HttpResponse } from '../http.js';
import type { Cache } from '../cache/fs-cache.js';
import type { DatabaseLookupResult, DatabaseClient } from './crossref.js';
import { stripMailto, sanitizeMailto, trimTrailingSlash } from './crossref.js';

// Re-export so consumers can import from this module too.
export type { DatabaseLookupResult, DatabaseClient };

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface OpenAlexClientOptions {
  http: HttpClient;
  cache: Cache;
  mailto?: string | null;
  /** Base URL for the OpenAlex API. Defaults to the public endpoint. */
  baseUrl?: string;
}

const DEFAULT_OPENALEX_BASE = 'https://api.openalex.org';

export interface OpenAlexClient extends DatabaseClient {
  readonly name: 'openalex';
  searchByTitleAuthor(
    title: string,
    authors: string[],
    signal?: AbortSignal,
  ): Promise<DatabaseLookupResult>;
  lookupByDoi(doi: string, signal?: AbortSignal): Promise<DatabaseLookupResult>;
}

// ---------------------------------------------------------------------------
// Internal API response types
// ---------------------------------------------------------------------------

interface OpenAlexAuthorship {
  author?: {
    display_name?: string;
  };
}

interface OpenAlexWork {
  display_name?: string;
  authorships?: OpenAlexAuthorship[];
  publication_year?: number;
  doi?: string;
  id?: string;
}

interface OpenAlexSearchResponse {
  results?: OpenAlexWork[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Re-export stripMailto for tests.
export { stripMailto };

function sanitizeRaw(value: unknown): unknown {
  return sanitizeMailto(value);
}

function isOpenAlexWork(body: unknown): body is OpenAlexWork {
  if (typeof body !== 'object' || body === null) return false;
  return true;
}

function isOpenAlexSearchResponse(body: unknown): body is OpenAlexSearchResponse {
  if (typeof body !== 'object' || body === null) return false;
  return true;
}

function mapWorkMetadata(work: OpenAlexWork): DatabaseLookupResult['metadata'] {
  const authors = work.authorships
    ?.map((a) => a.author?.display_name ?? '')
    .filter((n) => n.length > 0);

  return {
    title: work.display_name,
    authors: authors && authors.length > 0 ? authors : undefined,
    issued: typeof work.publication_year === 'number' ? work.publication_year : undefined,
    doi: work.doi,
    url: work.id,
  };
}

function appendMailto(url: string, mailto: string | null | undefined): string {
  if (!mailto) return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}mailto=${encodeURIComponent(mailto)}`;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createOpenAlexClient(opts: OpenAlexClientOptions): OpenAlexClient {
  const { http, cache, mailto } = opts;
  const base = trimTrailingSlash(opts.baseUrl ?? DEFAULT_OPENALEX_BASE);

  async function lookupByDoi(doi: string, signal?: AbortSignal): Promise<DatabaseLookupResult> {
    const cacheKey = `openalex:lookupByDoi:${doi.toLowerCase()}`;

    const cached = await cache.get<DatabaseLookupResult>(cacheKey, signal);
    if (cached !== null) {
      return cached;
    }

    const encoded = encodeURIComponent(doi);
    const baseUrl = `${base}/works/doi:${encoded}`;
    const url = appendMailto(baseUrl, mailto);

    let response: HttpResponse;
    response = await http.get(url, { signal });

    if (response.status === 404) {
      return { found: false, metadata: null, raw: sanitizeRaw(response.body) };
    }

    if (!isOpenAlexWork(response.body)) {
      throw new Error(`OpenAlex: unexpected response body for DOI "${doi}"`);
    }

    const sanitizedRaw = sanitizeRaw(response.body);
    const metadata = mapWorkMetadata(response.body);

    const result: DatabaseLookupResult = { found: true, metadata, raw: sanitizedRaw };
    await cache.set(cacheKey, result);
    return result;
  }

  async function searchByTitleAuthor(
    title: string,
    authors: string[],
    signal?: AbortSignal,
  ): Promise<DatabaseLookupResult> {
    const firstAuthor = authors[0] ?? '';
    const cacheKey = `openalex:searchByTitleAuthor:${title.toLowerCase()}:${firstAuthor.toLowerCase()}`;

    const cached = await cache.get<DatabaseLookupResult>(cacheKey, signal);
    if (cached !== null) {
      return cached;
    }

    const baseUrl = `${base}/works?search=${encodeURIComponent(title)}&filter=author.display_name.search:${encodeURIComponent(firstAuthor)}&per-page=5`;
    const url = appendMailto(baseUrl, mailto);

    let response: HttpResponse;
    response = await http.get(url, { signal });

    if (response.status === 404) {
      return { found: false, metadata: null, raw: sanitizeRaw(response.body) };
    }

    if (!isOpenAlexSearchResponse(response.body)) {
      throw new Error(`OpenAlex: unexpected search response for title "${title}"`);
    }

    const results = response.body.results;
    const firstResult = results?.[0];

    if (!firstResult) {
      const result: DatabaseLookupResult = {
        found: false,
        metadata: null,
        raw: sanitizeRaw(response.body),
      };
      await cache.set(cacheKey, result);
      return result;
    }

    const sanitizedRaw = sanitizeRaw(response.body);
    const metadata = mapWorkMetadata(firstResult);
    const result: DatabaseLookupResult = { found: true, metadata, raw: sanitizedRaw };
    await cache.set(cacheKey, result);
    return result;
  }

  return {
    name: 'openalex' as const,
    lookupByDoi,
    searchByTitleAuthor,
  };
}
