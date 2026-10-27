import type { ProjectedEvent } from '@board-game/contracts';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { platformFeedbackApi } from '@/api/platformFeedbackApi.js';
import {
  GameLogReportingProvider,
  ReportableLogEntry,
} from '@/components/GameLogReporting.js';

vi.mock('@/api/platformFeedbackApi.js', () => ({
  createPlatformFeedbackEventId: vi.fn(() => 'report-event-1'),
  platformFeedbackApi: { submit: vi.fn() },
}));
vi.mock('@/components/ui/toast.js', () => ({ toast: vi.fn() }));

const event: ProjectedEvent = {
  sequence: 41,
  eventId: 'host-event',
  payload: { id: 'engine-event', seq: 9 },
  source: { kind: 'human', seatId: '0' },
};
function LogFixture({
  sessionId = 'session-1',
  identityKey = 'alice',
  source = event.source,
}: {
  sessionId?: string;
  identityKey?: string;
  source?: ProjectedEvent['source'];
}): React.JSX.Element {
  return (
    <GameLogReportingProvider
      gameId='brass-pittsburgh'
      sessionId={sessionId}
      identityKey={identityKey}
      logs={[{ key: 'engine-event', event: { ...event, source } }]}
    >
      <ReportableLogEntry logKey='engine-event'>
        <p>Built a factory</p>
        <button type='button'>Inspect card</button>
      </ReportableLogEntry>
      <ReportableLogEntry logKey='unmapped'>
        <p>Unmapped legacy event</p>
      </ReportableLogEntry>
    </GameLogReportingProvider>
  );
}
function openReport(): void {
  fireEvent.click(screen.getByText('Built a factory'));
  fireEvent.click(screen.getByRole('button', { name: 'Report this issue' }));
}
beforeEach(() => vi.mocked(platformFeedbackApi.submit).mockReset());

describe('selected game log reports', () => {
  it('preserves embedded actions and submits the mapped Host sequence with a stable retry id', async () => {
    vi.mocked(platformFeedbackApi.submit)
      .mockRejectedValueOnce(new Error('Network disconnected'))
      .mockResolvedValueOnce({ reportId: 'report-1' } as never);
    render(<LogFixture />);
    fireEvent.click(screen.getByRole('button', { name: 'Inspect card' }));
    expect(
      screen.queryByRole('button', { name: 'Report this issue' }),
    ).not.toBeInTheDocument();
    fireEvent.pointerDown(screen.getByText('Built a factory'));
    expect(
      screen.queryByRole('button', { name: 'Report this issue' }),
    ).not.toBeInTheDocument();
    openReport();
    fireEvent.change(screen.getByLabelText('What happened?'), {
      target: { value: 'The factory was not built' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Submit report' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Network disconnected',
    );
    expect(screen.getByLabelText('What happened?')).toHaveValue(
      'The factory was not built',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Submit report' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
    const calls = vi.mocked(platformFeedbackApi.submit).mock.calls;
    expect(calls[0][0]).toMatchObject({
      category: 'bug',
      gameId: 'brass-pittsburgh',
      message: 'The factory was not built',
      target: { sessionId: 'session-1', eventSequence: 41 },
    });
    expect(calls[1][0]).toEqual(calls[0][0]);
  });

  it('offers AI-specific behavior and improvement fields from the trusted source', async () => {
    vi.mocked(platformFeedbackApi.submit).mockResolvedValue({
      reportId: 'report-ai',
    } as never);
    render(<LogFixture source={{ kind: 'ai', seatId: '1' }} />);
    openReport();
    expect(screen.getByRole('dialog')).toHaveAccessibleName(
      'Report an AI decision',
    );
    fireEvent.change(
      screen.getByLabelText('What is wrong with this AI decision?'),
      { target: { value: 'Passed with a profitable build available' } },
    );
    fireEvent.change(
      screen.getByLabelText('Expected behavior or suggested improvement'),
      { target: { value: 'Compare the build with passing' } },
    );
    fireEvent.change(screen.getByLabelText('Category'), {
      target: { value: 'optimization' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Submit report' }));
    await waitFor(() =>
      expect(platformFeedbackApi.submit).toHaveBeenCalledWith(
        expect.objectContaining({
          category: 'optimization',
          expectedBehavior: 'Compare the build with passing',
          target: {
            kind: 'native-session',
            sessionId: 'session-1',
            eventSequence: 41,
          },
        }),
      ),
    );
  });

  it('fences pending reports on session/account changes and disables duplicate submissions', async () => {
    let resolve!: (value: never) => void;
    vi.mocked(platformFeedbackApi.submit).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const view = render(<LogFixture />);
    openReport();
    fireEvent.change(screen.getByLabelText('What happened?'), {
      target: { value: 'First session issue' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Submit report' }));
    expect(screen.getByRole('button', { name: 'Submitting…' })).toBeDisabled();
    view.rerender(<LogFixture sessionId='session-2' identityKey='bob' />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    openReport();
    fireEvent.change(screen.getByLabelText('What happened?'), {
      target: { value: 'Second session issue' },
    });
    await act(async () => resolve({ reportId: 'old-report' } as never));
    expect(screen.getByLabelText('What happened?')).toHaveValue(
      'Second session issue',
    );
    expect(platformFeedbackApi.submit).toHaveBeenCalledTimes(1);
  });

  it('allows keyboard selection without inventing an identity for unmapped logs', () => {
    render(<LogFixture />);
    fireEvent.click(screen.getByText('Unmapped legacy event'));
    expect(
      screen.queryByRole('button', { name: 'Report this issue' }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'Select log for report' }),
    );
    expect(
      screen.getByRole('button', { name: 'Report this issue' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('group', { name: 'Game log entry' }),
    ).toHaveAttribute('data-report-selected', 'true');
  });
});
