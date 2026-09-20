# Changesets

A changeset is a short note describing a change and how it should affect the version numbers. Add one to
any pull request that changes published behaviour:

```bash
pnpm changeset
```

Pick the bump level, write a sentence a user of the package would understand, and commit the generated
file under `.changeset/` with your change. Documentation-only or internal-tooling pull requests do not need
one; CI reports the absence but does not block on it.

## The twenty packages move together

`fixed` in `config.json` groups all of `@kohaku-ui/*` into one version. They are one implementation of one
wire protocol: the schemas in `spec-core`, the `ComposeContext` types and the identity of the Zod objects
have to agree across the whole set. If versions drifted, a consumer could end up with two `spec-core`
copies whose types are structurally identical but not the same objects, and the failures would be
confusing and remote from their cause. So a release bumps all twenty, even the ones with no changes, and
"install them all at the same version" stays a one-sentence instruction.

The sample apps under `apps/` are ignored — they are demonstrations and are never published.

## Releasing

Releases run from `main` in two steps. Merged changesets accumulate into a `chore(release): version
packages` pull request; merging that one does **not** publish — it makes a draft GitHub Release appear.
Publishing that draft creates the tag, and the tag is what drives the publish workflow to npm and then
PyPI. See [docs/runbooks/release.md](../docs/runbooks/release.md) for the full procedure.
