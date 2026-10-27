import { randomUUID } from 'node:crypto';
import type { SessionRoute } from '@board-game/contracts';
import type { AutomationTrace } from '@board-game/storage';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PlatformFeedbackService } from '@/platform/feedback/service.js';
import {
  type CreatePlatformFeedbackRecord,
  PostgresPlatformFeedbackStore,
} from '@/platform/feedback/store.js';
import type { PlatformApplicationRuntime } from '@/platform/PlatformApplicationRuntime.js';
import type { PlatformSessionDiagnostics } from '@/platform/PlatformSessionDiagnostics.js';

const databaseUrl = process.env.BGP_TEST_DATABASE_URL;
const postgresSuite = databaseUrl ? describe : describe.skip;

describe('platform feedback migration', () => {
  it('runs schema changes in one transaction and rolls back failures', async () => {
    const statements: string[] = [];
    const client = {
      query: vi.fn(async (statement: string) => {
        statements.push(statement);
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
    } as unknown as Pool;

    await new PostgresPlatformFeedbackStore(pool).migrate();

    expect(statements[0]).toBe('BEGIN');
    expect(statements.at(-1)).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledOnce();

    const failingStatements: string[] = [];
    const failingClient = {
      query: vi.fn(async (statement: string) => {
        failingStatements.push(statement);
        if (statement !== 'BEGIN') throw new Error('migration failed');
      }),
      release: vi.fn(),
    };
    const failingPool = {
      connect: vi.fn(async () => failingClient),
    } as unknown as Pool;

    await expect(
      new PostgresPlatformFeedbackStore(failingPool).migrate(),
    ).rejects.toThrow('migration failed');
    expect(failingStatements).toEqual([
      'BEGIN',
      'CREATE SCHEMA IF NOT EXISTS board_platform_feedback',
      'ROLLBACK',
    ]);
    expect(failingClient.release).toHaveBeenCalledOnce();
  });
});

postgresSuite('PostgresPlatformFeedbackStore', () => {
  let pool: Pool;
  let store: PostgresPlatformFeedbackStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    store = new PostgresPlatformFeedbackStore(pool);
    await store.migrate();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('persists a typed report and deduplicates concurrent retries', async () => {
    const eventId = `postgres-feedback-${randomUUID()}`;
    const input: CreatePlatformFeedbackRecord = {
      eventId,
      fingerprint: 'feedback-fingerprint-1',
      sourceRecordId: `platform-feedback:postgres:${eventId}`,
      reporterId: 'postgres-player',
      category: 'bug',
      message: 'The native session did not advance.',
      expectedBehavior: undefined,
      gameId: 'brass',
      releaseId: 'brass-v1',
      sessionId: 'session-postgres',
      traceId: 'command:postgres',
      traceSnapshot: {
        kind: 'command',
        sessionId: 'session-postgres',
        traceId: 'command:postgres',
        decisionId: 'command:postgres',
        commandId: 'command:postgres',
        deadlineId: 'command:postgres',
        releaseId: 'brass-v1',
        policyId: 'player-command',
        expectedRevision: 0,
        seatId: 'seat-1',
        turnId: 'revision:0',
        state: { private: true },
        input: { actor: { principalId: 'postgres-player' } },
        schemaVersion: 1,
        options: null,
        command: { type: 'claim' },
        outcome: 'executed',
        startedAt: 1,
        finishedAt: 2,
        createdAt: 1,
      },
      nativeDiagnostics: {
        kind: 'native-session',
        sessionId: 'session-postgres',
        gameId: 'brass',
        releaseId: 'brass-v1',
        status: 'active',
        sourceRevision: 3,
        updatedAt: 1_000,
        summary: { phase: 'turn' },
        events: [],
      },
    };

    const [first, retry] = await Promise.all([
      store.create(input),
      store.create(input),
    ]);

    expect(retry).toEqual(first);
    expect(first).toMatchObject({
      eventId,
      fingerprint: 'feedback-fingerprint-1',
      reporterId: 'postgres-player',
      gameId: 'brass',
      status: 'open',
    });
    const listed = (await store.list({ limit: 10, gameId: 'brass' })).items;
    expect(listed.filter((item) => item.eventId === eventId)).toEqual([
      expect.objectContaining({ reportId: first.reportId, eventId }),
    ]);
    expect(listed.find((item) => item.eventId === eventId)).not.toHaveProperty(
      'nativeDiagnostics',
    );
    expect(listed.find((item) => item.eventId === eventId)).not.toHaveProperty(
      'traceSnapshot',
    );
    const platformEventId = `postgres-platform-${randomUUID()}`;
    await store.create({
      eventId: platformEventId,
      fingerprint: 'platform-fingerprint-1',
      sourceRecordId: `platform-feedback:postgres:${platformEventId}`,
      reporterId: 'postgres-player',
      category: 'bug',
      message: 'The platform shell is unavailable.',
    });
    const platformReports = (await store.list({ limit: 10, scope: 'platform' }))
      .items;
    expect(platformReports.map((item) => item.eventId)).toContain(
      platformEventId,
    );
    expect(platformReports.map((item) => item.eventId)).not.toContain(eventId);
    await expect(
      store.findByEvent('postgres-player', eventId),
    ).resolves.toMatchObject({
      reportId: first.reportId,
      fingerprint: 'feedback-fingerprint-1',
      traceId: 'command:postgres',
    });

    await expect(
      store.updateStatus(first.reportId, 'resolved', new Date()),
    ).resolves.toMatchObject({ reportId: first.reportId, status: 'resolved' });
  });

  it('replays report evidence persisted beyond the live trace TTL', async () => {
    const route: SessionRoute = {
      gameId: 'brass',
      modeId: 'regular',
      sessionId: `session-postgres-replay-${randomUUID()}`,
      releaseId: 'brass-v1',
      backendBindingId: 'backend-1',
      storageBindingId: 'storage-1',
      ownershipEpoch: 'epoch-1',
    };
    const traceSnapshot: AutomationTrace = {
      kind: 'command',
      sessionId: route.sessionId,
      traceId: 'command:expired-report',
      decisionId: 'command:expired-report',
      commandId: 'command:expired-report',
      deadlineId: 'command:expired-report',
      releaseId: route.releaseId,
      policyId: 'player-command',
      expectedRevision: 0,
      seatId: 'seat-1',
      turnId: 'revision:0',
      state: { turn: 0 },
      input: { actor: { principalId: 'player-1', kind: 'player' } },
      schemaVersion: 1,
      options: null,
      command: { type: 'claim' },
      outcome: 'executed',
      startedAt: 1,
      finishedAt: 2,
      createdAt: 1,
    };
    const report = await store.create({
      eventId: `postgres-replay-${randomUUID()}`,
      fingerprint: 'postgres-replay-fingerprint',
      sourceRecordId: `platform-feedback:postgres-replay:${randomUUID()}`,
      reporterId: 'postgres-admin-test',
      kind: 'game',
      category: 'bug',
      message: 'Replay this report after the live trace expires.',
      gameId: route.gameId,
      releaseId: route.releaseId,
      sessionId: route.sessionId,
      traceId: traceSnapshot.traceId,
      traceSnapshot,
    });
    const replay = vi.fn(async () => ({
      traceKind: 'command' as const,
      traceId: traceSnapshot.traceId,
      decisionId: traceSnapshot.decisionId,
      policyId: traceSnapshot.policyId,
      durationMs: 0,
      inputDigest: 'digest',
      legal: true,
    }));
    const runtime = {
      admissionStore: {
        getAdmission: vi.fn(async () => ({ route })),
      },
      game: vi.fn(() => ({
        identity: {
          diagnosticAccess: vi.fn(async () => ({
            principalId: 'diagnostic',
            authEpoch: 'diagnostic',
            scopes: ['session:view', 'session:spectate'],
          })),
        },
        host: { replayAutomationTraceEvidence: replay },
      })),
    } as unknown as PlatformApplicationRuntime;
    const service = new PlatformFeedbackService(
      store,
      runtime,
      {} as PlatformSessionDiagnostics,
    );

    expect((await store.get(report.reportId))?.traceSnapshot).toEqual(
      traceSnapshot,
    );
    await expect(
      service.replayTraceEvidenceForAdmin(
        { principalId: 'postgres-admin-test', authSessionId: 'auth-1' },
        report.reportId,
      ),
    ).resolves.toMatchObject({ traceKind: 'command', legal: true });
    expect(replay).toHaveBeenCalledWith(
      expect.objectContaining({ trace: traceSnapshot }),
    );
  });
});
