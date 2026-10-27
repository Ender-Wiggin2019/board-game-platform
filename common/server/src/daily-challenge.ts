import type {
  DailyChallengeParticipantContext,
  DailyChallengePrepared,
  DailyChallengeScore,
  GameResult,
  GameServiceDailyChallengeDescription,
  JsonValue,
  MatchAdmission,
  Participant,
} from '@board-game/contracts';

/** Game-owned implementation behind the authenticated daily service RPC. */
export interface GameDailyChallengeService {
  readonly description: GameServiceDailyChallengeDescription;
  readonly validateSettings: (settings: JsonValue) => void | Promise<void>;
  readonly publicSettings: (
    settings: JsonValue,
  ) => JsonValue | Promise<JsonValue>;
  readonly prepare: (
    challengeDate: string,
    settings: JsonValue,
  ) => DailyChallengePrepared | Promise<DailyChallengePrepared>;
  readonly validateSetup: (setup: JsonValue) => void | Promise<void>;
  readonly participants: (
    context: DailyChallengeParticipantContext,
  ) => readonly Participant[] | Promise<readonly Participant[]>;
  readonly score: (
    result: GameResult,
    admission: MatchAdmission,
  ) => DailyChallengeScore | null | Promise<DailyChallengeScore | null>;
}
