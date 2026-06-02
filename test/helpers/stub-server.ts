/**
 * Hermetic localhost HTTP stub for the bibliographic-database APIs.
 *
 * Phase 5 removed `--offline`; integration tests achieve determinism by
 * pointing the CLI's `[apis] *_base` URLs at a localhost stub started here.
 * The stub binds an ephemeral port (`listen(0)`), serves per-path canned JSON
 * for CrossRef / OpenAlex / OpenLibrary, and is torn down per test.
 *
 * Because the CLI runs as a child process (see `runCli` in the integration
 * tests) we cannot inject a JS mock — the only seam reachable by the
 * subprocess is configuration. `writeStubConfig()` writes a `bibcheck.toml`
 * (extending an existing fixture config if present) whose `[apis] *_base`
 * fields point at this server, so the spawned CLI hits localhost and never
 * the public internet.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

// ---------------------------------------------------------------------------
// Canned-response model
// ---------------------------------------------------------------------------

/**
 * A canned response. `status` defaults to 200; `body` is serialised as JSON
 * with `content-type: application/json` (the http client parses JSON only
 * when that content-type is present).
 */
export interface CannedResponse {
  status?: number;
  body: unknown;
}

/**
 * Decide which canned response to send for a given request. Receives the
 * parsed URL pathname and the full URL (path + query). Return `undefined`
 * to fall through to a default 404 (CrossRef/OpenLibrary "not found" shape).
 */
export type StubRouter = (pathname: string, fullUrl: string) => CannedResponse | undefined;

// ---------------------------------------------------------------------------
// Default router — preserves the previous (offline) integration outcomes.
// ---------------------------------------------------------------------------

/**
 * CrossRef "found" body. We deliberately omit `title` and `author` from the
 * record: the existence layer compares the queried entry's title/first-author
 * against the returned metadata with a fuzzy Levenshtein ratio and flags a
 * gating *metadata-mismatch* on divergence. A generic stub title would mismatch
 * every real fixture title. By returning a found work with no title/author the
 * comparison short-circuits to a match (entry vs. undefined metadata → "found"),
 * which preserves the previous offline behaviour: existence does not gate and
 * the known-good fixture stays at exit 0.
 */
function crossrefWork(): unknown {
  return {
    status: 'ok',
    'message-type': 'work',
    message: {
      DOI: '10.0000/stub',
      issued: { 'date-parts': [[2000]] },
      publisher: 'Stub Press',
      type: 'journal-article',
    },
  };
}

function openalexWork(): unknown {
  return {
    id: 'https://openalex.org/W0',
    publication_year: 2000,
    doi: 'https://doi.org/10.0000/stub',
  };
}

/**
 * The default router used by the migrated integration tests. It returns a
 * "found" record for any DOI/title lookup *except* DOIs that look fabricated
 * (path contains "nonexistent"), and a "not found" (empty) body for those —
 * preserving the known-bad fixture's not-found-in-databases outcome without
 * introducing a gating metadata-mismatch.
 */
export const defaultRouter: StubRouter = (pathname, fullUrl) => {
  const looksFabricated = /nonexistent|fakedoi|99999/i.test(fullUrl);

  // OpenAlex single-work: /works/doi:<doi> (checked before the generic
  // CrossRef /works/ prefix, which it also matches).
  if (pathname.startsWith('/works/doi:')) {
    if (looksFabricated) {
      return { status: 404, body: { error: 'Not found.' } };
    }
    return { body: openalexWork() };
  }

  // CrossRef: /works/<doi>
  if (pathname.startsWith('/works/')) {
    if (looksFabricated) {
      // CrossRef returns 404 with a small body for unknown DOIs.
      return { status: 404, body: { status: 'error', 'message-type': 'route-not-found' } };
    }
    return { body: crossrefWork() };
  }

  // OpenAlex search: /works?search=...
  if (pathname === '/works') {
    if (looksFabricated) {
      return { body: { results: [] } };
    }
    return { body: { results: [openalexWork()] } };
  }

  // OpenLibrary: /api/books?bibkeys=ISBN:<isbn>. Found, but with no
  // title/author (see crossrefWork docstring) so existence does not gate.
  if (pathname === '/api/books') {
    const m = /ISBN:([^&]+)/.exec(fullUrl);
    const isbn = m?.[1] !== undefined ? decodeURIComponent(m[1]) : '';
    if (looksFabricated || isbn === '') {
      // Empty object → no match (found: false).
      return { body: {} };
    }
    return {
      body: {
        [`ISBN:${isbn}`]: { publish_date: '2000' },
      },
    };
  }

  return undefined;
};

// ---------------------------------------------------------------------------
// Stub server
// ---------------------------------------------------------------------------

export interface StubServer {
  /** Base URL, e.g. http://127.0.0.1:54321 (no trailing slash). */
  readonly baseUrl: string;
  /** The bound port. */
  readonly port: number;
  /** Number of requests received (for assertions). */
  readonly requestCount: () => number;
  /** Paths received, in order (for assertions). */
  readonly requests: () => string[];
  /** Stop the server and free the port. */
  close: () => Promise<void>;
}

export interface StartStubOptions {
  /** Override the routing logic. Defaults to {@link defaultRouter}. */
  router?: StubRouter;
}

/**
 * Start a localhost stub on an ephemeral port (binds 127.0.0.1). The http
 * client now runs the private-IP guard on every hop, so reaching this stub
 * requires the client's `allowPrivateHosts` escape hatch — which production
 * enables only when an operator points an `[apis] *_base` at a private host
 * (see isPrivateApiBase); the guard on bibliography-derived URLs is unaffected.
 */
export async function startStubServer(opts?: StartStubOptions): Promise<StubServer> {
  const router = opts?.router ?? defaultRouter;
  const received: string[] = [];

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const rawUrl = req.url ?? '/';
    received.push(rawUrl);
    // Parse against a dummy base to split path/query.
    const parsed = new URL(rawUrl, 'http://localhost');
    const canned = router(parsed.pathname, rawUrl);

    if (canned === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'no stub for path', path: parsed.pathname }));
      return;
    }

    const status = canned.status ?? 200;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(canned.body));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address() as AddressInfo;
  const port = address.port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    port,
    requestCount: () => received.length,
    requests: () => [...received],
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

// ---------------------------------------------------------------------------
// Config writer
// ---------------------------------------------------------------------------

export interface WriteStubConfigOptions {
  /** Directory containing (or to contain) bibcheck.toml. */
  dir: string;
  /** The stub base URL to point all three live DB clients at. */
  baseUrl: string;
  /** Filename to write. Defaults to bibcheck.toml. */
  filename?: string;
}

/**
 * Write a bibcheck.toml into `dir` whose `[apis] *_base` URLs point at the
 * stub. If a config already exists, its `[apis]` section is replaced (other
 * sections preserved) so existing fixture settings (bibliography, phrases,
 * docs) still apply. Returns the path written.
 */
export async function writeStubConfig(opts: WriteStubConfigOptions): Promise<string> {
  const filename = opts.filename ?? 'bibcheck.toml';
  const configPath = join(opts.dir, filename);

  let existing = '';
  try {
    await access(configPath);
    existing = await readFile(configPath, 'utf-8');
  } catch {
    existing = '';
  }

  // Strip any pre-existing [apis] block to avoid duplicate-section errors and
  // stale base URLs. We match from a line starting with `[apis]` up to (but
  // not including) the next top-level `[` section header or EOF.
  const withoutApis = stripTomlSection(existing, 'apis');

  const apisBlock = [
    '[apis]',
    `crossref_base = "${opts.baseUrl}"`,
    `openalex_base = "${opts.baseUrl}"`,
    `openlibrary_base = "${opts.baseUrl}"`,
  ].join('\n');

  const trimmed = withoutApis.trimEnd();
  const merged = (trimmed === '' ? '' : trimmed + '\n\n') + apisBlock + '\n';

  await writeFile(configPath, merged, 'utf-8');
  return configPath;
}

/**
 * Remove a top-level TOML table section (e.g. `[apis]`) and its key/value
 * lines, leaving other sections intact. Subtables (`[apis.foo]`) are also
 * removed. Returns the remaining TOML text. Pure string surgery — sufficient
 * for our simple, hand-written fixture configs.
 */
export function stripTomlSection(toml: string, section: string): string {
  const lines = toml.split('\n');
  const out: string[] = [];
  let inSection = false;

  const headerRe = /^\s*\[([^\]]+)\]\s*$/;

  for (const line of lines) {
    const m = headerRe.exec(line);
    if (m !== null) {
      const name = (m[1] ?? '').trim();
      // Enter skip-mode for the target section or any of its subtables.
      inSection = name === section || name.startsWith(section + '.');
      if (inSection) continue;
    }
    if (!inSection) {
      out.push(line);
    }
  }

  return out.join('\n');
}
