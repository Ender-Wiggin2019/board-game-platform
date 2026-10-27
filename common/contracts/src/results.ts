import { contractError } from './errors.js';
import { assertJsonPayloadSize, type JsonValue } from './json.js';
import type { Participant } from './types.js';

export type ResultTeam = {
  readonly participantIds: readonly string[];
  readonly score?: number;
};

/** Groups are ordered best first. Teams in one group are tied. */
export type CompetitiveResult = {
  readonly kind: 'competitive';
  readonly rankGroups: readonly { readonly teams: readonly ResultTeam[] }[];
};

export type GameResult =
  | CompetitiveResult
  | {
      readonly kind: 'cooperative' | 'solo';
      readonly participantIds: readonly string[];
      readonly outcome: 'won' | 'lost' | 'completed';
      readonly score?: number;
    }
  | {
      readonly kind: 'progress';
      readonly participantIds: readonly string[];
      /** A reviewed public summary; puzzle solutions and private state are forbidden. */
      readonly progress: JsonValue;
    };

export function assertGameResult(
  value: unknown,
  participants: readonly Participant[],
): asserts value is GameResult {
  assertJsonPayloadSize(value, 256 * 1024);
  if (!value || Array.isArray(value) || typeof value !== 'object') invalid();
  const result = value as unknown as Record<string, unknown>;
  let ids: unknown[] = [];
  const keys = (
    object: Record<string, unknown>,
    allowed: readonly string[],
  ) => {
    if (Object.keys(object).some((key) => !allowed.includes(key))) invalid();
  };
  if (result.kind === 'competitive') {
    keys(result, ['kind', 'rankGroups']);
    if (!Array.isArray(result.rankGroups) || result.rankGroups.length === 0)
      invalid();
    for (const group of result.rankGroups) {
      if (!group || typeof group !== 'object' || Array.isArray(group))
        invalid();
      keys(group, ['teams']);
      if (!Array.isArray(group.teams) || group.teams.length === 0) invalid();
      for (const team of group.teams) {
        if (!team || typeof team !== 'object' || Array.isArray(team)) invalid();
        keys(team, ['participantIds', 'score']);
        if (
          !Array.isArray(team.participantIds) ||
          team.participantIds.length === 0
        )
          invalid();
        if (
          team.score !== undefined &&
          (typeof team.score !== 'number' || !Number.isFinite(team.score))
        )
          invalid();
        ids.push(...team.participantIds);
        const frozenTeams = participants.filter((participant) =>
          team.participantIds.includes(participant.principalId),
        );
        const teamIds = new Set(
          frozenTeams.map((participant) => participant.teamId),
        );
        if (
          teamIds.size !== 1 ||
          (team.participantIds.length > 1 && !frozenTeams[0]?.teamId)
        )
          invalid();
        const frozenTeamId = frozenTeams[0]?.teamId;
        if (
          frozenTeamId &&
          participants.some(
            (participant) =>
              participant.teamId === frozenTeamId &&
              !team.participantIds.includes(participant.principalId),
          )
        )
          invalid();
      }
    }
  } else if (
    result.kind === 'cooperative' ||
    result.kind === 'solo' ||
    result.kind === 'progress'
  ) {
    keys(
      result,
      result.kind === 'progress'
        ? ['kind', 'participantIds', 'progress']
        : ['kind', 'participantIds', 'outcome', 'score'],
    );
    if (
      !Array.isArray(result.participantIds) ||
      result.participantIds.length === 0
    )
      invalid();
    ids = result.participantIds;
    if (result.kind === 'solo' && ids.length !== 1) invalid();
    if (result.kind === 'progress') {
      if (!Object.hasOwn(result, 'progress')) invalid();
    } else {
      if (!['won', 'lost', 'completed'].includes(result.outcome as string))
        invalid();
      if (
        result.score !== undefined &&
        (typeof result.score !== 'number' || !Number.isFinite(result.score))
      )
        invalid();
    }
  } else invalid();
  if (
    ids.some((id) => typeof id !== 'string') ||
    new Set(ids).size !== ids.length ||
    ids.length !== participants.length ||
    participants.some((participant) => !ids.includes(participant.principalId))
  )
    invalid();
}

function invalid(): never {
  throw contractError('INVALID_REQUEST', 'platform.result.invalid');
}
