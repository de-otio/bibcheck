#!/usr/bin/env node
/**
 * bibcheck CLI entry point.
 *
 * Exports `buildProgram()` so tests can import and exercise the parser
 * without spawning a subprocess. The `isMain` guard at the bottom drives
 * the actual binary.
 */

import { Command } from 'commander';
import { writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import * as readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { loadConfig, ConfigError } from './config.js';
import type { Config } from './config.js';
import { buildCheckDeps, runCheck, checkExitReasons } from './check.js';
import type { Logger } from './check.js';
import { createMemoryCache } from './cache/fs-cache.js';
import { createHttpClient } from './http.js';
import { renderJson } from './output/json.js';
import { renderMarkdown } from './output/markdown.js';
import { renderSarif } from './output/sarif.js';
import { renderText } from './output/text.js';
import type { Output } from './schema/output.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Format = 'json' | 'markdown' | 'sarif' | 'text';
type SubcommandName = 'existence' | 'canonical' | 'linkage' | 'phrases' | 'worklist';

const ALL_SUBCOMMANDS: SubcommandName[] = [
  'existence',
  'canonical',
  'linkage',
  'phrases',
  'worklist',
];

const VALID_FORMATS: Format[] = ['json', 'markdown', 'sarif', 'text'];

// ---------------------------------------------------------------------------
// Global options shape (shared across subcommands)
// ---------------------------------------------------------------------------

interface GlobalOpts {
  config: string;
  format: Format;
  output?: string;
  noCache?: boolean;
  cwd: string;
}

interface DoctorOpts extends GlobalOpts {
  clearCache?: boolean;
  yes?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildLogger(): Logger {
  return {
    info: (_event: string, _ctx?: Record<string, unknown>) => {
      // no-op for info in production; stderr trace would go here
    },
    warn: (event: string, ctx?: Record<string, unknown>) => {
      process.stderr.write(`warn: ${event}${ctx != null ? ' ' + JSON.stringify(ctx) : ''}\n`);
    },
    error: (event: string, ctx?: Record<string, unknown>) => {
      process.stderr.write(`error: ${event}${ctx != null ? ' ' + JSON.stringify(ctx) : ''}\n`);
    },
  };
}

function defaultFormat(): Format {
  return process.stdout.isTTY ? 'text' : 'markdown';
}

function renderOutput(output: Output, format: Format): string {
  switch (format) {
    case 'json':
      return renderJson(output);
    case 'markdown':
      return renderMarkdown(output);
    case 'sarif':
      return renderSarif(output);
    case 'text':
    default:
      return renderText(output);
  }
}

function validateFormat(value: string): Format {
  if (!VALID_FORMATS.includes(value as Format)) {
    throw new Error(
      `Invalid format "${value}". Must be one of: ${VALID_FORMATS.join(', ')}.`,
    );
  }
  return value as Format;
}

async function writeOutput(content: string, outputPath?: string): Promise<void> {
  if (outputPath != null && outputPath !== '') {
    await writeFile(outputPath, content, 'utf-8');
  } else {
    process.stdout.write(content);
  }
}

// ---------------------------------------------------------------------------
// SIGINT / AbortController
// ---------------------------------------------------------------------------

function setupAbortController(): AbortController {
  const controller = new AbortController();
  process.on('SIGINT', () => {
    controller.abort();
    process.stderr.write('aborting...\n');
  });
  return controller;
}

// ---------------------------------------------------------------------------
// check / per-subcommand shared logic
// ---------------------------------------------------------------------------

async function runCheckCommand(
  opts: GlobalOpts,
  skip?: ReadonlySet<SubcommandName>,
): Promise<void> {
  const controller = setupAbortController();
  const logger = buildLogger();
  const cwd = opts.cwd;

  let config: Config;
  try {
    config = await loadConfig({ path: opts.config, cwd });
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`bibcheck: config error: ${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }

  const worldcatApiKey = config.apis.worldcat_key_env != null
    ? (process.env[config.apis.worldcat_key_env] ?? null)
    : null;

  const userAgent = config.apis.crossref_mailto != null
    ? `bibcheck/0.0.0 (mailto:${config.apis.crossref_mailto})`
    : 'bibcheck/0.0.0';

  let deps = await buildCheckDeps({
    config,
    cwd,
    signal: controller.signal,
    logger,
    worldcatApiKey,
    userAgent,
  });

  if (opts.noCache === true) {
    deps = { ...deps, cache: createMemoryCache() };
  }

  if (skip != null) {
    deps = { ...deps, skip };
  }

  const output = await runCheck(deps);

  const format = opts.format ?? defaultFormat();
  const rendered = renderOutput(output, format);
  await writeOutput(rendered, opts.output);

  const reasons = checkExitReasons(output);
  if (reasons.length > 0) {
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// doctor command
// ---------------------------------------------------------------------------

async function runDoctorCommand(opts: DoctorOpts): Promise<void> {
  const controller = setupAbortController();
  const cwd = opts.cwd;

  let config: Config;
  try {
    config = await loadConfig({ path: opts.config, cwd });
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`bibcheck: config error: ${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }

  // Clear-cache confirmation
  if (opts.clearCache === true && opts.yes !== true) {
    const confirmed = await promptYesNo('Clear the cache directory? [y/N] ');
    if (!confirmed) {
      process.exit(0);
    }
  }

  const http = createHttpClient({ userAgent: 'bibcheck/0.0.0' });

  // Doctor module is implemented by T14 concurrently. Import dynamically so
  // that compilation succeeds even if the file is not yet finalised, and fall
  // back gracefully if the module does not export runDoctor.
  let runDoctor: ((deps: unknown) => Promise<{ ok: boolean; checks: Array<{ status: string; name: string; message: string }> }>) | undefined;
  try {
    const doctorMod = await import('./doctor.js') as Record<string, unknown>;
    if (typeof doctorMod['runDoctor'] === 'function') {
      runDoctor = doctorMod['runDoctor'] as typeof runDoctor;
    }
  } catch {
    // doctor.ts not yet available
  }

  if (runDoctor == null) {
    process.stderr.write('bibcheck doctor: doctor module not yet available\n');
    process.exit(1);
  }

  const result = await runDoctor({
    config,
    cwd,
    http,
    signal: controller.signal,
    clearCache: opts.clearCache ?? false,
  });

  for (const check of result.checks) {
    process.stdout.write(`${check.status}  ${check.name}  ${check.message}\n`);
  }

  if (!result.ok) {
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// readline prompt helper
// ---------------------------------------------------------------------------

async function promptYesNo(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

// ---------------------------------------------------------------------------
// addGlobalOptions — attaches the shared flags to any Command
// ---------------------------------------------------------------------------

function addGlobalOptions(cmd: Command): Command {
  return cmd
    .option('--config <path>', 'path to bibcheck.toml', 'bibcheck.toml')
    .option(
      '--format <format>',
      'output format: json, markdown, sarif, text',
      (value: string) => {
        const validated = validateFormat(value);
        return validated;
      },
    )
    .option('--output <path>', 'write output to file instead of stdout')
    .option('--no-cache', 'disable cache (use in-memory cache)')
    .option('--cwd <path>', 'working directory', process.cwd());
}

// ---------------------------------------------------------------------------
// resolveGlobalOpts — extract + validate options from a Command instance
// ---------------------------------------------------------------------------

function resolveGlobalOpts(cmd: Command): GlobalOpts {
  const opts = cmd.opts<{
    config: string;
    format?: string;
    output?: string;
    cache: boolean; // commander flips --no-cache to cache=false
    cwd: string;
  }>();

  const format: Format = opts.format != null
    ? validateFormat(opts.format)
    : defaultFormat();

  return {
    config: opts.config,
    format,
    output: opts.output,
    noCache: opts.cache === false,
    cwd: opts.cwd,
  };
}

// ---------------------------------------------------------------------------
// buildProgram — the testable export
// ---------------------------------------------------------------------------

export function buildProgram(): Command {
  const program = new Command();

  program
    .name('bibcheck')
    .description('Humanities-aware citation verification for CSL-JSON bibliographies.')
    .version('0.0.0', '-V, --version', 'print version and exit');

  // ---- check ----
  const checkCmd = new Command('check')
    .description('Run all checks (existence, canonical, linkage, phrases, worklist). CI build-gate.');
  addGlobalOptions(checkCmd);
  checkCmd.action(async () => {
    const opts = resolveGlobalOpts(checkCmd);
    try {
      await runCheckCommand(opts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`bibcheck error: ${msg}\n`);
      process.exit(1);
    }
  });
  program.addCommand(checkCmd);

  // ---- per-subcommand variants ----
  const subDefs: Array<{ name: SubcommandName; description: string }> = [
    { name: 'canonical', description: 'Run only canonical-edition URL verification.' },
    { name: 'existence', description: 'Run only existence checks against bibliographic databases.' },
    { name: 'linkage',   description: 'Run only citekey linkage check.' },
    { name: 'phrases',   description: 'Run only the phrase-denylist lint.' },
    { name: 'worklist',  description: 'Run only worklist generation.' },
  ];

  for (const sub of subDefs) {
    const subCmd = new Command(sub.name).description(sub.description);
    addGlobalOptions(subCmd);
    // Capture sub.name in closure
    const subName = sub.name;
    subCmd.action(async () => {
      const opts = resolveGlobalOpts(subCmd);
      const skip = new Set(ALL_SUBCOMMANDS.filter((s) => s !== subName)) as ReadonlySet<SubcommandName>;
      try {
        await runCheckCommand(opts, skip);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`bibcheck error: ${msg}\n`);
        process.exit(1);
      }
    });
    program.addCommand(subCmd);
  }

  // ---- doctor ----
  const doctorCmd = new Command('doctor')
    .description('Run onboarding diagnostics to verify configuration and connectivity.');
  addGlobalOptions(doctorCmd);
  doctorCmd
    .option('--clear-cache', 'clear the cache directory before running checks')
    .option('--yes', 'skip the clear-cache confirmation prompt');
  doctorCmd.action(async () => {
    const globalOpts = resolveGlobalOpts(doctorCmd);
    const doctorSpecific = doctorCmd.opts<{ clearCache?: boolean; yes?: boolean }>();
    const opts: DoctorOpts = {
      ...globalOpts,
      clearCache: doctorSpecific.clearCache,
      yes: doctorSpecific.yes,
    };
    try {
      await runDoctorCommand(opts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`bibcheck error: ${msg}\n`);
      process.exit(1);
    }
  });
  program.addCommand(doctorCmd);

  // Default action: show help and exit 1 when no subcommand given
  program.action(() => {
    program.outputHelp();
    process.exit(1);
  });

  return program;
}

// ---------------------------------------------------------------------------
// Binary entry point
// ---------------------------------------------------------------------------

function isMainModule(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(argv1);
  } catch {
    return import.meta.url === `file://${argv1}`;
  }
}

if (isMainModule()) {
  buildProgram().parseAsync(process.argv).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`bibcheck error: ${msg}\n`);
    process.exit(1);
  });
}
