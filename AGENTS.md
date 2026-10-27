# Framework repository guidance

- Require Node.js 22 and use Corepack pnpm.
- Keep `common/*` game-neutral and `platform/*` independent of game source.
- Platform code may consume public manifests, release descriptions, and
  adapters only; it must not import a game engine, game client, cards, or
  private persistence path.
- Use `workspace:*` for packages in this workspace. Do not add nested lockfiles
  or nested workspaces under `examples/`.
- Keep database migrations explicit. Ordinary startup performs readiness checks
  and never changes schemas.
- Preserve recorded session routes and release pins across drain, rollback,
  and restart.
- Do not commit credentials, `.env` files, private keys, production URLs, or
  generated `dist/` output.
- Before handoff, run `corepack pnpm verify:platform`; use
  `corepack pnpm verify:platform:postgres` when database behavior changed.
- Do not claim Docker, browser, or production acceptance unless that exact gate
  was run and its result is recorded in the response.
