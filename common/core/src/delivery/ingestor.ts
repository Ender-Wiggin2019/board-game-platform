import type { SessionRoute } from '@board-game/contracts';
import { DeliveryError } from './errors.js';
import {
  assertDeliveryShape,
  assertObject,
  assertRoute,
  assertSource,
  copy,
  DEFAULT_MAX_IDENTIFIER_LENGTH,
  DEFAULT_MAX_PAYLOAD_BYTES,
  sameRoute,
} from './invariants.js';
import type {
  FactDelivery,
  FactDeliveryAck,
  TrustedFactIngestorOptions,
  TrustedSourceIdentity,
} from './types.js';

function normalizeKinds(
  kinds: ReadonlySet<string> | readonly string[],
): ReadonlySet<string> {
  if (!(kinds instanceof Set) && !Array.isArray(kinds))
    throw new DeliveryError(
      'INVALID_ARGUMENT',
      'allowedKinds must be a Set or an array',
    );
  const values = kinds instanceof Set ? [...kinds] : [...kinds];
  if (values.length === 0)
    throw new DeliveryError(
      'INVALID_ARGUMENT',
      'allowedKinds must not be empty',
    );
  const result = new Set<string>();
  for (const kind of values) {
    if (typeof kind !== 'string' || kind.length === 0)
      throw new DeliveryError(
        'INVALID_ARGUMENT',
        'allowedKinds contains an invalid kind',
      );
    result.add(kind);
  }
  return result;
}

function assertMax(value: number, name: string, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum)
    throw new DeliveryError(
      'INVALID_ARGUMENT',
      `${name} must be a positive integer`,
    );
}

export class TrustedFactIngestor {
  private readonly allowedKinds: ReadonlySet<string>;
  private readonly maxPayloadBytes: number;
  private readonly maxIdentifierLength: number;

  constructor(private readonly options: TrustedFactIngestorOptions) {
    assertObject(options, 'options');
    if (!options.inbox || !options.admission)
      throw new DeliveryError(
        'INVALID_ARGUMENT',
        'inbox and admission are required',
      );
    if (typeof options.admission.getAdmission !== 'function')
      throw new DeliveryError(
        'INVALID_ARGUMENT',
        'admission.getAdmission is required',
      );
    if (typeof options.authorizeSource !== 'function')
      throw new DeliveryError(
        'INVALID_ARGUMENT',
        'authorizeSource is required',
      );
    this.allowedKinds = normalizeKinds(options.allowedKinds);
    this.maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    this.maxIdentifierLength =
      options.maxIdentifierLength ?? DEFAULT_MAX_IDENTIFIER_LENGTH;
    assertMax(this.maxPayloadBytes, 'maxPayloadBytes', 0);
    assertMax(this.maxIdentifierLength, 'maxIdentifierLength', 1);
  }

  async ingest(delivery: FactDelivery): Promise<FactDeliveryAck> {
    assertDeliveryShape(
      delivery,
      this.maxPayloadBytes,
      this.maxIdentifierLength,
      this.allowedKinds,
    );
    const authorized = await this.options.authorizeSource(
      copy(delivery.source),
      copy(delivery.route),
    );
    if (authorized === false)
      throw new DeliveryError(
        'SOURCE_UNAUTHORIZED',
        'Authenticated source authorization was rejected',
      );
    const admission = await this.options.admission.getAdmission(
      delivery.route.sessionId,
    );
    if (!admission)
      throw new DeliveryError(
        'ADMISSION_NOT_FOUND',
        `No persisted admission exists for ${delivery.route.sessionId}`,
      );
    if (!sameRoute(admission.route, delivery.route))
      throw new DeliveryError(
        'ROUTE_MISMATCH',
        'Delivery route does not match the persisted match admission',
      );
    const accepted = await this.options.inbox.accept(copy(delivery.fact));
    return {
      envelopeKey: accepted.envelopeKey,
      producerId: accepted.producerId,
      eventId: accepted.eventId,
      digest: accepted.digest,
    };
  }

  /** Structural helper for callers that already have a route and source object. */
  async accept(
    source: TrustedSourceIdentity,
    route: SessionRoute,
    fact: FactDelivery['fact'],
  ): Promise<FactDeliveryAck> {
    assertRoute(route, this.maxIdentifierLength);
    assertSource(source, route, this.maxIdentifierLength);
    return this.ingest({ source, route, fact });
  }
}
