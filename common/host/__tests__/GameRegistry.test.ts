import { sequentialTurnFixture } from '@board-game/testing/fixtures';
import { describe, expect, it } from 'vitest';
import { GameRegistry } from '../src/GameRegistry.js';

describe('game registry rollback', () => {
  it('removes only the exact failed release', () => {
    const registry = new GameRegistry();
    const first = {
      ...sequentialTurnFixture,
      gameId: 'registry-game',
      releaseId: 'registry-v1',
    };
    const second = {
      ...sequentialTurnFixture,
      gameId: 'registry-game',
      releaseId: 'registry-v2',
    };
    registry.register(first).register(second);

    expect(registry.unregister('registry-game', 'registry-v1')).toBe(true);
    expect(() =>
      registry.resolve({
        gameId: 'registry-game',
        releaseId: 'registry-v1',
        modeId: 'sequential',
      }),
    ).toThrow();
    expect(() =>
      registry.resolve({
        gameId: 'registry-game',
        releaseId: 'registry-v2',
        modeId: 'sequential',
      }),
    ).not.toThrow();
    expect(registry.unregister('registry-game', 'registry-v1')).toBe(false);
  });
});
