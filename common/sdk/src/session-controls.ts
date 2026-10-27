import {
  EErrorCode,
  type GameSessionControlAbandonProposal,
  type GameSessionControlTimeoutState,
  type GameSessionControlTimeoutVote,
  type GameSessionControlTimeoutWindow,
  type GameSessionTimeoutMode,
  type ParticipantController,
} from '@board-game/contracts';
import { GameError } from './GameError.js';

export const DEFAULT_TIMEOUT_CONFIRMATION_DELAY_MS = 20_000;

export type TimeoutMode = GameSessionTimeoutMode;
export type TimeoutWindow = GameSessionControlTimeoutWindow;
export type TimeoutVote = GameSessionControlTimeoutVote;
export type TimeoutState = Omit<
  GameSessionControlTimeoutState,
  'timeoutVote'
> & {
  readonly timeoutVote?: TimeoutVote | null;
};
export type AbandonProposal = GameSessionControlAbandonProposal;

export type SessionControlParticipant = {
  readonly principalId: string;
  readonly controller?: ParticipantController;
  readonly active?: boolean;
};

export interface AgreeToAbandonInput {
  readonly existing?: AbandonProposal;
  readonly actorId: string;
  readonly participants: readonly SessionControlParticipant[];
  /** Applied only when creating the first proposal. */
  readonly excludedParticipantIds?: readonly string[];
  readonly nowMs: number;
}

export interface AbandonVoteResult {
  readonly proposal: AbandonProposal;
  readonly unanimous: boolean;
}

export interface TimeoutActionInput {
  readonly state: TimeoutState;
  readonly actorId: string;
  readonly windowId: string;
  readonly mode: TimeoutMode;
  readonly nowMs: number;
  readonly participants: readonly SessionControlParticipant[];
  readonly confirmationDelayMs?: number;
}

export type TimeoutResult =
  | {
      readonly state: TimeoutState;
      readonly status: 'pending';
    }
  | {
      readonly state: TimeoutState;
      readonly status: 'resolved';
      readonly timedOutParticipantId: string;
      readonly mode: TimeoutMode;
    };

/**
 * Start or continue an all-human abandon proposal. The first call snapshots
 * eligibility; later calls intentionally ignore the current roster.
 */
export function agreeToAbandonProposal(
  input: AgreeToAbandonInput,
): AbandonVoteResult {
  assertTimestamp(input.nowMs, 'nowMs');
  if (input.existing !== undefined) {
    const existing = cloneAbandonProposal(input.existing);
    assertAbandonEligibility(existing, input.actorId);
    const proposal: AbandonProposal = {
      ...existing,
      agreedParticipantIds: existing.agreedParticipantIds.includes(
        input.actorId,
      )
        ? [...existing.agreedParticipantIds]
        : [...existing.agreedParticipantIds, input.actorId],
    };
    return {
      proposal,
      unanimous: isAbandonUnanimous(proposal),
    };
  }

  const participants = normalizeParticipants(input.participants);
  if (participants.length === 0)
    invalidAction('An abandon proposal requires participants');

  const participantIds = participants.map(({ principalId }) => principalId);
  const explicitExcluded = new Set(input.excludedParticipantIds ?? []);
  for (const participantId of explicitExcluded) {
    if (!participantIds.includes(participantId))
      invalidAction('Abandon exclusion is not a participant', {
        participantId,
      });
  }

  const eligibleParticipantIds = participants
    .filter(
      (participant) =>
        participant.active !== false &&
        participant.controller !== 'bot' &&
        !explicitExcluded.has(participant.principalId),
    )
    .map(({ principalId }) => principalId);
  if (eligibleParticipantIds.length === 0)
    invalidAction('An abandon proposal requires an eligible participant');

  const excludedParticipantIds = participantIds.filter(
    (participantId) => !eligibleParticipantIds.includes(participantId),
  );
  if (!eligibleParticipantIds.includes(input.actorId))
    assertAbandonEligibility(
      {
        eligibleParticipantIds,
        excludedParticipantIds,
        agreedParticipantIds: [],
        createdAtMs: input.nowMs,
      },
      input.actorId,
    );

  const proposal: AbandonProposal = {
    eligibleParticipantIds,
    excludedParticipantIds,
    agreedParticipantIds: [input.actorId],
    createdAtMs: input.nowMs,
  };
  return { proposal, unanimous: isAbandonUnanimous(proposal) };
}

export function assertAbandonEligibility(
  proposal: AbandonProposal,
  actorId: string,
): void {
  assertValidAbandonProposal(proposal);
  if (!proposal.eligibleParticipantIds.includes(actorId))
    invalidAction(
      'Participant is not eligible to decide this abandon proposal',
      {
        participantId: actorId,
      },
    );
}

export function assertAbandonCanBeCancelled(proposal: AbandonProposal): void {
  if (isAbandonUnanimous(proposal))
    invalidAction('A unanimous abandon proposal can no longer be cancelled');
}

/** Validate and clear a proposal; the caller owns the surrounding state. */
export function cancelAbandonProposal(
  proposal: AbandonProposal | undefined | null,
  actorId: string,
): undefined {
  if (proposal === undefined || proposal === null) return undefined;
  assertAbandonEligibility(proposal, actorId);
  assertAbandonCanBeCancelled(proposal);
  return undefined;
}

export function isAbandonUnanimous(proposal: AbandonProposal): boolean {
  assertValidAbandonProposal(proposal);
  return proposal.eligibleParticipantIds.every((participantId) =>
    proposal.agreedParticipantIds.includes(participantId),
  );
}

/**
 * Reconcile a game's current timer windows with the previous control state.
 * A replaced target invalidates the whole vote; a replaced voter must confirm
 * again. A voter window disappearing does not erase an existing confirmation.
 */
export function syncTimeoutWindows(
  state: TimeoutState,
  activeWindows: readonly TimeoutWindow[],
): TimeoutState {
  const previousWindows = normalizeWindows(state.activeWindows);
  const nextWindows = normalizeWindows(activeWindows);
  const vote = state.timeoutVote
    ? cloneTimeoutVote(state.timeoutVote)
    : undefined;
  if (!vote)
    return {
      activeWindows: nextWindows,
    };

  const target = nextWindows.find((window) => window.id === vote.windowId);
  if (
    !target ||
    target.generation !== vote.targetWindowGeneration ||
    target.participantId !== vote.timedOutParticipantId
  ) {
    return { activeWindows: nextWindows };
  }

  const acceptedParticipantIds = [...vote.acceptedParticipantIds];
  const confirmationStartedAtMsByParticipantId = {
    ...vote.confirmationStartedAtMsByParticipantId,
  };
  const confirmationWindowGenerationByParticipantId = {
    ...vote.confirmationWindowGenerationByParticipantId,
  };
  for (const participantId of vote.eligibleParticipantIds) {
    const previous = previousWindows.find(
      (window) => window.participantId === participantId,
    );
    const current = nextWindows.find(
      (window) => window.participantId === participantId,
    );
    const renewed =
      current !== undefined &&
      (previous === undefined ||
        previous.id !== current.id ||
        previous.generation !== current.generation ||
        (vote.confirmationWindowGenerationByParticipantId[participantId] !==
          undefined &&
          vote.confirmationWindowGenerationByParticipantId[participantId] !==
            current.generation));
    if (renewed) {
      delete confirmationStartedAtMsByParticipantId[participantId];
      delete confirmationWindowGenerationByParticipantId[participantId];
      const acceptedIndex = acceptedParticipantIds.indexOf(participantId);
      if (acceptedIndex >= 0) acceptedParticipantIds.splice(acceptedIndex, 1);
    }
  }

  return {
    activeWindows: nextWindows,
    timeoutVote: {
      ...vote,
      acceptedParticipantIds,
      confirmationStartedAtMsByParticipantId,
      confirmationWindowGenerationByParticipantId,
    },
  };
}

/** Replace one participant's current window and advance its generation. */
export function renewTimeoutWindow(
  state: TimeoutState,
  window: Omit<TimeoutWindow, 'generation'> & { readonly generation?: number },
): TimeoutState {
  const previous = state.activeWindows.find(
    (candidate) => candidate.participantId === window.participantId,
  );
  const generation = Math.max(
    window.generation ?? 0,
    previous === undefined ? 0 : previous.generation + 1,
  );
  const nextWindow: TimeoutWindow = { ...window, generation };
  return syncTimeoutWindows(state, [
    ...state.activeWindows.filter(
      (candidate) => candidate.participantId !== window.participantId,
    ),
    nextWindow,
  ]);
}

export function verifyTimeout(input: TimeoutActionInput): TimeoutResult {
  const state = syncTimeoutWindows(input.state, input.state.activeWindows);
  const target = findWindow(state, input.windowId);
  assertTimestamp(input.nowMs, 'nowMs');
  assertConfirmationDelay(input.confirmationDelayMs);
  if (input.nowMs <= target.dueAtMs)
    invalidAction('Timer has not expired', {
      windowId: input.windowId,
      dueAtMs: target.dueAtMs,
    });

  let vote = state.timeoutVote;
  if (vote !== undefined && vote !== null) {
    if (vote.mode !== input.mode)
      invalidAction('Timeout removal mode does not match the active vote', {
        windowId: input.windowId,
      });
    if (vote.windowId !== input.windowId)
      invalidAction('Another timeout removal is already active', {
        activeWindowId: vote.windowId,
        windowId: input.windowId,
      });
    assertCurrentTimeoutVoter(
      state,
      input.participants,
      target,
      input.mode,
      input.actorId,
      input.nowMs,
      input.windowId,
    );
    vote = reconcileContinueVote(state, vote, input);
    assertTimeoutVoter(vote, input.actorId, input.windowId);
    return {
      status: 'pending',
      state: {
        activeWindows: state.activeWindows,
        timeoutVote: startConfirmation(vote, state, input.actorId, input.nowMs),
      },
    };
  }

  const eligibleParticipantIds = getEligibleTimeoutVoters(
    state,
    input.participants,
    target,
    input.mode,
    input.nowMs,
  );
  if (!eligibleParticipantIds.includes(input.actorId))
    invalidAction(
      'Participant is not eligible to remove this timed-out participant',
      {
        windowId: input.windowId,
        participantId: input.actorId,
      },
    );

  const voterWindow = state.activeWindows.find(
    (window) => window.participantId === input.actorId,
  );
  const newVote: TimeoutVote = {
    windowId: target.id,
    targetWindowGeneration: target.generation,
    timedOutParticipantId: target.participantId,
    triggeredByParticipantId: input.actorId,
    verifiedAtMs: input.nowMs,
    confirmationStartedAtMsByParticipantId: {},
    confirmationWindowGenerationByParticipantId: {},
    eligibleParticipantIds,
    acceptedParticipantIds: [],
    mode: input.mode,
  };
  return {
    status: 'pending',
    state: {
      activeWindows: state.activeWindows,
      timeoutVote: startConfirmation(
        newVote,
        state,
        input.actorId,
        input.nowMs,
        voterWindow,
      ),
    },
  };
}

export function confirmTimeout(input: TimeoutActionInput): TimeoutResult {
  const state = syncTimeoutWindows(input.state, input.state.activeWindows);
  const target = findWindow(state, input.windowId);
  assertTimestamp(input.nowMs, 'nowMs');
  const confirmationDelayMs = assertConfirmationDelay(
    input.confirmationDelayMs,
  );
  if (input.nowMs <= target.dueAtMs)
    invalidAction('Timer has not expired', { windowId: input.windowId });
  const currentVote = state.timeoutVote;
  if (!currentVote || currentVote.windowId !== input.windowId)
    invalidAction('Timeout vote not found', { windowId: input.windowId });
  if (currentVote.mode !== input.mode)
    invalidAction('Timeout removal mode does not match the active vote', {
      windowId: input.windowId,
    });
  assertCurrentTimeoutVoter(
    state,
    input.participants,
    target,
    input.mode,
    input.actorId,
    input.nowMs,
    input.windowId,
  );
  const vote = reconcileContinueVote(state, currentVote, input);
  assertTimeoutVoter(vote, input.actorId, input.windowId);
  if (input.actorId === vote.timedOutParticipantId)
    invalidAction('Timed-out participant cannot accept their own removal', {
      windowId: input.windowId,
    });
  const startedAtMs =
    vote.confirmationStartedAtMsByParticipantId[input.actorId];
  if (startedAtMs === undefined)
    invalidAction('Timeout confirmation has not started for this participant', {
      windowId: input.windowId,
      participantId: input.actorId,
    });
  if (input.nowMs - startedAtMs < confirmationDelayMs)
    invalidAction('Timeout confirmation is not available yet', {
      windowId: input.windowId,
      waitMs: confirmationDelayMs - (input.nowMs - startedAtMs),
    });

  const acceptedParticipantIds = vote.acceptedParticipantIds.includes(
    input.actorId,
  )
    ? [...vote.acceptedParticipantIds]
    : [...vote.acceptedParticipantIds, input.actorId];
  const nextVote: TimeoutVote = {
    ...vote,
    acceptedParticipantIds,
  };
  const resolved =
    input.mode === 'end-game' ||
    nextVote.eligibleParticipantIds.every((participantId) =>
      nextVote.acceptedParticipantIds.includes(participantId),
    );
  if (resolved) {
    return {
      status: 'resolved',
      state: { activeWindows: state.activeWindows },
      timedOutParticipantId: target.participantId,
      mode: input.mode,
    };
  }
  return {
    status: 'pending',
    state: { activeWindows: state.activeWindows, timeoutVote: nextVote },
  };
}

function reconcileContinueVote(
  state: TimeoutState,
  vote: TimeoutVote,
  input: TimeoutActionInput,
): TimeoutVote {
  if (vote.mode !== 'continue-game') return cloneTimeoutVote(vote);
  const target = findWindow(state, vote.windowId);
  const eligibleParticipantIds = getEligibleTimeoutVoters(
    state,
    input.participants,
    target,
    vote.mode,
    input.nowMs,
  );
  const eligible = new Set(eligibleParticipantIds);
  const acceptedParticipantIds = vote.acceptedParticipantIds.filter((id) =>
    eligible.has(id),
  );
  const confirmationStartedAtMsByParticipantId = Object.fromEntries(
    Object.entries(vote.confirmationStartedAtMsByParticipantId).filter(([id]) =>
      eligible.has(id),
    ),
  );
  const confirmationWindowGenerationByParticipantId = Object.fromEntries(
    Object.entries(vote.confirmationWindowGenerationByParticipantId).filter(
      ([id]) => eligible.has(id),
    ),
  );
  return {
    ...vote,
    eligibleParticipantIds,
    acceptedParticipantIds,
    confirmationStartedAtMsByParticipantId,
    confirmationWindowGenerationByParticipantId,
  };
}

function startConfirmation(
  vote: TimeoutVote,
  state: TimeoutState,
  actorId: string,
  nowMs: number,
  voterWindow = state.activeWindows.find(
    (window) => window.participantId === actorId,
  ),
): TimeoutVote {
  return {
    ...vote,
    confirmationStartedAtMsByParticipantId: {
      ...vote.confirmationStartedAtMsByParticipantId,
      [actorId]: vote.confirmationStartedAtMsByParticipantId[actorId] ?? nowMs,
    },
    confirmationWindowGenerationByParticipantId: {
      ...vote.confirmationWindowGenerationByParticipantId,
      ...(voterWindow
        ? {
            [actorId]: voterWindow.generation,
          }
        : {}),
    },
  };
}

function assertTimeoutVoter(
  vote: TimeoutVote,
  actorId: string,
  windowId: string,
): void {
  if (!vote.eligibleParticipantIds.includes(actorId))
    invalidAction(
      'Participant is not eligible to remove this timed-out participant',
      {
        windowId,
        participantId: actorId,
      },
    );
}

function assertCurrentTimeoutVoter(
  state: TimeoutState,
  participants: readonly SessionControlParticipant[],
  target: TimeoutWindow,
  mode: TimeoutMode,
  actorId: string,
  nowMs: number,
  windowId: string,
): void {
  if (
    !getEligibleTimeoutVoters(
      state,
      participants,
      target,
      mode,
      nowMs,
    ).includes(actorId)
  )
    invalidAction(
      'Participant is no longer eligible to remove this timed-out participant',
      {
        windowId,
        participantId: actorId,
      },
    );
}

function getEligibleTimeoutVoters(
  state: TimeoutState,
  participants: readonly SessionControlParticipant[],
  target: TimeoutWindow,
  mode: TimeoutMode,
  nowMs: number,
): string[] {
  const byParticipant = new Map(
    state.activeWindows.map((window) => [window.participantId, window]),
  );
  return normalizeParticipants(participants)
    .filter(
      (participant) =>
        participant.principalId !== target.participantId &&
        participant.active !== false &&
        participant.controller !== 'bot' &&
        (mode !== 'continue-game' ||
          !isExpired(byParticipant.get(participant.principalId), nowMs)),
    )
    .map(({ principalId }) => principalId);
}

function isExpired(window: TimeoutWindow | undefined, nowMs: number): boolean {
  return window !== undefined && nowMs > window.dueAtMs;
}

function findWindow(state: TimeoutState, windowId: string): TimeoutWindow {
  const window = state.activeWindows.find(
    (candidate) => candidate.id === windowId,
  );
  if (!window) invalidAction('Timer window not found', { windowId });
  return window;
}

function normalizeParticipants(
  participants: readonly SessionControlParticipant[],
): SessionControlParticipant[] {
  const ids = new Set<string>();
  return participants.map((participant) => {
    if (!participant || typeof participant.principalId !== 'string')
      validationError('Participant principalId is invalid');
    if (ids.has(participant.principalId))
      validationError('Participant principalId is duplicated', {
        participantId: participant.principalId,
      });
    ids.add(participant.principalId);
    return { ...participant };
  });
}

function normalizeWindows(windows: readonly TimeoutWindow[]): TimeoutWindow[] {
  const ids = new Set<string>();
  const participants = new Set<string>();
  return windows.map((window) => {
    if (ids.has(window.id))
      validationError('Timer window id is duplicated', { windowId: window.id });
    if (participants.has(window.participantId))
      validationError('A participant can have only one active timer window', {
        participantId: window.participantId,
      });
    ids.add(window.id);
    participants.add(window.participantId);
    if (!Number.isSafeInteger(window.generation) || window.generation < 0)
      validationError('Timer window generation is invalid', {
        windowId: window.id,
      });
    if (
      !Number.isFinite(window.startedAtMs) ||
      !Number.isFinite(window.dueAtMs)
    )
      validationError('Timer window timestamps are invalid', {
        windowId: window.id,
      });
    if (window.dueAtMs < window.startedAtMs)
      validationError('Timer window dueAtMs precedes startedAtMs', {
        windowId: window.id,
      });
    return { ...window };
  });
}

function cloneTimeoutVote(vote: TimeoutVote): TimeoutVote {
  return {
    ...vote,
    confirmationStartedAtMsByParticipantId: {
      ...vote.confirmationStartedAtMsByParticipantId,
    },
    confirmationWindowGenerationByParticipantId: {
      ...vote.confirmationWindowGenerationByParticipantId,
    },
    eligibleParticipantIds: [...vote.eligibleParticipantIds],
    acceptedParticipantIds: [...vote.acceptedParticipantIds],
  };
}

function cloneAbandonProposal(proposal: AbandonProposal): AbandonProposal {
  assertValidAbandonProposal(proposal);
  return {
    ...proposal,
    eligibleParticipantIds: [...proposal.eligibleParticipantIds],
    excludedParticipantIds: [...proposal.excludedParticipantIds],
    agreedParticipantIds: [...proposal.agreedParticipantIds],
  };
}

function assertValidAbandonProposal(proposal: AbandonProposal): void {
  assertUniqueIds(proposal.eligibleParticipantIds, 'eligibleParticipantIds');
  assertUniqueIds(proposal.excludedParticipantIds, 'excludedParticipantIds');
  assertUniqueIds(proposal.agreedParticipantIds, 'agreedParticipantIds');
  if (proposal.eligibleParticipantIds.length === 0)
    validationError('Abandon proposal has no eligible participants');
  const eligible = new Set(proposal.eligibleParticipantIds);
  if (proposal.excludedParticipantIds.some((id) => eligible.has(id)))
    validationError('Abandon proposal eligibility overlaps exclusions');
  if (proposal.agreedParticipantIds.some((id) => !eligible.has(id)))
    validationError('Abandon proposal agreement is not eligible');
  assertTimestamp(proposal.createdAtMs, 'createdAtMs');
}

function assertUniqueIds(ids: readonly string[], field: string): void {
  if (ids.some((id) => typeof id !== 'string' || id.length === 0))
    validationError(`${field} contains an invalid participant id`);
  if (new Set(ids).size !== ids.length)
    validationError(`${field} contains duplicate participant ids`);
}

function assertTimestamp(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0)
    validationError(`${field} must be a non-negative finite number`);
}

function assertConfirmationDelay(value: number | undefined): number {
  const delay = value ?? DEFAULT_TIMEOUT_CONFIRMATION_DELAY_MS;
  if (!Number.isFinite(delay) || delay < 0)
    validationError('confirmationDelayMs must be a non-negative finite number');
  return delay;
}

function invalidAction(
  message: string,
  details?: Record<string, unknown>,
): never {
  throw new GameError(EErrorCode.INVALID_ACTION, message, details);
}

function validationError(
  message: string,
  details?: Record<string, unknown>,
): never {
  throw new GameError(EErrorCode.VALIDATION_ERROR, message, details);
}
