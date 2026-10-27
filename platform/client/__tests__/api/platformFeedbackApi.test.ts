import { beforeEach, describe, expect, it, vi } from 'vitest';

const httpMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
}));

vi.mock('@/api/httpClient', () => ({ httpClient: httpMocks }));

import {
  createPlatformFeedbackEventId,
  platformFeedbackApi,
} from '@/api/platformFeedbackApi';

describe('platformFeedbackApi', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps feedback routes typed and encodes report and session ids', async () => {
    const report = {
      reportId: 'report-1',
      eventId: 'event-1',
      sourceRecordId: 'platform-feedback:user-1:event-1',
      reporterId: 'user-1',
      category: 'bug',
      message: 'The turn did not advance.',
      status: 'open',
      createdAt: '2026-10-19T12:00:00.000Z',
      updatedAt: '2026-10-19T12:00:00.000Z',
    } as const;
    const diagnostics = {
      kind: 'native-session',
      sessionId: 'session/1',
      gameId: 'seti',
      releaseId: 'seti-v1',
      status: 'active',
      sourceRevision: 4,
      updatedAt: 1_000,
      summary: { currentPlayer: 'user-1' },
      events: [],
    } as const;
    httpMocks.post.mockResolvedValueOnce({ data: report });
    httpMocks.get
      .mockResolvedValueOnce({ data: { items: [report], total: 1 } })
      .mockResolvedValueOnce({ data: { items: [report], total: 1 } })
      .mockResolvedValueOnce({ data: report })
      .mockResolvedValueOnce({ data: diagnostics })
      .mockResolvedValueOnce({ data: { completed: 12 } });
    httpMocks.patch.mockResolvedValueOnce({
      data: { ...report, status: 'triaged' },
    });

    await expect(
      platformFeedbackApi.submit({
        eventId: 'event-1',
        category: 'bug',
        message: report.message,
        gameId: 'seti',
        target: { kind: 'native-session', sessionId: 'session/1' },
      }),
    ).resolves.toEqual(report);
    await platformFeedbackApi.listMine({ limit: 50 });
    await platformFeedbackApi.list({ status: 'open', gameId: 'seti' });
    await platformFeedbackApi.get('report/1');
    await platformFeedbackApi.updateStatus('report/1', 'triaged');
    await platformFeedbackApi.diagnostics('session/1');
    await platformFeedbackApi.statistics('seti/expedition');

    expect(httpMocks.post).toHaveBeenCalledWith(
      '/platform/feedback',
      expect.objectContaining({ eventId: 'event-1' }),
      { showServerUpdateDialog: true },
    );
    expect(httpMocks.get).toHaveBeenNthCalledWith(
      1,
      '/platform/feedback/mine',
      {
        showServerUpdateDialog: true,
        params: { limit: 50 },
      },
    );
    expect(httpMocks.get).toHaveBeenNthCalledWith(2, '/platform/feedback', {
      showServerUpdateDialog: true,
      params: { status: 'open', gameId: 'seti' },
    });
    expect(httpMocks.get).toHaveBeenNthCalledWith(
      3,
      '/platform/feedback/report%2F1',
      { showServerUpdateDialog: true },
    );
    expect(httpMocks.patch).toHaveBeenCalledWith(
      '/platform/feedback/report%2F1/status',
      { status: 'triaged' },
      { showServerUpdateDialog: true },
    );
    expect(httpMocks.get).toHaveBeenNthCalledWith(
      4,
      '/platform/feedback/sessions/session%2F1/diagnostics',
      { showServerUpdateDialog: true },
    );
    expect(httpMocks.get).toHaveBeenNthCalledWith(
      5,
      '/platform/games/seti%2Fexpedition/stats',
      { showServerUpdateDialog: true },
    );
  });

  it('creates a retry-safe client event key', () => {
    const eventId = createPlatformFeedbackEventId();
    expect(eventId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
  });

  it('selects platform-scope reports explicitly', async () => {
    httpMocks.get.mockResolvedValueOnce({ data: { items: [], total: 0 } });
    await expect(
      platformFeedbackApi.list({ scope: 'platform', limit: 50 }),
    ).resolves.toEqual({ items: [], total: 0 });
    expect(httpMocks.get).toHaveBeenCalledWith('/platform/feedback', {
      showServerUpdateDialog: true,
      params: { scope: 'platform', limit: 50 },
    });
  });

  it('scopes AI queues and encodes trace diagnostics and replay routes', async () => {
    const traces = [{ traceId: 'trace/1' }];
    const replay = { traceId: 'trace/1', legal: true };
    httpMocks.get
      .mockResolvedValueOnce({ data: { items: [], total: 0 } })
      .mockResolvedValueOnce({ data: traces });
    httpMocks.post.mockResolvedValueOnce({ data: replay });

    await platformFeedbackApi.list({ kind: 'ai', gameId: 'seti' });
    await platformFeedbackApi.automationTraces('session/1', {
      limit: 100,
      afterCreatedAt: 1_000,
    });
    await expect(
      platformFeedbackApi.replayAutomation('session/1', 'trace/1'),
    ).resolves.toEqual(replay);

    expect(httpMocks.get).toHaveBeenNthCalledWith(1, '/platform/feedback', {
      showServerUpdateDialog: true,
      params: { kind: 'ai', gameId: 'seti' },
    });
    expect(httpMocks.get).toHaveBeenNthCalledWith(
      2,
      '/platform/feedback/sessions/session%2F1/automation-traces',
      {
        showServerUpdateDialog: true,
        params: { limit: 100, afterCreatedAt: 1_000 },
      },
    );
    expect(httpMocks.post).toHaveBeenCalledWith(
      '/platform/feedback/sessions/session%2F1/automation-traces/trace%2F1/replay',
      undefined,
      { showServerUpdateDialog: true },
    );
  });

  it('loads report-bound private trace evidence', async () => {
    const trace = { traceId: 'trace/1', kind: 'automation' };
    const replay = { traceId: 'trace/1', legal: true };
    httpMocks.get.mockResolvedValueOnce({ data: trace });
    httpMocks.post.mockResolvedValueOnce({ data: replay });

    await expect(
      platformFeedbackApi.traceEvidence('report/1'),
    ).resolves.toEqual(trace);
    await expect(
      platformFeedbackApi.replayTraceEvidence('report/1'),
    ).resolves.toEqual(replay);
    expect(httpMocks.get).toHaveBeenCalledWith(
      '/platform/feedback/report%2F1/trace-evidence',
      { showServerUpdateDialog: true },
    );
    expect(httpMocks.post).toHaveBeenCalledWith(
      '/platform/feedback/report%2F1/trace-evidence/replay',
      undefined,
      { showServerUpdateDialog: true },
    );
  });

  it("uses an account-scoped route for an author's full report", async () => {
    const report = { reportId: 'report/1' };
    httpMocks.get.mockResolvedValueOnce({ data: report });

    await expect(platformFeedbackApi.getMine('report/1')).resolves.toEqual(
      report,
    );
    expect(httpMocks.get).toHaveBeenCalledWith(
      '/platform/feedback/mine/report%2F1',
      { showServerUpdateDialog: true },
    );
  });
});
