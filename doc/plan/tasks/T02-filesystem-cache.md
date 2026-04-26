# T02 — Filesystem cache

**Phase:** 1 (Foundation)
**Complexity:** small
**Depends on:** none
**Blocks:** T05 (database clients use the cache), T06 (HTTP utility uses the cache for HEAD results)

## Scope

A filesystem-backed TTL cache for API responses, built on `keyv` + `keyv-file`. Reused by every module that hits an external API.

## Files

- `src/cache/fs-cache.ts` — `Cache` interface, `createFsCache` factory (wraps a `Keyv` instance backed by `keyv-file`), in-memory mock for tests.
- `test/cache.test.ts` — unit tests.

## Interfaces

### Imports

- `keyv` (new dependency — confirm before adding)
- `keyv-file` (new dependency — confirm before adding)
- `node:fs/promises`
- `node:path`
- `node:crypto` (for SHA-256 keying)

### Exports

```ts
export interface Cache {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlMs?: number): Promise<void>;
  invalidate(key: string): Promise<void>;
  clear(): Promise<void>;
}

export interface FsCacheOptions {
  dir: string;                 // e.g., './.bibcheck-cache' or XDG_CACHE_HOME/bibcheck
  defaultTtlMs?: number;       // default: 30 days
  clock?: () => number;        // for tests; default Date.now
}

export function createFsCache(opts: FsCacheOptions): Cache;
// createFsCache wraps a Keyv instance backed by keyv-file. It is a thin
// facade that adds envelope wrapping (version field, eviction) on top of
// Keyv's native TTL support.

// for tests
export function createInMemoryCache(opts?: { clock?: () => number }): Cache;
```

The exported `Cache` interface is used by T05 and T06; they accept a `Cache` parameter, never construct one directly.

## Implementation notes

- **Keying**: SHA-256 of the input key string, hex-encoded. File path: `<dir>/<hash[0:2]>/<hash[2:]>.json`.
- **Cache envelope**: `{ version: string, value: unknown, expiresAt: number }`. On read, if `version` doesn't match the current cache schema version, treat as a miss and delete the file. `Keyv` provides TTL natively but the wrapper still owns the `version` field.
- **Expiry**: `get` returns `null` when `Date.now() - storedAt > ttlMs`. Expired entries are not auto-deleted on read; they're overwritten on next `set`. A `clear()` removes the directory contents.
- **Atomic write** — writes go to `<file>.tmp` then `rename()`. Verify `keyv-file` does this; if not, wrap with the `tmp → rename` dance manually.
- **LRU size eviction** — when total cache size exceeds `config.cache.max_size_mb`, evict oldest entries by mtime until under budget. Eviction runs on `set`, not on a timer.
- **Concurrent runs** — atomic-rename gives crash safety. Two parallel `bibcheck check` runs in the same project may have one's writes overwrite the other's; this is last-write-wins. Document as a known limitation.
- **Cache directory creation**: `set` creates the directory tree on demand (`fs.mkdir({ recursive: true })`). Don't create on `get`.
- **Clock injection**: TTL tests must be deterministic; pass `clock` in tests.

## Acceptance criteria

- [ ] `Cache` interface exported.
- [ ] `createFsCache({ dir })` returns a cache that round-trips set/get values.
- [ ] Expired entries return `null` from `get`.
- [ ] `invalidate(key)` removes a specific entry.
- [ ] `clear()` removes all cached entries.
- [ ] `createInMemoryCache()` exists and implements the same interface for tests.
- [ ] Cache directory is created on first `set`, not at construction.
- [ ] No I/O at module top-level.
- [ ] Cache envelope includes a `version` string; mismatched version on read returns null and deletes the file.
- [ ] Atomic write: a Ctrl-C mid-write leaves no half-written cache file (use a `kill -9` test against a child process).
- [ ] LRU size eviction works when `max_size_mb` is configured.

## Tests

`test/cache.test.ts`:

- Round-trip: `set('k', { v: 1 })` then `get('k')` returns `{ v: 1 }`.
- Missing key: `get('absent')` returns `null`.
- TTL expiry: `set` with `ttlMs=1000`, advance clock by 1500ms, `get` returns `null`.
- TTL default: when `ttlMs` omitted, uses `defaultTtlMs` from options.
- `invalidate(key)`: removes one entry; other entries remain.
- `clear()`: removes all entries; cache directory still exists or is recreated cleanly.
- Hash distribution: two distinct keys never collide (sample 1000).
- `createInMemoryCache` passes the same test suite (use a parameterised describe).
- Filesystem-backed tests use a temp directory under `os.tmpdir()`; cleanup in `afterEach`.

Coverage target: ≥ 80% line + branch for `src/cache/fs-cache.ts`.

## New dependencies

- `keyv` — generic key-value store with pluggable backends.
- `keyv-file` — filesystem backend for `keyv`.

Confirm both before adding to `package.json` `dependencies`.
