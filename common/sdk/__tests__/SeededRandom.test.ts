import { describe, expect, it } from 'vitest';
import { SeededRandom } from '../src/SeededRandom.js';

describe('SeededRandom', () => {
  it('preserves the historical sequence for a fixed seed', () => {
    const random = new SeededRandom('historical-seed');

    expect(Array.from({ length: 6 }, () => random.next())).toStrictEqual([
      0.4259531006682664, 0.6589786321856081, 0.6868380564264953,
      0.7468459685333073, 0.250452546402812, 0.3409507761243731,
    ]);
    expect(random.getState()).toBe(1464372433);
  });

  it('generates the same sequence for the same seed', () => {
    const randomA = new SeededRandom('same-seed');
    const randomB = new SeededRandom('same-seed');

    const sequenceA = Array.from({ length: 6 }, () => randomA.next());
    const sequenceB = Array.from({ length: 6 }, () => randomB.next());

    expect(sequenceA).toStrictEqual(sequenceB);
  });

  it('generates different sequences for different seeds', () => {
    const randomA = new SeededRandom('seed-a');
    const randomB = new SeededRandom('seed-b');

    const sequenceA = Array.from({ length: 6 }, () => randomA.next());
    const sequenceB = Array.from({ length: 6 }, () => randomB.next());

    expect(sequenceA).not.toStrictEqual(sequenceB);
  });

  it('shuffles deterministically with the same seed', () => {
    const source = [1, 2, 3, 4, 5, 6, 7];
    const randomA = new SeededRandom('shuffle-seed');
    const randomB = new SeededRandom('shuffle-seed');

    const shuffledA = randomA.shuffle(source);
    const shuffledB = randomB.shuffle(source);

    expect(shuffledA).toStrictEqual(shuffledB);
    expect(shuffledA).not.toStrictEqual(source);
  });
});
