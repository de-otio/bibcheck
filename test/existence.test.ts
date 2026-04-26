/**
 * Unit tests for src/existence.ts
 *
 * All database clients are mocked with in-memory fixtures — no real
 * network calls are made.
 */

import { describe, it, expect } from 'vitest';
import { HttpError } from '../src/http.js';
import {
  runExistence,
  titlesMatch,
  getFirstAuthorSurname,
  getAllAuthorNames,
  type RunExistenceDeps,
} from '../src/existence.js';
import type { CslEntry } from '../src/schema/csl.js';
import type { DatabaseLookupResult } from '../src/databases/crossref.js';
import type { CrossRefClient } from '../src/databases/crossref.js';
import type { OpenAlexClient } from '../src/databases/openalex.js';
import type { OpenLibraryClient } from '../src/databases/openlibrary.js';
import type { WorldCatClient } from '../src/databases/worldcat.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type LookupFn = () => Promise<DatabaseLookupResult>;

interface ClientHandlers {
  crossrefDoi?: LookupFn;
  openalexDoi?: LookupFn;
  openalexSearch?: LookupFn;
  openlibrary?: LookupFn;
  worldcat?: LookupFn;
}

function notImplemented(name: string): LookupFn {
  return () => Promise.reject(new Error(`${name} called unexpectedly`));
}

function makeMockClients(h: ClientHandlers): RunExistenceDeps['clients'] {
  const crossref: CrossRefClient = {
    name: 'crossref' as const,
    lookupByDoi: (_doi, _signal) => (h.crossrefDoi ?? notImplemented('crossref.lookupByDoi'))(),
  };

  const openalex: OpenAlexClient = {
    name: 'openalex' as const,
    lookupByDoi: (_doi, _signal) => (h.openalexDoi ?? notImplemented('openalex.lookupByDoi'))(),
    searchByTitleAuthor: (_title, _authors, _signal) =>
      (h.openalexSearch ?? notImplemented('openalex.searchByTitleAuthor'))(),
  };

  const openlibrary: OpenLibraryClient = {
    name: 'openlibrary' as const,
    lookupByIsbn: (_isbn, _signal) =>
      (h.openlibrary ?? notImplemented('openlibrary.lookupByIsbn'))(),
  };

  const worldcat: WorldCatClient = {
    name: 'worldcat' as const,
    lookupByIsbn: (_isbn, _signal) =>
      (h.worldcat ?? notImplemented('worldcat.lookupByIsbn'))(),
  };

  return { crossref, openalex, openlibrary, worldcat };
}

function found(metadata: DatabaseLookupResult['metadata']): DatabaseLookupResult {
  return { found: true, metadata, raw: {} };
}

function notFound(): DatabaseLookupResult {
  return { found: false, metadata: null, raw: {} };
}

function makeEntry(overrides: Partial<CslEntry> & { citekey: string }): CslEntry {
  return {
    doi: undefined,
    isbn: undefined,
    url: undefined,
    title: undefined,
    author: undefined,
    issued: undefined,
    note: undefined,
    ...overrides,
  } as CslEntry;
}

function makeSignal(): AbortSignal {
  return new AbortController().signal;
}

// ---------------------------------------------------------------------------
// Helper unit tests
// ---------------------------------------------------------------------------

describe('getFirstAuthorSurname', () => {
  it('returns family name', () => {
    const entry = makeEntry({
      citekey: 'x',
      author: [{ family: 'Habermas', given: 'Jürgen' }],
    });
    expect(getFirstAuthorSurname(entry)).toBe('Habermas');
  });

  it('falls back to last token of literal', () => {
    const entry = makeEntry({
      citekey: 'x',
      author: [{ literal: 'Jürgen Habermas' }],
    });
    expect(getFirstAuthorSurname(entry)).toBe('Habermas');
  });

  it('returns undefined when no authors', () => {
    const entry = makeEntry({ citekey: 'x' });
    expect(getFirstAuthorSurname(entry)).toBeUndefined();
  });
});

describe('getAllAuthorNames', () => {
  it('returns family names', () => {
    const entry = makeEntry({
      citekey: 'x',
      author: [{ family: 'Mill', given: 'John Stuart' }, { family: 'Rawls', given: 'John' }],
    });
    expect(getAllAuthorNames(entry)).toEqual(['Mill', 'Rawls']);
  });

  it('falls back to literal when no family', () => {
    const entry = makeEntry({
      citekey: 'x',
      author: [{ literal: 'Some Author' }],
    });
    expect(getAllAuthorNames(entry)).toEqual(['Some Author']);
  });

  it('returns empty array when no author field', () => {
    const entry = makeEntry({ citekey: 'x' });
    expect(getAllAuthorNames(entry)).toEqual([]);
  });
});

describe('titlesMatch', () => {
  it('identical strings match', () => {
    expect(titlesMatch('On Liberty', 'On Liberty')).toBe(true);
  });

  it('case and punctuation differences match', () => {
    expect(titlesMatch('On Liberty', 'on liberty!')).toBe(true);
  });

  it('small typo within tolerance (≥0.85 ratio)', () => {
    // "strukturwandel der offentlichkeit" vs "strukturwandel der oeffentlichkeit"
    // normalised: both become similar strings; ratio should be ≥0.85
    expect(
      titlesMatch(
        'Strukturwandel der Öffentlichkeit',
        'Strukturwandel der Oeffentlichkeit',
      ),
    ).toBe(true);
  });

  it('completely different strings do not match', () => {
    expect(titlesMatch('A Theory of Justice', 'Critique of Pure Reason')).toBe(false);
  });

  it('empty strings match each other', () => {
    expect(titlesMatch('', '')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runExistence — main test cases
// ---------------------------------------------------------------------------

describe('runExistence', () => {
  // 1. DOI entry, CrossRef returns matching metadata → 'verified'
  it('Case 1: DOI entry, CrossRef found+match → verified', async () => {
    const clients = makeMockClients({
      crossrefDoi: () =>
        Promise.resolve(
          found({
            title: 'On Liberty',
            authors: ['Mill, John Stuart'],
            issued: 1859,
          }),
        ),
      openalexDoi: () => Promise.resolve(notFound()),
    });

    const entry = makeEntry({
      citekey: 'mill1859',
      doi: '10.1000/test',
      title: 'On Liberty',
      author: [{ family: 'Mill', given: 'John Stuart' }],
    });

    const result = await runExistence({ bibliography: [entry], clients, signal: makeSignal() });
    expect(result.entries).toHaveLength(1);
    const e = result.entries[0]!;
    expect(e.citekey).toBe('mill1859');
    expect(e.existence.status).toBe('verified');
    const crCheck = e.existence.checks.find((c) => c.source === 'crossref');
    expect(crCheck?.result).toBe('found');
  });

  // 2. DOI entry, CrossRef metadata mismatches title → 'metadata-mismatch'
  it('Case 2: DOI entry, CrossRef found but title mismatches → metadata-mismatch', async () => {
    const clients = makeMockClients({
      crossrefDoi: () =>
        Promise.resolve(
          found({
            title: 'Completely Different Title That Does Not Match',
            authors: ['Mill, John Stuart'],
          }),
        ),
      openalexDoi: () => Promise.resolve(notFound()),
    });

    const entry = makeEntry({
      citekey: 'mill1859',
      doi: '10.1000/test',
      title: 'On Liberty',
      author: [{ family: 'Mill', given: 'John Stuart' }],
    });

    const result = await runExistence({ bibliography: [entry], clients, signal: makeSignal() });
    const e = result.entries[0]!;
    expect(e.existence.status).toBe('metadata-mismatch');
    const crCheck = e.existence.checks.find((c) => c.source === 'crossref');
    expect(crCheck?.result).toBe('metadata-mismatch');
  });

  // 3. DOI entry, CrossRef 404 + OpenAlex 404 → 'not-found-in-databases'
  it('Case 3: DOI entry, CrossRef 404 + OpenAlex 404 → not-found-in-databases', async () => {
    const clients = makeMockClients({
      crossrefDoi: () => Promise.resolve(notFound()),
      openalexDoi: () => Promise.resolve(notFound()),
    });

    const entry = makeEntry({ citekey: 'missing', doi: '10.9999/ghost' });

    const result = await runExistence({ bibliography: [entry], clients, signal: makeSignal() });
    const e = result.entries[0]!;
    expect(e.existence.status).toBe('not-found-in-databases');
    expect(e.existence.checks.every((c) => c.result === 'not-found')).toBe(true);
  });

  // 4. Both CrossRef + OpenAlex throw HttpError → 'unverifiable'; checks have result 'error'
  it('Case 4: both CrossRef + OpenAlex throw HttpError → unverifiable with error checks', async () => {
    const httpErr = new HttpError('Retries exhausted', 503);
    const clients = makeMockClients({
      crossrefDoi: () => Promise.reject(httpErr),
      openalexDoi: () => Promise.reject(httpErr),
    });

    const entry = makeEntry({ citekey: 'broken', doi: '10.1000/broken' });

    const result = await runExistence({ bibliography: [entry], clients, signal: makeSignal() });
    const e = result.entries[0]!;
    expect(e.existence.status).toBe('unverifiable');
    expect(e.existence.checks.every((c) => c.result === 'error')).toBe(true);
    // Evidence should include error message
    const crCheck = e.existence.checks.find((c) => c.source === 'crossref');
    expect((crCheck?.evidence as Record<string, string>)?.['error']).toContain('Retries exhausted');
  });

  // 5. CrossRef errors but OpenAlex succeeds → 'verified'
  it('Case 5: CrossRef errors but OpenAlex succeeds → verified (best source wins)', async () => {
    const httpErr = new HttpError('Service Unavailable', 503);
    const clients = makeMockClients({
      crossrefDoi: () => Promise.reject(httpErr),
      openalexDoi: () =>
        Promise.resolve(
          found({
            title: 'On Liberty',
            authors: ['John Stuart Mill'],
          }),
        ),
    });

    const entry = makeEntry({
      citekey: 'mill1859',
      doi: '10.1000/test',
      title: 'On Liberty',
      author: [{ family: 'Mill', given: 'John Stuart' }],
    });

    const result = await runExistence({ bibliography: [entry], clients, signal: makeSignal() });
    const e = result.entries[0]!;
    expect(e.existence.status).toBe('verified');
    const crCheck = e.existence.checks.find((c) => c.source === 'crossref');
    expect(crCheck?.result).toBe('error');
    const oaCheck = e.existence.checks.find((c) => c.source === 'openalex');
    expect(oaCheck?.result).toBe('found');
  });

  // 6. ISBN entry, OpenLibrary returns metadata match → 'verified'
  it('Case 6: ISBN entry, OpenLibrary match → verified', async () => {
    const clients = makeMockClients({
      openlibrary: () =>
        Promise.resolve(
          found({
            title: 'A Theory of Justice',
            authors: ['Rawls, John'],
          }),
        ),
      worldcat: () => Promise.resolve(notFound()),
    });

    const entry = makeEntry({
      citekey: 'rawls1971',
      isbn: '978-0674880146',
      title: 'A Theory of Justice',
      author: [{ family: 'Rawls', given: 'John' }],
    });

    const result = await runExistence({ bibliography: [entry], clients, signal: makeSignal() });
    const e = result.entries[0]!;
    expect(e.existence.status).toBe('verified');
    const olCheck = e.existence.checks.find((c) => c.source === 'openlibrary');
    expect(olCheck?.result).toBe('found');
  });

  // 7. Entry with title only, OpenAlex search finds match → 'verified'
  it('Case 7: title-only entry, OpenAlex search finds match → verified', async () => {
    const clients = makeMockClients({
      openalexSearch: () =>
        Promise.resolve(
          found({
            title: 'The Structure of Scientific Revolutions',
            authors: ['Kuhn, Thomas'],
          }),
        ),
    });

    const entry = makeEntry({
      citekey: 'kuhn1962',
      title: 'The Structure of Scientific Revolutions',
      author: [{ family: 'Kuhn', given: 'Thomas' }],
    });

    const result = await runExistence({ bibliography: [entry], clients, signal: makeSignal() });
    const e = result.entries[0]!;
    expect(e.existence.status).toBe('verified');
    const oaCheck = e.existence.checks.find((c) => c.source === 'openalex');
    expect(oaCheck?.result).toBe('found');
  });

  // 8. Entry with no DOI/ISBN/title → 'unverifiable'; checks have result 'no-doi'
  it('Case 8: no DOI/ISBN/title → unverifiable with no-doi check', async () => {
    const clients = makeMockClients({});

    const entry = makeEntry({ citekey: 'mystery' });

    const result = await runExistence({ bibliography: [entry], clients, signal: makeSignal() });
    const e = result.entries[0]!;
    expect(e.existence.status).toBe('unverifiable');
    expect(e.existence.checks).toHaveLength(1);
    expect(e.existence.checks[0]!.result).toBe('no-doi');
  });

  // 9. Title fuzzy match: small typo in entry.title vs metadata → still 'found'
  it('Case 9: small typo in title still matches (fuzzy tolerance ≥ 0.85)', async () => {
    const clients = makeMockClients({
      openalexSearch: () =>
        Promise.resolve(
          found({
            // Metadata has correct spelling
            title: 'Strukturwandel der Oeffentlichkeit',
            authors: ['Habermas'],
          }),
        ),
    });

    const entry = makeEntry({
      citekey: 'habermas1962',
      // Entry has slightly different (but close) title
      title: 'Strukturwandel der Öffentlichkeit',
      author: [{ family: 'Habermas', given: 'Jürgen' }],
    });

    const result = await runExistence({ bibliography: [entry], clients, signal: makeSignal() });
    const e = result.entries[0]!;
    expect(e.existence.status).toBe('verified');
  });

  // 10. AbortSignal cancels mid-iteration: throws
  it('Case 10: aborted signal before processing throws', async () => {
    const controller = new AbortController();
    controller.abort(new Error('Cancelled'));

    const clients = makeMockClients({});
    const entry = makeEntry({ citekey: 'e1' });

    await expect(
      runExistence({ bibliography: [entry], clients, signal: controller.signal }),
    ).rejects.toThrow();
  });

  // 11. Signal honored: aborting mid-run stops processing remaining entries
  it('Case 11: abort after first entry stops further processing', async () => {
    const controller = new AbortController();
    let callCount = 0;

    const clients = makeMockClients({
      openalexSearch: () => {
        callCount++;
        // Abort after first call
        controller.abort(new Error('Stopped'));
        return Promise.resolve(notFound());
      },
    });

    const entries = [
      makeEntry({ citekey: 'e1', title: 'First Entry' }),
      makeEntry({ citekey: 'e2', title: 'Second Entry' }),
      makeEntry({ citekey: 'e3', title: 'Third Entry' }),
    ];

    await expect(
      runExistence({ bibliography: entries, clients, signal: controller.signal }),
    ).rejects.toThrow();

    // Only one entry was processed before abort was detected
    expect(callCount).toBe(1);
  });

  // 12. Sanitization: evidence doesn't contain ?mailto= params
  it('Case 12: evidence from successful lookup does not contain mailto', async () => {
    // The mock metadata here simulates what a client returns after its own
    // sanitisation — no ?mailto= in any field. Since clients sanitise before
    // returning, we verify the evidence recorded in existence checks is clean.
    const cleanMetadata = {
      title: 'On Liberty',
      authors: ['Mill, John Stuart'],
      url: 'https://api.crossref.org/works/10.1000%2Ftest',  // no mailto
    };

    const clients = makeMockClients({
      crossrefDoi: () => Promise.resolve(found(cleanMetadata)),
      openalexDoi: () => Promise.resolve(notFound()),
    });

    const entry = makeEntry({
      citekey: 'mill1859',
      doi: '10.1000/test',
      title: 'On Liberty',
      author: [{ family: 'Mill', given: 'John Stuart' }],
    });

    const result = await runExistence({ bibliography: [entry], clients, signal: makeSignal() });
    const e = result.entries[0]!;
    expect(e.existence.status).toBe('verified');

    // Verify no evidence field contains '?mailto=' or '&mailto='
    for (const check of e.existence.checks) {
      const evidenceStr = JSON.stringify(check.evidence ?? '');
      expect(evidenceStr).not.toContain('mailto=');
    }
  });

  // Multiple entries — correct aggregate processing
  it('processes multiple entries independently', async () => {
    const clients = makeMockClients({
      crossrefDoi: () =>
        Promise.resolve(
          found({
            title: 'On Liberty',
            authors: ['Mill, John Stuart'],
          }),
        ),
      openalexDoi: () => Promise.resolve(notFound()),
      openlibrary: () => Promise.resolve(notFound()),
      worldcat: () => Promise.resolve(notFound()),
    });

    const entries = [
      makeEntry({
        citekey: 'mill1859',
        doi: '10.1000/test',
        title: 'On Liberty',
        author: [{ family: 'Mill', given: 'John Stuart' }],
      }),
      makeEntry({
        citekey: 'mystery-book',
        isbn: '978-0000000000',
        title: 'Unknown Book',
      }),
      makeEntry({ citekey: 'no-id' }),
    ];

    const result = await runExistence({ bibliography: entries, clients, signal: makeSignal() });
    expect(result.entries).toHaveLength(3);
    expect(result.entries[0]!.existence.status).toBe('verified');
    expect(result.entries[1]!.existence.status).toBe('not-found-in-databases');
    expect(result.entries[2]!.existence.status).toBe('unverifiable');
  });

  // Per-entry CrossRef throws, others succeed (multi-entry error isolation)
  it('per-entry CrossRef error does not abort the whole run', async () => {
    let callCount = 0;
    const httpErr = new HttpError('Retries exhausted', 503);

    const clients = makeMockClients({
      crossrefDoi: () => {
        callCount++;
        return Promise.reject(httpErr);
      },
      openalexDoi: () => Promise.resolve(notFound()),
    });

    const entries = [
      makeEntry({ citekey: 'e1', doi: '10.1000/one' }),
      makeEntry({ citekey: 'e2', doi: '10.1000/two' }),
    ];

    const result = await runExistence({ bibliography: entries, clients, signal: makeSignal() });
    expect(result.entries).toHaveLength(2);
    // Both entries processed
    expect(callCount).toBe(2);
    // Both have error from crossref, and 'not-found' from openalex → not-found-in-databases
    for (const e of result.entries) {
      expect(e.existence.status).toBe('not-found-in-databases');
    }
  });

  // DOI entry where OpenAlex also finds a match (both sources work)
  it('both CrossRef and OpenAlex found → verified with two found checks', async () => {
    const clients = makeMockClients({
      crossrefDoi: () =>
        Promise.resolve(
          found({ title: 'Being and Time', authors: ['Heidegger, Martin'], issued: 1927 }),
        ),
      openalexDoi: () =>
        Promise.resolve(
          found({ title: 'Being and Time', authors: ['Martin Heidegger'], issued: 1927 }),
        ),
    });

    const entry = makeEntry({
      citekey: 'heidegger1927',
      doi: '10.1000/ht',
      title: 'Being and Time',
      author: [{ family: 'Heidegger', given: 'Martin' }],
    });

    const result = await runExistence({ bibliography: [entry], clients, signal: makeSignal() });
    const e = result.entries[0]!;
    expect(e.existence.status).toBe('verified');
    expect(e.existence.checks.filter((c) => c.result === 'found')).toHaveLength(2);
  });

  // ISBN entry where both OpenLibrary and WorldCat match
  it('ISBN entry where WorldCat also matches → verified', async () => {
    const clients = makeMockClients({
      openlibrary: () => Promise.resolve(notFound()),
      worldcat: () =>
        Promise.resolve(
          found({ title: 'The Republic', authors: ['Plato'], isbn: '978-0000000001' }),
        ),
    });

    const entry = makeEntry({
      citekey: 'plato',
      isbn: '978-0000000001',
      title: 'The Republic',
      author: [{ family: 'Plato' }],
    });

    const result = await runExistence({ bibliography: [entry], clients, signal: makeSignal() });
    const e = result.entries[0]!;
    expect(e.existence.status).toBe('verified');
  });

  // Title-only entry, OpenAlex not found → 'not-found-in-databases'
  it('title-only entry, OpenAlex not found → not-found-in-databases', async () => {
    const clients = makeMockClients({
      openalexSearch: () => Promise.resolve(notFound()),
    });

    const entry = makeEntry({
      citekey: 'ghost',
      title: 'Completely Imaginary Work That Does Not Exist',
    });

    const result = await runExistence({ bibliography: [entry], clients, signal: makeSignal() });
    const e = result.entries[0]!;
    expect(e.existence.status).toBe('not-found-in-databases');
  });

  // Entry has DOI and CrossRef finds it but author mismatch → metadata-mismatch
  it('DOI found but author surname mismatches → metadata-mismatch', async () => {
    const clients = makeMockClients({
      crossrefDoi: () =>
        Promise.resolve(
          found({
            title: 'On Liberty',
            authors: ['Jones, Alice'],  // wrong author
            issued: 1859,
          }),
        ),
      openalexDoi: () => Promise.resolve(notFound()),
    });

    const entry = makeEntry({
      citekey: 'mill1859',
      doi: '10.1000/test',
      title: 'On Liberty',
      author: [{ family: 'Mill', given: 'John Stuart' }],
    });

    const result = await runExistence({ bibliography: [entry], clients, signal: makeSignal() });
    const e = result.entries[0]!;
    expect(e.existence.status).toBe('metadata-mismatch');
  });
});
