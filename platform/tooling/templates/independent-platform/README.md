# Independent platform configuration

This workspace contains configuration, immutable release references and secret references. It does not contain platform or game source.

Install an exact `@board-platform/cli` version or a locally verified tarball. `bgp platform init . --empty` creates a zero-game configuration; omit `--empty` for a managed-game example. Replace example image/artifact digests before use. The platform and lock must name the same platform image and game releases.

## Empty platform

Use `compose.platform.yaml` (also copied as `compose.yaml` by `--empty`). Supply the server/client image digests, an independently owned PostgreSQL database, JWT secret and Ed25519 signing key through the environment described in `.env.example`. The image in `platform.config.json` must match `PLATFORM_SERVER_IMAGE`. Keep private values outside version control.

```sh
bgp platform init ./operations --empty
cd operations
# After setting explicit environment values and reviewing the images:
docker compose -f compose.platform.yaml run --rm migrate
docker compose -f compose.platform.yaml up --detach platform web
```

The migration service uses only the platform database. Web binds to localhost port 8080; production TLS is supplied by the operator's edge proxy. `/health/ready` is the API readiness endpoint. Platform APIs have the `/api` prefix. This repository's local acceptance uses fresh PostgreSQL and Node processes; Docker acceptance remains a separate gate.

## One game release

The example's `runtime/example-v1.json` is the same configuration consumed by a managed or external game process through `GAME_RUNTIME_CONFIG`. `platformConnection.apiUrlEnv` names the **fact ingress URL**, not the platform's account API URL. The audience must match `PLATFORM_PLAYER_AUDIENCE`. The default example uses one internal credential per immutable binding; it is never sent to browsers. If separate fact/auth credentials are configured, supply the corresponding explicit platform credential adapters as well.

```sh
bgp platform deployment plan example --workspace .
bgp platform game deploy example --platform-id my-platform --dry-run --json
# Execute only the reviewed target service:
bgp platform game deploy example --platform-id my-platform --json
```

Deploy writes the exact generated Compose plan to `deployments/<versioned-service>.compose.yaml` before invoking `up --detach --no-deps <service>`. Retrying identical contents is safe; different contents at that path are rejected. The plan includes the read-only runtime file, secret/env references and process resource limits. It joins the named platform Compose project. Configure the edge proxy to reach the game player listener on that network; control and authorization listeners stay internal. `external` entries are registered through their operator-supplied endpoints and cannot be started by this Compose command.

## Registration and channel changes

```sh
bgp platform game register release-registration.json --platform-id my-platform --platform-url https://platform.example/api --platform-token-ref env:BGP_ADMIN_TOKEN --json
bgp platform game ready example-v1-backend --platform-id my-platform --platform-url https://platform.example/api --platform-token-ref env:BGP_ADMIN_TOKEN
bgp platform game activate example-v1-backend --platform-id my-platform --platform-url https://platform.example/api --platform-token-ref env:BGP_ADMIN_TOKEN
bgp platform game switch example standard example-v1-backend --expected-revision 0 --platform-id my-platform --platform-url https://platform.example/api --platform-token-ref env:BGP_ADMIN_TOKEN
```

`ready` probes and loads the deployed binding. `activate` is an alias for the same idempotent readiness-and-load action. `switch` changes only the named new-session channel with compare-and-swap; `rollback` uses the same operation with the chosen retained binding. Existing sessions keep their original release, storage and ownership pins. `drain` stops new use after channels have moved. Review the management API/UI audit and export a config difference before reconciling the configuration repository.

`release publish <packed-directory>` uploads a verified packed release through the HTTP PUT store adapter. Its JSON result returns `clientArtifactBaseUrl` for registration. The store must serve `public/<game>/<release>/<clientDigest>/{client,public}` with the recorded MIME types, enforce immutable conditional writes (409 or 412 on an existing object), allow the chosen browser origin, and require authorization for every `private/` read. Server/private-content bytes are never placed under `public/`. This adapter does not publish npm packages or container images.

Dry-run commands perform local validation only. Planning, export and validation do not deploy, publish or alter the registry. Actual operation commands are explicit and accept `--dry-run`, `--json` and a stable optional `--operation-id`.
