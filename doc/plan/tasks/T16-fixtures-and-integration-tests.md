# T16 — Test fixtures and integration tests

**Phase:** 4 (Quality + release)
**Complexity:** medium
**Depends on:** T13 (check), T15 (CLI), and ideally all subcommand modules
**Blocks:** T17 (CI runs the integration tests)

## Scope

Create realistic test fixtures and integration tests that run the **built CLI** end-to-end. Also configure vitest with coverage thresholds.

This task validates the system works as a system, beyond what unit tests catch.

## Files

- `vitest.config.ts` — vitest configuration with coverage thresholds and includes/excludes.
- `test/fixtures/known-good/sources.json` — small but realistic CSL JSON (5–10 entries, mix of DOI / ISBN / pre-DOI URL).
- `test/fixtures/known-good/docs/essay.md` — markdown referencing the bibliography correctly, no findings.
- `test/fixtures/known-good/bibcheck.toml` — config with sensible settings.
- `test/fixtures/known-good/phrases.toml` — small project-supplied denylist (2–3 patterns) referenced by the known-good config; the fixture prose does not match any of them.
- `test/fixtures/known-bad/sources.json` — CSL JSON with deliberate problems: a fake DOI, an ISBN that doesn't resolve, a pre-DOI entry with a dead URL, a pre-DOI entry on an untrusted host.
- `test/fixtures/known-bad/docs/essay.md` — markdown with: an unresolved citekey, a phrase that matches the fixture's denylist (no acknowledgement), a direct quotation, a paraphrase with page ref.
- `test/fixtures/known-bad/phrases.toml` — denylist with at least one pattern that matches the known-bad essay.
- `test/fixtures/known-bad/bibcheck.toml`.
- `test/fixtures/minimal/sources.json` — empty array.
- `test/fixtures/minimal/bibcheck.toml`.
- `test/integration/check.test.ts` — integration tests running the built CLI.
- `test/integration/cli.test.ts` — integration tests for individual subcommands and flags.
- `test/integration/no-config.test.ts` — bibcheck behaviour in a project with no `bibcheck.toml`.

## Vitest configuration

T16 owns `vitest.config.ts` (created in Wave 1B.3). Thresholds match testing-strategy.md: lines/branches/functions/statements at 80. Exclusions: `src/cli.ts`, `src/**/index.ts`, `src/schema/output.ts`. Note that `src/cli.ts` is excluded because its coverage is exercised by integration tests running the built `dist/cli.js`, not by unit tests.

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      lines: 80,
      branches: 80,
      functions: 80,
      statements: 80,
      include: ['src/**/*.ts'],
      exclude: [
        'src/cli.ts',
        'src/**/index.ts',
        'src/schema/output.ts',
      ],
      thresholdAutoUpdate: false,
    },
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,        // integration tests can be slow
  },
});
```

## Fixtures content

### known-good/sources.json (sketch)

```json
[
  {
    "id": "habermas1962",
    "type": "book",
    "title": "Strukturwandel der Öffentlichkeit",
    "author": [{ "family": "Habermas", "given": "Jürgen" }],
    "issued": { "date-parts": [[1962]] },
    "URL": "https://archive.org/details/strukturwandel"
  },
  {
    "id": "fraser1990",
    "type": "article-journal",
    "title": "Rethinking the Public Sphere",
    "author": [{ "family": "Fraser", "given": "Nancy" }],
    "container-title": "Social Text",
    "issued": { "date-parts": [[1990]] },
    "DOI": "10.2307/466240"
  },
  /* ... add ISBN entries, OLL entries, etc. ... */
]
```

The DOI must be a real, resolvable DOI for the integration tests against CrossRef to pass — or, alternatively, mock the network at the integration test level.

### known-bad/phrases.toml (sketch)

```toml
[[patterns]]
key = "deprecated-term-foo"
description = "Test fixture: matches 'deprecated-term-foo' to exercise the phrases subcommand."
regex = "deprecated-term-foo"
```

### known-bad/docs/essay.md (sketch)

```markdown
# Essay

This sentence contains the deprecated-term-foo without an acknowledgement.

Some prose citing Habermas [@habermas1962, p. 47].

A quote from Mill: "the only purpose for which power can be rightfully
exercised over a member of a civilised community" [@mill1859onliberty].

A reference to a non-existent entry [@nonsense2099].
```

Each finding category is exercised at least once.

## Integration test approach

Tests use `node:child_process` to invoke the built CLI:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const exec = promisify(execFile);
const cliPath = path.resolve('dist/cli.js');

beforeAll(async () => {
  // Ensure the build is current
  await exec('npm', ['run', 'build']);
});

describe('bibcheck check (integration)', () => {
  it('exits 0 on the known-good fixture', async () => {
    const { stdout } = await exec('node', [
      cliPath, 'check',
      '--config', 'test/fixtures/known-good/bibcheck.toml',
      '--format', 'json',
    ]);
    const output = JSON.parse(stdout);
    expect(output.summary.phraseFlags).toBe(0);
  });

  it('exits 1 on the known-bad fixture and reports each finding category', async () => {
    let result;
    try {
      result = await exec('node', [
        cliPath, 'check',
        '--config', 'test/fixtures/known-bad/bibcheck.toml',
        '--format', 'json',
        '--no-network',     // for deterministic CI
      ]);
    } catch (e: any) {
      result = { stdout: e.stdout, code: e.code };
    }
    expect(result.code).toBe(1);
    const output = JSON.parse(result.stdout);
    expect(output.summary.phraseFlags).toBeGreaterThan(0);
    expect(output.linkage.some(l => l.status === 'unresolved')).toBe(true);
    expect(output.summary.canonicalIssues).toBeGreaterThan(0);
  });
});
```

`--no-network` makes the test deterministic in CI; a separate `npm run test:network` task can run the network-bound case manually.

## Acceptance criteria

- [ ] vitest.config.ts with 80% coverage threshold (lines, branches, functions, statements).
- [ ] `npm test` runs unit + integration tests.
- [ ] `known-good`, `known-bad`, `minimal` fixtures complete.
- [ ] At least one integration test per subcommand.
- [ ] Integration tests pass against the **built** dist/cli.js, not source.
- [ ] Coverage report generated; below-threshold runs fail.
- [ ] Tests run in < 30 seconds locally without network (`--no-network`).
- [ ] SARIF validation: T16's integration tests validate SARIF output against the official SARIF 2.1.0 schema using `ajv`.

## Tests

This task IS tests. The tests in `test/integration/` are the deliverable.

The fixtures themselves are also a deliverable — they should be realistic enough that an agent reading them can understand what bibcheck does without reading the docs.

Coverage target: this task's own deliverables don't have a coverage target; they enforce the project-wide coverage targets.

## Implementation notes

- **`@vitest/coverage-v8`**: add to `devDependencies` (Wave 1B.2 owns this addition).
- **Network-bound tests**: `npm run test:network` runs the network-bound integration tests (real CrossRef + OpenAlex + OpenLibrary calls). The default `npm test` skips these. CI does not run them.

## New dependencies

None.
