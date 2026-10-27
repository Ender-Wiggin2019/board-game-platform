import { describe, expect, it } from 'vitest';
import { assertGameResult } from '../src/results.js';

const participants = [
  { principalId: 'alice', seatId: 'a' },
  { principalId: 'bob', seatId: 'b' },
  { principalId: 'carol', seatId: 'c' },
];

describe('authoritative result validation', () => {
  it('accepts complete tied standings and public cooperative outcomes', () => {
    expect(() =>
      assertGameResult(
        {
          kind: 'competitive',
          rankGroups: [
            {
              teams: [
                { participantIds: ['alice'], score: 9 },
                { participantIds: ['carol'], score: 9 },
              ],
            },
            { teams: [{ participantIds: ['bob'], score: 4 }] },
          ],
        },
        participants,
      ),
    ).not.toThrow();
    expect(() =>
      assertGameResult(
        {
          kind: 'cooperative',
          participantIds: ['alice', 'bob', 'carol'],
          outcome: 'won',
        },
        participants,
      ),
    ).not.toThrow();
  });

  it.each([
    {
      kind: 'competitive',
      rankGroups: [{ teams: [{ participantIds: ['alice'] }] }],
    },
    {
      kind: 'competitive',
      rankGroups: [
        {
          teams: [
            { participantIds: ['alice', 'bob'] },
            { participantIds: ['carol'] },
          ],
        },
      ],
    },
    {
      kind: 'cooperative',
      participantIds: ['alice', 'alice', 'carol'],
      outcome: 'won',
    },
    {
      kind: 'cooperative',
      participantIds: ['alice', 'bob', 'outsider'],
      outcome: 'won',
    },
    { kind: 'solo', participantIds: ['alice', 'bob', 'carol'], outcome: 'won' },
    { kind: 'progress', participantIds: ['alice', 'bob', 'carol'] },
    {
      kind: 'cooperative',
      participantIds: ['alice', 'bob', 'carol'],
      outcome: 'won',
      privateHand: ['secret'],
    },
  ])(
    'rejects missing, duplicate, foreign, invented-team and extra private fields',
    (result) => {
      expect(() => assertGameResult(result, participants)).toThrow(
        'platform.result.invalid',
      );
    },
  );

  it('preserves frozen team membership and supports private-content-free solo progress', () => {
    const teams = participants.map((participant) => ({
      ...participant,
      teamId: participant.principalId === 'carol' ? 'two' : 'one',
    }));
    expect(() =>
      assertGameResult(
        {
          kind: 'competitive',
          rankGroups: [
            { teams: [{ participantIds: ['alice', 'bob'] }] },
            { teams: [{ participantIds: ['carol'] }] },
          ],
        },
        teams,
      ),
    ).not.toThrow();
    expect(() =>
      assertGameResult(
        {
          kind: 'competitive',
          rankGroups: [
            {
              teams: [
                { participantIds: ['alice'] },
                { participantIds: ['bob'] },
                { participantIds: ['carol'] },
              ],
            },
          ],
        },
        teams,
      ),
    ).toThrow();
    expect(() =>
      assertGameResult(
        {
          kind: 'progress',
          participantIds: ['alice'],
          progress: { completed: 2 },
        },
        [participants[0]],
      ),
    ).not.toThrow();
  });
});
