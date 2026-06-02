/**
 * Lightweight integration tests for CLI flags and global behaviours.
 *
 * These tests exercise the CLI binary itself (dist/cli.js) without
 * depending on fixture content beyond what the minimal fixture provides.
 * All tests run against the built binary — run `npm run build` first.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const projectRoot = path.resolve(fileURLToPath(import.meta.url), '../../..');
const cliPath = path.join(projectRoot, 'dist', 'cli.js');
const MINIMAL = path.join(projectRoot, 'test', 'fixtures', 'minimal');

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[], cwd?: string): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      'node',
      [cliPath, ...args],
      {
        cwd: cwd ?? projectRoot,
        env: { ...process.env, NODE_ENV: 'test' },
      },
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
// Build guard
// ---------------------------------------------------------------------------

beforeAll(async () => {
  try {
    await access(cliPath);
  } catch {
    throw new Error(
      `dist/cli.js not found at ${cliPath}. Run "npm run build" before running integration tests.`,
    );
  }
}, 60_000);

// ---------------------------------------------------------------------------
// --help
// ---------------------------------------------------------------------------

describe('--help', () => {
  it('exits 0 and prints help text', async () => {
    const result = await runCli(['--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('bibcheck');
    expect(result.stdout).toContain('check');
    expect(result.stdout).toContain('doctor');
  });

  it('check --help exits 0 and shows check options', async () => {
    const result = await runCli(['check', '--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('--format');
    expect(result.stdout).toContain('--config');
  });

  it('check --help no longer advertises --offline', async () => {
    const result = await runCli(['check', '--help']);
    expect(result.stdout).not.toContain('--offline');
  });
});

// ---------------------------------------------------------------------------
// --offline removed (decision Q3): now an unknown option
// ---------------------------------------------------------------------------

describe('--offline is removed', () => {
  it('check --offline errors as an unknown option', async () => {
    const result = await runCli(['check', '--offline', '--cwd', MINIMAL]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/unknown option.*--offline/i);
  });

  it('doctor --offline errors as an unknown option', async () => {
    const result = await runCli(['doctor', '--offline', '--cwd', MINIMAL]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/unknown option.*--offline/i);
  });
});

// ---------------------------------------------------------------------------
// --version
// ---------------------------------------------------------------------------

describe('--version', () => {
  it('exits 0 and prints a version string matching x.y.z', async () => {
    const result = await runCli(['--version']);
    // Commander writes version to stdout.
    const combined = result.stdout + result.stderr;
    // Version must match semver x.y.z pattern
    expect(combined).toMatch(/\d+\.\d+\.\d+/);
    // Exit 0 for version flag
    expect(result.code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Unknown subcommand
// ---------------------------------------------------------------------------

describe('unknown subcommand', () => {
  it('exits non-zero when given a bogus command', async () => {
    const result = await runCli(['bogus-command']);
    expect(result.code).not.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// No subcommand (invoked bare)
// ---------------------------------------------------------------------------

describe('bare invocation (no subcommand)', () => {
  it('exits non-zero and shows help', async () => {
    const result = await runCli([]);
    expect(result.code).not.toBe(0);
    // Help should appear on stdout since commander prints it via outputHelp()
    expect(result.stdout + result.stderr).toContain('bibcheck');
  });
});

// ---------------------------------------------------------------------------
// Per-subcommand --help
// ---------------------------------------------------------------------------

describe('subcommand --help flags', () => {
  const subcommands = ['canonical', 'existence', 'linkage', 'phrases', 'worklist', 'doctor'];

  for (const cmd of subcommands) {
    it(`bibcheck ${cmd} --help exits 0`, async () => {
      const result = await runCli([cmd, '--help']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('--format');
    });
  }
});

// ---------------------------------------------------------------------------
// --format validation
// ---------------------------------------------------------------------------

describe('--format validation', () => {
  it('rejects an invalid format and exits non-zero', async () => {
    const result = await runCli(
      ['check', '--format', 'invalid-format', '--cwd', MINIMAL],
    );
    expect(result.code).not.toBe(0);
  });
});
