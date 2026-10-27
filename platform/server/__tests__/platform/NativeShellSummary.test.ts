import type { Participant } from '@board-game/contracts';
import { describe, expect, it, vi } from 'vitest';
import { GameCapabilityRegistry } from '@/platform/capabilities/index.js';
import { NativeShellSummaryReader } from '@/platform/NativeShellSummary.js';

const participants = [
  { principalId: 'player-a', seatId: 'seat-a' },
  { principalId: 'player-b', seatId: 'seat-b' },
] as const;

function registration(
  releaseId: string,
  interpret: (summary: unknown, principalId: string) => boolean,
  observeParticipants?: (participants: readonly Participant[]) => void,
): Parameters<GameCapabilityRegistry['register']>[0] {
  return {
    metadata: {
      gameId: 'native-test',
      name: 'Native test',
      description: 'Native test',
      themeId: 'native-test',
    },
    releaseId,
    capabilities: ['profile'],
    policyVersions: [],
    assets: [],
    profile: { read: async () => ({}) },
    sessionAttention: {
      interpret: (summary, context) => {
        observeParticipants?.(context.participants);
        return interpret(summary, context.principalId);
      },
      roomCapacity: (room) =>
        typeof room.setup === 'object' &&
        room.setup !== null &&
        !Array.isArray(room.setup) &&
        typeof (room.setup as Record<string, unknown>).playerCount === 'number'
          ? Number((room.setup as Record<string, unknown>).playerCount)
          : 2,
    },
  };
}

function sessionRow(
  sessionId: string,
  releaseId: string,
  summary: unknown,
  sessionParticipants: readonly Participant[] = participants,
  updatedAt = 10,
) {
  return {
    kind: 'session' as const,
    row_id: sessionId,
    game_id: 'native-test',
    mode_id: 'room',
    release_id: releaseId,
    backend_binding_id: 'backend',
    storage_binding_id: 'storage',
    ownership_epoch: 'epoch',
    status: 'active',
    participants: sessionParticipants,
    summary,
    members: null,
    setup: null,
    updated_at: updatedAt,
  };
}

function roomRow(
  roomId: string,
  releaseId: string,
  members: readonly Participant[],
  playerCount = 2,
  status: 'open' | 'starting' | 'started' = 'open',
) {
  return {
    kind: 'room' as const,
    row_id: roomId,
    game_id: 'native-test',
    mode_id: 'room',
    release_id: releaseId,
    backend_binding_id: null,
    storage_binding_id: null,
    ownership_epoch: null,
    status,
    participants: null,
    summary: null,
    members: members.map((member) => ({ ...member, ready: false })),
    setup: { playerCount },
    updated_at: 0,
  };
}

function reader(rows: readonly unknown[]) {
  const query = vi.fn(async () => ({ rows }));
  const registry = new GameCapabilityRegistry()
    .register(
      registration('native-current', (summary, principalId) =>
        Boolean(
          summary &&
            typeof summary === 'object' &&
            (summary as { actionRequired?: unknown }).actionRequired ===
              principalId,
        ),
      ),
    )
    .register(
      registration('native-retained', (summary, principalId) =>
        Boolean(
          summary &&
            typeof summary === 'object' &&
            (summary as { actionRequired?: unknown }).actionRequired ===
              principalId,
        ),
      ),
    );
  return {
    query,
    native: new NativeShellSummaryReader(
      { query } as unknown as ConstructorParameters<
        typeof NativeShellSummaryReader
      >[0],
      registry,
    ),
  };
}

describe('NativeShellSummaryReader', () => {
  it('counts exact retained releases and full open rooms without Host reads', async () => {
    const fixture = reader([
      sessionRow('old-session', 'native-retained', {
        actionRequired: 'player-a',
      }),
      sessionRow('old-session', 'native-retained', {
        actionRequired: 'player-a',
      }),
      sessionRow('current-session', 'native-current', {
        actionRequired: 'player-a',
      }),
      roomRow('old-room', 'native-retained', participants),
      roomRow('old-room', 'native-retained', participants),
      roomRow('not-full-room', 'native-current', [participants[0]]),
      roomRow('private-other-room', 'native-current', [participants[1]]),
      roomRow('starting-room', 'native-current', participants, 2, 'starting'),
      roomRow('started-room', 'native-current', participants, 2, 'started'),
      roomRow('direct:room', 'native-current', participants),
    ]);

    await expect(fixture.native.read('player-a')).resolves.toEqual(
      new Map([['native-test', { actionRequired: 2, waitingReady: 1 }]]),
    );
    expect(fixture.query).toHaveBeenCalledTimes(1);
    const firstCalls = fixture.query.mock.calls as unknown[][];
    expect(firstCalls[0]?.[0]).toContain('participants @> jsonb_build_array');
    expect(firstCalls[0]?.[0]).toContain("room_row.room->'members' @>");
    expect(firstCalls[0]?.[0]).toContain(
      "jsonb_build_object('principalId', $1::text)",
    );
    expect(firstCalls[0]?.[0]).not.toContain('jsonb_array_elements');
    expect(firstCalls[0]?.[0]).not.toContain('encodedState');
  });

  it('fails closed for missing summaries and never trusts an unauthorized row', async () => {
    const fixture = reader([
      sessionRow('missing-summary', 'native-current', null),
      sessionRow(
        'other-player',
        'native-current',
        { actionRequired: 'player-a' },
        [participants[1]],
      ),
    ]);

    await expect(fixture.native.read('player-a')).resolves.toEqual(new Map());
  });

  it('preserves bot controller and public profile fields for attention interpreters', async () => {
    const bot = {
      principalId: 'bot:native-test:one',
      seatId: 'bot:native-test:seat:one',
      controller: 'bot' as const,
      publicProfile: {
        displayName: 'Native Bot',
        gameProfile: { kind: 'native-test-bot' },
      },
    };
    let seenParticipants: readonly Participant[] = [];
    const query = vi.fn(async () => ({
      rows: [
        sessionRow(
          'bot-session',
          'native-current',
          { actionRequired: 'nobody' },
          [participants[0], bot],
        ),
      ],
    }));
    const registry = new GameCapabilityRegistry().register(
      registration(
        'native-current',
        () => false,
        (seen) => {
          seenParticipants = seen;
        },
      ),
    );
    const native = new NativeShellSummaryReader(
      { query } as unknown as ConstructorParameters<
        typeof NativeShellSummaryReader
      >[0],
      registry,
    );

    await expect(native.read('player-a')).resolves.toEqual(new Map());
    expect(seenParticipants).toEqual([
      participants[0],
      {
        principalId: bot.principalId,
        seatId: bot.seatId,
        controller: 'bot',
        publicProfile: bot.publicProfile,
      },
    ]);
  });

  it('projects hotseat attention to the controlling account and excludes the synthetic principal', async () => {
    const hotseat: Participant = {
      principalId: 'hotseat:native-test:one',
      seatId: 'hotseat:native-test:seat:one',
      controller: 'hotseat',
      controlledBy: 'player-a',
    };
    const query = vi.fn(async () => ({
      rows: [
        sessionRow(
          'hotseat-session',
          'native-current',
          { actionRequired: 'player-a' },
          [hotseat],
        ),
      ],
    }));
    const registry = new GameCapabilityRegistry().register(
      registration('native-current', (summary, principalId) =>
        Boolean(
          summary &&
            typeof summary === 'object' &&
            (summary as { actionRequired?: unknown }).actionRequired ===
              principalId,
        ),
      ),
    );
    const native = new NativeShellSummaryReader(
      { query } as unknown as ConstructorParameters<
        typeof NativeShellSummaryReader
      >[0],
      registry,
    );

    await expect(native.read('player-a')).resolves.toEqual(
      new Map([['native-test', { actionRequired: 1, waitingReady: 0 }]]),
    );
    await expect(native.read(hotseat.principalId)).resolves.toEqual(new Map());
  });

  it('paginates active sessions without an unbounded result', async () => {
    const firstPage = Array.from({ length: 64 }, (_, index) =>
      sessionRow(
        `session-${index}`,
        'native-current',
        { actionRequired: 'player-a' },
        participants,
        100 - index,
      ),
    ).reverse();
    const lastPage = [
      sessionRow(
        'session-last',
        'native-current',
        { actionRequired: 'player-a' },
        participants,
        1,
      ),
    ];
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: firstPage })
      .mockResolvedValueOnce({ rows: lastPage });
    const registry = new GameCapabilityRegistry().register(
      registration('native-current', (summary, principalId) =>
        Boolean(
          summary &&
            typeof summary === 'object' &&
            (summary as { actionRequired?: unknown }).actionRequired ===
              principalId,
        ),
      ),
    );
    const native = new NativeShellSummaryReader(
      { query } as unknown as ConstructorParameters<
        typeof NativeShellSummaryReader
      >[0],
      registry,
    );

    await expect(native.read('player-a')).resolves.toEqual(
      new Map([['native-test', { actionRequired: 65, waitingReady: 0 }]]),
    );
    expect(query).toHaveBeenCalledTimes(2);
    const calls = query.mock.calls as unknown[][];
    expect((calls[1]?.[1] as unknown[] | undefined)?.[4]).toBe(true);
    expect((calls[1]?.[1] as unknown[] | undefined)?.[5]).toBe(false);
    expect((calls[1]?.[1] as unknown[] | undefined)?.[1]).toBe(37);
    expect((calls[1]?.[1] as unknown[] | undefined)?.[2]).toBe('session-63');
  });

  it('paginates room projections independently of session summaries', async () => {
    const firstPage = Array.from({ length: 64 }, (_, index) =>
      roomRow(
        `room-${index.toString().padStart(2, '0')}`,
        'native-current',
        participants,
      ),
    ).reverse();
    const lastPage = [roomRow('room-last', 'native-current', participants)];
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: firstPage })
      .mockResolvedValueOnce({ rows: lastPage });
    const registry = new GameCapabilityRegistry().register(
      registration('native-current', (summary, principalId) =>
        Boolean(
          summary &&
            typeof summary === 'object' &&
            (summary as { actionRequired?: unknown }).actionRequired ===
              principalId,
        ),
      ),
    );
    const native = new NativeShellSummaryReader(
      { query } as unknown as ConstructorParameters<
        typeof NativeShellSummaryReader
      >[0],
      registry,
    );

    await expect(native.read('player-a')).resolves.toEqual(
      new Map([['native-test', { actionRequired: 0, waitingReady: 65 }]]),
    );
    expect(query).toHaveBeenCalledTimes(2);
    const calls = query.mock.calls as unknown[][];
    expect((calls[1]?.[1] as unknown[] | undefined)?.[4]).toBe(false);
    expect((calls[1]?.[1] as unknown[] | undefined)?.[5]).toBe(true);
    expect((calls[1]?.[1] as unknown[] | undefined)?.[6]).toBe('room-63');
  });
});
