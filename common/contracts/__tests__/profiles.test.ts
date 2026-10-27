import { describe, expect, it } from 'vitest';
import { assertParticipant, assertPublicPlayerProfile } from '../src/index.js';

describe('trusted public player profile contracts', () => {
  it('accepts bounded display, appearance and game profile data', () => {
    expect(() =>
      assertParticipant({
        principalId: 'principal-1',
        seatId: 'seat-1',
        publicProfile: {
          displayName: 'Explorer',
          appearance: { color: 'amber', skin: 2 },
          gameProfile: { badge: 'scout' },
        },
      }),
    ).not.toThrow();
    expect(() =>
      assertParticipant({
        principalId: 'bot:room-1:1',
        seatId: 'bot:room-1:seat:1',
        controller: 'bot',
      }),
    ).not.toThrow();
  });

  it('rejects unknown profile fields and oversized game profile data', () => {
    expect(() =>
      assertPublicPlayerProfile({ displayName: 'Explorer', secret: true }),
    ).toThrowError(/invalidPublicProfile/);
    expect(() =>
      assertPublicPlayerProfile({
        gameProfile: { blob: 'x'.repeat(17 * 1024) },
      }),
    ).toThrowError(/payloadTooLarge/);
  });

  it('rejects control characters in display names', () => {
    expect(() =>
      assertPublicPlayerProfile({ displayName: 'Explorer\u0000' }),
    ).toThrowError(/invalidPublicProfile/);
  });

  it('rejects an unknown participant controller', () => {
    expect(() =>
      assertParticipant({
        principalId: 'principal-1',
        seatId: 'seat-1',
        controller: 'service',
      }),
    ).toThrowError(/invalidParticipant/);
  });
});
