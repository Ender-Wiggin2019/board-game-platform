FROM node:22-bookworm-slim AS build
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY patches ./patches
COPY common ./common
COPY platform ./platform
COPY apps/platform-client ./apps/platform-client
RUN corepack enable \
  && pnpm install --frozen-lockfile \
  && pnpm --filter @board-platform/platform-client... build

FROM nginx:1.28-alpine
ENV PLATFORM_API_UPSTREAM=platform:3000
COPY apps/platform-client/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /workspace/apps/platform-client/dist /usr/share/nginx/html
EXPOSE 80
