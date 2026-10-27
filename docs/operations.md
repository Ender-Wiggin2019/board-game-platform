# Operations

The independent platform is configured by explicit files and environment
references. It does not load `.env` files, a legacy game environment, browser
URLs, or a current game release as an implicit fallback.

## Installation and migration

Prepare a deployment directory containing:

- `platform.config.json`, describing the platform and approved release refs;
- `games.lock.json`, pinning the same release set;
- the versioned platform server and client artifacts;
- secret references resolved by the process supervisor.

Set `PLATFORM_CONFIG_PATH`, `PLATFORM_LOCK_PATH`, and
`PLATFORM_WORKSPACE_ROOT` when these files are outside the process directory.
Set `PLATFORM_DATABASE_URL` explicitly. The platform database is separate from
any game database.

Run the schema migration as a one-shot process before starting the HTTP server:

```sh
corepack pnpm --filter @board-platform/platform-server db:migrate
corepack pnpm --filter @board-platform/platform-server start
```

The server validates readiness and does not perform implicit migrations. Use a
supervisor for restart, bounded health checks, and log retention. The
`templates/independent-platform` files are deployment references; Docker
execution is a separate acceptance gate and is not implied by this source
check.

For a Node-process deployment, `platform.config.json` and `games.lock.json`
may use an immutable `archive` in place of an `image`, for example:

```json
{
  "format": "node-tar",
  "digest": "sha256:<64-hex-digest>",
  "sourceSha": "sha1:<40-hex-commit>"
}
```

The platform and lock entries must carry the same archive identity. The
archive is expected to contain the pinned source ancestry, dependency lock,
built artifacts, and a file-digest manifest; the operator verifies those bytes
and the source commit before installing dependencies or running migration.
An archive is a Node-process artifact, not a container image, and does not
enable implicit startup migration. This public framework does not prescribe a
host, registry, credential, or deployment URL.

## Health and routing

- `/health/live` reports process liveness.
- `/health/ready` reports configuration and database readiness.
- `/api/*` is the authenticated platform API.
- TLS and public DNS belong at the configured edge proxy.

External deployment configuration requires HTTPS for the browser player
endpoint. Control and authorization endpoints may use HTTP on literal loopback
addresses (`127.0.0.1` or `[::1]`) for separate processes on the same host.
The platform runtime still requires `PLATFORM_ALLOW_INSECURE_LOCALHOST=true`
to connect to them; non-loopback HTTP is rejected.

Game session routes must be selected from the persisted release/channel
registry. A browser must not choose an arbitrary backend URL or release. A
session keeps its recorded route and release for its lifetime, including during
drain, rollback, or service restart. Draining stops new admissions but leaves
active sessions and their historical replay references on the old binding.

## Credentials and evidence

Keep service tokens, signing keys, database URLs, and credential references in
the supervisor or secret manager. Never commit them to config, lockfiles,
fixtures, logs, or release artifacts. Readiness for a remote binding requires a
server-owned probe and an approved immutable description; a client assertion is
not evidence.

## PostgreSQL verification

Run the isolated framework gate before a release:

```sh
corepack pnpm verify:platform:postgres
```

It creates a temporary local cluster, exports only `BGP_TEST_DATABASE_URL`, and
stops/removes that cluster after success. Set `BGP_POSTGRES_BIN` when the
PostgreSQL tools are not on `PATH`.
