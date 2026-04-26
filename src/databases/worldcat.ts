/**
 * WorldCat ISBN lookup client (v0.1: OCLC Classify legacy endpoint).
 *
 * v0.1 uses the OCLC Classify API at:
 *   http://classify.oclc.org/classify2/api?isbn=<isbn>&summary=true
 *
 * IMPORTANT: This endpoint uses HTTP (not HTTPS). The response is bibliographic
 * metadata only and contains no credentials, but response integrity is not
 * guaranteed over a plaintext connection. This is an accepted v0.1 limitation.
 * Migrate to the OCLC Discovery API (HTTPS + OAuth2) in v0.2 when apiKey
 * support is implemented.
 *
 * The Classify API returns XML by default. We request JSON via Accept header.
 * If the response is nonetheless XML (string), we perform a minimal regex parse
 * for <work title="..." author="..."> — acceptable for v0.1 (documented kludge).
 */

import type { HttpClient, HttpResponse } from '../http.js';
import type { Cache } from '../cache/fs-cache.js';
import type { DatabaseLookupResult, DatabaseClient } from './crossref.js';

export type { DatabaseLookupResult, DatabaseClient };

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface WorldCatClientOptions {
  http: HttpClient;
  cache: Cache;
  apiKey?: string | null; // reserved for v0.2 OAuth2; unused in v0.1
}

export interface WorldCatClient extends DatabaseClient {
  readonly name: 'worldcat';
  lookupByIsbn(isbn: string, signal?: AbortSignal): Promise<DatabaseLookupResult>;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ClassifyJsonWork {
  title?: string;
  author?: string;
}

interface ClassifyJsonResponse {
  classify?: {
    works?: {
      work?: ClassifyJsonWork | ClassifyJsonWork[];
    };
    work?: ClassifyJsonWork;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isClassifyJsonResponse(body: unknown): body is ClassifyJsonResponse {
  return typeof body === 'object' && body !== null;
}

/**
 * Minimal XML parse for OCLC Classify XML responses.
 * Extracts title and author from the first <work title="..." author="..."> element.
 * This is a v0.1 kludge; full XML parsing is deferred to v0.2.
 */
function parseClassifyXml(xml: string): { title?: string; author?: string } | null {
  // Match both <work ... title="..." author="..."> and with attributes in any order.
  const workMatch = /<work\b([^>]*)>/i.exec(xml);
  if (!workMatch?.[1]) return null;

  const attrs = workMatch[1];

  const titleMatch = /\btitle="([^"]*)"/.exec(attrs);
  const authorMatch = /\bauthor="([^"]*)"/.exec(attrs);

  if (!titleMatch && !authorMatch) return null;

  return {
    title: titleMatch?.[1],
    author: authorMatch?.[1],
  };
}

/**
 * Determine whether there are zero works in a Classify JSON response.
 * The Classify API returns an empty work list or a specific responseCode when
 * no records are found.
 */
function hasClassifyWork(body: ClassifyJsonResponse): ClassifyJsonWork | null {
  const classify = body.classify;
  if (!classify) return null;

  // Single-work response.
  if (classify.work && typeof classify.work === 'object') {
    return classify.work;
  }

  // Multi-work summary: works.work may be an array or single object.
  if (classify.works?.work) {
    const w = classify.works.work;
    if (Array.isArray(w)) {
      return w[0] ?? null;
    }
    return w;
  }

  return null;
}

function mapClassifyMetadata(
  work: { title?: string; author?: string },
  isbn: string,
): DatabaseLookupResult['metadata'] {
  const authors = work.author ? [work.author] : undefined;
  return {
    title: work.title,
    authors,
    isbn,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createWorldCatClient(opts: WorldCatClientOptions): WorldCatClient {
  const { http, cache } = opts;
  // apiKey is reserved for v0.2; ignored in v0.1.

  async function lookupByIsbn(isbn: string, signal?: AbortSignal): Promise<DatabaseLookupResult> {
    const cacheKey = `worldcat:lookupByIsbn:${isbn}`;

    const cached = await cache.get<DatabaseLookupResult>(cacheKey, signal);
    if (cached !== null) {
      return cached;
    }

    // v0.1: HTTP (not HTTPS) — legacy Classify endpoint does not support HTTPS.
    const url = `http://classify.oclc.org/classify2/api?isbn=${encodeURIComponent(isbn)}&summary=true`;

    let response: HttpResponse;
    try {
      response = await http.get(url, {
        signal,
        headers: { Accept: 'application/json' },
      });
    } catch (err) {
      throw err;
    }

    if (response.status === 404) {
      return { found: false, metadata: null, raw: response.body };
    }

    // Handle XML fallback (response body is a string when Content-Type is not JSON).
    if (typeof response.body === 'string') {
      const parsed = parseClassifyXml(response.body);
      if (!parsed || (!parsed.title && !parsed.author)) {
        const result: DatabaseLookupResult = {
          found: false,
          metadata: null,
          raw: response.body,
        };
        await cache.set(cacheKey, result);
        return result;
      }

      const metadata = mapClassifyMetadata(parsed, isbn);
      const result: DatabaseLookupResult = { found: true, metadata, raw: response.body };
      await cache.set(cacheKey, result);
      return result;
    }

    // JSON response path.
    if (!isClassifyJsonResponse(response.body)) {
      throw new Error(`WorldCat: unexpected response body for ISBN "${isbn}"`);
    }

    const work = hasClassifyWork(response.body);
    if (!work) {
      const result: DatabaseLookupResult = {
        found: false,
        metadata: null,
        raw: response.body,
      };
      await cache.set(cacheKey, result);
      return result;
    }

    const metadata = mapClassifyMetadata(work, isbn);
    const result: DatabaseLookupResult = { found: true, metadata, raw: response.body };
    await cache.set(cacheKey, result);
    return result;
  }

  return {
    name: 'worldcat' as const,
    lookupByIsbn,
  };
}
