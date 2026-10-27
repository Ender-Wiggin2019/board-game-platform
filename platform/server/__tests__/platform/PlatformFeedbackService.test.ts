import type { SessionRoute } from '@board-game/contracts';
import type { AutomationTrace } from '@board-game/storage';
import type {
  IClientCrashReport,
  IPlatformFeedbackSubmitRequest,
  IPlatformNativeDiagnostics,
} from '@board-platform/contracts';
import { describe, expect, it, vi } from 'vitest';
import { PlatformFeedbackService } from '@/platform/feedback/service.js';
import { MemoryPlatformFeedbackStore } from '@/platform/feedback/store.js';
import type { PlatformApplicationRuntime } from '@/platform/PlatformApplicationRuntime.js';
import { PlatformSessionDiagnostics } from '@/platform/PlatformSessionDiagnostics.js';

const reference = { principalId: 'player-1', authSessionId: 'auth-1' };

function diagnostics(): IPlatformNativeDiagnostics {
  return {
    kind: 'native-session',
    sessionId: 'session-1',
    gameId: 'brass',
    releaseId: 'brass-v1',
    status: 'active',
    sourceRevision: 4,
    updatedAt: 4_000,
    summary: { phase: 'turn' },
    events: [
      { sequence: 4, eventId: 'event-4', payload: { kind: 'TurnStarted' } },
    ],
  };
}

function trace(): AutomationTrace {
  return {
    kind: 'automation',
    sessionId: 'session-1',
    traceId: 'decision-1',
    decisionId: 'decision-1',
    commandId: 'command-1',
    deadlineId: 'deadline-1',
    releaseId: 'brass-v1',
    policyId: 'brass-ai',
    policyVersion: 'v1',
    expectedRevision: 3,
    seatId: 'seat-2',
    turnId: 'turn-3',
    state: { private: true },
    input: { actor: { principalId: 'ai-seat' } },
    schemaVersion: 1,
    options: null,
    command: { type: 'claim' },
    diagnostics: { nodes: 3 },
    outcome: 'executed',
    startedAt: 3_000,
    finishedAt: 3_001,
    createdAt: 3_000,
    eventSequenceStart: 4,
    eventSequenceCount: 1,
  };
}

function fixture() {
  const route: SessionRoute = {
    gameId: 'brass',
    modeId: 'regular-multiplayer',
    sessionId: 'session-1',
    releaseId: 'brass-v1',
    backendBindingId: 'backend-1',
    storageBindingId: 'storage-1',
    ownershipEpoch: 'epoch-1',
  };
  const replay = vi.fn(async () => ({
    traceKind: 'automation' as const,
    traceId: 'decision-1',
    decisionId: 'decision-1',
    policyId: 'brass-ai',
    policyVersion: 'v1',
    command: { type: 'claim' },
    diagnostics: { nodes: 3 },
    durationMs: 1,
    inputDigest: 'digest',
    legal: true,
  }));
  const runtime = {
    game: vi.fn(() => ({
      releaseId: 'brass-v1',
      identity: {
        diagnosticAccess: vi.fn(async () => ({
          principalId: 'diagnostic',
          authEpoch: 'diagnostic',
          scopes: ['session:view', 'session:spectate'],
        })),
      },
      host: { replayAutomationTraceEvidence: replay },
    })),
    admissionStore: {
      getAdmission: vi.fn(async () => ({ route })),
    },
    sessions: {
      descriptor: vi.fn(async () => ({ route })),
    },
  } as unknown as PlatformApplicationRuntime;
  const native = diagnostics();
  const reader = {
    readForPrincipal: vi.fn(async () => native),
    readForAdmin: vi.fn(async () => native),
    readTraceForReport: vi.fn(async () => trace()),
  } as unknown as PlatformSessionDiagnostics;
  const store = new MemoryPlatformFeedbackStore();
  return {
    service: new PlatformFeedbackService(store, runtime, reader),
    runtime,
    reader,
    replay,
    store,
  };
}

describe('PlatformFeedbackService', () => {
  it('captures a bounded native projection and keeps retries idempotent', async () => {
    const { service, reader, store } = fixture();
    const input: IPlatformFeedbackSubmitRequest = {
      eventId: 'client-event-1',
      category: 'bug',
      message: 'The turn indicator did not advance.',
      target: { kind: 'native-session', sessionId: 'session-1' },
    };

    const first = await service.submit(reference, input);
    vi.mocked(reader.readForPrincipal).mockRejectedValue(
      new Error('session no longer readable'),
    );
    const retry = await service.submit(reference, input);

    expect(first).toEqual(retry);
    expect(first).toMatchObject({
      gameId: 'brass',
      releaseId: 'brass-v1',
      sessionId: 'session-1',
      nativeDiagnostics: diagnostics(),
      status: 'open',
    });
    expect(reader.readForPrincipal).toHaveBeenCalledTimes(1);
    await expect(
      service.submit(reference, { ...input, message: 'Different body.' }),
    ).rejects.toMatchObject({ envelope: { code: 'IDEMPOTENCY_CONFLICT' } });
    expect((await service.list()).items[0]).not.toHaveProperty(
      'nativeDiagnostics',
    );
    expect((await store.list({ limit: 10 })).total).toBe(1);
  });

  it('validates game context and exposes operator reads and status changes', async () => {
    const { service } = fixture();
    const report = await service.submit(reference, {
      eventId: 'client-event-2',
      category: 'ux',
      message: 'The lobby copy is unclear.',
      gameId: 'brass',
    });
    expect((await service.list({ status: 'open' })).total).toBe(1);
    expect(
      await service.updateStatus(report.reportId, 'triaged'),
    ).toMatchObject({
      reportId: report.reportId,
      status: 'triaged',
    });
    expect((await service.list({ status: 'open' })).total).toBe(0);
    expect((await service.list({ status: 'triaged' })).items[0]).toMatchObject({
      eventId: 'client-event-2',
    });
    await expect(
      service.submit(reference, {
        eventId: 'client-event-3',
        category: 'bug',
        message: 'Wrong game.',
        gameId: 'other-game',
        target: { kind: 'native-session', sessionId: 'session-1' },
      }),
    ).rejects.toMatchObject({ envelope: { code: 'INVALID_REQUEST' } });
    await expect(
      service.submit(reference, {
        eventId: 123 as unknown as string,
        category: 'bug',
        message: 'Bad event id.',
      }),
    ).rejects.toMatchObject({ envelope: { code: 'INVALID_REQUEST' } });
    await expect(
      service.submit(reference, {
        eventId: 'client-event-number-game',
        category: 'bug',
        message: 'Bad game id.',
        gameId: 42 as unknown as string,
      }),
    ).rejects.toMatchObject({ envelope: { code: 'INVALID_REQUEST' } });
  });

  it('separates platform-scope reports from game queues', async () => {
    const { service } = fixture();
    await service.submit(reference, {
      eventId: 'platform-scope-event',
      category: 'bug',
      message: 'The platform shell failed to load.',
    });
    await service.submit(reference, {
      eventId: 'game-scope-event',
      category: 'ux',
      message: 'The game panel is clipped.',
      gameId: 'brass',
    });

    await expect(service.list({ scope: 'platform' })).resolves.toMatchObject({
      total: 1,
      items: [expect.objectContaining({ eventId: 'platform-scope-event' })],
    });
    await expect(service.list({ gameId: 'brass' })).resolves.toMatchObject({
      total: 1,
      items: [expect.objectContaining({ eventId: 'game-scope-event' })],
    });
    await expect(
      service.list({ scope: 'platform', gameId: 'brass' }),
    ).rejects.toMatchObject({ envelope: { code: 'INVALID_REQUEST' } });
    await expect(service.listMine(reference)).resolves.toMatchObject({
      total: 2,
    });
  });

  it('derives the AI queue and selected event from trusted Host source metadata', async () => {
    const { service, reader, replay } = fixture();
    vi.mocked(reader.readForPrincipal).mockResolvedValue({
      ...diagnostics(),
      events: [
        {
          sequence: 4,
          eventId: 'event-4',
          payload: { kind: 'TurnStarted' },
          source: { kind: 'ai', seatId: 'seat-2', traceId: 'decision-1' },
        },
      ],
    });

    const report = await service.submit(reference, {
      eventId: 'ai-event-1',
      kind: 'game',
      category: 'behavior',
      message: 'The AI chose an unexpected move.',
      expectedBehavior: 'Prefer the lower-risk legal move.',
      target: {
        kind: 'native-session',
        sessionId: 'session-1',
        eventSequence: 4,
      },
    });

    expect(report).toMatchObject({
      kind: 'ai',
      category: 'behavior',
      eventSequence: 4,
      traceId: 'decision-1',
      traceEvidenceAvailable: true,
      expectedBehavior: 'Prefer the lower-risk legal move.',
    });
    expect(reader.readTraceForReport).toHaveBeenCalledWith(
      reference,
      'session-1',
      4,
      expect.objectContaining({ sessionId: 'session-1' }),
    );
    await expect(
      service.traceEvidenceForAdmin(reference, report.reportId),
    ).resolves.toEqual(trace());
    await expect(
      service.replayTraceEvidenceForAdmin(reference, report.reportId),
    ).resolves.toMatchObject({
      traceKind: 'automation',
      traceId: 'decision-1',
      legal: true,
    });
    expect((await service.list()).items[0]).not.toHaveProperty('traceSnapshot');
    expect(replay).toHaveBeenCalledTimes(1);
    await expect(
      service.submit(reference, {
        eventId: 'ai-event-2',
        kind: 'ai',
        category: 'behavior',
        message: 'Forged AI queue without a trusted event.',
      }),
    ).rejects.toMatchObject({ envelope: { code: 'INVALID_REQUEST' } });
  });

  it('rejects expected behavior on a game report', async () => {
    const { service } = fixture();
    await expect(
      service.submit(reference, {
        eventId: 'game-expected-behavior',
        category: 'bug',
        message: 'A normal game error.',
        expectedBehavior: 'This must not enter the game queue.',
      }),
    ).rejects.toMatchObject({ envelope: { code: 'INVALID_REQUEST' } });
  });

  it('keeps the report when private evidence exceeds the snapshot cap', async () => {
    const { service, reader, store } = fixture();
    vi.mocked(reader.readForPrincipal).mockResolvedValue({
      ...diagnostics(),
      events: [
        {
          sequence: 4,
          eventId: 'event-4',
          payload: { kind: 'TurnStarted' },
          source: { kind: 'ai', traceId: 'decision-1' },
        },
      ],
    });
    vi.mocked(reader.readTraceForReport).mockResolvedValueOnce({
      ...trace(),
      diagnostics: { blob: 'x'.repeat(3 * 1024 * 1024) },
    });

    const report = await service.submit(reference, {
      eventId: 'ai-evidence-too-large',
      category: 'behavior',
      message: 'The AI behavior needs review.',
      target: {
        kind: 'native-session',
        sessionId: 'session-1',
        eventSequence: 4,
      },
    });
    expect(report).toMatchObject({
      kind: 'ai',
      traceId: 'decision-1',
      traceEvidenceAvailable: false,
    });
    expect(await store.get(report.reportId)).not.toHaveProperty(
      'traceSnapshot',
    );
  });

  it("lists only the authenticated principal's reports after submission", async () => {
    const { service } = fixture();
    await service.submit(reference, {
      eventId: 'mine-event-1',
      category: 'bug',
      message: 'My report.',
    });
    await service.submit(
      { principalId: 'player-2', authSessionId: 'auth-2' },
      {
        eventId: 'mine-event-2',
        category: 'ux',
        message: 'Another player report.',
      },
    );

    await expect(service.listMine(reference)).resolves.toMatchObject({
      total: 1,
      items: [
        expect.objectContaining({
          eventId: 'mine-event-1',
          reporterId: 'player-1',
        }),
      ],
    });
  });

  it('delegates live diagnostics to the admin-gated reader', async () => {
    const { service, reader } = fixture();
    await expect(
      service.diagnosticsForAdmin(reference, 'session-1'),
    ).resolves.toEqual(diagnostics());
    expect(reader.readForAdmin).toHaveBeenCalledWith(reference, 'session-1');
  });

  it('accepts bounded anonymous client crashes and returns a stable receipt', async () => {
    const { service } = fixture();
    const report: IClientCrashReport = {
      eventId: 'crash-event-1',
      source: 'window',
      message: 'Chunk failed to load.',
      stack: 'Error: Chunk failed to load.',
      url: 'https://example.test/game/arnak',
      userAgent: 'test-agent',
      locale: 'en-US',
      capturedAt: new Date(1_000).toISOString(),
      gameId: 'brass',
    };
    const receipt = await service.ingestClientCrash(report);
    expect(receipt).toMatchObject({
      id: 'crash-event-1',
      reportId: expect.any(String),
    });
    const listed = await service.list();
    expect(listed.items[0]).toMatchObject({
      eventId: 'crash-event-1',
      category: 'bug',
      gameId: 'brass',
    });
    expect(listed.items[0]).not.toHaveProperty('clientCrash');
    await expect(service.get(receipt.reportId)).resolves.toMatchObject({
      eventId: 'crash-event-1',
      clientCrash: report,
    });
  });

  it('requires authentication when a client crash targets a native session', async () => {
    const { service } = fixture();
    await expect(
      service.ingestClientCrash({
        eventId: 'crash-event-2',
        source: 'react',
        message: 'Render failed.',
        url: '/game/arnak',
        userAgent: 'test-agent',
        locale: 'en-US',
        capturedAt: new Date(1_000).toISOString(),
        target: { kind: 'native-session', sessionId: 'session-1' },
      }),
    ).rejects.toMatchObject({ envelope: { code: 'UNAUTHENTICATED' } });
  });

  it('rejects a crash game id that disagrees with its authorized session target', async () => {
    const { service } = fixture();
    await expect(
      service.ingestClientCrash(
        {
          eventId: 'crash-event-game-mismatch',
          source: 'react',
          message: 'Render failed.',
          url: '/game/brass',
          userAgent: 'test-agent',
          locale: 'en-US',
          capturedAt: new Date(1_000).toISOString(),
          gameId: 'other-game',
          target: { kind: 'native-session', sessionId: 'session-1' },
        },
        reference,
      ),
    ).rejects.toMatchObject({ envelope: { code: 'INVALID_REQUEST' } });
  });

  it('retries a native client crash without rereading a changed session', async () => {
    const { service, reader } = fixture();
    const report: IClientCrashReport = {
      eventId: 'crash-event-native-1',
      source: 'react',
      message: 'Render failed.',
      url: '/game/brass',
      userAgent: 'test-agent',
      locale: 'en-US',
      capturedAt: new Date(1_000).toISOString(),
      target: { kind: 'native-session', sessionId: 'session-1' },
    };

    const first = await service.ingestClientCrash(report, reference);
    vi.mocked(reader.readForPrincipal).mockRejectedValue(
      new Error('session no longer readable'),
    );
    await expect(service.ingestClientCrash(report, reference)).resolves.toEqual(
      first,
    );
    expect(reader.readForPrincipal).toHaveBeenCalledTimes(1);
  });
});
