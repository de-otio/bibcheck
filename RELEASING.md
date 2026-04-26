# Releasing bibcheck

## Pre-tag checklist

- [ ] All tests pass on `main`: `npm run typecheck && npm run build && npx vitest run --coverage`.
- [ ] CI is green on the commit you intend to tag.
- [ ] `package.json` `version` matches the tag (e.g., tag `v0.1.0` → version `0.1.0`).
- [ ] `CHANGELOG.md` updated (if maintained).
- [ ] No `NODE_AUTH_TOKEN` in `.npmrc`, GitHub Actions secrets, or environment variables.
- [ ] Workflow `.github/workflows/release.yml` validated against the five gotchas below.
- [ ] Repository is public (required for `--provenance`).

## The five OIDC gotchas

1. **Node 24, not Node 22.** npm Trusted Publishing requires npm >= 11.5.1, which ships only with Node 24+. Node 22 ships npm 10 and fails with a misleading `404 Not Found - PUT https://registry.npmjs.org/<scope>/<pkg>` immediately after the provenance statement is signed. Set `node-version: 24` in `actions/setup-node`.
2. **`--provenance` requires the source repo to be public.** Drop the flag for private repos; OIDC still works without it. Add `--provenance` back if the repo is later made public.
3. **Never set `NODE_AUTH_TOKEN`** — even to empty. If set, npm uses it instead of OIDC and Trusted Publishing silently never engages.
4. **Keep `registry-url: https://registry.npmjs.org`** on `setup-node`; removing it causes npm to fail with `ENEEDAUTH`.
5. **`packages: write` is NOT needed.** That is the GitHub Packages permission, unrelated to npm. Setting it provides nothing and breaks minimum-permission discipline. Only `id-token: write` and `contents: read` belong on the publish job.

## Tagging

```sh
git tag v0.1.0
git push origin v0.1.0
```

The release workflow triggers on tag push and publishes to npm via Trusted Publishing.

## First-tag dry run

Before tagging the actual `v0.1.0`, push a pre-release tag (`v0.1.0-rc.1`) to validate the workflow. npm does not allow re-publishing a deleted version within 72 hours, so a pre-release suffix avoids the trap.

```sh
git tag v0.1.0-rc.1
git push origin v0.1.0-rc.1
```

Inspect the workflow run, confirm the publish step succeeds, then deprecate the rc on npm:

```sh
npm deprecate bibcheck@0.1.0-rc.1 "release candidate; use 0.1.0"
```

Then tag and push the actual release:

```sh
git tag v0.1.0
git push origin v0.1.0
```

## Rollback / yank

- npm allows `npm unpublish <pkg>@<version>` within 72 hours of a non-deprecated release.
- Outside that window, the strategy is `npm deprecate <pkg>@<version> "<reason>"` followed by a patch release containing the fix.
- Never silently re-publish a published version under the same number — the registry blocks it and consumers' lockfiles will diverge.
