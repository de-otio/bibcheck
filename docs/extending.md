# Extending bibcheck

This guide describes how to add new database clients, output formats, and subcommands, and how to manage the trusted-host whitelist.

Contributions are accepted under the project's MIT license (see [LICENSE](../LICENSE)).

---

## Adding a new database client

Database clients live in [`src/databases/`](../src/databases/). Each client is a factory function that returns an object satisfying the `DatabaseClient` interface (defined in [`src/databases/crossref.ts`](../src/databases/crossref.ts)).

### `DatabaseClient` interface

```ts
export interface DatabaseClient {
  readonly name: string;
}
```

In practice, each client extends this with one or more lookup methods. The CrossRef client, for example, exposes:

```ts
export interface CrossRefClient extends DatabaseClient {
  readonly name: 'crossref';
  lookupByDoi(doi: string, signal?: AbortSignal): Promise<DatabaseLookupResult>;
}
```

The `DatabaseLookupResult` shape (also from `crossref.ts`) is the normalized metadata structure all clients return:

```ts
export interface DatabaseLookupResult {
  found: boolean;
  metadata: {
    title?: string;
    authors?: string[];
    issued?: number;   // year
    publisher?: string;
    doi?: string;
    isbn?: string;
    url?: string;
  } | null;
  raw: unknown;        // sanitized raw API response
}
```

### Reference example

[`src/databases/crossref.ts`](../src/databases/crossref.ts) is the reference implementation. Study it before writing a new client. Key patterns to follow:

1. **Factory function:** export a `create<Name>Client(opts)` factory, not a class. Options include `http: HttpClient`, `cache: Cache`, and any credentials.
2. **Cache-first:** check the cache before making a network request. Use a stable cache key (e.g., `crossref:lookupByDoi:<doi.toLowerCase()>`).
3. **Sanitize before caching:** strip the polite-pool email address (or any credential) from the raw response before writing to cache. Use the `sanitizeMailto` helper or write an equivalent.
4. **Pass `signal` through:** every method that makes an HTTP request must accept an `AbortSignal` and pass it to `http.get(...)`.
5. **No module-level I/O:** all dependencies (http, cache) are passed as arguments, not imported globally. This is what makes the client testable with mocks.

### Wiring a new client

After writing the client:

1. Re-export it from [`src/databases/index.ts`](../src/databases/index.ts).
2. Add it to `RunExistenceDeps` in `src/existence.ts` and call its lookup method in `runExistence`.
3. Add the corresponding `ExistenceCheckSource` enum value to `src/schema/output.ts` (this is an additive minor bump to the schema).
4. Write tests in `test/databases/<name>.test.ts` using a mock `HttpClient`.

---

## Adding a new output format

Output renderers live in [`src/output/`](../src/output/). Each renderer is a pure function of shape:

```ts
(output: Output) => string
```

where `Output` is the top-level type from `src/schema/output.ts`.

### Steps

1. Create `src/output/<name>.ts` and export a `render<Name>(output: Output): string` function.
2. The function must not perform I/O. It receives the structured output and returns a string.
3. Register the format in `src/cli.ts`: add the format name to the `Format` union type, the `VALID_FORMATS` array, and the `renderOutput` switch statement.
4. Write tests in `test/output/<name>.test.ts` with a fixture `Output` object.

---

## Trusted-host whitelist

### For project-level additions

If your project needs to add a host to the canonical-edition trusted list (for example, a discipline-specific archive), edit `bibcheck.toml`'s `[trusted_hosts] hosts` array. Note that this array overrides the default list entirely; repeat all default hosts plus your addition.

See [docs/configuration.md](configuration.md#trusted_hosts) for the default list and an example.

### Proposing an addition to the default list

To propose adding a host to the default list (in `src/config.ts`), open a pull request. The criteria are:

- The host serves canonical editions of scholarly or primary-source content (university libraries, scholarly archives, recognized open-access repositories).
- The host is reasonably stable and unlikely to change domain or shut down.
- The host uses HTTPS. HTTP is acceptable only for legacy archive endpoints (such as `classify.oclc.org`) that have not yet migrated.

The default list is intentionally conservative. Proposal PRs should include a description of the host, a link to its about or policy page, and an example URL from a real bibliography entry.

---

## Adding a new subcommand

Subcommand modules follow the `Run<Name>Deps` / `Run<Name>Result` pattern described in the architecture document.

### Pattern

Each subcommand module exports:

```ts
export interface Run<Name>Deps {
  config: Config;
  // ... other injected dependencies
  logger: Logger;
  signal: AbortSignal;
}

export interface Run<Name>Result {
  // ... the piece of Output this subcommand produces
}

export async function run<Name>(deps: Run<Name>Deps): Promise<Run<Name>Result> {
  // implementation
}
```

The `logger` and `signal` fields are required in every `Run*Deps` interface — no exceptions.

### Steps

1. Create `src/<name>.ts` following the pattern above.
2. Add the subcommand to the orchestrator in `src/check.ts`: import `run<Name>`, add its deps to `RunCheckDeps`, and add its result to the assembled `Output`.
3. Add the subcommand to `src/cli.ts`: add it to the `SubcommandName` union and the `subDefs` array.
4. If the subcommand produces a new top-level output field, add the field to `OutputSchema` in `src/schema/output.ts` (coordinate this with a schema version bump).
5. Write tests in `test/<name>.test.ts` using mocked deps.

### Import DAG

The import graph must remain a directed acyclic graph:

```
cli → check → {canonical, existence, linkage, phrases, worklist} → {http, databases/*, markdown/*, phrases/load} → {config, cache} → schema/{output, csl}
```

No subcommand module may import another subcommand module. If two subcommands need shared logic, extract it to a helper module in an appropriate layer.

---

## Contributions

Contributions are accepted under the project's MIT license (see [LICENSE](../LICENSE)).

Before opening a pull request:

- Run `npm run typecheck && npm run build && npx vitest run` and ensure all checks pass.
- Follow the existing module conventions: pure-function modules, dependency injection, no module-level I/O.
- Add tests for new code. The project targets 80% line coverage; new code should not decrease this.
- For schema changes, update [docs/output-schema.md](output-schema.md) to match.
