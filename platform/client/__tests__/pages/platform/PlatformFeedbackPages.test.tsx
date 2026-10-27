import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlatformFeedbackPage } from '@/pages/platform/PlatformFeedbackPage';
import { PlatformOperationsPage } from '@/pages/platform/PlatformOperationsPage';
import { useAuthStore } from '@/stores/authStore';

const mocks = vi.hoisted(() => ({
  search: {} as Record<string, unknown>,
  permissions: { read: false, manage: false },
  api: {
    submit: vi.fn(),
    listMine: vi.fn(),
    list: vi.fn(),
    get: vi.fn(),
    getMine: vi.fn(),
    updateStatus: vi.fn(),
    diagnostics: vi.fn(),
    automationTraces: vi.fn(),
    replayAutomation: vi.fn(),
    replayTraceEvidence: vi.fn(),
    traceEvidence: vi.fn(),
    statistics: vi.fn(),
  },
  games: {
    listGames: vi.fn(),
  },
}));

vi.mock('@/api/platformFeedbackApi', () => ({
  platformFeedbackApi: mocks.api,
  createPlatformFeedbackEventId: () => 'feedback-event-1',
}));
vi.mock('@/api/platformGamesApi', () => ({ platformGamesApi: mocks.games }));
vi.mock('@/hooks/usePermissions', () => ({
  usePermissions: () => ({
    can: (capability: string) =>
      capability === 'analytics.read'
        ? mocks.permissions.read
        : mocks.permissions.manage,
  }),
}));
vi.mock('@tanstack/react-router', () => ({
  useSearch: () => mocks.search,
}));

const report = {
  reportId: 'report-1',
  eventId: 'event-1',
  sourceRecordId: 'platform-feedback:user-1:event-1',
  reporterId: 'user-1',
  category: 'bug',
  message: 'The turn did not advance.',
  gameId: 'seti',
  sessionId: 'session-1',
  status: 'open',
  createdAt: '2026-10-19T12:00:00.000Z',
  updatedAt: '2026-10-19T12:00:00.000Z',
} as const;

function renderWithQuery(ui: React.ReactNode) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
          },
        })
      }
    >
      {ui}
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ authEpoch: 0 });
  mocks.search = {};
  mocks.permissions = { read: false, manage: false };
  mocks.api.listMine.mockResolvedValue({ items: [], total: 0 });
  mocks.api.list.mockResolvedValue({ items: [], total: 0 });
  mocks.api.get.mockResolvedValue(report);
  mocks.api.getMine.mockResolvedValue(report);
  mocks.api.diagnostics.mockResolvedValue({
    kind: 'native-session',
    sessionId: 'session-1',
    gameId: 'seti',
    releaseId: 'seti-v1',
    status: 'active',
    sourceRevision: 4,
    updatedAt: 1_000,
    summary: { currentPlayer: 'user-1' },
    events: [{ sequence: 3, eventId: 'event-3', payload: { action: 'pass' } }],
  });
  mocks.api.statistics.mockResolvedValue({ completed: 12, averageScore: 4.5 });
  mocks.api.automationTraces.mockResolvedValue([]);
  mocks.api.replayAutomation.mockResolvedValue({
    traceId: 'trace-1',
    decisionId: 'decision-1',
    policyId: 'seti.ai.v1',
    durationMs: 8,
    inputDigest: 'digest-1',
    legal: true,
  });
  mocks.api.replayTraceEvidence.mockResolvedValue({
    traceId: 'trace-1',
    decisionId: 'decision-1',
    policyId: 'seti.ai.v1',
    durationMs: 8,
    inputDigest: 'digest-1',
    legal: true,
  });
  mocks.api.traceEvidence.mockResolvedValue(undefined);
  mocks.games.listGames.mockResolvedValue([
    {
      metadata: {
        gameId: 'seti',
        name: 'SETI',
        description: 'Search for life.',
        themeId: 'seti',
      },
      releaseId: 'seti-v1',
      capabilities: [],
      policyVersions: [],
      assets: [],
    },
  ]);
});

describe('platform feedback pages', () => {
  it('preserves the initial session context and clears it after an auth change', async () => {
    mocks.search = { gameId: 'seti', sessionId: 'session-1' };
    renderWithQuery(<PlatformFeedbackPage />);

    expect(screen.getByLabelText('Game (optional)')).toHaveValue('seti');
    expect(screen.getByLabelText('Session (optional)')).toHaveValue(
      'session-1',
    );

    act(() => useAuthStore.setState({ authEpoch: 1 }));

    await waitFor(() =>
      expect(screen.getByLabelText('Session (optional)')).toHaveValue(''),
    );
  });

  it('updates and clears context when the feedback search changes', () => {
    mocks.search = { gameId: 'seti', sessionId: 'session-1' };
    const view = renderWithQuery(<PlatformFeedbackPage />);

    mocks.search = { gameId: 'brass' };
    view.rerender(
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: {
              queries: { retry: false },
              mutations: { retry: false },
            },
          })
        }
      >
        <PlatformFeedbackPage />
      </QueryClientProvider>,
    );

    expect(screen.getByLabelText('Game (optional)')).toHaveValue('brass');
    expect(screen.getByLabelText('Session (optional)')).toHaveValue('');
  });

  it('keeps one event id when a feedback submission is retried', async () => {
    mocks.api.submit
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce(report);
    renderWithQuery(<PlatformFeedbackPage />);

    fireEvent.change(await screen.findByLabelText('What happened?'), {
      target: { value: 'The turn did not advance.' },
    });
    const submit = screen.getByRole('button', { name: 'Submit feedback' });
    fireEvent.click(submit);
    await waitFor(() => expect(mocks.api.submit).toHaveBeenCalledTimes(1));
    fireEvent.click(submit);
    await waitFor(() => expect(mocks.api.submit).toHaveBeenCalledTimes(2));

    expect(mocks.api.submit).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ eventId: 'feedback-event-1' }),
    );
    expect(mocks.api.submit).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ eventId: 'feedback-event-1' }),
    );
    expect(await screen.findByText('Feedback submitted.')).toBeInTheDocument();
  });

  it('preserves a newer draft when an older submission finishes', async () => {
    let resolveSubmit!: (value: typeof report) => void;
    mocks.api.submit.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSubmit = resolve;
        }),
    );
    renderWithQuery(<PlatformFeedbackPage />);

    const message = await screen.findByLabelText('What happened?');
    const session = screen.getByLabelText('Session (optional)');
    fireEvent.change(message, { target: { value: 'First report' } });
    fireEvent.change(session, { target: { value: 'session-first' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit feedback' }));
    await waitFor(() => expect(mocks.api.submit).toHaveBeenCalledTimes(1));

    fireEvent.change(message, { target: { value: 'Newer report' } });
    fireEvent.change(session, { target: { value: 'session-newer' } });
    await act(async () => resolveSubmit(report));

    expect(message).toHaveValue('Newer report');
    expect(session).toHaveValue('session-newer');
  });

  it('loads full report evidence from the summary history row on demand', async () => {
    mocks.api.listMine.mockResolvedValue({ items: [report], total: 1 });
    mocks.api.getMine.mockResolvedValue({
      ...report,
      clientCrash: { name: 'Error', message: 'render failed' },
    });
    renderWithQuery(<PlatformFeedbackPage />);

    fireEvent.click(
      await screen.findByRole('button', { name: 'View details' }),
    );
    expect(await screen.findByText('Feedback details')).toBeInTheDocument();
    await waitFor(() =>
      expect(mocks.api.getMine).toHaveBeenCalledWith('report-1'),
    );
    expect(await screen.findByText(/render failed/)).toBeInTheDocument();
  });

  it('keeps the platform queue scoped while updating status and inspecting diagnostics', async () => {
    mocks.permissions = { read: true, manage: true };
    mocks.api.list.mockResolvedValue({ items: [report], total: 1 });
    mocks.api.updateStatus.mockResolvedValue({ ...report, status: 'triaged' });
    renderWithQuery(<PlatformOperationsPage />);

    expect(
      await screen.findByText('The turn did not advance.'),
    ).toBeInTheDocument();
    expect(mocks.api.list).toHaveBeenCalledWith({
      limit: 100,
      kind: 'game',
      scope: 'platform',
      status: 'open',
    });
    expect(
      screen
        .getAllByText('Open')
        .some((node) => node.classList.contains('whitespace-nowrap')),
    ).toBe(true);
    fireEvent.change(
      screen.getByRole('combobox', { name: 'Status for bug report' }),
      { target: { value: 'triaged' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(mocks.api.updateStatus).toHaveBeenCalledWith(
        'report-1',
        'triaged',
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: 'View report' }));
    expect(await screen.findByText('Report details')).toBeInTheDocument();
    await waitFor(() => expect(mocks.api.get).toHaveBeenCalledWith('report-1'));

    fireEvent.click(screen.getByRole('button', { name: 'View diagnostics' }));
    expect(
      await screen.findByText('Native session diagnostics'),
    ).toBeInTheDocument();
    expect(await screen.findByText('event-3')).toBeInTheDocument();
  });

  it('keeps the queue readable while hiding status controls without manage capabilities', async () => {
    mocks.permissions = { read: true, manage: false };
    mocks.api.list.mockResolvedValue({ items: [report], total: 1 });
    renderWithQuery(<PlatformOperationsPage />);

    expect(
      await screen.findByText('The turn did not advance.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('columnheader', { name: 'Update' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('combobox', { name: 'Status for bug report' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Save' }),
    ).not.toBeInTheDocument();
  });

  it('keeps the AI queue scoped and exposes trusted evidence plus replay dry-run', async () => {
    mocks.permissions = { read: true, manage: true };
    const aiReport = {
      ...report,
      kind: 'ai' as const,
      category: 'behavior' as const,
      eventSequence: 3,
      traceId: 'trace-1',
      nativeDiagnostics: {
        kind: 'native-session' as const,
        sessionId: 'session-1',
        gameId: 'seti',
        releaseId: 'seti-v1',
        status: 'active' as const,
        sourceRevision: 4,
        updatedAt: 1_000,
        summary: { currentPlayer: 'ai-1' },
        events: [
          {
            sequence: 3,
            eventId: 'event-3',
            payload: { action: 'build' },
            source: { kind: 'ai' as const, seatId: 'ai-1' },
          },
        ],
      },
    };
    mocks.api.list.mockResolvedValue({ items: [aiReport], total: 1 });
    mocks.api.get.mockResolvedValue(aiReport);
    mocks.api.traceEvidence.mockResolvedValue({
      traceId: 'trace-1',
      kind: 'automation',
    });
    mocks.api.automationTraces.mockResolvedValue([
      {
        kind: 'automation',
        sessionId: 'session-1',
        traceId: 'trace-1',
        decisionId: 'decision-1',
        commandId: 'command-1',
        deadlineId: 'deadline-1',
        releaseId: 'seti-v1',
        policyId: 'seti.ai.v1',
        expectedRevision: 6,
        seatId: 'ai-1',
        turnId: 'turn-1',
        state: { round: 2 },
        input: { legalActions: ['build'] },
        schemaVersion: 1,
        options: { difficulty: 'standard' },
        command: { type: 'build' },
        diagnostics: { reason: 'best legal action' },
        outcome: 'executed',
        startedAt: 1_000,
        finishedAt: 1_008,
        createdAt: 1_000,
        eventSequenceStart: 3,
        eventSequenceCount: 1,
      },
    ]);
    renderWithQuery(<PlatformOperationsPage gameId='seti' kind='ai' />);

    expect(await screen.findByText('AI issue reports')).toBeInTheDocument();
    expect(mocks.api.list).toHaveBeenCalledWith({
      limit: 100,
      kind: 'ai',
      status: 'open',
      gameId: 'seti',
    });
    fireEvent.click(await screen.findByRole('button', { name: 'View report' }));
    expect(await screen.findByText('Trace evidence')).toBeInTheDocument();
    expect(await screen.findByText('event-3')).toBeInTheDocument();
    expect(
      await screen.findByText('Trusted snapshot loaded'),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(mocks.api.automationTraces).toHaveBeenCalledWith('session-1', {
        limit: 100,
      }),
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Inspect trace' }),
    );
    expect(await screen.findByText('Trace details')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Replay dry-run' }));
    await waitFor(() =>
      expect(mocks.api.replayTraceEvidence).toHaveBeenCalledWith('report-1'),
    );
    expect(
      await screen.findByText('Replay dry-run result'),
    ).toBeInTheDocument();
    expect(screen.getByText('digest-1')).toBeInTheDocument();
  });

  it('can retry a failed private AI trace request', async () => {
    mocks.permissions = { read: true, manage: true };
    const aiReport = {
      ...report,
      kind: 'ai' as const,
      category: 'behavior' as const,
      traceId: 'trace-1',
    };
    mocks.api.list.mockResolvedValue({ items: [aiReport], total: 1 });
    mocks.api.get.mockResolvedValue(aiReport);
    mocks.api.automationTraces
      .mockRejectedValueOnce(new Error('temporary trace failure'))
      .mockResolvedValueOnce([]);
    mocks.api.traceEvidence.mockResolvedValue({
      kind: 'automation',
      sessionId: 'session-1',
      traceId: 'trace-1',
      decisionId: 'decision-1',
      commandId: 'command-1',
      deadlineId: 'deadline-1',
      releaseId: 'seti-v1',
      policyId: 'seti.ai.v1',
      expectedRevision: 1,
      seatId: 'ai-1',
      turnId: 'turn-1',
      state: {},
      input: {},
      schemaVersion: 1,
      options: {},
      outcome: 'executed',
      startedAt: 1_000,
      createdAt: 1_000,
    });
    renderWithQuery(<PlatformOperationsPage gameId='seti' kind='ai' />);

    fireEvent.click(await screen.findByRole('button', { name: 'View report' }));
    expect(
      await screen.findByText('temporary trace failure'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() =>
      expect(mocks.api.automationTraces).toHaveBeenCalledTimes(2),
    );
    expect(
      await screen.findByText(
        'No private traces were retained for this session.',
      ),
    ).toBeInTheDocument();
  });

  it('falls back to a live trace when no durable report snapshot was retained', async () => {
    mocks.permissions = { read: true, manage: true };
    const reportWithoutSnapshot = {
      ...report,
      kind: 'ai' as const,
      category: 'behavior' as const,
      traceId: 'trace-live',
      traceEvidenceAvailable: false,
    };
    mocks.api.list.mockResolvedValue({
      items: [reportWithoutSnapshot],
      total: 1,
    });
    mocks.api.get.mockResolvedValue(reportWithoutSnapshot);
    mocks.api.automationTraces.mockResolvedValue([
      {
        kind: 'automation',
        sessionId: 'session-1',
        traceId: 'trace-live',
        decisionId: 'decision-live',
        commandId: 'command-live',
        deadlineId: 'deadline-live',
        releaseId: 'seti-v1',
        policyId: 'seti.ai.v1',
        expectedRevision: 3,
        seatId: 'ai-1',
        turnId: 'turn-live',
        state: {},
        input: {},
        schemaVersion: 1,
        options: {},
        outcome: 'executed',
        startedAt: 1_000,
        createdAt: 1_000,
      },
    ]);
    renderWithQuery(<PlatformOperationsPage gameId='seti' kind='ai' />);

    fireEvent.click(await screen.findByRole('button', { name: 'View report' }));
    expect(
      await screen.findByText(
        'No durable snapshot was retained; live traces may still be available below.',
      ),
    ).toBeInTheDocument();
    expect(mocks.api.traceEvidence).not.toHaveBeenCalled();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Inspect trace' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Replay dry-run' }));
    await waitFor(() =>
      expect(mocks.api.replayAutomation).toHaveBeenCalledWith(
        'session-1',
        'trace-live',
      ),
    );
    expect(mocks.api.replayTraceEvidence).not.toHaveBeenCalled();
  });

  it('opens and replays a report-bound command trace from the game queue', async () => {
    mocks.permissions = { read: true, manage: true };
    const commandReport = {
      ...report,
      kind: 'game' as const,
      traceId: 'trace-command',
    };
    mocks.api.list.mockResolvedValue({ items: [commandReport], total: 1 });
    mocks.api.get.mockResolvedValue(commandReport);
    mocks.api.automationTraces.mockResolvedValue([
      {
        kind: 'command',
        sessionId: 'session-1',
        traceId: 'trace-command',
        decisionId: 'command-decision-1',
        commandId: 'command-1',
        deadlineId: 'deadline-1',
        releaseId: 'seti-v1',
        policyId: 'platform.command',
        expectedRevision: 4,
        seatId: 'player-1',
        turnId: 'turn-1',
        state: { round: 1 },
        input: { action: 'pass' },
        schemaVersion: 1,
        options: {},
        command: { type: 'pass' },
        diagnostics: { source: 'human' },
        outcome: 'executed',
        startedAt: 1_000,
        finishedAt: 1_008,
        createdAt: 1_000,
      },
    ]);
    mocks.api.traceEvidence.mockResolvedValue({
      kind: 'command',
      sessionId: 'session-1',
      traceId: 'trace-command',
      decisionId: 'command-decision-1',
      commandId: 'command-1',
      deadlineId: 'deadline-1',
      releaseId: 'seti-v1',
      policyId: 'platform.command',
      expectedRevision: 4,
      seatId: 'player-1',
      turnId: 'turn-1',
      state: { round: 1 },
      input: { action: 'pass' },
      schemaVersion: 1,
      options: {},
      command: { type: 'pass' },
      diagnostics: { source: 'human' },
      outcome: 'executed',
      startedAt: 1_000,
      finishedAt: 1_008,
      createdAt: 1_000,
    });

    renderWithQuery(<PlatformOperationsPage gameId='seti' />);

    fireEvent.click(await screen.findByRole('button', { name: 'View report' }));
    expect(await screen.findByText('Trace evidence')).toBeInTheDocument();
    await waitFor(() =>
      expect(mocks.api.traceEvidence).toHaveBeenCalledWith('report-1'),
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Inspect trace' }),
    );
    expect(await screen.findByText('command-decision-1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Replay dry-run' }));
    await waitFor(() =>
      expect(mocks.api.replayTraceEvidence).toHaveBeenCalledWith('report-1'),
    );
  });
});
