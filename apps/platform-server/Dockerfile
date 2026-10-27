FROM node:22-bookworm-slim AS build

WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY patches ./patches
COPY common ./common
COPY platform ./platform
COPY apps/platform-server ./apps/platform-server

RUN corepack enable \
  && pnpm install --config.inject-workspace-packages=true --lockfile-only --offline --ignore-scripts --no-frozen-lockfile \
  && pnpm install --config.inject-workspace-packages=true --frozen-lockfile \
  && pnpm --filter @board-platform/platform-server... build \
  && pnpm --config.inject-workspace-packages=true deploy --filter @board-platform/platform-server --prod /out

FROM node:22-bookworm-slim

ARG PLATFORM_SERVER_VERSION=0.1.0
LABEL org.opencontainers.image.title="Board Game Utopia independent platform server" \
  org.opencontainers.image.version="$PLATFORM_SERVER_VERSION"

WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /out ./
COPY --from=build /workspace/apps/platform-server/drizzle ./drizzle

EXPOSE 3000 3003
CMD ["node", "dist/main.js"]
