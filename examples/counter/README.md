# counter

This is an independently runnable REST-first counter game. It owns the rule
module, server definition, setup schema, undo command, query/replay surface,
terminal result, native client component and deterministic development fixture.
The client entry is loaded by `bgp dev` through a Vite/HMR shell.

```sh
corepack pnpm install
corepack pnpm run build
corepack pnpm dev
```

The dev command starts a loopback memory Host and a native Vite client, then
prints JSON containing both URLs. It does not use Docker or production
credentials. Select one of the fixed player accounts with `POST
/v1/auth/select`, then use the client controls or the rooms and sessions REST
endpoints documented by the development host. One or two player accounts can
join the room; turns alternate between joined players. The `complete` scenario
is available from `GET /v1/scenarios` and can be selected when creating a room.
