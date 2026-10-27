import { describe, expect, it } from 'vitest';
import {
  GAME_NOTE_MAX_LENGTH,
  type IGameNoteResponse,
} from '../../../src/types/protocol/notes.js';
import type { IPlatformSessionPresencePayload } from '../../../src/types/protocol/presence.js';

describe('platform notes and presence contracts', () => {
  it('keeps notes bounded and presence seat-aware', () => {
    const note: IGameNoteResponse = {
      content: 'Remember this',
      updatedAt: null,
    };
    const presence: IPlatformSessionPresencePayload = {
      sessionId: 'session-1',
      sessionStatus: 'active',
      players: [{ principalId: 'user-1', seatId: 'seat-1', status: 'online' }],
    };
    expect(GAME_NOTE_MAX_LENGTH).toBe(20_000);
    expect(note.updatedAt).toBeNull();
    expect(presence.players[0]?.seatId).toBe('seat-1');
  });
});
