# T04 — Phrase denylist loader

**Phase:** 2a (Module utilities)
**Complexity:** small
**Depends on:** T01 (Config), since the project's denylist file path comes from `bibcheck.toml`
**Blocks:** T07 (phrases subcommand)

## Scope

A loader that parses a project-supplied phrase-denylist TOML file, validates it with Zod, and returns the resulting `Pattern[]`.

bibcheck does **not** ship a curated baseline of phrases. The feature is an opt-in lint: a project owner who wants their docs scanned for specific phrases (style-guide deprecations, retracted-source wording, in-house terminology drift) supplies their own denylist via `[phrases] file = "..."` in `bibcheck.toml`.

If `[phrases].file` is unset, the phrases subcommand (T07) emits no findings. There is no built-in content for v0.1.

## Files

- `src/phrases/load.ts` — loader, Zod schema.
- `test/phrases.test.ts` — unit tests (this ticket only covers the loader; the subcommand tests live in T07).

## Interfaces

### Imports

- `zod`
- `smol-toml`
- `re2js` (new dependency — confirm before adding)
- `node:fs/promises`

### Exports

```ts
export const PatternSchema = z.object({
  key: z.string().min(1),
  description: z.string(),
  regex: z.string(),                    // serialized regex pattern; recompiled at runtime
  flags: z.string().optional(),         // default 'i'
  referenceUrl: z.string().url().optional(),  // optional project-supplied doc URL
  notes: z.string().optional(),
});
export type Pattern = z.infer<typeof PatternSchema>;

export const DenylistFileSchema = z.object({
  patterns: z.array(PatternSchema),
});

export interface LoadDenylistOptions {
  /** Path to the project's phrase-denylist TOML file. If null/undefined, returns []. */
  path?: string | null;
}

export async function loadDenylist(opts?: LoadDenylistOptions): Promise<Pattern[]>;
```

`loadDenylist({ path: null })` (or with `path` omitted) returns `[]` — no baseline, no error. `loadDenylist({ path: 'phrases.toml' })` reads and validates the file; a missing file throws a clear error (the user explicitly named a file, so an absent file is a misconfiguration, not the empty-default case).

## TOML schema (for users)

The format a project author writes:

```toml
# phrases.toml
[[patterns]]
key = "deprecated-term-foo"
description = "Use 'bar' instead of 'foo' per the 2026 style guide."
regex = '\bfoo\b'
flags = "i"
referenceUrl = "https://example.org/style-guide#foo"

[[patterns]]
key = "retracted-claim-x"
description = "This wording came from a since-retracted source."
regex = "the once-claimed effect of X on Y"
```

Pattern keys must be unique within the file; duplicates fail validation.

## Implementation notes

- **Patterns are case-insensitive by default** (`flags: 'i'` if the field is omitted). Document this in the schema description so users know to set `flags = ""` if they want case-sensitive matching.
- **Compile patterns lazily**: the loader returns `Pattern[]` with serialized regex strings. Compilation happens at use time in T07.
- **RE2 engine for compiled patterns**: compile with `RE2JS.compile(pattern, flags)`. If the pattern contains backreferences or lookahead (RE2 doesn't support them), `RE2JS.compile` throws — translate to `PhraseLoaderError` with message: `'Pattern <key> is not RE2-safe (no backreferences or lookahead): <reason>'`. RE2 has linear-time guarantees — this is the ReDoS mitigation. Document this in user-facing `extending.md` (T19).
- **Validate regex syntax at load time**: use `RE2JS.compile` for each pattern; surface a clear error referencing the pattern's `key` if compilation fails. This catches bad regex (including ReDoS-prone patterns) before the user runs `bibcheck check`.
- **Prototype-pollution guard**: after `smol-toml.parse()` and before Zod validation, recursively walk the parsed object and throw `PhraseLoaderError` if any node has own keys named `__proto__`, `constructor`, or `prototype`. The phrase-denylist TOML is a less-trusted input source than `bibcheck.toml`; apply the same guard as T01.
- **Duplicate-key detection**: walk the parsed array; if any `key` appears more than once, throw with a message naming the key and offending entries' indices.

## Acceptance criteria

- [ ] `loadDenylist()` with no path returns `[]`.
- [ ] `loadDenylist({ path: null })` returns `[]`.
- [ ] `loadDenylist({ path })` reads, validates, and returns the file's patterns.
- [ ] `loadDenylist({ path: 'missing-file.toml' })` throws a clear error.
- [ ] Schema validation rejects malformed entries (missing `key`, missing `regex`, duplicate keys, bad URL in `referenceUrl`).
- [ ] Regex syntax errors at load time include the offending pattern's `key`.
- [ ] A known-catastrophic pattern (e.g. `(a+)+b`) is either rejected at load time OR runs in bounded time on a 1MB input. Test verifies.
- [ ] Patterns using JS-only regex features (backreferences `\1`, lookahead `(?=...)`) are rejected with `PhraseLoaderError`.
- [ ] Prototype-pollution keys in the denylist TOML are rejected.

## Tests

`test/phrases.test.ts` (loader portion):

- No path → `[]`.
- Null path → `[]`.
- Valid file → patterns returned in order.
- Missing file with explicit path → throws.
- Schema violations: missing `key`, missing `regex`, invalid `referenceUrl`, duplicate `key`.
- Bad regex syntax → throws with the pattern's `key` in the message.

Coverage target: ≥ 80% line + branch for `src/phrases/load.ts`.

## New dependencies to confirm

- `re2js` — pure-JS RE2 engine with linear-time guarantees; used for ReDoS-safe pattern compilation.

Confirm before adding to `package.json` `dependencies`.

## What this ticket does NOT include

- No `baseline.toml`. There is no built-in content.
- No subcommand integration. That lives in T07.
- No project-extension merge logic — the project's file IS the denylist, full stop. Nothing to merge against.
