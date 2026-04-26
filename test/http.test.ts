/**
 * Tests for src/http.ts.
 *
 * Uses a small in-process HTTP server (node:http createServer) for realistic
 * behaviour. Each describe block starts a server on port 0 (auto-assigned) and
 * stops it in afterEach.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as nodeHttp from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  createHttpClient,
  headCheck,
  isHostAllowed,
  isPrivateIp,
  HttpError,
  type HeadCheckOptions,
} from '../src/http.js';
import { createMemoryCache } from '../src/cache/fs-cache.js';

// ---------------------------------------------------------------------------
// Test-server helpers
// ---------------------------------------------------------------------------

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void;

function startServer(handler: RouteHandler): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = nodeHttp.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({
        port,
        close: () =>
          new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res()))),
      });
    });
  });
}

function jsonHandler(body: unknown, status = 200): RouteHandler {
  return (_req, res) => {
    const data = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(data),
    });
    res.end(data);
  };
}

function textHandler(body: string, status = 200): RouteHandler {
  return (_req, res) => {
    res.writeHead(status, {
      'content-type': 'text/plain',
      'content-length': Buffer.byteLength(body),
    });
    res.end(body);
  };
}

// ---------------------------------------------------------------------------
// createHttpClient.get tests
// ---------------------------------------------------------------------------

describe('createHttpClient.get', () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it('1. returns body parsed as JSON when content-type is JSON', async () => {
    const { port, close: c } = await startServer(jsonHandler({ hello: 'world' }));
    close = c;

    const client = createHttpClient();
    const response = await client.get(`http://127.0.0.1:${port}/`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ hello: 'world' });
  });

  it('2. returns body as string when content-type is text/plain', async () => {
    const { port, close: c } = await startServer(textHandler('plain text'));
    close = c;

    const client = createHttpClient();
    const response = await client.get(`http://127.0.0.1:${port}/`);

    expect(response.status).toBe(200);
    expect(response.body).toBe('plain text');
  });

  it('3. retries on 5xx; server returns 500 twice then 200', async () => {
    let callCount = 0;
    const { port, close: c } = await startServer((_req, res) => {
      callCount++;
      if (callCount <= 2) {
        res.writeHead(500);
        res.end('error');
      } else {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
      }
    });
    close = c;

    const client = createHttpClient({ retryBaseMs: 10, maxRetries: 2 });
    const response = await client.get(`http://127.0.0.1:${port}/`);

    expect(response.status).toBe(200);
    expect(callCount).toBe(3);
  });

  it('4. 404 does NOT trigger retry', async () => {
    let callCount = 0;
    const { port, close: c } = await startServer((_req, res) => {
      callCount++;
      res.writeHead(404);
      res.end('not found');
    });
    close = c;

    const client = createHttpClient({ retryBaseMs: 10, maxRetries: 2 });
    const response = await client.get(`http://127.0.0.1:${port}/`);

    expect(response.status).toBe(404);
    expect(callCount).toBe(1);
  });

  it('5. AbortSignal cancels in-flight request', async () => {
    const { port, close: c } = await startServer((_req, res) => {
      // Delay response to ensure abort can fire
      setTimeout(() => res.end('too late'), 2000);
    });
    close = c;

    const controller = new AbortController();
    const client = createHttpClient({ defaultTimeoutMs: 5000 });

    const promise = client.get(`http://127.0.0.1:${port}/`, { signal: controller.signal });
    // Abort immediately
    controller.abort(new Error('user cancelled'));

    await expect(promise).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// createHttpClient.head tests
// ---------------------------------------------------------------------------

describe('createHttpClient.head', () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it('6. follows 302 redirect; redirectChain has one entry', async () => {
    const { port, close: c } = await startServer((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { location: '/end' });
        res.end();
      } else {
        res.writeHead(200);
        res.end();
      }
    });
    close = c;

    const client = createHttpClient();
    const response = await client.head(`http://127.0.0.1:${port}/start`);

    expect(response.status).toBe(200);
    expect(response.redirectChain).toHaveLength(1);
    expect(response.redirectChain[0]).toContain('/start');
    expect(response.finalUrl).toContain('/end');
  });

  it('7. HEAD 405 triggers GET+Range fallback returning 200', async () => {
    const { port, close: c } = await startServer((req, res) => {
      if (req.method === 'HEAD') {
        res.writeHead(405);
        res.end();
      } else {
        // GET with Range — respond 206 Partial Content
        res.writeHead(206, { 'content-type': 'text/plain' });
        res.end('x');
      }
    });
    close = c;

    const client = createHttpClient();
    const response = await client.head(`http://127.0.0.1:${port}/resource`);

    // 405 falls back to GET, which returns 206 (success range)
    expect(response.status).toBe(206);
    expect(response.finalUrl).toContain('/resource');
  });

  it('8. redirect to 127.0.0.1 is rejected with HttpError', async () => {
    // We need a real server that redirects to a private IP.
    // But we also need to make sure the redirect target doesn't resolve.
    // We'll redirect to a different 127.x address that isPrivateIp catches.
    const { port, close: c } = await startServer((_req, res) => {
      res.writeHead(302, { location: 'http://127.0.0.2:9999/target' });
      res.end();
    });
    close = c;

    const client = createHttpClient();
    await expect(
      client.head(`http://127.0.0.1:${port}/redirect`),
    ).rejects.toMatchObject({ name: 'HttpError', message: expect.stringContaining('private IP') });
  });

  it('9. non-http scheme (ftp://) is rejected', async () => {
    const client = createHttpClient();
    await expect(
      client.head('ftp://example.com/file'),
    ).rejects.toMatchObject({ name: 'HttpError', message: expect.stringContaining('scheme') });
  });
});

// ---------------------------------------------------------------------------
// isHostAllowed
// ---------------------------------------------------------------------------

describe('isHostAllowed', () => {
  it('10. suffix matching: oll.libertyfund.org matches libertyfund.org', () => {
    expect(isHostAllowed('oll.libertyfund.org', ['libertyfund.org'])).toBe(true);
  });

  it('11. empty whitelist returns false', () => {
    expect(isHostAllowed('example.com', [])).toBe(false);
  });

  it('12. case-insensitive matching', () => {
    expect(isHostAllowed('EXAMPLE.COM', ['example.com'])).toBe(true);
    expect(isHostAllowed('example.com', ['EXAMPLE.COM'])).toBe(true);
  });

  it('exact match works', () => {
    expect(isHostAllowed('example.com', ['example.com'])).toBe(true);
  });

  it('unrelated host returns false', () => {
    expect(isHostAllowed('evil.com', ['libertyfund.org'])).toBe(false);
  });

  it('partial prefix does not match (foo.libertyfund.org.evil.com is not allowed)', () => {
    expect(isHostAllowed('libertyfund.org.evil.com', ['libertyfund.org'])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isPrivateIp
// ---------------------------------------------------------------------------

describe('isPrivateIp', () => {
  it('13. 127.0.0.1 is private', () => {
    expect(isPrivateIp('127.0.0.1')).toBe(true);
  });

  it('14. 8.8.8.8 is not private', () => {
    expect(isPrivateIp('8.8.8.8')).toBe(false);
  });

  it('15. 169.254.169.254 is private (link-local)', () => {
    expect(isPrivateIp('169.254.169.254')).toBe(true);
  });

  it('16. ::1 is private (IPv6 loopback)', () => {
    expect(isPrivateIp('::1')).toBe(true);
  });

  it('17. fc00::1 is private (IPv6 ULA)', () => {
    expect(isPrivateIp('fc00::1')).toBe(true);
  });

  it('10.0.0.1 is private', () => {
    expect(isPrivateIp('10.0.0.1')).toBe(true);
  });

  it('172.16.0.1 is private', () => {
    expect(isPrivateIp('172.16.0.1')).toBe(true);
  });

  it('172.32.0.1 is not private (outside 172.16–31)', () => {
    expect(isPrivateIp('172.32.0.1')).toBe(false);
  });

  it('192.168.1.1 is private', () => {
    expect(isPrivateIp('192.168.1.1')).toBe(true);
  });

  it('fe80::1 is private (IPv6 link-local)', () => {
    expect(isPrivateIp('fe80::1')).toBe(true);
  });

  it('fd00::1 is private (IPv6 ULA)', () => {
    expect(isPrivateIp('fd00::1')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// headCheck
// ---------------------------------------------------------------------------

describe('headCheck', () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it('18. trusted host returns { ok: true }', async () => {
    const { port, close: c } = await startServer((_req, res) => {
      res.writeHead(200);
      res.end();
    });
    close = c;

    const client = createHttpClient();
    const opts: HeadCheckOptions = {
      http: client,
      trustedHosts: ['127.0.0.1'],
    };

    const result = await headCheck(`http://127.0.0.1:${port}/ok`, opts, AbortSignal.timeout(5000));
    expect(result).toMatchObject({ ok: true, status: 200, host: '127.0.0.1' });
  });

  it('19. untrusted host returns { ok: false, reason: "wrong-host" }', async () => {
    const { port, close: c } = await startServer((_req, res) => {
      res.writeHead(200);
      res.end();
    });
    close = c;

    const client = createHttpClient();
    const opts: HeadCheckOptions = {
      http: client,
      trustedHosts: ['example.com'],
    };

    const result = await headCheck(`http://127.0.0.1:${port}/ok`, opts, AbortSignal.timeout(5000));
    expect(result).toMatchObject({ ok: false, reason: 'wrong-host' });
  });

  it('20. 404 response returns { ok: false, reason: "dead-url" }', async () => {
    const { port, close: c } = await startServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    close = c;

    const client = createHttpClient();
    const opts: HeadCheckOptions = {
      http: client,
      trustedHosts: ['127.0.0.1'],
    };

    const result = await headCheck(`http://127.0.0.1:${port}/gone`, opts, AbortSignal.timeout(5000));
    expect(result).toMatchObject({ ok: false, reason: 'dead-url', details: '404' });
  });

  it('21. redirect to private IP returns { ok: false, reason: "wrong-host" }', async () => {
    const { port, close: c } = await startServer((_req, res) => {
      res.writeHead(302, { location: 'http://127.0.0.2:9999/target' });
      res.end();
    });
    close = c;

    const client = createHttpClient();
    const opts: HeadCheckOptions = {
      http: client,
      trustedHosts: ['127.0.0.1'],
    };

    const result = await headCheck(
      `http://127.0.0.1:${port}/redirect`,
      opts,
      AbortSignal.timeout(5000),
    );
    expect(result).toMatchObject({ ok: false, reason: 'wrong-host', details: 'redirect to private IP rejected' });
  });

  it('22. cache hit on second call (no second HTTP request)', async () => {
    let requestCount = 0;
    const { port, close: c } = await startServer((_req, res) => {
      requestCount++;
      res.writeHead(200);
      res.end();
    });
    close = c;

    const client = createHttpClient();
    const cache = createMemoryCache();
    const opts: HeadCheckOptions = {
      http: client,
      cache,
      trustedHosts: ['127.0.0.1'],
    };

    const url = `http://127.0.0.1:${port}/cached`;
    const signal = AbortSignal.timeout(5000);

    const first = await headCheck(url, opts, signal);
    const second = await headCheck(url, opts, signal);

    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: true });
    // Only one HTTP request should have been made
    expect(requestCount).toBe(1);
  });

  it('headCheck with network error returns { ok: false, reason: "network-error" }', async () => {
    // Point at a port that is definitely not listening
    const unusedPort = 19999;
    const client = createHttpClient({ maxRetries: 0 });
    const opts: HeadCheckOptions = {
      http: client,
      trustedHosts: ['127.0.0.1'],
    };

    const result = await headCheck(
      `http://127.0.0.1:${unusedPort}/gone`,
      opts,
      AbortSignal.timeout(5000),
    );
    expect(result).toMatchObject({ ok: false });
    expect(['network-error', 'timeout']).toContain((result as { ok: false; reason: string }).reason);
  });

  it('headCheck with pre-aborted signal returns timeout result', async () => {
    const { port, close: c } = await startServer((_req, res) => {
      setTimeout(() => res.end(), 2000);
    });
    close = c;

    // Create an already-aborted signal
    const controller = new AbortController();
    const client = createHttpClient({ maxRetries: 0 });
    const opts: HeadCheckOptions = {
      http: client,
      trustedHosts: ['127.0.0.1'],
    };

    // Use a very short timeout to simulate a timeout-like condition at headCheck level
    const abortedSignal = AbortSignal.timeout(1); // expires almost immediately
    // Give it a tick to expire
    await new Promise(r => setTimeout(r, 5));

    const result = await headCheck(
      `http://127.0.0.1:${port}/slow`,
      opts,
      abortedSignal,
    );
    // After timeout, result should be ok:false
    expect(result.ok).toBe(false);
    void controller;
  });
});

// ---------------------------------------------------------------------------
// Per-origin concurrency (optional advanced test)
// ---------------------------------------------------------------------------

describe('per-origin concurrency', () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it('23. ≤2 in-flight requests to same origin at once (concurrency=2)', async () => {
    let maxConcurrent = 0;
    let current = 0;

    const { port, close: c } = await startServer((_req, res) => {
      current++;
      if (current > maxConcurrent) maxConcurrent = current;
      // Slow response so multiple requests pile up
      setTimeout(() => {
        current--;
        res.writeHead(200);
        res.end();
      }, 30);
    });
    close = c;

    const client = createHttpClient({ perOriginConcurrency: 2 });
    const url = `http://127.0.0.1:${port}/`;

    await Promise.all([
      client.head(url),
      client.head(url),
      client.head(url),
      client.head(url),
      client.head(url),
    ]);

    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// HttpError export
// ---------------------------------------------------------------------------

describe('HttpError', () => {
  it('is an instance of Error', () => {
    const e = new HttpError('something went wrong', 503);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('HttpError');
    expect(e.status).toBe(503);
    expect(e.message).toBe('something went wrong');
  });
});

// ---------------------------------------------------------------------------
// head with followRedirects: false
// ---------------------------------------------------------------------------

describe('head followRedirects: false', () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it('returns first response without following redirects', async () => {
    const { port, close: c } = await startServer((_req, res) => {
      res.writeHead(302, { location: '/final' });
      res.end();
    });
    close = c;

    const client = createHttpClient();
    const response = await client.head(`http://127.0.0.1:${port}/start`, {
      followRedirects: false,
    });

    expect(response.status).toBe(302);
    expect(response.redirectChain).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// too-many-redirects via headCheck
// ---------------------------------------------------------------------------

describe('headCheck too-many-redirects', () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it('returns { ok: false, reason: "too-many-redirects" } when chain exceeds maxRedirects', async () => {
    // Server that keeps redirecting to itself
    const { port, close: c } = await startServer((req, res) => {
      const n = parseInt(new URL(req.url ?? '/', `http://127.0.0.1:${port}`).searchParams.get('n') ?? '0');
      if (n < 10) {
        res.writeHead(302, { location: `/?n=${n + 1}` });
        res.end();
      } else {
        res.writeHead(200);
        res.end();
      }
    });
    close = c;

    const client = createHttpClient();
    const opts: HeadCheckOptions = {
      http: client,
      trustedHosts: ['127.0.0.1'],
    };

    const result = await headCheck(
      `http://127.0.0.1:${port}/?n=0`,
      opts,
      AbortSignal.timeout(10000),
    );

    expect(result).toMatchObject({ ok: false, reason: 'too-many-redirects' });
  });
});
