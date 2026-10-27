import type { ServerOptions } from 'socket.io';

export interface ISocketIoCompressionConfig {
  readonly enabled: boolean;
  readonly thresholdBytes: number;
  readonly level: number;
  readonly memLevel: number;
  readonly concurrencyLimit: number;
  readonly noContextTakeover: boolean;
}

/** Fixed, bounded compression policy for every platform Socket.IO host. */
export const SOCKET_IO_COMPRESSION_CONFIG: ISocketIoCompressionConfig =
  Object.freeze({
    enabled: true,
    thresholdBytes: 4_096,
    level: 3,
    memLevel: 7,
    concurrencyLimit: 5,
    noContextTakeover: true,
  });

export function resolveSocketIoCompressionConfig(): ISocketIoCompressionConfig {
  return SOCKET_IO_COMPRESSION_CONFIG;
}

export function buildSocketIoServerOptions(
  config: ISocketIoCompressionConfig = SOCKET_IO_COMPRESSION_CONFIG,
): Pick<ServerOptions, 'httpCompression' | 'perMessageDeflate'> {
  if (!config.enabled) {
    return {
      httpCompression: { threshold: config.thresholdBytes },
      perMessageDeflate: false,
    };
  }
  return {
    httpCompression: { threshold: config.thresholdBytes },
    perMessageDeflate: {
      threshold: config.thresholdBytes,
      concurrencyLimit: config.concurrencyLimit,
      clientNoContextTakeover: config.noContextTakeover,
      serverNoContextTakeover: config.noContextTakeover,
      zlibDeflateOptions: {
        level: config.level,
        memLevel: config.memLevel,
      },
    },
  };
}
