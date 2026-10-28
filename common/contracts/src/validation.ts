import {
  type DeveloperCommand,
  type DeveloperConsoleCatalogRequest,
  type SubmitDeveloperCommandRequest,
} from './developer-console.js';
import { PlatformError } from './errors.js';
import {
  assertJsonPayloadSize,
  DEFAULT_JSON_LIMITS,
  isJsonValue,
  type JsonValue,
} from './json.js';
import { assertSchemaDescriptor, type SchemaDescriptor } from './schema.js';
import {
  type AccessContext,
  type CommandPrecondition,
  type ControlSessionRequest,
  type CreateSessionRequest,
  type GetEventsRequest,
  isCommandPrecondition,
  type ModeDefinition,
  type Participant,
  type ProtocolRequest,
  type PublicPlayerProfile,
  type SafeCommandReceipt,
  type SessionRoute,
  type SubmitCommandRequest,
  type SubmitSystemCommandRequest,
} from './types.js';

export const MAX_EVENT_READ_LIMIT = 200;

function fail(messageKey: string, details?: JsonValue): never {
  throw new PlatformError({
    code: 'INVALID_REQUEST',
    messageKey,
    retryable: false,
    details,
  });
}

function requireNonEmptyString(
  value: unknown,
  field: string,
): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0)
    fail('contracts.validation.requiredString', { field });
}

function requireExactKeys(
  value: object,
  keys: readonly string[],
  messageKey: string,
): void {
  const expected = new Set(keys);
  if (Object.keys(value).some((key) => !expected.has(key))) fail(messageKey);
}

export function assertAccessContext(
  value: unknown,
): asserts value is AccessContext {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('contracts.validation.invalidAccessContext');
  const context = value as Partial<AccessContext>;
  requireExactKeys(
    context,
    ['principalId', 'scopes', 'authEpoch', 'seatId'],
    'contracts.validation.invalidAccessContext',
  );
  requireNonEmptyString(context.principalId, 'principalId');
  if (!Array.isArray(context.scopes)) {
    fail('contracts.validation.invalidScopes');
  }
  for (let index = 0; index < context.scopes.length; index += 1) {
    if (
      !Object.hasOwn(context.scopes, index) ||
      typeof context.scopes[index] !== 'string' ||
      context.scopes[index].length === 0
    )
      fail('contracts.validation.invalidScopes');
  }
  requireNonEmptyString(context.authEpoch, 'authEpoch');
  if (context.seatId !== undefined)
    requireNonEmptyString(context.seatId, 'seatId');
}

export function assertProtocolRequest(
  value: unknown,
): asserts value is ProtocolRequest {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (value as { protocolVersion?: unknown }).protocolVersion !== 1
  ) {
    fail('contracts.validation.unsupportedProtocol');
  }
}

export function assertSessionRoute(
  value: unknown,
): asserts value is SessionRoute {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('contracts.validation.invalidRoute');
  const route = value as Partial<SessionRoute>;
  requireExactKeys(
    route,
    [
      'gameId',
      'modeId',
      'sessionId',
      'releaseId',
      'backendBindingId',
      'storageBindingId',
      'ownershipEpoch',
    ],
    'contracts.validation.invalidRoute',
  );
  requireNonEmptyString(route.gameId, 'gameId');
  requireNonEmptyString(route.modeId, 'modeId');
  requireNonEmptyString(route.sessionId, 'sessionId');
  requireNonEmptyString(route.releaseId, 'releaseId');
  requireNonEmptyString(route.backendBindingId, 'backendBindingId');
  requireNonEmptyString(route.storageBindingId, 'storageBindingId');
  requireNonEmptyString(route.ownershipEpoch, 'ownershipEpoch');
}

export function assertParticipant(
  value: unknown,
): asserts value is Participant {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('contracts.validation.invalidParticipant');
  const participant = value as Partial<Participant>;
  requireNonEmptyString(participant.principalId, 'participant.principalId');
  requireNonEmptyString(participant.seatId, 'participant.seatId');
  if (participant.teamId !== undefined)
    requireNonEmptyString(participant.teamId, 'participant.teamId');
  if (
    participant.controller !== undefined &&
    participant.controller !== 'human' &&
    participant.controller !== 'bot' &&
    participant.controller !== 'hotseat' &&
    participant.controller !== 'ai' &&
    participant.controller !== 'automa'
  )
    fail('contracts.validation.invalidParticipant');
  if (participant.controller === 'hotseat') {
    requireNonEmptyString(participant.controlledBy, 'participant.controlledBy');
    if (participant.controlledBy === participant.principalId)
      fail('contracts.validation.invalidParticipant');
  } else if (participant.controlledBy !== undefined) {
    fail('contracts.validation.invalidParticipant');
  }
  if (participant.controller === 'ai' || participant.controller === 'automa') {
    requireNonEmptyString(participant.controllerId, 'participant.controllerId');
    if (participant.controllerOptions !== undefined)
      assertJsonPayloadSize(participant.controllerOptions, 16 * 1024);
  } else if (
    participant.controllerId !== undefined ||
    participant.controllerOptions !== undefined
  ) {
    fail('contracts.validation.invalidParticipant');
  }
  if (participant.publicProfile !== undefined)
    assertPublicPlayerProfile(participant.publicProfile);
}

const PUBLIC_PROFILE_BYTES = 16 * 1024;

export function assertPublicPlayerProfile(
  value: unknown,
): asserts value is PublicPlayerProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('contracts.validation.invalidPublicProfile');
  const profile = value as Partial<PublicPlayerProfile>;
  requireExactKeys(
    profile,
    ['displayName', 'appearance', 'gameProfile'],
    'contracts.validation.invalidPublicProfile',
  );
  if (profile.displayName !== undefined) {
    requireNonEmptyString(profile.displayName, 'displayName');
    if (profile.displayName.length > 240 || /\p{Cc}/u.test(profile.displayName))
      fail('contracts.validation.invalidPublicProfile');
  }
  if (profile.appearance !== undefined)
    assertJsonPayloadSize(
      profile.appearance,
      PUBLIC_PROFILE_BYTES,
      'publicProfile.appearance',
    );
  if (profile.gameProfile !== undefined)
    assertJsonPayloadSize(
      profile.gameProfile,
      PUBLIC_PROFILE_BYTES,
      'publicProfile.gameProfile',
    );
  assertJsonPayloadSize(value, PUBLIC_PROFILE_BYTES, 'publicProfile');
}

export function assertModeDefinition(
  value: unknown,
): asserts value is ModeDefinition {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('contracts.validation.invalidMode');
  const mode = value as Partial<ModeDefinition>;
  requireNonEmptyString(mode.id, 'mode.id');
  if (mode.entry !== 'room' && mode.entry !== 'direct-solo')
    fail('contracts.validation.invalidModeEntry');
  if (
    typeof mode.minPlayers !== 'number' ||
    !Number.isSafeInteger(mode.minPlayers) ||
    mode.minPlayers < 1
  ) {
    fail('contracts.validation.invalidPlayerBounds');
  }
  if (
    typeof mode.maxPlayers !== 'number' ||
    !Number.isSafeInteger(mode.maxPlayers) ||
    mode.maxPlayers < mode.minPlayers
  ) {
    fail('contracts.validation.invalidPlayerBounds');
  }
  if (
    mode.history !== 'summary-and-replay' &&
    mode.history !== 'progress-only' &&
    mode.history !== 'ephemeral-result'
  ) {
    fail('contracts.validation.invalidHistoryPolicy');
  }
  if (typeof mode.platformRating !== 'boolean')
    fail('contracts.validation.invalidRatingPolicy');
  if (mode.concurrency !== 'revision' && mode.concurrency !== 'prompt')
    fail('contracts.validation.invalidConcurrency');
}

export function assertCommandPrecondition(
  value: unknown,
): asserts value is CommandPrecondition {
  if (!isCommandPrecondition(value))
    fail('contracts.validation.invalidCommandPrecondition');
}

export function assertSchema(
  value: unknown,
): asserts value is SchemaDescriptor {
  assertSchemaDescriptor(value as SchemaDescriptor);
}

export interface ValidationLimits {
  readonly setupBytes?: number;
  readonly commandBytes?: number;
  readonly queryBytes?: number;
}

export function assertGetEventsRequest(
  value: unknown,
): asserts value is GetEventsRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('contracts.validation.invalidEventsRequest');
  const request = value as Partial<GetEventsRequest> & Record<string, unknown>;
  requireExactKeys(
    request,
    [
      'protocolVersion',
      'accessContext',
      'route',
      'afterSequence',
      'limit',
      'viewEpoch',
    ],
    'contracts.validation.invalidEventsRequest',
  );
  assertProtocolRequest(request);
  assertAccessContext(request.accessContext);
  assertSessionRoute(request.route);
  if (
    typeof request.afterSequence !== 'number' ||
    !Number.isSafeInteger(request.afterSequence) ||
    request.afterSequence < 0
  ) {
    fail('contracts.validation.invalidEventSequence');
  }
  if (
    typeof request.limit !== 'number' ||
    !Number.isSafeInteger(request.limit) ||
    request.limit < 1 ||
    request.limit > MAX_EVENT_READ_LIMIT
  ) {
    fail('contracts.validation.invalidEventLimit');
  }
  if (request.viewEpoch !== undefined)
    requireNonEmptyString(request.viewEpoch, 'viewEpoch');
}

export function assertCreateSessionRequest<Setup extends JsonValue>(
  request: CreateSessionRequest<Setup>,
  limits: ValidationLimits = {},
): void {
  assertProtocolRequest(request);
  assertAccessContext(request.accessContext);
  assertSessionRoute(request.route);
  requireNonEmptyString(request.startId, 'startId');
  if (
    !Number.isSafeInteger(request.startGeneration) ||
    request.startGeneration < 0
  )
    fail('contracts.validation.invalidStartGeneration');
  requireNonEmptyString(request.seed, 'seed');
  if (!Array.isArray(request.participants) || request.participants.length === 0)
    fail('contracts.validation.invalidParticipants');
  for (let index = 0; index < request.participants.length; index += 1) {
    if (!Object.hasOwn(request.participants, index))
      fail('contracts.validation.invalidParticipants');
    assertParticipant(request.participants[index]);
  }
  if (!isJsonValue(request.setup)) fail('contracts.validation.invalidSetup');
  assertJsonPayloadSize(
    request.setup,
    limits.setupBytes ?? DEFAULT_JSON_LIMITS.setupBytes,
    'setup',
  );
}

export function assertSubmitCommandRequest<Command extends JsonValue>(
  request: SubmitCommandRequest<Command>,
  limits: ValidationLimits = {},
): void {
  assertProtocolRequest(request);
  assertAccessContext(request.accessContext);
  assertSessionRoute(request.route);
  requireNonEmptyString(request.commandId, 'commandId');
  assertCommandPrecondition(request.precondition);
  if (!isJsonValue(request.command))
    fail('contracts.validation.invalidCommand');
  assertJsonPayloadSize(
    request.command,
    limits.commandBytes ?? DEFAULT_JSON_LIMITS.commandBytes,
    'command',
  );
}

export function assertSubmitSystemCommandRequest<
  SystemCommand extends JsonValue,
>(
  request: SubmitSystemCommandRequest<SystemCommand>,
  limits: ValidationLimits = {},
): void {
  assertProtocolRequest(request);
  requireExactKeys(
    request as unknown as object,
    [
      'protocolVersion',
      'accessContext',
      'route',
      'commandId',
      'expectedRevision',
      'command',
      'deadlineId',
    ],
    'contracts.validation.invalidSystemCommandRequest',
  );
  assertAccessContext(request.accessContext);
  assertSessionRoute(request.route);
  requireNonEmptyString(request.commandId, 'commandId');
  if (
    typeof request.expectedRevision !== 'number' ||
    !Number.isSafeInteger(request.expectedRevision) ||
    request.expectedRevision < 0
  )
    fail('contracts.validation.invalidExpectedRevision');
  if (request.deadlineId !== undefined)
    requireNonEmptyString(request.deadlineId, 'deadlineId');
  if (!isJsonValue(request.command))
    fail('contracts.validation.invalidSystemCommand');
  assertJsonPayloadSize(
    request.command,
    limits.commandBytes ?? DEFAULT_JSON_LIMITS.commandBytes,
    'systemCommand',
  );
}

export function assertDeveloperCommand(
  value: unknown,
): asserts value is DeveloperCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('contracts.validation.invalidDeveloperCommand');
  const command = value as Partial<DeveloperCommand> & Record<string, unknown>;
  requireExactKeys(
    command,
    ['name', 'input'],
    'contracts.validation.invalidDeveloperCommand',
  );
  requireNonEmptyString(command.name, 'developerCommand.name');
  if (command.name.length > 128)
    fail('contracts.validation.invalidDeveloperCommand');
  if (!isJsonValue(command.input))
    fail('contracts.validation.invalidDeveloperCommand');
}

export function assertDeveloperConsoleCatalogRequest(
  request: DeveloperConsoleCatalogRequest,
): void {
  assertProtocolRequest(request);
  assertAccessContext(request.accessContext);
  assertSessionRoute(request.route);
}

export function assertSubmitDeveloperCommandRequest(
  request: SubmitDeveloperCommandRequest,
  limits: ValidationLimits = {},
): void {
  assertProtocolRequest(request);
  requireExactKeys(
    request as unknown as object,
    [
      'protocolVersion',
      'accessContext',
      'route',
      'commandId',
      'expectedRevision',
      'command',
    ],
    'contracts.validation.invalidDeveloperCommandRequest',
  );
  assertAccessContext(request.accessContext);
  assertSessionRoute(request.route);
  requireNonEmptyString(request.commandId, 'commandId');
  if (
    typeof request.expectedRevision !== 'number' ||
    !Number.isSafeInteger(request.expectedRevision) ||
    request.expectedRevision < 0
  )
    fail('contracts.validation.invalidExpectedRevision');
  assertDeveloperCommand(request.command);
  assertJsonPayloadSize(
    request.command,
    limits.commandBytes ?? DEFAULT_JSON_LIMITS.commandBytes,
    'developerCommand',
  );
}

export function assertControlSessionRequest(
  value: unknown,
): asserts value is ControlSessionRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('contracts.validation.invalidControlRequest');
  assertProtocolRequest(value);
  const request = value as Partial<ControlSessionRequest>;
  assertAccessContext(request.accessContext);
  assertSessionRoute(request.route);
  requireNonEmptyString(request.commandId, 'commandId');
  if (
    typeof request.expectedRevision !== 'number' ||
    !Number.isSafeInteger(request.expectedRevision) ||
    request.expectedRevision < 0
  ) {
    fail('contracts.validation.invalidExpectedRevision');
  }
  if (
    request.action !== 'pause' &&
    request.action !== 'resume' &&
    request.action !== 'cancel'
  ) {
    fail('contracts.validation.invalidControlAction');
  }
}

export function assertSafeCommandReceipt(
  value: unknown,
): asserts value is SafeCommandReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('contracts.validation.invalidReceipt');
  const receipt = value as Partial<SafeCommandReceipt> &
    Record<string, unknown>;
  requireExactKeys(
    receipt,
    [
      'commandId',
      'sessionId',
      'status',
      'persistedRevision',
      'persistedAt',
      'resultRetention',
      'error',
    ],
    'contracts.validation.unsafeReceipt',
  );
  for (const forbidden of ['command', 'payload', 'result', 'state', 'view']) {
    if (Object.hasOwn(receipt, forbidden))
      fail('contracts.validation.unsafeReceipt', { field: forbidden });
  }
  requireNonEmptyString(receipt.commandId, 'commandId');
  requireNonEmptyString(receipt.sessionId, 'sessionId');
  if (
    receipt.status !== 'accepted' &&
    receipt.status !== 'rejected' &&
    receipt.status !== 'duplicate' &&
    receipt.status !== 'unknown'
  ) {
    fail('contracts.validation.invalidReceiptStatus');
  }
  if (
    receipt.resultRetention !== 'replayable' &&
    receipt.resultRetention !== 'ephemeral-result'
  ) {
    fail('contracts.validation.invalidReceiptRetention');
  }
  if (
    receipt.persistedRevision !== undefined &&
    (typeof receipt.persistedRevision !== 'number' ||
      !Number.isSafeInteger(receipt.persistedRevision) ||
      receipt.persistedRevision < 0)
  ) {
    fail('contracts.validation.invalidReceiptRevision');
  }
  if (
    receipt.persistedAt !== undefined &&
    (typeof receipt.persistedAt !== 'number' ||
      !Number.isFinite(receipt.persistedAt))
  ) {
    fail('contracts.validation.invalidReceiptTime');
  }
}

export function assertQueryPayload(
  value: unknown,
  limits: ValidationLimits = {},
): asserts value is JsonValue {
  if (!isJsonValue(value)) fail('contracts.validation.invalidQuery');
  assertJsonPayloadSize(
    value,
    limits.queryBytes ?? DEFAULT_JSON_LIMITS.queryBytes,
    'query',
  );
}

/** Preset seeds are user-visible setup values, never game-specific schema fields. */
export function assertPresetSeed(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 256 ||
    value.trim() !== value ||
    /\p{Cc}/u.test(value)
  )
    fail('contracts.validation.invalidPresetSeed');
}
