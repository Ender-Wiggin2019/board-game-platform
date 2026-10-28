import {
  contractError,
  type SessionRoute,
  type SubmitDeveloperCommandResponse,
} from '@board-game/contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  createDeveloperConsoleRuntime,
  DeveloperConsoleSession,
  type GameDeveloperConsoleRuntime,
} from '../src/DeveloperConsole.js';

const route: SessionRoute = {
  gameId: 'example',
  modeId: 'casual',
  releaseId: 'v1',
  sessionId: 'session-1',
  backendBindingId: 'host',
  storageBindingId: 'store',
  ownershipEpoch: 'epoch',
};
const command = { name: 'set-money', input: { playerId: 'p1', amount: 40 } };
const accepted: SubmitDeveloperCommandResponse = {
  receipt: {
    commandId: 'command-1',
    sessionId: route.sessionId,
    status: 'accepted',
    persistedRevision: 8,
    resultRetention: 'replayable',
  },
  revision: 8,
};

function fixture() {
  const runtime = {
    describe: vi.fn(async () => ({ catalog: [], enabled: true, revision: 7 })),
    submit: vi.fn<GameDeveloperConsoleRuntime['submit']>(),
  };
  const nextId = vi.fn(() => 'command-1');
  return {
    runtime,
    nextId,
    client: new DeveloperConsoleSession(runtime, route, nextId),
  };
}

describe('developer console transport', () => {
  it('keeps the original request after a lost acknowledgement', async () => {
    const { runtime, client, nextId } = fixture();
    runtime.submit
      .mockRejectedValueOnce(new Error('connection closed'))
      .mockResolvedValueOnce(accepted);
    const original = structuredClone(command);
    await expect(client.submit(original, 7)).rejects.toThrow(
      'connection closed',
    );
    original.input.amount = 99;
    expect(() => client.submit(command, 8)).toThrow(
      'client.developer.retry_pending',
    );
    await client.retryPending();
    expect(runtime.submit.mock.calls[0]).toEqual(runtime.submit.mock.calls[1]);
    expect(runtime.submit.mock.calls[1]?.[1]).toEqual({
      commandId: 'command-1',
      expectedRevision: 7,
      command,
    });
    expect(nextId).toHaveBeenCalledTimes(1);
    expect(client.pendingCommand).toBeNull();
  });

  it('retains unknown outcomes and releases definitive rejected receipts', async () => {
    const { runtime, client } = fixture();
    runtime.submit
      .mockResolvedValueOnce({
        ...accepted,
        receipt: { ...accepted.receipt, status: 'unknown' },
      })
      .mockResolvedValueOnce({
        ...accepted,
        receipt: { ...accepted.receipt, status: 'rejected' },
      });
    await client.submit(command, 7);
    expect(client.pendingCommand?.commandId).toBe('command-1');
    await client.retryPending();
    expect(client.pendingCommand).toBeNull();
  });

  it('allows a fresh attempt after a definitive stale rejection', async () => {
    const { runtime, client } = fixture();
    runtime.submit
      .mockRejectedValueOnce(contractError('STALE_REVISION', 'stale'))
      .mockResolvedValueOnce(accepted);
    await expect(client.submit(command, 6)).rejects.toThrow('stale');
    expect(client.pendingCommand).toBeNull();
    await client.submit(command, 7);
    expect(runtime.submit.mock.calls[1]?.[1].expectedRevision).toBe(7);
  });

  it('preserves an unknown outcome when a later retry loses authorization', async () => {
    const { runtime, client } = fixture();
    runtime.submit
      .mockRejectedValueOnce(new Error('connection closed'))
      .mockRejectedValueOnce(contractError('FORBIDDEN', 'revoked'));
    await expect(client.submit(command, 7)).rejects.toThrow(
      'connection closed',
    );
    await expect(client.retryPending()).rejects.toThrow('revoked');
    expect(client.pendingCommand?.expectedRevision).toBe(7);
  });

  it('rejects a receipt for another session without forgetting the pending command', async () => {
    const { runtime, client } = fixture();
    runtime.submit.mockResolvedValue({
      ...accepted,
      receipt: { ...accepted.receipt, sessionId: 'another-session' },
    });
    await expect(client.submit(command, 7)).rejects.toThrow(
      'client.developer.receipt_mismatch',
    );
    expect(client.pendingCommand?.commandId).toBe('command-1');
  });

  it('does not duplicate an in-flight request', async () => {
    const { runtime, client } = fixture();
    let resolve!: (value: SubmitDeveloperCommandResponse) => void;
    runtime.submit.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const first = client.submit(command, 7);
    await expect(client.retryPending()).rejects.toThrow(
      'client.developer.submitting',
    );
    resolve(accepted);
    await first;
    expect(runtime.submit).toHaveBeenCalledTimes(1);
  });

  it('sends only the command envelope through the host-provided HTTP client', async () => {
    const get = vi.fn(async () => ({
      data: { catalog: [], enabled: true, revision: 7 },
    }));
    const post = vi.fn(async () => ({ data: accepted }));
    const runtime = createDeveloperConsoleRuntime(
      { get, post } as never,
      (value) => `/sessions/${value.sessionId}/developer-console`,
    );
    await runtime.describe(route);
    await runtime.submit(route, {
      commandId: 'command-1',
      expectedRevision: 7,
      command,
    });
    expect(get).toHaveBeenCalledWith('/sessions/session-1/developer-console');
    expect(post).toHaveBeenCalledWith(
      '/sessions/session-1/developer-console/commands',
      {
        commandId: 'command-1',
        expectedRevision: 7,
        command,
      },
    );
  });
});
