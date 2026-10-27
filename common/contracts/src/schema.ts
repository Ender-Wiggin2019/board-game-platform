import { PlatformError } from './errors.js';
import { isJsonValue, type JsonValue, jsonByteLength } from './json.js';

export type JsonSchema =
  | { readonly type: 'any' }
  | { readonly type: 'null' }
  | { readonly type: 'boolean' }
  | {
      readonly type: 'number' | 'integer';
      readonly minimum?: number;
      readonly maximum?: number;
    }
  | {
      readonly type: 'string';
      readonly enum?: readonly string[];
      readonly minLength?: number;
      readonly maxLength?: number;
      readonly pattern?: string;
    }
  | {
      readonly type: 'array';
      readonly items?: JsonSchema;
      readonly minItems?: number;
      readonly maxItems?: number;
    }
  | {
      readonly type: 'object';
      readonly properties?: Readonly<Record<string, JsonSchema>>;
      readonly required?: readonly string[];
      readonly additionalProperties?: boolean | JsonSchema;
      readonly minProperties?: number;
      readonly maxProperties?: number;
    };

export interface SchemaDescriptor {
  readonly name: string;
  readonly version: number;
  readonly schema: JsonSchema;
  readonly maxBytes?: number;
}

export interface ValidationIssue {
  readonly path: string;
  readonly code:
    | 'type'
    | 'required'
    | 'enum'
    | 'range'
    | 'pattern'
    | 'unknownProperty'
    | 'schema';
  readonly messageKey: string;
}

function issue(
  path: string,
  code: ValidationIssue['code'],
  messageKey: string,
): ValidationIssue {
  return { path, code, messageKey };
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

const MAX_SCHEMA_DEPTH = 64;
const MAX_SCHEMA_NODES = 10_000;
const MAX_VALIDATION_ISSUES = 1000;

function isDenseStringArray(value: unknown): value is readonly string[] {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index) || typeof value[index] !== 'string')
      return false;
  }
  return true;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function ownValue(value: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(value, key) ? value[key] : undefined;
}

function isJsonSchemaInternal(
  value: unknown,
  seen: Set<object>,
  depth: number,
  budget: { remaining: number },
): value is JsonSchema {
  if (
    depth > MAX_SCHEMA_DEPTH ||
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value)
  )
    return false;
  budget.remaining -= 1;
  if (budget.remaining < 0) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (!Object.hasOwn(candidate, 'type') || typeof candidate.type !== 'string') {
    seen.delete(value);
    return false;
  }
  if (Object.keys(candidate).some((key) => candidate[key] === undefined)) {
    seen.delete(value);
    return false;
  }

  let valid = false;

  switch (candidate.type) {
    case 'any':
    case 'null':
    case 'boolean':
      valid = hasOnlyKeys(candidate, ['type']);
      break;
    case 'number':
    case 'integer': {
      const minimum = ownValue(candidate, 'minimum');
      const maximum = ownValue(candidate, 'maximum');
      valid =
        hasOnlyKeys(candidate, ['type', 'minimum', 'maximum']) &&
        (minimum === undefined || isNumber(minimum)) &&
        (maximum === undefined || isNumber(maximum)) &&
        (minimum === undefined ||
          maximum === undefined ||
          (isNumber(minimum) && isNumber(maximum) && minimum <= maximum));
      break;
    }
    case 'string': {
      const enumValue = ownValue(candidate, 'enum');
      const minLength = ownValue(candidate, 'minLength');
      const maxLength = ownValue(candidate, 'maxLength');
      const pattern = ownValue(candidate, 'pattern');
      valid =
        hasOnlyKeys(candidate, [
          'type',
          'enum',
          'minLength',
          'maxLength',
          'pattern',
        ]) &&
        (enumValue === undefined ||
          (Array.isArray(enumValue) && isDenseStringArray(enumValue))) &&
        (minLength === undefined || isNonNegativeInteger(minLength)) &&
        (maxLength === undefined || isNonNegativeInteger(maxLength)) &&
        (minLength === undefined ||
          maxLength === undefined ||
          (typeof minLength === 'number' &&
            typeof maxLength === 'number' &&
            minLength <= maxLength)) &&
        (pattern === undefined || typeof pattern === 'string');
      if (valid && typeof pattern === 'string') {
        try {
          new RegExp(pattern, 'u');
        } catch {
          valid = false;
        }
      }
      break;
    }
    case 'array': {
      const minItems = ownValue(candidate, 'minItems');
      const maxItems = ownValue(candidate, 'maxItems');
      valid =
        hasOnlyKeys(candidate, ['type', 'items', 'minItems', 'maxItems']) &&
        (ownValue(candidate, 'items') === undefined ||
          isJsonSchemaInternal(
            ownValue(candidate, 'items'),
            seen,
            depth + 1,
            budget,
          )) &&
        (minItems === undefined || isNonNegativeInteger(minItems)) &&
        (maxItems === undefined || isNonNegativeInteger(maxItems)) &&
        (minItems === undefined ||
          maxItems === undefined ||
          (typeof minItems === 'number' &&
            typeof maxItems === 'number' &&
            minItems <= maxItems));
      break;
    }
    case 'object': {
      const minProperties = ownValue(candidate, 'minProperties');
      const maxProperties = ownValue(candidate, 'maxProperties');
      if (
        !hasOnlyKeys(candidate, [
          'type',
          'properties',
          'required',
          'additionalProperties',
          'minProperties',
          'maxProperties',
        ])
      ) {
        seen.delete(value);
        return false;
      }
      if (
        (minProperties !== undefined &&
          (typeof minProperties !== 'number' ||
            !isNonNegativeInteger(minProperties))) ||
        (maxProperties !== undefined &&
          (typeof maxProperties !== 'number' ||
            !isNonNegativeInteger(maxProperties))) ||
        (minProperties !== undefined &&
          maxProperties !== undefined &&
          typeof minProperties === 'number' &&
          typeof maxProperties === 'number' &&
          minProperties > maxProperties)
      ) {
        seen.delete(value);
        return false;
      }
      if (
        ownValue(candidate, 'required') !== undefined &&
        !isDenseStringArray(ownValue(candidate, 'required'))
      ) {
        valid = false;
        break;
      }
      const propertiesValue = ownValue(candidate, 'properties');
      if (propertiesValue !== undefined) {
        if (
          !propertiesValue ||
          typeof propertiesValue !== 'object' ||
          Array.isArray(propertiesValue) ||
          (Object.getPrototypeOf(propertiesValue) !== Object.prototype &&
            Object.getPrototypeOf(propertiesValue) !== null)
        ) {
          seen.delete(value);
          valid = false;
          break;
        }
        if (
          !Object.values(propertiesValue).every((property) =>
            isJsonSchemaInternal(property, seen, depth + 1, budget),
          )
        ) {
          seen.delete(value);
          valid = false;
          break;
        }
      }
      valid =
        ownValue(candidate, 'additionalProperties') === undefined ||
        typeof ownValue(candidate, 'additionalProperties') === 'boolean' ||
        isJsonSchemaInternal(
          ownValue(candidate, 'additionalProperties'),
          seen,
          depth + 1,
          budget,
        );
      break;
    }
    default:
      valid = false;
  }

  seen.delete(value);
  return valid;
}

export function isJsonSchema(value: unknown): value is JsonSchema {
  return isJsonSchemaInternal(value, new Set<object>(), 0, {
    remaining: MAX_SCHEMA_NODES,
  });
}

function validateJsonInternal(
  value: unknown,
  schema: JsonSchema,
  path: string,
  depth: number,
  issues: ValidationIssue[],
): void {
  if (issues.length >= MAX_VALIDATION_ISSUES) return;
  if (depth > MAX_SCHEMA_DEPTH) {
    issues.push(issue(path, 'schema', 'contracts.schema.maxDepth'));
    return;
  }
  if (schema.type === 'any') return;
  if (schema.type === 'null') {
    if (value !== null)
      issues.push(issue(path, 'type', 'contracts.schema.expectedNull'));
    return;
  }
  if (schema.type === 'boolean') {
    if (typeof value !== 'boolean')
      issues.push(issue(path, 'type', 'contracts.schema.expectedBoolean'));
    return;
  }

  if (schema.type === 'number' || schema.type === 'integer') {
    if (
      !isNumber(value) ||
      (schema.type === 'integer' && !Number.isInteger(value))
    ) {
      issues.push(
        issue(
          path,
          'type',
          schema.type === 'integer'
            ? 'contracts.schema.expectedInteger'
            : 'contracts.schema.expectedNumber',
        ),
      );
      return;
    }
    if (schema.minimum !== undefined && value < schema.minimum)
      issues.push(issue(path, 'range', 'contracts.schema.minimum'));
    if (schema.maximum !== undefined && value > schema.maximum)
      issues.push(issue(path, 'range', 'contracts.schema.maximum'));
    return;
  }

  if (schema.type === 'string') {
    if (typeof value !== 'string') {
      issues.push(issue(path, 'type', 'contracts.schema.expectedString'));
      return;
    }
    if (schema.enum && !schema.enum.includes(value))
      issues.push(issue(path, 'enum', 'contracts.schema.enum'));
    if (schema.minLength !== undefined && value.length < schema.minLength)
      issues.push(issue(path, 'range', 'contracts.schema.minLength'));
    if (schema.maxLength !== undefined && value.length > schema.maxLength)
      issues.push(issue(path, 'range', 'contracts.schema.maxLength'));
    if (
      schema.pattern !== undefined &&
      !new RegExp(schema.pattern, 'u').test(value)
    )
      issues.push(issue(path, 'pattern', 'contracts.schema.pattern'));
    return;
  }

  if (schema.type === 'array') {
    if (!Array.isArray(value)) {
      issues.push(issue(path, 'type', 'contracts.schema.expectedArray'));
      return;
    }
    if (schema.minItems !== undefined && value.length < schema.minItems)
      issues.push(issue(path, 'range', 'contracts.schema.minItems'));
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      issues.push(issue(path, 'range', 'contracts.schema.maxItems'));
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        issues.push(
          issue(`${path}[${index}]`, 'type', 'contracts.schema.sparseArray'),
        );
        continue;
      }
      if (issues.length >= MAX_VALIDATION_ISSUES) return;
      if (schema.items)
        validateJsonInternal(
          value[index],
          schema.items,
          `${path}[${index}]`,
          depth + 1,
          issues,
        );
    }
    return;
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    issues.push(issue(path, 'type', 'contracts.schema.expectedObject'));
    return;
  }
  const record = value as Record<string, unknown>;
  if (schema.type !== 'object') return;
  const properties = schema.properties ?? {};
  const keys = Object.keys(record);
  if (schema.minProperties !== undefined && keys.length < schema.minProperties)
    issues.push(issue(path, 'range', 'contracts.schema.minProperties'));
  if (schema.maxProperties !== undefined && keys.length > schema.maxProperties)
    issues.push(issue(path, 'range', 'contracts.schema.maxProperties'));
  for (const required of schema.required ?? []) {
    if (!Object.hasOwn(record, required))
      issues.push(
        issue(`${path}.${required}`, 'required', 'contracts.schema.required'),
      );
  }
  for (const key of keys) {
    const propertySchema = Object.hasOwn(properties, key)
      ? properties[key]
      : undefined;
    if (propertySchema !== undefined) {
      validateJsonInternal(
        record[key],
        propertySchema,
        `${path}.${key}`,
        depth + 1,
        issues,
      );
      continue;
    }
    if (schema.additionalProperties === false) {
      issues.push(
        issue(
          `${path}.${key}`,
          'unknownProperty',
          'contracts.schema.unknownProperty',
        ),
      );
    } else if (
      schema.additionalProperties &&
      typeof schema.additionalProperties === 'object'
    ) {
      validateJsonInternal(
        record[key],
        schema.additionalProperties,
        `${path}.${key}`,
        depth + 1,
        issues,
      );
    }
  }
}

export function validateJson(
  value: unknown,
  schema: JsonSchema,
  path = '$',
): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isJsonSchema(schema))
    return [issue(path, 'schema', 'contracts.schema.invalidSchema')];
  if (!isJsonValue(value))
    return [issue(path, 'type', 'contracts.schema.invalidJson')];
  validateJsonInternal(value, schema, path, 0, issues);
  return issues;
}

export function assertSchemaDescriptor(
  descriptor: SchemaDescriptor,
  path = '$',
): void {
  if (!descriptor || typeof descriptor !== 'object') {
    throw new PlatformError({
      code: 'SCHEMA_VALIDATION_FAILED',
      messageKey: 'contracts.schema.invalidDescriptor',
      retryable: false,
    });
  }
  const descriptorRecord = descriptor as unknown as Record<string, unknown>;
  const maxBytes = Object.hasOwn(descriptorRecord, 'maxBytes')
    ? descriptor.maxBytes
    : undefined;
  if (
    !Object.hasOwn(descriptorRecord, 'name') ||
    !descriptor.name ||
    typeof descriptor.name !== 'string' ||
    !Object.hasOwn(descriptorRecord, 'version') ||
    !Number.isSafeInteger(descriptor.version) ||
    descriptor.version < 1 ||
    (Object.hasOwn(descriptorRecord, 'maxBytes') &&
      descriptor.maxBytes === undefined)
  ) {
    throw new PlatformError({
      code: 'SCHEMA_VALIDATION_FAILED',
      messageKey: 'contracts.schema.invalidDescriptor',
      retryable: false,
      details: { path },
    });
  }
  if (
    !Object.hasOwn(descriptorRecord, 'schema') ||
    !isJsonSchema(descriptor.schema)
  ) {
    throw new PlatformError({
      code: 'SCHEMA_VALIDATION_FAILED',
      messageKey: 'contracts.schema.invalidSchema',
      retryable: false,
      details: { path },
    });
  }
  if (
    maxBytes !== undefined &&
    (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
  ) {
    throw new PlatformError({
      code: 'SCHEMA_VALIDATION_FAILED',
      messageKey: 'contracts.schema.invalidSizeLimit',
      retryable: false,
      details: { path },
    });
  }
}

export function assertMatchesSchema(
  value: unknown,
  descriptor: SchemaDescriptor,
  path = '$',
): asserts value is JsonValue {
  assertSchemaDescriptor(descriptor, path);
  const issues = validateJson(value, descriptor.schema, path);
  if (issues.length > 0) {
    throw new PlatformError({
      code: 'SCHEMA_VALIDATION_FAILED',
      messageKey: 'contracts.schema.invalidValue',
      retryable: false,
      details: {
        issues: issues.map((item) => ({
          path: item.path,
          code: item.code,
          messageKey: item.messageKey,
        })),
      },
    });
  }
  if (descriptor.maxBytes !== undefined) {
    const byteLength = jsonByteLength(value);
    if (byteLength <= descriptor.maxBytes) return;
    throw new PlatformError({
      code: 'PAYLOAD_TOO_LARGE',
      messageKey: 'contracts.schema.payloadTooLarge',
      retryable: false,
      details: {
        maxBytes: descriptor.maxBytes,
        byteLength,
      },
    });
  }
}

/** Validates the descriptor itself without throwing, useful for registration checks. */
export function schemaDescriptorIssues(
  descriptor: unknown,
  path = '$',
): readonly ValidationIssue[] {
  if (!descriptor || typeof descriptor !== 'object')
    return [issue(path, 'schema', 'contracts.schema.invalidDescriptor')];
  const candidate = descriptor as Partial<SchemaDescriptor>;
  const candidateRecord = descriptor as Record<string, unknown>;
  if (
    !Object.hasOwn(candidateRecord, 'name') ||
    typeof candidate.name !== 'string' ||
    candidate.name.length === 0
  )
    return [
      issue(`${path}.name`, 'schema', 'contracts.schema.invalidDescriptor'),
    ];
  if (
    !Object.hasOwn(candidateRecord, 'version') ||
    typeof candidate.version !== 'number' ||
    !Number.isSafeInteger(candidate.version) ||
    candidate.version < 1
  ) {
    return [
      issue(`${path}.version`, 'schema', 'contracts.schema.invalidDescriptor'),
    ];
  }
  if (
    !Object.hasOwn(candidateRecord, 'schema') ||
    !isJsonSchema(candidate.schema)
  )
    return [
      issue(`${path}.schema`, 'schema', 'contracts.schema.invalidSchema'),
    ];
  if (
    Object.hasOwn(candidateRecord, 'maxBytes') &&
    (candidate.maxBytes === undefined ||
      !Number.isSafeInteger(candidate.maxBytes) ||
      candidate.maxBytes < 0)
  ) {
    return [
      issue(`${path}.maxBytes`, 'schema', 'contracts.schema.invalidSizeLimit'),
    ];
  }
  return [];
}
