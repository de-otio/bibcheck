/**
 * Filesystem-backed TTL cache for external API responses.
 *
 * Uses keyv + keyv-file for persistence. Every stored value is wrapped in an
 * envelope that carries a schema version and an explicit expiresAt timestamp so
 * that version mismatches and TTL expiry are enforced independently of keyv's
 * own TTL mechanism. This lets us invalidate the entire cache by bumping the
 * version constant without touching the backing file.
 *
 * Known limitation: two concurrent bibcheck runs writing to the same cache
 * directory race on the underlying JSON file. keyv-file uses a write-delay
 * debounce rather than an atomic rename, so the last writer wins. This is
 * acceptable for v0.1; a future task may add file locking.
 */

import { createHash } from 'node:crypto';
import { stat, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { Keyv } from 'keyv';
import { KeyvFile } from 'keyv-file';

// ---------------------------------------------------------------------------
// Minimal logger interface — defined inline so we don't import from a module
// that does not yet exist.
// ---------------------------------------------------------------------------

export interface Logger {
  warn(event: string, ctx?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// Public Cache interface
// ---------------------------------------------------------------------------

export interface Cache {
  get<T>(key: string, signal?: AbortSignal): Promise<T | null>;
  set<T>(key: string, value: T, opts?: { ttlMs?: number }): Promise<void>;
  invalidate(key: string): Promise<void>;
  clear(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface FsCacheOptions {
  /** Base directory for the cache file. Created on first write. */
  dir: string;
  /** Default TTL in milliseconds. Defaults to 30 days. */
  defaultTtlMs?: number;
  /** Maximum total size of the cache file in megabytes. null = unlimited. */
  maxSizeMb?: number | null;
  /** Injectable clock for deterministic tests. */
  clock?: { now(): number };
  /** Cache schema version. Bumping this invalidates all existing entries. */
  version?: string;
  /** Optional logger for operational warnings. */
  logger?: Logger;
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class CacheError extends Error {
  override name = 'CacheError' as const;
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const DEFAULT_VERSION = '1';

type Envelope = {
  version: string;
  value: unknown;
  expiresAt: number;
};

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

function checkAbort(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason as Error;
  }
}

// ---------------------------------------------------------------------------
// createFsCache
// ---------------------------------------------------------------------------

export function createFsCache(opts: FsCacheOptions): Cache {
  const {
    dir,
    defaultTtlMs = DEFAULT_TTL_MS,
    maxSizeMb = null,
    clock = { now: () => Date.now() },
    version = DEFAULT_VERSION,
    logger,
  } = opts;

  const filename = path.join(dir, 'cache.json');

  const store = new KeyvFile({ filename, writeDelay: 0 });
  const keyv = new Keyv({ store, useKeyPrefix: false });

  async function get<T>(key: string, signal?: AbortSignal): Promise<T | null> {
    checkAbort(signal);

    const hash = hashKey(key);
    let raw: unknown;
    try {
      raw = await keyv.get<unknown>(hash);
    } catch (err) {
      logger?.warn('cache.get.error', { key, error: String(err) });
      return null;
    }

    if (raw === undefined || raw === null) {
      return null;
    }

    // Validate envelope shape — if keyv-file holds corrupt/non-envelope data,
    // treat it as a miss and clean up.
    if (!isEnvelope(raw)) {
      logger?.warn('cache.corrupt', { key });
      await keyv.delete(hash).catch(() => undefined);
      return null;
    }

    const envelope = raw;

    if (envelope.version !== version) {
      logger?.warn('cache.version_mismatch', {
        key,
        stored: envelope.version,
        expected: version,
      });
      await keyv.delete(hash).catch(() => undefined);
      return null;
    }

    if (clock.now() > envelope.expiresAt) {
      await keyv.delete(hash).catch(() => undefined);
      return null;
    }

    return envelope.value as T;
  }

  async function set<T>(key: string, value: T, setOpts?: { ttlMs?: number }): Promise<void> {
    checkAbort(undefined);

    const ttlMs = setOpts?.ttlMs ?? defaultTtlMs;
    const hash = hashKey(key);
    const expiresAt = clock.now() + ttlMs;

    const envelope: Envelope = { version, value, expiresAt };

    try {
      // Pass ttlMs to keyv so it can handle native expiry via keyv-file; our
      // envelope's expiresAt is the authoritative TTL guard on read.
      await keyv.set(hash, envelope, ttlMs);
    } catch (err) {
      throw new CacheError(`Failed to write cache entry for key "${key}"`, { cause: err });
    }

    // LRU-style size eviction: simple "if over cap, clear half" sweep.
    // A proper LRU would track access order; for v0.1 we just evict the
    // oldest half by expiresAt when the file exceeds maxSizeMb.
    if (maxSizeMb !== null && maxSizeMb > 0) {
      await maybeSweep(filename, maxSizeMb, keyv, clock);
    }
  }

  async function invalidate(key: string): Promise<void> {
    checkAbort(undefined);
    const hash = hashKey(key);
    try {
      await keyv.delete(hash);
    } catch (err) {
      throw new CacheError(`Failed to invalidate cache entry for key "${key}"`, { cause: err });
    }
  }

  async function clear(): Promise<void> {
    try {
      await keyv.clear();
    } catch (err) {
      throw new CacheError('Failed to clear cache', { cause: err });
    }
  }

  return { get, set, invalidate, clear };
}

// ---------------------------------------------------------------------------
// Size eviction helper
// ---------------------------------------------------------------------------

async function maybeSweep(
  filename: string,
  maxSizeMb: number,
  keyv: Keyv,
  clock: { now(): number },
): Promise<void> {
  let fileStat: Awaited<ReturnType<typeof stat>>;
  try {
    fileStat = await stat(filename);
  } catch {
    // File not yet written; nothing to sweep.
    return;
  }

  const sizeMb = fileStat.size / (1024 * 1024);
  if (sizeMb <= maxSizeMb) {
    return;
  }

  // Collect all entries and sort oldest-first by expiresAt; evict the bottom
  // half.  Simple strategy: O(n) scan, O(n log n) sort, O(n/2) deletes.
  //
  // We read the backing JSON file directly because keyv-file's iterator
  // filters by namespace, which conflicts with useKeyPrefix:false (our keys
  // are raw SHA-256 hashes and never contain the 'keyv' namespace token).
  const entries: Array<{ key: string; expiresAt: number }> = [];
  try {
    const raw = await readFile(filename, 'utf8');
    // keyv-file serialises the store as { cache: [[key, wrappedValue], ...], lastExpire: number }.
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      Array.isArray((parsed as Record<string, unknown>)['cache'])
    ) {
      for (const item of (parsed as { cache: unknown[] })['cache']) {
        if (!Array.isArray(item) || item.length < 2) continue;
        const [key, wrapped] = item as [unknown, unknown];
        if (typeof key !== 'string') continue;
        // keyv-file wraps values as { value: serialised-string, expire?: number }
        // The inner 'value' is a JSON string produced by @keyv/serialize.
        let innerValue: unknown = null;
        if (
          typeof wrapped === 'object' &&
          wrapped !== null &&
          'value' in (wrapped as Record<string, unknown>)
        ) {
          const wv = (wrapped as Record<string, unknown>)['value'];
          if (typeof wv === 'string') {
            try {
              const decoded = JSON.parse(wv) as Record<string, unknown>;
              // @keyv/serialize wraps as { value: actualData, expires?: number }
              innerValue = decoded['value'] ?? decoded;
            } catch {
              innerValue = wv;
            }
          } else {
            innerValue = wv;
          }
        }
        if (isEnvelope(innerValue)) {
          entries.push({ key, expiresAt: innerValue.expiresAt });
        } else {
          entries.push({ key, expiresAt: clock.now() - 1 });
        }
      }
    }
  } catch {
    // Parse or read failure; skip sweep.
    return;
  }

  if (entries.length === 0) return;

  entries.sort((a, b) => a.expiresAt - b.expiresAt);
  const evictCount = Math.max(1, Math.floor(entries.length / 2));
  const toEvict = entries.slice(0, evictCount);

  for (const { key } of toEvict) {
    await keyv.delete(key).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Type guard for stored envelopes
// ---------------------------------------------------------------------------

function isEnvelope(val: unknown): val is Envelope {
  if (typeof val !== 'object' || val === null) return false;
  const v = val as Record<string, unknown>;
  return (
    typeof v['version'] === 'string' &&
    typeof v['expiresAt'] === 'number' &&
    'value' in v
  );
}

// ---------------------------------------------------------------------------
// createMemoryCache
// ---------------------------------------------------------------------------

export function createMemoryCache(opts?: {
  defaultTtlMs?: number;
  clock?: { now(): number };
}): Cache {
  const defaultTtlMs = opts?.defaultTtlMs ?? DEFAULT_TTL_MS;
  const clock = opts?.clock ?? { now: () => Date.now() };

  const store = new Map<string, { value: unknown; expiresAt: number }>();

  async function get<T>(key: string, signal?: AbortSignal): Promise<T | null> {
    checkAbort(signal);
    const entry = store.get(key);
    if (entry === undefined) return null;
    if (clock.now() > entry.expiresAt) {
      store.delete(key);
      return null;
    }
    return entry.value as T;
  }

  async function set<T>(key: string, value: T, setOpts?: { ttlMs?: number }): Promise<void> {
    checkAbort(undefined);
    const ttlMs = setOpts?.ttlMs ?? defaultTtlMs;
    store.set(key, { value, expiresAt: clock.now() + ttlMs });
  }

  async function invalidate(key: string): Promise<void> {
    checkAbort(undefined);
    store.delete(key);
  }

  async function clear(): Promise<void> {
    store.clear();
  }

  return { get, set, invalidate, clear };
}

// ---------------------------------------------------------------------------
// Re-export dir cleanup helper for tests
// ---------------------------------------------------------------------------

/** Remove all files inside a cache directory (not the directory itself). */
export async function clearCacheDir(dir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  await Promise.all(
    entries.map((entry) => rm(path.join(dir, entry), { recursive: true, force: true })),
  );
}
