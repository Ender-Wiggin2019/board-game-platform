import { describe, expect, it } from 'vitest';
import {
  canonicalStableStringify,
  type GameCatalogEntry,
} from '../src/index.js';

describe('public game catalog contracts', () => {
  it('is JSON-only and carries the pinned release and policy surface', () => {
    const entry: GameCatalogEntry = {
      metadata: {
        gameId: 'brass',
        name: 'Brass',
        description: 'Industrial strategy',
        themeId: 'brass-dark',
      },
      releaseId: 'brass-v1',
      capabilities: ['achievements', 'rewards', 'wallet', 'rating', 'rankings'],
      policyVersions: [
        { kind: 'rating', version: 'brass-rating-v1' },
        { kind: 'progression', version: 'brass-progression-v1' },
        { kind: 'achievement', version: 'brass-achievements-v1' },
        { kind: 'reward', version: 'brass-rewards-v1' },
      ],
      assets: [{ asset: 'coin', kind: 'currency' }],
    };

    expect(() => canonicalStableStringify(entry)).not.toThrow();
    expect(canonicalStableStringify(entry)).not.toContain('function');
  });
});
