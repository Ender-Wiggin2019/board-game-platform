import type {
  JsonValue,
  MatchAdmission,
  SessionRoute,
} from '@board-game/contracts';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { validateRecord } from '../src/directory/invariants.js';
import { MemorySessionDirectory } from '../src/directory/memory.js';
import { PostgresSessionDirectory } from '../src/directory/postgres.js';
import type {
  SessionDirectoryEnvelope,
  SessionDirectoryOptions,
  SessionDirectoryStore,
} from '../src/directory/types.js';

const route: SessionRoute = {
  gameId: 'seti',
  modeId: 'ranked',
  sessionId: 'directory-session-1',
  releaseId: 'release-1',
  backendBindingId: 'backend-1',
  storageBindingId: 'storage-1',
  ownershipEpoch: 'epoch-1',
};

const admission: MatchAdmission = {
  id: 'admission-1',
  route,
  participants: [
    {
      principalId: 'player-1',
      seatId: 'seat-1',
      publicProfile: { displayName: 'One' },
    },
    { principalId: 'player-2', seatId: 'seat-2' },
  ],
  visibility: 'private',
  rating: null,
  validityPolicyVersion: 'validity-1',
  createdAt: 10,
};

function options(
  value: MatchAdmission = admission,
  history: SessionDirectoryOptions['retentionResolver'] = () =>
    'summary-and-replay',
): SessionDirectoryOptions {
  return {
    admission: { getAdmission: async () => value },
    retentionResolver: history,
    now: () => 100,
  };
}

function fact(
  kind: SessionDirectoryEnvelope['kind'],
  aggregateSequence: number,
  payload: Record<string, unknown> = {},
  eventId = `${kind}-${aggregateSequence}`,
): SessionDirectoryEnvelope {
  return {
    producerId: `game:${route.gameId}:session:${route.sessionId}`,
    eventId,
    sessionId: route.sessionId,
    kind,
    schemaVersion: 1,
    sourceRelease: route.releaseId,
    payload: payload as JsonValue,
    aggregateSequence,
    occurredAt: aggregateSequence * 10,
    receivedAt: aggregateSequence * 10 + 1,
    digest: `transport-digest-${eventId}`,
  };
}

async function seed(directory: MemorySessionDirectory): Promise<void> {
  await directory.applyFact(
    fact('SessionCreated', 1, { summary: { phase: 'created' } }),
  );
  await directory.applyFact(fact('SessionActivated', 2));
}

async function applyLateCompletionScenario(
  directory: SessionDirectoryStore,
): Promise<void> {
  await directory.applyFact(
    fact('SessionCreated', 1, { summary: { phase: 'created' } }),
  );
  await directory.applyFact(fact('SessionActivated', 2));
  await directory.applyFact(
    fact('SessionSummaryChanged', 10, {
      summary: { phase: 'latest-summary' },
      participants: [
        {
          principalId: 'player-1',
          seatId: 'seat-1',
          publicProfile: { displayName: 'Latest profile' },
        },
        { principalId: 'player-2', seatId: 'seat-2' },
      ],
    }),
  );

  const completed = await directory.applyFact(
    fact('SessionCompleted', 3, {
      summary: { phase: 'late-summary' },
      result: { winner: 'player-1' },
      participants: [
        {
          principalId: 'player-1',
          seatId: 'seat-1',
          publicProfile: { displayName: 'Late profile' },
        },
        { principalId: 'player-2', seatId: 'seat-2' },
      ],
      status: 'completed',
    }),
  );
  expect(completed.status).toBe('completed');
  expect(completed.result).toEqual({ winner: 'player-1' });
  expect(completed.latestAggregateSequence).toBe(10);
  expect(completed.summary).toEqual({ phase: 'latest-summary' });
  expect(completed.participants[0]?.publicProfile).toEqual({
    displayName: 'Latest profile',
  });

  await expect(
    directory.applyFact(
      fact(
        'SessionCompleted',
        11,
        { result: { winner: 'player-2' }, status: 'completed' },
        'completed-conflict',
      ),
    ),
  ).rejects.toMatchObject({ code: 'FACT_CONFLICT' });

  await expect(
    directory.applyFact(
      fact('SessionActivated', 4, { status: 'active' }, 'late-activation'),
    ),
  ).resolves.toMatchObject({
    status: 'completed',
    result: { winner: 'player-1' },
  });
}

describe('MemorySessionDirectory', () => {
  it('projects a hotseat session to its controlling account and excludes the synthetic principal', async () => {
    const hotseat: MatchAdmission = {
      ...admission,
      participants: [
        { principalId: 'player-1', seatId: 'seat-1' },
        {
          principalId: 'hotseat:session:seat-2',
          seatId: 'seat-2',
          controller: 'hotseat',
          controlledBy: 'player-1',
        },
      ],
    };
    const directory = new MemorySessionDirectory(options(hotseat));
    await directory.applyFact(
      fact('SessionCreated', 1, { participants: hotseat.participants }),
    );

    expect((await directory.listForPrincipal('player-1')).items).toHaveLength(
      1,
    );
    expect(
      (await directory.listForPrincipal('hotseat:session:seat-2')).items,
    ).toHaveLength(0);
  });

  it('rejects unknown controller fields in directory payloads and records', async () => {
    const directory = new MemorySessionDirectory(options());
    await expect(
      directory.applyFact(
        fact('SessionCreated', 1, {
          participants: [
            { principalId: 'player-1', seatId: 'seat-1', extra: true },
            { principalId: 'player-2', seatId: 'seat-2' },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

    expect(() =>
      validateRecord({
        sessionId: route.sessionId,
        admissionId: admission.id,
        route,
        visibility: 'private',
        participants: [
          { principalId: 'player-1', seatId: 'seat-1', extra: true } as never,
        ],
        status: 'suspended',
        latestAggregateSequence: 0,
        createdAt: 1,
        updatedAt: 1,
      }),
    ).toThrow('stored participant schema is invalid');
  });

  it('projects only safe summary data and preserves clone isolation', async () => {
    const directory = new MemorySessionDirectory(options());
    const created = await directory.applyFact(
      fact('SessionCreated', 1, {
        summary: { phase: 'created' },
        participants: [
          {
            principalId: 'player-1',
            seatId: 'seat-1',
            publicProfile: { displayName: 'One' },
          },
          { principalId: 'player-2', seatId: 'seat-2' },
        ],
      }),
    );
    expect(created).toMatchObject({
      sessionId: route.sessionId,
      route,
      status: 'suspended',
      latestAggregateSequence: 1,
      summary: { phase: 'created' },
    });
    const leaked = created as unknown as { summary: { phase: string } };
    leaked.summary.phase = 'mutated';
    expect((await directory.getSession(route.sessionId))?.summary).toEqual({
      phase: 'created',
    });
  });

  it('accepts trusted public profile refreshes while keeping the frozen roster identity', async () => {
    const directory = new MemorySessionDirectory(options());
    await directory.applyFact(
      fact('SessionCreated', 0, {
        summary: { phase: 'created' },
        participants: admission.participants,
      }),
    );
    const updated = await directory.applyFact(
      fact('SessionSummaryChanged', 1, {
        summary: { phase: 'active' },
        participants: [
          {
            principalId: 'player-1',
            seatId: 'seat-1',
            publicProfile: { displayName: 'Renamed' },
          },
          { principalId: 'player-2', seatId: 'seat-2' },
        ],
      }),
    );
    expect(updated.participants[0]).toMatchObject({
      principalId: 'player-1',
      seatId: 'seat-1',
      publicProfile: { displayName: 'Renamed' },
    });
  });

  it('ignores stale sequences, deduplicates retries, and rejects same-sequence conflicts', async () => {
    const directory = new MemorySessionDirectory(options());
    await seed(directory);
    const duplicate = await directory.applyFact(fact('SessionActivated', 2));
    expect(duplicate.status).toBe('active');
    const stale = await directory.applyFact(
      fact('SessionSummaryChanged', 1, { summary: { phase: 'old' } }, 'stale'),
    );
    expect(stale.latestAggregateSequence).toBe(2);
    expect(stale.summary).toEqual({ phase: 'created' });
    await expect(
      directory.applyFact(
        fact(
          'SessionActivated',
          2,
          { summary: { different: true } },
          'conflict',
        ),
      ),
    ).rejects.toMatchObject({ code: 'FACT_CONFLICT' });
    await expect(
      directory.applyFact(
        fact('SessionActivated', 3, {}, 'SessionActivated-2'),
      ),
    ).rejects.toMatchObject({ code: 'FACT_CONFLICT' });
  });

  it('accepts different fact kinds at one sequence but keeps status monotonic', async () => {
    const directory = new MemorySessionDirectory(options());
    await directory.applyFact(fact('SessionCreated', 1));
    await directory.applyFact(fact('SessionActivated', 1));
    const completed = await directory.applyFact(
      fact('SessionCompleted', 1, { result: { winner: 'player-1' } }),
    );
    expect(completed.status).toBe('completed');
    expect(completed.result).toEqual({ winner: 'player-1' });
  });

  it('normalizes host lifecycle payloads and preserves completion on same-sequence retries', async () => {
    const directory = new MemorySessionDirectory(options());
    await directory.applyFact(fact('SessionCreated', 0, { phase: 'created' }));
    await directory.applyFact(fact('SessionActivated', 1, { phase: 'active' }));
    await directory.applyFact(
      fact(
        'SessionCompleted',
        2,
        {
          summary: { phase: 'done' },
          result: { winner: 'player-1' },
          resultRevision: 1,
          endedAt: 20,
        },
        'completed-first',
      ),
    );
    const afterSummaryRetry = await directory.applyFact(
      fact(
        'SessionSummaryChanged',
        2,
        { summary: { phase: 'done' }, progress: { step: 1 } },
        'summary-after-completion',
      ),
    );
    expect(afterSummaryRetry.status).toBe('completed');
    expect(afterSummaryRetry.result).toEqual({ winner: 'player-1' });
  });

  it('projects a late completion without losing the newer summary or reopening the terminal session', async () => {
    await applyLateCompletionScenario(new MemorySessionDirectory(options()));
  });

  it('projects host SessionControlled actions into lifecycle status', async () => {
    const directory = new MemorySessionDirectory(options());
    await directory.applyFact(fact('SessionCreated', 0, { summary: {} }));
    await directory.applyFact(fact('SessionActivated', 1, { summary: {} }));
    expect(
      (
        await directory.applyFact(
          fact('SessionControlled', 2, {
            action: 'pause',
            principalId: 'player-1',
            summary: { phase: 'paused' },
            status: 'paused',
          }),
        )
      ).status,
    ).toBe('paused');
    expect(
      (
        await directory.applyFact(
          fact('SessionControlled', 3, {
            action: 'resume',
            principalId: 'player-1',
            summary: { phase: 'resumed' },
            status: 'active',
          }),
        )
      ).status,
    ).toBe('active');
  });

  it('does not retain results for progress-only or ephemeral history', async () => {
    for (const history of ['progress-only', 'ephemeral-result'] as const) {
      const directory = new MemorySessionDirectory(
        options(admission, () => history),
      );
      const completed = await directory.applyFact(
        fact('SessionCompleted', 1, {
          summary: { progress: 1 },
          result: { answer: 'private' },
        }),
      );
      expect(completed.result).toBeUndefined();
      if (history === 'ephemeral-result')
        expect(completed.summary).toBeUndefined();
      else expect(completed.summary).toEqual({ progress: 1 });
    }
  });

  it('filters private sessions, supports public sessions, and paginates stably', async () => {
    const publicAdmission: MatchAdmission = {
      ...admission,
      id: 'public-admission',
      visibility: 'public',
    };
    const directory = new MemorySessionDirectory({
      ...options(),
      admission: {
        getAdmission: async (sessionId) =>
          sessionId === route.sessionId ? publicAdmission : null,
      },
    });
    await directory.applyFact(fact('SessionCreated', 1));
    expect((await directory.listForPrincipal('outsider')).items).toHaveLength(
      1,
    );
    expect((await directory.listPublic('seti')).items).toHaveLength(1);
    expect((await directory.listPublic('other-game')).items).toHaveLength(0);
    const page = await directory.listForPrincipal('outsider', { limit: 1 });
    expect(page.nextCursor).toBeDefined();
    expect(
      (
        await directory.listForPrincipal('outsider', {
          cursor: page.nextCursor,
        })
      ).items,
    ).toHaveLength(0);
  });

  it('rejects source spoofing and roster changes', async () => {
    const directory = new MemorySessionDirectory(options());
    await expect(
      directory.applyFact({
        ...fact('SessionCreated', 1),
        producerId: 'game:other:session:directory-session-1',
      }),
    ).rejects.toMatchObject({ code: 'ROUTE_MISMATCH' });
    await expect(
      directory.applyFact(
        fact('SessionCreated', 1, {
          participants: [{ principalId: 'attacker', seatId: 'seat-1' }],
        }),
      ),
    ).rejects.toMatchObject({ code: 'ROUTE_MISMATCH' });
  });

  it('serializes concurrent updates without losing the newest projection', async () => {
    const directory = new MemorySessionDirectory(options());
    const results = await Promise.all([
      directory.applyFact(fact('SessionCreated', 1, { summary: { n: 1 } })),
      directory.applyFact(
        fact('SessionSummaryChanged', 2, { summary: { n: 2 } }),
      ),
      directory.applyFact(
        fact('SessionSummaryChanged', 3, { summary: { n: 3 } }),
      ),
    ]);
    expect(
      (await directory.getSession(route.sessionId))?.latestAggregateSequence,
    ).toBe(3);
    expect((await directory.getSession(route.sessionId))?.summary).toEqual({
      n: 3,
    });
    expect(results).toHaveLength(3);
  });
});

const databaseUrl = process.env.BGP_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('PostgresSessionDirectory', () => {
  it('projects a late completion without losing the newer summary or reopening the terminal session', async () => {
    const pool = new Pool({ connectionString: databaseUrl });
    const schema = `directory_late_completion_${process.pid}_${Math.random().toString(36).slice(2, 9)}`;
    const directory = new PostgresSessionDirectory({
      pool,
      schema,
      ...options(),
    });
    try {
      await directory.migrate();
      await applyLateCompletionScenario(directory);
    } finally {
      await directory.close();
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
  });

  it('upgrades an existing fact constraint and persists cancellation after restart', async () => {
    const pool = new Pool({ connectionString: databaseUrl });
    const schema = `directory_cancel_${process.pid}_${Math.random().toString(36).slice(2, 9)}`;
    const first = new PostgresSessionDirectory({ pool, schema, ...options() });
    try {
      await first.migrate();
      await pool.query(
        `ALTER TABLE "${schema}".facts DROP CONSTRAINT facts_kind_check, ADD CONSTRAINT facts_kind_check CHECK (kind IN ('SessionCreated', 'SessionActivated', 'SessionSummaryChanged', 'SessionCompleted'))`,
      );
      await first.applyFact(
        fact('SessionCreated', 1, { summary: { phase: 'created' } }),
      );
      await first.migrate();
      await first.migrate();
      await first.applyFact(
        fact('SessionControlled', 2, {
          action: 'cancel',
          status: 'cancelled',
          principalId: 'player-1',
        }),
      );
      const restarted = new PostgresSessionDirectory({
        pool,
        schema,
        ...options(),
      });
      expect(await restarted.getSession(route.sessionId)).toMatchObject({
        status: 'cancelled',
        latestAggregateSequence: 2,
      });
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
  });

  it('survives a new store instance and rolls back conflicting facts', async () => {
    const pool = new Pool({ connectionString: databaseUrl });
    const schema = `directory_test_${process.pid}_${Math.random().toString(36).slice(2, 9)}`;
    const storeOptions = {
      connectionString: databaseUrl,
      schema,
      ...options(),
    };
    const first = new PostgresSessionDirectory(storeOptions);
    const second = new PostgresSessionDirectory({
      connectionString: databaseUrl,
      schema,
      ...options(),
    });
    try {
      await first.migrate();
      await first.applyFact(
        fact('SessionCreated', 1, { summary: { phase: 'created' } }),
      );
      await expect(
        first.applyFact(
          fact(
            'SessionCreated',
            1,
            { summary: { phase: 'different' } },
            'conflict',
          ),
        ),
      ).rejects.toMatchObject({ code: 'FACT_CONFLICT' });
      expect((await second.getSession(route.sessionId))?.summary).toEqual({
        phase: 'created',
      });
      await second.applyFact(
        fact('SessionCompleted', 2, { result: { winner: 'player-1' } }),
      );
      expect((await first.getSession(route.sessionId))?.status).toBe(
        'completed',
      );
    } finally {
      await first.close();
      await second.close();
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
  });
});
