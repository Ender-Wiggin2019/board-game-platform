/** JSON data belongs in the game state and is committed by the Host. */
export interface DeckState<Card extends { readonly id: string }> {
  readonly cards: readonly Card[];
  /** Index zero is the top of each pile. Hands use game-defined pile names. */
  readonly piles: Readonly<Record<string, readonly string[]>>;
  readonly randomState: number;
}

export interface DeckDraw<Card extends { readonly id: string }> {
  readonly deck: DeckState<Card>;
  readonly cards: readonly Card[];
}

function pileName(name: string): void {
  if (!name || ['__proto__', 'constructor', 'prototype'].includes(name))
    throw new Error('DECK_INVALID_PILE');
}

function isCardRecord(value: unknown): value is { readonly id: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    value.id.length > 0
  );
}

function isPileRecord(
  value: unknown,
): value is Readonly<Record<string, readonly string[]>> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(
      (pile) =>
        Array.isArray(pile) &&
        pile.every((id) => typeof id === 'string' && id.length > 0),
    )
  );
}

/** Stable Fisher–Yates with game-owned entropy; never uses Math.random. */
export function shuffleWithRandom<T>(
  values: readonly T[],
  next: () => number,
): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index--) {
    const random = next();
    if (!Number.isFinite(random) || random < 0 || random >= 1)
      throw new Error('DECK_INVALID_RANDOM');
    const swap = Math.floor(random * (index + 1));
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}

export function createDeck<Card extends { readonly id: string }>(
  cards: readonly Card[],
  options: { readonly pile: string; readonly seed: number },
): DeckState<Card> {
  pileName(options.pile);
  if (!Number.isSafeInteger(options.seed)) throw new Error('DECK_INVALID_SEED');
  if (
    cards.some((card) => !card.id) ||
    new Set(cards.map((c) => c.id)).size !== cards.length
  )
    throw new Error('DECK_DUPLICATE_CARD');
  return {
    cards: [...cards],
    piles: { [options.pile]: cards.map((card) => card.id) },
    randomState: options.seed >>> 0 || 1,
  };
}

/** Validate recovered state before rules can move or expose a card. */
export function assertDeck<Card extends { readonly id: string }>(
  deck: DeckState<Card>,
): void {
  const raw = deck as unknown as {
    readonly cards?: unknown;
    readonly piles?: unknown;
    readonly randomState?: unknown;
  };
  if (
    !Array.isArray(raw.cards) ||
    !raw.cards.every(isCardRecord) ||
    !isPileRecord(raw.piles) ||
    typeof raw.randomState !== 'number'
  )
    throw new Error('DECK_INVALID_STATE');
  const cards = raw.cards as unknown as readonly Card[];
  const piles = raw.piles;
  const ids = new Set(cards.map((card) => card.id));
  const located = Object.values(piles).flat();
  if (
    ids.size !== cards.length ||
    located.length !== ids.size ||
    new Set(located).size !== ids.size ||
    located.some((id) => !ids.has(id)) ||
    !Number.isInteger(raw.randomState) ||
    raw.randomState < 1 ||
    raw.randomState > 0xffff_ffff
  )
    throw new Error('DECK_INVALID_STATE');
  for (const name of Object.keys(piles)) pileName(name);
}

export function cardsInPile<Card extends { readonly id: string }>(
  deck: DeckState<Card>,
  pile: string,
): readonly Card[] {
  pileName(pile);
  const byId = new Map(deck.cards.map((card) => [card.id, card]));
  return (deck.piles[pile] ?? []).map((id) => {
    const card = byId.get(id);
    if (!card) throw new Error('DECK_UNKNOWN_CARD');
    return card;
  });
}

/** Atomic, immutable move; the input remains unchanged on invalid IDs. */
export function moveCards<Card extends { readonly id: string }>(
  deck: DeckState<Card>,
  ids: readonly string[],
  destination: string,
  position: 'top' | 'bottom' = 'bottom',
): DeckState<Card> {
  pileName(destination);
  if (position !== 'top' && position !== 'bottom')
    throw new Error('DECK_INVALID_MOVE');
  const selected = new Set(ids);
  const located = new Set(Object.values(deck.piles).flat());
  if (selected.size !== ids.length || ids.some((id) => !located.has(id)))
    throw new Error('DECK_INVALID_MOVE');
  const piles = Object.fromEntries(
    Object.entries(deck.piles).map(([name, cards]) => [
      name,
      cards.filter((id) => !selected.has(id)),
    ]),
  );
  const target = piles[destination] ?? [];
  piles[destination] =
    position === 'top' ? [...ids, ...target] : [...target, ...ids];
  return { ...deck, piles };
}

export function shufflePile<Card extends { readonly id: string }>(
  deck: DeckState<Card>,
  pile: string,
): DeckState<Card> {
  pileName(pile);
  let randomState = deck.randomState;
  const ids = shuffleWithRandom(deck.piles[pile] ?? [], () => {
    let value = randomState;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    randomState = value >>> 0;
    return randomState / 0x1_0000_0000;
  });
  return { ...deck, randomState, piles: { ...deck.piles, [pile]: ids } };
}

/**
 * Draw up to count cards, optionally recycling a discard pile once exhausted.
 * The game decides whether recycling is legal and which audiences see cards.
 * Never return the complete DeckState from a player projection.
 */
export function drawCards<Card extends { readonly id: string }>(
  deck: DeckState<Card>,
  options: {
    readonly from: string;
    readonly to: string;
    readonly count: number;
    readonly recycle?: string;
  },
): DeckDraw<Card> {
  for (const pile of [
    options.from,
    options.to,
    ...(options.recycle !== undefined ? [options.recycle] : []),
  ])
    pileName(pile);
  if (
    !Number.isSafeInteger(options.count) ||
    options.count < 0 ||
    options.from === options.to ||
    options.recycle === options.from ||
    options.recycle === options.to
  )
    throw new Error('DECK_INVALID_DRAW');
  let next = deck;
  const drawn: Card[] = [];
  while (drawn.length < options.count) {
    if (!next.piles[options.from]?.length) {
      const discard =
        options.recycle !== undefined ? next.piles[options.recycle] : undefined;
      if (!discard?.length) break;
      next = shufflePile(moveCards(next, discard, options.from), options.from);
    }
    const cards = cardsInPile(next, options.from).slice(
      0,
      options.count - drawn.length,
    );
    next = moveCards(
      next,
      cards.map((card) => card.id),
      options.to,
    );
    drawn.push(...cards);
  }
  return { deck: next, cards: drawn };
}
