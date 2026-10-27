import type {
  Actor,
  JsonValue,
  RuleError,
  Transition,
  Viewer,
} from '@board-game/sdk';

export interface FixtureParticipant {
  readonly principalId: string;
  readonly seatId: string;
}

export interface FixtureStateParticipants {
  readonly participants: readonly FixtureParticipant[];
}

export function participantsFromActors(
  actors: readonly Actor[],
): readonly FixtureParticipant[] {
  return actors
    .filter((actor) => actor.kind === 'player')
    .map((actor, index) => ({
      principalId: actor.principalId,
      seatId: actor.seatId ?? `seat-${index + 1}`,
    }));
}

export function actorForParticipant(
  actor: Actor,
  participants: readonly FixtureParticipant[],
): FixtureParticipant | undefined {
  if (actor.kind !== 'player' || !actor.seatId) return undefined;
  return participants.find(
    (participant) =>
      participant.seatId === actor.seatId &&
      participant.principalId === actor.principalId,
  );
}

export function viewerSeat(viewer: Viewer): string | undefined {
  return viewer.seatId;
}

export function reject(
  code: string,
  messageKey = `fixture.${code.toLowerCase()}`,
): { ok: false; error: RuleError } {
  return { ok: false, error: { code, messageKey } };
}

export function accepted<S, Event>(
  state: S,
  ...events: readonly Event[]
): Transition<S, Event> {
  return { ok: true, state, events };
}

export function jsonRecord(values: Record<string, JsonValue>): JsonValue {
  return values;
}

export function participantViews(
  participants: readonly FixtureParticipant[],
  viewer: Viewer,
): readonly { seatId: string; isYou: boolean }[] {
  return participants.map((participant) => ({
    seatId: participant.seatId,
    isYou: participant.seatId === viewer.seatId,
  }));
}
