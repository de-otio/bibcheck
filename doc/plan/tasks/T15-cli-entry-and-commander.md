# T15 — CLI entry point and commander setup

**Phase:** 3 (Integration)
**Complexity:** medium
**Depends on:** T13 (check), T14 (doctor), all subcommand modules (T07–T12)
**Blocks:** T16 (integration tests run the built CLI)

## Scope

Replace the placeholder `src/cli.ts` (currently a stub) with a real CLI that dispatches all seven subcommands, parses flags, and renders output.

## Files

- `src/cli.ts` — replaces existing scaffold.
- `test/cli.test.ts` — unit tests; integration tests are T16's responsibility.

## Interfaces

### Imports

- `commander` (new dependency — confirm before adding) or `yargs`. Recommendation: `commander` (smaller, simpler, well-documented).
- All `run*` functions: `runCanonical`, `runPhrases`, `runLinkage`, `runWorklist`, `runExistence`, `runCheck`, `runDoctor`.
- `loadConfig`, `loadDenylist`, `createFsCache`, `createHttpClient`, `buildCheckDeps`.
- All four output renderers: `renderJson`, `renderMarkdown`, `renderSarif`, `renderText`.

### Exports

```ts
export async function main(argv: string[]): Promise<number>;  // returns exit code
```

The bin script at the top of the file:

```ts
#!/usr/bin/env node
import { main } from './cli.js';
main(process.argv.slice(2)).then(code => process.exit(code), err => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
```

Exporting `main` allows `test/cli.test.ts` to invoke the CLI in-process without spawning a child process for unit tests.

## Subcommands and flags

```
bibcheck check                      Run all subcommands; CI build-gate.
  --config <path>                   Path to bibcheck.toml. Default: ./bibcheck.toml.
  --format <json|markdown|sarif|text>  Output format. Default: text for tty, markdown otherwise.
  --output <path>                   Write output to file instead of stdout.
  --no-cache                        Bypass the filesystem cache.
  --skip <subcommand>               Skip a specific subcommand. Repeatable.
  --no-network                      Skip subcommands that require network.
  --offline                         Use ONLY cached responses; cache-miss = unverifiable.
                                    Alias: --cache-only. Recommended for pre-commit hooks.

bibcheck canonical                  Run only canonical-edition URL verification.
  (same flags as check)

bibcheck phrases                    Run only the phrase-denylist lint. No-op when [phrases].file is unset.
  (same flags as check)

bibcheck linkage                    Run only citekey linkage check.
  (same flags as check)

bibcheck worklist                   Run only worklist generation.
  (same flags as check)

bibcheck existence                  Run only existence check.
  (same flags as check)

bibcheck doctor                     Onboarding diagnostic.
  --config <path>                   Same.

bibcheck --version                  Print version.
bibcheck --help                     Print help.
bibcheck <subcommand> --help        Subcommand help.
```

## Implementation notes

- **Default `--format`**: detect TTY via `process.stdout.isTTY`; use `text` if TTY, `markdown` otherwise. This keeps human ad-hoc use readable while making piping into other tools sane.
- **`--no-network`**: implemented as `--skip canonical --skip existence` internally. Easier than threading a network-or-not flag through every subcommand.
- **`--offline` / `--cache-only`**: when set, all subcommands skip outbound network calls and use ONLY cached responses. A cache-miss yields `unverifiable` rather than a hard failure. Recommend this flag in `docs/usage.md` (T19) for pre-commit hooks.
- **AbortController + SIGINT**: on startup, `cli.ts` creates a single `AbortController`. `process.on('SIGINT', () => controller.abort())` is wired before any subcommand runs. The controller's `signal` is passed into `buildCheckDeps`.
- **Node version**: the runtime supports Node 20+ (`engines.node`). Node 24 is required ONLY for the publish workflow (npm Trusted Publishing requires npm 11+, which ships with Node 24+).
- **WorldCat env-var**: T15 reads `process.env[config.apis.worldcat_key_env]` (when configured) and passes the resolved value into `buildCheckDeps` for T05's WorldCat client. T01 (config) itself does not touch `process.env`.
- **Polite-pool User-Agent**: T15 builds the User-Agent string `bibcheck/<package.version> (mailto:<email>)` and passes it into HttpClient via T06's `userAgent` option.
- **Exit codes**:
  - `0`: no findings; or `doctor` all-passed; or `--help` / `--version`.
  - `1`: findings present (CI gate purpose); or `doctor` had failures.
  - `2`: invocation error (bad flag, missing config, etc.).
- **`--config <path>`**: every subcommand needs this; commander supports option inheritance via parent commands.
- **Help text**: each subcommand has a one-line description and a longer description. Keep examples in the longer description.

## Wiring `runCheck` into the CLI

```ts
async function commandCheck(opts: CommandOptions) {
  const config = await loadConfig({ path: opts.config });

  const controller = new AbortController();
  process.on('SIGINT', () => controller.abort());

  const deps = buildCheckDeps({
    config,
    cwd: process.cwd(),
    signal: controller.signal,
    logger,
  });
  const output = await runCheck(deps, { skip: opts.skip });

  const rendered = render(output, opts.format);
  if (opts.output) await writeFile(opts.output, rendered);
  else process.stdout.write(rendered + '\n');

  // Exit-code rule (Wave 0.9): non-zero iff any flagged phrase (not acknowledged),
  // unresolved linkage, problematic canonical status, or metadata-mismatch existence.
  const hasFinding =
    output.phraseFlags.some(f => f.status === 'flagged') ||
    output.linkage.some(l => l.status === 'unresolved') ||
    output.entries.some(e =>
      ['dead-url', 'wrong-host', 'no-url-on-pre-doi-entry', 'live-url-not-archived-snapshot']
        .includes(e.canonical?.status ?? '')
    ) ||
    output.entries.some(e => e.existence?.status === 'metadata-mismatch');
  return hasFinding ? 1 : 0;
}
```

Each per-subcommand command (`bibcheck canonical`, etc.) is a similar shape but invokes only the relevant `run*` function and synthesises a partial `Output` for rendering.

## Acceptance criteria

- [ ] All seven subcommands dispatch correctly.
- [ ] All flags parsed and applied.
- [ ] `--help` and `--version` work.
- [ ] Default `--format` selects based on TTY.
- [ ] Exit codes: 0 / 1 / 2 per the table above.
- [ ] Top-level error handler catches unhandled errors and prints a clean message.
- [ ] Built CLI (`dist/cli.js`) is executable.
- [ ] `bibcheck check --offline` does not make outbound network calls (verified by mocked HttpClient).
- [ ] SIGINT triggers `AbortController.abort()`; in-flight requests cancel; partial results are emitted with structured error indicators.
- [ ] WorldCat env-var name is resolved in T15 (CLI), not in T01 (config).

## Tests

`test/cli.test.ts`:

Use the exported `main(argv)` function for in-process testing. Mock dependencies via the same helpers tests use elsewhere.

- `main(['--help'])` → exit 0, prints help.
- `main(['--version'])` → exit 0, prints version.
- `main(['check', '--config', 'fixtures/.../bibcheck.toml'])` → exit 0 or 1 depending on findings.
- `main(['unknown-command'])` → exit 2.
- `main(['check', '--format', 'json'])` → output is valid JSON.
- `main(['check', '--no-network'])` → existence and canonical skipped.
- Each subcommand dispatches: `main(['canonical'])` runs only canonical.

End-to-end CLI tests via spawned child process are T16's responsibility, not this task.

Coverage target: `src/cli.ts` is **excluded** from the default coverage gate (per testing-strategy.md and T16's vitest config). Coverage of the CLI is exercised instead by T16's integration tests running the built `dist/cli.js`.

## New dependencies to confirm

- `commander@^12` — CLI parsing (pin to major 12).
