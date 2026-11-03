# Stargrep

Stargrep searches a developer's GitHub stars in plain language.

Read these before changing code:

- `docs/architecture.md` explains the stack, repo layout, and testing.
- `docs/effect.md` sets the Effect conventions.
- `design/system.md` is the design system.
- `docs/setup.md` lists the local setup steps.

Run `bun run check` and `bun test --parallel` before you push.

Commit messages and PR titles are lowercase conventional commits, such as `feat(db): add schema and migrations`.

## Vendored repositories

`repos/` holds the source of key dependencies at the versions this repo pins. Use it as read-only reference.

- Prefer the patterns in `repos/` over guesses or web search. A plain `grep -rn` finds the source, docs, and tests for an API.
- Never edit or import from `repos/`.
- Read `repos/effect/LLMS.md` before writing Effect code.
- Update a vendored repo in the same PR that bumps the matching dependency. `repos/orpc` is a git subtree, so run `git subtree pull --prefix=repos/orpc https://github.com/middleapi/orpc.git <tag> --squash`. `repos/effect` and `repos/alchemy` are subsets, so change the tag in `scripts/sync-repos.ts` and run `bun scripts/sync-repos.ts <name>`.
