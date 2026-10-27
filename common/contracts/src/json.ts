import { PlatformError } from './errors.js';

export type JsonPrimitive = null | boolean | number | string;
export type JsonArray = readonly JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };
export type JsonValue = JsonPrimitive | JsonArray | JsonObject;

const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 1_000_000;

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertJsonValue(
  value: unknown,
  path: string,
  seen: Set<object>,
  depth = 0,
  budget: { remaining: number } = { remaining: MAX_JSON_NODES },
): asserts value is JsonValue {
  if (depth > MAX_JSON_DEPTH) {
    throw new PlatformError({
      code: 'INVALID_REQUEST',
      messageKey: 'contracts.json.maxDepth',
      retryable: false,
      details: { path },
    });
  }
  budget.remaining -= 1;
  if (budget.remaining < 0) {
    throw new PlatformError({
      code: 'INVALID_REQUEST',
      messageKey: 'contracts.json.maxNodes',
      retryable: false,
      details: { path },
    });
  }

  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return;

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new PlatformError({
        code: 'INVALID_REQUEST',
        messageKey: 'contracts.json.nonFiniteNumber',
        retryable: false,
        details: { path },
      });
    }
    return;
  }

  if (typeof value !== 'object' || !value) {
    throw new PlatformError({
      code: 'INVALID_REQUEST',
      messageKey: 'contracts.json.invalidValue',
      retryable: false,
      details: { path },
    });
  }

  if (seen.has(value)) {
    throw new PlatformError({
      code: 'INVALID_REQUEST',
      messageKey: 'contracts.json.circularValue',
      retryable: false,
      details: { path },
    });
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        throw new PlatformError({
          code: 'INVALID_REQUEST',
          messageKey: 'contracts.json.sparseArray',
          retryable: false,
          details: { path },
        });
      }
      assertJsonValue(
        value[index],
        `${path}[${index}]`,
        seen,
        depth + 1,
        budget,
      );
    }
  } else if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      assertJsonValue(value[key], `${path}.${key}`, seen, depth + 1, budget);
    }
  } else {
    throw new PlatformError({
      code: 'INVALID_REQUEST',
      messageKey: 'contracts.json.nonPlainObject',
      retryable: false,
      details: { path },
    });
  }

  seen.delete(value);
}

export function isJsonValue(value: unknown): value is JsonValue {
  try {
    assertJsonValue(value, '$', new Set<object>(), 0, {
      remaining: MAX_JSON_NODES,
    });
    return true;
  } catch {
    return false;
  }
}

function canonicalize(value: JsonValue): string {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;

  const keys = Object.keys(value).sort();
  const object = value as JsonObject;
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`).join(',')}}`;
}

/**
 * Serializes a JSON request deterministically without relying on Node APIs.
 * Object keys are sorted recursively; arrays keep their supplied order.
 */
export function canonicalStableStringify(value: unknown): string {
  assertJsonValue(value, '$', new Set<object>(), 0, {
    remaining: MAX_JSON_NODES,
  });
  return canonicalize(value);
}

/** Alias used by request/command code to make the digest boundary explicit. */
export const serializeCanonicalRequest = canonicalStableStringify;

export function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(canonicalStableStringify(value)).byteLength;
}

export function assertJsonPayloadSize(
  value: unknown,
  maxBytes: number,
  path = '$',
): asserts value is JsonValue {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new PlatformError({
      code: 'INVALID_REQUEST',
      messageKey: 'contracts.json.invalidSizeLimit',
      retryable: false,
      details: { maxBytes },
    });
  }

  const byteLength = jsonByteLength(value);
  if (byteLength > maxBytes) {
    throw new PlatformError({
      code: 'PAYLOAD_TOO_LARGE',
      messageKey: 'contracts.json.payloadTooLarge',
      retryable: false,
      details: { path, maxBytes, byteLength },
    });
  }
}

export const DEFAULT_JSON_LIMITS = Object.freeze({
  commandBytes: 64 * 1024,
  queryBytes: 64 * 1024,
  setupBytes: 256 * 1024,
  viewBytes: 2 * 1024 * 1024,
  resumeBytes: 2 * 1024 * 1024,
});
