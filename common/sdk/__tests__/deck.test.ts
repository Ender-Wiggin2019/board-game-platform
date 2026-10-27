import { describe, expect, it } from 'vitest';
import {
  assertDeck,
  cardsInPile,
  createDeck,
  drawCards,
  moveCards,
  shufflePile,
} from '../src/index.js';

const cards = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id, value: id }));

describe('durable card locations', () => {
  it('draws the remaining pile before recycling, preserving unique card ownership', () => {
    const initial = createDeck(cards, { pile: 'deck', seed: 39 });
    const prepared = moveCards(initial, ['b', 'c', 'd', 'e', 'f'], 'discard');
    const result = drawCards(prepared, {
      from: 'deck',
      to: 'hand:seat-1',
      count: 4,
      recycle: 'discard',
    });
    expect(result.cards[0].id).toBe('a');
    expect(result.cards).toHaveLength(4);
    expect(cardsInPile(result.deck, 'discard')).toEqual([]);
    expect(cardsInPile(result.deck, 'deck')).toHaveLength(2);
    expect(cardsInPile(result.deck, 'hand:seat-1')).toEqual(result.cards);
    expect(prepared.piles.deck).toEqual(['a']);
    assertDeck(result.deck);
  });

  it('continues with identical shuffle results after JSON recovery', () => {
    let deck = shufflePile(
      createDeck(cards, { pile: 'deck', seed: 7 }),
      'deck',
    );
    deck = moveCards(deck, deck.piles.deck, 'discard');
    const restored = JSON.parse(JSON.stringify(deck));
    assertDeck(restored);
    const options = {
      from: 'deck',
      to: 'hand:seat-2',
      count: 3,
      recycle: 'discard',
    };
    expect(drawCards(restored, options)).toEqual(drawCards(deck, options));
  });

  it('rejects invalid moves and duplicate locations without mutating any pile', () => {
    const deck = createDeck(cards, { pile: 'deck', seed: 1 });
    const before = JSON.stringify(deck);
    expect(() => moveCards(deck, ['a', 'missing'], 'hand')).toThrow(
      'DECK_INVALID_MOVE',
    );
    expect(() => moveCards(deck, ['a', 'a'], 'hand')).toThrow(
      'DECK_INVALID_MOVE',
    );
    expect(() =>
      drawCards(deck, { from: 'deck', to: 'deck', count: 1 }),
    ).toThrow('DECK_INVALID_DRAW');
    expect(() =>
      assertDeck({ ...deck, piles: { ...deck.piles, hand: ['a'] } }),
    ).toThrow('DECK_INVALID_STATE');
    expect(JSON.stringify(deck)).toBe(before);
  });

  it('rejects malformed recovered pile values before card readers use them', () => {
    const deck = createDeck(cards, { pile: 'deck', seed: 1 });
    const malformed = {
      ...deck,
      piles: { deck: 'a' },
    } as unknown as typeof deck;
    expect(() => assertDeck(malformed)).toThrow('DECK_INVALID_STATE');
  });

  it('supports top/bottom movement and returns only available cards on exhaustion', () => {
    const deck = createDeck(cards, { pile: 'deck', seed: 1 });
    const moved = moveCards(deck, ['e', 'f'], 'deck', 'top');
    expect(cardsInPile(moved, 'deck').map((card) => card.id)).toEqual([
      'e',
      'f',
      'a',
      'b',
      'c',
      'd',
    ]);
    const result = drawCards(moved, { from: 'deck', to: 'hand', count: 20 });
    expect(result.cards).toHaveLength(6);
    expect(result.deck.piles.deck).toEqual([]);
    expect(
      drawCards(result.deck, { from: 'deck', to: 'hand', count: 1 }).cards,
    ).toEqual([]);
    assertDeck(result.deck);
  });

  it('rejects invalid move positions and empty recycle pile names', () => {
    const deck = createDeck([{ id: 'a' }], { pile: 'deck', seed: 1 });
    expect(() => moveCards(deck, ['a'], 'hand', 'middle' as never)).toThrow(
      'DECK_INVALID_MOVE',
    );
    expect(() =>
      drawCards(deck, { from: 'deck', to: 'hand', count: 1, recycle: '' }),
    ).toThrow('DECK_INVALID_PILE');
  });
});
