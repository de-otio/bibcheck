/**
 * bibcheck doctor — diagnostic runner.
 *
 * Runs a series of environment and configuration checks and returns a
 * structured result. Each check emits a DoctorCheck entry with a name,
 * status, and human-readable message. The CLI (T15) is responsible for
 * rendering the output; this module does no I/O beyond what is needed
 * to perform the checks.
 *
 * SECURITY: API keys, polite-pool email addresses, and full request URLs
 * (which might contain ?mailto= query params) MUST NOT appear in any
 * DoctorCheck.message or .details value.
 */

import type { Config } from './config.js';
import { API_BASE_DEFAULTS } from './config.js';
import type { HttpClient } from './http.js';
import { resolve, join } from 'node:path';
import { rm } from 'node:fs/promises';
import { loadBibliography, BibliographyParseError } from './schema/csl.js';
import { loadDenylist, PhraseLoaderError } from './phrases/load.js';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface DoctorCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  message: string;
  details?: Record<string, unknown>;
}

export interface RunDoctorDeps {
  config: Config;
  cwd: string;
  http: HttpClient;
  signal: AbortSignal;
  /** Injectable for tests */
  fs?: {
    stat: (path: string) => Promise<{ size: number; isDirectory: () => boolean }>;
    access: (path: string) => Promise<void>;
    readdir: (path: string) => Promise<string[]>;
  };
  /** Optional: clear cache directory (called by --clear-cache flag) */
  clearCache?: boolean;
}

export interface RunDoctorResult {
  checks: DoctorCheck[];
  ok: boolean; // true if no 'fail' checks
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Minimum supported Node major version. */
const MIN_NODE_MAJOR = 20;

/** Remove a single trailing slash so connectivity URLs join cleanly. */
function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/** Regex for basic hostname validation. */
const HOSTNAME_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/;

type FsInterface = NonNullable<RunDoctorDeps['fs']>;

/** Resolve the injectable fs interface, falling back to node:fs/promises. */
async function resolveFs(fsDep: RunDoctorDeps['fs']): Promise<FsInterface> {
  if (fsDep !== undefined) return fsDep;
  const nodeFs = await import('node:fs/promises');
  return {
    stat: nodeFs.stat.bind(nodeFs),
    access: nodeFs.access.bind(nodeFs),
    readdir: (p: string) => nodeFs.readdir(p),
  };
}

/**
 * Walk a directory recursively and sum total file sizes.
 * Returns 0 if the directory does not exist or is not accessible.
 */
async function sumDirBytes(
  dirPath: string,
  fsModule: FsInterface,
): Promise<number> {
  try {
    await fsModule.access(dirPath);
  } catch {
    return 0;
  }

  let total = 0;
  const stack: string[] = [dirPath];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: string[];
    try {
      entries = await fsModule.readdir(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = join(current, entry);
      try {
        const s = await fsModule.stat(entryPath);
        if (s.isDirectory()) {
          stack.push(entryPath);
        } else {
          total += s.size;
        }
      } catch {
        // ignore unreadable entries
      }
    }
  }
  return total;
}

/** Perform a connectivity check against an API endpoint. */
async function checkApiConnectivity(
  name: string,
  url: string,
  http: HttpClient,
  signal: AbortSignal,
): Promise<DoctorCheck> {
  if (signal.aborted) {
    throw signal.reason as Error;
  }
  try {
    const response = await http.head(url, { signal, timeoutMs: 5000, followRedirects: false });
    const status = response.status;
    // Any response (including 4xx) means the server is reachable.
    // 5xx means the server responded but errored — we still count it as reachable
    // for the purposes of this connectivity check, but report the code.
    if (status >= 500) {
      return {
        name,
        status: 'fail',
        message: `fail (HTTP ${status})`,
      };
    }
    return {
      name,
      status: 'ok',
      message: `ok (HTTP ${status})`,
    };
  } catch (err) {
    if (signal.aborted) {
      throw signal.reason as Error;
    }
    // Check if error carries an HTTP status
    if (err instanceof Error) {
      // HttpError carries a status property
      const httpErr = err as Error & { status?: number };
      if (typeof httpErr.status === 'number') {
        return {
          name,
          status: 'fail',
          message: `fail (HTTP ${httpErr.status})`,
        };
      }
    }
    return {
      name,
      status: 'fail',
      message: 'fail (network)',
    };
  }
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

export async function runDoctor(deps: RunDoctorDeps): Promise<RunDoctorResult> {
  const { config, cwd, http, signal } = deps;
  const checks: DoctorCheck[] = [];

  // Throw immediately if aborted at entry.
  if (signal.aborted) {
    throw signal.reason as Error;
  }

  // -------------------------------------------------------------------------
  // Optional: clear cache before running checks
  // -------------------------------------------------------------------------

  if (deps.clearCache === true) {
    const cacheDir = resolve(cwd, config.cache.dir);
    try {
      await rm(cacheDir, { recursive: true, force: true });
      checks.push({
        name: 'cache-cleared',
        status: 'ok',
        message: 'Cache directory cleared.',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      checks.push({
        name: 'cache-cleared',
        status: 'fail',
        message: `Failed to clear cache directory: ${msg}`,
      });
    }
  }

  // Resolve the injectable fs module or fall back to node:fs/promises.
  const fsModule = await resolveFs(deps.fs);

  // -------------------------------------------------------------------------
  // Check 1: Node version
  // -------------------------------------------------------------------------

  {
    const version = process.version; // e.g. "v20.0.0"
    const match = /^v(\d+)/.exec(version);
    const major = match !== null && match[1] !== undefined ? parseInt(match[1], 10) : 0;
    if (major >= MIN_NODE_MAJOR) {
      checks.push({
        name: 'node-version',
        status: 'ok',
        message: `Node ${version} satisfies >=v${MIN_NODE_MAJOR}.`,
      });
    } else {
      checks.push({
        name: 'node-version',
        status: 'fail',
        message: `Node ${version} is below the required v${MIN_NODE_MAJOR}.0.0.`,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Check 2: Config validity (always ok — config was already validated by caller)
  // -------------------------------------------------------------------------

  {
    checks.push({
      name: 'config-valid',
      status: 'ok',
      message: 'Configuration is valid.',
    });
  }

  // -------------------------------------------------------------------------
  // Check 3: Bibliography file exists
  // -------------------------------------------------------------------------

  {
    const bibPath = resolve(cwd, config.bibliography.file);
    try {
      await fsModule.access(bibPath);
      checks.push({
        name: 'bibliography-exists',
        status: 'ok',
        message: `Bibliography file found: ${config.bibliography.file}`,
      });
    } catch {
      checks.push({
        name: 'bibliography-exists',
        status: 'fail',
        message: `Bibliography file not found: ${config.bibliography.file}`,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Check 4: Bibliography parses as valid CSL-JSON
  // -------------------------------------------------------------------------

  {
    try {
      const entries = await loadBibliography({ path: config.bibliography.file, cwd });
      checks.push({
        name: 'bibliography-parses',
        status: 'ok',
        message: `Bibliography parsed successfully (${entries.length} entries).`,
        details: { entryCount: entries.length },
      });
    } catch (err) {
      const msg = err instanceof BibliographyParseError ? err.message : String(err);
      checks.push({
        name: 'bibliography-parses',
        status: 'fail',
        message: `Bibliography parse error: ${msg}`,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Check 5: Phrase denylist (if configured)
  // -------------------------------------------------------------------------

  if (config.phrases.file !== null) {
    try {
      const patterns = await loadDenylist({ path: config.phrases.file, cwd });
      checks.push({
        name: 'phrase-denylist',
        status: 'ok',
        message: `Phrase denylist loaded (${patterns.length} patterns).`,
        details: { patternCount: patterns.length },
      });
    } catch (err) {
      if (err instanceof PhraseLoaderError) {
        // Distinguish missing-file (warn) from parse/compile errors (fail).
        const msg = err.message;
        if (msg.includes('not found')) {
          checks.push({
            name: 'phrase-denylist',
            status: 'warn',
            message: `Phrase denylist file configured but not found: ${config.phrases.file}`,
          });
        } else {
          checks.push({
            name: 'phrase-denylist',
            status: 'fail',
            message: `Phrase denylist load error: ${msg}`,
          });
        }
      } else {
        checks.push({
          name: 'phrase-denylist',
          status: 'fail',
          message: `Phrase denylist load error: ${String(err)}`,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Check 6: Cache directory writability
  // -------------------------------------------------------------------------

  {
    const cacheDir = resolve(cwd, config.cache.dir);
    try {
      await fsModule.access(cacheDir);
      // Directory exists — check if we can read it (proxy for write access in injectable fs)
      checks.push({
        name: 'cache-writable',
        status: 'ok',
        message: `Cache directory is accessible: ${config.cache.dir}`,
        details: { cacheDir },
      });
    } catch {
      // Directory does not exist yet — that is fine; bibcheck creates it on first write.
      checks.push({
        name: 'cache-writable',
        status: 'warn',
        message: `Cache directory does not exist yet (will be created on first use): ${config.cache.dir}`,
        details: { cacheDir },
      });
    }
  }

  // -------------------------------------------------------------------------
  // Check 7: Cache size
  // -------------------------------------------------------------------------

  {
    const cacheDir = resolve(cwd, config.cache.dir);
    const totalBytes = await sumDirBytes(cacheDir, fsModule);
    const totalMb = totalBytes / (1024 * 1024);
    const maxMb = config.cache.max_size_mb;

    let cacheStatus: 'ok' | 'warn' = 'ok';
    let cacheMsg: string;

    if (maxMb !== null && totalMb > maxMb * 0.8) {
      cacheStatus = 'warn';
      cacheMsg = `Cache is using ${totalMb.toFixed(1)} MB of ${maxMb} MB limit (>80%).`;
    } else if (maxMb !== null) {
      cacheMsg = `Cache is using ${totalMb.toFixed(1)} MB of ${maxMb} MB limit.`;
    } else {
      cacheMsg = `Cache is using ${totalMb.toFixed(1)} MB (no limit configured).`;
    }

    checks.push({
      name: 'cache-size',
      status: cacheStatus,
      message: cacheMsg,
      details: { totalBytes, totalMb: parseFloat(totalMb.toFixed(3)) },
    });
  }

  // -------------------------------------------------------------------------
  // Check 8: CrossRef API connectivity
  // -------------------------------------------------------------------------

  if (signal.aborted) throw signal.reason as Error;

  checks.push(
    await checkApiConnectivity(
      'crossref-connectivity',
      `${trimTrailingSlash(config.apis.crossref_base ?? API_BASE_DEFAULTS.crossref)}/works/10.1000/xyz123`,
      http,
      signal,
    ),
  );

  // -------------------------------------------------------------------------
  // Check 9: OpenAlex API connectivity
  // -------------------------------------------------------------------------

  if (signal.aborted) throw signal.reason as Error;

  checks.push(
    await checkApiConnectivity(
      'openalex-connectivity',
      `${trimTrailingSlash(config.apis.openalex_base ?? API_BASE_DEFAULTS.openalex)}/`,
      http,
      signal,
    ),
  );

  // -------------------------------------------------------------------------
  // Check 10: OpenLibrary API connectivity
  // -------------------------------------------------------------------------

  if (signal.aborted) throw signal.reason as Error;

  checks.push(
    await checkApiConnectivity(
      'openlibrary-connectivity',
      `${trimTrailingSlash(config.apis.openlibrary_base ?? API_BASE_DEFAULTS.openlibrary)}/api/books`,
      http,
      signal,
    ),
  );

  // -------------------------------------------------------------------------
  // Check 11: Trusted host whitelist sanity
  // -------------------------------------------------------------------------

  {
    const hosts = config.trusted_hosts.hosts;
    if (hosts.length === 0) {
      checks.push({
        name: 'trusted-hosts',
        status: 'warn',
        message: 'trusted_hosts.hosts is empty — all canonical URL checks will be skipped.',
      });
    } else {
      const invalid = hosts.filter((h) => !HOSTNAME_RE.test(h));
      if (invalid.length > 0) {
        checks.push({
          name: 'trusted-hosts',
          status: 'warn',
          message: `Some trusted hosts do not look like valid hostnames: ${invalid.join(', ')}`,
          details: { invalidHosts: invalid },
        });
      } else {
        checks.push({
          name: 'trusted-hosts',
          status: 'ok',
          message: `Trusted host whitelist is valid (${hosts.length} hosts).`,
          details: { hostCount: hosts.length },
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Aggregate result
  // -------------------------------------------------------------------------

  const ok = checks.every((c) => c.status !== 'fail');
  return { checks, ok };
}
