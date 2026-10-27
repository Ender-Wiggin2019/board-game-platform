# Development

## Workspace boundary

`common/*` provides game-neutral contracts, storage, Host, server, client, and
tooling. `platform/*` provides account, release, registry, and platform
services. `apps/platform-*` are the empty-platform compositions. The example
under `examples/counter` is the only game-shaped source included here and is a
fixture for the public package boundary, not a production release.

Do not add a game import to platform or common packages. A game owns its rules,
server process, client artifact, database, and replay implementation. Platform
registration consumes public JSON descriptions and immutable release metadata;
it must not load game closures or private source paths.

## Local checks

```sh
corepack pnpm install
corepack pnpm verify:platform
corepack pnpm smoke:platform
```

`verify:platform` builds, typechecks, lints, and tests only framework and empty
platform packages. `smoke:platform` is a fresh PostgreSQL plus browser check;
it needs the local `initdb`/`pg_ctl` tools and the Playwright browser supplied
by `@board-platform/cli`.

For a game package, use the public CLI from the workspace:

```sh
corepack pnpm --filter @board-platform/cli build
corepack pnpm bgp game verify examples/counter --check
corepack pnpm --dir examples/counter typecheck
```

Do not run a game migration as part of ordinary server startup. Durable DDL is
an explicit operator command; readiness checks only inspect the existing
schema.

## Adding a game example

Keep the game under `examples/<id>/{common,engine,server,client}` and register
only public package exports in `game.json`. Use `workspace:*` for framework and
same-game dependencies. Do not create a second workspace lockfile inside the
example. A game example must remain removable without changing platform
runtime code.
