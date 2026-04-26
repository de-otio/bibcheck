# T06 — HTTP utility for URL verification

**Phase:** 2a (Module utilities)
**Complexity:** small
**Depends on:** T02 (Cache — used to cache HEAD results)
**Blocks:** T05 (database clients use the HttpClient interface), T09 (canonical subcommand)

## Scope

Two responsibilities:

1. A small `HttpClient` interface used by every module that makes HTTP calls. The CLI wires a real `fetch`-backed implementation; tests inject mocks.
2. A higher-level `headCheck` utility for canonical-edition URL verification — performs HEAD with redirect tracking, validates the final host against a whitelist, returns a structured result.

## Files

- `src/http.ts` — `HttpClient` interface, real impl, `headCheck` utility, host-whitelist matcher.
- `test/http.test.ts` — unit tests.

## Interfaces

### HttpClient

```ts
export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;                // parsed JSON if Content-Type is JSON; else raw string
}

export interface HttpClient {
  get(url: string, opts?: HttpRequestOptions): Promise<HttpResponse>;
  head(url: string, opts?: HttpHeadOptions): Promise<HttpHeadResponse>;
}

export interface HttpRequestOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface HttpHeadOptions extends HttpRequestOptions {
  followRedirects?: boolean;    // default true
  maxRedirects?: number;        // default 5
}

export interface HttpHeadResponse {
  status: number;
  finalUrl: string;
  redirectChain: string[];      // intermediate URLs in redirect chain, excluding origin
}

export interface CreateHttpClientOptions {
  userAgent?: string;
  defaultTimeoutMs?: number;    // default 10_000
}

export function createHttpClient(opts?: CreateHttpClientOptions): HttpClient;
```

### headCheck

```ts
export interface HeadCheckOptions {
  http: HttpClient;
  cache?: Cache;                // optional caching of HEAD results
  trustedHosts: string[];       // from Config
}

export type HeadCheckResult =
  | { ok: true; status: number; finalUrl: string; redirectChain: string[]; host: string }
  | { ok: false; reason: 'dead-url' | 'wrong-host' | 'too-many-redirects' | 'timeout' | 'network-error'; details: string };

export async function headCheck(url: string, opts: HeadCheckOptions, signal: AbortSignal): Promise<HeadCheckResult>;

export function isHostAllowed(host: string, whitelist: string[]): boolean;
```

`isHostAllowed` does suffix matching: `oll.libertyfund.org` matches `libertyfund.org` in the whitelist. Wildcards (`*.archive.org`) optional for v0.1.

## Implementation notes

- **Switch to `undici.request`**: Node's built-in `fetch` is built on `undici` but doesn't expose redirect history. Use `undici.request` with `maxRedirections: 0` (manual redirect following) so each hop can be inspected and validated. `undici` is built into Node 20+; no extra dependency.
- **HEAD→GET fallback**: on a 4xx-not-404 status from a HEAD request, retry with `GET` + header `Range: bytes=0-0` and use that response for status and redirect chain. Many trusted hosts (HathiTrust, archive.org backends, Liberty Fund's CDN) return 405 or 403 to HEAD; without this fallback they would surface as `dead-url`.
- **Redirect chain SSRF mitigation**: the manual-redirect loop validates EVERY hop's host before following. Use `dns.lookup(hostname, { all: true })` to enumerate resolved IPs and reject any that fall in private/reserved ranges: `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `::1`, `fc00::/7`. Also reject any URL whose scheme is not `http` or `https`. Without per-hop validation, a redirect from a trusted host to `169.254.169.254` would still execute and could exfiltrate cloud metadata.
- **AbortSignal**: `headCheck` accepts `signal: AbortSignal` (REQUIRED). Internally compose with timeout: `AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])` (Node 20.3+).
- **Per-host concurrency**: `HttpClient` owns the `p-queue` pool. `createHttpClient(opts)` creates an internal `Map<origin, PQueue>` with `concurrency: 2` per origin (configurable via opts). Every `get`/`head` call enters the queue for its target's origin before dispatching. This is where the per-origin concurrency cap documented in T05 is enforced.
- **Retry layer**: T06 implements 1–2 retries with jittered backoff (250ms base, 1.5× multiplier) on 5xx and network errors. Never retry on 4xx. Per-attempt timeout 10s; total per-call deadline 30s. T05's clients call into T06 without any retry awareness.
- **JSON parsing**: in `get`, if `Content-Type` includes `application/json`, parse `body` as JSON; otherwise return text. Don't throw on JSON-parse errors; return text in `body`.
- **HEAD caching**: cache `HeadCheckResult` keyed by URL. Default TTL same as cache default (30 days). Dead-URL results should still be cached (avoid re-pinging dead links).
- **Host extraction**: `new URL(finalUrl).hostname.toLowerCase()`.

## Acceptance criteria

- [ ] `HttpClient` interface exported.
- [ ] `createHttpClient()` returns a real implementation backed by `fetch`.
- [ ] `head(url)` follows redirects up to `maxRedirects`; returns chain.
- [ ] `head(url, { followRedirects: false })` returns the first response without following.
- [ ] Timeout aborts the request after `timeoutMs`.
- [ ] Caller `signal` aborts the request.
- [ ] `headCheck` returns `{ ok: true }` for 200 + trusted host.
- [ ] `headCheck` returns `{ ok: false, reason: 'wrong-host' }` when final URL is on an untrusted host.
- [ ] `headCheck` returns `{ ok: false, reason: 'dead-url' }` for 404 / 410 / 5xx.
- [ ] `headCheck` returns `{ ok: false, reason: 'too-many-redirects' }` when chain exceeds `maxRedirects`.
- [ ] `headCheck` caches results when a cache is provided.
- [ ] `isHostAllowed` does suffix matching correctly.
- [ ] HEAD returns 405 → GET with Range fallback succeeds.
- [ ] Redirect to `127.0.0.1` is rejected (test with a local mock server).
- [ ] Redirect to `file://` URL is rejected.
- [ ] Per-origin concurrency 2 verified.
- [ ] Retry on 503 fires once; retry on 404 does NOT fire.
- [ ] AbortSignal cancels in-flight request.

## Tests

`test/http.test.ts`:

- Use a small in-process HTTP server (`node:http` `createServer`) rather than mocking `fetch` — gives realistic redirect / timeout / 404 behaviour. Start on port 0 (auto-assigned), stop in `afterEach`.
- HEAD: 200 → ok, redirect chain → ok with chain, 404 → dead-url, timeout → timeout.
- Redirect chain: 3-hop redirect ending in 200 returns the intermediate URLs.
- Too-many-redirects: 6-hop chain with maxRedirects=5 returns `too-many-redirects`.
- AbortSignal: caller aborts; promise rejects.
- `isHostAllowed`: suffix matching positive and negative cases.
- HEAD cache hit on second call.

Coverage target: ≥ 80% line + branch for `src/http.ts`.

## New dependencies

- `p-queue` — per-origin concurrency queue. Confirm before adding to `package.json` `dependencies`.
- `undici` — built into Node 20+; no separate install needed. Used instead of `fetch` to enable manual redirect following and redirect-chain inspection.
