import type {
  AccessContext,
  Actor,
  Participant,
  PlatformRoom,
} from '@board-game/contracts';
import { GameHost, GameRegistry } from '@board-game/host';
import { MemoryStorageDriver } from '@board-game/storage';
import { sequentialTurnFixture } from '@board-game/testing/fixtures';
import { describe, expect, it } from 'vitest';
import { AdmissionCoordinator } from '../src/admission/AdmissionCoordinator.js';
import { MemoryAdmissionStore } from '../src/admission/memory.js';

const access: AccessContext = {
  principalId: 'platform',
  authEpoch: '1',
  scopes: ['session:create', 'session:control'],
};

function harness(
  options: {
    readonly freezeParticipants?: (
      room: PlatformRoom,
    ) => Promise<readonly Participant[]>;
    readonly observedActors?: Actor[][];
  } = {},
) {
  const store = new MemoryAdmissionStore();
  const gameStore = new MemoryStorageDriver();
  const observedActors = options.observedActors ?? [];
  const base = sequentialTurnFixture;
  const instrumented = {
    ...base,
    rules: {
      ...base.rules,
      create: (
        setup: Parameters<typeof base.rules.create>[0],
        context: Parameters<typeof base.rules.create>[1],
      ) => {
        observedActors.push(structuredClone([...context.participants]));
        return base.rules.create(setup, context);
      },
    },
  } as typeof sequentialTurnFixture;
  const backend = new GameHost({
    registry: new GameRegistry().register(instrumented),
    storage: gameStore,
    backendBindingId: 'embedded',
    storageBindingId: 'games',
    authorize: async () => undefined,
    now: () => 100,
  });
  let id = 0;
  const makeCoordinator = () =>
    new AdmissionCoordinator({
      store,
      now: () => 100,
      newId: () => `id-${++id}`,
      resolveRelease: () => ({
        gameId: instrumented.gameId,
        releaseId: instrumented.releaseId,
        mode: instrumented.modes[0],
        backendBindingId: 'embedded',
        storageBindingId: 'games',
        ownershipEpoch: '1',
        backend,
        validateSetup: () => undefined,
      }),
      resolveBackend: () => backend,
      authorize: async () => true,
      freezePolicy: async () => ({
        rating: {
          poolId: 'fixture-pool',
          policyVersion: 'skill-v1',
          progressionPolicyVersion: 'progress-v1',
          seasonId: null,
        },
        validityPolicyVersion: 'casual-v1',
      }),
      freezeParticipants: options.freezeParticipants,
      accessForStart: async () => access,
    });

  const coordinator = makeCoordinator();
  async function readyRoom(): Promise<PlatformRoom> {
    let room = await coordinator.createRoom('alice', {
      gameId: instrumented.gameId,
      modeId: instrumented.modes[0].id,
      releaseId: instrumented.releaseId,
      visibility: 'private',
      setup: { target: 2 },
    });
    room = await coordinator.joinRoom('bob', room.id, room.revision);
    room = await coordinator.ready('alice', room.id, room.revision, true);
    return coordinator.ready('bob', room.id, room.revision, true);
  }

  return {
    backend,
    coordinator,
    gameStore,
    makeCoordinator,
    observedActors,
    readyRoom,
    store,
  };
}

const profiles: readonly Participant[] = [
  {
    principalId: 'alice',
    seatId: 'seat-alice',
    publicProfile: {
      displayName: 'Alice Explorer',
      appearance: { color: 'amber' },
    },
  },
  {
    principalId: 'bob',
    seatId: 'seat-bob',
    publicProfile: {
      displayName: 'Bob Explorer',
      gameProfile: { badge: 'scout' },
    },
  },
];

function profileForRoom(room: PlatformRoom): readonly Participant[] {
  return room.members.map((member, index) => ({
    principalId: member.principalId,
    seatId: member.seatId,
    ...(profiles[index]?.publicProfile
      ? { publicProfile: profiles[index].publicProfile }
      : {}),
  }));
}

describe('trusted public player profiles', () => {
  it('freezes server profiles and passes them through Host rules.create actors', async () => {
    const fixture = harness({
      freezeParticipants: async (room) => profileForRoom(room),
    });
    const room = await fixture.readyRoom();

    const started = await fixture.coordinator.startRoom(
      'alice',
      room.id,
      room.revision,
      'profiles-1',
    );

    expect(started.state).toBe('active');
    expect(await fixture.store.getAdmission(started.sessionId)).toMatchObject({
      participants: profileForRoom(room),
    });
    expect(fixture.observedActors).toEqual([
      [
        expect.objectContaining({
          kind: 'player',
          principalId: 'alice',
          publicProfile: profiles[0].publicProfile,
        }),
        expect.objectContaining({
          kind: 'player',
          principalId: 'bob',
          publicProfile: profiles[1].publicProfile,
        }),
      ],
    ]);
  });

  it('keeps the frozen profile immutable across reads and coordinator restart', async () => {
    const fixture = harness({
      freezeParticipants: async (room) => profileForRoom(room),
    });
    const room = await fixture.readyRoom();
    await fixture.coordinator.startRoom(
      'alice',
      room.id,
      room.revision,
      'profiles-2',
    );

    const snapshot = await fixture.store.getStart(room.id);
    if (!snapshot) throw new Error('missing frozen start');
    const mutable = snapshot as unknown as {
      admission: {
        participants: Array<{ publicProfile?: { displayName?: string } }>;
      };
    };
    mutable.admission.participants[0].publicProfile = {
      displayName: 'tampered',
    };

    await fixture.makeCoordinator().recoverStart(room.id);
    expect(
      (await fixture.store.getStart(room.id))?.admission.participants,
    ).toEqual(profileForRoom(room));
  });

  it('rejects a callback that changes the frozen roster identity', async () => {
    const fixture = harness({
      freezeParticipants: async (room) =>
        room.members.map((member, index) => ({
          principalId: member.principalId,
          seatId: index === 0 ? 'spoofed-seat' : member.seatId,
        })),
    });
    const room = await fixture.readyRoom();

    await expect(
      fixture.coordinator.startRoom(
        'alice',
        room.id,
        room.revision,
        'profiles-3',
      ),
    ).rejects.toMatchObject({ envelope: { code: 'INVALID_REQUEST' } });
    expect(await fixture.store.getStart(room.id)).toBeNull();
    expect((await fixture.store.getRoom(room.id))?.status).toBe('open');
  });

  it('rejects a callback that changes a human seat into a bot', async () => {
    const fixture = harness({
      freezeParticipants: async (room) =>
        room.members.map((member, index) => ({
          principalId: member.principalId,
          seatId: member.seatId,
          ...(index === 0 ? { controller: 'bot' as const } : {}),
        })),
    });
    const room = await fixture.readyRoom();

    await expect(
      fixture.coordinator.startRoom(
        'alice',
        room.id,
        room.revision,
        'profiles-controller-1',
      ),
    ).rejects.toMatchObject({ envelope: { code: 'INVALID_REQUEST' } });
    expect(await fixture.store.getStart(room.id)).toBeNull();
  });

  it('rejects oversized profile payloads before persisting the start', async () => {
    const fixture = harness({
      freezeParticipants: async (room) =>
        room.members.map((member) => ({
          principalId: member.principalId,
          seatId: member.seatId,
          publicProfile: { gameProfile: { blob: 'x'.repeat(17 * 1024) } },
        })),
    });
    const room = await fixture.readyRoom();

    await expect(
      fixture.coordinator.startRoom(
        'alice',
        room.id,
        room.revision,
        'profiles-4',
      ),
    ).rejects.toMatchObject({ envelope: { code: 'PAYLOAD_TOO_LARGE' } });
    expect(await fixture.store.getStart(room.id)).toBeNull();
  });
});
