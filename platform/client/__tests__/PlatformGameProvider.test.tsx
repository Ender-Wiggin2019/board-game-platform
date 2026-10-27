import type { ClientSessionTransport } from '@board-game/client';
import type {
  GetEventsResponse,
  QueryOptionsResponse,
  ResumeResult,
  SessionRoute,
  SubmitCommandResponse,
} from '@board-game/contracts';
import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlatformGameProvider } from '../src/PlatformGameProvider.js';
import type { PlatformSessionSignals } from '../src/runtime.js';

const route: SessionRoute = {
  gameId: 'brass',
  modeId: 'regular-multiplayer',
  sessionId: 'session-1',
  releaseId: 'brass-development',
  backendBindingId: 'brass-backend',
  storageBindingId: 'brass-storage',
  ownershipEpoch: 'epoch-1',
};

function unusedTransport(): ClientSessionTransport {
  const unused = async (): Promise<never> => {
    throw new Error('transport should not load in this test');
  };
  return {
    getPlayerView: unused,
    getEvents: unused as () => Promise<GetEventsResponse>,
    resume: unused as () => Promise<ResumeResult>,
    submitCommand: unused as () => Promise<SubmitCommandResponse>,
    queryOptions: unused as () => Promise<QueryOptionsResponse>,
  };
}

describe('PlatformGameProvider foreground lifecycle', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('keeps the heartbeat alive across a delayed socket connection', () => {
    vi.useFakeTimers();
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    let connected = false;
    const setForeground = vi.fn();
    const signals: PlatformSessionSignals = {
      subscribeRevision: vi.fn(() => () => undefined),
      setForeground,
      get isConnected() {
        return connected;
      },
    };

    const view = render(
      <PlatformGameProvider
        route={route}
        transport={unusedTransport()}
        loadOnMount={false}
        signals={signals}
      >
        <span />
      </PlatformGameProvider>,
    );

    expect(setForeground).not.toHaveBeenCalled();
    connected = true;
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(setForeground).toHaveBeenCalledWith(route.sessionId, true);

    view.unmount();
    expect(setForeground).toHaveBeenLastCalledWith(route.sessionId, false);
  });
});
