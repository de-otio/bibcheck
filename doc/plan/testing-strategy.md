# Testing strategy — 80% coverage

Coverage target for v0.1 is **80% line coverage and 80% branch coverage**, enforced by `vitest run --coverage` in CI.

This file documents how that target is hit module-by-module, the fixture conventions, and the integration-test approach.

## Coverage configuration

Configured in `vitest.config.ts` (owned by T16):

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
        'src/cli.ts',                  // entry-point glue, exercised by integration tests
        'src/**/index.ts',             // barrels
        'src/schema/output.ts',        // schema definitions; smoke tests already cover
      ],
    },
  },
});
```

The exclusions are deliberate — barrels and entry-point glue are exercised by integration tests, but their *unit* coverage isn't meaningful.

## Per-module test plan

Every Phase 1 / 2a / 2b module has a paired unit-test file at `test/<modulename>.test.ts`. Tests use vitest. Mock external effects via dependency injection (see [`coding-standards.md`](coding-standards.md) §"Dependency injection").

The acceptance criteria of each task includes specific test scenarios; this file documents the cross-cutting patterns.

### Mocking HTTP

Every test that exercises code making HTTP calls passes a mock `HttpClient`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { lookupDoi } from '../src/databases/crossref.js';
import type { HttpClient } from '../src/http.js';

it('returns metadata when CrossRef finds the DOI', async () => {
  const mockHttp: HttpClient = {
    get: vi.fn().mockResolvedValue({
      status: 200,
      body: { message: { title: ['Example'], author: [/* ... */] } },
    }),
    head: vi.fn(),
  };

  const result = await lookupDoi('10.1000/example', mockHttp);
  expect(result).toEqual({ found: true, /* ... */ });
  expect(mockHttp.get).toHaveBeenCalledWith(expect.stringContaining('crossref.org'));
});
```

Never let a unit test make a real network call. Integration tests can (under conditions documented below).

### Mocking the filesystem cache

```ts
const mockCache = new Map<string, unknown>();
const cache: Cache = {
  get: async (k) => mockCache.get(k) ?? null,
  set: async (k, v) => void mockCache.set(k, v),
  invalidate: async (k) => void mockCache.delete(k),
};
```

### Mocking time

For any code that depends on time (TTL expiry):

```ts
const clock = { now: () => 1700000000000 };
// ... advance manually:
clock.now = () => 1700000000000 + 31 * 24 * 60 * 60 * 1000;
```

### Mocking the file system

For modules that read files (config loader, markdown utilities), use vitest's `vi.mock('node:fs/promises', ...)` or pass a `readFile` callback.

## Fixture conventions

Owned by T16. Lives at `test/fixtures/`.

```
test/fixtures/
├── known-good/
│   ├── sources.json
│   ├── docs/
│   │   └── essay.md
│   └── bibcheck.toml
├── known-bad/
│   ├── sources.json              # has a fake DOI
│   ├── docs/
│   │   └── essay.md              # exercises each subcommand including phrase denylist
│   └── bibcheck.toml
└── minimal/
    ├── sources.json              # empty bibliography
    └── bibcheck.toml
```

Fixtures are realistic enough to exercise interesting code paths without being so large as to slow tests down. The `known-bad/` fixture must trigger at least one finding from each subcommand.

## Integration tests

Owned by T16. Lives at `test/integration/`. These run the CLI end-to-end against the fixtures.

```ts
import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

it('check exits non-zero on the known-bad fixture', async () => {
  const { stdout, stderr, error } = await exec('node', [
    'dist/cli.js', 'check',
    '--config', 'test/fixtures/known-bad/bibcheck.toml',
    '--format', 'json',
  ]).catch(e => ({ stdout: e.stdout, stderr: e.stderr, error: e }));

  expect(error?.code).toBe(1);
  const output = JSON.parse(stdout);
  expect(output.summary.phraseFlags).toBeGreaterThan(0);
});
```

Integration tests run the **built** CLI (`dist/cli.js`), not the TypeScript source — this catches build-time issues that pure unit tests miss.

### Network in integration tests

Integration tests should **not** hit live external APIs by default. The fixtures' `bibcheck.toml` should disable network checks (or use a `--no-network` flag the CLI supports for testing). A separate `npm run test:network` task can run the network-bound integration tests; that target is not part of the default `npm test` and not gated in CI.

## Property-based and snapshot tests

- **Schema round-tripping**: every output renderer (T12) has a property-style test that round-trips a generated `Output` through the renderer and (for JSON) back through the schema. This guarantees the renderers don't drop or invent fields.
- **Snapshot testing for output formats** is acceptable for the Markdown / SARIF / text renderers when output stability matters; pin the snapshot to specific fixture inputs.

## What ≥ 80% means in practice

Per-module rules:

- **Line coverage ≥ 80%**: of all source lines in the module, at least 80% are executed by tests.
- **Branch coverage ≥ 80%**: of all conditional branches, at least 80% have both arms exercised.
- **Function coverage ≥ 80%**: 80% of named functions/methods are called by at least one test.
- **Statement coverage ≥ 80%**: similar to line coverage but counts statements.

vitest's `v8` coverage provider measures all four. The CI gate fails if any falls below 80%.

The 20% headroom is for things genuinely hard to exercise — exotic error paths in network code, race conditions, environment-specific branches. Don't burn time chasing 100%; do hit 80%.

## Modules that should aim higher

A few modules are central to correctness and should aim for ≥ 95% coverage:

- `src/schema/output.ts` — is excluded from the global coverage gate (smoke-tested at the boundary). However, `test/schema.test.ts` MUST enumerate every enum value, every nullable/optional distinction, and numeric-boundary cases. Coverage of the schema in practice is ~95% via these direct tests.
- `src/config.ts` — config validation is a trust boundary.
- `src/phrases/load.ts` — config-trust-boundary loader; bad regex or schema slips here surface as runtime failures during `bibcheck check`.
- `src/canonical.ts` — the differentiated function; getting it wrong negates the tool's value proposition.

## Tests are part of the deliverable

Every task ticket includes test requirements. A task is **not done** until:

1. Its unit tests pass.
2. Its module's coverage is ≥ 80% on all four metrics (line / branch / function / statement).
3. The full test suite (`npm test`) still passes after the task lands.

If you can't hit 80% for a module, raise it as a finding rather than silently dropping the bar.
