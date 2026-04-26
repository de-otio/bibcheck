/**
 * CrossRef DOI lookup client.
 *
 * Queries https://api.crossref.org/works/<doi> and returns normalised
 * DatabaseLookupResult metadata. Supports the CrossRef polite pool via a
 * ?mailto= query param. Results are cached (default 30-day TTL).
 *
 * The polite-pool email is stripped from any URL fields in the raw response
 * before caching to prevent credentials leaking into evidence output.
 */

import type { HttpClient, HttpResponse } from '../http.js';
import type { Cache } from '../cache/fs-cache.js';

// ---------------------------------------------------------------------------
// Shared types — re-exported so other database clients can import from here
// without depending on a separate shared-types module.
// ---------------------------------------------------------------------------

export interface DatabaseLookupResult {
  found: boolean;
  metadata: {
    title?: string;
    authors?: string[];
    issued?: number; // year
    publisher?: string;
    doi?: string;
    isbn?: string;
    url?: string;
  } | null;
  raw: unknown; // raw API response (sanitized — no mailto/api-key)
}

export interface DatabaseClient {
  readonly name: string;
}

// ---------------------------------------------------------------------------
// CrossRef-specific types
// ---------------------------------------------------------------------------

export interface CrossRefClientOptions {
  http: HttpClient;
  cache: Cache;
  mailto?: string | null; // polite-pool email
}

export interface CrossRefClient extends DatabaseClient {
  readonly name: 'crossref';
  lookupByDoi(doi: string, signal?: AbortSignal): Promise<DatabaseLookupResult>;
}

// ---------------------------------------------------------------------------
// Internal types for CrossRef API response
// ---------------------------------------------------------------------------

interface CrossRefAuthor {
  family?: string;
  given?: string;
}

interface CrossRefDateParts {
  'date-parts'?: ReadonlyArray<ReadonlyArray<number>>;
}

interface CrossRefMessage {
  title?: string[];
  author?: CrossRefAuthor[];
  'container-title'?: string[];
  DOI?: string;
  ISBN?: string[];
  issued?: CrossRefDateParts;
  URL?: string;
  publisher?: string;
}

interface CrossRefSuccessBody {
  status: 'ok';
  message: CrossRefMessage;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strip the ?mailto= query parameter from a URL string.
 * Returns the original string unchanged if it is not a valid URL.
 */
export function stripMailto(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.searchParams.has('mailto')) {
    parsed.searchParams.delete('mailto');
    return parsed.toString();
  }
  return url;
}

/**
 * Recursively walk an unknown value and strip ?mailto= from any string
 * fields that look like URLs. Returns a new value; does not mutate.
 */
export function sanitizeMailto(value: unknown): unknown {
  if (typeof value === 'string') {
    // Only attempt stripMailto for strings that look like URLs.
    if (value.startsWith('http://') || value.startsWith('https://')) {
      return stripMailto(value);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeMailto);
  }
  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = sanitizeMailto(v);
    }
    return result;
  }
  return value;
}

function isCrossRefSuccess(body: unknown): body is CrossRefSuccessBody {
  if (typeof body !== 'object' || body === null) return false;
  const b = body as Record<string, unknown>;
  return b['status'] === 'ok' && typeof b['message'] === 'object' && b['message'] !== null;
}

function mapMetadata(msg: CrossRefMessage): DatabaseLookupResult['metadata'] {
  const authors = msg.author
    ?.map((a) => [a.family, a.given].filter(Boolean).join(', '))
    .filter((s) => s.length > 0);

  // noUncheckedIndexedAccess: date-parts[0] could be undefined on malformed data.
  const dateParts = msg.issued?.['date-parts'];
  const firstPart = dateParts?.[0];
  const year = firstPart?.[0];

  const isbn = msg.ISBN?.[0];
  const title = msg.title?.[0];

  return {
    title,
    authors: authors && authors.length > 0 ? authors : undefined,
    issued: typeof year === 'number' ? year : undefined,
    publisher: msg.publisher,
    doi: msg.DOI,
    isbn,
    url: msg.URL,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCrossRefClient(opts: CrossRefClientOptions): CrossRefClient {
  const { http, cache, mailto } = opts;

  async function lookupByDoi(doi: string, signal?: AbortSignal): Promise<DatabaseLookupResult> {
    const cacheKey = `crossref:lookupByDoi:${doi.toLowerCase()}`;

    const cached = await cache.get<DatabaseLookupResult>(cacheKey, signal);
    if (cached !== null) {
      return cached;
    }

    const encoded = encodeURIComponent(doi);
    let url = `https://api.crossref.org/works/${encoded}`;
    if (mailto) {
      url += `?mailto=${encodeURIComponent(mailto)}`;
    }

    let response: HttpResponse;
    try {
      response = await http.get(url, { signal });
    } catch (err) {
      // Network errors / 5xx after retries — propagate.
      throw err;
    }

    if (response.status === 404) {
      const result: DatabaseLookupResult = {
        found: false,
        metadata: null,
        raw: sanitizeMailto(response.body),
      };
      return result;
    }

    if (!isCrossRefSuccess(response.body)) {
      throw new Error(
        `CrossRef: unexpected response body for DOI "${doi}" (status ${response.status})`,
      );
    }

    const sanitizedRaw = sanitizeMailto(response.body);
    const metadata = mapMetadata(response.body.message);

    const result: DatabaseLookupResult = {
      found: true,
      metadata,
      raw: sanitizedRaw,
    };

    await cache.set(cacheKey, result);
    return result;
  }

  return {
    name: 'crossref' as const,
    lookupByDoi,
  };
}
