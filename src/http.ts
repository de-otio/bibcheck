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

export function isPrivateIp(ip: string): boolean {
  // IPv6 special cases
  if (ip === '::1') return true;
  // fc00::/7 — addresses starting with fc or fd
  if (/^fc[0-9a-f]{2}:/i.test(ip) || /^fd[0-9a-f]{2}:/i.test(ip)) return true;
  // fe80::/10
  if (/^fe[89ab][0-9a-f]:/i.test(ip)) return true;

  // IPv4
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4) return false;
  const [a, b, c] = parts;
  /* c8 ignore next */
  if (a === undefined || b === undefined || c === undefined) return false; // unreachable: length checked above
  // noUncheckedIndexedAccess: array destructuring checked by length guard above

  if (a === 127) return true;                          // 127.0.0.0/8
  if (a === 10) return true;                           // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12
  if (a === 192 && b === 168) return true;             // 192.168.0.0/16
  if (a === 169 && b === 254) return true;             // 169.254.0.0/16

  return false;
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

async function assertNotPrivate(url: string): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new HttpError(`rejected: unsupported scheme ${parsed.protocol}`);
  }
  const hostname = parsed.hostname;
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
  return status >= 500;
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

        try {
          const result = await fn(combined);

          if (isRetryableStatus(result.status)) {
            lastStatus = result.status;
            lastError = new HttpError(`HTTP ${result.status}`, result.status);
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
          const delay = backoffMs(attempt, retryBaseMs);
          const remaining = Math.max(0, totalDeadlineMs - (Date.now() - startTime));
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
    // Validate the scheme of the initial URL (but not IP — caller controls it).
    const initialParsed = new URL(currentUrl);
    if (initialParsed.protocol !== 'http:' && initialParsed.protocol !== 'https:') {
      throw new HttpError(`rejected: unsupported scheme ${initialParsed.protocol}`);
    }
    // Track the initial hostname so same-host redirects bypass the SSRF IP check.
    const initialHostname = initialParsed.hostname;

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
        const nextHostname = new URL(nextUrl).hostname;
        // SSRF guard for redirect targets that move to a different host.
        // Same-host redirects are allowed (the caller already chose to connect).
        if (nextHostname !== initialHostname) {
          await assertNotPrivate(nextUrl);
        } else {
          // Still reject non-http(s) schemes even for same-host redirects.
          const nextProto = new URL(nextUrl).protocol;
          if (nextProto !== 'http:' && nextProto !== 'https:') {
            throw new HttpError(`rejected: unsupported scheme ${nextProto}`);
          }
        }
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
