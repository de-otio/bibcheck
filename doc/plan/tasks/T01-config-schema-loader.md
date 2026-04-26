# T01 — Configuration schema and loader

**Phase:** 1 (Foundation)
**Complexity:** small
**Depends on:** none
**Blocks:** T07 (worklist needs source-type rules), T09 (canonical needs trusted-host whitelist), T11 (worklist), T13 (check), T14 (doctor), T15 (CLI)

## Scope

Define the Zod schema for `bibcheck.toml`, implement a loader with sensible defaults, and expose typed access to configuration throughout the codebase.

The configuration is a trust boundary — every consumer in bibcheck reads typed `Config` objects, not raw TOML. Validation lives here.

## Files

- `src/config.ts` — schema, loader, defaults.
- `test/config.test.ts` — unit tests.

## Interfaces

### Imports

- `zod` (already a dependency)
- `smol-toml` (new dependency — confirm before adding to `package.json`)
- `node:fs/promises` for reading the file

### Exports

```ts
export const ConfigSchema: z.ZodType<...>;
export type Config = z.infer<typeof ConfigSchema>;

export interface LoadConfigOptions {
  path?: string;            // default: ./bibcheck.toml
  cwd?: string;             // default: process.cwd()
}

export async function loadConfig(opts?: LoadConfigOptions): Promise<Config>;
```

`loadConfig` returns defaults if the file doesn't exist; throws `ConfigError` (subclass of `Error`) on invalid TOML or schema-validation failure.

## Configuration grammar

Match the design in `doc/source-verifier/reference-librarian/bibcheck-interface.md` (this file is in Mündig's source-verifier folder; the relevant grammar is reproduced in [`../architecture.md`](../architecture.md) §"Configuration schema"). Sections:

- `[bibliography]`
  - `file: string` — default `"docs/sources.json"`
- `[docs]`
  - `include: string[]` — default `["docs/**/*.md"]`
  - `exclude: string[]` — default `[]`
- `[trusted_hosts]`
  - `hosts: string[]` — default: `["hathitrust.org", "archive.org", "oll.libertyfund.org", "plato.stanford.edu", "philpapers.org", "loc.gov", "dnb.de", "bnf.fr"]`
- `[phrases]`
  - `file: string | null` — default `null`. Path to a project-supplied phrase-denylist TOML. When `null`, the phrases subcommand is a no-op.
- `[source_types]`
  - keyed by source-type name; value is `{ warn_load_bearing?: boolean, allow_load_bearing?: boolean }`
- `[edition_discipline]`
  - keyed by author surname (lowercase); value is a string identifying the canonical edition (e.g., `"akademie-ausgabe"`, `"glasgow"`, `"clarendon"`, `"toronto-cw"`)
- `[apis]`
  - `crossref_mailto: string | null`
  - `openalex_mailto: string | null`
  - `worldcat_key_env: string | null`
- `[cache]`
  - `dir: string` — default `.bibcheck-cache` (project-relative)
  - `max_size_mb: number | null` — default `256`; `null` means unlimited

All sections optional; missing sections fall back to documented defaults.

## Implementation notes

- The `Config` type should be deeply readonly where practical (`z.object(...).readonly()` or post-process to `DeepReadonly`).
- Validation errors should include the field path: `bibliography.file: Expected string, received number` style.
- For the default-when-missing-file case, return a `Config` populated with defaults; do **not** synthesise a mock TOML file.
- TOML parsing via `smol-toml` produces a `Record<string, unknown>` which is then handed to `ConfigSchema.parse`; the Zod schema is the validation layer.
- **Prototype-pollution guard** — after `smol-toml.parse()` and before `ConfigSchema.parse()`, recursively walk the parsed object and throw `ConfigError` if any node has own keys named `__proto__`, `constructor`, or `prototype`. Phrase-denylist loader (T04) does the same on its TOML.
- **Default cache directory** — `.bibcheck-cache/` (project-relative). Override via `--cache-dir` CLI flag (T15). The directory should be added to a `.gitignore` snippet in `docs/usage.md` (T19).
- **WorldCat key-env-var resolution** — T01 declares `[apis] worldcat_key_env: string | null` (env-var name). T15 (CLI wiring) reads `process.env[name]` to obtain the actual key; T01 itself does NOT read env vars.

## Acceptance criteria

- [ ] `ConfigSchema` exported and matches the grammar above.
- [ ] `Config` type exported via `z.infer`.
- [ ] `loadConfig()` returns defaults when no file exists.
- [ ] `loadConfig()` returns a typed `Config` for valid TOML.
- [ ] `loadConfig()` throws `ConfigError` with field-path messages on invalid TOML or schema violations.
- [ ] All defaults match the grammar exactly.
- [ ] No I/O at module top-level; loading happens only when `loadConfig` is called.
- [ ] Prototype-pollution guard rejects TOML with `__proto__` keys at any depth (test verifies).

## Tests

`test/config.test.ts`:

- Default config returned when `bibcheck.toml` is absent.
- Empty TOML file parses to defaults.
- Full valid TOML parses to expected `Config` shape.
- Missing required-but-defaulted fields fall back to defaults.
- Invalid TOML syntax throws with a `ConfigError` mentioning the line.
- Type mismatches (e.g., `hosts = "not-an-array"`) throw with a `ConfigError` mentioning the field path.
- `[trusted_hosts]` with a custom list overrides defaults entirely (does not merge with default list — document this).
- `[phrases.file = "missing-file.toml"]` does **not** trigger an error here; that's enforced at use time (T04).

Coverage target: ≥ 80% line + branch for `src/config.ts`.

## New dependencies to confirm

- `smol-toml@^1 (pinned)` — small, modern TOML parser. Add to `package.json` `dependencies` (not `devDependencies`).
