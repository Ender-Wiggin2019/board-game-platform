import { contractError } from './errors.js';
import { assertJsonPayloadSize, isJsonValue, type JsonValue } from './json.js';
import {
  assertMatchesSchema,
  assertSchemaDescriptor,
  type SchemaDescriptor,
} from './schema.js';
import type { AccessContext, ProtocolRequest } from './types.js';
import { assertAccessContext } from './validation.js';

/** The authenticated service-listener operation used by native statistics. */
export const GAME_STATISTICS_BACKEND_OPERATION = 'statistics' as const;
export const GAME_STATISTICS_PROTOCOL_VERSION = 1 as const;

export const GAME_STATISTICS_AUDIENCES = ['self', 'community'] as const;
export type GameStatisticsAudience = (typeof GAME_STATISTICS_AUDIENCES)[number];

const MAX_IDENTIFIER_LENGTH = 256;
const MAX_OPERATION_LENGTH = 128;
const MAX_OPERATIONS = 64;
const MAX_DESCRIPTION_BYTES = 256 * 1024;
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;

export interface GameStatisticsRoute {
  readonly gameId: string;
  readonly releaseId: string;
  readonly backendBindingId: string;
  readonly storageBindingId: string;
  readonly ownershipEpoch: string;
}

export interface GameStatisticsOperationDescription {
  readonly key: string;
  readonly audience: GameStatisticsAudience;
  readonly requestSchema: SchemaDescriptor;
  readonly responseSchema: SchemaDescriptor;
}

/** JSON-only statistics declaration for one exact service release. */
export interface GameServiceStatisticsDescription {
  readonly protocolVersion: typeof GAME_STATISTICS_PROTOCOL_VERSION;
  readonly operations: readonly GameStatisticsOperationDescription[];
}

export interface GameStatisticsServiceRequest extends ProtocolRequest {
  readonly route: GameStatisticsRoute;
  readonly operation: string;
  readonly audience: GameStatisticsAudience;
  /** Injected by the platform service boundary; never accepted from browsers. */
  readonly accessContext: AccessContext;
  readonly query: JsonValue;
}

export interface GameStatisticsServiceResponse {
  readonly operation: string;
  readonly audience: GameStatisticsAudience;
  readonly payload: JsonValue;
}

function invalid(path: string): never {
  throw contractError(
    'INVALID_REQUEST',
    'contracts.statistics.invalid',
    false,
    {
      path,
    },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function identifier(
  value: unknown,
  path: string,
  max = MAX_IDENTIFIER_LENGTH,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > max
  )
    invalid(path);
}

function audience(
  value: unknown,
  path: string,
): asserts value is GameStatisticsAudience {
  if (
    typeof value !== 'string' ||
    !(GAME_STATISTICS_AUDIENCES as readonly string[]).includes(value)
  )
    invalid(path);
}

function strictSchema(
  value: unknown,
  path: string,
): asserts value is SchemaDescriptor {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['name', 'version', 'schema', 'maxBytes'])
  )
    invalid(path);
  assertSchemaDescriptor(value as unknown as SchemaDescriptor, path);
  identifier(value.name, `${path}.name`);
}

function assertOperationDescription(
  value: unknown,
  path: string,
): asserts value is GameStatisticsOperationDescription {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['key', 'audience', 'requestSchema', 'responseSchema'])
  )
    invalid(path);
  identifier(value.key, `${path}.key`, MAX_OPERATION_LENGTH);
  audience(value.audience, `${path}.audience`);
  strictSchema(value.requestSchema, `${path}.requestSchema`);
  strictSchema(value.responseSchema, `${path}.responseSchema`);
}

export function assertGameStatisticsRoute(
  value: unknown,
): asserts value is GameStatisticsRoute {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'gameId',
      'releaseId',
      'backendBindingId',
      'storageBindingId',
      'ownershipEpoch',
    ])
  )
    invalid('$.route');
  identifier(value.gameId, '$.route.gameId');
  identifier(value.releaseId, '$.route.releaseId');
  identifier(value.backendBindingId, '$.route.backendBindingId');
  identifier(value.storageBindingId, '$.route.storageBindingId');
  identifier(value.ownershipEpoch, '$.route.ownershipEpoch');
}

export function assertGameServiceStatisticsDescription(
  value: unknown,
): asserts value is GameServiceStatisticsDescription {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['protocolVersion', 'operations']) ||
    value.protocolVersion !== GAME_STATISTICS_PROTOCOL_VERSION ||
    !Array.isArray(value.operations) ||
    value.operations.length === 0 ||
    value.operations.length > MAX_OPERATIONS
  )
    invalid('$.statistics');
  const keys = new Set<string>();
  for (const [index, operation] of value.operations.entries()) {
    const path = `$.statistics.operations[${index}]`;
    assertOperationDescription(operation, path);
    if (keys.has(operation.key)) invalid(`${path}.key`);
    keys.add(operation.key);
  }
  assertJsonPayloadSize(value, MAX_DESCRIPTION_BYTES, '$.statistics');
}

export function assertGameStatisticsServiceRequest(
  value: unknown,
): asserts value is GameStatisticsServiceRequest {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'protocolVersion',
      'route',
      'operation',
      'audience',
      'accessContext',
      'query',
    ]) ||
    value.protocolVersion !== GAME_STATISTICS_PROTOCOL_VERSION
  )
    invalid('$');
  assertGameStatisticsRoute(value.route);
  identifier(value.operation, '$.operation', MAX_OPERATION_LENGTH);
  audience(value.audience, '$.audience');
  assertAccessContext(value.accessContext);
  if (!isJsonValue(value.query)) invalid('$.query');
  assertJsonPayloadSize(value.query, MAX_REQUEST_BYTES, '$.query');
  assertJsonPayloadSize(value, MAX_REQUEST_BYTES, '$');
}

export function assertGameStatisticsServiceResponse(
  value: unknown,
): asserts value is GameStatisticsServiceResponse {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['operation', 'audience', 'payload'])
  )
    invalid('$');
  identifier(value.operation, '$.operation', MAX_OPERATION_LENGTH);
  audience(value.audience, '$.audience');
  if (!isJsonValue(value.payload)) invalid('$.payload');
  assertJsonPayloadSize(value.payload, MAX_RESPONSE_BYTES, '$.payload');
  assertJsonPayloadSize(value, MAX_RESPONSE_BYTES, '$');
}

export function assertGameStatisticsQuery(
  query: JsonValue,
  descriptor: GameStatisticsOperationDescription,
): void {
  assertMatchesSchema(query, descriptor.requestSchema);
}

export function assertGameStatisticsPayload(
  payload: JsonValue,
  descriptor: GameStatisticsOperationDescription,
): void {
  assertMatchesSchema(payload, descriptor.responseSchema);
}
