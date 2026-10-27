import { contractError } from './errors.js';
import { assertJsonPayloadSize, isJsonValue, type JsonValue } from './json.js';
import type { MatchAdmission } from './platform.js';
import type { GameResult } from './results.js';
import {
  assertMatchesSchema,
  assertSchemaDescriptor,
  type SchemaDescriptor,
} from './schema.js';
import type { Participant, ProtocolRequest, SessionRoute } from './types.js';
import { assertParticipant, assertSessionRoute } from './validation.js';

/** The authenticated control-listener operation used by remote daily adapters. */
export const DAILY_CHALLENGE_BACKEND_OPERATION = 'dailyChallenge' as const;

export const DAILY_CHALLENGE_SERVICE_OPERATIONS = [
  'validateSettings',
  'publicSettings',
  'prepare',
  'validateSetup',
  'participants',
  'score',
] as const;

export const DAILY_CHALLENGE_REQUIRED_OPERATIONS = [
  'validateSettings',
  'prepare',
  'validateSetup',
  'participants',
  'score',
] as const;

export type DailyChallengeServiceOperation =
  (typeof DAILY_CHALLENGE_SERVICE_OPERATIONS)[number];

/** JSON-only descriptor published by an exact game/release service. */
export interface GameServiceDailyChallengeDescription {
  readonly modeId: string;
  readonly playerCount: number;
  readonly timezone?: string;
  readonly validityPolicyVersion?: string;
  readonly settingsSchema: SchemaDescriptor;
  readonly defaultSettings: JsonValue;
  readonly operations: readonly DailyChallengeServiceOperation[];
}

export interface DailyChallengeParticipantContext {
  readonly principalId: string;
  readonly attemptId: string;
  readonly sessionId: string;
  readonly challengeDate: string;
  readonly setup: JsonValue;
  readonly settings: JsonValue;
}

export interface DailyChallengePrepared {
  readonly seed: string;
  readonly setup: JsonValue;
  /** Optional date-specific, game-owned presentation safe for clients. */
  readonly publicSettings?: JsonValue;
}

export interface DailyChallengeScore {
  readonly score: number;
  readonly result?: JsonValue;
}

export type DailyChallengeServiceRequest = ProtocolRequest &
  (
    | {
        readonly operation: 'validateSettings';
        readonly route: SessionRoute;
        readonly settings: JsonValue;
      }
    | {
        readonly operation: 'publicSettings';
        readonly route: SessionRoute;
        readonly settings: JsonValue;
      }
    | {
        readonly operation: 'prepare';
        readonly route: SessionRoute;
        readonly challengeDate: string;
        readonly settings: JsonValue;
      }
    | {
        readonly operation: 'validateSetup';
        readonly route: SessionRoute;
        readonly setup: JsonValue;
      }
    | {
        readonly operation: 'participants';
        readonly route: SessionRoute;
        readonly context: DailyChallengeParticipantContext;
      }
    | {
        readonly operation: 'score';
        readonly route: SessionRoute;
        readonly result: GameResult;
        readonly admission: MatchAdmission;
      }
  );

export type DailyChallengeServiceResponse =
  | {
      readonly operation: 'validateSettings';
      readonly accepted: true;
    }
  | {
      readonly operation: 'publicSettings';
      readonly publicSettings: JsonValue;
    }
  | ({ readonly operation: 'prepare' } & DailyChallengePrepared)
  | {
      readonly operation: 'validateSetup';
      readonly accepted: true;
    }
  | {
      readonly operation: 'participants';
      readonly participants: readonly Participant[];
    }
  | {
      readonly operation: 'score';
      readonly score: DailyChallengeScore | null;
    };

function invalid(path: string): never {
  throw contractError('INVALID_REQUEST', 'contracts.daily.invalid', false, {
    path,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  const actual = Reflect.ownKeys(value);
  return (
    actual.length === expected.size &&
    actual.every((key) => typeof key === 'string' && expected.has(key))
  );
}

function requiredAndOptionalKeys(
  value: object,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const allowed = new Set([...required, ...optional]);
  const actual = Reflect.ownKeys(value);
  return (
    actual.every((key) => typeof key === 'string' && allowed.has(key)) &&
    required.every((key) => Object.hasOwn(value, key))
  );
}

function identifier(value: unknown, path: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > 256
  )
    invalid(path);
}

function finitePositiveInteger(
  value: unknown,
  path: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalid(path);
}

function assertDescription(
  value: unknown,
  path: string,
): asserts value is GameServiceDailyChallengeDescription {
  if (!isRecord(value)) invalid(path);
  if (
    !requiredAndOptionalKeys(
      value,
      [
        'modeId',
        'playerCount',
        'settingsSchema',
        'defaultSettings',
        'operations',
      ],
      ['timezone', 'validityPolicyVersion'],
    )
  )
    invalid(path);
  identifier(value.modeId, `${path}.modeId`);
  finitePositiveInteger(value.playerCount, `${path}.playerCount`);
  if (value.timezone !== undefined)
    identifier(value.timezone, `${path}.timezone`);
  if (value.validityPolicyVersion !== undefined)
    identifier(value.validityPolicyVersion, `${path}.validityPolicyVersion`);
  if (!isRecord(value.settingsSchema)) invalid(`${path}.settingsSchema`);
  assertSchemaDescriptor(
    value.settingsSchema as unknown as SchemaDescriptor,
    `${path}.settingsSchema`,
  );
  if (!isJsonValue(value.defaultSettings)) invalid(`${path}.defaultSettings`);
  try {
    assertJsonPayloadSize(
      value.defaultSettings,
      128 * 1024,
      `${path}.defaultSettings`,
    );
    assertMatchesSchema(
      value.defaultSettings,
      value.settingsSchema as unknown as SchemaDescriptor,
    );
  } catch {
    invalid(`${path}.defaultSettings`);
  }
  if (!Array.isArray(value.operations)) invalid(`${path}.operations`);
  const operations = value.operations;
  if (
    operations.length === 0 ||
    operations.some(
      (operation) =>
        typeof operation !== 'string' ||
        !(DAILY_CHALLENGE_SERVICE_OPERATIONS as readonly string[]).includes(
          operation,
        ),
    ) ||
    new Set(operations).size !== operations.length ||
    DAILY_CHALLENGE_REQUIRED_OPERATIONS.some(
      (operation) => !operations.includes(operation),
    )
  )
    invalid(`${path}.operations`);
}

export function assertGameServiceDailyChallengeDescription(
  value: unknown,
): asserts value is GameServiceDailyChallengeDescription {
  assertDescription(value, '$.dailyChallenge');
}

function assertParticipantContext(value: unknown, path: string): void {
  if (!isRecord(value)) invalid(path);
  if (
    !exactKeys(value, [
      'principalId',
      'attemptId',
      'sessionId',
      'challengeDate',
      'setup',
      'settings',
    ])
  )
    invalid(path);
  identifier(value.principalId, `${path}.principalId`);
  identifier(value.attemptId, `${path}.attemptId`);
  identifier(value.sessionId, `${path}.sessionId`);
  identifier(value.challengeDate, `${path}.challengeDate`);
  if (!isJsonValue(value.setup)) invalid(`${path}.setup`);
  if (!isJsonValue(value.settings)) invalid(`${path}.settings`);
  assertJsonPayloadSize(value, 256 * 1024, path);
}

function assertParticipants(value: unknown, path: string): void {
  if (!Array.isArray(value) || value.length === 0) invalid(path);
  const principals = new Set<string>();
  const seats = new Set<string>();
  for (const [index, participant] of value.entries()) {
    if (!isRecord(participant)) invalid(`${path}[${index}]`);
    try {
      assertParticipant(participant);
    } catch {
      invalid(`${path}[${index}]`);
    }
    if (
      principals.has(participant.principalId as string) ||
      seats.has(participant.seatId as string)
    )
      invalid(`${path}[${index}]`);
    principals.add(participant.principalId as string);
    seats.add(participant.seatId as string);
  }
}

/** Strict validation shared by EmbeddedBackendAdapter and HTTP transport. */
export function assertDailyChallengeServiceRequest(
  value: unknown,
): asserts value is DailyChallengeServiceRequest {
  if (!isRecord(value) || value.protocolVersion !== 1) invalid('$');
  if (!Object.hasOwn(value, 'operation') || !Object.hasOwn(value, 'route'))
    invalid('$');
  assertSessionRoute(value.route);
  const operation = value.operation;
  if (
    typeof operation !== 'string' ||
    !(DAILY_CHALLENGE_SERVICE_OPERATIONS as readonly string[]).includes(
      operation,
    )
  )
    invalid('$.operation');
  switch (operation) {
    case 'validateSettings':
    case 'publicSettings':
      if (!isJsonValue(value.settings)) invalid('$.settings');
      break;
    case 'prepare':
      identifier(value.challengeDate, '$.challengeDate');
      if (!isJsonValue(value.settings)) invalid('$.settings');
      break;
    case 'validateSetup':
      if (!isJsonValue(value.setup)) invalid('$.setup');
      break;
    case 'participants':
      assertParticipantContext(value.context, '$.context');
      break;
    case 'score':
      if (!isJsonValue(value.result)) invalid('$.result');
      if (!isRecord(value.admission)) invalid('$.admission');
      assertSessionRoute(value.admission.route);
      assertJsonPayloadSize(value.admission, 256 * 1024, '$.admission');
      assertParticipants(
        value.admission.participants,
        '$.admission.participants',
      );
      break;
  }
}

export function assertDailyChallengeServiceResponse(
  value: unknown,
): asserts value is DailyChallengeServiceResponse {
  if (!isRecord(value) || typeof value.operation !== 'string') invalid('$');
  switch (value.operation) {
    case 'validateSettings':
    case 'validateSetup':
      if (
        !exactKeys(value, ['operation', 'accepted']) ||
        value.accepted !== true
      )
        invalid('$');
      return;
    case 'publicSettings':
      if (
        !exactKeys(value, ['operation', 'publicSettings']) ||
        !isJsonValue(value.publicSettings)
      )
        invalid('$');
      return;
    case 'prepare':
      if (
        !requiredAndOptionalKeys(
          value,
          ['operation', 'seed', 'setup'],
          ['publicSettings'],
        )
      )
        invalid('$');
      identifier(value.seed, '$.seed');
      if (!isJsonValue(value.setup)) invalid('$.setup');
      if (Object.hasOwn(value, 'publicSettings')) {
        if (!isJsonValue(value.publicSettings)) invalid('$.publicSettings');
        try {
          assertJsonPayloadSize(
            value.publicSettings,
            128 * 1024,
            '$.publicSettings',
          );
        } catch {
          invalid('$.publicSettings');
        }
      }
      return;
    case 'participants':
      if (!exactKeys(value, ['operation', 'participants'])) invalid('$');
      assertParticipants(value.participants, '$.participants');
      return;
    case 'score':
      if (!exactKeys(value, ['operation', 'score'])) invalid('$');
      if (value.score !== null) {
        if (
          !isRecord(value.score) ||
          !requiredAndOptionalKeys(value.score, ['score'], ['result'])
        )
          invalid('$.score');
        if (
          typeof value.score.score !== 'number' ||
          !Number.isFinite(value.score.score)
        )
          invalid('$.score.score');
        if (
          value.score.result !== undefined &&
          !isJsonValue(value.score.result)
        )
          invalid('$.score.result');
      }
      return;
    default:
      invalid('$.operation');
  }
}
