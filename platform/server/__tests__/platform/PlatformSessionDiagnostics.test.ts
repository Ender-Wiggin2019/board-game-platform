import type {
  GetEventsResponse,
  SessionRoute,
  SessionSummary,
} from '@board-game/contracts';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { PlatformApplicationRuntime } from '@/platform/PlatformApplicationRuntime.js';
import { PlatformSessionDiagnostics } from '@/platform/PlatformSessionDiagnostics.js';

const route: SessionRoute = {
  gameId: 'arnak',
  modeId: 'competitive',
  sessionId: 'session-1',
  releaseId: 'arnak-v1',
  backendBindingId: 'backend-1',
  storageBindingId: 'storage-1',
  ownershipEpoch: 'epoch-1',
};

const summary: SessionSummary = {
  route,
  status: 'active',
  sourceRevision: 2,
  eventSequence: 2,
  updatedAt: 2_000,
  summary: { phase: 'round' },
};

const events: GetEventsResponse = {
  gameId: 'arnak',
  sessionId: 'session-1',
  releaseId: 'arnak-v1',
  audienceKey: 'diagnostic',
  viewEpoch: 'epoch-1',
  nextSequence: 2,
  hasMore: false,
  resetRequired: false,
  events: [
    { sequence: 1, eventId: 'event-1', payload: { kind: 'Started' } },
    { sequence: 2, eventId: 'event-2', payload: { kind: 'Round' } },
  ],
};

describe('PlatformSessionDiagnostics', () => {
  it('resolves through the Nest runtime provider token', async () => {
    const runtime = {} as PlatformApplicationRuntime;
    const moduleRef = await Test.createTestingModule({
      providers: [
        PlatformSessionDiagnostics,
        { provide: PlatformApplicationRuntime, useValue: runtime },
      ],
    }).compile();

    expect(moduleRef.get(PlatformSessionDiagnostics)).toBeInstanceOf(
      PlatformSessionDiagnostics,
    );
    await moduleRef.close();
  });

  it('uses the authenticated session gateway for player evidence', async () => {
    const runtime = {
      sessions: {
        summary: vi.fn(async () => summary),
        events: vi.fn(async () => events),
      },
    } as unknown as PlatformApplicationRuntime;
    const service = new PlatformSessionDiagnostics(runtime);

    await expect(
      service.readForPrincipal(
        { principalId: 'player-1', authSessionId: 'auth-1' },
        'session-1',
      ),
    ).resolves.toMatchObject({
      kind: 'native-session',
      gameId: 'arnak',
      releaseId: 'arnak-v1',
      events: events.events,
    });
    expect(runtime.sessions.events).toHaveBeenCalledWith(
      { principalId: 'player-1', authSessionId: 'auth-1' },
      'session-1',
      { afterSequence: 0, limit: 200 },
    );
  });

  it('reads an explicitly selected event outside the normal tail window', async () => {
    const selectedSummary = { ...summary, eventSequence: 1_000 };
    const runtime = {
      sessions: {
        summary: vi.fn(async () => selectedSummary),
        events: vi.fn(async () => events),
      },
    } as unknown as PlatformApplicationRuntime;
    const service = new PlatformSessionDiagnostics(runtime);

    await service.readForPrincipal(
      { principalId: 'player-1', authSessionId: 'auth-1' },
      'session-1',
      42,
    );
    expect(runtime.sessions.events).toHaveBeenCalledWith(
      { principalId: 'player-1', authSessionId: 'auth-1' },
      'session-1',
      { afterSequence: 41, limit: 200 },
    );
  });

  it('requires the game admin policy before reading a pinned Host', async () => {
    const admissionStore = {
      getAdmission: vi.fn(async () => ({ route })),
    };
    const backend = {
      getSessionSummary: vi.fn(async () => summary),
      getEvents: vi.fn(async () => events),
    };
    const identity = {
      adminAccess: vi.fn(async () => ({
        principalId: 'admin',
        authEpoch: 'epoch',
        scopes: ['session:admin'],
      })),
      diagnosticAccess: vi.fn(async () => ({
        principalId: 'platform:diagnostic-reader',
        authEpoch: 'platform-diagnostic-v1',
        scopes: ['session:view', 'session:spectate'],
      })),
    };
    const runtime = {
      admissionStore,
      game: vi.fn(() => ({ identity })),
      resolveBackend: vi.fn(() => backend),
    } as unknown as PlatformApplicationRuntime;
    const service = new PlatformSessionDiagnostics(runtime);

    await expect(
      service.readForAdmin(
        { principalId: 'admin', authSessionId: 'auth-1' },
        'session-1',
      ),
    ).resolves.toMatchObject({ gameId: 'arnak', events: events.events });
    expect(identity.adminAccess).toHaveBeenCalledWith(
      { principalId: 'admin', authSessionId: 'auth-1' },
      route,
    );
    expect(backend.getSessionSummary).toHaveBeenCalledWith({
      protocolVersion: 1,
      route,
      accessContext: await identity.diagnosticAccess(),
    });
  });

  it('fails closed when the event reader requires an audience reset', async () => {
    const runtime = {
      sessions: {
        summary: vi.fn(async () => summary),
        events: vi.fn(async () => ({ ...events, resetRequired: true })),
      },
    } as unknown as PlatformApplicationRuntime;
    const service = new PlatformSessionDiagnostics(runtime);

    await expect(
      service.readForPrincipal(
        { principalId: 'player-1', authSessionId: 'auth-1' },
        'session-1',
      ),
    ).rejects.toThrow('Invalid native diagnostic projection');
  });
});
