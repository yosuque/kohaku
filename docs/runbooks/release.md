# Runbook: releasing kohaku

This is the procedure for cutting and publishing a release of the twenty-seven `@kohaku-ui/*` npm packages
and the `kohaku-ui` PyPI distribution, which always move together (see
[.changeset/README.md](../../.changeset/README.md)). See [CONTRIBUTING.md §11](../../CONTRIBUTING.md)
for the short version aimed at contributors; this runbook is the operational detail for whoever runs
the release.

## 1. Overview

Releasing is two steps, driven by two workflows, so that "a version is decided" and "a version is
published" are separate, auditable moments with a human gate in between:

```
changeset-carrying PR ──merge──▶ main push ──▶ .github/workflows/version.yml
                                                ├─ changesets pending → open/update the
                                                │  "chore(release): version packages" PR
                                                └─ no changesets pending & the current version has
                                                   no tag yet → draft GitHub Release vX.Y.Z
                                                   (target = the merge commit, body = scripts/release-notes.mjs)

human: dry run .github/workflows/release.yml (workflow_dispatch, dry_run=true) ──▶ green
human: publish the draft release ──▶ GitHub creates tag vX.Y.Z ──▶ `release: published` event
                                                                     ──▶ .github/workflows/release.yml
                                                                         verify → npm (env `npm`, OIDC)
                                                                                → pypi (env `pypi`, OIDC)
                                                                                → summary
```

- **`version.yml`** only ever runs on a push to `main`. It never publishes anything — it either
  maintains the version pull request, or (once that pull request is merged and no changesets remain)
  creates a *draft* GitHub Release. Nothing it does touches a registry.
- **`release.yml`** is the publish workflow. It is triggered by a human publishing the draft release
  (GitHub's `release: published` event, which fires only when a draft is published — not when it is
  created or edited), or by hand via `workflow_dispatch` for a dry run or to re-run a failed publish.
  Everything it does is checked out from the release tag, and it re-verifies (typecheck, tests, pack
  smoke) on that exact tree before publishing anything.
- **The file name `release.yml` is load-bearing.** Both npm's and PyPI's trusted publishers are
  registered against this exact workflow file name — renaming it means re-registering all of them (see
  §2).
- The two **Environments**, `npm` and `pypi`, exist purely to scope each registry's OIDC trust and to
  show the target registry's URL on the run. Neither carries a required-reviewers gate: the deliberate
  human gate in this design is publishing the draft release, not approving a workflow run.

## 2. One-time setup

This is infrastructure setup, done once by whoever administers the repository and the two package
registries. None of it is code, so it isn't part of any pull request.

- [ ] **GitHub → Settings → Actions → General**: enable "Allow GitHub Actions to create and approve
  pull requests". Without this, `version.yml` cannot open the version pull request at all (this is
  exactly how the first run under this design failed).
- [ ] **GitHub → Settings → Environments**: create environment `npm`. Deployment branches and tags:
  "Selected branches and tags", allowing branch `main` **and** tag `v*`. Both are needed — the dry run
  deploys to the `npm` environment from `main` (no tag exists yet), while a real publish deploys from
  the release tag. No secrets are needed (OIDC only, no `NPM_TOKEN`). Required reviewers are optional;
  adding one also gates the dry run behind an approval.
- [ ] **GitHub → Settings → Environments**: leave the existing `pypi` environment as is (optionally
  give it the same `main` + `v*` policy — its build step runs on `main` during a dry run too). No code
  change is needed on the PyPI side.
- [ ] **npmjs.com, for each of the 27 packages below**: Settings → Publishing access → Trusted
  publisher → GitHub Actions, with:
  - Organization or user: `yosuque`
  - Repository: `kohaku`
  - Workflow filename: `release.yml` (exact match, extension included)
  - Environment name: `npm`

  Packages: `@kohaku-ui/admin-react`, `authz-hmac`, `authz-jwt`, `cli`, `client`, `composer`,
  `data-binding`, `evals`, `host-a2ui`, `host-core`, `host-mcp-apps`, `host-rest`, `intents`, `lineage`,
  `llm`, `otel`, `registry`, `renderer-core`, `renderer-react`, `renderer-wc`, `sandbox`, `semantic-llm`,
  `spec`, `spec-core`, `storage-memory`, `storage-postgres`, `storage-redis`. The
  `release.yml` `npm` job's dry run probes every one of these and lists any that are missing a trusted
  publisher — see §4. (`@kohaku-ui/port-contracts` is private and never appears here.)
- [ ] **Once the first OIDC publish succeeds**: delete the repository secret `NPM_TOKEN` and revoke the
  corresponding token on npmjs.com (the workflow no longer references it after this change).
  Optionally enable "Require two-factor authentication and disallow tokens" on each package.
- [ ] **PyPI**: no change needed. The existing trusted publisher for `kohaku-ui` (`yosuque/kohaku`,
  `release.yml`, environment `pypi`) already covers this.

## 3. The version PR

Once a changeset-carrying pull request merges to `main`, `version.yml` opens or updates a pull request
titled `chore(release): version packages`. Review it like any other pull request before merging:

- All twenty-seven package manifests bump to the same version (the fixed group).
- All twenty-seven `CHANGELOG.md` files gain a new `## <version>` section.
- `python/kohaku/pyproject.toml` and `python/kohaku/src/kohaku/__init__.py` bump to the matching
  version — these are the two places the Python side states its version, and `release.yml`'s `verify`
  job later asserts they agree with the tag. The `kohaku-ui` entry in `python/uv.lock` bumps with them
  (CI's `uv lock --check` fails on a stale lock).
- The lockfile updates (changeset removal + version bumps touch it).

Merging this pull request does **not** publish anything. It only removes the merged changesets, which
is what lets `version.yml`'s next run notice "no changesets pending" and create the draft release.

## 4. Pre-publish checklist

Before publishing the draft release:

- [ ] CI is green on the merge commit that produced the draft (the same commit the draft release's
  `target` points at).
- [ ] The draft release's body (generated by `scripts/release-notes.mjs` from the CHANGELOGs) reads
  correctly — it can be edited by hand before publishing if a wording fix is needed.
- [ ] Dry run is green: `gh workflow run release.yml -f dry_run=true` run from `main` (no `tag` input on
  a dry run — it exercises whatever ref the run was started from). This also runs the npm job's
  trusted-publisher probe, which must report every one of the 27 packages as `ok`.
- [ ] Anything that only shows up manually has been checked once more for this version (e.g. paging
  through `records`, or exercising an MCP host by hand) — CI's automated coverage does not replace a
  human look at a real release candidate.
- [ ] The `npm` and `pypi` Environment deployment policies are as set up in §2 (branch `main` and tag
  `v*`), so neither the dry run nor the real publish is unexpectedly blocked.

## 5. Publishing

Publish the draft release either from the GitHub UI (Releases → the draft → Edit → Publish release) or:

```bash
gh release edit vX.Y.Z --draft=false
```

This makes GitHub create the tag `vX.Y.Z` at the draft's target commit and fire `release: published`,
which starts `release.yml` for real (`dry_run` is implicitly `false` on this trigger). Watch the run:
`verify` re-checks versions/typecheck/tests/pack-smoke on the tagged tree, then `npm` publishes all
twenty-seven packages via OIDC trusted publishing with provenance, then `pypi` publishes the wheel/sdist. The
`summary` job's step summary lists which packages this run actually published, and links to the npm
package page, the PyPI project page, and the GitHub release.

## 6. Re-running a failed publish

A partial failure (e.g. one npm package's trusted publisher was missing) is safe to re-run:

```bash
gh workflow run release.yml --ref vX.Y.Z -f tag=vX.Y.Z -f dry_run=false
```

`pnpm -r publish` only publishes packages whose version isn't already on the registry, so already-
published packages are skipped and re-running is idempotent. PyPI's upload step uses `skip-existing`
for the same reason. To diagnose exactly how far a partial publish got:

```bash
npm view @kohaku-ui/<pkg> versions
```

## 7. Undoing a release

There is no single "undo". Depending on what's needed:

- **npm**: `npm deprecate @kohaku-ui/<pkg>@<version> "<reason>"` across all 27 packages is the normal
  path — it warns installers without breaking anyone already pinned to the version. `npm unpublish` is
  only possible within 72 hours of publishing and only while nothing else depends on the version; given
  twenty-seven interdependent packages, treat it as effectively unavailable once other packages have started
  depending on the new version.
- **PyPI**: yank the release (`pypi.org` → the project → the version → "Yank"). A yanked release stays
  installable by exact version pin but is skipped by default resolution.
- **GitHub**: edit the release notes to say what happened; leave the tag in place. Tags are not
  deleted — the tag is the audit trail of what was actually built and published.

## 8. Troubleshooting

- **"GitHub Actions is not permitted to create or approve pull requests"**: the repository setting in
  §2 ("Allow GitHub Actions to create and approve pull requests") is off. `version.yml` can push the
  branch but not open the pull request.
- **"Skipped OIDC: ERR_PNPM_AUTH_TOKEN_EXCHANGE"**: no trusted publisher is registered for that npm
  package (repository, workflow filename, and environment must match exactly — see §2). The `npm` job
  turns this into a hard failure rather than silently falling back to a token, because there is no
  token to fall back to any more.
- **"still a draft"** (from `release.yml`'s `verify` step when given a `tag` input): the named release
  exists but hasn't been published yet, so the tag doesn't exist yet either. Publish the draft (§5), or
  run a dry run without a `tag` input to exercise the current ref instead.
- **`Branch "main" is not allowed to deploy to npm`**: the `npm` Environment's deployment branch/tag
  policy (§2) doesn't include `main` — needed for the dry run, which runs before any tag exists.
