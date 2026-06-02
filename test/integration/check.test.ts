/**
 * Integration tests for `bibcheck check` and per-subcommand variants.
 *
 * All tests run against the **built** dist/cli.js, not source.
 *
 * Determinism: `--offline` was removed in decision Q3. Network-bound checks
 * (existence, canonical) now run against a hermetic localhost HTTP stub
 * (test/helpers/stub-server.ts). Each fixture is materialised into a fresh
 * temp directory whose bibcheck.toml points the `[apis] *_base` URLs at the
 * stub, so the spawned CLI subprocess reaches localhost and never the public
 * internet. The stub is torn down after each test.
 *
 * SARIF validation uses a local stub schema (test/fixtures/sarif-2.1.0.schema.json).
 * If the schema file is missing, the SARIF structural test falls back to basic
 * property assertions.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, access, cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startStubServer, writeStubConfig, type StubServer } from '../helpers/stub-server.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const projectRoot = path.resolve(fileURLToPath(import.meta.url), '../../..');
const cliPath = path.join(projectRoot, 'dist', 'cli.js');
const fixturesDir = path.join(projectRoot, 'test', 'fixtures');

const KNOWN_GOOD = path.join(fixturesDir, 'known-good');
const KNOWN_BAD  = path.join(fixturesDir, 'known-bad');
const MINIMAL    = path.join(fixturesDir, 'minimal');
const GATING     = path.join(fixturesDir, 'gating');

const SARIF_SCHEMA_PATH = path.join(fixturesDir, 'sarif-2.1.0.schema.json');

// ---------------------------------------------------------------------------
// Helper: run the CLI
// ---------------------------------------------------------------------------

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[], cwd: string): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      'node',
      [cliPath, ...args],
      { cwd, env: { ...process.env, NODE_ENV: 'test' } },
    );
    return { code: 0, stdout, stderr };
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
    };
  }
}

// ---------------------------------------------------------------------------
// Hermetic harness: one stub + per-test temp fixture copies
// ---------------------------------------------------------------------------

let stub: StubServer;
const tempDirs: string[] = [];

/**
 * Copy a fixture dir into a fresh temp dir and rewrite its bibcheck.toml so
 * the `[apis] *_base` URLs target the stub. Returns the temp dir to use as the
 * CLI's cwd. Cleaned up in afterEach.
 */
async function stubbedFixture(fixtureDir: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'bibcheck-it-'));
  tempDirs.push(dir);
  await cp(fixtureDir, dir, { recursive: true });
  await writeStubConfig({ dir, baseUrl: stub.baseUrl });
  return dir;
}

beforeAll(async () => {
  try {
    await access(cliPath);
  } catch {
    throw new Error(
      `dist/cli.js not found at ${cliPath}. Run "npm run build" before running integration tests.`,
    );
  }
}, 60_000);

beforeEach(async () => {
  stub = await startStubServer();
});

afterEach(async () => {
  await stub.close();
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

// ---------------------------------------------------------------------------
// known-good fixture
// ---------------------------------------------------------------------------

describe('known-good fixture', () => {
  it('exits 0 (existence verified against stub, no phrase/linkage/canonical issues)', async () => {
    const cwd = await stubbedFixture(KNOWN_GOOD);
    const result = await runCli(['check', '--format', 'json'], cwd);
    expect(result.code).toBe(0);

    // Hermeticity guarantee: the spawned CLI's existence lookups hit the
    // localhost stub, not the public APIs. If it had reached real CrossRef/
    // OpenAlex the returned (real) titles would diverge from the fixture and
    // existence would flip to a gating metadata-mismatch (exit 1).
    expect(stub.requestCount()).toBeGreaterThan(0);

    const output = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(output).toBeDefined();

    const summary = output['summary'] as Record<string, number>;
    expect(summary['phraseFlags']).toBe(0);
    expect(summary['linkageFailures']).toBe(0);
    expect(summary['canonicalIssues']).toBe(0);
    expect(summary['worklistItems']).toBe(0);
    // Existence is verified (not unverifiable) because the stub returns matches.
    expect(summary['metadataMismatches']).toBe(0);
  });

  it('JSON output validates against OutputSchema shape', async () => {
    const cwd = await stubbedFixture(KNOWN_GOOD);
    const result = await runCli(['check', '--format', 'json'], cwd);
    const output = JSON.parse(result.stdout) as Record<string, unknown>;

    expect(output).toHaveProperty('schemaVersion', '0.2.0');
    expect(output).toHaveProperty('tool');
    expect(output).toHaveProperty('summary');
    expect(output).toHaveProperty('entries');
    expect(output).toHaveProperty('linkage');
    expect(output).toHaveProperty('phraseFlags');
    expect(output).toHaveProperty('worklist');

    const linkage = output['linkage'] as Array<Record<string, unknown>>;
    for (const entry of linkage) {
      expect(entry['status']).toBe('resolved');
    }
  });
});

// ---------------------------------------------------------------------------
// known-bad fixture
// ---------------------------------------------------------------------------

describe('known-bad fixture', () => {
  it('exits 1', async () => {
    const cwd = await stubbedFixture(KNOWN_BAD);
    const result = await runCli(['check', '--format', 'json'], cwd);
    expect(result.code).toBe(1);
  });

  it('reports phraseFlags >= 1', async () => {
    const cwd = await stubbedFixture(KNOWN_BAD);
    const result = await runCli(['check', '--format', 'json'], cwd);
    const output = JSON.parse(result.stdout) as Record<string, unknown>;
    const summary = output['summary'] as Record<string, number>;
    expect(summary['phraseFlags']).toBeGreaterThanOrEqual(1);
  });

  it('reports linkageFailures >= 1', async () => {
    const cwd = await stubbedFixture(KNOWN_BAD);
    const result = await runCli(['check', '--format', 'json'], cwd);
    const output = JSON.parse(result.stdout) as Record<string, unknown>;
    const summary = output['summary'] as Record<string, number>;
    expect(summary['linkageFailures']).toBeGreaterThanOrEqual(1);
  });

  it('reports worklistItems >= 1', async () => {
    const cwd = await stubbedFixture(KNOWN_BAD);
    const result = await runCli(['check', '--format', 'json'], cwd);
    const output = JSON.parse(result.stdout) as Record<string, unknown>;
    const summary = output['summary'] as Record<string, number>;
    expect(summary['worklistItems']).toBeGreaterThanOrEqual(1);
  });

  it('linkage array contains at least one unresolved entry', async () => {
    const cwd = await stubbedFixture(KNOWN_BAD);
    const result = await runCli(['check', '--format', 'json'], cwd);
    const output = JSON.parse(result.stdout) as Record<string, unknown>;
    const linkage = output['linkage'] as Array<Record<string, unknown>>;
    expect(linkage.some((l) => l['status'] === 'unresolved')).toBe(true);
  });

  it('phraseFlags array contains at least one flagged entry', async () => {
    const cwd = await stubbedFixture(KNOWN_BAD);
    const result = await runCli(['check', '--format', 'json'], cwd);
    const output = JSON.parse(result.stdout) as Record<string, unknown>;
    const phraseFlags = output['phraseFlags'] as Array<Record<string, unknown>>;
    expect(phraseFlags.some((f) => f['status'] === 'flagged')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// gating fixture — the T22 B1 fix + malformed-identifier gating (Q1)
//
// Proves the headline behaviour end-to-end via the built CLI + hermetic stub:
//   - a fabricated DOI (stub 404) → not-found-in-databases, counted, exit 1
//   - a bad-checksum ISBN (local T21) → skips the network call, counted in
//     malformedIdentifiers, exit 1
// ---------------------------------------------------------------------------

describe('gating fixture (fabricated DOI + bad-checksum ISBN)', () => {
  it('exits 1', async () => {
    const cwd = await stubbedFixture(GATING);
    const result = await runCli(['check', '--format', 'json'], cwd);
    expect(result.code).toBe(1);
  });

  it('counts the fabricated DOI in summary.notFoundInDatabases and the bad ISBN in summary.malformedIdentifiers', async () => {
    const cwd = await stubbedFixture(GATING);
    const result = await runCli(['check', '--format', 'json'], cwd);
    const output = JSON.parse(result.stdout) as Record<string, unknown>;
    const summary = output['summary'] as Record<string, number>;

    expect(summary['notFoundInDatabases']).toBe(1);
    expect(summary['malformedIdentifiers']).toBe(1);

    const entries = output['entries'] as Array<Record<string, unknown>>;
    const fakeDoi = entries.find((e) => e['citekey'] === 'fakeDoi2099nonexistent');
    const existence = fakeDoi?.['existence'] as Record<string, unknown> | undefined;
    expect(existence?.['status']).toBe('not-found-in-databases');
    expect(existence?.['evidence']).toBe('absent');

    const badIsbn = entries.find((e) => e['citekey'] === 'badChecksumIsbn');
    const ids = badIsbn?.['identifiers'] as Record<string, unknown> | undefined;
    expect(ids?.['isbn']).toBe('bad-checksum');
    // claim-support is always in notCheckedFor (Q2).
    const badExistence = badIsbn?.['existence'] as Record<string, unknown> | undefined;
    expect(badExistence?.['notCheckedFor']).toContain('claim-support');
  });

  it('does not leak a mailto/API key into the output for the fabricated DOI', async () => {
    const cwd = await stubbedFixture(GATING);
    const result = await runCli(['check', '--format', 'json'], cwd);
    expect(result.stdout).not.toContain('mailto=');
  });
});

// ---------------------------------------------------------------------------
// minimal fixture
// ---------------------------------------------------------------------------

describe('minimal fixture', () => {
  it('exits 0 with empty bibliography', async () => {
    const cwd = await stubbedFixture(MINIMAL);
    const result = await runCli(['check', '--format', 'json'], cwd);
    expect(result.code).toBe(0);
  });

  it('emits empty arrays for all finding categories', async () => {
    const cwd = await stubbedFixture(MINIMAL);
    const result = await runCli(['check', '--format', 'json'], cwd);
    const output = JSON.parse(result.stdout) as Record<string, unknown>;

    expect(output['entries']).toEqual([]);
    expect(output['linkage']).toEqual([]);
    expect(output['phraseFlags']).toEqual([]);
    expect(output['worklist']).toEqual([]);
  });

  it('summary counts are all zero', async () => {
    const cwd = await stubbedFixture(MINIMAL);
    const result = await runCli(['check', '--format', 'json'], cwd);
    const output = JSON.parse(result.stdout) as Record<string, unknown>;
    const summary = output['summary'] as Record<string, number>;

    expect(summary['totalEntries']).toBe(0);
    expect(summary['verified']).toBe(0);
    expect(summary['linkageFailures']).toBe(0);
    expect(summary['phraseFlags']).toBe(0);
    expect(summary['worklistItems']).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Output formats
// ---------------------------------------------------------------------------

describe('--format markdown', () => {
  it('produces markdown output containing the report heading', async () => {
    const cwd = await stubbedFixture(MINIMAL);
    const result = await runCli(['check', '--format', 'markdown'], cwd);
    expect(result.stdout).toContain('# bibcheck report');
  });
});

describe('--format sarif', () => {
  it('produces valid SARIF with version "2.1.0" and a runs array', async () => {
    const cwd = await stubbedFixture(MINIMAL);
    const result = await runCli(['check', '--format', 'sarif'], cwd);
    const sarifObj = JSON.parse(result.stdout) as Record<string, unknown>;

    expect(sarifObj['version']).toBe('2.1.0');
    expect(Array.isArray(sarifObj['runs'])).toBe(true);
  });

  it('validates against the SARIF 2.1.0 JSON Schema using ajv (if schema available)', async () => {
    let schemaAvailable = true;
    let schemaContent: string;
    try {
      schemaContent = await readFile(SARIF_SCHEMA_PATH, 'utf-8');
    } catch {
      schemaAvailable = false;
      schemaContent = '';
    }

    if (!schemaAvailable) {
      const cwd = await stubbedFixture(MINIMAL);
      const result = await runCli(['check', '--format', 'sarif'], cwd);
      const sarif = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(sarif['version']).toBe('2.1.0');
      expect(Array.isArray(sarif['runs'])).toBe(true);
      return;
    }

    const schema = JSON.parse(schemaContent) as Record<string, unknown>;

    const ajvModule = (await import('ajv')) as unknown as {
      default: new (opts?: Record<string, unknown>) => {
        compile: (schema: unknown) => {
          (data: unknown): boolean;
          errors?: Array<{ instancePath?: string; message?: string }> | null;
        };
      };
    };
    const ajv = new ajvModule.default({ strict: false, allErrors: true });

    const validate = ajv.compile(schema);

    const cwd = await stubbedFixture(KNOWN_BAD);
    const result = await runCli(['check', '--format', 'sarif'], cwd);
    const sarif = JSON.parse(result.stdout) as unknown;
    const valid = validate(sarif);

    if (!valid) {
      const errors = (validate.errors ?? [])
        .slice(0, 5)
        .map((e) => `${e.instancePath ?? ''} ${e.message ?? ''}`)
        .join('; ');
      throw new Error(`SARIF output failed schema validation: ${errors}`);
    }

    expect(valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// doctor command — connectivity against the stub
// ---------------------------------------------------------------------------

describe('bibcheck doctor', () => {
  it('exits 0 against the minimal fixture with connectivity targeting the stub', async () => {
    const cwd = await stubbedFixture(MINIMAL);
    const result = await runCli(['doctor'], cwd);
    // Node/config/bibliography checks pass; connectivity hits the stub (200) → ok.
    expect(result.code).toBe(0);
    expect(result.stdout.toLowerCase()).toMatch(/node/);
  });

  it('reports connectivity checks as ok when the stub answers', async () => {
    const cwd = await stubbedFixture(MINIMAL);
    const result = await runCli(['doctor'], cwd);
    expect(result.stdout).toMatch(/crossref-connectivity/);
    // Connectivity check should be ok against the stub (any non-5xx response).
    const crossrefLine = result.stdout
      .split('\n')
      .find((l) => l.includes('crossref-connectivity'));
    expect(crossrefLine).toMatch(/^ok/);
  });

  it('mentions "Node version" check in the output', async () => {
    const cwd = await stubbedFixture(MINIMAL);
    const result = await runCli(['doctor'], cwd);
    expect(result.stdout).toMatch(/node-version|Node v\d+/i);
  });

  it('connectivity fails fast (no hang) when pointed at a refused port', async () => {
    // Point the config at a closed localhost port so the connect is refused
    // immediately. This is the previously-flaky connectivity test, now
    // deterministic and hermetic. The connect is refused (ECONNREFUSED) and
    // the client's bounded retry/backoff resolves quickly — it must not hang
    // on the per-attempt network timeout (5s × 3 attempts × 4 endpoints).
    const cwd = await stubbedFixture(MINIMAL);
    // Overwrite the stub config to target a port nothing is listening on.
    await writeStubConfig({ dir: cwd, baseUrl: 'http://127.0.0.1:1' });
    const start = Date.now();
    const result = await runCli(['doctor'], cwd);
    const elapsed = Date.now() - start;
    // Connectivity failures make doctor exit 1 (a 'fail' check).
    expect(result.code).toBe(1);
    const crossrefLine = result.stdout
      .split('\n')
      .find((l) => l.includes('crossref-connectivity'));
    expect(crossrefLine).toMatch(/^fail/);
    // Refused connects resolve via fast backoff, nowhere near the timeout path.
    expect(elapsed).toBeLessThan(15000);
  });
});

// ---------------------------------------------------------------------------
// Per-subcommand: phrases
// ---------------------------------------------------------------------------

describe('bibcheck phrases (standalone)', () => {
  it('exits 1 on known-bad (phrase flag is a non-zero-exit reason)', async () => {
    const cwd = await stubbedFixture(KNOWN_BAD);
    const result = await runCli(['phrases', '--format', 'json'], cwd);
    expect(result.code).toBe(1);
  });

  it('exits 0 on known-good (no denylist configured, no patterns)', async () => {
    const cwd = await stubbedFixture(KNOWN_GOOD);
    const result = await runCli(['phrases', '--format', 'json'], cwd);
    expect(result.code).toBe(0);
    const output = JSON.parse(result.stdout) as Record<string, unknown>;
    expect((output['phraseFlags'] as unknown[]).length).toBe(0);
  });

  it('exits 0 on minimal (empty bibliography, no patterns)', async () => {
    const cwd = await stubbedFixture(MINIMAL);
    const result = await runCli(['phrases', '--format', 'json'], cwd);
    expect(result.code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Per-subcommand: linkage
// ---------------------------------------------------------------------------

describe('bibcheck linkage (standalone)', () => {
  it('exits 1 on known-bad (unresolved linkage is a non-zero-exit reason)', async () => {
    const cwd = await stubbedFixture(KNOWN_BAD);
    const result = await runCli(['linkage', '--format', 'json'], cwd);
    expect(result.code).toBe(1);
  });

  it('exits 0 on known-good (all citekeys resolve)', async () => {
    const cwd = await stubbedFixture(KNOWN_GOOD);
    const result = await runCli(['linkage', '--format', 'json'], cwd);
    expect(result.code).toBe(0);
    const output = JSON.parse(result.stdout) as Record<string, unknown>;
    const linkage = output['linkage'] as Array<Record<string, unknown>>;
    expect(linkage.every((l) => l['status'] === 'resolved')).toBe(true);
  });

  it('exits 0 on minimal (empty bibliography, no docs with citekeys)', async () => {
    const cwd = await stubbedFixture(MINIMAL);
    const result = await runCli(['linkage', '--format', 'json'], cwd);
    expect(result.code).toBe(0);
  });
});
