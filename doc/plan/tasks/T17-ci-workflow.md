# T17 — CI workflow

**Phase:** 4 (Quality + release)
**Complexity:** small
**Depends on:** T16 (integration tests + vitest config)
**Blocks:** none (CI failures don't block the v0.1 *cut* if mostly green)

## Scope

GitHub Actions workflow for continuous integration. Runs on every push to a branch and every PR.

Verifies: lint (if configured), typecheck, build, unit + integration tests, coverage gate.

## Files

- `.github/workflows/ci.yml`

## Workflow content

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

permissions:
  contents: read

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - run: npm ci

      - name: Typecheck
        run: npm run typecheck

      - name: Build
        run: npm run build

      - name: Test (with coverage)
        # Build must precede test: integration tests run dist/cli.js
        run: npm test -- --coverage

      - name: License check
        run: npx license-checker-rseidelsohn --production --onlyAllow 'MIT;BSD-2-Clause;BSD-3-Clause;ISC;Apache-2.0;CC0-1.0;Unlicense'
        # Allowlist rejects GPL, AGPL, LGPL, SSPL and other copyleft licenses.

      - name: Upload coverage report on failure
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: coverage-report
          path: coverage/
          if-no-files-found: ignore

  dependency-review:
    # Runs only on pull requests to catch newly introduced vulnerable/restricted dependencies
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/dependency-review-action@v4
```

## Implementation notes

- **Node 20** — the runtime target. Tool-side publishing uses Node 24 (T18), but CI uses what users will use.
- **Coverage gate** is enforced by vitest itself via `vitest.config.ts` thresholds (T16); CI just runs the test command. A below-threshold coverage run exits non-zero.
- **Build-before-test sequencing**: `npm run build` runs before `npm test -- --coverage`. Integration tests invoke `dist/cli.js`; without a prior build the tests will fail with ENOENT.
- **`npm ci`** for reproducible installs (uses `package-lock.json`).
- **`if: failure()`** uploads the coverage report only when the test step fails — useful for diagnosing why coverage dropped below threshold.
- **License checker**: uses `license-checker-rseidelsohn` (npx, no install required). Rejects GPL, AGPL, LGPL, and SSPL. Only production dependencies are checked (`--production`).
- **Dependency review**: `actions/dependency-review-action@v4` runs on PRs only (`if: github.event_name == 'pull_request'`). Skipped on direct pushes to main to avoid false positives when already-reviewed code lands.
- **No matrix** for v0.1 — single Node version, single OS. Multi-version testing can come later if user reports surface platform-specific issues.
- **No npm publish step** here. That's T18.

## Acceptance criteria

- [ ] `.github/workflows/ci.yml` exists with the structure above.
- [ ] Workflow triggers on push to `main` and on every PR.
- [ ] All steps execute on a green build.
- [ ] `npm run build` runs before `npm test -- --coverage`.
- [ ] Coverage threshold violations cause the test step to fail.
- [ ] Failed runs upload the coverage report as an artefact.
- [ ] No secrets required (CI is read-only).
- [ ] License-checker rejects a sample GPL dep added to `package.json` (verified manually before merging).
- [ ] `dependency-review-action@v4` runs on PR events; skipped on push to main.

## Tests

The workflow itself isn't unit-testable in any meaningful way. Validation strategy:

- **Local dry-run**: `act` (https://github.com/nektos/act) can run GitHub Actions locally if we want a smoke test. Optional.
- **First PR**: the first PR to land after this workflow is added is the test. If it fails, fix and re-PR.

## New dependencies

None.
