/**
 * Tests for src/doctor.ts — runDoctor diagnostic runner.
 *
 * All external I/O (filesystem, HTTP, bibliography loading, phrase loading)
 * is exercised via the injectable deps.fs interface and a mock HttpClient.
 * Real filesystem tests are avoided to keep the suite fast and hermetic.
 *
 * Note: loadBibliography and loadDenylist are real functions (they use
 * node:fs/promises internally), so tests that exercise those paths write
 * temporary files on disk. Checks that do NOT exercise those paths use
 * the injectable fs interface.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import * as nodeHttp from 'node:http';
import { runDoctor, type RunDoctorDeps, type DoctorCheck } from '../src/doctor.js';
import { ConfigSchema } from '../src/config.js';
import type { Config } from '../src/config.js';
import { createHttpClient, type HttpClient, type HttpHeadResponse } from '../src/http.js';
import { buildUserAgent } from '../src/cli.js';

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

/** Build a default Config using the schema's defaults. */
function defaultConfig(overrides: Partial<Config> = {}): Config {
  return ConfigSchema.parse({
    ...overrides,
  }) as Config;
}

/** Build a stub HttpClient where head() returns the given response. */
function makeHttp(headFn: (url: string) => Promise<HttpHeadResponse>): HttpClient {
  return {
    head: (_url, _opts) => headFn(_url),
    get: vi.fn().mockResolvedValue({ status: 200, headers: {}, body: '' }),
  };
}

/** Default head stub: returns 200 OK for all URLs. */
function okHeadFn(): (url: string) => Promise<HttpHeadResponse> {
  return async (_url) => ({ status: 200, finalUrl: _url, redirectChain: [] });
}

/** Build an injectable fs that always succeeds stat/access/readdir. */
function makeOkFs(cacheDirPath: string): NonNullable<RunDoctorDeps['fs']> {
  return {
    stat: async (p: string) => {
      // Anything inside cacheDir is a file; the cacheDir itself is a directory.
      if (p === cacheDirPath) return { size: 0, isDirectory: () => true };
      return { size: 1024, isDirectory: () => false };
    },
    access: async (_p: string) => { /* always succeeds */ },
    readdir: async (p: string) => {
      if (p === cacheDirPath) return ['cache-file-1.json', 'cache-file-2.json'];
      return [];
    },
  };
}

/** Build an injectable fs where access() throws for the given path. */
function makeMissingFs(missingPath: string): NonNullable<RunDoctorDeps['fs']> {
  return {
    stat: async (_p: string) => ({ size: 0, isDirectory: () => false }),
    access: async (p: string) => {
      if (p === missingPath) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    readdir: async (_p: string) => [],
  };
}

/** Helper to get a check by name. */
function getCheck(checks: DoctorCheck[], name: string): DoctorCheck | undefined {
  return checks.find((c) => c.name === name);
}

// ---------------------------------------------------------------------------
// Temp directory helpers (for real-fs tests)
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(async () => {
  tempDir = join(tmpdir(), `bibcheck-doctor-test-${randomUUID()}`);
  await mkdir(tempDir, { recursive: true });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test 1: All checks pass
// ---------------------------------------------------------------------------

describe('runDoctor — all checks pass', () => {
  it('returns ok:true with all status:ok when everything is healthy', async () => {
    // Write a minimal valid bibliography file so loadBibliography succeeds.
    const bibFile = join(tempDir, 'sources.json');
    await writeFile(bibFile, JSON.stringify([{ id: 'test-entry', type: 'book' }]), 'utf-8');

    const config = defaultConfig({
      bibliography: { file: 'sources.json' },
      cache: { dir: '.bibcheck-cache', max_size_mb: 256 },
      phrases: { file: null },
    });

    const cacheDir = resolve(tempDir, config.cache.dir);
    const fsStub = makeOkFs(cacheDir);

    const deps: RunDoctorDeps = {
      config,
      cwd: tempDir,
      http: makeHttp(okHeadFn()),
      signal: AbortSignal.timeout(30_000),
      fs: fsStub,
    };

    const result = await runDoctor(deps);

    expect(result.ok).toBe(true);
    expect(result.checks).toBeInstanceOf(Array);

    // Every check should be 'ok' or 'warn' (no 'fail').
    const failChecks = result.checks.filter((c) => c.status === 'fail');
    expect(failChecks).toHaveLength(0);

    // Verify key checks exist.
    expect(getCheck(result.checks, 'node-version')?.status).toBe('ok');
    expect(getCheck(result.checks, 'config-valid')?.status).toBe('ok');
    expect(getCheck(result.checks, 'bibliography-exists')?.status).toBe('ok');
    expect(getCheck(result.checks, 'bibliography-parses')?.status).toBe('ok');
    expect(getCheck(result.checks, 'crossref-connectivity')?.status).toBe('ok');
    expect(getCheck(result.checks, 'openalex-connectivity')?.status).toBe('ok');
    expect(getCheck(result.checks, 'openlibrary-connectivity')?.status).toBe('ok');
    expect(getCheck(result.checks, 'trusted-hosts')?.status).toBe('ok');

    // Bibliography parses check should include entry count.
    const bibParsesCheck = getCheck(result.checks, 'bibliography-parses');
    expect(bibParsesCheck?.details?.['entryCount']).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Test 2: Missing bibliography → ok: false
// ---------------------------------------------------------------------------

describe('runDoctor — missing bibliography', () => {
  it('emits fail checks for missing bibliography and sets ok:false', async () => {
    const config = defaultConfig({
      bibliography: { file: 'nonexistent-sources.json' },
      phrases: { file: null },
    });

    const cacheDir = resolve(tempDir, config.cache.dir);
    const fsStub = makeMissingFs(resolve(tempDir, 'nonexistent-sources.json'));
    // Override readdir to not fail for cache dir.
    const fsFull: NonNullable<RunDoctorDeps['fs']> = {
      ...fsStub,
      // access succeeds for everything except the bib file (handled by makeMissingFs)
      // but we also need readdir for cache size.
      readdir: async (_p: string) => [],
      stat: async (_p: string) => ({ size: 0, isDirectory: () => false }),
    };

    const deps: RunDoctorDeps = {
      config,
      cwd: tempDir,
      http: makeHttp(okHeadFn()),
      signal: AbortSignal.timeout(30_000),
      fs: fsFull,
    };

    const result = await runDoctor(deps);

    expect(result.ok).toBe(false);

    const existsCheck = getCheck(result.checks, 'bibliography-exists');
    expect(existsCheck?.status).toBe('fail');

    const parsesCheck = getCheck(result.checks, 'bibliography-parses');
    expect(parsesCheck?.status).toBe('fail');
  });
});

// ---------------------------------------------------------------------------
// Test 3: Cache dir doesn't exist → warn (not fail)
// ---------------------------------------------------------------------------

describe('runDoctor — cache dir missing', () => {
  it('emits warn (not fail) when cache directory does not exist', async () => {
    const bibFile = join(tempDir, 'sources.json');
    await writeFile(bibFile, JSON.stringify([]), 'utf-8');

    const config = defaultConfig({
      bibliography: { file: 'sources.json' },
      cache: { dir: '.bibcheck-cache', max_size_mb: 256 },
      phrases: { file: null },
    });

    const cacheDir = resolve(tempDir, config.cache.dir);
    // fs where access fails for the cache dir specifically
    const fsStub: NonNullable<RunDoctorDeps['fs']> = {
      stat: async (_p: string) => ({ size: 0, isDirectory: () => false }),
      access: async (p: string) => {
        // Allow access to bibliography, reject cache dir
        if (p === resolve(tempDir, 'sources.json')) return;
        if (p === cacheDir) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        // Allow all other paths
      },
      readdir: async (_p: string) => [],
    };

    const deps: RunDoctorDeps = {
      config,
      cwd: tempDir,
      http: makeHttp(okHeadFn()),
      signal: AbortSignal.timeout(30_000),
      fs: fsStub,
    };

    const result = await runDoctor(deps);

    const writableCheck = getCheck(result.checks, 'cache-writable');
    expect(writableCheck?.status).toBe('warn');
    // Should NOT be a fail.
    expect(writableCheck?.status).not.toBe('fail');
  });
});

// ---------------------------------------------------------------------------
// Test 4: CrossRef returns 503 → fail with HTTP code
// ---------------------------------------------------------------------------

describe('runDoctor — CrossRef 503', () => {
  it('emits fail (HTTP 503) when CrossRef returns 503', async () => {
    const bibFile = join(tempDir, 'sources.json');
    await writeFile(bibFile, JSON.stringify([]), 'utf-8');

    const config = defaultConfig({
      bibliography: { file: 'sources.json' },
      phrases: { file: null },
    });

    const cacheDir = resolve(tempDir, config.cache.dir);
    const fsStub = makeOkFs(cacheDir);

    const headFn = async (url: string): Promise<HttpHeadResponse> => {
      if (url.includes('crossref.org')) {
        return { status: 503, finalUrl: url, redirectChain: [] };
      }
      return { status: 200, finalUrl: url, redirectChain: [] };
    };

    const deps: RunDoctorDeps = {
      config,
      cwd: tempDir,
      http: makeHttp(headFn),
      signal: AbortSignal.timeout(30_000),
      fs: fsStub,
    };

    const result = await runDoctor(deps);

    const crossrefCheck = getCheck(result.checks, 'crossref-connectivity');
    expect(crossrefCheck?.status).toBe('fail');
    expect(crossrefCheck?.message).toBe('fail (HTTP 503)');
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 5: CrossRef network error → fail (network)
// ---------------------------------------------------------------------------

describe('runDoctor — CrossRef network error', () => {
  it('emits fail (network) when CrossRef has a network error', async () => {
    const bibFile = join(tempDir, 'sources.json');
    await writeFile(bibFile, JSON.stringify([]), 'utf-8');

    const config = defaultConfig({
      bibliography: { file: 'sources.json' },
      phrases: { file: null },
    });

    const cacheDir = resolve(tempDir, config.cache.dir);
    const fsStub = makeOkFs(cacheDir);

    const headFn = async (url: string): Promise<HttpHeadResponse> => {
      if (url.includes('crossref.org')) {
        throw Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' });
      }
      return { status: 200, finalUrl: url, redirectChain: [] };
    };

    const deps: RunDoctorDeps = {
      config,
      cwd: tempDir,
      http: makeHttp(headFn),
      signal: AbortSignal.timeout(30_000),
      fs: fsStub,
    };

    const result = await runDoctor(deps);

    const crossrefCheck = getCheck(result.checks, 'crossref-connectivity');
    expect(crossrefCheck?.status).toBe('fail');
    expect(crossrefCheck?.message).toBe('fail (network)');
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 6: Secret safety — mailto must not appear in any check
// ---------------------------------------------------------------------------

describe('runDoctor — secret safety', () => {
  it('does not leak mailto email in any check message or details', async () => {
    const bibFile = join(tempDir, 'sources.json');
    await writeFile(bibFile, JSON.stringify([]), 'utf-8');

    const EMAIL = 'user@example.com';

    // Config with a polite-pool email (crossref_mailto).
    const rawConfig = ConfigSchema.parse({
      bibliography: { file: 'sources.json' },
      apis: { crossref_mailto: EMAIL, openalex_mailto: EMAIL },
      phrases: { file: null },
    }) as Config;

    const cacheDir = resolve(tempDir, rawConfig.cache.dir);
    const fsStub = makeOkFs(cacheDir);

    const capturedUrls: string[] = [];
    const headFn = async (url: string): Promise<HttpHeadResponse> => {
      capturedUrls.push(url);
      return { status: 200, finalUrl: url, redirectChain: [] };
    };

    const deps: RunDoctorDeps = {
      config: rawConfig,
      cwd: tempDir,
      http: makeHttp(headFn),
      signal: AbortSignal.timeout(30_000),
      fs: fsStub,
    };

    const result = await runDoctor(deps);

    // Check every DoctorCheck for the email address.
    for (const check of result.checks) {
      expect(check.message).not.toContain(EMAIL);
      if (check.details !== undefined) {
        const detailsStr = JSON.stringify(check.details);
        expect(detailsStr).not.toContain(EMAIL);
      }
    }

    // Also verify that ?mailto= does not appear in any check output.
    for (const check of result.checks) {
      expect(check.message).not.toContain('mailto=');
      if (check.details !== undefined) {
        const detailsStr = JSON.stringify(check.details);
        expect(detailsStr).not.toContain('mailto=');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Test 7: clearCache flag
// ---------------------------------------------------------------------------

describe('runDoctor — clearCache', () => {
  it('emits cache-cleared check first and clears the directory', async () => {
    const bibFile = join(tempDir, 'sources.json');
    await writeFile(bibFile, JSON.stringify([]), 'utf-8');

    const cacheDir = join(tempDir, '.bibcheck-cache');
    await mkdir(cacheDir, { recursive: true });
    await writeFile(join(cacheDir, 'old-entry.json'), '{}', 'utf-8');

    const config = defaultConfig({
      bibliography: { file: 'sources.json' },
      cache: { dir: '.bibcheck-cache', max_size_mb: 256 },
      phrases: { file: null },
    });

    // Use real fs (cache dir is real); for bibliography access in checks, also real.
    const deps: RunDoctorDeps = {
      config,
      cwd: tempDir,
      http: makeHttp(okHeadFn()),
      signal: AbortSignal.timeout(30_000),
      clearCache: true,
      // No injected fs — uses real filesystem for clearCache test
    };

    const result = await runDoctor(deps);

    // First check should be cache-cleared.
    expect(result.checks[0]?.name).toBe('cache-cleared');
    expect(result.checks[0]?.status).toBe('ok');
    expect(result.checks[0]?.message).toBe('Cache directory cleared.');

    // The cache directory should no longer exist (or be empty).
    let cacheDirExists = false;
    try {
      const { access } = await import('node:fs/promises');
      await access(cacheDir);
      cacheDirExists = true;
    } catch {
      cacheDirExists = false;
    }
    // rm with force: true removes the directory entirely.
    expect(cacheDirExists).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 8: Phrase denylist configured but missing → warn
// ---------------------------------------------------------------------------

describe('runDoctor — phrase denylist missing', () => {
  it('emits warn when phrase denylist file is configured but missing', async () => {
    const bibFile = join(tempDir, 'sources.json');
    await writeFile(bibFile, JSON.stringify([]), 'utf-8');

    const config = defaultConfig({
      bibliography: { file: 'sources.json' },
      phrases: { file: 'nonexistent-phrases.toml' },
    });

    const cacheDir = resolve(tempDir, config.cache.dir);
    const fsStub = makeOkFs(cacheDir);

    const deps: RunDoctorDeps = {
      config,
      cwd: tempDir,
      http: makeHttp(okHeadFn()),
      signal: AbortSignal.timeout(30_000),
      fs: fsStub,
    };

    const result = await runDoctor(deps);

    const phrasesCheck = getCheck(result.checks, 'phrase-denylist');
    expect(phrasesCheck?.status).toBe('warn');
    expect(phrasesCheck?.message).toContain('not found');
  });
});

// ---------------------------------------------------------------------------
// Test 9: Phrase denylist parses successfully → ok with pattern count
// ---------------------------------------------------------------------------

describe('runDoctor — phrase denylist ok', () => {
  it('emits ok with pattern count when denylist parses successfully', async () => {
    const bibFile = join(tempDir, 'sources.json');
    await writeFile(bibFile, JSON.stringify([]), 'utf-8');

    const denylistFile = join(tempDir, 'phrases.toml');
    await writeFile(
      denylistFile,
      `
[[patterns]]
key = "test-pattern-1"
regex = "foo"
flags = ""

[[patterns]]
key = "test-pattern-2"
regex = "bar"
flags = "i"
`.trim(),
      'utf-8',
    );

    const config = defaultConfig({
      bibliography: { file: 'sources.json' },
      phrases: { file: 'phrases.toml' },
    });

    const cacheDir = resolve(tempDir, config.cache.dir);
    const fsStub = makeOkFs(cacheDir);

    const deps: RunDoctorDeps = {
      config,
      cwd: tempDir,
      http: makeHttp(okHeadFn()),
      signal: AbortSignal.timeout(30_000),
      fs: fsStub,
    };

    const result = await runDoctor(deps);

    const phrasesCheck = getCheck(result.checks, 'phrase-denylist');
    expect(phrasesCheck?.status).toBe('ok');
    expect(phrasesCheck?.details?.['patternCount']).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Test 10: AbortSignal aborted → throws
// ---------------------------------------------------------------------------

describe('runDoctor — AbortSignal aborted', () => {
  it('throws when the signal is already aborted at call time', async () => {
    const config = defaultConfig({ phrases: { file: null } });

    const controller = new AbortController();
    controller.abort(new Error('aborted by test'));

    const deps: RunDoctorDeps = {
      config,
      cwd: tempDir,
      http: makeHttp(okHeadFn()),
      signal: controller.signal,
    };

    await expect(runDoctor(deps)).rejects.toThrow();
  });

  it('throws when signal is aborted during API connectivity checks', async () => {
    const bibFile = join(tempDir, 'sources.json');
    await writeFile(bibFile, JSON.stringify([]), 'utf-8');

    const config = defaultConfig({
      bibliography: { file: 'sources.json' },
      phrases: { file: null },
    });

    const cacheDir = resolve(tempDir, config.cache.dir);
    const fsStub = makeOkFs(cacheDir);

    const controller = new AbortController();

    // Abort after the first HEAD request (CrossRef).
    let callCount = 0;
    const headFn = async (url: string): Promise<HttpHeadResponse> => {
      callCount++;
      if (callCount === 1) {
        // Abort the signal after this call.
        controller.abort(new Error('test abort'));
        return { status: 200, finalUrl: url, redirectChain: [] };
      }
      // This should not be reached due to abort check between API calls.
      return { status: 200, finalUrl: url, redirectChain: [] };
    };

    const deps: RunDoctorDeps = {
      config,
      cwd: tempDir,
      http: makeHttp(headFn),
      signal: controller.signal,
      fs: fsStub,
    };

    // runDoctor should throw because the signal is aborted between API checks.
    await expect(runDoctor(deps)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Additional edge case: cache size warns when approaching limit
// ---------------------------------------------------------------------------

describe('runDoctor — cache size near limit', () => {
  it('emits warn when cache usage exceeds 80% of max_size_mb', async () => {
    const bibFile = join(tempDir, 'sources.json');
    await writeFile(bibFile, JSON.stringify([]), 'utf-8');

    const MAX_MB = 10;
    const config = defaultConfig({
      bibliography: { file: 'sources.json' },
      cache: { dir: '.bibcheck-cache', max_size_mb: MAX_MB },
      phrases: { file: null },
    });

    const cacheDir = resolve(tempDir, config.cache.dir);

    // Simulate 9 MB used (90% of 10 MB limit).
    const nineMb = 9 * 1024 * 1024;
    const fsStub: NonNullable<RunDoctorDeps['fs']> = {
      access: async (_p: string) => { /* always ok */ },
      stat: async (p: string) => {
        if (p === cacheDir) return { size: 0, isDirectory: () => true };
        return { size: nineMb, isDirectory: () => false };
      },
      readdir: async (p: string) => {
        if (p === cacheDir) return ['big-cache-file.json'];
        return [];
      },
    };

    const deps: RunDoctorDeps = {
      config,
      cwd: tempDir,
      http: makeHttp(okHeadFn()),
      signal: AbortSignal.timeout(30_000),
      fs: fsStub,
    };

    const result = await runDoctor(deps);

    const sizeCheck = getCheck(result.checks, 'cache-size');
    expect(sizeCheck?.status).toBe('warn');
    expect(sizeCheck?.message).toContain('>80%');
  });
});

// ---------------------------------------------------------------------------
// Additional edge case: trusted-hosts empty → warn
// ---------------------------------------------------------------------------

describe('runDoctor — trusted hosts empty', () => {
  it('emits warn when trusted_hosts.hosts is empty', async () => {
    const bibFile = join(tempDir, 'sources.json');
    await writeFile(bibFile, JSON.stringify([]), 'utf-8');

    const config = defaultConfig({
      bibliography: { file: 'sources.json' },
      trusted_hosts: { hosts: [] },
      phrases: { file: null },
    });

    const cacheDir = resolve(tempDir, config.cache.dir);
    const fsStub = makeOkFs(cacheDir);

    const deps: RunDoctorDeps = {
      config,
      cwd: tempDir,
      http: makeHttp(okHeadFn()),
      signal: AbortSignal.timeout(30_000),
      fs: fsStub,
    };

    const result = await runDoctor(deps);

    const hostsCheck = getCheck(result.checks, 'trusted-hosts');
    expect(hostsCheck?.status).toBe('warn');
  });
});

// ---------------------------------------------------------------------------
// Additional edge case: invalid trusted hostname entries → warn
// ---------------------------------------------------------------------------

describe('runDoctor — invalid trusted hostnames', () => {
  it('emits warn when some trusted_hosts.hosts entries fail hostname validation', async () => {
    const bibFile = join(tempDir, 'sources.json');
    await writeFile(bibFile, JSON.stringify([]), 'utf-8');

    const config = defaultConfig({
      bibliography: { file: 'sources.json' },
      // Zod accepts any string, but doctor validates the format.
      trusted_hosts: { hosts: ['valid.example.com', 'INVALID HOST', 'another-bad one'] },
      phrases: { file: null },
    });

    const cacheDir = resolve(tempDir, config.cache.dir);
    const fsStub = makeOkFs(cacheDir);

    const deps: RunDoctorDeps = {
      config,
      cwd: tempDir,
      http: makeHttp(okHeadFn()),
      signal: AbortSignal.timeout(30_000),
      fs: fsStub,
    };

    const result = await runDoctor(deps);

    const hostsCheck = getCheck(result.checks, 'trusted-hosts');
    expect(hostsCheck?.status).toBe('warn');
    expect(hostsCheck?.message).toContain('INVALID HOST');
    expect(hostsCheck?.details?.['invalidHosts']).toEqual(['INVALID HOST', 'another-bad one']);
  });
});

// ---------------------------------------------------------------------------
// Additional edge case: phrase denylist load error (not-found vs parse error)
// ---------------------------------------------------------------------------

describe('runDoctor — phrase denylist parse error', () => {
  it('emits fail when denylist file exists but has bad TOML', async () => {
    const bibFile = join(tempDir, 'sources.json');
    await writeFile(bibFile, JSON.stringify([]), 'utf-8');

    // Write a denylist file with invalid TOML.
    const denylistFile = join(tempDir, 'bad-phrases.toml');
    await writeFile(denylistFile, '[[patterns\nthis is not valid toml', 'utf-8');

    const config = defaultConfig({
      bibliography: { file: 'sources.json' },
      phrases: { file: 'bad-phrases.toml' },
    });

    const cacheDir = resolve(tempDir, config.cache.dir);
    const fsStub = makeOkFs(cacheDir);

    const deps: RunDoctorDeps = {
      config,
      cwd: tempDir,
      http: makeHttp(okHeadFn()),
      signal: AbortSignal.timeout(30_000),
      fs: fsStub,
    };

    const result = await runDoctor(deps);

    const phrasesCheck = getCheck(result.checks, 'phrase-denylist');
    expect(phrasesCheck?.status).toBe('fail');
    expect(phrasesCheck?.message).toContain('Phrase denylist load error');
  });
});

// ---------------------------------------------------------------------------
// Additional edge case: HTTP error with numeric status (via HttpError-like object)
// ---------------------------------------------------------------------------

describe('runDoctor — HTTP error with status code', () => {
  it('reports fail (HTTP N) when head throws an error with a numeric status property', async () => {
    const bibFile = join(tempDir, 'sources.json');
    await writeFile(bibFile, JSON.stringify([]), 'utf-8');

    const config = defaultConfig({
      bibliography: { file: 'sources.json' },
      phrases: { file: null },
    });

    const cacheDir = resolve(tempDir, config.cache.dir);
    const fsStub = makeOkFs(cacheDir);

    const headFn = async (url: string): Promise<HttpHeadResponse> => {
      if (url.includes('openalex.org')) {
        // Simulate an HttpError-like object with a numeric status property.
        const err = Object.assign(new Error('HTTP 429'), { status: 429 });
        throw err;
      }
      return { status: 200, finalUrl: url, redirectChain: [] };
    };

    const deps: RunDoctorDeps = {
      config,
      cwd: tempDir,
      http: makeHttp(headFn),
      signal: AbortSignal.timeout(30_000),
      fs: fsStub,
    };

    const result = await runDoctor(deps);

    const openAlexCheck = getCheck(result.checks, 'openalex-connectivity');
    expect(openAlexCheck?.status).toBe('fail');
    expect(openAlexCheck?.message).toBe('fail (HTTP 429)');
  });
});

// ---------------------------------------------------------------------------
// Additional edge case: cache max_size_mb = null (unlimited)
// ---------------------------------------------------------------------------

describe('runDoctor — cache size unlimited', () => {
  it('reports ok with "no limit configured" when max_size_mb is null', async () => {
    const bibFile = join(tempDir, 'sources.json');
    await writeFile(bibFile, JSON.stringify([]), 'utf-8');

    const config = defaultConfig({
      bibliography: { file: 'sources.json' },
      cache: { dir: '.bibcheck-cache', max_size_mb: null },
      phrases: { file: null },
    });

    const cacheDir = resolve(tempDir, config.cache.dir);
    const fsStub = makeOkFs(cacheDir);

    const deps: RunDoctorDeps = {
      config,
      cwd: tempDir,
      http: makeHttp(okHeadFn()),
      signal: AbortSignal.timeout(30_000),
      fs: fsStub,
    };

    const result = await runDoctor(deps);

    const sizeCheck = getCheck(result.checks, 'cache-size');
    expect(sizeCheck?.status).toBe('ok');
    expect(sizeCheck?.message).toContain('no limit configured');
  });
});

// ---------------------------------------------------------------------------
// B4: doctor connectivity client carries a polite-pool mailto User-Agent
// ---------------------------------------------------------------------------

describe('runDoctor — polite-pool User-Agent on connectivity client', () => {
  it('sends a mailto User-Agent built from openalex_mailto when only it is set', async () => {
    const bibFile = join(tempDir, 'sources.json');
    await writeFile(bibFile, JSON.stringify([]), 'utf-8');

    // Capture the User-Agent the connectivity client sends.
    const seenUserAgents: string[] = [];
    const server = nodeHttp.createServer((req, res) => {
      seenUserAgents.push(req.headers['user-agent'] ?? '');
      res.writeHead(200);
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const addr = server.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    const base = `http://127.0.0.1:${port}`;

    try {
      // Only openalex_mailto set — UA must still carry it (B4 fallback).
      const config = ConfigSchema.parse({
        bibliography: { file: 'sources.json' },
        apis: {
          openalex_mailto: 'oa@example.com',
          crossref_base: base,
          openalex_base: base,
          openlibrary_base: base,
        },
        phrases: { file: null },
      }) as Config;

      const cacheDir = resolve(tempDir, config.cache.dir);
      const fsStub = makeOkFs(cacheDir);

      // Build the real client exactly as the CLI does for doctor, with the
      // loopback escape hatch so the in-process server is reachable.
      const http = createHttpClient({
        userAgent: buildUserAgent(config),
        allowPrivateHosts: true,
      });

      const result = await runDoctor({
        config,
        cwd: tempDir,
        http,
        signal: AbortSignal.timeout(30_000),
        fs: fsStub,
      });

      // Connectivity checks should have run and reached the server.
      expect(getCheck(result.checks, 'crossref-connectivity')?.status).toBe('ok');
      expect(seenUserAgents.length).toBeGreaterThan(0);
      for (const ua of seenUserAgents) {
        expect(ua).toBe('bibcheck/0.0.0 (mailto:oa@example.com)');
      }
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
