/**
 * Canonical-edition URL verification subcommand.
 *
 * For each bibliography entry that lacks a DOI or ISBN (pre-DOI primary
 * sources), verifies that the entry's `url` field points to a trusted
 * canonical-edition host and that the URL is live.
 *
 * Injects `headCheck` for testability; defaults to the real implementation.
 */

import { headCheck as defaultHeadCheck } from './http.js';
import type { HeadCheckResult } from './http.js';
import type { HttpClient } from './http.js';
import type { Cache } from './cache/fs-cache.js';
import type { CslEntry } from './schema/csl.js';
import type { Entry, CanonicalLayer } from './schema/output.js';
import type { Config } from './config.js';

// ---------------------------------------------------------------------------
// Edition-discipline host mapping (v0.1 compile-time inline)
// ---------------------------------------------------------------------------

const CANONICAL_EDITION_HOSTS: Record<string, string[]> = {
  'akademie-ausgabe': ['korpora.zim.uni-duisburg-essen.de', 'archive.org'],
  'glasgow':          ['oll.libertyfund.org'],
  'clarendon':        ['oll.libertyfund.org', 'global.oup.com'],
  'toronto-cw':       ['oll.libertyfund.org'],
};

type EditionKey = keyof typeof CANONICAL_EDITION_HOSTS;

/**
 * Detect a canonical-edition signal in a note string. Returns the edition key
 * or null if no known signal is found.
 */
function detectEdition(note: string): EditionKey | null {
  if (/Ak\.\s*[IVXLCDM]+/i.test(note) || /Akademie-Ausgabe/i.test(note)) {
    return 'akademie-ausgabe';
  }
  if (/Glasgow\s+(WN|TMS|LJ)/i.test(note) || /Glasgow Edition/i.test(note)) {
    return 'glasgow';
  }
  if (/Clarendon Edition/i.test(note)) {
    return 'clarendon';
  }
  if (/Toronto\s+CW/i.test(note) || /Collected\s+Works\s+of\s+John\s+Stuart\s+Mill/i.test(note)) {
    return 'toronto-cw';
  }
  return null;
}

/**
 * Return true if `host` is among the allowed hosts for the given edition
 * (suffix matching: `archive.org` matches `web.archive.org`).
 */
function isEditionHostAllowed(host: string, allowedHosts: string[]): boolean {
  const h = host.toLowerCase();
  for (const allowed of allowedHosts) {
    const lw = allowed.toLowerCase();
    if (h === lw || h.endsWith('.' + lw)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface RunCanonicalDeps {
  config: Config;
  bibliography: CslEntry[];
  http: HttpClient;
  cache?: Cache;
  signal: AbortSignal;
  /** Injectable for tests; defaults to the real headCheck from ./http.js */
  headCheck?: typeof defaultHeadCheck;
}

export interface RunCanonicalResult {
  entries: Array<Pick<Entry, 'citekey' | 'canonical'>>;
}

// ---------------------------------------------------------------------------
// runCanonical
// ---------------------------------------------------------------------------

export async function runCanonical(deps: RunCanonicalDeps): Promise<RunCanonicalResult> {
  const { config, bibliography, http, cache, signal } = deps;
  const doHeadCheck = deps.headCheck ?? defaultHeadCheck;

  if (signal.aborted) {
    throw signal.reason as Error;
  }

  const results: Array<Pick<Entry, 'citekey' | 'canonical'>> = [];

  for (const entry of bibliography) {
    if (signal.aborted) {
      throw signal.reason as Error;
    }

    const canonical = await processEntry(entry, config, http, cache, signal, doHeadCheck);
    results.push({ citekey: entry.citekey, canonical });
  }

  return { entries: results };
}

// ---------------------------------------------------------------------------
// Per-entry processing
// ---------------------------------------------------------------------------

async function processEntry(
  entry: CslEntry,
  config: Config,
  http: HttpClient,
  cache: Cache | undefined,
  signal: AbortSignal,
  doHeadCheck: typeof defaultHeadCheck,
): Promise<CanonicalLayer> {
  // Step 1: applicability check
  if (entry.doi !== undefined || entry.isbn !== undefined) {
    return { status: 'not-applicable', url: entry.url ?? null };
  }

  // Step 2: no-URL case
  if (entry.url === undefined) {
    return { status: 'no-url-on-pre-doi-entry', url: null };
  }

  const url = entry.url;

  // Step 3: URL liveness via headCheck (per-entry errors are caught)
  let checkResult: HeadCheckResult;
  try {
    checkResult = await doHeadCheck(
      url,
      {
        http,
        cache,
        trustedHosts: config.trusted_hosts.hosts,
      },
      signal,
    );
  } catch (err) {
    // AbortSignal abort — rethrow so the entire run aborts
    if (signal.aborted) throw err;
    // Any other unexpected error → dead-url
    return { status: 'dead-url', url, redirectChain: [] };
  }

  if (!checkResult.ok) {
    switch (checkResult.reason) {
      case 'wrong-host':
        return { status: 'wrong-host', url, redirectChain: [] };
      case 'dead-url':
      case 'too-many-redirects':
      case 'timeout':
      case 'network-error':
        return { status: 'dead-url', url, redirectChain: [] };
    }
  }

  // checkResult.ok === true
  const { finalUrl, redirectChain, host } = checkResult;

  // Step 4: SEP archived-snapshot rule
  if (host === 'plato.stanford.edu') {
    if (!finalUrl.includes('/archives/')) {
      return { status: 'live-url-not-archived-snapshot', url: finalUrl, redirectChain };
    }
  }

  // Step 5: Edition-discipline check
  if (entry.note !== undefined) {
    const edition = detectEdition(entry.note);
    if (edition !== null) {
      const allowedHosts = CANONICAL_EDITION_HOSTS[edition];
      if (allowedHosts !== undefined && !isEditionHostAllowed(host, allowedHosts)) {
        return { status: 'wrong-host', url: finalUrl, redirectChain };
      }
    }
  }

  // Step 6: verified canonical
  return { status: 'verified-canonical', url: finalUrl, redirectChain };
}
