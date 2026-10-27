import { describe, expect, it } from 'vitest';
import {
  assertCommandPrecondition,
  assertJsonPayloadSize,
  assertModeDefinition,
  assertSafeCommandReceipt,
  canonicalStableStringify,
  isCommandPrecondition,
  isJsonSchema,
  isJsonValue,
  validateJson,
} from '../src/index.js';

describe('canonical JSON contracts', () => {
  it('sorts object keys recursively while preserving array order', () => {
    expect(canonicalStableStringify({ b: { z: 1, a: 2 }, a: [3, 1] })).toBe(
      '{"a":[3,1],"b":{"a":2,"z":1}}',
    );
    expect(canonicalStableStringify({ value: -0 })).toBe('{"value":0}');
  });

  it('rejects values that cannot be represented as JSON', () => {
    expect(isJsonValue(undefined)).toBe(false);
    expect(isJsonValue(new Date())).toBe(false);
    expect(isJsonValue(Number.NaN)).toBe(false);

    const sparse: unknown[] = [];
    sparse.length = 1;
    expect(isJsonValue(sparse)).toBe(false);
    expect(() => canonicalStableStringify(sparse)).toThrow();
  });

  it('bounds recursive validation and canonicalization', () => {
    let nested: unknown = null;
    for (let index = 0; index < 65; index += 1) nested = { nested };
    expect(isJsonValue(nested)).toBe(false);
    expect(() => canonicalStableStringify(nested)).toThrow();
  });

  it('enforces byte limits before a payload crosses a protocol boundary', () => {
    expect(() => assertJsonPayloadSize({ message: 'hello' }, 4)).toThrowError(
      /payloadTooLarge/,
    );
  });
});

describe('runtime schema validation', () => {
  it('requires JSON even for the any schema', () => {
    expect(validateJson(undefined, { type: 'any' })).toHaveLength(1);
    expect(validateJson(new Date(), { type: 'any' })).toHaveLength(1);
  });

  it('does not treat inherited properties as schema fields or required values', () => {
    const schema = {
      type: 'object' as const,
      properties: { safe: { type: 'string' as const } },
      required: ['toString'],
      additionalProperties: false,
    };
    const missing = validateJson({}, schema);
    expect(
      missing.some(
        (item) => item.code === 'required' && item.path.endsWith('.toString'),
      ),
    ).toBe(true);
    const inheritedLookup = validateJson({ toString: 1 }, schema);
    expect(
      inheritedLookup.some((item) => item.code === 'unknownProperty'),
    ).toBe(true);
  });

  it('rejects sparse schema arrays', () => {
    const enumValues: string[] = [];
    enumValues.length = 1;
    expect(isJsonSchema({ type: 'string', enum: enumValues })).toBe(false);
    expect(isJsonSchema({ type: 'array', items: undefined })).toBe(false);
  });
});

describe('command and receipt boundaries', () => {
  it('requires exactly one command concurrency precondition shape', () => {
    expect(
      isCommandPrecondition({ kind: 'revision', expectedRevision: 2 }),
    ).toBe(true);
    expect(
      isCommandPrecondition({
        kind: 'prompt',
        promptId: 'p-1',
        participantInputRevision: 3,
      }),
    ).toBe(true);
    expect(
      isCommandPrecondition({
        kind: 'revision',
        expectedRevision: 2,
        promptId: 'p-1',
      }),
    ).toBe(false);
    expect(() =>
      assertCommandPrecondition({
        kind: 'prompt',
        promptId: 'p-1',
        participantInputRevision: -1,
      }),
    ).toThrow();
  });

  it('accepts a safe receipt and rejects embedded command or result payloads', () => {
    const receipt = {
      commandId: 'cmd-1',
      sessionId: 'session-1',
      status: 'accepted' as const,
      persistedRevision: 4,
      resultRetention: 'ephemeral-result' as const,
    };
    expect(() => assertSafeCommandReceipt(receipt)).not.toThrow();
    expect(() =>
      assertSafeCommandReceipt({ ...receipt, payload: { secret: true } }),
    ).toThrowError(/unsafeReceipt/);
    expect(() =>
      assertSafeCommandReceipt({ ...receipt, diagnostic: { secret: true } }),
    ).toThrowError(/unsafeReceipt/);
  });
});

describe('mode definitions', () => {
  it('requires explicit concurrency semantics', () => {
    expect(() =>
      assertModeDefinition({
        id: 'solo',
        entry: 'direct-solo',
        minPlayers: 1,
        maxPlayers: 1,
        history: 'progress-only',
        platformRating: false,
        concurrency: 'revision',
      }),
    ).not.toThrow();
    expect(() =>
      assertModeDefinition({
        id: 'bad',
        entry: 'room',
        minPlayers: 2,
        maxPlayers: 2,
        history: 'summary-and-replay',
        platformRating: false,
      }),
    ).toThrow();
  });
});
