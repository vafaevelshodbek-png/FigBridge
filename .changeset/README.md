# Changesets

Every pull request that changes what users get adds a changeset:

```sh
pnpm changeset
```

Pick `figbridge`, the bump (`patch` for fixes, `minor` for features, `major` for breaking
changes to the CLI, MCP tools or protocol) and write one or two sentences for the changelog,
from the user's point of view.

Only `figbridge` is published. The `@figbridge/*` workspace packages are private and bundled
into it, so their changes are described in a `figbridge` changeset.

On `main`, the release workflow keeps a "Version packages" pull request up to date; merging it
bumps the version, writes `CHANGELOG.md` and publishes to npm with provenance.
