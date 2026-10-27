import { timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import {
  assertProtocolRequest,
  assertSessionRoute,
  type SessionRoute,
} from '@board-game/contracts';
import type { FactEnvelope } from '../inbox/types.js';
import { DeliveryError, isDeliveryError } from './errors.js';
import { assertObject, assertString, copy } from './invariants.js';
import type {
  FactDelivery,
  FactDeliveryAck,
  TrustedFactIngestorLike,
  TrustedSourceIdentity,
} from './types.js';

const DEFAULT_PATH = '/v1/facts';
const DEFAULT_MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_BATCH = 1_000;

export interface HttpFactIngressCredential {
  readonly token: string;
  readonly platformId: string;
  readonly source: TrustedSourceIdentity;
}

export interface HttpFactIngressServerOptions {
  readonly receiver: TrustedFactIngestorLike;
  /** One bearer token maps to one trusted platform/source identity. */
  readonly credentials?: readonly HttpFactIngressCredential[];
  readonly host?: string;
  readonly port?: number;
  readonly path?: string;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  readonly timeoutMs?: number;
}

export interface HttpFactIngressServerAddress {
  readonly address: string;
  readonly port: number;
}

interface HttpFactWireDelivery {
  readonly route: SessionRoute;
  readonly fact: FactEnvelope;
}

interface HttpFactBatchRequest {
  readonly protocolVersion: 1;
  readonly platformId: string;
  readonly deliveries: readonly HttpFactWireDelivery[];
}

interface HttpFactBatchError {
  readonly index: number;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

interface HttpFactBatchResponse {
  readonly protocolVersion: 1;
  readonly acks: readonly {
    readonly index: number;
    readonly ack: FactDeliveryAck;
  }[];
  readonly errors: readonly HttpFactBatchError[];
}

function invalid(message: string): DeliveryError {
  return new DeliveryError('INVALID_ARGUMENT', message, false);
}

function requireLimit(value: number, name: string, max: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max)
    throw invalid(`${name} must be an integer between 1 and ${max}`);
  return value;
}

function writeJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  maxBytes?: number,
): void {
  const encoded = JSON.stringify(body);
  if (maxBytes !== undefined && Buffer.byteLength(encoded) > maxBytes) {
    response.statusCode = 500;
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({ protocolVersion: 1, error: 'response_too_large' }),
    );
    return;
  }
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.setHeader('content-length', Buffer.byteLength(encoded));
  response.end(encoded);
}

function tokenMatches(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function bearerToken(request: IncomingMessage): string | null {
  const value = request.headers.authorization;
  if (typeof value !== 'string') return null;
  const match = /^Bearer ([^\s]+)$/u.exec(value);
  return match?.[1] ?? null;
}

function readBody(
  request: IncomingMessage,
  maxBytes: number,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      request.destroy();
      reject(new DeliveryError('FACT_REJECTED', 'HTTP request timed out'));
    }, timeoutMs);
    const done = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(Buffer.concat(chunks).toString('utf8'));
    };
    request.on('data', (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += value.length;
      if (bytes > maxBytes) {
        done(
          new DeliveryError(
            'FACT_REJECTED',
            'HTTP request body is too large',
            false,
          ),
        );
        request.destroy();
        return;
      }
      chunks.push(value);
    });
    request.on('end', () => done());
    request.on('error', (error) => done(error));
    request.on('aborted', () =>
      done(new DeliveryError('FACT_REJECTED', 'HTTP request was aborted')),
    );
  });
}

function assertWireDelivery(
  value: unknown,
  index: number,
): asserts value is HttpFactWireDelivery {
  assertObject(value, `deliveries[${index}]`);
  const delivery = value as Partial<HttpFactWireDelivery> & {
    readonly source?: unknown;
  };
  // source mapped from the bearer token and never trusts this field.
  if (Object.hasOwn(delivery, 'source'))
    throw invalid(`deliveries[${index}].source is not accepted`);
  if (!delivery.route || !delivery.fact)
    throw invalid(`deliveries[${index}] must contain route and fact`);
  try {
    assertSessionRoute(delivery.route);
  } catch {
    throw new DeliveryError(
      'ROUTE_MISMATCH',
      `deliveries[${index}].route is invalid`,
      false,
    );
  }
  assertObject(delivery.fact, `deliveries[${index}].fact`);
}

function parseBatch(value: unknown): HttpFactBatchRequest {
  assertObject(value, 'request');
  assertProtocolRequest(value);
  const request = value as Partial<HttpFactBatchRequest>;
  assertString(request.platformId, 'platformId');
  if (
    !Array.isArray(request.deliveries) ||
    request.deliveries.length < 1 ||
    request.deliveries.length > MAX_BATCH
  )
    throw invalid(`deliveries must contain between 1 and ${MAX_BATCH} items`);
  request.deliveries.forEach(assertWireDelivery);
  return {
    protocolVersion: 1,
    platformId: request.platformId,
    deliveries: copy(request.deliveries),
  };
}

function responseError(error: unknown): Omit<HttpFactBatchError, 'index'> {
  if (isDeliveryError(error))
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  return {
    code: 'FACT_REJECTED',
    message: 'Fact receiver unavailable',
    retryable: true,
  };
}

function clientError(value: HttpFactBatchError): DeliveryError {
  const known: ConstructorParameters<typeof DeliveryError>[0][] = [
    'INVALID_ARGUMENT',
    'SOURCE_UNAUTHORIZED',
    'ADMISSION_NOT_FOUND',
    'ROUTE_MISMATCH',
    'FACT_REJECTED',
    'CONSUMER_NOT_REGISTERED',
    'CONSUMER_ALREADY_REGISTERED',
  ];
  const code = known.includes(value.code as (typeof known)[number])
    ? (value.code as (typeof known)[number])
    : 'FACT_REJECTED';
  return new DeliveryError(code, value.message, value.retryable);
}

/** Small Node HTTP server that turns authenticated requests into trusted Inbox deliveries. */
export class HttpFactIngressServer {
  readonly server: Server;
  private credentials: readonly HttpFactIngressCredential[];
  private readonly path: string;
  private readonly host: string;
  private readonly port: number;
  private readonly maxRequestBytes: number;
  private readonly maxResponseBytes: number;
  private readonly timeoutMs: number;
  private listening = false;

  constructor(private readonly options: HttpFactIngressServerOptions) {
    if (
      !options ||
      typeof options !== 'object' ||
      !options.receiver ||
      typeof options.receiver.ingest !== 'function'
    )
      throw invalid('receiver.ingest is required');
    this.credentials = HttpFactIngressServer.validateCredentials(
      options.credentials,
    );
    this.path = options.path ?? DEFAULT_PATH;
    if (!this.path.startsWith('/')) throw invalid('path must start with /');
    this.host = options.host ?? '127.0.0.1';
    this.port = options.port ?? 0;
    if (!Number.isSafeInteger(this.port) || this.port < 0 || this.port > 65_535)
      throw invalid('port must be between 0 and 65535');
    this.maxRequestBytes = requireLimit(
      options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES,
      'maxRequestBytes',
      32 * 1024 * 1024,
    );
    this.maxResponseBytes = requireLimit(
      options.maxResponseBytes ?? DEFAULT_MAX_REQUEST_BYTES,
      'maxResponseBytes',
      32 * 1024 * 1024,
    );
    this.timeoutMs = requireLimit(
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      'timeoutMs',
      300_000,
    );
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
    this.server.requestTimeout = this.timeoutMs;
    this.server.headersTimeout = this.timeoutMs;
  }

  private static validateCredentials(
    credentials: readonly HttpFactIngressCredential[] | undefined,
  ): readonly HttpFactIngressCredential[] {
    if (!credentials || credentials.length === 0)
      throw invalid('at least one HTTP ingress credential is required');
    const tokens = new Set<string>();
    return credentials.map((credential) => {
      assertObject(credential, 'credential');
      assertString(credential.token, 'credential.token');
      if (credential.token.length < 32)
        throw invalid('credential.token must contain at least 32 characters');
      assertString(credential.platformId, 'credential.platformId');
      assertObject(credential.source, 'credential.source');
      if (tokens.has(credential.token))
        throw invalid('credential tokens must be unique');
      tokens.add(credential.token);
      return copy(credential);
    });
  }

  /** Replaces trusted token mappings without restarting the listening socket. */
  updateCredentials(credentials: readonly HttpFactIngressCredential[]): void {
    this.credentials = HttpFactIngressServer.validateCredentials(credentials);
  }

  async listen(): Promise<HttpFactIngressServerAddress> {
    if (this.listening) {
      const address = this.server.address();
      if (!address || typeof address === 'string')
        throw new Error('HTTP server has no address');
      return { address: address.address, port: address.port };
    }
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off('error', onError);
        this.listening = true;
        resolve();
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(this.port, this.host);
    });
    const address = this.server.address();
    if (!address || typeof address === 'string')
      throw new Error('HTTP server has no address');
    return { address: address.address, port: address.port };
  }

  async close(): Promise<void> {
    if (!this.listening) return;
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
    this.listening = false;
  }

  private credential(token: string): HttpFactIngressCredential | null {
    for (const candidate of this.credentials) {
      if (tokenMatches(candidate.token, token)) return candidate;
    }
    return null;
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (request.url !== this.path) {
      writeJson(
        response,
        404,
        { protocolVersion: 1, error: 'not_found' },
        this.maxResponseBytes,
      );
      return;
    }
    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST');
      writeJson(
        response,
        405,
        { protocolVersion: 1, error: 'method_not_allowed' },
        this.maxResponseBytes,
      );
      return;
    }
    const token = bearerToken(request);
    const credential = token ? this.credential(token) : null;
    if (!credential) {
      writeJson(
        response,
        401,
        { protocolVersion: 1, error: 'unauthorized' },
        this.maxResponseBytes,
      );
      return;
    }
    if (
      request.headers['content-type']?.split(';', 1)[0] !== 'application/json'
    ) {
      writeJson(
        response,
        415,
        { protocolVersion: 1, error: 'content_type_required' },
        this.maxResponseBytes,
      );
      return;
    }
    try {
      const body = parseBatch(
        JSON.parse(
          await readBody(request, this.maxRequestBytes, this.timeoutMs),
        ),
      );
      if (body.platformId !== credential.platformId) {
        writeJson(
          response,
          403,
          { protocolVersion: 1, error: 'platform_mismatch' },
          this.maxResponseBytes,
        );
        return;
      }
      const acks: { index: number; ack: FactDeliveryAck }[] = [];
      const errors: HttpFactBatchError[] = [];
      for (let index = 0; index < body.deliveries.length; index += 1) {
        const delivery = body.deliveries[index];
        try {
          const ack = await this.options.receiver.ingest({
            source: copy(credential.source),
            route: copy(delivery.route),
            fact: copy(delivery.fact),
          });
          acks.push({ index, ack: copy(ack) });
        } catch (error) {
          errors.push({ index, ...responseError(error) });
        }
      }
      const result: HttpFactBatchResponse = {
        protocolVersion: 1,
        acks,
        errors,
      };
      writeJson(response, 200, result, this.maxResponseBytes);
    } catch (error) {
      const status =
        isDeliveryError(error) && error.message.includes('too large')
          ? 413
          : 400;
      writeJson(
        response,
        status,
        { protocolVersion: 1, error: responseError(error) },
        this.maxResponseBytes,
      );
    }
  }
}

export interface HttpFactIngressClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly platformId: string;
  /** Optional local assertion; the server maps the token to the trusted source. */
  readonly source?: TrustedSourceIdentity;
  readonly timeoutMs?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  readonly fetchImpl?: typeof fetch;
  /** Allows plain HTTP only for loopback development servers. */
  readonly allowInsecureLocalhost?: boolean;
  readonly path?: string;
}

export class HttpFactIngressClient implements TrustedFactIngestorLike {
  private readonly baseUrl: URL;
  private readonly timeoutMs: number;
  private readonly maxRequestBytes: number;
  private readonly maxResponseBytes: number;
  private readonly fetchImpl: typeof fetch;
  private readonly path: string;

  constructor(private readonly options: HttpFactIngressClientOptions) {
    assertString(options.baseUrl, 'baseUrl');
    assertString(options.token, 'token');
    if (options.token.length < 32)
      throw invalid('token must contain at least 32 characters');
    assertString(options.platformId, 'platformId');
    if (options.source !== undefined) assertObject(options.source, 'source');
    try {
      this.baseUrl = new URL(options.baseUrl);
    } catch {
      throw invalid('baseUrl must be an absolute URL');
    }
    const loopback =
      this.baseUrl.hostname === '127.0.0.1' ||
      this.baseUrl.hostname === '::1' ||
      this.baseUrl.hostname === 'localhost';
    if (
      this.baseUrl.protocol !== 'https:' &&
      !(options.allowInsecureLocalhost && loopback)
    )
      throw invalid(
        'HTTP ingress requires HTTPS except for explicit loopback development',
      );
    this.timeoutMs = requireLimit(
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      'timeoutMs',
      300_000,
    );
    this.maxRequestBytes = requireLimit(
      options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES,
      'maxRequestBytes',
      32 * 1024 * 1024,
    );
    this.maxResponseBytes = requireLimit(
      options.maxResponseBytes ?? DEFAULT_MAX_REQUEST_BYTES,
      'maxResponseBytes',
      32 * 1024 * 1024,
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.path = options.path ?? DEFAULT_PATH;
  }

  async ingest(delivery: FactDelivery): Promise<FactDeliveryAck> {
    const [ack] = await this.ingestBatch([delivery]);
    if (!ack)
      throw new DeliveryError(
        'FACT_REJECTED',
        'HTTP ingress returned no acknowledgement',
      );
    return ack;
  }

  async ingestBatch(
    deliveries: readonly FactDelivery[],
  ): Promise<readonly FactDeliveryAck[]> {
    if (
      !Array.isArray(deliveries) ||
      deliveries.length < 1 ||
      deliveries.length > MAX_BATCH
    )
      throw invalid(`deliveries must contain between 1 and ${MAX_BATCH} items`);
    const body: HttpFactBatchRequest = {
      protocolVersion: 1,
      platformId: this.options.platformId,
      deliveries: deliveries.map((delivery) => {
        if (
          this.options.source &&
          (delivery.source.gameId !== this.options.source.gameId ||
            delivery.source.releaseId !== this.options.source.releaseId ||
            delivery.source.backendBindingId !==
              this.options.source.backendBindingId ||
            delivery.source.ownershipEpoch !==
              this.options.source.ownershipEpoch)
        )
          throw new DeliveryError(
            'SOURCE_UNAUTHORIZED',
            'Client source does not match the configured source identity',
            false,
          );
        return { route: copy(delivery.route), fact: copy(delivery.fact) };
      }),
    };
    const encoded = JSON.stringify(body);
    if (Buffer.byteLength(encoded) > this.maxRequestBytes)
      throw new DeliveryError(
        'FACT_REJECTED',
        'HTTP request body is too large',
        false,
      );
    const url = new URL(this.path, this.baseUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.options.token}`,
          'content-type': 'application/json',
        },
        body: encoded,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    let parsed: unknown;
    try {
      const responseBytes = await response.arrayBuffer();
      if (responseBytes.byteLength > this.maxResponseBytes)
        throw new DeliveryError(
          'FACT_REJECTED',
          'HTTP response body is too large',
          false,
        );
      parsed = JSON.parse(new TextDecoder().decode(responseBytes));
    } catch (error) {
      if (isDeliveryError(error)) throw error;
      throw new DeliveryError(
        'FACT_REJECTED',
        `HTTP ingress returned ${response.status} with invalid JSON`,
        response.status >= 500,
      );
    }
    if (!response.ok) {
      const error =
        parsed && typeof parsed === 'object' && 'error' in parsed
          ? (parsed as { error?: unknown }).error
          : undefined;
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        typeof (error as { code?: unknown }).code === 'string'
      )
        throw clientError(error as HttpFactBatchError);
      throw new DeliveryError(
        response.status === 401 || response.status === 403
          ? 'SOURCE_UNAUTHORIZED'
          : 'FACT_REJECTED',
        `HTTP ingress returned ${response.status}`,
        response.status >= 500,
      );
    }
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      (parsed as { protocolVersion?: unknown }).protocolVersion !== 1 ||
      !Array.isArray((parsed as { acks?: unknown }).acks) ||
      !Array.isArray((parsed as { errors?: unknown }).errors)
    )
      throw new DeliveryError(
        'FACT_REJECTED',
        'HTTP ingress response is invalid',
      );
    const result = parsed as HttpFactBatchResponse;
    if (result.errors.length > 0) throw clientError(result.errors[0]);
    const acks = new Array<FactDeliveryAck>(deliveries.length);
    for (const entry of result.acks) {
      if (
        !entry ||
        !Number.isSafeInteger(entry.index) ||
        entry.index < 0 ||
        entry.index >= deliveries.length ||
        !entry.ack
      )
        throw new DeliveryError(
          'FACT_REJECTED',
          'HTTP ingress acknowledgement is invalid',
        );
      acks[entry.index] = copy(entry.ack);
    }
    if (acks.some((ack) => !ack))
      throw new DeliveryError(
        'FACT_REJECTED',
        'HTTP ingress acknowledgement is incomplete',
      );
    return acks;
  }
}
