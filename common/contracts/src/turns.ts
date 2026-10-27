import { contractError } from './errors.js';
import type { JsonValue } from './json.js';
import type { SchemaDescriptor } from './schema.js';
import type { CommandPrecondition, Participant } from './types.js';

/** A rule opportunity, independent of the person or program controlling a seat. */
export interface TurnInputOpportunity {
  readonly promptId: string;
  readonly participantInputRevision: number;
}

/** Games derive this from authoritative state; it may change within one mode. */
export interface TurnState {
  readonly id: string;
  readonly mode: 'sequential' | 'simultaneous';
  readonly activeSeatIds: readonly string[];
  /** Independent prompts are required for every active simultaneous seat. */
  readonly inputOpportunities?: Readonly<Record<string, TurnInputOpportunity>>;
}

/** Public attention metadata. Private prompt fences travel only in actionPrecondition. */
export type TurnView = Pick<TurnState, 'id' | 'mode' | 'activeSeatIds'>;

export interface AutomationControllerDescriptor {
  readonly id: string;
  /** Release-owned implementation version; useful for deterministic daily pins. */
  readonly version?: string;
  readonly kind: 'ai' | 'automa';
  readonly label: string;
  readonly optionsSchema?: SchemaDescriptor;
  readonly defaultOptions?: JsonValue;
  readonly presets?: readonly AutomationPreset[];
}

/** Safe, public diagnostic metadata for a terminal automated-seat failure. */
export interface AutomationFailure {
  readonly seatId: string;
  readonly messageKey: string;
}

/** Game-owned, named configurations shown by the shared room UI. */
export interface AutomationPreset {
  readonly id: string;
  readonly label: string;
  readonly options: JsonValue;
}

export function isAutomatedParticipant(
  participant: Pick<Participant, 'controller'>,
): boolean {
  return (
    participant.controller === 'ai' ||
    participant.controller === 'automa' ||
    participant.controller === 'bot'
  );
}

/** Automated seats and synthetic hotseat seats are not platform accounts. */
export function participantAccountId(
  participant: Pick<Participant, 'principalId' | 'controller' | 'controlledBy'>,
): string | undefined {
  if (isAutomatedParticipant(participant)) return undefined;
  return participant.controller === 'hotseat'
    ? participant.controlledBy
    : participant.principalId;
}

export function controlsParticipant(
  participant: Pick<Participant, 'principalId' | 'controller' | 'controlledBy'>,
  principalId: string,
): boolean {
  return participantAccountId(participant) === principalId;
}

/** Validate the rule hook before using it for authorization or scheduling. */
export function assertTurnState(
  value: unknown,
  participants?: readonly Pick<Participant, 'seatId'>[],
): asserts value is TurnState {
  const fail = (): never => {
    throw contractError('INVALID_REQUEST', 'contracts.turn.invalid');
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const turn = value as Partial<TurnState>;
  if (typeof turn.id !== 'string' || !turn.id || turn.id.length > 256) fail();
  if (turn.mode !== 'sequential' && turn.mode !== 'simultaneous') fail();
  if (!Array.isArray(turn.activeSeatIds)) fail();
  const seats = turn.activeSeatIds as readonly string[];
  if (seats.length > 64 || new Set(seats).size !== seats.length) fail();
  if (turn.mode === 'sequential' && seats.length > 1) fail();
  for (const seatId of seats) {
    if (typeof seatId !== 'string' || !seatId || seatId.length > 256) fail();
    if (participants && !participants.some((seat) => seat.seatId === seatId))
      fail();
  }
  if (turn.inputOpportunities !== undefined) {
    if (
      !turn.inputOpportunities ||
      typeof turn.inputOpportunities !== 'object' ||
      Array.isArray(turn.inputOpportunities)
    )
      fail();
    for (const [seatId, input] of Object.entries(turn.inputOpportunities)) {
      if (!seats.includes(seatId)) fail();
      if (
        !input ||
        typeof input.promptId !== 'string' ||
        !input.promptId ||
        input.promptId.length > 256 ||
        !Number.isSafeInteger(input.participantInputRevision) ||
        input.participantInputRevision < 0
      )
        fail();
    }
  }
  if (turn.mode === 'simultaneous')
    for (const seatId of seats)
      if (!Object.hasOwn(turn.inputOpportunities ?? {}, seatId)) fail();
}

/** A client hint; Host always revalidates it against the current rule state. */
export function turnPrecondition(
  turn: TurnState | null,
  seatId: string | undefined,
  revision: number,
): CommandPrecondition {
  const input = seatId ? turn?.inputOpportunities?.[seatId] : undefined;
  return turn?.mode === 'simultaneous' && input
    ? { kind: 'prompt', ...input }
    : { kind: 'revision', expectedRevision: revision };
}
