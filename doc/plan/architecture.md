# Architecture

The v0.1 module structure of bibcheck. Each module has a single, narrow responsibility; the boundaries are designed so that tasks can be worked in parallel.

## Module tree

```
src/
├── cli.ts                       # Commander entry; subcommand dispatch (T15)
├── index.ts                     # Library entry; re-exports schema
├── check.ts                     # bibcheck check orchestrator (T13)
├── doctor.ts                    # bibcheck doctor diagnostic (T14)
├── canonical.ts                 # bibcheck canonical subcommand (T09)
├── existence.ts                 # bibcheck existence subcommand (T08)
├── linkage.ts                   # bibcheck linkage subcommand (T10)
├── phrases.ts                   # bibcheck phrases subcommand (T07)
├── worklist.ts                  # bibcheck worklist subcommand (T11)
├── config.ts                    # bibcheck.toml loader + zod schema (T01)
├── http.ts                      # HEAD / redirect-chain utility (T06)
├── schema/
│   ├── output.ts                # output JSON schema (already scaffolded)
│   └── csl.ts                   # minimal CslJsonEntrySchema for input-bibliography validation (T01-adjacent)
├── databases/
│   ├── index.ts                 # barrel
│   ├── crossref.ts              # CrossRef DOI lookup (T05)
│   ├── openalex.ts              # OpenAlex title/author search (T05)
│   ├── openlibrary.ts           # OpenLibrary ISBN lookup (T05)
│   └── worldcat.ts              # WorldCat ISBN lookup, key-gated (T05)
├── markdown/
│   ├── citekeys.ts              # extract @citekey refs with file:line (T03)
│   ├── blocks.ts                # extract blockquotes / direct quotes (T03)
│   └── glob.ts                  # file discovery with include/exclude (T03)
├── phrases/
│   └── load.ts                  # parse + validate project-supplied phrase denylist (T04)
├── output/
│   ├── json.ts                  # JSON renderer (T12)
│   ├── markdown.ts              # human-readable Markdown (T12)
│   ├── sarif.ts                 # SARIF for CI / PR annotation (T12)
│   └── text.ts                  # compact CLI-friendly text (T12)
└── cache/
    └── fs-cache.ts              # filesystem TTL cache for API responses (T02)
```

## Public-interface conventions

Every module exports one of two patterns:

### Pure-function modules

Stateless, no I/O at module top-level, all dependencies passed as arguments. Used for: schema, phrase denylist loader, output renderers, markdown helpers, config validation.

```ts
export function loadDenylist(opts: LoadDenylistOptions): Promise<Pattern[]> { ... }
export function renderJson(output: Output): string { ... }
```

### Subcommand modules

Each subcommand exports a `run<Name>(deps)` function that returns a piece of the output:

```ts
export interface RunCanonicalDeps {
  config: Config;
  bibliography: CslJsonEntry[];
  http: HttpClient;          // injected; allows mocking in tests
  cache: Cache;              // injected; allows in-memory mock
}

export interface RunCanonicalResult {
  entries: Pick<Entry, 'citekey' | 'canonical'>[];
}

export async function runCanonical(deps: RunCanonicalDeps): Promise<RunCanonicalResult> { ... }
```

The orchestrator (`check.ts`) composes these and assembles the top-level `Output`.

## Cross-cutting interfaces

### Logger

Every subcommand and utility module receives a `Logger` via its `Run*Deps` interface. No module may call `console.log` directly.

```ts
export interface Logger {
  info(event: string, context?: Record<string, unknown>): void;
  warn(event: string, context?: Record<string, unknown>): void;
  error(event: string, context?: Record<string, unknown>): void;
}
```

Every `Run*Deps` interface MUST include `logger: Logger` — no exceptions. The CLI wires a real structured-output logger; tests wire a `vi.fn()`-backed stub.

## Error class taxonomy

Subclasses of `Error` used across the codebase. Each is thrown in one specific layer so that `cli.ts` can catch, format, and exit with the right code.

| Class | Thrown by | Superclass |
|---|---|---|
| `ConfigError` | `src/config.ts` (T01) — malformed or missing `bibcheck.toml` | `Error` |
| `BibliographyParseError` | CSL JSON loader (T01-adjacent, `src/schema/csl.ts`) — input file fails schema | `Error` |
| `HttpError` | `src/http.ts` (T06) — non-2xx/3xx responses or network-level failures | `Error` |
| `CacheError` | `src/cache/fs-cache.ts` (T02) — unreadable/unwritable cache directory | `Error` |
| `PhraseLoaderError` | `src/phrases/load.ts` (T04) — bad regex pattern or invalid TOML structure | `Error` |

Each class carries structured metadata (`cause`, `path`, `statusCode`, etc.) so the CLI top-level handler can render a user-friendly message.

## AbortSignal plumbing

`cli.ts` creates one `AbortController` for the lifetime of the command:

```ts
const controller = new AbortController();
process.on('SIGINT', () => controller.abort());
```

`controller.signal` is threaded into `RunCheckDeps.signal` (and every other `Run*Deps.signal`) as a **required** field — not optional:

```ts
export interface RunCheckDeps {
  // ...
  signal: AbortSignal;   // REQUIRED; no default; no '?'
}
```

Inside `src/http.ts`, per-request timeouts are composed with the user signal so that either can cancel the fetch:

```ts
const combined = AbortSignal.any([userSignal, AbortSignal.timeout(timeoutMs)]);
// AbortSignal.any() is available in Node 20.3+
```

Every `Run*Deps` interface MUST include `signal: AbortSignal`. The goal is that `Ctrl-C` during a long check run terminates in-flight HTTP requests cleanly rather than hanging until the OS kills the process.

## Dependency injection

External dependencies (HTTP, cache, file I/O, time) are **always passed as arguments**, never imported and used directly inside subcommand or database modules. This is what makes 80% test coverage achievable — every module can be tested with mocked dependencies.

Concretely:

- `HttpClient` interface in `src/http.ts` — modules import the **type**, not a concrete instance. The CLI wires a real `fetch`-backed implementation; tests wire a mock.
- `Cache` interface in `src/cache/fs-cache.ts` — same shape. Real impl uses filesystem; tests use an in-memory `Map`.
- `Clock` interface (for TTL) in `src/cache/fs-cache.ts` — real impl uses `Date.now()`; tests use a controllable clock.
- File I/O — passed as `readFile`/`writeFile` callbacks where it matters; or use vitest's filesystem mocks.

## Import DAG (no cycles)

The import graph must remain a directed acyclic graph. The sketch below shows allowed dependency directions:

```
cli → check → {canonical, existence, linkage, phrases, worklist} → {http, databases/*, markdown/*, phrases/load} → {config, cache} → schema/{output, csl}
```

Additional rules:

- `output/` renderers consume `schema/` only — they are leaves in the DAG.
- `check.ts` (T13) is the **only** module that imports all subcommand modules. No subcommand module imports another.
- `cli.ts` imports `check.ts`, `doctor.ts`, and `output/` renderers; it does not import subcommand modules directly.

If a proposed import would create a cycle, stop and surface it — the design has a structural problem.

## Data flow

```
                    ┌────────────────┐
                    │  bibcheck.toml │
                    └───────┬────────┘
                            │
                            ▼
                    ┌────────────────┐
                    │   loadConfig   │── T01
                    └───────┬────────┘
                            │ Config
              ┌─────────────┴────────────┬───────────────────┐
              ▼                          ▼                   ▼
    ┌──────────────────┐     ┌───────────────────┐   ┌──────────────┐
    │   sources.json   │     │  docs/**/*.md     │   │  phrases/    │
    └─────────┬────────┘     └─────────┬─────────┘   └───────┬──────┘
              │                        │                     │
              │  CslJsonEntry[]        │ md text + citekeys  │ Pattern[]
              │                        │                     │
              ▼                        ▼                     ▼
       ┌──────────────────────────────────────────────────────┐
       │              subcommand modules                       │
       │                                                       │
       │   canonical    existence    linkage    phrases        │
       │     │             │            │             │        │
       │     │             │            │             │        │
       │     ▼             ▼            ▼             ▼        │
       │   {canonical}  {existence}  {linkage}  {phraseFlags}  │
       └──────────────────────────────────────────────────────┘
                              │ aggregate
                              ▼
                       ┌────────────┐
                       │   check    │── T13
                       └─────┬──────┘
                             │ Output
                             ▼
                       ┌────────────┐
                       │  output/   │── T12
                       │  json|md|  │
                       │  sarif|text│
                       └─────┬──────┘
                             │ string
                             ▼
                          stdout
```

The subcommand modules are independent leaves; only `check.ts` knows about all of them. This is what makes Phase 2b parallelisable.

## Output schema (already done)

The output JSON schema is the contract every output renderer and every consumer (the `reference-librarian` agent, CI tooling, editor extensions) reads. It is defined in [`src/schema/output.ts`](../../src/schema/output.ts) using Zod, with TypeScript types derived via `z.infer`.

Key design points:

- `SCHEMA_VERSION` constant at `'0.1.0'`. Bump rules documented in the file.
- Per-policy-layer breakdown: `existence` (Layer 1 commodity), `canonical` (Layer 1 differentiated), `linkage` (Layer 1 structural), `phraseFlags` (project-supplied lint), `worklist` (Layer 2 / 3).
- All status fields are literal-union enums.
- Every Zod schema has a paired TypeScript type with the same name minus `Schema` suffix.
- The published JSON Schema in `docs/output-schema.md` (T19) is generated from these Zod definitions, not hand-maintained.

Tasks do **not** modify `src/schema/output.ts` unless a fundamental design issue is found. If a change is needed, surface it as a question before editing — the schema is the contract every other module reads.

## Configuration schema

Defined in `src/config.ts` (T01), validates `bibcheck.toml`. Sections:

- `[bibliography]` — `file` path to CSL JSON.
- `[docs]` — `include` / `exclude` glob lists.
- `[trusted_hosts]` — `hosts` array; trusted-canonical-edition whitelist.
- `[phrases]` — `file` path to a project-supplied phrase-denylist TOML file. Optional; when unset, the phrases subcommand is a no-op.
- `[source_types]` — per-source-type weighting (warn-on-load-bearing rules).
- `[edition_discipline]` — author-to-canonical-edition mapping.
- `[apis]` — polite-pool email addresses, API key env-var names.

Defaults are sensible enough that bibcheck works in a project with no `bibcheck.toml` at all (just a `sources.json` and some markdown).

## What gets written where

| Target file or path | Owning task |
|---|---|
| `src/cli.ts` | T15 (replaces existing scaffold) |
| `src/check.ts` | T13 |
| `src/doctor.ts` | T14 |
| `src/canonical.ts` | T09 |
| `src/existence.ts` | T08 |
| `src/linkage.ts` | T10 |
| `src/phrases.ts` | T07 |
| `src/worklist.ts` | T11 |
| `src/config.ts` | T01 |
| `src/http.ts` | T06 |
| `src/schema/output.ts` | already scaffolded; **do not modify** |
| `src/databases/*.ts` | T05 |
| `src/markdown/*.ts` | T03 |
| `src/phrases/*` | T04 |
| `src/output/*.ts` | T12 |
| `src/cache/fs-cache.ts` | T02 |
| `test/fixtures/**` | T16 |
| `test/integration/**` | T16 |
| `test/<modulename>.test.ts` | owning task of that module |
| `vitest.config.ts` | T16 |
| `.github/workflows/ci.yml` | T17 |
| `.github/workflows/release.yml` | T18 |
| `docs/usage.md`, `configuration.md`, `output-schema.md`, `extending.md` | T19 |
| `package.json` (deps additions) | task that needs the dep, with confirmation |

If your task requires editing a file owned by another task — stop and ask. Do not silently touch shared files.
