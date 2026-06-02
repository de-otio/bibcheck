# T24 — Remove offline mode (internet required)

**Phase:** 5 (Hallucination-hardening)
**Complexity:** low
**Depends on:** — (independent of the schema work; can run any time in Phase 5)
**Blocks:** —

## Scope

Remove the `--offline` flag and make a network connection a hard requirement.
Rationale (open-question 3): an offline run can only ever degrade hallucination
detection to "unverifiable", silently weakening the tool's core purpose. A tool
that quietly does less when offline is worse than one that refuses to run; fail
fast with a clear message instead.

**This supersedes the `--offline` doctor fix made earlier** (the change that made
`--offline` skip connectivity checks to pass a flaky integration test). That
flag is being removed; the doctor test must instead inject a **mock HTTP client**
so it stays deterministic without an offline mode.

## Files

- `src/cli.ts` — remove `--offline` from `addGlobalOptions`; remove `offline`
  from `GlobalOpts`/`DoctorOpts` and all pass-through (`runDoctorCommand`,
  subcommand runners). Remove the `offline: opts.offline` wiring added earlier.
- `src/doctor.ts` — remove the `offline` field from `RunDoctorDeps` and the
  offline branch in the connectivity loop (added earlier this phase). Doctor
  always runs connectivity checks.
- `src/http.ts` / wherever the run begins — on a network-unavailable / DNS
  failure for the *first* real request, fail with a clear actionable error
  ("bibcheck requires network access; all checks need CrossRef/OpenAlex/…").
- `test/integration/check.test.ts` — rework the `doctor` cases that used
  `--offline` to inject a stub `HttpClient` (canned responses), NOT the real
  network. Remove `--offline` from all integration invocations.
- `docs/usage.md`, `docs/configuration.md` — remove `--offline`; if `--no-network`
  is still documented anywhere (B6), remove it too.

## Acceptance criteria

- [ ] `--offline` is not a recognized flag (and is not silently accepted).
- [ ] `bibcheck doctor` always performs connectivity checks; no offline branch remains in `doctor.ts`.
- [ ] The doctor integration test passes deterministically using a mocked HTTP client — no real network call, no 5s timeout.
- [ ] A genuine network failure produces a single clear error and a non-zero exit, not a misleading "all unverifiable" success.
- [ ] No references to `--offline` / `--no-network` remain in docs or `--help`.
- [ ] Full suite green; the previously-flaky `doctor > Node version` test is stable.

## Tests

- Doctor integration test with a stub HTTP client returning 200s → connectivity checks `ok`, deterministic, fast.
- Doctor integration test with a stub returning network errors → connectivity checks `fail`, doctor still exits per its aggregation rules.
- Unit: invoking with `--offline` errors as unknown option.
