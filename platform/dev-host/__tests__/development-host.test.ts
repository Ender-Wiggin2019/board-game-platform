import {
  type GameServiceDescription,
  type JsonObject,
} from '@board-game/contracts';
import {
  defineCommandService,
  defineGameServer,
  GAME_SERVICE_COMMAND_TYPE,
} from '@board-game/server';
import {
  type SequentialTurnCommand,
  type SequentialTurnSetup,
  sequentialTurnFixture,
} from '@board-game/testing/fixtures';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createDevelopmentHost,
  type DevelopmentHost,
  type DevelopmentScenario,
} from '../src/index.js';

const replaySchema = {
  name: 'dev-host.replay-query',
  version: 1,
  schema: {
    type: 'object' as const,
    additionalProperties: true as const,
  },
};

const commandSchema = {
  name: 'dev-host.claim-input',
  version: 1,
  schema: {
    type: 'object' as const,
    properties: { action: { type: 'string' as const, enum: ['claim'] } },
    required: ['action'],
    additionalProperties: false,
  },
};

interface StorageOptions {
  readonly storageProfile?: 'memory' | 'postgres';
  readonly databaseUrl?: string;
}

const claimService = defineCommandService<
  JsonObject,
  { readonly type: 'claim' }
>({
  key: 'claim',
  operation: 'command',
  parse: (input) => input as JsonObject,
  toCommand: () => ({ type: 'claim' }),
});

function makeHost(
  scenarios: readonly DevelopmentScenario<
    SequentialTurnCommand,
    SequentialTurnSetup
  >[] = [],
  storageOptions: StorageOptions = {},
): DevelopmentHost {
  const module = {
    ...sequentialTurnFixture,
    turn: () => null,
    schemas: { ...sequentialTurnFixture.schemas, query: replaySchema },
    rules: {
      ...sequentialTurnFixture.rules,
      query: (_state: unknown, query: JsonObject): JsonObject => {
        if (query.type === 'dev-replay-manifest')
          return {
            type: 'dev-replay-manifest-answer',
            eventLimit:
              typeof query.eventLimit === 'number' ? query.eventLimit : 200,
          };
        if (query.type === 'dev-replay-frames')
          return {
            type: 'dev-replay-frames-answer',
            from: typeof query.from === 'number' ? query.from : 0,
            limit: typeof query.limit === 'number' ? query.limit : 1,
            frames: [],
          };
        return { type: 'dev-replay-unknown-answer' };
      },
    },
  } as unknown as typeof sequentialTurnFixture;
  const definition = defineGameServer({
    manifest: {
      gameId: sequentialTurnFixture.gameId,
      releaseId: sequentialTurnFixture.releaseId,
    },
    module,
    services: {
      commands: [claimService],
      replay: {
        queries: {
          manifest: (eventLimit) => ({
            type: 'dev-replay-manifest',
            eventLimit,
          }),
          frames: (from, limit) => ({
            type: 'dev-replay-frames',
            from,
            limit,
          }),
        },
      },
    },
  });
  const description: GameServiceDescription = {
    schemaVersion: 1,
    platformId: 'dev-host-test',
    gameId: sequentialTurnFixture.gameId,
    releaseId: sequentialTurnFixture.releaseId,
    backendBindingId: 'dev-host-backend',
    storageBindingId: 'dev-host-storage',
    ownershipEpoch: 'dev-host-owner-v1',
    metadata: {
      gameId: sequentialTurnFixture.gameId,
      name: 'Development fixture',
      description: 'A real Host-backed development fixture.',
      themeId: 'development-fixture',
    },
    modes: sequentialTurnFixture.modes,
    setupSchema: sequentialTurnFixture.schemas.setup,
    replay: {
      manifestQuery: { type: 'dev-replay-manifest', eventLimit: 200 },
      framesQueryType: 'dev-replay-frames',
    },
    commands: [
      { key: 'claim', operation: 'command', inputSchema: commandSchema },
    ],
  };
  return createDevelopmentHost({
    definition,
    description,
    scenarios,
    seed: 'test-seed',
    ...storageOptions,
  });
}

// biome-ignore lint/suspicious/noExplicitAny: HTTP black-box assertions intentionally inspect arbitrary JSON fields.
type JsonResponse = Record<string, any>;

async function request(
  baseURL: string,
  path: string,
  init: RequestInit = {},
): Promise<{ readonly response: Response; readonly body: JsonResponse }> {
  const response = await fetch(`${baseURL}${path}`, init);
  const body = (await response.json()) as JsonResponse;
  return { response, body };
}

function jsonHeaders(token?: string): HeadersInit {
  return {
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

async function select(baseURL: string, principalId: string): Promise<string> {
  const { response, body } = await request(baseURL, '/v1/auth/select', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ principalId }),
  });
  expect(response.status).toBe(200);
  return body.token as string;
}

const hosts: DevelopmentHost[] = [];
const postgresDatabaseUrl = process.env.BGP_DEV_HOST_TEST_DATABASE_URL;
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
});

describe('memory development host', () => {
  it('rejects production and PostgreSQL profiles without an explicit database', () => {
    expect(() =>
      createDevelopmentHost({
        definition: undefined as never,
        description: undefined as never,
        mode: 'production',
      }),
    ).toThrow('dev-host.production_unsupported');
    expect(() =>
      createDevelopmentHost({
        definition: undefined as never,
        description: undefined as never,
        storageProfile: 'postgres',
      }),
    ).toThrow('dev-host.postgres_database_url_required');
  });

  it('serves the packaged UI and rejects cross-origin browser requests', async () => {
    const host = makeHost();
    hosts.push(host);
    const baseURL = await host.start();

    const ui = await fetch(`${baseURL}/`);
    expect(ui.status).toBe(200);
    expect(ui.headers.get('content-type')).toContain('text/html');
    expect(await ui.text()).toContain('Development host');

    const script = await fetch(`${baseURL}/assets/dev-host.js`);
    expect(script.status).toBe(200);
    expect(script.headers.get('content-type')).toContain('text/javascript');
    expect((await script.text()).length).toBeGreaterThan(1_000);

    const crossOrigin = await fetch(`${baseURL}/v1/accounts`, {
      headers: { origin: 'https://evil.example' },
    });
    expect(crossOrigin.status).toBe(403);

    const preflight = await fetch(`${baseURL}/v1/auth/select`, {
      method: 'OPTIONS',
      headers: {
        origin: baseURL,
        'access-control-request-method': 'POST',
      },
    });
    expect(preflight.status).toBe(403);
  });

  it('runs a real multi-account HTTP lifecycle with privacy, retry, replay and reset fences', async () => {
    const host = makeHost();
    hosts.push(host);
    const baseURL = await host.start();
    const player1 = await select(baseURL, 'player1');
    const player2 = await select(baseURL, 'player2');
    const observer = await select(baseURL, 'observer');

    const created = await request(baseURL, '/v1/rooms', {
      method: 'POST',
      headers: jsonHeaders(player1),
      body: JSON.stringify({ setup: { target: 1 } }),
    });
    expect(created.response.status).toBe(200);
    const room = created.body.room;
    const joined = await request(baseURL, `/v1/rooms/${room.id}/join`, {
      method: 'POST',
      headers: jsonHeaders(player2),
      body: JSON.stringify({ expectedRevision: room.revision }),
    });
    const roomWithTwo = joined.body;
    const ready1 = await request(baseURL, `/v1/rooms/${room.id}/ready`, {
      method: 'POST',
      headers: jsonHeaders(player1),
      body: JSON.stringify({
        expectedRevision: roomWithTwo.revision,
        ready: true,
      }),
    });
    const ready2 = await request(baseURL, `/v1/rooms/${room.id}/ready`, {
      method: 'POST',
      headers: jsonHeaders(player2),
      body: JSON.stringify({
        expectedRevision: ready1.body.revision,
        ready: true,
      }),
    });
    const started = await request(baseURL, `/v1/rooms/${room.id}/start`, {
      method: 'POST',
      headers: jsonHeaders(player1),
      body: JSON.stringify({
        expectedRevision: ready2.body.revision,
        requestId: 'dev-start-1',
      }),
    });
    expect(started.response.status).toBe(200);
    const sessionId = started.body.start.sessionId as string;

    const playerView = await request(
      baseURL,
      `/v1/sessions/${sessionId}/view`,
      {
        headers: jsonHeaders(player1),
      },
    );
    const observerView = await request(
      baseURL,
      `/v1/sessions/${sessionId}/view`,
      {
        headers: jsonHeaders(observer),
      },
    );
    expect(playerView.response.status).toBe(200);
    expect(observerView.response.status).toBe(200);
    expect(playerView.body.payload.you.seatId).toBeTruthy();
    expect(observerView.body.payload.you.seatId).toBeNull();

    const transportEvents = await request(
      baseURL,
      `/v1/sessions/${sessionId}/events`,
      {
        method: 'POST',
        headers: jsonHeaders(player1),
        body: JSON.stringify({ afterSequence: 0, limit: 10 }),
      },
    );
    expect(transportEvents.response.status).toBe(200);
    const transportResume = await request(
      baseURL,
      `/v1/sessions/${sessionId}/resume`,
      {
        method: 'POST',
        headers: jsonHeaders(player1),
        body: JSON.stringify({
          viewerEpoch: playerView.body.viewEpoch,
          streamCursor: playerView.body.streamCursor,
        }),
      },
    );
    expect(transportResume.response.status).toBe(200);

    const command = {
      commandId: 'dev-command-1',
      precondition: { kind: 'revision', expectedRevision: 1 },
      command: {
        type: GAME_SERVICE_COMMAND_TYPE,
        key: 'claim',
        input: { action: 'claim' },
      },
    };
    const first = await request(baseURL, `/v1/sessions/${sessionId}/command`, {
      method: 'POST',
      headers: jsonHeaders(player1),
      body: JSON.stringify(command),
    });
    const retry = await request(baseURL, `/v1/sessions/${sessionId}/command`, {
      method: 'POST',
      headers: jsonHeaders(player1),
      body: JSON.stringify(command),
    });
    const pluralRetry = await request(
      baseURL,
      `/v1/sessions/${sessionId}/commands`,
      {
        method: 'POST',
        headers: jsonHeaders(player1),
        body: JSON.stringify(command),
      },
    );
    expect(first.body.receipt.status).toBe('accepted');
    expect(retry.body.receipt.status).toBe('duplicate');
    expect(pluralRetry.body.receipt.status).toBe('duplicate');
    expect(retry.body.receipt.persistedRevision).toBe(
      first.body.receipt.persistedRevision,
    );

    const summary = await request(
      baseURL,
      `/v1/sessions/${sessionId}/summary`,
      {
        headers: jsonHeaders(player2),
      },
    );
    expect(summary.body.status).toBe('completed');
    const events = await request(
      baseURL,
      `/v1/sessions/${sessionId}/events?afterSequence=0&limit=10`,
      {
        headers: jsonHeaders(observer),
      },
    );
    expect(events.response.status).toBe(200);
    const result = await request(
      baseURL,
      `/v1/sessions/${sessionId}/terminal`,
      {
        headers: jsonHeaders(observer),
      },
    );
    expect(result.body.status).toBe('completed');
    expect(result.body.result.kind).toBe('competitive');

    const replayManifest = await request(
      baseURL,
      `/v1/sessions/${sessionId}/replay/manifest`,
      { headers: jsonHeaders(observer) },
    );
    expect(replayManifest.body.answer).toEqual({
      type: 'dev-replay-manifest-answer',
      eventLimit: 200,
    });
    const replayFrames = await request(
      baseURL,
      `/v1/sessions/${sessionId}/replay/frames?from=0&limit=10`,
      { headers: jsonHeaders(observer) },
    );
    expect(replayFrames.body.answer.type).toBe('dev-replay-frames-answer');
    expect(replayFrames.body.answer.frames).toEqual([]);

    const reset = await request(baseURL, `/v1/sessions/${sessionId}/reset`, {
      method: 'POST',
      headers: jsonHeaders(player1),
      body: '{}',
    });
    expect(reset.response.status).toBe(200);
    const resetSessionId = reset.body.sessionId as string;
    expect(resetSessionId).not.toBe(sessionId);
    const oldToken = await request(
      baseURL,
      `/v1/sessions/${resetSessionId}/view`,
      {
        headers: jsonHeaders(player1),
      },
    );
    expect(oldToken.response.status).toBe(401);
    const newPlayer1 = await select(baseURL, 'player1');
    const reconnected = await request(
      baseURL,
      `/v1/sessions/${resetSessionId}/view`,
      {
        headers: jsonHeaders(newPlayer1),
      },
    );
    expect(reconnected.response.status).toBe(200);
  });

  it.skipIf(!postgresDatabaseUrl)(
    'recovers rooms, sessions, receipts, replay and reset auth epochs after PostgreSQL close/recreate',
    async () => {
      const storageOptions = {
        storageProfile: 'postgres' as const,
        databaseUrl: postgresDatabaseUrl as string,
      };
      const firstHost = makeHost([], storageOptions);
      hosts.push(firstHost);
      const firstURL = await firstHost.start();
      const player1 = await select(firstURL, 'player1');
      const player2 = await select(firstURL, 'player2');
      const created = await request(firstURL, '/v1/rooms', {
        method: 'POST',
        headers: jsonHeaders(player1),
        body: JSON.stringify({ setup: { target: 1 } }),
      });
      expect(created.response.status).toBe(200);
      const room = created.body.room;
      const joined = await request(firstURL, `/v1/rooms/${room.id}/join`, {
        method: 'POST',
        headers: jsonHeaders(player2),
        body: JSON.stringify({ expectedRevision: room.revision }),
      });
      const ready1 = await request(firstURL, `/v1/rooms/${room.id}/ready`, {
        method: 'POST',
        headers: jsonHeaders(player1),
        body: JSON.stringify({ expectedRevision: joined.body.revision }),
      });
      const ready2 = await request(firstURL, `/v1/rooms/${room.id}/ready`, {
        method: 'POST',
        headers: jsonHeaders(player2),
        body: JSON.stringify({ expectedRevision: ready1.body.revision }),
      });
      const started = await request(firstURL, `/v1/rooms/${room.id}/start`, {
        method: 'POST',
        headers: jsonHeaders(player1),
        body: JSON.stringify({ expectedRevision: ready2.body.revision }),
      });
      expect(started.response.status).toBe(200);
      const sessionId = started.body.start.sessionId as string;
      const command = {
        commandId: 'postgres-recovery-command-1',
        precondition: { kind: 'revision', expectedRevision: 1 },
        command: {
          type: GAME_SERVICE_COMMAND_TYPE,
          key: 'claim',
          input: { action: 'claim' },
        },
      };
      const accepted = await request(
        firstURL,
        `/v1/sessions/${sessionId}/command`,
        {
          method: 'POST',
          headers: jsonHeaders(player1),
          body: JSON.stringify(command),
        },
      );
      expect(accepted.body.receipt.status).toBe('accepted');
      const firstView = await request(
        firstURL,
        `/v1/sessions/${sessionId}/view`,
        { headers: jsonHeaders(player1) },
      );
      expect(firstView.response.status).toBe(200);
      const firstReplay = await request(
        firstURL,
        `/v1/sessions/${sessionId}/replay/manifest`,
        { headers: jsonHeaders(player2) },
      );
      expect(firstReplay.response.status).toBe(200);

      await firstHost.close();

      const secondHost = makeHost([], storageOptions);
      hosts.push(secondHost);
      const secondURL = await secondHost.start();
      const staleToken = await request(
        secondURL,
        `/v1/sessions/${sessionId}/view`,
        { headers: jsonHeaders(player1) },
      );
      expect(staleToken.response.status).toBe(401);
      const reconnectedPlayer1 = await select(secondURL, 'player1');
      const reconnectedPlayer2 = await select(secondURL, 'player2');
      const recoveredRoom = await request(secondURL, `/v1/rooms/${room.id}`, {
        headers: jsonHeaders(reconnectedPlayer1),
      });
      expect(recoveredRoom.response.status).toBe(200);
      expect(recoveredRoom.body.id).toBe(room.id);
      const recoveredSummary = await request(
        secondURL,
        `/v1/sessions/${sessionId}/summary`,
        { headers: jsonHeaders(reconnectedPlayer1) },
      );
      expect(recoveredSummary.response.status).toBe(200);
      expect(recoveredSummary.body.status).toBe('completed');
      const duplicate = await request(
        secondURL,
        `/v1/sessions/${sessionId}/command`,
        {
          method: 'POST',
          headers: jsonHeaders(reconnectedPlayer1),
          body: JSON.stringify(command),
        },
      );
      expect(duplicate.response.status).toBe(200);
      expect(duplicate.body.receipt.status).toBe('duplicate');
      const recoveredReplay = await request(
        secondURL,
        `/v1/sessions/${sessionId}/replay/manifest`,
        { headers: jsonHeaders(reconnectedPlayer2) },
      );
      expect(recoveredReplay.response.status).toBe(200);
      expect(recoveredReplay.body.answer.type).toBe(
        'dev-replay-manifest-answer',
      );
      const reset = await request(
        secondURL,
        `/v1/sessions/${sessionId}/reset`,
        {
          method: 'POST',
          headers: jsonHeaders(reconnectedPlayer1),
          body: '{}',
        },
      );
      expect(reset.response.status).toBe(200);
      const resetSessionId = reset.body.sessionId as string;
      expect(resetSessionId).not.toBe(sessionId);
      const resetEpochToken = await request(
        secondURL,
        `/v1/sessions/${resetSessionId}/view`,
        { headers: jsonHeaders(reconnectedPlayer1) },
      );
      expect(resetEpochToken.response.status).toBe(401);
      const resetPlayer1 = await select(secondURL, 'player1');
      const resetView = await request(
        secondURL,
        `/v1/sessions/${resetSessionId}/view`,
        { headers: jsonHeaders(resetPlayer1) },
      );
      expect(resetView.response.status).toBe(200);
    },
  );

  it('builds a terminal fixture by applying scenario commands through the gateway', async () => {
    const host = makeHost([
      {
        id: 'one-claim',
        setup: { target: 1 },
        seed: 'scenario-seed',
        commands: [
          {
            principalId: 'player1',
            command: { key: 'claim', input: { action: 'claim' } },
          },
        ],
      },
    ]);
    hosts.push(host);
    const baseURL = await host.start();
    const player1 = await select(baseURL, 'player1');
    const player2 = await select(baseURL, 'player2');
    const created = await request(baseURL, '/v1/rooms', {
      method: 'POST',
      headers: jsonHeaders(player1),
      body: JSON.stringify({ scenarioId: 'one-claim' }),
    });
    const room = created.body.room;
    const joined = await request(baseURL, `/v1/rooms/${room.id}/join`, {
      method: 'POST',
      headers: jsonHeaders(player2),
      body: JSON.stringify({ expectedRevision: room.revision }),
    });
    const ready1 = await request(baseURL, `/v1/rooms/${room.id}/ready`, {
      method: 'POST',
      headers: jsonHeaders(player1),
      body: JSON.stringify({ expectedRevision: joined.body.revision }),
    });
    const ready2 = await request(baseURL, `/v1/rooms/${room.id}/ready`, {
      method: 'POST',
      headers: jsonHeaders(player2),
      body: JSON.stringify({ expectedRevision: ready1.body.revision }),
    });
    const started = await request(baseURL, `/v1/rooms/${room.id}/start`, {
      method: 'POST',
      headers: jsonHeaders(player1),
      body: JSON.stringify({ expectedRevision: ready2.body.revision }),
    });
    expect(started.response.status).toBe(200);
    const summary = await request(
      baseURL,
      `/v1/sessions/${started.body.start.sessionId}/summary`,
      { headers: jsonHeaders(player1) },
    );
    expect(summary.body.status).toBe('completed');
    const admission = await host.admission.getStart(room.id);
    expect(admission?.seed).toContain('scenario-seed');
  });
});
