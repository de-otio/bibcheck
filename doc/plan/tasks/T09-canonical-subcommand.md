# T09 — `bibcheck canonical` subcommand

**Phase:** 2b (Subcommand modules)
**Complexity:** medium
**Depends on:** T06 (HTTP utility), T01 (config — for trusted-host whitelist)
**Blocks:** T13 (check orchestrator), T15 (CLI)

## Scope

Implement the `canonical` subcommand: for each bibliography entry that lacks a DOI or ISBN — the pre-DOI primary-source case — verify that the entry's `URL` field points to a trusted canonical-edition host and that the URL is live.

This is **the most distinctive function in bibcheck**. No other surveyed tool implements a humanities-canonical-edition-aware URL verifier. Get this right.

## Files

- `src/canonical.ts` — `runCanonical` function.
- `test/canonical.test.ts` — unit tests.

## Interfaces

### Imports

- `./http.js` — `headCheck`, `isHostAllowed`, `HttpClient` from T06.
- `./schema/output.js` — `CanonicalLayer`, `CanonicalStatus`.
- `./config.js` — `Config` (for `trusted_hosts.hosts`).

### Exports

```ts
export interface RunCanonicalDeps {
  config: Config;
  bibliography: CslEntry[];
  http: HttpClient;
  cache?: Cache;
}

export interface RunCanonicalResult {
  entries: Array<{
    citekey: string;
    canonical: CanonicalLayer;
  }>;
}

export async function runCanonical(deps: RunCanonicalDeps): Promise<RunCanonicalResult>;
```

## Algorithm

For each bibliography entry:

1. **Applicability check**: if the entry has a DOI or ISBN, status is `not-applicable` — skip URL verification. The existence subcommand (T08) handles those entries.

2. **No-URL case**: if the entry lacks both DOI/ISBN AND has no `URL` field, status is `no-url-on-pre-doi-entry`. This is a finding — the entry is unverifiable without a URL.

3. **URL liveness**: call `headCheck(entry.URL, { http, cache, trustedHosts: config.trusted_hosts.hosts })`.
   - Result `{ ok: true, status, finalUrl, redirectChain, host }` → continue to host check.
   - Result `{ ok: false, reason: 'dead-url' }` → status `dead-url`.
   - Result `{ ok: false, reason: 'wrong-host' }` → status `wrong-host`.
   - Result `{ ok: false, reason: 'too-many-redirects' / 'timeout' / 'network-error' }` → status `dead-url` with a note in the redirect chain field.

4. **SEP archived-snapshot rule**: if `host` is `plato.stanford.edu`, the URL must contain `/archives/<date>/...`. The canonical citation form for SEP entries is the archived snapshot, not the live URL (since SEP entries are revised over time). If the URL is `plato.stanford.edu/entries/<entry>/` (live), status is `live-url-not-archived-snapshot`.

5. **Edition-discipline check** (optional, gated on `config.edition_discipline`): if the entry's `note:` field signals a canonical edition (e.g., `Ak. V` for Kant Akademie-Ausgabe; `Glasgow WN` for Smith Glasgow Edition; `CW Mill` for Mill Toronto Collected Works), confirm the URL host is appropriate for that edition. If the entry's `note:` mentions a canonical edition and the URL host doesn't match the expected canonical-edition host, surface as `wrong-host` with a note in the redirect chain field. v0.1 covers Kant Akademie, Smith Glasgow, and Mill Toronto-CW; other edition mappings are stretch. This is a v0.1 stretch — basic implementation is acceptable; full author-to-host mapping can be deferred. If implemented, document the mapping in `config.edition_discipline` per the configuration grammar.

6. All other cases: status `verified-canonical`.

## Implementation notes

- **SSRF mitigation**: redirect-chain SSRF mitigation lives in T06; T09 inherits it. Trust T06's `headCheck` to reject redirects to private IP ranges; T09 doesn't re-validate. T06 returns `wrong-host` if any hop is to a private IP; T09 maps that directly to `wrong-host` in its output. Per-host concurrency limits and the HEAD→GET fallback are also inherited from T06.
- **Trusted-host whitelist scope**: the trusted-host whitelist applied at T09 is evaluated against the FINAL URL after the SSRF-safe redirect chain has resolved. T06 ensures no intermediate hop is to a private IP range before T09 ever sees the final URL.
- **Trusted-host suffix matching**: use `isHostAllowed` from T06. `archive.org` matches `web.archive.org`; `libertyfund.org` matches `oll.libertyfund.org`; etc.
- **Redirect chain reporting**: when `verified-canonical`, include the redirect chain in `canonical.redirectChain` so the agent can see how requests resolve.
- **CSL `URL` field**: in CSL JSON, the field is conventionally `URL` (uppercase). citation-js normalizes to `URL`. Be tolerant of `url` lowercase.
- **Edition discipline mapping**: minimal v0.1 implementation can compile a small lookup:
  ```ts
  const CANONICAL_EDITION_HOSTS: Record<string, string[]> = {
    'akademie-ausgabe': ['korpora.zim.uni-duisburg-essen.de', 'archive.org'],
    'glasgow': ['oll.libertyfund.org'],
    'clarendon': ['oll.libertyfund.org', 'global.oup.com'],
    'toronto-cw': ['oll.libertyfund.org'],
  };
  ```
  Match the entry's `note:` field with a simple regex (e.g., `/Ak\.\s/i` → `akademie-ausgabe`) to look up the expected host.

- **Concurrency**: limit URL HEAD requests to 4 in flight (same as existence).

## Acceptance criteria

- [ ] DOI / ISBN entries return `not-applicable`.
- [ ] No-URL pre-DOI entries return `no-url-on-pre-doi-entry`.
- [ ] Dead URLs return `dead-url`.
- [ ] URLs on untrusted hosts return `wrong-host`.
- [ ] Live SEP URLs (non-archived) return `live-url-not-archived-snapshot`.
- [ ] Trusted-host URLs that resolve 200 return `verified-canonical`.
- [ ] Redirect chain is captured in the result for `verified-canonical` cases.
- [ ] Edition-discipline check fires when configured (basic implementation).
- [ ] Per-entry errors don't abort the run.
- [ ] An entry whose URL redirects through `archive.org` then to `127.0.0.1` is reported as `wrong-host` (T06 catches the private-IP hop).

## Tests

`test/canonical.test.ts`:

Mock `HttpClient` and run against a mock bibliography.

- Entry with DOI → `not-applicable`.
- Entry with ISBN → `not-applicable`.
- Entry without DOI/ISBN/URL → `no-url-on-pre-doi-entry`.
- Entry with URL to `https://www.gutenberg.org/files/...` (not in trusted whitelist by default) → `wrong-host`.
- Entry with URL to `https://archive.org/details/...` (whitelisted) returning 200 → `verified-canonical`.
- Entry with URL returning 404 → `dead-url`.
- Entry with URL redirect chain ending on trusted host → `verified-canonical`, chain reported.
- Entry with URL redirect chain ending on untrusted host → `wrong-host`.
- Entry with `https://plato.stanford.edu/entries/foo/` → `live-url-not-archived-snapshot`.
- Entry with `https://plato.stanford.edu/archives/win2024/entries/foo/` → `verified-canonical`.
- Edition-discipline: entry with `note: "Ak. V:35"` and URL on `oll.libertyfund.org` → flag (Akademie should be on Bonn corpora or archive.org).
- Project-extended trusted-host whitelist works (entry on a project-added host → `verified-canonical`).

Coverage target: ≥ 95% line + branch for `src/canonical.ts` (per testing-strategy: this is reputational-load-bearing).

## New dependencies

None.
