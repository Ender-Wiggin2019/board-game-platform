import type { IncomingMessage } from 'node:http';
import type { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { ServerOptions } from 'socket.io';
import {
  getRuntimeConfig,
  isAllowedOrigin,
  type RuntimeConfig,
} from '../config/runtimeConfig.js';
import {
  buildSocketIoServerOptions,
  resolveSocketIoCompressionConfig,
} from './socketIoCompression.js';

/** Shared Socket.IO transport policy used by all game hosts. */
export class ConfiguredSocketIoAdapter extends IoAdapter {
  public constructor(
    app: INestApplicationContext,
    private readonly config: RuntimeConfig = getRuntimeConfig(),
  ) {
    super(app);
  }

  public override createIOServer(
    port: number,
    options?: ServerOptions,
  ): unknown {
    const compression = buildSocketIoServerOptions(
      resolveSocketIoCompressionConfig(),
    );
    return super.createIOServer(port, {
      ...options,
      ...compression,
      cors: {
        origin: this.config.server.publicOrigin,
        credentials: true,
      },
      allowRequest: (
        request: IncomingMessage,
        callback: (error: string | null | undefined, success: boolean) => void,
      ) => {
        callback(null, isAllowedOrigin(readOrigin(request), this.config));
      },
    });
  }
}

function readOrigin(request: IncomingMessage): string | undefined {
  const origin = request.headers.origin;
  return typeof origin === 'string' ? origin : undefined;
}
