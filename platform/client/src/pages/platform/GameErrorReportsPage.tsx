import type { TPlatformFeedbackKind } from '@board-platform/contracts';
import { PlatformOperationsPage } from './PlatformOperationsPage.js';

/** Game-scoped report queue; evidence and diagnostics stay in platform UI. */
export function GameErrorReportsPage({
  gameId,
  kind = 'game',
}: {
  readonly gameId: string;
  readonly kind?: TPlatformFeedbackKind;
}): React.JSX.Element {
  return <PlatformOperationsPage gameId={gameId} kind={kind} />;
}

/** Game-scoped AI/automa report queue with private trace diagnostics. */
export function GameAiErrorReportsPage({
  gameId,
}: {
  readonly gameId: string;
}): React.JSX.Element {
  return <GameErrorReportsPage gameId={gameId} kind='ai' />;
}
