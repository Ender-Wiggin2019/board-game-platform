# Board Game Platform

This repository is the game-independent framework for independently maintained
board-game services. It contains reusable contracts, Host and server runtime,
platform account and release services, a browser client, development tooling,
and a small counter example. It does not contain a production game, game
rules, game artwork, or game credentials.

## Requirements

- Node.js 22 or newer
- Corepack with pnpm 10
- PostgreSQL only for the PostgreSQL verification gate or a deployed platform

Install the workspace from this directory:

```sh
corepack pnpm install
```

The root workspace owns all framework and example packages. The counter
example is intentionally part of this workspace; it has no nested lockfile or
independent package installation.

## Development

Run the framework checks with:

```sh
corepack pnpm verify:platform
```

This verifies only `common/*`, `platform/*`, and the empty platform apps. The
PostgreSQL gate creates a temporary local cluster and never uses an inherited
application database URL:

```sh
corepack pnpm verify:platform:postgres
```

The counter example can be developed locally with `corepack pnpm --dir
examples/counter dev` after the framework packages have been built. See
[`docs/development.md`](docs/development.md) for the game-package boundary
and release workflow.

## Independent platform

The standalone server reads an explicit `platform.config.json`,
`games.lock.json`, and `PLATFORM_DATABASE_URL`. Run its migration as a separate
job, then start the server:

```sh
corepack pnpm --filter @board-platform/platform-server build
PLATFORM_DATABASE_URL='postgresql://...' \
  corepack pnpm --filter @board-platform/platform-server db:migrate
PLATFORM_DATABASE_URL='postgresql://...' \
  corepack pnpm --filter @board-platform/platform-server start
```

Production TLS, secret resolution, process supervision, and edge routing are
operator responsibilities. See [`docs/operations.md`](docs/operations.md).

## Licensing and attribution

Framework source is GPL-3.0-only. Third-party dependencies keep their own
licenses. The attribution and exclusion boundary is recorded in
[`NOTICE.md`](NOTICE.md); it does not grant rights to game content that is not
present in this repository.
