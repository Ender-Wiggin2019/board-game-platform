import type { ParticipantController } from './types.js';

/** Public actions shared by game-session control panels. */
export type GameSessionControlAction =
  | 'abandonAgree'
  | 'abandonCancel'
  | 'timeoutRequest'
  | 'timeoutConfirm';

/** Timeout semantics are deliberately independent of a game's scoring rules. */
export type GameSessionTimeoutMode = 'end-game' | 'continue-game';

/** A game command used by the common session-control UI. */
export type GameSessionControlCommand =
  | {
      readonly type: 'sessionControl';
      readonly action: 'abandonAgree' | 'abandonCancel';
    }
  | {
      readonly type: 'sessionControl';
      readonly action: 'timeoutRequest' | 'timeoutConfirm';
      readonly windowId: string;
      readonly mode: GameSessionTimeoutMode;
    };

/** Safe participant data that a game may include in its control projection. */
export type GameSessionControlParticipant = {
  readonly principalId: string;
  readonly displayName: string | null;
  readonly controller: ParticipantController;
  readonly active: boolean;
};

export type GameSessionControlTimeoutWindow = {
  readonly id: string;
  readonly participantId: string;
  readonly startedAtMs: number;
  readonly dueAtMs: number;
  /** Changes whenever the participant receives a replacement window. */
  readonly generation: number;
  readonly kind: string | null;
};

export type GameSessionControlTimeoutVote = {
  readonly windowId: string;
  readonly targetWindowGeneration: number;
  readonly timedOutParticipantId: string;
  readonly triggeredByParticipantId: string;
  readonly verifiedAtMs: number;
  readonly confirmationStartedAtMsByParticipantId: Readonly<
    Record<string, number>
  >;
  readonly confirmationWindowGenerationByParticipantId: Readonly<
    Record<string, number>
  >;
  readonly eligibleParticipantIds: readonly string[];
  readonly acceptedParticipantIds: readonly string[];
  readonly mode: GameSessionTimeoutMode;
};

export type GameSessionControlTimeoutState = {
  readonly activeWindows: readonly GameSessionControlTimeoutWindow[];
  readonly timeoutVote: GameSessionControlTimeoutVote | null;
};

export type GameSessionControlAbandonProposal = {
  readonly eligibleParticipantIds: readonly string[];
  readonly excludedParticipantIds: readonly string[];
  readonly agreedParticipantIds: readonly string[];
  readonly createdAtMs: number;
};

/** Viewer-safe state consumed by shared game and room control components. */
export type GameSessionControlsView = {
  readonly participants: readonly GameSessionControlParticipant[];
  readonly timeout: GameSessionControlTimeoutState | null;
  readonly abandon: GameSessionControlAbandonProposal | null;
  readonly serverNowMs: number;
  readonly viewerId: string | null;
  readonly status: 'active' | 'cancelled' | 'completed';
  readonly confirmationDelayMs: number;
  readonly availableModes: readonly GameSessionTimeoutMode[];
};
