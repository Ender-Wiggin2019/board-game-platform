import type { PlayerViewEnvelope } from '@board-game/contracts';
import { describe, expect, it } from 'vitest';
import {
  createActionIntent,
  resolveActionPrecondition,
} from '../src/ClientSessionStore.js';

const snapshot: Pick<PlayerViewEnvelope, 'revision' | 'actionPrecondition'> = {
  revision: 7,
  actionPrecondition: {
    kind: 'prompt',
    promptId: 'prompt-1',
    participantInputRevision: 2,
  },
};

describe('client action preconditions', () => {
  it('prefers the public action fence over the snapshot revision', () => {
    expect(resolveActionPrecondition(snapshot)).toEqual(
      snapshot.actionPrecondition,
    );
    expect(createActionIntent(snapshot, 'command-1', { type: 'play' })).toEqual(
      {
        commandId: 'command-1',
        command: { type: 'play' },
        precondition: snapshot.actionPrecondition,
      },
    );
  });

  it('keeps an explicit revision for management commands', () => {
    expect(
      resolveActionPrecondition(snapshot, {
        kind: 'revision',
        expectedRevision: 9,
      }),
    ).toEqual({ kind: 'revision', expectedRevision: 9 });
  });
});
