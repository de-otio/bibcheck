# T18 — Release workflow (npm Trusted Publishing)

**Phase:** 4 (Quality + release)
**Complexity:** small (but unforgiving — get any of the four OIDC gotchas wrong and the release silently fails)
**Depends on:** none (independent of test infrastructure)
**Blocks:** v0.1.0 tag itself

## Scope

GitHub Actions workflow that publishes `bibcheck` to npm via Trusted Publishing (OIDC) on tag push.

This task is small in code volume but high in care. The four OIDC gotchas documented in [`../release.md`](../release.md) are load-bearing — each one has previously bitten the maintainer.

## Files

- `.github/workflows/release.yml`

## Workflow content

Per [`../release.md`](../release.md) §"Release workflow":

```yaml
name: Release
on:
  push:
    tags: ['v*']

permissions:
  id-token: write       # required for OIDC
  contents: read
  # packages: write is intentionally NOT set; that's GitHub Packages, unrelated to npm.

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 24                            # NOT 22 — npm 11+ required for Trusted Publishing
          registry-url: https://registry.npmjs.org    # required; without it ENEEDAUTH

      - run: npm ci
      - run: npm run build
      - run: npm test -- --coverage

      - run: npm publish --provenance --access public
        # Critical (do not change without re-reading release.md):
        # - Node 24 not 22 (npm 10 silently fails)
        # - --provenance requires public repo (drop if private)
        # - DO NOT set NODE_AUTH_TOKEN (its presence makes npm skip OIDC)
        # - registry-url: must be set on setup-node above
```

## Pre-tag checklist

Before pushing a tag, the maintainer manually verifies:

- [ ] `node-version: 24` on the publish job.
- [ ] `registry-url: https://registry.npmjs.org` set on `setup-node`.
- [ ] `id-token: write` permission on the job.
- [ ] No `NODE_AUTH_TOKEN` in env, secrets, `.npmrc`, or anywhere in the workflow.
- [ ] `--provenance --access public` on `npm publish`.
- [ ] Repository is public on GitHub.
- [ ] All tests + coverage pass on the commit being tagged.
- [ ] Trusted Publishing is configured on the npm side (one-time; package settings → Trusted Publishers).

## First-tag validation

The release workflow uses the YAML at the **tagged ref**, so a post-tag fix doesn't help — a broken release is locked into that tag. To validate before the real `v0.1.0`:

1. Push a `v0.1.0-rc.1` tag (per Wave 1A.1's release.md — use this pre-release form, not `v0.0.1-test`).
2. Confirm the workflow runs and publishes successfully.
3. Inspect the published package on npm: provenance attested, files correct, `bin` working.
4. If issues, fix on `main`, push a new pre-release tag, repeat.
5. When confident, push `v0.1.0`.

`npm pack` locally is the cheapest way to validate the tarball contents before any tag:

```sh
npm pack
# inspect bibcheck-0.1.0.tgz with:
tar -tzf bibcheck-0.1.0.tgz
# verify dist/, README.md, LICENSE, package.json present
```

## Rollback / yank story

If a release is published with a critical bug, see `doc/plan/release.md` §"Rollback / yank story" for the npm deprecation / yank procedure. In brief: `npm deprecate bibcheck@<version> "<reason>"` immediately; coordinate with downstream consumers; cut a patch release. Full instructions and caveats are in release.md.

## Acceptance criteria

- [ ] `.github/workflows/release.yml` exists with the structure above.
- [ ] All four OIDC gotchas encoded as inline comments.
- [ ] Pre-tag checklist documented (in this file or in `doc/plan/release.md`).
- [ ] First pre-release tag (`v0.1.0-rc.1`) publishes successfully.
- [ ] Release workflow lacks `packages: write` permission (verified by reading the YAML).
- [ ] Rollback/yank story is cross-linked to `doc/plan/release.md §"Rollback / yank story"`.

## Tests

Same as T17: not unit-testable. The first publish is the test. The pre-release tag exists specifically to surface issues.

## New dependencies

None.
