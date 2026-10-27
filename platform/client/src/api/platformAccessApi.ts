import type {
  GameAccessCatalogEntry,
  GameAccessCodeIssue,
  GameAccessCodeSummary,
  GameAccessGrantSummary,
} from '@board-platform/contracts';
import { httpClient } from './httpClient.js';

const path = (gameId: string) =>
  `/platform/game-access/${encodeURIComponent(gameId)}`;
export const platformAccessApi = {
  async catalog(): Promise<readonly GameAccessCatalogEntry[]> {
    return (
      await httpClient.get<readonly GameAccessCatalogEntry[]>(
        '/platform/game-access/catalog',
      )
    ).data;
  },
  async grants(gameId: string): Promise<readonly GameAccessGrantSummary[]> {
    return (
      await httpClient.get<readonly GameAccessGrantSummary[]>(
        `${path(gameId)}/grants`,
      )
    ).data;
  },
  async redeem(gameId: string, code: string): Promise<GameAccessGrantSummary> {
    return (
      await httpClient.post<GameAccessGrantSummary>(`${path(gameId)}/redeem`, {
        code,
      })
    ).data;
  },
  async codes(gameId: string): Promise<readonly GameAccessCodeSummary[]> {
    return (
      await httpClient.get<readonly GameAccessCodeSummary[]>(
        `${path(gameId)}/codes`,
      )
    ).data;
  },
  async issue(
    gameId: string,
    input: {
      readonly entitlement: string;
      readonly maxUses?: number;
      readonly expiresAt?: string;
    },
  ): Promise<GameAccessCodeIssue> {
    return (
      await httpClient.post<GameAccessCodeIssue>(`${path(gameId)}/codes`, input)
    ).data;
  },
  async revoke(gameId: string, codeId: string): Promise<void> {
    await httpClient.post(
      `${path(gameId)}/codes/${encodeURIComponent(codeId)}/revoke`,
      {},
    );
  },
};
