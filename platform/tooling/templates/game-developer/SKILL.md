---
name: game-developer
description: Develop, package, and verify an independent game with the Board Game Utopia 0.1 SDK, release client artifacts, and the local development Host.
metadata:
  sdk-series: "0.1"
  runtime-protocol: "1"
---

# Independent game developer

Use the `bgp` command from an independent game workspace. The workspace owns
its `game.json`, public client/server packages, and release metadata; it does
not import private source paths from a platform repository.

Install the CLI from the registry or an exact local tarball before the first
run. A generated starter already declares it as a dev dependency:

```sh
pnpm install
# For a pre-publication SDK set, use exact local tarballs instead:
# pnpm add --save-dev /path/to/board-platform-cli-0.1.0.tgz
pnpm exec bgp doctor --workspace .
```

## Local loop

```sh
pnpm exec bgp game init ./my-game --workspace .
pnpm exec bgp game build ./my-game --workspace .
pnpm exec bgp dev ./my-game --profile memory --seed local-v1 --scene smoke --workspace .
```

`bgp dev` starts the loopback development Host described by the game's public
server export. Memory storage is the default; `--profile postgres
--database-url <isolated-url>` is an explicit restart/recovery profile. When
the public client export is native, the command also starts a Vite/HMR shell.
Stop it with `SIGINT`; `--once` checks startup and closes both processes. A
game can be selected from another current directory with `--workspace
<directory>`; relative paths are resolved from that workspace.

## Checks and packaging

```sh
pnpm exec bgp game verify ./my-game --workspace .
pnpm exec bgp game client-build ./my-game ./client-artifacts --release my-game-v1 --workspace .
pnpm exec bgp game export ./my-game ./game-export --mode dist --workspace .
pnpm exec bgp game verify-export ./game-export --offline --workspace .
pnpm exec bgp release validate ./release --workspace .
```

`game verify-export` installs the exported package outside the source tree,
checks public client/server exports, runs Vite and server import checks, and
performs the browser Host smoke when a native client is present. Use
`--package-overrides <json-or-file>` to map framework names to exact local
tarballs before registry publication. It does not replace application
composition, PostgreSQL recovery, mobile/device, capacity, or production
deployment acceptance.

## Independent runtime

The production server export constructs a pure `GameServerDefinition` and uses
`createConfiguredGameProcess` / `runConfiguredGameProcess` from
`@board-game/server`. `GAME_RUNTIME_CONFIG` identifies the game-owned config;
production requires PostgreSQL, immutable release/binding/storage/ownership
pins, an Ed25519 player verification key and an internal service credential.
Control, player and authorization endpoints are distinct listeners. The
platform connection URL is the authenticated fact ingress base URL. Run the
entrypoint with `--migrate` for the explicit game migration job.

The game owns state, receipts, events, outbox and replay. Return JSON service
metadata and public policy facts; do not import platform rule, account or
settlement implementations into the production game graph. Client artwork and
styles resolve through the exact release asset base and are cleaned up when
that client unmounts.

The checks above are local validation and packaging operations. Explicit
operator commands also exist: `release publish` and
`platform game deploy/register/ready/activate/switch/rollback/drain`. Use their
`--dry-run --json` preview within the requested task; export and verification do
not authorize a deployment or publication. Keep runtime configuration and
secrets outside game sources. Use environment variable names
or credential references in deployment configuration, never secret values in
manifests or lock files. The framework packages retain their declared
`GPL-3.0-only` metadata; commercial or closed-source distribution remains a
separate licensing/provenance review.
