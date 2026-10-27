import type { GameSchemas, JsonObject } from '@board-game/contracts';
import type {
  CommandResponse,
  InboxEnvelope,
  SessionGateway,
} from '@board-game/core';
import type { GameModule } from '@board-game/sdk';
import { describe, expect, it, vi } from 'vitest';
import {
  defineCommandService,
  defineGameServer,
  type GameResultPresenter,
  type GameServerDefinition,
  type GameServerInstallContext,
  type GameServerManifest,
  type GameServerServices,
  installGameServer,
} from '../src/index.js';

type FixtureModule = GameModule<
  JsonObject,
  JsonObject,
  JsonObject,
  JsonObject,
  JsonObject,
  JsonObject,
  JsonObject,
  JsonObject
>;
type FixtureContext = { readonly installed: string };
type FixtureDefinition = GameServerDefinition<
  JsonObject,
  JsonObject,
  JsonObject,
  JsonObject,
  JsonObject,
  JsonObject,
  JsonObject,
  JsonObject,
  GameServerManifest,
  FixtureContext
>;

type Call =
  | 'host'
  | 'commands'
  | 'replay'
  | 'queries'
  | 'settlement'
  | 'fact'
  | 'recovery'
  | 'platform';

const schemas: GameSchemas = {
  setup: {
    name: 'fixture.setup',
    version: 1,
    schema: { type: 'object', additionalProperties: true },
  },
  command: {
    name: 'fixture.command',
    version: 1,
    schema: { type: 'object', additionalProperties: true },
  },
};

const module: FixtureModule = {
  gameId: 'fixture',
  releaseId: 'fixture-v1',
  stateSchemaVersion: 1,
  viewSchemaVersion: 1,
  modes: [],
  schemas,
  rules: {
    create: () => ({}),
    execute: (state) => ({ ok: true, state, events: [] }),
    project: () => ({}),
    projectEvent: () => null,
    encode: (state) => state,
    decode: (saved) => saved as JsonObject,
  },
  summarize: (state) => state,
  turn: () => null,
  collectFacts: () => [],
  completion: () => ({ finished: false }),
};

const presenter: GameResultPresenter = {
  getCompletion: async () => null,
  getEndRecord: async () => null,
  getSettlement: async () => null,
  getReplayManifest: async () => null,
  getReplayFrames: async () => null,
};

function definition(
  platform: (context: FixtureContext) => void = () => undefined,
): FixtureDefinition {
  const command = defineCommandService<JsonObject, JsonObject>({
    key: 'undo',
    operation: 'undo',
    parse: (input) => {
      if (!input || typeof input !== 'object' || Array.isArray(input))
        throw new Error('invalid input');
      return input as JsonObject;
    },
    toCommand: (input) => ({ type: 'undo', ...input }),
  });
  const services: GameServerServices<JsonObject, FixtureContext> = {
    commands: [command],
    replay: {
      presenter,
      queries: {
        manifest: (eventLimit) => ({ type: 'manifest', eventLimit }),
        frames: (from, limit) => ({ type: 'frames', from, limit }),
      },
      settlement: async () => ({ settled: true }),
    },
    facts: [
      {
        key: 'fixture:fact:v1',
        consume: async (_envelope: InboxEnvelope) => undefined,
      },
    ],
    recovery: [
      {
        key: 'fixture:recovery:v1',
        recover: async () => undefined,
      },
    ],
    platform,
  };
  return defineGameServer({
    manifest: { gameId: 'fixture', releaseId: 'fixture-v1' },
    module,
    services,
  });
}

function context(
  calls: Call[],
): GameServerInstallContext<
  GameServerManifest,
  FixtureModule,
  string,
  FixtureContext,
  JsonObject
> {
  const response = {} as CommandResponse;
  return {
    installHost: () => {
      calls.push('host');
      return 'installed';
    },
    submitCommand: async (_reference, _sessionId, input) => {
      calls.push('commands');
      expect(input.command).toEqual({ type: 'undo', scope: 'turn' });
      return response;
    },
    registerCommandServices: (_gameId, _releaseId, services) => {
      calls.push('commands');
      expect(services.list()).toHaveLength(1);
    },
    registerReplay: () => calls.push('replay'),
    registerReplayQueries: () => calls.push('queries'),
    registerSettlement: () => calls.push('settlement'),
    registerView: (
      _gameId,
      _releaseId,
      _presenter: Pick<SessionGateway, 'view' | 'resume' | 'command'>,
    ) => undefined,
    registerFactConsumer: () => calls.push('fact'),
    registerRecoveryHook: () => calls.push('recovery'),
    createPlatformContext: () => ({ installed: 'installed' }),
  };
}

describe('game server definition and installation', () => {
  it('requires a turn contract for newly installed game servers', () => {
    expect(() =>
      defineGameServer({
        ...definition(),
        module: { ...module, turn: undefined },
      }),
    ).toThrow('server.definition.turnRequired');
  });
  it('preflights declared replay registrations before installing Host', () => {
    const calls: Call[] = [];
    const incomplete = context(calls);
    const { registerReplayQueries: _registerReplayQueries, ...withoutQueries } =
      incomplete;

    expect(() => installGameServer(definition(), withoutQueries)).toThrow(
      expect.objectContaining({
        envelope: expect.objectContaining({
          messageKey: 'server.install.register_replay_queries',
        }),
      }),
    );
    expect(calls).toEqual([]);
  });

  it('propagates platform registration failure without claiming an installation', () => {
    const calls: Call[] = [];
    const rollback = vi.fn();
    expect(() =>
      installGameServer(
        definition(() => {
          calls.push('platform');
          throw new Error('capability registration failed');
        }),
        { ...context(calls), rollback },
      ),
    ).toThrow('capability registration failed');
    expect(rollback).toHaveBeenCalledWith('installed');
    expect(calls).toEqual([
      'host',
      'commands',
      'replay',
      'queries',
      'settlement',
      'fact',
      'recovery',
      'platform',
    ]);
  });

  it('registers declared services and routes typed commands through the submitter', async () => {
    const calls: Call[] = [];
    let installedContext: FixtureContext | undefined;
    const installed = installGameServer(
      definition((value) => {
        installedContext = value;
        calls.push('platform');
      }),
      context(calls),
    );

    expect(installed.installed).toBe('installed');
    expect(installedContext).toEqual({ installed: 'installed' });
    expect(calls).toEqual([
      'host',
      'commands',
      'replay',
      'queries',
      'settlement',
      'fact',
      'recovery',
      'platform',
    ]);

    await installed.commandServices.invoke(
      { principalId: 'p-1', authSessionId: 'auth-1' },
      'session-1',
      'undo',
      {
        commandId: 'command-1',
        precondition: { kind: 'revision', expectedRevision: 1 },
        input: { scope: 'turn' },
      },
    );
    expect(calls).toContain('commands');
  });
});
