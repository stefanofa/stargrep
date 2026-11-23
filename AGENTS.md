# Stargrep

Stargrep searches the GitHub repos a developer starred, in plain language.

Read these before changing code:

- `docs/architecture.md` explains the stack, repo layout, and testing.
- `docs/effect.md` sets the Effect conventions.
- `design/system.md` is the design system.
- `docs/setup.md` lists the local setup steps.

Run `bun run check` and `bun test --parallel` before you push.

Server code in `apps/web` lives in `src/server.ts` and `src/server/`. Everything else in `apps/web/src` and `packages/ui` is client code and imports `packages/api` with `import type` only, which lint enforces.

Tests that run on workerd are named `*.workerd-test.ts`. `bun test` never matches that name, and each app's vitest config includes only that pattern. Other tests use `*.test.ts` or `*.test.tsx` and run on `bun test`. A `*.test.tsx` file gets happy-dom from the root preload and a `*.test.ts` file gets no DOM. The worker test command also bundles the real Worker for a separate workerd runtime suite.

What to test:

- Test behavior that can break, such as auth, sessions and rate limits, GitHub response parsing, database queries and migrations, search and ranking, API and MCP contracts, the Worker on workerd, and the logic a bug fix changed. Leave out tests for what types already guarantee, trivial logic, copy text, smoke runs, mock-call mirrors, callback wiring, and props rendered to static markup. A test that a doc or comment names as a guard stays.
- Extend before you add. When an existing test or table covers the behavior, add a row or an assertion there. Write a new `test` only when no case fits.
- Test at one layer: the lowest one that fails on `main`. Do not repeat the case in a wrapper test, at each call site, or in two copies of the same logic, such as `packages/core` and again through `apps/web`.
- In review, ask for a missing test only when it would catch a real regression. Flag a new test that breaks these rules and name the fix: fold it into the existing case or table, delete it, or keep one layer.

Every workspace has a `typecheck` script, so `bun run check` covers it.

Commit messages and PR titles are lowercase conventional commits, such as `feat(db): add schema and migrations`.

## Vendored repositories

`repos/` holds the source of key dependencies at the versions this repo pins. Git tracks only `repos/VENDORED.json`, which pins each repo's tag and commit. Run `bun scripts/sync-repos.ts` in a fresh clone to fetch the rest. Use it as read-only reference.

- Prefer the patterns in `repos/` over guesses or web search. A plain `grep -rn` finds the source, docs, and tests for an API.
- Never edit or import from `repos/`.
- Read `repos/effect/LLMS.md` before writing Effect code. If it is missing, run the sync first.
- Bump a vendored repo in the same PR that bumps the matching dependency. Change the tag in `scripts/sync-repos.ts` and run `bun scripts/sync-repos.ts --update`, which pins the new commit in `repos/VENDORED.json`. The effect tag comes from the catalog in the root `package.json`, so bumping `effect` there is enough. A test fails while `VENDORED.json` and the script disagree.
