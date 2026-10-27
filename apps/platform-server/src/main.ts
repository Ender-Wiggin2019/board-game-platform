import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { applyStandaloneEnvironment, loadStandaloneConfig } from './config.js';

async function bootstrap(): Promise<void> {
  const standalone = await loadStandaloneConfig();
  applyStandaloneEnvironment(standalone);
  const { HttpErrorFilter } = await import(
    '@board-platform/server/shared/errors/HttpErrorFilter.js'
  );
  const { attachAuditRequestId } = await import(
    '@board-platform/server/auth/account-audit-request.js'
  );
  const { ConfiguredSocketIoAdapter } = await import(
    '@board-platform/server/platform/ConfiguredSocketIoAdapter.js'
  );
  const { loadProductionConfig, formatRuntimeConfigSummary } = await import(
    '@board-platform/server/config/runtimeConfig.js'
  );
  const { createStandalonePlatformModule } = await import('./app.module.js');
  const config = loadProductionConfig();
  const module = await createStandalonePlatformModule();
  const app = await NestFactory.create<NestExpressApplication>(module);
  app.set(
    'trust proxy',
    process.env.PLATFORM_TRUST_PROXY?.trim() || 'loopback',
  );
  app.enableShutdownHooks(['SIGINT', 'SIGTERM']);
  app.use(attachAuditRequestId);
  app.useBodyParser('json', { limit: '8mb' });
  app.use(
    (
      request: {
        headers: { cookie?: string };
        cookies?: Record<string, string>;
      },
      _response: unknown,
      next: () => void,
    ) => {
      const cookies: Record<string, string> = Object.create(null);
      for (const part of request.headers.cookie?.split(';') ?? []) {
        const separator = part.indexOf('=');
        if (separator <= 0) continue;
        const name = part.slice(0, separator).trim();
        if (!name || Object.hasOwn(cookies, name)) continue;
        try {
          cookies[name] = decodeURIComponent(part.slice(separator + 1).trim());
        } catch {
          /* Malformed cookie values are ignored and authentication rejects missing proof. */
        }
      }
      request.cookies = cookies;
      next();
    },
  );
  app.enableCors({
    origin: config.server.publicOrigin,
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new HttpErrorFilter());
  app.setGlobalPrefix('api', {
    exclude: ['health', 'health/live', 'health/ready'],
  });
  app.useWebSocketAdapter(new ConfiguredSocketIoAdapter(app, config));
  const host = process.env.PLATFORM_HOST?.trim() || config.server.host;
  await app.listen(config.server.port, host);
  Logger.log(
    `Independent platform server listening on ${host}:${config.server.port} (${formatRuntimeConfigSummary(config)})`,
    'Bootstrap',
  );
}

void bootstrap().catch((error: unknown) => {
  Logger.error(
    error instanceof Error ? error.message : String(error),
    'Bootstrap',
  );
  process.exitCode = 1;
});
