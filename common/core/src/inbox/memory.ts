import { createHash } from 'node:crypto';
import {
  canonicalStableStringify,
  type JsonValue,
} from '@board-game/contracts';
import { InboxError } from './errors.js';
import type {
  ConsumeOutcome,
  ConsumerReceipt,
  FactEnvelope,
  InboxCapabilities,
  InboxEffectInput,
  InboxEffectRecord,
  InboxEnvelope,
  InboxStore,
  InboxUnitOfWork,
  ListEffectsOptions,
  ListPendingOptions,
  RetryDeadLettersOptions,
} from './types.js';
import { MAX_INBOX_CONSUMER_ATTEMPTS } from './types.js';

const MAX_BATCH = 1_000;
const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 60_000;

function retryAt(attempts: number, now: number): number {
  const exponent = Math.min(Math.max(attempts - 1, 0), 6);
  return (
    now + Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** exponent)
  );
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function assertObject(value: unknown, name: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new InboxError('INVALID_ARGUMENT', `${name} must be an object`);
}

function assertString(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0)
    throw new InboxError(
      'INVALID_ARGUMENT',
      `${name} must be a non-empty string`,
    );
}

function assertTimestamp(
  value: unknown,
  name: string,
): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new InboxError(
      'INVALID_ARGUMENT',
      `${name} must be a finite timestamp`,
    );
}

function assertNonNegativeInteger(
  value: unknown,
  name: string,
): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new InboxError(
      'INVALID_ARGUMENT',
      `${name} must be a non-negative integer`,
    );
}

function assertPositiveInteger(
  value: unknown,
  name: string,
): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new InboxError(
      'INVALID_ARGUMENT',
      `${name} must be a positive integer`,
    );
}

function assertJson(value: unknown, name: string): asserts value is JsonValue {
  try {
    canonicalStableStringify(value);
  } catch {
    throw new InboxError('INVALID_ARGUMENT', `${name} must be JSON safe`);
  }
}

function assertLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BATCH)
    throw new InboxError(
      'INVALID_ARGUMENT',
      `limit must be an integer between 1 and ${MAX_BATCH}`,
    );
}

function pairKey(left: string, right: string): string {
  return JSON.stringify([left, right]);
}

function envelopeKey(producerId: string, eventId: string): string {
  return Buffer.from(JSON.stringify([producerId, eventId]), 'utf8').toString(
    'base64url',
  );
}

function parseEnvelopeKey(value: string): readonly [string, string] {
  assertString(value, 'envelopeKey');
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new InboxError('INVALID_ARGUMENT', 'envelopeKey is invalid');
  }
  if (
    !Array.isArray(decoded) ||
    decoded.length !== 2 ||
    typeof decoded[0] !== 'string' ||
    typeof decoded[1] !== 'string' ||
    decoded[0].length === 0 ||
    decoded[1].length === 0
  )
    throw new InboxError('INVALID_ARGUMENT', 'envelopeKey is invalid');
  return [decoded[0], decoded[1]];
}

function digestOf(value: JsonValue): string {
  return createHash('sha256')
    .update(canonicalStableStringify(value))
    .digest('hex');
}

function envelopeDigest(envelope: FactEnvelope): string {
  return digestOf({
    producerId: envelope.producerId,
    eventId: envelope.eventId,
    sessionId: envelope.sessionId ?? null,
    kind: envelope.kind,
    schemaVersion: envelope.schemaVersion,
    sourceRelease: envelope.sourceRelease,
    aggregateSequence: envelope.aggregateSequence ?? null,
    occurredAt: envelope.occurredAt ?? null,
    payload: envelope.payload,
  });
}

function effectDigest(payload: JsonValue): string {
  return digestOf(payload);
}

function validateEnvelope(input: FactEnvelope): {
  readonly canonicalDigest: string;
  readonly storedDigest: string;
} {
  assertObject(input, 'envelope');
  assertString(input.producerId, 'producerId');
  assertString(input.eventId, 'eventId');
  if (input.sessionId !== undefined) assertString(input.sessionId, 'sessionId');
  assertString(input.kind, 'kind');
  assertPositiveInteger(input.schemaVersion, 'schemaVersion');
  assertString(input.sourceRelease, 'sourceRelease');
  assertJson(input.payload, 'payload');
  if (input.aggregateSequence !== undefined)
    assertNonNegativeInteger(input.aggregateSequence, 'aggregateSequence');
  if (input.occurredAt !== undefined)
    assertTimestamp(input.occurredAt, 'occurredAt');
  if (input.receivedAt !== undefined)
    assertTimestamp(input.receivedAt, 'receivedAt');
  const canonicalDigest = envelopeDigest(input);
  if (input.digest !== undefined) {
    assertString(input.digest, 'digest');
  }
  return {
    canonicalDigest,
    storedDigest: input.digest ?? canonicalDigest,
  };
}

function validateEffect(effect: InboxEffectInput): void {
  assertObject(effect, 'effect');
  assertString(effect.effectId, 'effectId');
  assertJson(effect.payload, 'effect payload');
  if (effect.createdAt !== undefined)
    assertTimestamp(effect.createdAt, 'effect.createdAt');
}

class Mutex {
  private tail: Promise<void> = Promise.resolve();

  async run<Result>(callback: () => Promise<Result>): Promise<Result> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await callback();
    } finally {
      release();
    }
  }
}

interface MemoryInboxOptions {
  readonly now?: () => number;
}

/** In-process reference implementation with clone-on-read and rollback semantics. */
export class MemoryInboxStore implements InboxStore {
  readonly capabilities: InboxCapabilities = {
    durable: false,
    serializableTransactions: true,
    boundedReads: true,
  };

  private readonly facts = new Map<string, InboxEnvelope>();
  private readonly receipts = new Map<string, ConsumerReceipt>();
  private readonly effects = new Map<string, InboxEffectRecord>();
  private readonly factLocks = new Map<string, Mutex>();
  private readonly consumerLocks = new Map<string, Mutex>();
  private readonly now: () => number;

  constructor(options: MemoryInboxOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  private factLock(key: string): Mutex {
    let lock = this.factLocks.get(key);
    if (!lock) {
      lock = new Mutex();
      this.factLocks.set(key, lock);
    }
    return lock;
  }

  private consumerLock(key: string): Mutex {
    let lock = this.consumerLocks.get(key);
    if (!lock) {
      lock = new Mutex();
      this.consumerLocks.set(key, lock);
    }
    return lock;
  }

  async accept(input: FactEnvelope): Promise<InboxEnvelope> {
    const { canonicalDigest, storedDigest } = validateEnvelope(input);
    const key = pairKey(input.producerId, input.eventId);
    return this.factLock(key).run(async () => {
      const existing = this.facts.get(key);
      if (existing) {
        if (
          envelopeDigest(existing) !== canonicalDigest ||
          (input.digest !== undefined && existing.digest !== input.digest)
        )
          throw new InboxError(
            'IDEMPOTENCY_CONFLICT',
            `Fact ${input.producerId}/${input.eventId} has a different digest`,
          );
        return clone(existing);
      }
      const receivedAt = input.receivedAt ?? this.now();
      assertTimestamp(receivedAt, 'receivedAt');
      const accepted: InboxEnvelope = {
        producerId: input.producerId,
        eventId: input.eventId,
        ...(input.sessionId !== undefined
          ? { sessionId: input.sessionId }
          : {}),
        kind: input.kind,
        schemaVersion: input.schemaVersion,
        sourceRelease: input.sourceRelease,
        payload: clone(input.payload),
        ...(input.aggregateSequence !== undefined
          ? { aggregateSequence: input.aggregateSequence }
          : {}),
        ...(input.occurredAt !== undefined
          ? { occurredAt: input.occurredAt }
          : {}),
        envelopeKey: envelopeKey(input.producerId, input.eventId),
        digest: storedDigest,
        receivedAt,
      };
      this.facts.set(key, clone(accepted));
      return clone(accepted);
    });
  }

  async getEnvelope(key: string): Promise<InboxEnvelope | null> {
    const [producerId, eventId] = parseEnvelopeKey(key);
    const found = this.facts.get(pairKey(producerId, eventId));
    return found ? clone(found) : null;
  }

  async getReceipt(
    consumerKey: string,
    key: string,
  ): Promise<ConsumerReceipt | null> {
    assertString(consumerKey, 'consumerKey');
    const [producerId, eventId] = parseEnvelopeKey(key);
    const canonicalKey = envelopeKey(producerId, eventId);
    const found = this.receipts.get(pairKey(consumerKey, canonicalKey));
    if (!found || found.producerId !== producerId || found.eventId !== eventId)
      return null;
    return clone(found);
  }

  async transactConsume<Result>(
    consumerKey: string,
    key: string,
    callback: (unitOfWork: InboxUnitOfWork) => Promise<Result>,
  ): Promise<ConsumeOutcome<Result>> {
    assertString(consumerKey, 'consumerKey');
    if (typeof callback !== 'function')
      throw new InboxError('INVALID_ARGUMENT', 'callback must be a function');
    const [producerId, eventId] = parseEnvelopeKey(key);
    const canonicalKey = envelopeKey(producerId, eventId);
    const factKey = pairKey(producerId, eventId);
    return this.consumerLock(consumerKey).run(async () => {
      const envelope = this.facts.get(factKey);
      if (!envelope)
        throw new InboxError(
          'ENVELOPE_NOT_FOUND',
          `Envelope ${key} does not exist`,
        );
      const receiptKey = pairKey(consumerKey, canonicalKey);
      const existing = this.receipts.get(receiptKey);
      if (existing?.status === 'completed')
        return { status: 'duplicate', receipt: clone(existing) };
      if (existing?.status === 'dead-letter')
        return { status: 'dead-letter', receipt: clone(existing) };

      const attempts = (existing?.attempts ?? 0) + 1;
      const attemptedAt = this.now();
      assertTimestamp(attemptedAt, 'now');
      const staged = new Map<string, InboxEffectRecord>();
      let open = true;
      const assertOpen = (): void => {
        if (!open)
          throw new InboxError(
            'DATABASE_ERROR',
            'The inbox unit of work is closed',
            false,
          );
      };
      const unitOfWork: InboxUnitOfWork = {
        envelope: clone(envelope),
        appendEffect: async (input) => {
          assertOpen();
          validateEffect(input);
          const effectKey = pairKey(consumerKey, input.effectId);
          const digest = effectDigest(input.payload);
          const existingEffect =
            staged.get(effectKey) ?? this.effects.get(effectKey);
          if (existingEffect) {
            if (
              existingEffect.producerId !== producerId ||
              existingEffect.eventId !== eventId ||
              existingEffect.digest !== digest
            )
              throw new InboxError(
                'IDEMPOTENCY_CONFLICT',
                `Effect ${consumerKey}/${input.effectId} conflicts with a prior effect`,
              );
            return clone(existingEffect);
          }
          const createdAt = input.createdAt ?? this.now();
          assertTimestamp(createdAt, 'effect.createdAt');
          const record: InboxEffectRecord = {
            consumerKey,
            envelopeKey: canonicalKey,
            producerId,
            eventId,
            effectId: input.effectId,
            digest,
            payload: clone(input.payload),
            createdAt,
          };
          staged.set(effectKey, clone(record));
          return clone(record);
        },
      };

      try {
        const result = await callback(unitOfWork);
        open = false;
        const completedAt = this.now();
        assertTimestamp(completedAt, 'completedAt');
        for (const [effectKey, effect] of staged) {
          const already = this.effects.get(effectKey);
          if (already) {
            if (
              already.producerId !== effect.producerId ||
              already.eventId !== effect.eventId ||
              already.digest !== effect.digest
            )
              throw new InboxError(
                'IDEMPOTENCY_CONFLICT',
                `Effect ${effect.consumerKey}/${effect.effectId} conflicts with a prior effect`,
              );
          }
        }
        for (const [effectKey, effect] of staged) {
          if (!this.effects.has(effectKey))
            this.effects.set(effectKey, clone(effect));
        }
        const completed: ConsumerReceipt = {
          consumerKey,
          envelopeKey: canonicalKey,
          producerId,
          eventId,
          status: 'completed',
          attempts,
          lastAttemptAt: attemptedAt,
          completedAt,
        };
        this.receipts.set(receiptKey, clone(completed));
        return { status: 'processed', receipt: clone(completed), result };
      } catch (error) {
        open = false;
        const deadLettered = attempts >= MAX_INBOX_CONSUMER_ATTEMPTS;
        const failed: ConsumerReceipt = {
          consumerKey,
          envelopeKey: canonicalKey,
          producerId,
          eventId,
          status: deadLettered ? 'dead-letter' : 'failed',
          attempts,
          lastAttemptAt: attemptedAt,
          ...(deadLettered
            ? {}
            : { nextAttemptAt: retryAt(attempts, attemptedAt) }),
        };
        this.receipts.set(receiptKey, clone(failed));
        throw error;
      }
    });
  }

  async consumeOnce<Result>(
    consumerKey: string,
    key: string,
    callback: (unitOfWork: InboxUnitOfWork) => Promise<Result>,
  ): Promise<ConsumeOutcome<Result>> {
    return this.transactConsume(consumerKey, key, callback);
  }

  async listEffects(
    consumerKey: string,
    options: ListEffectsOptions = {},
  ): Promise<readonly InboxEffectRecord[]> {
    assertString(consumerKey, 'consumerKey');
    assertObject(options, 'options');
    const limit = options.limit ?? MAX_BATCH;
    assertLimit(limit);
    let envelopeFilter: readonly [string, string] | undefined;
    if (options.envelopeKey !== undefined)
      envelopeFilter = parseEnvelopeKey(options.envelopeKey);
    return [...this.effects.values()]
      .filter(
        (effect) =>
          effect.consumerKey === consumerKey &&
          (envelopeFilter === undefined ||
            (effect.producerId === envelopeFilter[0] &&
              effect.eventId === envelopeFilter[1])),
      )
      .sort(
        (left, right) =>
          left.createdAt - right.createdAt ||
          left.effectId.localeCompare(right.effectId),
      )
      .slice(0, limit)
      .map(clone);
  }

  async listPending(
    consumerKey: string,
    options: ListPendingOptions,
  ): Promise<readonly InboxEnvelope[]> {
    assertString(consumerKey, 'consumerKey');
    assertObject(options, 'options');
    assertLimit(options.limit);
    const now = options.now ?? this.now();
    assertTimestamp(now, 'now');
    return [...this.facts.values()]
      .filter((fact) => {
        const receipt = this.receipts.get(
          pairKey(consumerKey, fact.envelopeKey),
        );
        return (
          receipt?.status !== 'completed' &&
          receipt?.status !== 'dead-letter' &&
          (receipt?.nextAttemptAt === undefined || receipt.nextAttemptAt <= now)
        );
      })
      .sort(
        (left, right) =>
          left.receivedAt - right.receivedAt ||
          left.envelopeKey.localeCompare(right.envelopeKey),
      )
      .slice(0, options.limit)
      .map(clone);
  }

  async retryDeadLetters(
    consumerKey: string,
    options: RetryDeadLettersOptions,
  ): Promise<number> {
    assertString(consumerKey, 'consumerKey');
    assertObject(options, 'options');
    assertLimit(options.limit);
    const now = options.now ?? this.now();
    assertTimestamp(now, 'now');
    return this.consumerLock(consumerKey).run(async () => {
      const candidates = [...this.receipts.values()]
        .filter(
          (receipt) =>
            receipt.consumerKey === consumerKey &&
            receipt.status === 'dead-letter',
        )
        .sort(
          (left, right) =>
            left.lastAttemptAt - right.lastAttemptAt ||
            left.envelopeKey.localeCompare(right.envelopeKey),
        )
        .slice(0, options.limit);
      for (const receipt of candidates) {
        this.receipts.set(
          pairKey(consumerKey, receipt.envelopeKey),
          clone({
            ...receipt,
            status: 'failed',
            nextAttemptAt: now,
          }),
        );
      }
      return candidates.length;
    });
  }

  async close(): Promise<void> {
    // The memory driver owns no external resources.
  }
}
