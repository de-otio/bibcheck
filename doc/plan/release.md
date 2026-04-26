# Release pipeline

CI on every push/PR; release on tag push via npm Trusted Publishing (OIDC).

## CI workflow (T17)

`.github/workflows/ci.yml`. Runs on every push to a branch and every PR.

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

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
      - run: npm run typecheck
      - run: npm run build
      - run: npm test -- --coverage

      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: coverage-report
          path: coverage/
```

The coverage gate (≥ 80%) is enforced inside vitest, not as a separate CI step — `npm test -- --coverage` exits non-zero if coverage falls below the thresholds in `vitest.config.ts`.

For Node version: CI uses Node 20 (the runtime target), not Node 24. The Node-24-only constraint applies only to the publish step. CI runs on the runtime version contributors will actually use.

## Release workflow (T18)

`.github/workflows/release.yml`. Runs on tag push (`v*`).

```yaml
name: Release
on:
  push:
    tags: ['v*']

jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      id-token: write       # required for OIDC
      contents: read
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 24                            # NOT 22 — npm 11+ required
          registry-url: https://registry.npmjs.org    # required; without it ENEEDAUTH

      - run: npm ci
      - run: npm run build
      - run: npm test -- --coverage

      - run: npm publish --provenance --access public
        # do NOT set NODE_AUTH_TOKEN — its presence makes npm skip OIDC
```

## The four OIDC gotchas (load-bearing)

The user's pre-existing notes on npm Trusted Publishing have been bitten by all four of these. Encode them inline as comments in `release.yml` so future maintainers don't lose the why.

1. **Node 24, not Node 22.** npm Trusted Publishing requires `npm ≥ 11.5.1`. Node 22 ships npm 10, which fails the publish step with a misleading `404 Not Found - PUT https://registry.npmjs.org/...`. Node 24 ships npm 11+ and works.

2. **`--provenance` requires the source repo to be public.** A private repo will fail with `422 Unprocessable Entity - Error verifying sigstore provenance bundle: Unsupported GitHub Actions source repository visibility: "private"`. The bibcheck repo is intended to be public, so `--provenance` is correct. If the repo were ever made private, drop `--provenance`; OIDC auth still works without it, you just skip the sigstore attestation.

3. **Do not set `NODE_AUTH_TOKEN`** — even to empty. If set, npm uses it instead of OIDC and Trusted Publishing silently never engages. The token must not appear anywhere in the workflow's environment.

4. **Keep `registry-url: https://registry.npmjs.org`** on `setup-node`. Removing it produces `ENEEDAUTH`.

5. **`packages: write` is NOT needed.** That's the GitHub Packages permission, unrelated to npm. Adding it "to be safe" breaks the minimum-permissions principle and provides nothing. Only `id-token: write` and `contents: read` belong on the publish job.

## Rollback / yank story

When a published version needs to be pulled:

- npm allows `npm unpublish <pkg>@<version>` within **72 hours** of a non-deprecated release, provided the package is not depended upon by other packages.
- Outside that window, the strategy is `npm deprecate <pkg>@<version> "<reason>"` followed by a patch release containing the fix. This marks the bad version visibly to installers without removing it.
- Never silently re-publish a published version under the same number — the registry blocks it and consumers' lockfiles will diverge, causing reproducibility failures.
- Document this procedure in `RELEASING.md` (T19) so future maintainers know the procedure without having to rediscover it.

## Pre-tag validation

Before pushing a tag, validate the workflow YAML against the four points above. The release workflow uses the YAML at the **tagged ref**, so a post-tag fix does not help — a broken release is locked in.

Pragmatic checklist:

- [ ] `node-version: 24` on the publish job.
- [ ] `registry-url` set.
- [ ] No `NODE_AUTH_TOKEN` in env, secrets, or `.npmrc`.
- [ ] `--provenance --access public` on `npm publish`.
- [ ] Repo is public.
- [ ] `id-token: write` permission set.
- [ ] All tests + coverage pass on the commit being tagged.

## Trusted Publishing setup on npm

This is a one-time configuration step on the npm side, not in the repo:

1. Create the package on npm (or use an existing published `bibcheck` if it exists). Initial `0.0.x` placeholder publish may be done manually with `npm publish` to claim the name.
2. Configure Trusted Publishing in the package settings: link the GitHub repo, the workflow filename (`release.yml`), and the workflow environment (none, by default).
3. After this is configured, the workflow YAML's OIDC `id-token: write` step authenticates without any token.

## Versioning

Pre-1.0:

- Patch bumps (`0.1.0` → `0.1.1`) for bug fixes.
- Minor bumps (`0.1.0` → `0.2.0`) for new features and breaking changes alike. Pre-1.0 semver permits this.

The output schema version is bumped independently of the package version. See [`../../src/schema/output.ts`](../../src/schema/output.ts) for the bump rules.

## First-tag validation

Before tagging the actual `v0.1.0`:

1. Push a `v0.1.0-rc.1` tag to validate the release workflow on a known-empty package version. npm doesn't allow re-publishing a deleted version within 72h, so a pre-release suffix (`-rc.N`) avoids the trap. (Confirm the package on npm allows pre-release tags or use `--tag rc`.)
2. Confirm the publish succeeds and provenance is attested.
3. If the test publish has issues, fix them on `main`, push a new test tag, and repeat.
4. When confident, push the real `v0.1.0` tag.

The first real publish is the highest-risk publish — the workflow is unproven against this repo until then.

## Local verification

Before committing release-workflow changes, simulate the build locally:

```sh
nvm use 24                  # match the publish node version
npm ci
npm run build
npm test -- --coverage
npm pack                    # produces bibcheck-x.y.z.tgz
npx --yes ./bibcheck-x.y.z.tgz --help     # verify the published tarball runs
```

`npm pack` does not publish; it produces the exact tarball that would be uploaded. Inspecting that tarball is the cheapest way to catch missing files (`files` field in `package.json` is wrong) or a misconfigured `bin` field.
