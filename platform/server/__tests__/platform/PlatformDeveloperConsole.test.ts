import { contractError, type SessionRoute } from '@board-game/contracts';
import { describe, expect, it, vi } from 'vitest';
import { PlatformDeveloperConsole } from '@/platform/PlatformDeveloperConsole.js';
import { PlatformController } from '@/platform/platform.controller.js';

const route: SessionRoute = {
  gameId: 'brass',
  modeId: 'casual',
  sessionId: 'session-1',
  releaseId: 'retained-v1',
  backendBindingId: 'old-host',
  storageBindingId: 'game-store',
  ownershipEpoch: 'epoch-1',
};
const reference = { principalId: 'admin', authSessionId: 'auth-1' };
const accessContext = {
  principalId: 'admin',
  authEpoch: 'current',
  scopes: ['session:admin', 'session:developer'],
};
const mutation = {
  commandId: 'command-1',
  expectedRevision: 7,
  command: {
    name: 'player-stat',
    input: { playerId: 'p1', stat: 'money', mode: 'set', amount: 40 },
  },
};

function fixture() {
  const developerAccess = vi.fn(async () => accessContext);
  const getDeveloperConsole = vi.fn(async () => ({
    catalog: [],
    enabled: true,
    revision: 7,
  }));
  const submitDeveloperCommand = vi.fn(async () => ({
    receipt: {
      commandId: 'command-1',
      sessionId: 'session-1',
      status: 'accepted',
    },
    revision: 8,
  }));
  const runtime = {
    admissionStore: { getAdmission: vi.fn(async () => ({ route })) },
    releaseGame: vi.fn(() => ({ identity: { developerAccess } })),
    resolveBackend: vi.fn(() => ({
      getDeveloperConsole,
      submitDeveloperCommand,
    })),
  };
  return {
    runtime,
    developerAccess,
    getDeveloperConsole,
    submitDeveloperCommand,
    console: new PlatformDeveloperConsole(runtime as never),
  };
}

describe('platform developer console', () => {
  it('resolves the exact retained release and constructs authority server-side', async () => {
    const fixture_ = fixture();
    await fixture_.console.describe(reference, route.sessionId);
    await fixture_.console.submit(reference, route.sessionId, mutation);
    expect(fixture_.runtime.releaseGame).toHaveBeenCalledWith(
      'brass',
      'retained-v1',
    );
    expect(fixture_.developerAccess).toHaveBeenCalledTimes(2);
    expect(fixture_.developerAccess).toHaveBeenCalledWith(reference, route);
    expect(fixture_.submitDeveloperCommand).toHaveBeenCalledWith({
      protocolVersion: 1,
      route,
      accessContext,
      ...mutation,
    });
  });

  it('stops before contacting the Host when current operator authority is denied', async () => {
    const fixture_ = fixture();
    fixture_.developerAccess.mockRejectedValue(
      contractError('FORBIDDEN', 'denied'),
    );
    await expect(
      fixture_.console.submit(reference, route.sessionId, mutation),
    ).rejects.toMatchObject({ envelope: { code: 'FORBIDDEN' } });
    expect(fixture_.runtime.resolveBackend).not.toHaveBeenCalled();
    expect(fixture_.submitDeveloperCommand).not.toHaveBeenCalled();
  });

  it('does not fall back when a pinned release has no operator adapter', async () => {
    const fixture_ = fixture();
    fixture_.runtime.releaseGame.mockReturnValue({ identity: {} } as never);
    await expect(
      fixture_.console.describe(reference, route.sessionId),
    ).rejects.toMatchObject({ envelope: { code: 'NOT_READY' } });
    expect(fixture_.runtime.resolveBackend).not.toHaveBeenCalled();
  });

  it('rejects browser authority, route overrides and malformed command inputs', async () => {
    const fixture_ = fixture();
    const controller = new PlatformController(fixture_.runtime as never);
    const request = { user: { sub: 'admin', sid: 'auth-1' } } as never;
    for (const body of [
      { ...mutation, accessContext },
      { ...mutation, route: { ...route, releaseId: 'latest' } },
      { ...mutation, command: { ...mutation.command, actor: 'admin' } },
      { ...mutation, expectedRevision: -1 },
    ]) {
      expect(() =>
        controller.submitDeveloperCommand(request, route.sessionId, body),
      ).toThrow();
    }
    expect(fixture_.submitDeveloperCommand).not.toHaveBeenCalled();
    await controller.submitDeveloperCommand(request, route.sessionId, mutation);
    expect(fixture_.submitDeveloperCommand).toHaveBeenCalledTimes(1);
  });
});
