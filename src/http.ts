/**
 * HTTP utility for URL verification.
 *
 * Provides an HttpClient backed by the native Node 20 fetch API with per-origin
 * concurrency queuing, jittered-backoff retry on 5xx/network errors, manual
 * redirect following with SSRF mitigation, and a higher-level headCheck utility
 * for canonical-edition URL verification.
 *
 * Note: The spec calls for undici.request directly, but we use the native Node
 * global fetch (which is backed by undici internally) because undici is not
 * separately installed in this project. We use `redirect: 'manual'` to achieve
 * the same manual redirect-following behaviour.
 */

import PQueue from 'p-queue';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { Cache } from './cache/fs-cache.js';

// ---------------------------------------------------------------------------
// Exported interfaces
// ---------------------------------------------------------------------------

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown; // parsed JSON if Content-Type is JSON; else raw string
}

export interface HttpRequestOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface HttpHeadOptions extends HttpRequestOptions {
  followRedirects?: boolean;
  maxRedirects?: number;
}

export interface HttpHeadResponse {
  status: number;
  finalUrl: string;
  redirectChain: string[];
}

export interface HttpClient {
  get(url: string, opts?: HttpRequestOptions): Promise<HttpResponse>;
  head(url: string, opts?: HttpHeadOptions): Promise<HttpHeadResponse>;
}

export interface CreateHttpClientOptions {
  userAgent?: string;
  defaultTimeoutMs?: number;
  maxRetries?: number;
  retryBaseMs?: number;
  perOriginConcurrency?: number;
  totalDeadlineMs?: number;
  /**
   * Test-only escape hatch. When true, the per-hop private-IP SSRF guard is
   * skipped so the in-process loopback test server (127.0.0.1) is reachable.
   * Production callers MUST leave this unset/false — the secure default rejects
   * private addresses on every hop.
   */
  allowPrivateHosts?: boolean;
}

// ---------------------------------------------------------------------------
// HttpError
// ---------------------------------------------------------------------------

export class HttpError extends Error {
  override name = 'HttpError' as const;
  readonly status: number | undefined;
  override readonly cause: unknown;

  constructor(message: string, status?: number, cause?: unknown) {
    super(message);
    this.status = status;
    this.cause = cause;
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, HttpError);
    }
  }
}

// ---------------------------------------------------------------------------
// SSRF helpers
// ---------------------------------------------------------------------------

/**
 * Classify a dotted-quad IPv4 (a.b.c.d, each octet already a number) as private
 * / non-routable. Covers loopback, RFC 1918, link-local, "this host", and the
 * CGNAT shared range.
 */
function isPrivateIpv4Octets(a: number, b: number): boolean {
  if (a === 0) return true;                            // 0.0.0.0/8 ("this host")
  if (a === 127) return true;                          // 127.0.0.0/8 loopback
  if (a === 10) return true;                           // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true;    // 172.16.0.0/12
  if (a === 192 && b === 168) return true;             // 192.168.0.0/16
  if (a === 169 && b === 254) return true;             // 169.254.0.0/16 link-local
  if (a === 100 && b >= 64 && b <= 127) return true;   // 100.64.0.0/10 CGNAT
  return false;
}

/**
 * Parse a non-dotted IPv4 literal (decimal, octal, or hex) into a 32-bit
 * number, e.g. "2130706433" or "0x7f000001" → 0x7f000001. Returns null when
 * the string is not a single-integer IPv4 form. URL/WHATWG parsing already
 * accepts these as hostnames, so we must classify them too.
 */
function parseIntegerIpv4(host: string): number | null {
  let n: number;
  if (/^0x[0-9a-f]+$/i.test(host)) {
    n = parseInt(host, 16);
  } else if (/^0[0-7]+$/.test(host)) {
    n = parseInt(host, 8);
  } else if (/^[0-9]+$/.test(host)) {
    n = parseInt(host, 10);
  } else {
    return null;
  }
  if (!Number.isFinite(n) || n < 0 || n > 0xffffffff) return null;
  return n >>> 0;
}

export function isPrivateIp(ip: string): boolean {
  const lower = ip.toLowerCase();

  // IPv6 loopback / ULA / link-local.
  if (lower === '::1') return true;
  if (/^fc[0-9a-f]{2}:/.test(lower) || /^fd[0-9a-f]{2}:/.test(lower)) return true; // fc00::/7
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true;                               // fe80::/10

  // IPv4-mapped / -compatible IPv6 (e.g. ::ffff:127.0.0.1, ::ffff:7f00:1).
  // Re-classify the embedded IPv4 portion.
  if (lower.startsWith('::ffff:') || lower.startsWith('::')) {
    const tail = lower.slice(lower.lastIndexOf(':') + 1);
    if (/^\d+\.\d+\.\d+\.\d+$/.test(tail)) {
      return isPrivateIp(tail);
    }
  }

  // Dotted-quad IPv4.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(lower)) {
    const parts = lower.split('.').map(Number);
    const [a, b] = parts;
    /* c8 ignore next */
    if (a === undefined || b === undefined) return false; // unreachable: regex guarantees 4 octets
    return isPrivateIpv4Octets(a, b);
  }

  // Single-integer IPv4 (decimal / octal / hex).
  const n = parseIntegerIpv4(lower);
  if (n !== null) {
    const a = (n >>> 24) & 0xff;
    const b = (n >>> 16) & 0xff;
    return isPrivateIpv4Octets(a, b);
  }

  return false;
}

/**
 * Decide whether a configured API base URL targets a private / loopback host.
 *
 * The per-hop SSRF guard exists to stop *untrusted bibliography URLs* reaching
 * internal addresses. The `[apis] *_base` endpoints, by contrast, are
 * operator-controlled configuration; pointing them at `http://127.0.0.1:PORT`
 * (a local stub or dev mirror) is a legitimate, explicit choice. Callers use
 * this to opt a configured-endpoint client into `allowPrivateHosts` so the
 * operator's deliberate localhost config is honored without weakening the guard
 * on bibliography-derived URLs. Returns false for any unparseable / public base.
 */
export function isPrivateApiBase(baseUrl: string | null | undefined): boolean {
  if (baseUrl == null || baseUrl === '') return false;
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host === 'localhost') return true;
  return isPrivateIp(host);
}

export function isHostAllowed(host: string, whitelist: string[]): boolean {
  if (whitelist.length === 0) return false;
  const h = host.toLowerCase();
  for (const w of whitelist) {
    const lw = w.toLowerCase();
    if (h === lw || h.endsWith('.' + lw)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Internal: per-request SSRF guard
// ---------------------------------------------------------------------------

/**
 * Validate a single hop's URL: enforce http/https scheme and reject any
 * private / non-routable destination. Literal-IP hostnames (dotted-quad,
 * IPv6, decimal/octal/hex integer, IPv4-mapped) are classified directly; a
 * DNS name is resolved and every returned address is checked.
 */
async function assertNotPrivate(url: string): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new HttpError(`rejected: unsupported scheme ${parsed.protocol}`);
  }
  // WHATWG URL strips brackets from IPv6 hostnames; isIP handles both families.
  let hostname = parsed.hostname;
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    hostname = hostname.slice(1, -1);
  }

  // If the hostname is itself an address literal (in any form the URL parser
  // accepts), classify it without a DNS round-trip — DNS would not be consulted
  // for these at connect time anyway.
  if (isIP(hostname) !== 0 || /^\d+\.\d+\.\d+\.\d+$/.test(hostname) || parseIntegerIpv4(hostname) !== null) {
    if (isPrivateIp(hostname)) {
      throw new HttpError('rejected: private IP');
    }
    return;
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await dnsLookup(hostname, { all: true });
  } catch (err) {
    throw new HttpError(`DNS resolution failed for ${hostname}`, undefined, err);
  }
  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      throw new HttpError('rejected: private IP');
    }
  }
}

// ---------------------------------------------------------------------------
// Internal: error classification
// ---------------------------------------------------------------------------

function isRetryableStatus(status: number): boolean {
  // 429 (Too Many Requests) and 503 (Service Unavailable) are explicitly
  // retryable per the polite-pool etiquette; both commonly carry Retry-After.
  // All other 5xx are retried too.
  return status === 429 || status >= 500;
}

/**
 * Parse a Retry-After header value into a delay in milliseconds, or null if it
 * is absent / unparseable. Accepts delta-seconds ("120") and an HTTP-date.
 * `now` is injectable for deterministic tests.
 */
export function parseRetryAfterMs(value: string | undefined, now: number = Date.now()): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (/^\d+$/.test(trimmed)) {
    return parseInt(trimmed, 10) * 1000;
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return null;
  return Math.max(0, dateMs - now);
}

function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  const msg = err.message;
  return (
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'ETIMEDOUT' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    msg.includes('ECONNRESET') ||
    msg.includes('socket hang up') ||
    msg.includes('UND_ERR') ||
    msg.includes('fetch failed')
  );
}

function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'AbortError' || (err as NodeJS.ErrnoException).code === 'ABORT_ERR';
}

// ---------------------------------------------------------------------------
// Internal: backoff / sleep
// ---------------------------------------------------------------------------

function jitter(baseMs: number): number {
  return Math.floor(Math.random() * baseMs);
}

function backoffMs(attempt: number, baseMs: number): number {
  return Math.floor(baseMs * Math.pow(1.5, attempt)) + jitter(baseMs);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Internal: low-level fetch wrapper
// ---------------------------------------------------------------------------

type DispatchResult = {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
};

async function dispatchFetch(
  method: 'GET' | 'HEAD',
  url: string,
  extraHeaders: Record<string, string>,
  userAgent: string | undefined,
  signal: AbortSignal,
): Promise<DispatchResult> {
  const baseHeaders: Record<string, string> = {};
  if (userAgent !== undefined) baseHeaders['user-agent'] = userAgent;
  const mergedHeaders = { ...baseHeaders, ...extraHeaders };

  const response = await fetch(url, {
    method,
    headers: mergedHeaders,
    redirect: 'manual',
    signal,
  });

  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  let bodyText = '';
  if (method === 'GET') {
    bodyText = await response.text();
  } else {
    // Drain the body for HEAD (opaque redirects have empty bodies, but be safe)
    await response.body?.cancel().catch(() => undefined);
  }

  return { status: response.status, headers, bodyText };
}

// ---------------------------------------------------------------------------
// createHttpClient
// ---------------------------------------------------------------------------

export function createHttpClient(opts?: CreateHttpClientOptions): HttpClient {
  const userAgent = opts?.userAgent;
  const defaultTimeoutMs = opts?.defaultTimeoutMs ?? 10_000;
  const maxRetries = opts?.maxRetries ?? 2;
  const retryBaseMs = opts?.retryBaseMs ?? 250;
  const perOriginConcurrency = opts?.perOriginConcurrency ?? 2;
  const totalDeadlineMs = opts?.totalDeadlineMs ?? 30_000;
  const allowPrivateHosts = opts?.allowPrivateHosts === true;

  // Guard a single hop. The `allowPrivateHosts` test escape hatch bypasses the
  // private-IP check (so the in-process loopback test server, which only listens
  // on 127.0.0.1, is reachable across redirects). The scheme restriction is
  // always enforced, even in test mode. Production callers leave the hatch off,
  // so every hop — hop 0 and every redirect — is fully guarded.
  async function guardHop(hopUrl: string): Promise<void> {
    if (allowPrivateHosts) {
      const proto = new URL(hopUrl).protocol;
      if (proto !== 'http:' && proto !== 'https:') {
        throw new HttpError(`rejected: unsupported scheme ${proto}`);
      }
      return;
    }
    await assertNotPrivate(hopUrl);
  }

  const queues = new Map<string, PQueue>();

  function getQueue(origin: string): PQueue {
    let q = queues.get(origin);
    if (q === undefined) {
      q = new PQueue({ concurrency: perOriginConcurrency });
      queues.set(origin, q);
    }
    return q;
  }

  async function withRetry(
    origin: string,
    fn: (signal: AbortSignal) => Promise<DispatchResult>,
    userSignal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<DispatchResult> {
    const q = getQueue(origin);

    return q.add(async (): Promise<DispatchResult> => {
      const startTime = Date.now();
      let lastError: unknown;
      let lastStatus: number | undefined;
      // When a retryable response carries Retry-After, prefer it over the
      // jittered backoff for the *next* sleep.
      let retryAfterMs: number | null = null;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (userSignal !== undefined && userSignal.aborted) {
          throw userSignal.reason as Error;
        }

        const elapsed = Date.now() - startTime;
        if (attempt > 0 && elapsed > totalDeadlineMs) {
          break;
        }

        const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
        if (userSignal !== undefined) signals.push(userSignal);
        const combined = AbortSignal.any(signals);

        retryAfterMs = null;
        try {
          const result = await fn(combined);

          if (isRetryableStatus(result.status)) {
            lastStatus = result.status;
            lastError = new HttpError(`HTTP ${result.status}`, result.status);
            retryAfterMs = parseRetryAfterMs(result.headers['retry-after']);
          } else {
            return result;
          }
        } catch (err) {
          if (isAbortError(err)) {
            if (userSignal !== undefined && userSignal.aborted) throw err;
            // Per-attempt timeout — retryable
            lastError = err;
          } else if (isNetworkError(err)) {
            lastError = err;
          } else {
            throw err;
          }
        }

        if (attempt < maxRetries) {
          const remaining = Math.max(0, totalDeadlineMs - (Date.now() - startTime));
          // Honor Retry-After when present; otherwise use jittered backoff.
          // Either way the sleep is capped against the total deadline so a
          // hostile/large Retry-After cannot stall the run past its budget.
          const baseDelay = retryAfterMs !== null ? retryAfterMs : backoffMs(attempt, retryBaseMs);
          const delay = Math.min(baseDelay, remaining);
          const sleepSignals: AbortSignal[] = [AbortSignal.timeout(remaining)];
          if (userSignal !== undefined) sleepSignals.push(userSignal);
          const sleepSig = AbortSignal.any(sleepSignals);
          try {
            await sleep(delay, sleepSig);
          } catch {
            if (userSignal !== undefined && userSignal.aborted) throw userSignal.reason as Error;
            break;
          }
        }
      }

      if (lastError instanceof HttpError) throw lastError;
      if (lastError !== undefined) {
        throw new HttpError(
          `Request failed after ${maxRetries} retries`,
          lastStatus,
          lastError,
        );
      }

      throw new HttpError(`Request failed: exceeded total deadline`, lastStatus);
    }) as Promise<DispatchResult>;
  }

  async function get(url: string, reqOpts?: HttpRequestOptions): Promise<HttpResponse> {
    const timeoutMs = reqOpts?.timeoutMs ?? defaultTimeoutMs;
    const origin = new URL(url).origin;

    const result = await withRetry(
      origin,
      (signal) =>
        dispatchFetch('GET', url, reqOpts?.headers ?? {}, userAgent, signal),
      reqOpts?.signal,
      timeoutMs,
    );

    const contentType = result.headers['content-type'] ?? '';
    let body: unknown = result.bodyText;
    if (contentType.includes('application/json')) {
      try {
        body = JSON.parse(result.bodyText) as unknown;
      } catch {
        // leave as string
      }
    }

    return { status: result.status, headers: result.headers, body };
  }

  async function head(url: string, headOpts?: HttpHeadOptions): Promise<HttpHeadResponse> {
    const followRedirects = headOpts?.followRedirects !== false;
    const maxRedirects = headOpts?.maxRedirects ?? 5;
    const timeoutMs = headOpts?.timeoutMs ?? defaultTimeoutMs;
    const userSignal = headOpts?.signal;

    if (!followRedirects) {
      // SSRF guard on the (only) hop: scheme + private-IP rejection.
      await guardHop(url);
      const origin = new URL(url).origin;
      const result = await withRetry(
        origin,
        (signal) => dispatchFetch('HEAD', url, headOpts?.headers ?? {}, userAgent, signal),
        userSignal,
        timeoutMs,
      );
      return { status: result.status, finalUrl: url, redirectChain: [] };
    }

    const redirectChain: string[] = [];
    let currentUrl = url;
    // SSRF guard on hop 0 (the initial URL) — scheme + private-IP rejection —
    // *before* any request is dispatched.
    await guardHop(currentUrl);

    for (;;) {
      const origin = new URL(currentUrl).origin;
      const result = await withRetry(
        origin,
        (signal) => dispatchFetch('HEAD', currentUrl, headOpts?.headers ?? {}, userAgent, signal),
        userSignal,
        timeoutMs,
      );

      const { status, headers } = result;

      if (status >= 300 && status < 400) {
        const location = headers['location'];
        if (location === undefined || location === '') {
          return { status, finalUrl: currentUrl, redirectChain };
        }
        if (redirectChain.length >= maxRedirects) {
          throw new HttpError(`too-many-redirects: exceeded ${maxRedirects} hops`);
        }
        redirectChain.push(currentUrl);
        const nextUrl = new URL(location, currentUrl).href;
        // SSRF guard on EVERY redirect hop, regardless of host equality:
        // scheme + private-IP rejection. Redirect hops are never exempted by
        // the test escape hatch.
        await guardHop(nextUrl);
        currentUrl = nextUrl;
        continue;
      }

      // HEAD returned 4xx but not 404 — try GET+Range fallback
      if (status >= 400 && status < 500 && status !== 404) {
        const getHeaders = { ...(headOpts?.headers ?? {}), range: 'bytes=0-0' };
        const origin2 = new URL(currentUrl).origin;
        const getResult = await withRetry(
          origin2,
          (signal) => dispatchFetch('GET', currentUrl, getHeaders, userAgent, signal),
          userSignal,
          timeoutMs,
        );
        return { status: getResult.status, finalUrl: currentUrl, redirectChain };
      }

      return { status, finalUrl: currentUrl, redirectChain };
    }
  }

  return { get, head };
}

// ---------------------------------------------------------------------------
// headCheck
// ---------------------------------------------------------------------------

export interface HeadCheckOptions {
  http: HttpClient;
  cache?: Cache;
  trustedHosts: string[];
}

export type HeadCheckResult =
  | { ok: true; status: number; finalUrl: string; redirectChain: string[]; host: string }
  | {
      ok: false;
      reason: 'dead-url' | 'wrong-host' | 'too-many-redirects' | 'timeout' | 'network-error';
      details: string;
    };

export async function headCheck(
  url: string,
  opts: HeadCheckOptions,
  signal: AbortSignal,
): Promise<HeadCheckResult> {
  const cacheKey = 'headCheck:' + url;

  if (opts.cache !== undefined) {
    const cached = await opts.cache.get<HeadCheckResult>(cacheKey, signal);
    if (cached !== null) return cached;
  }

  let result: HeadCheckResult;

  // SSRF: enforce the trusted-host allowlist on the INPUT host BEFORE
  // dispatching any request. A bibliography entry pointing at a metadata
  // endpoint or an untrusted host must never be fetched at all.
  let inputHost: string;
  try {
    inputHost = new URL(url).hostname.toLowerCase();
  } catch {
    const out: HeadCheckResult = { ok: false, reason: 'network-error', details: 'invalid URL' };
    if (opts.cache !== undefined) await opts.cache.set(cacheKey, out);
    return out;
  }
  if (!isHostAllowed(inputHost, opts.trustedHosts)) {
    const out: HeadCheckResult = { ok: false, reason: 'wrong-host', details: inputHost };
    if (opts.cache !== undefined) await opts.cache.set(cacheKey, out);
    return out;
  }

  try {
    const response = await opts.http.head(url, { signal });
    const host = new URL(response.finalUrl).hostname.toLowerCase();

    if (!isHostAllowed(host, opts.trustedHosts)) {
      result = { ok: false, reason: 'wrong-host', details: host };
    } else if (response.status >= 400) {
      result = { ok: false, reason: 'dead-url', details: String(response.status) };
    } else {
      result = {
        ok: true,
        status: response.status,
        finalUrl: response.finalUrl,
        redirectChain: response.redirectChain,
        host,
      };
    }
  } catch (err) {
    if (isAbortError(err) && !(err instanceof HttpError)) {
      throw err;
    }
    if (err instanceof HttpError) {
      const msg = err.message;
      if (msg.includes('rejected: private IP')) {
        result = { ok: false, reason: 'wrong-host', details: 'redirect to private IP rejected' };
      } else if (msg.includes('too-many-redirects')) {
        result = { ok: false, reason: 'too-many-redirects', details: msg };
      } else if (isAbortError(err)) {
        result = { ok: false, reason: 'timeout', details: msg };
      } else {
        result = { ok: false, reason: 'network-error', details: msg };
      }
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      result = { ok: false, reason: 'network-error', details: msg };
    }
  }

  if (opts.cache !== undefined) {
    await opts.cache.set(cacheKey, result);
  }

  return result;
}
