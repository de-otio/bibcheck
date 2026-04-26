# Coding standards

Conventions every task implementation should follow. These are short and load-bearing — read once, apply throughout.

## TypeScript

- **`strict: true`** is enabled in `tsconfig.json`, plus `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `noPropertyAccessFromIndexSignature`. Don't disable any of these.
- **Never use `any`.** Use `unknown` and narrow. If you find yourself reaching for `any`, the design needs adjustment — surface the issue.
- **Prefer `type` over `interface`** for data shapes. Use `interface` for extensible behaviour contracts (e.g., `HttpClient`).
- **Module imports use `.js` extensions** on relative paths (ESM requirement under `moduleResolution: NodeNext`):
  ```ts
  import { OutputSchema } from './schema/output.js';   // ✓
  import { OutputSchema } from './schema/output';      // ✗ fails at runtime
  ```
- **Named exports only.** No default exports. Default exports break tree-shaking and make refactoring noisier.
- **One module = one responsibility.** If a file is doing two unrelated things, split it.

## Type-only imports

With `verbatimModuleSyntax + isolatedModules` enabled, every cross-module import of a type-only symbol MUST use `import type { ... }` syntax. Mixing types and values in one `import` statement requires the inline `type` keyword on each type-only member:

Correct:
```ts
import type { HttpClient } from './http.js';
import { createClient } from './http.js';
```

Also correct (mixed import with inline type keyword):
```ts
import { type HttpClient, createClient } from './http.js';
```

Incorrect (will fail to compile when `HttpClient` is a type-only export):
```ts
import { HttpClient, createClient } from './http.js';
```

The compiler will reject incorrect forms under `verbatimModuleSyntax`. Do not suppress the error — fix the import.

## Schemas and types

- **Zod is the source of truth.** Where a value crosses a trust boundary (config file, network response, JSON input), validate with Zod and derive the TS type via `z.infer<typeof Schema>`.
- **Naming convention**: `FooSchema` for the Zod schema, `Foo` for the inferred type. The output schema in `src/schema/output.ts` is the canonical example.

```ts
export const ConfigSchema = z.object({ /* ... */ });
export type Config = z.infer<typeof ConfigSchema>;
```

- **Don't re-validate on hot paths.** Validate at boundaries (config load, API response, JSON input); pass typed values internally.

## Error handling

- **Don't throw on expected outcomes.** "Not found" / "metadata mismatch" / "dead URL" are *expected* outcomes of bibcheck — they are findings, not exceptions. Return them as part of the result.
- **Throw for genuinely exceptional conditions:** filesystem errors, malformed input, network failures that aren't 4xx. Throw `Error` subclasses with informative messages.
- **CLI catches all unhandled errors** at the top level (`cli.ts`) and prints a useful message before exiting with a non-zero code. No raw stack traces leak to users on expected failures.
- **Use Result-shaped types where ambiguity matters:**
  ```ts
  type ApiResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };
  ```
  Don't litter the codebase with `Result` though — use it where the alternative is "throw or return undefined."

## Async

- **No top-level `await`** in modules. CLI bootstrap is fine; library modules should expose async functions, not execute them at import time.
- **Bound concurrency** for batch operations against external APIs. Use `p-queue` or a hand-rolled limiter; don't burst-rate-limit a single backend.
- **Always pass an `AbortSignal`** to long-running async functions (HTTP calls, anything that loops). The CLI wires up a `Ctrl-C` handler that aborts in-flight work cleanly.

## Logging

- **No `console.log` in library code.** Use a small `Logger` interface passed in via dependency injection (test-friendly).
- **`console.error` is fine in `cli.ts`** for user-facing messages.
- **No emojis or decoration** in log output unless explicitly asked. Plain, parseable, grep-able.
- **Structured > unstructured.** A log line should encode `level`, `event`, and relevant context as keys.

## Dependency injection (load-bearing)

External effects — HTTP, filesystem, time, environment — are **always passed as arguments**, not imported and used directly inside subcommand or database modules. This is what makes 80% test coverage achievable.

```ts
// ✗ BAD — uses fetch directly; can't be mocked in tests
export async function lookupDoi(doi: string) {
  return await fetch(`https://api.crossref.org/works/${doi}`);
}

// ✓ GOOD — accepts an HttpClient; tests inject a mock
export async function lookupDoi(doi: string, http: HttpClient) {
  return await http.get(`https://api.crossref.org/works/${doi}`);
}
```

The CLI entry point (T15) is the only place that wires real implementations. Everything else accepts dependencies.

## Module hygiene

- **No circular imports.** If you find yourself adding one, the design has a bug.
- **No barrel files in `src/` except `databases/index.ts`** (which re-exports the four database clients for convenience). Resist the temptation to add an `index.ts` in every folder.
- **No global mutable state.** Caches and config live as values passed through, not as module-level mutables.

## Comments

- **Default to no comments.** Names and types should carry the meaning. A comment is needed only when the *why* is non-obvious — a workaround, a hidden constraint, an invariant.
- **No "what" comments**: don't restate the code. `// fetch the DOI` above `await fetch(doi)` is noise.
- **Multi-line block comments are fine for module-top-of-file documentation** (one short paragraph stating purpose).
- **No emojis in code or comments.**

## Style automation

- The repo will not currently run a formatter or linter automatically. Tasks that produce TypeScript should be consistent with surrounding code — 2-space indent, semicolons, single quotes, trailing commas in multi-line literals.
- A future task may add `biome` or `eslint + prettier`; that's out of scope for v0.1.

## Coverage exemptions

Branches that exist solely because `noUncheckedIndexedAccess` forces a defensive check on an index that cannot be undefined in well-formed input may be excluded from branch coverage with `/* c8 ignore next */`:

```ts
const first = items[0]; // noUncheckedIndexedAccess makes this T | undefined
if (first === undefined) throw new Error('unreachable: items array is guaranteed non-empty here');
//                                       ^ required justification comment
/* c8 ignore next */
```

Rules:

- The `/* c8 ignore next */` comment MUST be accompanied by a one-line justification explaining why the branch is unreachable in well-formed input.
- Do NOT use `c8 ignore` to hide real defensive paths that handle expected runtime conditions — those must be tested.
- If you are tempted to exempt a branch that is NOT `noUncheckedIndexedAccess`-driven, surface it for review rather than silently ignoring it.

## Tests live next to the rules they enforce

- Test placement: `test/<modulename>.test.ts` for unit tests; `test/integration/*.test.ts` for end-to-end.
- See [`testing-strategy.md`](testing-strategy.md) for coverage rules and fixture conventions.
- Every task's acceptance criteria includes "tests at ≥ 80% coverage for the module's lines and branches." Don't merge a task that fails its own coverage gate.
