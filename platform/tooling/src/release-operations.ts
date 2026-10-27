import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import {
  canonicalStableStringify,
  type GamePolicyVersion,
  type GameServiceDescription,
  type JsonValue,
  type ReleaseManifest,
} from '@board-game/contracts';
import { verifyPackedRelease } from '@board-game/tooling/release';
import {
  type ComposePlan,
  type ComposePlanFileOptions,
  createComposePlanFromFiles,
} from './compose.js';

export type ReleaseOperationAction =
  | 'register'
  | 'ready'
  | 'activate'
  | 'switch'
  | 'rollback'
  | 'drain'
  | 'publish'
  | 'deploy';

export interface RegisterStagedReleasePayload {
  readonly manifest: ReleaseManifest;
  readonly service: GameServiceDescription;
  readonly approvedFeatures: readonly string[];
  readonly approvedModes: readonly string[];
  readonly policyBundle?: JsonValue;
  readonly approvedPolicyVersions?: readonly GamePolicyVersion[];
  readonly binding: {
    readonly deployment: 'managed' | 'external';
    readonly controlEndpoint: string;
    readonly playerEndpoint: string;
    readonly authorizationEndpoint?: string;
    readonly clientArtifactBaseUrl: string;
    readonly serviceCredentialRef: string;
  };
}

export interface PlatformOperationsRequest {
  readonly method: 'POST';
  readonly path: string;
  readonly body: Readonly<Record<string, unknown>>;
  readonly operationId: string;
}

export interface PlatformOperationsTransport {
  request<T>(request: PlatformOperationsRequest): Promise<T>;
}

export interface ReleaseArtifactPublisher {
  publish(input: {
    readonly releaseDirectory: string;
    readonly manifest: ReleaseManifest;
    readonly operationId: string;
  }): Promise<unknown>;
}

export interface HttpReleaseArtifactPublisherOptions {
  readonly baseUrl: string;
  readonly tokenRef: string;
  readonly resolveSecret?: (reference: string) => string | Promise<string>;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly allowInsecureLocalhost?: boolean;
}

export interface ReleasePublishResult {
  readonly releaseDigest: string;
  readonly manifestUrl: string;
  readonly clientArtifactBaseUrl: string;
  readonly objects: {
    readonly uploaded: number;
    readonly reused: number;
  };
}

export interface ComposeExecutor {
  run(input: {
    readonly plan: ComposePlan;
    readonly operationId: string;
  }): Promise<unknown>;
}

export interface ReleaseOperationResult<T = unknown> {
  readonly action: ReleaseOperationAction;
  readonly operationId: string;
  readonly dryRun: boolean;
  readonly request?: PlatformOperationsRequest;
  readonly result?: T;
  readonly plan?: ComposePlan;
  readonly release?: {
    readonly gameId: string;
    readonly releaseId: string;
    readonly manifestDigest: Readonly<Record<string, string>>;
  };
}

export interface ReleaseOperationsOptions {
  readonly platformId: string;
  readonly transport?: PlatformOperationsTransport;
  readonly publisher?: ReleaseArtifactPublisher;
  readonly composeExecutor?: ComposeExecutor;
}

export interface RegisterReleaseOperationInput
  extends RegisterStagedReleasePayload {
  readonly dryRun?: boolean;
  readonly operationId?: string;
}

export interface BindingOperationInput {
  readonly backendBindingId: string;
  readonly dryRun?: boolean;
  readonly operationId?: string;
}

export interface RollbackOperationInput {
  readonly gameId: string;
  readonly modeId: string;
  readonly channel: string;
  readonly expectedRevision: number;
  readonly targetBackendBindingId: string;
  readonly dryRun?: boolean;
  readonly operationId?: string;
}

export interface PublishOperationInput {
  readonly releaseDirectory: string;
  readonly dryRun?: boolean;
  readonly operationId?: string;
}

export interface DeployOperationInput extends ComposePlanFileOptions {
  readonly targetGameId: string;
  readonly dryRun?: boolean;
  readonly operationId?: string;
}

function requiredIdentifier(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0)
    throw new Error(`${label} must be a non-empty string`);
  return value;
}

function secretReference(value: string, label: string): string {
  const reference = requiredIdentifier(value, label);
  if (
    !/^(?:env:[A-Za-z][A-Za-z0-9_]*|secrets\/[A-Za-z0-9._/-]+)$/u.test(
      reference,
    )
  )
    throw new Error(`${label} must be an env: or secrets/ reference`);
  return reference;
}

function resolveEnvironmentSecretReference(reference: string): string {
  secretReference(reference, 'tokenRef');
  if (!reference.startsWith('env:'))
    throw new Error(
      'tokenRef requires an injected secret resolver for secrets/ references',
    );
  const name = reference.slice('env:'.length);
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Secret environment variable ${name} is missing`);
  return value;
}

function providedOperationId(value: string | undefined): string | undefined {
  return value === undefined
    ? undefined
    : requiredIdentifier(value, 'operationId');
}

function operationId(
  platformId: string,
  action: ReleaseOperationAction,
  identity: unknown,
): string {
  const digest = createHash('sha256')
    .update(
      canonicalStableStringify({
        platformId: requiredIdentifier(platformId, 'platformId'),
        action,
        identity,
      }),
    )
    .digest('hex');
  return `bgp-${action}-${digest.slice(0, 32)}`;
}

export function stableReleaseOperationId(input: {
  readonly platformId: string;
  readonly action: ReleaseOperationAction;
  readonly identity: unknown;
}): string {
  return operationId(input.platformId, input.action, input.identity);
}

function request(
  operation: string,
  path: string,
  body: Readonly<Record<string, unknown>>,
): PlatformOperationsRequest {
  return { method: 'POST', path, body, operationId: operation };
}

function assertComposeCommand(plan: ComposePlan): void {
  if (
    plan.command.includes('down') ||
    !plan.command.includes('up') ||
    !plan.command.includes('--no-deps') ||
    plan.command[plan.command.length - 1] !== plan.targetService
  )
    throw new Error(
      'compose deployment must target one versioned service with up --no-deps',
    );
}

interface ReleaseObject {
  readonly path: string;
  readonly bytes: Buffer;
  readonly contentType: string;
  readonly visibility: 'public' | 'private';
}

function artifactContentType(path: string): string {
  const types: Readonly<Record<string, string>> = {
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.css': 'text/css',
    '.html': 'text/html',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
  };
  return types[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

async function collectReleaseFiles(
  directory: string,
  prefix = '',
): Promise<readonly { readonly path: string; readonly bytes: Buffer }[]> {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error('release artifact directories must not be symlinks');
  const entries: { readonly path: string; readonly bytes: Buffer }[] = [];
  for (const name of (await readdir(directory)).sort()) {
    const absolute = join(directory, name);
    const relative = prefix ? `${prefix}/${name}` : name;
    const child = await lstat(absolute);
    if (child.isSymbolicLink())
      throw new Error('release artifact files must not be symlinks');
    if (child.isDirectory())
      entries.push(...(await collectReleaseFiles(absolute, relative)));
    else if (child.isFile())
      entries.push({ path: relative, bytes: await readFile(absolute) });
    else throw new Error('release artifact contains a non-regular file');
  }
  return entries;
}

function releaseDigest(manifest: ReleaseManifest): string {
  return `sha256:${createHash('sha256')
    .update(canonicalStableStringify(manifest))
    .digest('hex')}`;
}

function sameBytes(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && left.equals(right);
}

function requestBody(bytes: Buffer): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.length);
  new Uint8Array(copy).set(bytes);
  return copy;
}

/**
 * Uploads an already packed release to an HTTP PUT object store. The store
 * must treat `If-None-Match: *` paths as immutable; a same-byte 409 is the
 * only conflict considered idempotent.
 */
export class HttpReleaseArtifactPublisher implements ReleaseArtifactPublisher {
  private readonly baseUrl: URL;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly tokenRef: string;

  constructor(private readonly options: HttpReleaseArtifactPublisherOptions) {
    this.tokenRef = secretReference(options.tokenRef, 'tokenRef');
    try {
      this.baseUrl = new URL(options.baseUrl);
    } catch {
      throw new Error('release store baseUrl must be an absolute URL');
    }
    if (
      this.baseUrl.search ||
      this.baseUrl.hash ||
      this.baseUrl.username ||
      this.baseUrl.password
    )
      throw new Error(
        'release store baseUrl must not contain credentials, query or hash',
      );
    const loopback =
      this.baseUrl.hostname === '127.0.0.1' ||
      this.baseUrl.hostname === 'localhost' ||
      this.baseUrl.hostname === '::1';
    if (
      this.baseUrl.protocol !== 'https:' &&
      !(options.allowInsecureLocalhost && loopback)
    )
      throw new Error('release store requires HTTPS');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1)
      throw new Error('release store timeoutMs must be positive');
  }

  async publish(input: {
    readonly releaseDirectory: string;
    readonly manifest: ReleaseManifest;
    readonly operationId: string;
  }): Promise<ReleasePublishResult> {
    const verified = await verifyPackedRelease(input.releaseDirectory);
    if (
      canonicalStableStringify(verified) !==
      canonicalStableStringify(input.manifest)
    )
      throw new Error('packed release manifest changed before upload');
    const digest = releaseDigest(verified);
    const objects: ReleaseObject[] = [];
    const publicRoot = [
      'public',
      verified.gameId,
      verified.releaseId,
      verified.artifacts.client.digest.slice(7),
    ];
    const artifactRoots = {
      client: join(input.releaseDirectory, 'public', 'client'),
      publicAssets: join(input.releaseDirectory, 'public', 'publicAssets'),
      server: join(input.releaseDirectory, 'private', 'server'),
      ...(verified.artifacts.privateContent
        ? {
            privateContent: join(
              input.releaseDirectory,
              'private',
              'privateContent',
            ),
          }
        : {}),
    } as const;
    for (const [key, root] of Object.entries(artifactRoots)) {
      const artifact = verified.artifacts[key as keyof typeof artifactRoots];
      if (!artifact) throw new Error(`release artifact is missing: ${key}`);
      const files = await collectReleaseFiles(root);
      const isPublic = key === 'client' || key === 'publicAssets';
      for (const file of files) {
        const prefix = isPublic
          ? [...publicRoot, key === 'client' ? 'client' : 'public']
          : [
              'private',
              verified.gameId,
              verified.releaseId,
              artifact.digest.slice(7),
              key,
            ];
        objects.push({
          path: [...prefix, file.path].join('/'),
          bytes: file.bytes,
          contentType: artifactContentType(file.path),
          visibility: isPublic ? 'public' : 'private',
        });
      }
    }
    const manifestPath = [
      'manifests',
      verified.gameId,
      verified.releaseId,
      digest.slice(7),
      'release.json',
    ];
    objects.push({
      path: manifestPath.join('/'),
      bytes: await readFile(join(input.releaseDirectory, 'release.json')),
      contentType: 'application/json',
      visibility: 'public',
    });
    const token = await (this.options.resolveSecret
      ? this.options.resolveSecret(this.tokenRef)
      : resolveEnvironmentSecretReference(this.tokenRef));
    if (typeof token !== 'string' || token.trim().length === 0)
      throw new Error('release store token resolved to an empty value');
    let uploaded = 0;
    let reused = 0;
    for (const object of objects) {
      const result = await this.put(
        object.path.split('/'),
        object,
        token,
        input.operationId,
      );
      if (result === 'uploaded') uploaded += 1;
      else reused += 1;
    }
    return {
      releaseDigest: digest,
      manifestUrl: this.url(manifestPath).href,
      clientArtifactBaseUrl: `${this.url(['public']).href}/`,
      objects: { uploaded, reused },
    };
  }

  private url(parts: readonly string[]): URL {
    const url = new URL(this.baseUrl.href);
    const prefix = url.pathname.endsWith('/')
      ? url.pathname
      : `${url.pathname}/`;
    url.pathname = `${prefix}${parts.map((part) => encodeURIComponent(part)).join('/')}`;
    return url;
  }

  private async put(
    parts: readonly string[],
    object: ReleaseObject,
    token: string,
    operationIdValue: string,
  ): Promise<'uploaded' | 'reused'> {
    const response = await this.fetchRequest(this.url(parts), {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': object.contentType,
        'if-none-match': '*',
        'x-bgp-operation-id': operationIdValue,
        'x-bgp-artifact-visibility': object.visibility,
      },
      body: requestBody(object.bytes),
    });
    if (response.status >= 200 && response.status < 300) return 'uploaded';
    if (response.status !== 409 && response.status !== 412)
      throw new Error(`release store upload failed (${response.status})`);
    const existing = await this.fetchRequest(this.url(parts), {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    });
    if (!existing.ok)
      throw new Error(`release store immutable conflict (${existing.status})`);
    const current = Buffer.from(await existing.arrayBuffer());
    if (!sameBytes(current, object.bytes))
      throw new Error('release store immutable conflict');
    return 'reused';
  }

  private async fetchRequest(url: URL, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (_error) {
      if (controller.signal.aborted)
        throw new Error('release store request timed out');
      throw new Error('release store request failed');
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Thin, injectable release operation boundary. It deliberately does not own
 * credentials, artifact storage or Docker: callers provide those ports and
 * can use the same methods for dry-run previews and real operations.
 */
export class ReleaseOperations {
  constructor(private readonly options: ReleaseOperationsOptions) {
    requiredIdentifier(options.platformId, 'platformId');
  }

  async register(
    input: RegisterReleaseOperationInput,
  ): Promise<ReleaseOperationResult> {
    const {
      dryRun = false,
      operationId: requestedOperationId,
      ...payload
    } = input;
    secretReference(
      payload.binding.serviceCredentialRef,
      'binding.serviceCredentialRef',
    );
    const id =
      providedOperationId(requestedOperationId) ??
      operationId(this.options.platformId, 'register', payload);
    const route = request(id, '/platform/admin/releases', payload);
    if (dryRun)
      return { action: 'register', operationId: id, dryRun, request: route };
    const result = await this.transport().request(route);
    return { action: 'register', operationId: id, dryRun, result };
  }

  async ready(input: BindingOperationInput): Promise<ReleaseOperationResult> {
    return this.bindingAction('ready', input);
  }

  async activate(
    input: BindingOperationInput,
  ): Promise<ReleaseOperationResult> {
    return this.bindingAction('activate', input);
  }

  async drain(input: BindingOperationInput): Promise<ReleaseOperationResult> {
    return this.bindingAction('drain', input);
  }

  async rollback(
    input: RollbackOperationInput,
  ): Promise<ReleaseOperationResult> {
    return this.changeChannel('rollback', input);
  }

  async switchChannel(
    input: RollbackOperationInput,
  ): Promise<ReleaseOperationResult> {
    return this.changeChannel('switch', input);
  }

  private async changeChannel(
    action: 'switch' | 'rollback',
    input: RollbackOperationInput,
  ): Promise<ReleaseOperationResult> {
    const {
      dryRun = false,
      operationId: requestedOperationId,
      ...payload
    } = input;
    requiredIdentifier(payload.gameId, 'gameId');
    requiredIdentifier(payload.modeId, 'modeId');
    requiredIdentifier(payload.channel, 'channel');
    requiredIdentifier(
      payload.targetBackendBindingId,
      'targetBackendBindingId',
    );
    if (
      !Number.isSafeInteger(payload.expectedRevision) ||
      payload.expectedRevision < 0
    )
      throw new Error('expectedRevision must be a non-negative integer');
    const id =
      providedOperationId(requestedOperationId) ??
      operationId(this.options.platformId, action, payload);
    const route = request(id, '/platform/admin/releases/channels/switch', {
      ...payload,
      operationId: id,
    });
    if (dryRun) return { action, operationId: id, dryRun, request: route };
    const result = await this.transport().request(route);
    return { action, operationId: id, dryRun, result };
  }

  async publish(input: PublishOperationInput): Promise<ReleaseOperationResult> {
    const manifest = await verifyPackedRelease(input.releaseDirectory);
    const {
      dryRun = false,
      operationId: requestedOperationId,
      releaseDirectory: _releaseDirectory,
    } = input;
    const id =
      providedOperationId(requestedOperationId) ??
      operationId(this.options.platformId, 'publish', {
        gameId: manifest.gameId,
        releaseId: manifest.releaseId,
        artifacts: manifest.artifacts,
      });
    const release = {
      gameId: manifest.gameId,
      releaseId: manifest.releaseId,
      manifestDigest: Object.fromEntries(
        Object.entries(manifest.artifacts).map(([key, artifact]) => [
          key,
          artifact.digest,
        ]),
      ),
    };
    if (dryRun)
      return {
        action: 'publish',
        operationId: id,
        dryRun,
        release,
      };
    if (!this.options.publisher)
      throw new Error('a release artifact publisher is required for publish');
    const result = await this.options.publisher.publish({
      releaseDirectory: input.releaseDirectory,
      manifest,
      operationId: id,
    });
    return { action: 'publish', operationId: id, dryRun, release, result };
  }

  async deploy(input: DeployOperationInput): Promise<ReleaseOperationResult> {
    const plan = await createComposePlanFromFiles(input);
    assertComposeCommand(plan);
    const { dryRun = false, operationId: requestedOperationId } = input;
    const id =
      providedOperationId(requestedOperationId) ??
      operationId(this.options.platformId, 'deploy', {
        targetGameId: plan.gameId,
        releaseId: plan.releaseId,
        targetService: plan.targetService,
      });
    if (dryRun) return { action: 'deploy', operationId: id, dryRun, plan };
    if (!this.options.composeExecutor)
      throw new Error('a compose executor is required for deploy');
    const result = await this.options.composeExecutor.run({
      plan,
      operationId: id,
    });
    return { action: 'deploy', operationId: id, dryRun, plan, result };
  }

  private async bindingAction(
    action: 'ready' | 'activate' | 'drain',
    input: BindingOperationInput,
  ): Promise<ReleaseOperationResult> {
    const bindingId = requiredIdentifier(
      input.backendBindingId,
      'backendBindingId',
    );
    const { dryRun = false, operationId: requestedOperationId } = input;
    const id =
      providedOperationId(requestedOperationId) ??
      operationId(this.options.platformId, action, {
        backendBindingId: bindingId,
      });
    const route = request(
      id,
      `/platform/admin/releases/bindings/${encodeURIComponent(bindingId)}/${action}`,
      {},
    );
    if (dryRun) return { action, operationId: id, dryRun, request: route };
    const result = await this.transport().request(route);
    return { action, operationId: id, dryRun, result };
  }

  private transport(): PlatformOperationsTransport {
    if (!this.options.transport)
      throw new Error('a platform operations transport is required');
    return this.options.transport;
  }
}

export function createReleaseOperations(
  options: ReleaseOperationsOptions,
): ReleaseOperations {
  return new ReleaseOperations(options);
}

export interface HttpPlatformOperationsClientOptions {
  readonly baseUrl: string;
  readonly token?: string | (() => string | Promise<string>);
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly allowInsecureLocalhost?: boolean;
}

/** HTTP adapter for the platform admin release routes. */
export class HttpPlatformOperationsClient
  implements PlatformOperationsTransport
{
  private readonly baseUrl: URL;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: HttpPlatformOperationsClientOptions) {
    try {
      this.baseUrl = new URL(options.baseUrl);
    } catch {
      throw new Error('platform operations baseUrl must be an absolute URL');
    }
    if (
      this.baseUrl.search ||
      this.baseUrl.hash ||
      this.baseUrl.username ||
      this.baseUrl.password
    )
      throw new Error(
        'platform operations baseUrl must not contain credentials, query or hash',
      );
    if (!this.baseUrl.pathname.endsWith('/')) this.baseUrl.pathname += '/';
    const loopback =
      this.baseUrl.hostname === '127.0.0.1' ||
      this.baseUrl.hostname === 'localhost' ||
      this.baseUrl.hostname === '::1';
    if (
      this.baseUrl.protocol !== 'https:' &&
      !(options.allowInsecureLocalhost && loopback)
    )
      throw new Error('platform operations require HTTPS');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1)
      throw new Error('platform operations timeoutMs must be positive');
  }

  async request<T>(input: PlatformOperationsRequest): Promise<T> {
    if (!input.path.startsWith('/'))
      throw new Error('platform operations path must start with /');
    const url = new URL(input.path.slice(1), this.baseUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const token =
        typeof this.options.token === 'function'
          ? await this.options.token()
          : this.options.token;
      if (token !== undefined && token.trim().length === 0)
        throw new Error('platform operations token must not be empty');
      const response = await this.fetchImpl(url, {
        method: input.method,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-bgp-operation-id': input.operationId,
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify(input.body),
        signal: controller.signal,
      });
      if (!response.ok)
        throw new Error(
          `platform operations request failed (${response.status})`,
        );
      try {
        return (await response.json()) as T;
      } catch {
        throw new Error('platform operations returned invalid JSON');
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith('platform operations')
      )
        throw error;
      if (controller.signal.aborted)
        throw new Error('platform operations request timed out');
      throw new Error('platform operations request failed');
    } finally {
      clearTimeout(timer);
    }
  }
}
