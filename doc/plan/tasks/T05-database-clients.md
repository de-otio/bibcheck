# T05 — Database clients (CrossRef, OpenAlex, OpenLibrary, WorldCat)

**Phase:** 2a (Module utilities)
**Complexity:** medium-large
**Depends on:** T02 (Cache), T01 (Config — for polite-pool email addresses)
**Blocks:** T08 (existence subcommand)

## Scope

Four lightweight HTTP clients for the bibliographic databases bibcheck queries. Each client implements a common interface, accepts a `Cache` and a polite-pool email config, and returns structured results. No heavyweight wrapper libraries.

## Files

- `src/databases/index.ts` — barrel re-exporting the four clients.
- `src/databases/crossref.ts`
- `src/databases/openalex.ts`
- `src/databases/openlibrary.ts`
- `src/databases/worldcat.ts`
- `test/databases.test.ts` — unit tests for all four (one suite per client; shared helper module if useful).

## Interfaces

### Common shape

```ts
export interface DatabaseLookupResult {
  found: boolean;
  metadata: {
    title?: string;
    authors?: string[];
    issued?: number;            // year
    publisher?: string;
    doi?: string;
    isbn?: string;
    url?: string;
  } | null;
  raw: unknown;                 // the raw API response, for evidence
}

export interface DatabaseClient {
  readonly name: string;        // 'crossref' | 'openalex' | 'openlibrary' | 'worldcat'
}

// per-client signatures vary; see below
```

### CrossRef

```ts
export interface CrossRefClientOptions {
  http: HttpClient;             // from T06
  cache: Cache;                 // from T02
  mailto?: string | null;       // polite pool
}

export function createCrossRefClient(opts: CrossRefClientOptions): {
  name: 'crossref';
  lookupByDoi(doi: string, signal?: AbortSignal): Promise<DatabaseLookupResult>;
};
```

URL: `https://api.crossref.org/works/<doi>`. Polite-pool: append `?mailto=<email>` query param when `mailto` is set.

### OpenAlex

```ts
export function createOpenAlexClient(opts: { http; cache; mailto? }): {
  name: 'openalex';
  searchByTitleAuthor(title: string, authors: string[], signal?): Promise<DatabaseLookupResult>;
  lookupByDoi(doi: string, signal?): Promise<DatabaseLookupResult>;
};
```

URL: `https://api.openalex.org/works`. Polite-pool: `?mailto=<email>` query param.

### OpenLibrary

```ts
export function createOpenLibraryClient(opts: { http; cache }): {
  name: 'openlibrary';
  lookupByIsbn(isbn: string, signal?): Promise<DatabaseLookupResult>;
};
```

URL: `https://openlibrary.org/api/books?bibkeys=ISBN:<isbn>&format=json&jscmd=data`.

### WorldCat

```ts
export function createWorldCatClient(opts: { http; cache; apiKey?: string | null }): {
  name: 'worldcat';
  lookupByIsbn(isbn: string, signal?): Promise<DatabaseLookupResult>;
};
```

**v0.1 endpoint**: `http://classify.oclc.org/classify2/api?isbn=<isbn>&summary=true` (OCLC Classify legacy API). Note: HTTP-only — the endpoint does not support HTTPS; document the trust implications (response integrity is not guaranteed over plaintext). The OAuth2 OCLC Discovery API is deferred to v0.2.

When `worldcat_key_env` is unset (the v0.1 default), the client uses Classify and ignores any `apiKey`. The previous "no-op when key missing" stub is replaced: `worldcat` **always** queries Classify in v0.1, and "no key" simply means Discovery is unavailable.

## Implementation notes

- **Polite-pool email** comes from `Config.apis.crossref_mailto` and `Config.apis.openalex_mailto`. The CLI wires this; clients accept it as a constructor option.
- **User-Agent header**: ALL clients MUST set `User-Agent: bibcheck/<package.version> (mailto:<email>)` when polite-pool email is configured. The `?mailto=<email>` query-string parameter is also appended as a belt-and-braces fallback. The `User-Agent` string is built in T15 (CLI wiring) and threaded into the `HttpClient` via T06's `userAgent` option; database clients do not build it themselves.
- **Per-host concurrency**: the concurrency layer lives inside T06's `HttpClient` (a per-origin `p-queue` with `concurrency: 2`; global cap 4 in-flight across all clients). Database clients themselves do not manage queues.
- **Retry policy**: 1–2 retries with jittered backoff (250ms base, 1.5× multiplier) on 5xx and network errors only. Never retry on 4xx (treat as definitive). Per-attempt timeout 10s; total per-call deadline 30s. The retry/timeout logic lives in T06's `HttpClient`; database clients are unaware of retries.
- **Secrets-in-output rule**: the WorldCat API key, polite-pool email, and any `?mailto=` URL parameter MUST NOT appear in the `evidence`/`raw` field, in any log line, or in any error message. Strip the `mailto` query param from any URL captured in `raw` before storing.
- **Caching key**: hash of `(client name, method, args)` — e.g., `"crossref:lookupByDoi:10.1000/example"`. The `Cache` interface from T02 handles the SHA-256 internally; just pass the string.
- **Cache TTL**: default to the `Cache` defaults (30 days). Bibliographic data changes slowly.
- **Response normalisation**: each client maps its API's response shape to the common `DatabaseLookupResult.metadata` shape. Don't over-normalise — preserve the raw response in `raw` for evidence.
- **Error handling**: 404 on CrossRef means "DOI doesn't exist" — return `found: false`, not throw. Network errors / 5xx — throw, let caller decide.
- **OpenLibrary throttling**: per-origin `p-queue` concurrency 2 (more conservative than CrossRef/OpenAlex, reflecting OpenLibrary's published guidance).
- **Abort support**: pass `AbortSignal` through to `HttpClient` so the CLI's Ctrl-C handler aborts in-flight requests.

## Acceptance criteria

- [ ] All four clients implement their documented signatures.
- [ ] Each client accepts a `Cache` and uses it (no test assertion needed; just behavioural — test that two consecutive `lookupByDoi(same)` calls only hit the network once).
- [ ] Polite-pool email is sent as a query param when set, omitted when null.
- [ ] 404 returns `{ found: false }`, not an exception.
- [ ] 5xx throws.
- [ ] Network errors throw.
- [ ] Each client exports a `name` field for logging / evidence-attribution.
- [ ] User-Agent contains `mailto:` when configured; query-string `?mailto=` is also present (belt-and-braces).
- [ ] Polite-pool email is stripped from `raw` URL captures.
- [ ] Retries fire on 5xx; do not fire on 4xx.
- [ ] Per-origin concurrency 2 verified via test (5 concurrent calls to same origin → 2 simultaneous, 3 queued).
- [ ] WorldCat client queries `classify.oclc.org/classify2/` in v0.1.

## Tests

`test/databases.test.ts`:

For each client:

- Successful lookup returns `{ found: true, metadata: ..., raw: ... }`.
- 404 returns `{ found: false }`.
- 5xx throws.
- Network error throws.
- Polite-pool email is included in URL when set.
- Cache hit on second call.
- AbortSignal aborts the request.

Mock HTTP via the `HttpClient` interface — every test passes a vi.spyOn'd mock client. **No real network calls.**

The test file should have one parametric describe block per client to share assertion helpers.

Coverage target: ≥ 80% line + branch for `src/databases/**/*.ts`.

## New dependencies

None at the dependency level. Uses Node's `fetch` indirectly via the `HttpClient` interface (T06).

## Open question

CrossRef metadata is publisher-supplied and uncurated; author-name slop is documented (some entries have given/family swapped, others have one-string-many-authors). Decide on a metadata-mismatch tolerance: probably "title fuzzy match + first-author surname match" rather than exact match. Document the tolerance in the implementation. The mismatch tolerance is consumed by T08 (existence) when comparing API metadata to bibliography metadata.
