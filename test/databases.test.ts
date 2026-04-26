/**
 * Unit tests for src/databases/*.ts
 *
 * Each describe block covers one database client. All tests use a mock
 * HttpClient and an in-memory Cache — no real network calls are made.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HttpClient, HttpResponse } from '../src/http.js';
import { createMemoryCache } from '../src/cache/fs-cache.js';
import { createCrossRefClient, stripMailto } from '../src/databases/crossref.js';
import { createOpenAlexClient } from '../src/databases/openalex.js';
import { createOpenLibraryClient } from '../src/databases/openlibrary.js';
import { createWorldCatClient } from '../src/databases/worldcat.js';

// ---------------------------------------------------------------------------
// Mock HttpClient factory
// ---------------------------------------------------------------------------

function makeMockHttp(handlers: Record<string, HttpResponse | Error>): HttpClient {
  return {
    async get(url: string, _opts?: Parameters<HttpClient['get']>[1]): Promise<HttpResponse> {
      // Match exact URL first, then try prefix match (for mailto-appended URLs).
      let handler: HttpResponse | Error | undefined = handlers[url];
      if (handler === undefined) {
        // Try to match ignoring query params that differ only in mailto.
        for (const [key, val] of Object.entries(handlers)) {
          // strip mailto from both sides and compare.
          const strippedKey = stripMailto(key).replace(/[?&]mailto=[^&]*/, '');
          const strippedUrl = stripMailto(url).replace(/[?&]mailto=[^&]*/, '');
          if (strippedKey === strippedUrl) {
            handler = val;
            break;
          }
        }
      }
      if (handler instanceof Error) throw handler;
      if (handler === undefined) throw new Error(`unmocked URL: ${url}`);
      return handler;
    },
    async head(): Promise<never> {
      throw new Error('head not used in database client tests');
    },
  };
}

function jsonResponse(status: number, body: unknown): HttpResponse {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body,
  };
}

function xmlResponse(status: number, body: string): HttpResponse {
  return {
    status,
    headers: { 'content-type': 'application/xml' },
    body,
  };
}

// ---------------------------------------------------------------------------
// CrossRef
// ---------------------------------------------------------------------------

describe('CrossRef client', () => {
  const crossRefDoi = '10.1000/example';
  const crossRefUrl = `https://api.crossref.org/works/${encodeURIComponent(crossRefDoi)}`;
  const crossRefUrlWithMailto = `${crossRefUrl}?mailto=test%40example.com`;

  const successBody = {
    status: 'ok',
    message: {
      title: ['Test Article Title'],
      author: [
        { family: 'Smith', given: 'John' },
        { family: 'Jones', given: 'Alice' },
      ],
      'container-title': ['Test Journal'],
      DOI: crossRefDoi,
      ISBN: ['978-0-12-345678-9'],
      issued: { 'date-parts': [[2021, 6, 15]] },
      URL: 'https://doi.org/10.1000/example',
      publisher: 'Test Publisher',
    },
  };

  it('lookupByDoi 200 returns { found: true, metadata, raw }', async () => {
    const http = makeMockHttp({ [crossRefUrl]: jsonResponse(200, successBody) });
    const cache = createMemoryCache();
    const client = createCrossRefClient({ http, cache });

    const result = await client.lookupByDoi(crossRefDoi);

    expect(result.found).toBe(true);
    expect(result.metadata?.title).toBe('Test Article Title');
    expect(result.metadata?.authors).toEqual(['Smith, John', 'Jones, Alice']);
    expect(result.metadata?.issued).toBe(2021);
    expect(result.metadata?.publisher).toBe('Test Publisher');
    expect(result.metadata?.doi).toBe(crossRefDoi);
    expect(result.metadata?.isbn).toBe('978-0-12-345678-9');
    expect(result.metadata?.url).toBe('https://doi.org/10.1000/example');
    expect(result.raw).toBeDefined();
  });

  it('lookupByDoi 404 returns { found: false, metadata: null }', async () => {
    const http = makeMockHttp({ [crossRefUrl]: jsonResponse(404, { status: 'failed' }) });
    const cache = createMemoryCache();
    const client = createCrossRefClient({ http, cache });

    const result = await client.lookupByDoi(crossRefDoi);

    expect(result.found).toBe(false);
    expect(result.metadata).toBeNull();
  });

  it('mailto query param appears in URL when set', async () => {
    const getSpy = vi.fn().mockResolvedValue(jsonResponse(200, successBody));
    const http: HttpClient = {
      get: getSpy,
      async head(): Promise<never> { throw new Error('head not used'); },
    };
    const cache = createMemoryCache();
    const client = createCrossRefClient({ http, cache, mailto: 'test@example.com' });

    await client.lookupByDoi(crossRefDoi);

    expect(getSpy).toHaveBeenCalledOnce();
    const calledUrl: string = getSpy.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain('mailto=');
  });

  it('mailto query param absent when mailto is null', async () => {
    const getSpy = vi.fn().mockResolvedValue(jsonResponse(200, successBody));
    const http: HttpClient = {
      get: getSpy,
      async head(): Promise<never> { throw new Error('head not used'); },
    };
    const cache = createMemoryCache();
    const client = createCrossRefClient({ http, cache, mailto: null });

    await client.lookupByDoi(crossRefDoi);

    const calledUrl: string = getSpy.mock.calls[0]?.[0] as string;
    expect(calledUrl).not.toContain('mailto');
  });

  it('cache hit on 2nd call — mock called only once', async () => {
    const getSpy = vi.fn().mockResolvedValue(jsonResponse(200, successBody));
    const http: HttpClient = {
      get: getSpy,
      async head(): Promise<never> { throw new Error('head not used'); },
    };
    const cache = createMemoryCache();
    const client = createCrossRefClient({ http, cache });

    await client.lookupByDoi(crossRefDoi);
    await client.lookupByDoi(crossRefDoi);

    expect(getSpy).toHaveBeenCalledOnce();
  });

  it('raw response does not contain ?mailto= in URL fields', async () => {
    const bodyWithMailtoUrl = {
      status: 'ok',
      message: {
        ...successBody.message,
        URL: 'https://doi.org/10.1000/example?mailto=secret@example.com',
      },
    };
    const http = makeMockHttp({ [crossRefUrl]: jsonResponse(200, bodyWithMailtoUrl) });
    const cache = createMemoryCache();
    const client = createCrossRefClient({ http, cache });

    const result = await client.lookupByDoi(crossRefDoi);

    const rawStr = JSON.stringify(result.raw);
    expect(rawStr).not.toContain('mailto=');
  });

  it('aborted signal throws', async () => {
    const controller = new AbortController();
    controller.abort();

    const http = makeMockHttp({ [crossRefUrl]: jsonResponse(200, successBody) });
    const cache = createMemoryCache();
    const client = createCrossRefClient({ http, cache });

    await expect(client.lookupByDoi(crossRefDoi, controller.signal)).rejects.toThrow();
  });

  it('network error propagates', async () => {
    const networkError = new Error('ECONNRESET');
    const http = makeMockHttp({ [crossRefUrl]: networkError });
    const cache = createMemoryCache();
    const client = createCrossRefClient({ http, cache });

    await expect(client.lookupByDoi(crossRefDoi)).rejects.toThrow('ECONNRESET');
  });

  it('mailto URL appended correctly with mailto option', async () => {
    const http = makeMockHttp({ [crossRefUrlWithMailto]: jsonResponse(200, successBody) });
    const cache = createMemoryCache();
    const client = createCrossRefClient({ http, cache, mailto: 'test@example.com' });

    const result = await client.lookupByDoi(crossRefDoi);
    expect(result.found).toBe(true);
  });

  it('unexpected response body (not status:ok) throws', async () => {
    const badBody = { status: 'failed', message: null };
    const http = makeMockHttp({ [crossRefUrl]: jsonResponse(200, badBody) });
    const cache = createMemoryCache();
    const client = createCrossRefClient({ http, cache });

    await expect(client.lookupByDoi(crossRefDoi)).rejects.toThrow('CrossRef: unexpected response body');
  });
});

// ---------------------------------------------------------------------------
// stripMailto helper
// ---------------------------------------------------------------------------

describe('stripMailto', () => {
  it('removes mailto query param', () => {
    expect(stripMailto('https://api.crossref.org/works/foo?mailto=x@y.com')).toBe(
      'https://api.crossref.org/works/foo',
    );
  });

  it('leaves URL without mailto unchanged', () => {
    expect(stripMailto('https://api.crossref.org/works/foo')).toBe(
      'https://api.crossref.org/works/foo',
    );
  });

  it('returns non-URL strings unchanged', () => {
    expect(stripMailto('not-a-url')).toBe('not-a-url');
  });
});

// ---------------------------------------------------------------------------
// OpenAlex
// ---------------------------------------------------------------------------

describe('OpenAlex client', () => {
  const doi = '10.1000/openalex-example';
  const encodedDoi = encodeURIComponent(doi);
  const doiUrl = `https://api.openalex.org/works/doi:${encodedDoi}`;

  const workBody = {
    display_name: 'OpenAlex Test Work',
    authorships: [
      { author: { display_name: 'Jane Doe' } },
      { author: { display_name: 'Bob Smith' } },
    ],
    publication_year: 2022,
    doi: doi,
    id: 'https://openalex.org/W12345',
  };

  const searchTitle = 'OpenAlex Test Work';
  const searchAuthor = 'Jane Doe';
  const searchUrl = `https://api.openalex.org/works?search=${encodeURIComponent(searchTitle)}&filter=author.display_name.search:${encodeURIComponent(searchAuthor)}&per-page=5`;

  it('lookupByDoi 200 returns metadata', async () => {
    const http = makeMockHttp({ [doiUrl]: jsonResponse(200, workBody) });
    const cache = createMemoryCache();
    const client = createOpenAlexClient({ http, cache });

    const result = await client.lookupByDoi(doi);

    expect(result.found).toBe(true);
    expect(result.metadata?.title).toBe('OpenAlex Test Work');
    expect(result.metadata?.authors).toEqual(['Jane Doe', 'Bob Smith']);
    expect(result.metadata?.issued).toBe(2022);
    expect(result.metadata?.doi).toBe(doi);
    expect(result.metadata?.url).toBe('https://openalex.org/W12345');
  });

  it('lookupByDoi 404 returns { found: false }', async () => {
    const http = makeMockHttp({ [doiUrl]: jsonResponse(404, {}) });
    const cache = createMemoryCache();
    const client = createOpenAlexClient({ http, cache });

    const result = await client.lookupByDoi(doi);
    expect(result.found).toBe(false);
    expect(result.metadata).toBeNull();
  });

  it('searchByTitleAuthor 200 with results returns first match metadata', async () => {
    const searchBody = { results: [workBody] };
    const http = makeMockHttp({ [searchUrl]: jsonResponse(200, searchBody) });
    const cache = createMemoryCache();
    const client = createOpenAlexClient({ http, cache });

    const result = await client.searchByTitleAuthor(searchTitle, [searchAuthor]);

    expect(result.found).toBe(true);
    expect(result.metadata?.title).toBe('OpenAlex Test Work');
  });

  it('searchByTitleAuthor 200 with empty results returns { found: false }', async () => {
    const searchBody = { results: [] };
    const http = makeMockHttp({ [searchUrl]: jsonResponse(200, searchBody) });
    const cache = createMemoryCache();
    const client = createOpenAlexClient({ http, cache });

    const result = await client.searchByTitleAuthor(searchTitle, [searchAuthor]);

    expect(result.found).toBe(false);
    expect(result.metadata).toBeNull();
  });

  it('mailto query param appears in URL when set', async () => {
    const getSpy = vi.fn().mockResolvedValue(jsonResponse(200, workBody));
    const http: HttpClient = {
      get: getSpy,
      async head(): Promise<never> { throw new Error('head not used'); },
    };
    const cache = createMemoryCache();
    const client = createOpenAlexClient({ http, cache, mailto: 'openalex@example.com' });

    await client.lookupByDoi(doi);

    const calledUrl: string = getSpy.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain('mailto=');
  });

  it('raw response does not contain ?mailto= in URL fields', async () => {
    const bodyWithMailto = {
      ...workBody,
      id: 'https://openalex.org/W12345?mailto=secret@example.com',
    };
    const http = makeMockHttp({ [doiUrl]: jsonResponse(200, bodyWithMailto) });
    const cache = createMemoryCache();
    const client = createOpenAlexClient({ http, cache });

    const result = await client.lookupByDoi(doi);

    const rawStr = JSON.stringify(result.raw);
    expect(rawStr).not.toContain('mailto=');
  });

  it('cache hit on 2nd lookupByDoi call', async () => {
    const getSpy = vi.fn().mockResolvedValue(jsonResponse(200, workBody));
    const http: HttpClient = {
      get: getSpy,
      async head(): Promise<never> { throw new Error('head not used'); },
    };
    const cache = createMemoryCache();
    const client = createOpenAlexClient({ http, cache });

    await client.lookupByDoi(doi);
    await client.lookupByDoi(doi);

    expect(getSpy).toHaveBeenCalledOnce();
  });

  it('aborted signal throws on lookupByDoi', async () => {
    const controller = new AbortController();
    controller.abort();

    const http = makeMockHttp({ [doiUrl]: jsonResponse(200, workBody) });
    const cache = createMemoryCache();
    const client = createOpenAlexClient({ http, cache });

    await expect(client.lookupByDoi(doi, controller.signal)).rejects.toThrow();
  });

  it('searchByTitleAuthor 404 returns { found: false }', async () => {
    const http = makeMockHttp({ [searchUrl]: jsonResponse(404, {}) });
    const cache = createMemoryCache();
    const client = createOpenAlexClient({ http, cache });

    const result = await client.searchByTitleAuthor(searchTitle, [searchAuthor]);
    expect(result.found).toBe(false);
  });

  it('aborted signal throws on searchByTitleAuthor', async () => {
    const controller = new AbortController();
    controller.abort();

    const http = makeMockHttp({ [searchUrl]: jsonResponse(200, { results: [] }) });
    const cache = createMemoryCache();
    const client = createOpenAlexClient({ http, cache });

    await expect(client.searchByTitleAuthor(searchTitle, [searchAuthor], controller.signal)).rejects.toThrow();
  });

  it('cache hit on 2nd searchByTitleAuthor call', async () => {
    const searchBody = { results: [workBody] };
    const getSpy = vi.fn().mockResolvedValue(jsonResponse(200, searchBody));
    const http: HttpClient = {
      get: getSpy,
      async head(): Promise<never> { throw new Error('head not used'); },
    };
    const cache = createMemoryCache();
    const client = createOpenAlexClient({ http, cache });

    await client.searchByTitleAuthor(searchTitle, [searchAuthor]);
    await client.searchByTitleAuthor(searchTitle, [searchAuthor]);

    expect(getSpy).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// OpenLibrary
// ---------------------------------------------------------------------------

describe('OpenLibrary client', () => {
  const isbn = '9780123456789';
  const openLibUrl = `https://openlibrary.org/api/books?bibkeys=ISBN:${encodeURIComponent(isbn)}&format=json&jscmd=data`;

  const bookData = {
    title: 'Test Book',
    authors: [{ name: 'Author One' }, { name: 'Author Two' }],
    publishers: [{ name: 'Test Press' }],
    publish_date: 'January 2020',
  };

  const successBody = { [`ISBN:${isbn}`]: bookData };

  it('lookupByIsbn 200 with data returns { found: true, metadata }', async () => {
    const http = makeMockHttp({ [openLibUrl]: jsonResponse(200, successBody) });
    const cache = createMemoryCache();
    const client = createOpenLibraryClient({ http, cache });

    const result = await client.lookupByIsbn(isbn);

    expect(result.found).toBe(true);
    expect(result.metadata?.title).toBe('Test Book');
    expect(result.metadata?.authors).toEqual(['Author One', 'Author Two']);
    expect(result.metadata?.publisher).toBe('Test Press');
    expect(result.metadata?.issued).toBe(2020);
    expect(result.metadata?.isbn).toBe(isbn);
  });

  it('lookupByIsbn 200 with {} returns { found: false }', async () => {
    const http = makeMockHttp({ [openLibUrl]: jsonResponse(200, {}) });
    const cache = createMemoryCache();
    const client = createOpenLibraryClient({ http, cache });

    const result = await client.lookupByIsbn(isbn);

    expect(result.found).toBe(false);
    expect(result.metadata).toBeNull();
  });

  it('lookupByIsbn 404 returns { found: false }', async () => {
    const http = makeMockHttp({ [openLibUrl]: jsonResponse(404, {}) });
    const cache = createMemoryCache();
    const client = createOpenLibraryClient({ http, cache });

    const result = await client.lookupByIsbn(isbn);
    expect(result.found).toBe(false);
  });

  it('cache hit on 2nd call — mock called only once', async () => {
    const getSpy = vi.fn().mockResolvedValue(jsonResponse(200, successBody));
    const http: HttpClient = {
      get: getSpy,
      async head(): Promise<never> { throw new Error('head not used'); },
    };
    const cache = createMemoryCache();
    const client = createOpenLibraryClient({ http, cache });

    await client.lookupByIsbn(isbn);
    await client.lookupByIsbn(isbn);

    expect(getSpy).toHaveBeenCalledOnce();
  });

  it('network error propagates', async () => {
    const err = new Error('ECONNRESET');
    const http = makeMockHttp({ [openLibUrl]: err });
    const cache = createMemoryCache();
    const client = createOpenLibraryClient({ http, cache });

    await expect(client.lookupByIsbn(isbn)).rejects.toThrow('ECONNRESET');
  });

  it('aborted signal throws', async () => {
    const controller = new AbortController();
    controller.abort();

    const http = makeMockHttp({ [openLibUrl]: jsonResponse(200, successBody) });
    const cache = createMemoryCache();
    const client = createOpenLibraryClient({ http, cache });

    await expect(client.lookupByIsbn(isbn, controller.signal)).rejects.toThrow();
  });

  it('publish_date as plain year string is parsed correctly', async () => {
    const bodyWithYearDate = {
      [`ISBN:${isbn}`]: { ...bookData, publish_date: '2019' },
    };
    const http = makeMockHttp({ [openLibUrl]: jsonResponse(200, bodyWithYearDate) });
    const cache = createMemoryCache();
    const client = createOpenLibraryClient({ http, cache });

    const result = await client.lookupByIsbn(isbn);
    expect(result.metadata?.issued).toBe(2019);
  });

  it('unexpected response body (non-object) throws', async () => {
    const http = makeMockHttp({ [openLibUrl]: { status: 200, headers: {}, body: 'not-json' } });
    const cache = createMemoryCache();
    const client = createOpenLibraryClient({ http, cache });

    await expect(client.lookupByIsbn(isbn)).rejects.toThrow('OpenLibrary: unexpected response body');
  });
});

// ---------------------------------------------------------------------------
// WorldCat
// ---------------------------------------------------------------------------

describe('WorldCat client', () => {
  const isbn = '9780987654321';
  // v0.1 endpoint uses HTTP (not HTTPS).
  const worldCatUrl = `http://classify.oclc.org/classify2/api?isbn=${encodeURIComponent(isbn)}&summary=true`;

  const xmlWithWork = `<?xml version="1.0"?>
<classify>
  <response code="2"/>
  <works>
    <work title="WorldCat Test Book" author="Doe, Jane" wi="123456789" editions="5" holdings="200" owi="12345" schemes="DDC LCC"/>
  </works>
</classify>`;

  const xmlEmpty = `<?xml version="1.0"?>
<classify>
  <response code="102"/>
</classify>`;

  it('lookupByIsbn with XML containing <work title="X" author="Y"> returns metadata', async () => {
    const http = makeMockHttp({ [worldCatUrl]: xmlResponse(200, xmlWithWork) });
    const cache = createMemoryCache();
    const client = createWorldCatClient({ http, cache });

    const result = await client.lookupByIsbn(isbn);

    expect(result.found).toBe(true);
    expect(result.metadata?.title).toBe('WorldCat Test Book');
    expect(result.metadata?.authors).toEqual(['Doe, Jane']);
    expect(result.metadata?.isbn).toBe(isbn);
  });

  it('lookupByIsbn with empty XML work returns { found: false }', async () => {
    const http = makeMockHttp({ [worldCatUrl]: xmlResponse(200, xmlEmpty) });
    const cache = createMemoryCache();
    const client = createWorldCatClient({ http, cache });

    const result = await client.lookupByIsbn(isbn);

    expect(result.found).toBe(false);
    expect(result.metadata).toBeNull();
  });

  it('uses http:// (not https://) URL for Classify endpoint', async () => {
    const getSpy = vi.fn().mockResolvedValue(xmlResponse(200, xmlWithWork));
    const http: HttpClient = {
      get: getSpy,
      async head(): Promise<never> { throw new Error('head not used'); },
    };
    const cache = createMemoryCache();
    const client = createWorldCatClient({ http, cache });

    await client.lookupByIsbn(isbn);

    const calledUrl: string = getSpy.mock.calls[0]?.[0] as string;
    expect(calledUrl).toMatch(/^http:\/\/classify\.oclc\.org/);
    expect(calledUrl).not.toMatch(/^https:/);
  });

  it('cache hit on 2nd call — mock called only once', async () => {
    const getSpy = vi.fn().mockResolvedValue(xmlResponse(200, xmlWithWork));
    const http: HttpClient = {
      get: getSpy,
      async head(): Promise<never> { throw new Error('head not used'); },
    };
    const cache = createMemoryCache();
    const client = createWorldCatClient({ http, cache });

    await client.lookupByIsbn(isbn);
    await client.lookupByIsbn(isbn);

    expect(getSpy).toHaveBeenCalledOnce();
  });

  it('JSON response with work data returns metadata', async () => {
    const jsonBody = {
      classify: {
        work: { title: 'JSON Test Book', author: 'Smith, Bob' },
      },
    };
    const http = makeMockHttp({ [worldCatUrl]: jsonResponse(200, jsonBody) });
    const cache = createMemoryCache();
    const client = createWorldCatClient({ http, cache });

    const result = await client.lookupByIsbn(isbn);

    expect(result.found).toBe(true);
    expect(result.metadata?.title).toBe('JSON Test Book');
    expect(result.metadata?.authors).toEqual(['Smith, Bob']);
  });

  it('JSON response with works.work array returns first match', async () => {
    const jsonBody = {
      classify: {
        works: {
          work: [
            { title: 'First Work', author: 'First Author' },
            { title: 'Second Work', author: 'Second Author' },
          ],
        },
      },
    };
    const http = makeMockHttp({ [worldCatUrl]: jsonResponse(200, jsonBody) });
    const cache = createMemoryCache();
    const client = createWorldCatClient({ http, cache });

    const result = await client.lookupByIsbn(isbn);

    expect(result.found).toBe(true);
    expect(result.metadata?.title).toBe('First Work');
  });

  it('JSON response with no work returns { found: false }', async () => {
    const jsonBody = { classify: {} };
    const http = makeMockHttp({ [worldCatUrl]: jsonResponse(200, jsonBody) });
    const cache = createMemoryCache();
    const client = createWorldCatClient({ http, cache });

    const result = await client.lookupByIsbn(isbn);
    expect(result.found).toBe(false);
  });

  it('network error propagates', async () => {
    const err = new Error('network failure');
    const http = makeMockHttp({ [worldCatUrl]: err });
    const cache = createMemoryCache();
    const client = createWorldCatClient({ http, cache });

    await expect(client.lookupByIsbn(isbn)).rejects.toThrow('network failure');
  });

  it('aborted signal throws', async () => {
    const controller = new AbortController();
    controller.abort();

    const http = makeMockHttp({ [worldCatUrl]: xmlResponse(200, xmlWithWork) });
    const cache = createMemoryCache();
    const client = createWorldCatClient({ http, cache });

    await expect(client.lookupByIsbn(isbn, controller.signal)).rejects.toThrow();
  });

  it('XML with no <work> element returns { found: false }', async () => {
    // XML that has no <work> tag at all — parseClassifyXml returns null.
    const xmlNoWork = `<?xml version="1.0"?><classify><response code="102"/></classify>`;
    const http = makeMockHttp({ [worldCatUrl]: xmlResponse(200, xmlNoWork) });
    const cache = createMemoryCache();
    const client = createWorldCatClient({ http, cache });

    const result = await client.lookupByIsbn(isbn);
    expect(result.found).toBe(false);
  });

  it('XML with <work> but no title or author returns { found: false }', async () => {
    // parseClassifyXml finds the element but it has no title/author attrs.
    const xmlWorkNoAttrs = `<?xml version="1.0"?><classify><works><work wi="123"/></works></classify>`;
    const http = makeMockHttp({ [worldCatUrl]: xmlResponse(200, xmlWorkNoAttrs) });
    const cache = createMemoryCache();
    const client = createWorldCatClient({ http, cache });

    const result = await client.lookupByIsbn(isbn);
    expect(result.found).toBe(false);
  });

  it('lookupByIsbn 404 returns { found: false }', async () => {
    const http = makeMockHttp({ [worldCatUrl]: jsonResponse(404, {}) });
    const cache = createMemoryCache();
    const client = createWorldCatClient({ http, cache });

    const result = await client.lookupByIsbn(isbn);
    expect(result.found).toBe(false);
  });

  it('JSON response with works.work as single object returns metadata', async () => {
    const jsonBody = {
      classify: {
        works: {
          work: { title: 'Single Work Object', author: 'One Author' },
        },
      },
    };
    const http = makeMockHttp({ [worldCatUrl]: jsonResponse(200, jsonBody) });
    const cache = createMemoryCache();
    const client = createWorldCatClient({ http, cache });

    const result = await client.lookupByIsbn(isbn);
    expect(result.found).toBe(true);
    expect(result.metadata?.title).toBe('Single Work Object');
  });
});
