import { type JsonObject } from '@board-game/contracts';
import type { PlatformIdentityReference } from '@board-game/core';
import type { GameModule } from '@board-game/sdk';
import { defineCommandService, defineGameServer } from '@board-game/server';
import { describe, expect, it, vi } from 'vitest';
import type { PlatformGameServerManifest } from '@/platform/GameServerInstaller.js';
import { installPlatformGameServer } from '@/platform/GameServerInstaller.js';
import type { PlatformApplicationRuntime } from '@/platform/PlatformApplicationRuntime.js';

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

function definition(platform?: () => void) {
  const module = {
    gameId: 'fixture',
    releaseId: 'fixture-v1',
    turn: () => null,
  } as unknown as FixtureModule;
  const manifest = {
    gameId: module.gameId,
    releaseId: module.releaseId,
  } as PlatformGameServerManifest;
  return defineGameServer({
    manifest,
    module,
    services: {
      commands: [
        defineCommandService<JsonObject, JsonObject>({
          key: 'undo',
          operation: 'undo',
          parse: (input) => input as JsonObject,
          toCommand: (input) => ({ type: 'undo', ...input }),
        }),
      ],
      ...(platform ? { platform } : {}),
    },
  });
}

function platformForRoute(route: { gameId: string; releaseId?: string }) {
  const command = vi.fn(async () => ({}) as never);
  const platform = {
    registerGame: vi.fn(() => ({}) as never),
    sessions: {
      descriptor: vi.fn(
        async (_reference: PlatformIdentityReference, _sessionId: string) => ({
          route,
        }),
      ),
    },
    views: {
      command,
      register: vi.fn(),
    },
    results: {
      register: vi.fn(),
      registerReplayQueries: vi.fn(),
      registerSettlement: vi.fn(),
    },
    registerCommandServices: vi.fn(),
    registerFactConsumer: vi.fn(),
    registerRecoveryHook: vi.fn(),
    abortGameRegistration: vi.fn(),
  } as unknown as PlatformApplicationRuntime;
  return { platform, command };
}

function platformForWrongGame() {
  return platformForRoute({ gameId: 'another-game' });
}

describe('platform game server bridge', () => {
  it('rejects a service command when the session route belongs to another game', async () => {
    const { platform, command } = platformForWrongGame();
    const installed = installPlatformGameServer(definition(), { platform });

    await expect(
      installed.commandServices.invoke(
        { principalId: 'p-1', authSessionId: 'auth-1' },
        'session-1',
        'undo',
        {
          commandId: 'command-1',
          precondition: { kind: 'revision', expectedRevision: 1 },
          input: {},
        },
      ),
    ).rejects.toMatchObject({
      envelope: expect.objectContaining({ code: 'FORBIDDEN' }),
    });
    expect(command).not.toHaveBeenCalled();
  });

  it('rejects a service command when the session route belongs to another release', async () => {
    const { platform, command } = platformForRoute({
      gameId: 'fixture',
      releaseId: 'fixture-v0',
    });
    const installed = installPlatformGameServer(definition(), { platform });

    await expect(
      installed.commandServices.invoke(
        { principalId: 'p-1', authSessionId: 'auth-1' },
        'session-1',
        'undo',
        {
          commandId: 'command-1',
          precondition: { kind: 'revision', expectedRevision: 1 },
          input: {},
        },
      ),
    ).rejects.toMatchObject({
      envelope: expect.objectContaining({ code: 'NOT_READY' }),
    });
    expect(command).not.toHaveBeenCalled();
  });

  it('closes the platform registration after a later service fails', () => {
    const { platform } = platformForWrongGame();

    expect(() =>
      installPlatformGameServer(
        definition(() => {
          throw new Error('capability registration failed');
        }),
        { platform },
      ),
    ).toThrow('capability registration failed');
    expect(platform.abortGameRegistration).toHaveBeenCalledOnce();
  });
});
