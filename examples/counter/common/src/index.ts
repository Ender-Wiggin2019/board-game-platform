export const GAME_ID = 'counter' as const;
export const DEFAULT_TARGET = 3;
export type CounterSetup = { readonly target?: number };
export type CounterCommand = { readonly type: 'increment' | 'undo' };
export type CounterQuery =
  | { readonly type: 'replayManifest'; readonly eventLimit: number }
  | { readonly type: 'replayFrames'; readonly from: number; readonly limit: number };
export type CounterView = {
  readonly count: number;
  readonly target: number;
  readonly status: 'active' | 'completed';
  readonly playerId: string;
  readonly canIncrement: boolean;
  readonly canUndo: boolean;
};
export type CounterEvent = { readonly type: 'changed'; readonly count: number };
export type CounterReplayAnswer = {
  readonly kind: 'manifest';
  readonly releaseId: string;
  readonly limit: number;
  readonly frames: readonly { readonly revision: number; readonly count: number }[];
} | {
  readonly kind: 'frames';
  readonly releaseId: string;
  readonly from: number;
  readonly limit: number;
  readonly frames: readonly { readonly revision: number; readonly count: number }[];
};
