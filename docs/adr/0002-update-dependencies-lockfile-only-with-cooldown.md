# 0002. Update dependencies lockfile-only, with a 7-day cooldown

- Status: accepted
- Date: 2026-11-08
- Deciders: yosuque + Claude Code
- Phase: operations

## Context and problem

Most TypeScript dependency versions live in one place, the `catalog:` block of `pnpm-workspace.yaml`, so a catalog range is not only what this repository tests against. The packing step writes it into every published package's dependency and peer ranges. `cli/src/init/versions.ts` (`EXTERNAL_VERSIONS`) must match it as well, and `kohaku init` writes those versions into a generated project. Raising a catalog floor (`^2.1.1` → `^2.1.6`) therefore narrows what consumers may install, even when nothing in the repository needs the newer version.

Dependabot's default npm strategy (`auto`, which raises the floor of an application's requirement) did exactly that. In November 2026 every npm Dependabot PR raised catalog floors: #95–#99, and #101, #102 and #106 a few days later. As a result each one failed CI on `cli/test/init/render.test.ts` until `EXTERNAL_VERSIONS` was synced by hand.

Two further constraints shape the policy. Some packages release several times a week (`ai`, `@ai-sdk/*`), so a version only a few days old is often superseded by the next patch. And a brand-new release is the usual window for a compromised package to be noticed and pulled, which is what a release-age gate protects against.

The same policy was already applied by hand in three update runs (#84 in October 2026, #92, and #103 / #107 in November 2026); this ADR writes it down.

## Options considered

- **Option A**: accept Dependabot's floor raises every month and sync `EXTERNAL_VERSIONS` and the init goldens by hand in each PR.
- **Option B**: refresh only the lockfile and keep the floors, with a 7-day cooldown; raise a floor only for the exceptions listed below. Set Dependabot's npm `versioning-strategy` to `increase-if-necessary` so that its PRs follow the same rule.
- **Option C**: Option B, but with Dependabot's `versioning-strategy: lockfile-only`.
- **Option D**: Option B without the cooldown.

## Decision

Chosen: **Option B**

1. An update run uses a cutoff seven days before the run date. For pnpm, the run is `pnpm update -r --no-save --config.minimumReleaseAge=10080`. For uv, run `uv lock --upgrade` and then pin anything newer than the cutoff back with `uv lock --upgrade-package <pkg>==<version>`. Do not use `--exclude-newer`, because uv records it in the lock.
2. Catalog `^` ranges, package.json ranges and pyproject floors stay unchanged, with three exceptions:
   - an **exact pin** (react, react-dom, typescript, vitepress, `@biomejs/biome`) moves to the new version;
   - a **package whose new behaviour the code depends on**, whose floor rises to the first version with that behaviour (for example, the MCP SDK floor `^2.3.1` in #85);
   - a **security fix**, which is an exception to both the cooldown and the floor rule. Its floor rises to the patched version, so that a consumer or a generated project can no longer resolve a vulnerable one (for example, `@hono/node-server` `^2.1.6` for GHSA-jpvv-r467-5p4w in #108).
3. A new major version is reviewed on its own and is not taken by a routine run. For example, anthropic Python SDK 2.x changed the API version it sends, and this needed [ADR-0003](0003-python-claude-adapter-sends-no-sampling-parameters.md) first.
4. Dependabot's npm entry uses `versioning-strategy: increase-if-necessary`. A Dependabot PR that still raises a floor is closed as superseded, with a comment naming the PR that replaced it.
5. Any catalog change is synced to `EXTERNAL_VERSIONS`, followed by `KOHAKU_UPDATE_INIT_GOLDEN=1` to regenerate the goldens. A changeset is added when the published output changes, including what `kohaku init` generates.

### Rationale

- **Published ranges change only for a reason.** A floor that moves only for an exact pin, a behaviour dependency or a security fix keeps consumers on the widest range the code actually supports.
- **Dependabot keeps doing its useful part.** `increase-if-necessary` leaves a requirement unchanged when it already allows the new release and still updates the resolved version, while an exact pin is bumped. It applies to catalog entries too: Dependabot's npm `RequirementsUpdater` applies the strategy to every requirement whatever file it lives in, and its pnpm workspace updater writes the result into `pnpm-workspace.yaml`. Option C was rejected because a lockfile-only strategy ignores any update that needs a manifest change, so react, typescript and Biome would never get a PR.
- **The cooldown filters churn and fresh-release risk.** Option D would open PRs that the next patch supersedes within days, and would drop the window in which a bad release is usually caught.
- Option A puts a hand edit into every Dependabot PR and narrows the published ranges for no functional gain.

## Consequences (trade-offs)

- Good: the published dependency and peer ranges stay stable. Dependabot PRs for `^` ranges become lockfile-only and pass CI without a hand edit. The routine monthly run is one lockfile refresh rather than a batch of conflicting PRs.
- Costs / bad: non-security fixes reach the lockfile up to seven days late. CI runs against the newest resolution, so the floor versions themselves are not tested, and a consumer on a floor version may hit a bug that CI never sees. Floor raises for security fixes stay manual, because `increase-if-necessary` keeps a range that already allows the patched version. Dependabot still cannot edit `EXTERNAL_VERSIONS`, so a PR that bumps an exact pin still needs a hand sync.
- Revisit when: Dependabot's handling of pnpm catalogs or of `increase-if-necessary` changes; a consumer reports a bug that comes from a floor version (then consider a CI job that installs the floors); or the cooldown blocks a fix that is needed sooner and is not a security fix.

## References

- PRs: #84, #85, #92, #103, #107 and #108 (runs that applied this policy); Dependabot PRs closed as superseded: #95–#99, #101, #102, #106
- [.github/dependabot.yml](../../.github/dependabot.yml): the "Catalog and the versioning strategy" note
- Dependabot `versioning-strategy`: https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference
- dependabot-core: `npm_and_yarn/lib/dependabot/npm_and_yarn/update_checker/requirements_updater.rb` and `file_updater/pnpm_workspace_updater.rb`
- [ADR-0003](0003-python-claude-adapter-sends-no-sampling-parameters.md): the anthropic SDK 2.x major that this policy held back for separate review
