/**
 * Tests for src/cache/fs-cache.ts.
 *
 * Fs-backed tests use a fresh temp directory per test to avoid cross-test
 * contamination. The clock is injected so TTL behaviour is deterministic.
 */

import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, rm, stat } from 'node:fs/promises';

import {
  createFsCache,
  createMemoryCache,
  CacheError,
  clearCacheDir,
  type Cache,
  type FsCacheOptions,
} from '../src/cache/fs-cache.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir(): string {
  return path.join(os.tmpdir(), randomUUID());
}

type ClockState = { now(): number };

function makeClock(initialMs = 1_000_000): { clock: ClockState; advance(ms: number): void } {
  let current = initialMs;
  return {
    clock: { now: () => current },
    advance(ms: number) {
      current += ms;
    },
  };
}

// ---------------------------------------------------------------------------
// Shared behavioural suite — runs against both implementations
// ---------------------------------------------------------------------------

function behavioralSuite(
  label: string,
  factory: (overrides?: Partial<FsCacheOptions>) => { cache: Cache; advance(ms: number): void },
) {
  describe(label, () => {
    it('get after set returns the value within TTL', async () => {
      const { cache } = factory();
      await cache.set('key1', { x: 42 });
      const result = await cache.get<{ x: number }>('key1');
      expect(result).toEqual({ x: 42 });
    });

    it('get returns null for a missing key', async () => {
      const { cache } = factory();
      const result = await cache.get('absent');
      expect(result).toBeNull();
    });

    it('get returns null after TTL expires (via clock)', async () => {
      const { cache, advance } = factory({ defaultTtlMs: 1000 });
      await cache.set('expiring', 'hello');
      advance(1500);
      const result = await cache.get('expiring');
      expect(result).toBeNull();
    });

    it('uses defaultTtlMs from options when ttlMs is not passed to set', async () => {
      const { cache, advance } = factory({ defaultTtlMs: 5000 });
      await cache.set('key2', 'world');
      advance(4000); // still within TTL
      expect(await cache.get('key2')).toBe('world');
      advance(2000); // now past TTL
      expect(await cache.get('key2')).toBeNull();
    });

    it('per-call ttlMs overrides the default', async () => {
      const { cache, advance } = factory({ defaultTtlMs: 60_000 });
      await cache.set('short', 'v', { ttlMs: 500 });
      advance(600);
      expect(await cache.get('short')).toBeNull();
    });

    it('invalidate removes a single entry; other entries remain', async () => {
      const { cache } = factory();
      await cache.set('a', 1);
      await cache.set('b', 2);
      await cache.invalidate('a');
      expect(await cache.get('a')).toBeNull();
      expect(await cache.get<number>('b')).toBe(2);
    });

    it('clear removes all entries', async () => {
      const { cache } = factory();
      await cache.set('x', 10);
      await cache.set('y', 20);
      await cache.clear();
      expect(await cache.get('x')).toBeNull();
      expect(await cache.get('y')).toBeNull();
    });

    it('AbortSignal already aborted → throws before any work', async () => {
      const { cache } = factory();
      const controller = new AbortController();
      const reason = new Error('aborted');
      controller.abort(reason);
      await expect(cache.get('k', controller.signal)).rejects.toThrow('aborted');
    });
  });
}

// ---------------------------------------------------------------------------
// Fs-cache factory
// ---------------------------------------------------------------------------

const fsDirs: string[] = [];

function makeFsFactory(extraOpts?: Partial<FsCacheOptions>) {
  const { clock, advance } = makeClock();
  const dir = tmpDir();
  fsDirs.push(dir);

  const cache = createFsCache({
    dir,
    clock,
    defaultTtlMs: 60_000,
    version: '1',
    ...extraOpts,
  });

  return { cache, advance };
}

afterEach(async () => {
  for (const d of fsDirs.splice(0)) {
    await rm(d, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Memory-cache factory
// ---------------------------------------------------------------------------

function makeMemFactory(extraOpts?: Partial<FsCacheOptions>) {
  const { clock, advance } = makeClock();
  const defaultTtlMs = extraOpts?.defaultTtlMs ?? 60_000;
  const cache = createMemoryCache({ defaultTtlMs, clock });
  return { cache, advance };
}

// ---------------------------------------------------------------------------
// Run shared suite against both implementations
// ---------------------------------------------------------------------------

behavioralSuite('FsCache — behavioural', makeFsFactory);
behavioralSuite('MemoryCache — behavioural', makeMemFactory);

// ---------------------------------------------------------------------------
// FsCache-specific tests
// ---------------------------------------------------------------------------

describe('FsCache — specific', () => {
  it('cache directory is created on first set, not at construction', async () => {
    const { clock, advance: _advance } = makeClock();
    const dir = tmpDir();
    fsDirs.push(dir);

    // Construction must not throw even though dir doesn't exist yet.
    const cache = createFsCache({ dir, clock });

    // Dir should not exist yet.
    await expect(stat(dir)).rejects.toThrow();

    await cache.set('k', 'v');

    // Dir should exist now.
    const s = await stat(dir);
    expect(s.isDirectory()).toBe(true);
  });

  it('version mismatch → returns null', async () => {
    const { clock } = makeClock();
    const dir = tmpDir();
    fsDirs.push(dir);

    // Write with version '1'.
    const cacheV1 = createFsCache({ dir, clock, version: '1' });
    await cacheV1.set('shared', { data: 'original' });

    // A new cache instance with version '2' reading the same file → null.
    // (Each KeyvFile instance has its own in-memory map loaded from disk;
    //  version filtering happens in our envelope logic, not in keyv.)
    const cacheV2 = createFsCache({ dir, clock, version: '2' });
    const result = await cacheV2.get('shared');
    expect(result).toBeNull();
  });

  it('version mismatch → auto-deletes: subsequent same-version get also returns null', async () => {
    const { clock } = makeClock();
    const dir = tmpDir();
    fsDirs.push(dir);

    // Write with version '1'.
    const cache = createFsCache({ dir, clock, version: '1' });
    await cache.set('shared', { data: 'original' });

    // Open a v2 cache and trigger a mismatch-delete.
    const cacheV2 = createFsCache({ dir, clock, version: '2' });
    await cacheV2.get('shared'); // triggers delete; writes to disk

    // A brand-new v1 instance loading from the now-mutated disk file.
    const cacheV1Fresh = createFsCache({ dir, clock, version: '1' });
    const resultFresh = await cacheV1Fresh.get('shared');
    expect(resultFresh).toBeNull();
  });

  it('corrupt JSON in storage → returns null and does not throw', async () => {
    const { clock } = makeClock();
    const dir = tmpDir();
    fsDirs.push(dir);

    await mkdir(dir, { recursive: true });

    // Write a valid entry first so the file exists.
    const cache = createFsCache({ dir, clock });
    await cache.set('legit', 'value');

    // Overwrite the cache file with corrupt JSON so the backing store can't
    // parse it. keyv-file falls back to an empty map on parse error, so the
    // value will simply be missing — returning null is the correct behaviour.
    const cacheFile = path.join(dir, 'cache.json');
    await writeFile(cacheFile, '{corrupt json!!!');

    // Re-create the cache (re-reads the file) and attempt a get.
    const cache2 = createFsCache({ dir, clock });
    const result = await cache2.get('legit');
    expect(result).toBeNull();
  });

  it('maxSizeMb = null → unlimited; many writes do not trip eviction', async () => {
    const { clock } = makeClock();
    const dir = tmpDir();
    fsDirs.push(dir);

    const cache = createFsCache({ dir, clock, maxSizeMb: null });
    for (let i = 0; i < 50; i++) {
      await cache.set(`key-${i}`, 'x'.repeat(100));
    }
    // All entries should still be readable.
    for (let i = 0; i < 50; i++) {
      expect(await cache.get(`key-${i}`)).toBe('x'.repeat(100));
    }
  });

  it('maxSizeMb hit → eviction reduces the number of readable entries', async () => {
    const { clock } = makeClock();
    const dir = tmpDir();
    fsDirs.push(dir);

    // Use a very small cap (0.001 MB = ~1 KB) so we trip it easily.
    const cache = createFsCache({ dir, clock, maxSizeMb: 0.001 });

    // Write enough data to exceed the cap.
    const payload = 'x'.repeat(500);
    for (let i = 0; i < 10; i++) {
      await cache.set(`big-${i}`, payload);
    }

    // After eviction, at least some entries should be gone.
    let misses = 0;
    for (let i = 0; i < 10; i++) {
      if ((await cache.get(`big-${i}`)) === null) misses++;
    }
    expect(misses).toBeGreaterThan(0);
  });

  it('AbortSignal already aborted → throws signal.reason on get', async () => {
    const { clock } = makeClock();
    const dir = tmpDir();
    fsDirs.push(dir);

    const cache = createFsCache({ dir, clock });
    const controller = new AbortController();
    const myError = new Error('cancelled');
    controller.abort(myError);

    await expect(cache.get('any-key', controller.signal)).rejects.toThrow('cancelled');
  });

  it('hash distribution: 1000 distinct keys produce distinct hashes', async () => {
    const { clock } = makeClock();
    const dir = tmpDir();
    fsDirs.push(dir);

    // We just check that the SHA-256 hash function we rely on gives distinct
    // outputs for distinct inputs; collision in 1000 keys would be a catastrophe.
    const { createHash } = await import('node:crypto');
    const hashes = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const h = createHash('sha256').update(`key-${i}`).digest('hex');
      hashes.add(h);
    }
    expect(hashes.size).toBe(1000);
  });

  it('clearCacheDir removes file contents without error', async () => {
    const dir = tmpDir();
    fsDirs.push(dir);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'test.json'), '{}');

    await clearCacheDir(dir);

    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(dir);
    expect(entries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// MemoryCache-specific tests
// ---------------------------------------------------------------------------

describe('MemoryCache — specific', () => {
  it('TTL expiry is clock-driven (wall-clock-independent)', async () => {
    const { clock, advance } = makeClock(0);
    const cache = createMemoryCache({ defaultTtlMs: 1000, clock });
    await cache.set('timed', 'hi');
    advance(999);
    expect(await cache.get('timed')).toBe('hi');
    advance(2); // now at 1001ms — past TTL
    expect(await cache.get('timed')).toBeNull();
  });

  it('stores and retrieves complex objects', async () => {
    const cache = createMemoryCache();
    const obj = { a: [1, 2, 3], b: { nested: true } };
    await cache.set('complex', obj);
    expect(await cache.get('complex')).toEqual(obj);
  });

  it('CacheError is an Error subclass with name CacheError', () => {
    const err = new CacheError('test error');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('CacheError');
    expect(err.message).toBe('test error');
  });
});
