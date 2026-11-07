# Stargrep

Stargrep searches a developer's GitHub stars in plain language.

Read these before changing code:

- `docs/architecture.md` explains the stack, repo layout, and testing.
- `docs/effect.md` sets the Effect conventions.
- `design/system.md` is the design system.
- `docs/setup.md` lists the local setup steps.

Run `bun run check` and `bun test --parallel` before you push.

Server code in `apps/web` lives in `src/server.ts` and `src/server/`. Everything else in `apps/web/src` and `packages/ui` is client code and imports `packages/api` with `import type` only, which lint enforces.

Tests that run on workerd are named `*.workerd-test.ts`. `bun test` never matches that name, and each app's vitest config includes only that pattern. Other tests use `*.test.ts` or `*.test.tsx` and run on `bun test`. The worker test command also bundles the real Worker for a separate workerd runtime suite.

Every workspace has a `typecheck` script, so `bun run check` covers it.

Commit messages and PR titles are lowercase conventional commits, such as `feat(db): add schema and migrations`.

## Vendored repositories

`repos/` holds the source of key dependencies at the versions this repo pins. Use it as read-only reference.

- Prefer the patterns in `repos/` over guesses or web search. A plain `grep -rn` finds the source, docs, and tests for an API.
- Never edit or import from `repos/`.
- Read `repos/effect/LLMS.md` before writing Effect code.
- Update a vendored repo in the same PR that bumps the matching dependency. Change the tag in `scripts/sync-repos.ts` and run `bun scripts/sync-repos.ts`. The effect tag comes from the catalog in the root `package.json`, so bumping `effect` there is enough.
