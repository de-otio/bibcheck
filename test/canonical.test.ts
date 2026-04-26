/**
 * Tests for src/canonical.ts — runCanonical subcommand.
 *
 * Injects a mock `headCheck` via RunCanonicalDeps.headCheck so no real network
 * traffic is generated.
 */

import { describe, it, expect } from 'vitest';
import { runCanonical } from '../src/canonical.js';
import type { RunCanonicalDeps } from '../src/canonical.js';
import type { HeadCheckResult, HttpClient } from '../src/http.js';
import type { Config } from '../src/config.js';
import type { CslEntry } from '../src/schema/csl.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal Config with a standard trusted-host whitelist. */
function makeConfig(extraHosts: string[] = []): Config {
  return {
    bibliography: { file: 'docs/sources.json' },
    docs: { include: ['docs/**/*.md'], exclude: [] },
    trusted_hosts: {
      hosts: [
        'hathitrust.org',
        'archive.org',
        'oll.libertyfund.org',
        'plato.stanford.edu',
        'philpapers.org',
        'loc.gov',
        'dnb.de',
        'bnf.fr',
        ...extraHosts,
      ],
    },
    phrases: { file: null },
    source_types: {},
    edition_discipline: {},
    apis: {
      crossref_mailto: null,
      openalex_mailto: null,
      worldcat_key_env: null,
    },
    cache: { dir: '.bibcheck-cache', max_size_mb: 256 },
  };
}

/** Stub HttpClient — runCanonical delegates to the injected headCheck, not http directly. */
const stubHttp: HttpClient = {
  get: async () => { throw new Error('stubHttp.get should not be called'); },
  head: async () => { throw new Error('stubHttp.head should not be called'); },
};

/** Build a minimal CslEntry with only the fields we care about. */
function makeEntry(overrides: Partial<CslEntry>): CslEntry {
  return {
    citekey: 'test-key',
    id: 'test-key',
    type: 'book',
    ...overrides,
  } as CslEntry;
}

/** Build a mock headCheck that returns a fixed result for any URL. */
function mockHeadCheck(result: HeadCheckResult): RunCanonicalDeps['headCheck'] {
  return async (_url, _opts, _signal) => result;
}

/** headCheck result for a successful fetch on a given host/url. */
function okResult(finalUrl: string, redirectChain: string[] = []): HeadCheckResult {
  const host = new URL(finalUrl).hostname.toLowerCase();
  return { ok: true, status: 200, finalUrl, redirectChain, host };
}

type FailReason = Extract<HeadCheckResult, { ok: false }>['reason'];

/** headCheck result for a failed fetch. */
function failResult(reason: FailReason): HeadCheckResult {
  return { ok: false, reason, details: `mock: ${reason}` };
}

/** Non-aborted AbortSignal. */
function liveSignal(): AbortSignal {
  return new AbortController().signal;
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

describe('runCanonical', () => {

  // Case 1: Entry with DOI → not-applicable
  it('returns not-applicable for entry with DOI', async () => {
    const entry = makeEntry({ citekey: 'kant1781', doi: '10.1000/xyz123', url: 'https://example.com' });
    const { entries } = await runCanonical({
      config: makeConfig(),
      bibliography: [entry],
      http: stubHttp,
      signal: liveSignal(),
      headCheck: async () => { throw new Error('should not call headCheck for DOI entries'); },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.canonical?.status).toBe('not-applicable');
    expect(entries[0]?.canonical?.url).toBe('https://example.com');
  });

  // Case 2: Entry with ISBN → not-applicable
  it('returns not-applicable for entry with ISBN', async () => {
    const entry = makeEntry({ citekey: 'smith1776', isbn: '978-0-19-953680-5', url: 'https://example.com' });
    const { entries } = await runCanonical({
      config: makeConfig(),
      bibliography: [entry],
      http: stubHttp,
      signal: liveSignal(),
      headCheck: async () => { throw new Error('should not call headCheck for ISBN entries'); },
    });
    expect(entries[0]?.canonical?.status).toBe('not-applicable');
    expect(entries[0]?.canonical?.url).toBe('https://example.com');
  });

  // Case 2b: Entry with ISBN and no URL → not-applicable with null url
  it('returns not-applicable with null url for DOI entry with no URL', async () => {
    const entry = makeEntry({ citekey: 'kant2', doi: '10.1000/abc' });
    const { entries } = await runCanonical({
      config: makeConfig(),
      bibliography: [entry],
      http: stubHttp,
      signal: liveSignal(),
    });
    expect(entries[0]?.canonical?.status).toBe('not-applicable');
    expect(entries[0]?.canonical?.url).toBeNull();
  });

  // Case 3: Entry with no DOI, ISBN, or URL → no-url-on-pre-doi-entry
  it('returns no-url-on-pre-doi-entry for entry with no DOI, ISBN, or URL', async () => {
    const entry = makeEntry({ citekey: 'plato400bc' });
    const { entries } = await runCanonical({
      config: makeConfig(),
      bibliography: [entry],
      http: stubHttp,
      signal: liveSignal(),
      headCheck: async () => { throw new Error('should not call headCheck'); },
    });
    expect(entries[0]?.canonical?.status).toBe('no-url-on-pre-doi-entry');
    expect(entries[0]?.canonical?.url).toBeNull();
  });

  // Case 4: URL on archive.org (whitelisted) → verified-canonical
  it('returns verified-canonical for URL on archive.org returning ok', async () => {
    const url = 'https://archive.org/details/some-book';
    const entry = makeEntry({ citekey: 'mill1859', url });
    const { entries } = await runCanonical({
      config: makeConfig(),
      bibliography: [entry],
      http: stubHttp,
      signal: liveSignal(),
      headCheck: mockHeadCheck(okResult(url)),
    });
    expect(entries[0]?.canonical?.status).toBe('verified-canonical');
    expect(entries[0]?.canonical?.url).toBe(url);
    expect(entries[0]?.canonical?.redirectChain).toEqual([]);
  });

  // Case 5: URL returning headCheck ok: false, reason: dead-url → dead-url
  it('returns dead-url when headCheck says dead-url', async () => {
    const url = 'https://archive.org/details/missing-book';
    const entry = makeEntry({ citekey: 'kant1781b', url });
    const { entries } = await runCanonical({
      config: makeConfig(),
      bibliography: [entry],
      http: stubHttp,
      signal: liveSignal(),
      headCheck: mockHeadCheck(failResult('dead-url')),
    });
    expect(entries[0]?.canonical?.status).toBe('dead-url');
    expect(entries[0]?.canonical?.url).toBe(url);
    expect(entries[0]?.canonical?.redirectChain).toEqual([]);
  });

  // Case 6: URL on untrusted host, headCheck returning wrong-host → wrong-host
  it('returns wrong-host for URL on untrusted host (gutenberg.org)', async () => {
    const url = 'https://www.gutenberg.org/files/12345/12345.txt';
    const entry = makeEntry({ citekey: 'austen1813', url });
    const { entries } = await runCanonical({
      config: makeConfig(),
      bibliography: [entry],
      http: stubHttp,
      signal: liveSignal(),
      headCheck: mockHeadCheck(failResult('wrong-host')),
    });
    expect(entries[0]?.canonical?.status).toBe('wrong-host');
    expect(entries[0]?.canonical?.url).toBe(url);
    expect(entries[0]?.canonical?.redirectChain).toEqual([]);
  });

  // Case 7: SEP live URL (no /archives/) → live-url-not-archived-snapshot
  it('returns live-url-not-archived-snapshot for non-archived SEP URL', async () => {
    const url = 'https://plato.stanford.edu/entries/foo/';
    const entry = makeEntry({ citekey: 'sep-foo', url });
    const { entries } = await runCanonical({
      config: makeConfig(),
      bibliography: [entry],
      http: stubHttp,
      signal: liveSignal(),
      headCheck: mockHeadCheck(okResult(url)),
    });
    expect(entries[0]?.canonical?.status).toBe('live-url-not-archived-snapshot');
    expect(entries[0]?.canonical?.url).toBe(url);
  });

  // Case 8: SEP archived-snapshot URL → verified-canonical
  it('returns verified-canonical for archived SEP URL', async () => {
    const url = 'https://plato.stanford.edu/archives/win2024/entries/foo/';
    const entry = makeEntry({ citekey: 'sep-foo-archived', url });
    const { entries } = await runCanonical({
      config: makeConfig(),
      bibliography: [entry],
      http: stubHttp,
      signal: liveSignal(),
      headCheck: mockHeadCheck(okResult(url)),
    });
    expect(entries[0]?.canonical?.status).toBe('verified-canonical');
    expect(entries[0]?.canonical?.url).toBe(url);
  });

  // Case 9: Redirect chain ending on trusted host → verified-canonical, chain populated
  it('returns verified-canonical with populated redirectChain when URL redirects to trusted host', async () => {
    const originalUrl = 'http://archive.org/details/old-book';
    const finalUrl = 'https://archive.org/details/old-book';
    const redirectChain = [originalUrl];
    const entry = makeEntry({ citekey: 'old-book', url: originalUrl });
    const { entries } = await runCanonical({
      config: makeConfig(),
      bibliography: [entry],
      http: stubHttp,
      signal: liveSignal(),
      headCheck: mockHeadCheck(okResult(finalUrl, redirectChain)),
    });
    expect(entries[0]?.canonical?.status).toBe('verified-canonical');
    expect(entries[0]?.canonical?.url).toBe(finalUrl);
    expect(entries[0]?.canonical?.redirectChain).toEqual(redirectChain);
  });

  // Case 10: Edition discipline — Ak. note + URL on oll.libertyfund.org → wrong-host
  it('returns wrong-host for Akademie entry with URL on wrong edition host', async () => {
    const url = 'https://oll.libertyfund.org/titles/kant-critique-of-pure-reason';
    const entry = makeEntry({
      citekey: 'kant1781-kdrv',
      note: 'Ak. V:35',
      url,
    });
    const { entries } = await runCanonical({
      config: makeConfig(),
      bibliography: [entry],
      http: stubHttp,
      signal: liveSignal(),
      headCheck: mockHeadCheck(okResult(url)),
    });
    expect(entries[0]?.canonical?.status).toBe('wrong-host');
  });

  // Case 11: Edition discipline — Glasgow WN + URL on oll.libertyfund.org → verified-canonical
  it('returns verified-canonical for Glasgow WN entry with URL on oll.libertyfund.org', async () => {
    const url = 'https://oll.libertyfund.org/titles/smith-wealth-of-nations';
    const entry = makeEntry({
      citekey: 'smith1776-wn',
      note: 'Glasgow WN I.iii',
      url,
    });
    const { entries } = await runCanonical({
      config: makeConfig(),
      bibliography: [entry],
      http: stubHttp,
      signal: liveSignal(),
      headCheck: mockHeadCheck(okResult(url)),
    });
    expect(entries[0]?.canonical?.status).toBe('verified-canonical');
  });

  // Case 12: Per-entry error doesn't abort — list of 3 entries, second errors
  it('does not abort the run when one entry throws an unexpected error', async () => {
    const url1 = 'https://archive.org/details/book1';
    const url2 = 'https://archive.org/details/book2';
    const url3 = 'https://archive.org/details/book3';

    const entries = [
      makeEntry({ citekey: 'entry1', url: url1 }),
      makeEntry({ citekey: 'entry2', url: url2 }),
      makeEntry({ citekey: 'entry3', url: url3 }),
    ];

    let callCount = 0;
    const headCheckMock: RunCanonicalDeps['headCheck'] = async (url, _opts, _signal) => {
      callCount++;
      if (url === url2) {
        throw new Error('Simulated unexpected network error');
      }
      return okResult(url);
    };

    const result = await runCanonical({
      config: makeConfig(),
      bibliography: entries,
      http: stubHttp,
      signal: liveSignal(),
      headCheck: headCheckMock,
    });

    expect(result.entries).toHaveLength(3);
    expect(callCount).toBe(3);
    expect(result.entries[0]?.canonical?.status).toBe('verified-canonical');
    expect(result.entries[1]?.canonical?.status).toBe('dead-url');
    expect(result.entries[2]?.canonical?.status).toBe('verified-canonical');
  });

  // Case 13: AbortSignal aborted → throws
  it('throws when the AbortSignal is already aborted before run starts', async () => {
    const controller = new AbortController();
    controller.abort(new Error('user cancelled'));

    const entry = makeEntry({ citekey: 'test', url: 'https://archive.org/details/book' });

    await expect(
      runCanonical({
        config: makeConfig(),
        bibliography: [entry],
        http: stubHttp,
        signal: controller.signal,
        headCheck: async () => { throw new Error('should not be called'); },
      }),
    ).rejects.toThrow('user cancelled');
  });

  // Additional: too-many-redirects → dead-url
  it('returns dead-url for too-many-redirects reason', async () => {
    const url = 'https://archive.org/redirect-loop';
    const entry = makeEntry({ citekey: 'redirect-loop', url });
    const { entries } = await runCanonical({
      config: makeConfig(),
      bibliography: [entry],
      http: stubHttp,
      signal: liveSignal(),
      headCheck: mockHeadCheck(failResult('too-many-redirects')),
    });
    expect(entries[0]?.canonical?.status).toBe('dead-url');
  });

  // Additional: timeout → dead-url
  it('returns dead-url for timeout reason', async () => {
    const url = 'https://archive.org/slow-resource';
    const entry = makeEntry({ citekey: 'slow', url });
    const { entries } = await runCanonical({
      config: makeConfig(),
      bibliography: [entry],
      http: stubHttp,
      signal: liveSignal(),
      headCheck: mockHeadCheck(failResult('timeout')),
    });
    expect(entries[0]?.canonical?.status).toBe('dead-url');
  });

  // Additional: network-error → dead-url
  it('returns dead-url for network-error reason', async () => {
    const url = 'https://archive.org/unreachable';
    const entry = makeEntry({ citekey: 'unreachable', url });
    const { entries } = await runCanonical({
      config: makeConfig(),
      bibliography: [entry],
      http: stubHttp,
      signal: liveSignal(),
      headCheck: mockHeadCheck(failResult('network-error')),
    });
    expect(entries[0]?.canonical?.status).toBe('dead-url');
  });

  // Additional: Toronto-CW edition on wrong host → wrong-host
  it('returns wrong-host for Toronto CW entry on non-approved host', async () => {
    const url = 'https://some-random-site.com/mill';
    const entry = makeEntry({
      citekey: 'mill-toronto',
      note: 'Toronto CW vol. 18',
      url,
    });
    const { entries } = await runCanonical({
      config: makeConfig(['some-random-site.com']),
      bibliography: [entry],
      http: stubHttp,
      signal: liveSignal(),
      headCheck: mockHeadCheck(okResult(url)),
    });
    expect(entries[0]?.canonical?.status).toBe('wrong-host');
  });

  // Additional: Clarendon edition on oup.com → verified-canonical
  it('returns verified-canonical for Clarendon entry on global.oup.com', async () => {
    const url = 'https://global.oup.com/academic/product/some-book';
    const entry = makeEntry({
      citekey: 'hobbes-clarendon',
      note: 'Clarendon Edition of the works',
      url,
    });
    const { entries } = await runCanonical({
      config: makeConfig(['global.oup.com']),
      bibliography: [entry],
      http: stubHttp,
      signal: liveSignal(),
      headCheck: mockHeadCheck(okResult(url)),
    });
    expect(entries[0]?.canonical?.status).toBe('verified-canonical');
  });

  // Additional: Akademie-Ausgabe on archive.org → verified-canonical
  it('returns verified-canonical for Akademie-Ausgabe entry on archive.org', async () => {
    const url = 'https://archive.org/details/kant-akademie';
    const entry = makeEntry({
      citekey: 'kant-ak',
      note: 'Akademie-Ausgabe Band III',
      url,
    });
    const { entries } = await runCanonical({
      config: makeConfig(),
      bibliography: [entry],
      http: stubHttp,
      signal: liveSignal(),
      headCheck: mockHeadCheck(okResult(url)),
    });
    expect(entries[0]?.canonical?.status).toBe('verified-canonical');
  });

  // Additional: Collected Works of John Stuart Mill → toronto-cw
  it('recognises "Collected Works of John Stuart Mill" as toronto-cw edition', async () => {
    const url = 'https://oll.libertyfund.org/titles/mill-collected-works';
    const entry = makeEntry({
      citekey: 'mill-cw',
      note: 'Collected Works of John Stuart Mill, vol. 1',
      url,
    });
    const { entries } = await runCanonical({
      config: makeConfig(),
      bibliography: [entry],
      http: stubHttp,
      signal: liveSignal(),
      headCheck: mockHeadCheck(okResult(url)),
    });
    expect(entries[0]?.canonical?.status).toBe('verified-canonical');
  });

  // Additional: Glasgow Edition (generic form) → glasgow
  it('recognises "Glasgow Edition" note form', async () => {
    const url = 'https://oll.libertyfund.org/titles/smith-tms';
    const entry = makeEntry({
      citekey: 'smith-glasgow',
      note: 'Glasgow Edition of Smith',
      url,
    });
    const { entries } = await runCanonical({
      config: makeConfig(),
      bibliography: [entry],
      http: stubHttp,
      signal: liveSignal(),
      headCheck: mockHeadCheck(okResult(url)),
    });
    expect(entries[0]?.canonical?.status).toBe('verified-canonical');
  });

  // Additional: project-extended trusted-host whitelist works
  it('returns verified-canonical for entry on a project-added trusted host', async () => {
    const url = 'https://project-custom-host.org/primary-source';
    const entry = makeEntry({ citekey: 'custom', url });
    const { entries } = await runCanonical({
      config: makeConfig(['project-custom-host.org']),
      bibliography: [entry],
      http: stubHttp,
      signal: liveSignal(),
      headCheck: mockHeadCheck(okResult(url)),
    });
    expect(entries[0]?.canonical?.status).toBe('verified-canonical');
  });

  // Additional: abort mid-run (signal aborted between entries)
  it('throws when AbortSignal is aborted mid-run', async () => {
    const controller = new AbortController();
    const url = 'https://archive.org/details/book1';

    const entries = [
      makeEntry({ citekey: 'entry1', url }),
      makeEntry({ citekey: 'entry2', url }),
    ];

    let callCount = 0;
    const headCheckMock: RunCanonicalDeps['headCheck'] = async (_url, _opts, signal) => {
      callCount++;
      if (callCount === 1) {
        // Abort after processing the first entry
        controller.abort(new Error('aborted mid-run'));
      }
      if (signal.aborted) throw signal.reason as Error;
      return okResult(_url);
    };

    await expect(
      runCanonical({
        config: makeConfig(),
        bibliography: entries,
        http: stubHttp,
        signal: controller.signal,
        headCheck: headCheckMock,
      }),
    ).rejects.toThrow('aborted mid-run');
  });

  // Additional: empty bibliography returns empty entries array
  it('returns empty entries for empty bibliography', async () => {
    const { entries } = await runCanonical({
      config: makeConfig(),
      bibliography: [],
      http: stubHttp,
      signal: liveSignal(),
    });
    expect(entries).toHaveLength(0);
  });
});
