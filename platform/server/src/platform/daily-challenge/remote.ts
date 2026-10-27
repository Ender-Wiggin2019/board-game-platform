import {
  assertDailyChallengeServiceResponse,
  assertGameServiceDailyChallengeDescription,
  assertMatchesSchema,
  type BackendPort,
  contractError,
  type DailyChallengeParticipantContext,
  type DailyChallengeServiceOperation,
  type DailyChallengeServiceRequest,
  type DailyChallengeServiceResponse,
  type GameResult,
  type GameServiceDescription,
  type JsonValue,
  type MatchAdmission,
  type SessionRoute,
} from '@board-game/contracts';
import { BackendTransportError } from '@board-game/host';
import type { DailyChallengeRegistration } from './types.js';

export interface RemoteDailyChallengeRegistrationOptions {
  /** The runtime supplies a release-pinned forwarding view for each call. */
  readonly backend: Pick<BackendPort, 'dailyChallenge'>;
  readonly description: GameServiceDescription;
}

function routeFor(
  description: GameServiceDescription,
  operation: DailyChallengeServiceOperation,
  challengeDate?: string,
  sessionId?: string,
): SessionRoute {
  const daily = description.dailyChallenge;
  if (!daily) throw new Error('PLATFORM_DAILY_DESCRIPTION_MISSING');
  return {
    gameId: description.gameId,
    modeId: daily.modeId,
    sessionId:
      sessionId ?? `daily-rpc-${operation}-${challengeDate ?? 'service'}`,
    releaseId: description.releaseId,
    backendBindingId: description.backendBindingId,
    storageBindingId: description.storageBindingId,
    ownershipEpoch: description.ownershipEpoch,
  };
}

function responseFor<T extends DailyChallengeServiceResponse['operation']>(
  response: DailyChallengeServiceResponse,
  operation: T,
): Extract<DailyChallengeServiceResponse, { readonly operation: T }> {
  assertDailyChallengeServiceResponse(response);
  if (response.operation !== operation)
    throw new Error('PLATFORM_DAILY_RESPONSE_OPERATION_MISMATCH');
  return response as Extract<
    DailyChallengeServiceResponse,
    { readonly operation: T }
  >;
}

async function callRemoteDaily(
  backend: Pick<BackendPort, 'dailyChallenge'>,
  request: Omit<DailyChallengeServiceRequest, 'protocolVersion'>,
  route = request.route,
): Promise<DailyChallengeServiceResponse> {
  if (!backend.dailyChallenge)
    throw new Error('PLATFORM_DAILY_RPC_UNAVAILABLE');
  let response: DailyChallengeServiceResponse;
  try {
    response = await backend.dailyChallenge({
      protocolVersion: 1,
      ...request,
      route,
    } as DailyChallengeServiceRequest);
  } catch (error) {
    if (
      error instanceof BackendTransportError &&
      (error.code === 'NETWORK' || error.code === 'TIMEOUT')
    )
      throw contractError('NOT_READY', 'platform.daily.unavailable', true);
    throw error;
  }
  assertDailyChallengeServiceResponse(response);
  return response;
}

/** Adapt a JSON-only game daily RPC to the existing platform daily service. */
export function createRemoteDailyChallengeRegistration(
  options: RemoteDailyChallengeRegistrationOptions,
): DailyChallengeRegistration {
  const { description, backend } = options;
  assertGameServiceDailyChallengeDescription(description.dailyChallenge);
  const daily = description.dailyChallenge;
  const rpc = (
    operation: DailyChallengeServiceOperation,
    request: Omit<
      DailyChallengeServiceRequest,
      'protocolVersion' | 'operation' | 'route'
    > &
      Record<string, unknown>,
    route?: SessionRoute,
  ) =>
    callRemoteDaily(
      backend,
      {
        operation,
        route:
          route ??
          routeFor(
            description,
            operation,
            (request as { challengeDate?: string }).challengeDate,
          ),
        ...request,
      } as DailyChallengeServiceRequest,
      route,
    );

  return {
    gameId: description.gameId,
    releaseId: description.releaseId,
    modeId: daily.modeId,
    playerCount: daily.playerCount,
    ...(daily.timezone ? { timezone: daily.timezone } : {}),
    ...(daily.validityPolicyVersion
      ? { validityPolicyVersion: daily.validityPolicyVersion }
      : {}),
    settings: {
      defaults: structuredClone(daily.defaultSettings),
      validate: (settings) =>
        assertMatchesSchema(settings, daily.settingsSchema),
      validateAsync: async (settings) => {
        responseFor(
          await rpc('validateSettings', { settings }),
          'validateSettings',
        );
      },
    },
    ...(daily.operations.includes('publicSettings')
      ? {
          publicSettings: async (settings: JsonValue) =>
            responseFor(
              await rpc('publicSettings', { settings }),
              'publicSettings',
            ).publicSettings,
        }
      : {}),
    prepare: async (challengeDate, settings) => {
      const response = responseFor(
        await rpc('prepare', { challengeDate, settings }),
        'prepare',
      );
      return {
        seed: response.seed,
        setup: response.setup,
        ...(response.publicSettings === undefined
          ? {}
          : { publicSettings: response.publicSettings }),
      };
    },
    seedForDate: async (challengeDate, settings) =>
      (
        await responseFor(
          await rpc('prepare', { challengeDate, settings }),
          'prepare',
        )
      ).seed,
    setupForDate: async (challengeDate, settings) =>
      (
        await responseFor(
          await rpc('prepare', { challengeDate, settings }),
          'prepare',
        )
      ).setup,
    validateSetup: async (setup) => {
      responseFor(await rpc('validateSetup', { setup }), 'validateSetup');
    },
    participants: async (context: DailyChallengeParticipantContext) =>
      responseFor(
        await rpc(
          'participants',
          { context },
          routeFor(
            description,
            'participants',
            context.challengeDate,
            context.sessionId,
          ),
        ),
        'participants',
      ).participants,
    score: async (result: GameResult, admission: MatchAdmission) =>
      responseFor(
        await rpc('score', { result, admission }, admission.route),
        'score',
      ).score,
  };
}
