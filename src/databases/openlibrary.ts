/**
 * OpenLibrary ISBN lookup client.
 *
 * Queries https://openlibrary.org/api/books?bibkeys=ISBN:<isbn>&format=json&jscmd=data
 * and returns normalised DatabaseLookupResult metadata. Results are cached at
 * the default TTL (30 days).
 *
 * An empty response object {} indicates no match (found: false). The client
 * does not use a polite-pool email (OpenLibrary has no such mechanism).
 */

import type { HttpClient, HttpResponse } from '../http.js';
import type { Cache } from '../cache/fs-cache.js';
import type { DatabaseLookupResult, DatabaseClient } from './crossref.js';

export type { DatabaseLookupResult, DatabaseClient };

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface OpenLibraryClientOptions {
  http: HttpClient;
  cache: Cache;
}

export interface OpenLibraryClient extends DatabaseClient {
  readonly name: 'openlibrary';
  lookupByIsbn(isbn: string, signal?: AbortSignal): Promise<DatabaseLookupResult>;
}

// ---------------------------------------------------------------------------
// Internal API response types
// ---------------------------------------------------------------------------

interface OpenLibraryAuthor {
  name?: string;
}

interface OpenLibraryPublisher {
  name?: string;
}

interface OpenLibraryBookData {
  title?: string;
  authors?: OpenLibraryAuthor[];
  publishers?: OpenLibraryPublisher[];
  publish_date?: string;
}

// The API returns an object keyed by "ISBN:<isbn>".
type OpenLibraryResponse = Record<string, OpenLibraryBookData>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isOpenLibraryResponse(body: unknown): body is OpenLibraryResponse {
  return typeof body === 'object' && body !== null && !Array.isArray(body);
}

function mapBookMetadata(book: OpenLibraryBookData, isbn: string): DatabaseLookupResult['metadata'] {
  const authors = book.authors?.map((a) => a.name ?? '').filter((n) => n.length > 0);

  const publisher = book.publishers?.[0]?.name;

  // publish_date is a free-form string like "January 2001" or "2001"; extract year.
  let issued: number | undefined;
  if (book.publish_date) {
    const match = /\b(\d{4})\b/.exec(book.publish_date);
    if (match?.[1] !== undefined) {
      const parsed = parseInt(match[1], 10);
      if (!isNaN(parsed)) {
        issued = parsed;
      }
    }
  }

  return {
    title: book.title,
    authors: authors && authors.length > 0 ? authors : undefined,
    issued,
    publisher,
    isbn,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createOpenLibraryClient(opts: OpenLibraryClientOptions): OpenLibraryClient {
  const { http, cache } = opts;

  async function lookupByIsbn(isbn: string, signal?: AbortSignal): Promise<DatabaseLookupResult> {
    const cacheKey = `openlibrary:lookupByIsbn:${isbn}`;

    const cached = await cache.get<DatabaseLookupResult>(cacheKey, signal);
    if (cached !== null) {
      return cached;
    }

    const url = `https://openlibrary.org/api/books?bibkeys=ISBN:${encodeURIComponent(isbn)}&format=json&jscmd=data`;

    let response: HttpResponse;
    response = await http.get(url, { signal });

    if (response.status === 404) {
      return { found: false, metadata: null, raw: response.body };
    }

    if (!isOpenLibraryResponse(response.body)) {
      throw new Error(`OpenLibrary: unexpected response body for ISBN "${isbn}"`);
    }

    const bookData = response.body[`ISBN:${isbn}`];
    if (bookData === undefined) {
      // Empty response or no matching entry.
      const result: DatabaseLookupResult = { found: false, metadata: null, raw: response.body };
      await cache.set(cacheKey, result);
      return result;
    }

    const metadata = mapBookMetadata(bookData, isbn);
    const result: DatabaseLookupResult = { found: true, metadata, raw: response.body };
    await cache.set(cacheKey, result);
    return result;
  }

  return {
    name: 'openlibrary' as const,
    lookupByIsbn,
  };
}
