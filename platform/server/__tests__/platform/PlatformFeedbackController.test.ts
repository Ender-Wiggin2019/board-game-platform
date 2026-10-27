import { describe, expect, it, vi } from 'vitest';
import { PlatformFeedbackController } from '@/platform/feedback/controller.js';
import { PlatformFeedbackService } from '@/platform/feedback/service.js';
import { MemoryPlatformFeedbackStore } from '@/platform/feedback/store.js';
import type { PlatformApplicationRuntime } from '@/platform/PlatformApplicationRuntime.js';
import { PlatformSessionDiagnostics } from '@/platform/PlatformSessionDiagnostics.js';

function request(principalId: string) {
  return { user: { sub: principalId, sid: `${principalId}-auth` } } as never;
}

function controller(): PlatformFeedbackController {
  const runtime = {
    game: vi.fn(() => ({ releaseId: 'brass-v1' })),
    sessions: { descriptor: vi.fn() },
  } as unknown as PlatformApplicationRuntime;
  const diagnostics = {
    readForPrincipal: vi.fn(),
    readForAdmin: vi.fn(),
  } as unknown as PlatformSessionDiagnostics;
  return new PlatformFeedbackController(
    new PlatformFeedbackService(
      new MemoryPlatformFeedbackStore(),
      runtime,
      diagnostics,
    ),
  );
}

describe('PlatformFeedbackController', () => {
  it("returns only the authenticated author's reports from mine after POST", async () => {
    const instance = controller();
    await instance.submit(request('player-1'), {
      eventId: 'controller-event-1',
      category: 'bug',
      message: 'My report.',
    });
    await instance.submit(request('player-2'), {
      eventId: 'controller-event-2',
      category: 'ux',
      message: 'Another report.',
    });

    await expect(instance.mine(request('player-1'), {})).resolves.toMatchObject(
      {
        total: 1,
        items: [
          expect.objectContaining({
            eventId: 'controller-event-1',
            reporterId: 'player-1',
          }),
        ],
      },
    );
  });

  it('allows an author to read full detail and hides another author report', async () => {
    const instance = controller();
    const own = await instance.submit(request('player-1'), {
      eventId: 'controller-detail-1',
      category: 'bug',
      message: 'My detail report.',
    });
    const other = await instance.submit(request('player-2'), {
      eventId: 'controller-detail-2',
      category: 'ux',
      message: 'Another detail report.',
    });

    await expect(
      instance.mineReport(request('player-1'), own.reportId),
    ).resolves.toMatchObject({
      reportId: own.reportId,
      reporterId: 'player-1',
      message: 'My detail report.',
    });
    await expect(
      instance.mineReport(request('player-1'), other.reportId),
    ).rejects.toMatchObject({ envelope: { code: 'NOT_FOUND' } });
  });
});
