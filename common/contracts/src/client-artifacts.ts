import { contractError } from './errors.js';
import {
  assertMatchesSchema,
  type JsonSchema,
  type SchemaDescriptor,
} from './schema.js';

export const REACT_CLIENT_RUNTIME_ABI = 'board-game-react18-v1';
export const IFRAME_CLIENT_RUNTIME_ABI = 'board-game-iframe-v1';

/** Build-time identity only: addresses and trust are supplied by the platform binding. */
export interface ClientRuntimeManifest {
  readonly abiVersion: string;
  readonly format: 'esm' | 'iframe';
  readonly entry: string;
  readonly exportName: string;
  readonly styles: readonly string[];
  readonly shared: readonly {
    readonly specifier: string;
    readonly version: string;
  }[];
}

export interface ClientReleaseLocator {
  readonly schemaVersion: 1;
  readonly gameId: string;
  readonly releaseId: string;
  readonly clientDigest: string;
  readonly publicAssetsDigest: string;
  /** Immutable release root, approved by the platform. Never comes from browser query parameters. */
  readonly baseUrl: string;
  readonly runtime: ClientRuntimeManifest;
}

const text: JsonSchema = { type: 'string', minLength: 1, maxLength: 256 };
export const CLIENT_RUNTIME_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['abiVersion', 'format', 'entry', 'exportName', 'styles', 'shared'],
  properties: {
    abiVersion: text,
    format: { type: 'string', enum: ['esm', 'iframe'] },
    entry: text,
    exportName: {
      type: 'string',
      pattern: '^[A-Za-z_$][A-Za-z0-9_$]*$',
      maxLength: 128,
    },
    styles: { type: 'array', items: text, maxItems: 64 },
    shared: {
      type: 'array',
      maxItems: 256,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['specifier', 'version'],
        properties: {
          specifier: text,
          version: {
            type: 'string',
            pattern: '^\\d+\\.\\d+\\.\\d+(?:-[A-Za-z0-9.-]+)?$',
            maxLength: 128,
          },
        },
      },
    },
  },
};
const runtimeSchema: SchemaDescriptor = {
  name: 'client.runtime',
  version: 1,
  maxBytes: 32 * 1024,
  schema: CLIENT_RUNTIME_SCHEMA,
};
const locatorSchema: SchemaDescriptor = {
  name: 'client.release-locator',
  version: 1,
  maxBytes: 40 * 1024,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: [
      'schemaVersion',
      'gameId',
      'releaseId',
      'clientDigest',
      'publicAssetsDigest',
      'baseUrl',
      'runtime',
    ],
    properties: {
      schemaVersion: { type: 'integer', minimum: 1, maximum: 1 },
      gameId: text,
      releaseId: text,
      clientDigest: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
      publicAssetsDigest: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
      baseUrl: { type: 'string', minLength: 1, maxLength: 2048 },
      runtime: CLIENT_RUNTIME_SCHEMA,
    },
  },
};

export function assertClientArtifactPath(path: string): void {
  if (
    !/^[A-Za-z0-9_][A-Za-z0-9_ ./-]*$/.test(path) ||
    path
      .split('/')
      .some(
        (part) =>
          !part || part === '.' || part === '..' || part.trim() !== part,
      )
  )
    throw contractError('INVALID_REQUEST', 'client.artifact.path_invalid');
}

export function assertClientRuntimeManifest(
  value: unknown,
): asserts value is ClientRuntimeManifest {
  assertMatchesSchema(value, runtimeSchema);
  const manifest = value as unknown as ClientRuntimeManifest;
  for (const path of [manifest.entry, ...manifest.styles])
    assertClientArtifactPath(path);
  if (
    new Set(manifest.styles).size !== manifest.styles.length ||
    new Set(manifest.shared.map((item) => item.specifier)).size !==
      manifest.shared.length
  )
    throw contractError('INVALID_REQUEST', 'client.runtime.duplicate');
  if (manifest.format === 'iframe' && manifest.shared.length !== 0)
    throw contractError(
      'INVALID_REQUEST',
      'client.runtime.iframe_shared_forbidden',
    );
}

export function assertClientReleaseLocator(
  value: unknown,
  allowInsecureLocalhost = false,
): asserts value is ClientReleaseLocator {
  assertMatchesSchema(value, locatorSchema);
  const locator = value as unknown as ClientReleaseLocator;
  assertClientRuntimeManifest(locator.runtime);
  let url: URL;
  try {
    url = new URL(locator.baseUrl);
  } catch {
    throw contractError('INVALID_REQUEST', 'client.artifact.url_invalid');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' &&
      !(allowInsecureLocalhost && local && url.protocol === 'http:')) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.endsWith('/')
  )
    throw contractError('INVALID_REQUEST', 'client.artifact.url_invalid');
  const expected = `/${encodeURIComponent(locator.gameId)}/${encodeURIComponent(locator.releaseId)}/${locator.clientDigest.slice(7)}/`;
  if (!url.pathname.endsWith(expected))
    throw contractError(
      'INVALID_REQUEST',
      'client.artifact.release_path_required',
    );
}

/** Relative assets can never escape their immutable release root. */
export function clientArtifactUrl(
  locator: ClientReleaseLocator,
  path: string,
): string {
  assertClientArtifactPath(path);
  return new URL(path, locator.baseUrl).href;
}

export function clientReleaseKey(locator: ClientReleaseLocator): string {
  return JSON.stringify([
    locator.gameId,
    locator.releaseId,
    locator.runtime.abiVersion,
    locator.clientDigest,
  ]);
}
