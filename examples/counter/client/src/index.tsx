import { createElement } from 'react';
import { defineGameClient, defineGameComponent } from '@board-game/components';
import type { JsonValue } from '@board-game/contracts';
import { GAME_ID, DEFAULT_TARGET, type CounterCommand, type CounterQuery, type CounterReplayAnswer, type CounterSetup, type CounterView } from '@board-games/counter-common';

function isView(value: JsonValue | undefined): value is CounterView {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && typeof (value as { count?: unknown }).count === 'number';
}

const CounterLive = defineGameComponent<'live', CounterCommand, CounterQuery, CounterReplayAnswer, CounterView>({
  mode: 'live',
  session: {},
  render: ({ entry, session }) => {
    const view = session?.state.snapshot?.payload;
    const model = isView(view) ? view : undefined;
    const send = (command: CounterCommand) => {
      if (!session) return;
      void session.submitAction(crypto.randomUUID(), command).catch(() => undefined);
    };
    return createElement('section', { 'data-counter-status': model?.status ?? session?.state.status ?? 'loading' },
      createElement('h2', null, GAME_ID + ' / ' + (entry.mode === 'live' ? 'live' : entry.mode)),
      createElement('p', null, model ? ('Count ' + model.count + ' / ' + model.target) : 'Loading view…'),
      createElement('p', null, model ? ('Turn: ' + model.playerId) : ''),
      createElement('button', { type: 'button', disabled: !model?.canIncrement, onClick: () => send({ type: 'increment' }) }, 'Increment'),
      createElement('button', { type: 'button', disabled: !model?.canUndo, onClick: () => send({ type: 'undo' }) }, 'Undo'),
      createElement('button', { type: 'button', onClick: () => { if (session) void session.queryOptions({ type: 'replayManifest', eventLimit: 20 }).catch(() => undefined); } }, 'Query replay'),
      createElement('pre', null, session?.state.query ? JSON.stringify(session.state.query.answer, null, 2) : ''),
    );
  },
});

const CounterReplay = defineGameComponent<'replay', CounterCommand, CounterQuery, CounterReplayAnswer, CounterView>({
  mode: 'replay',
  render: () => createElement('p', null, 'Replay is available through the host query surface.'),
});

const CounterEnd = defineGameComponent<'end', CounterCommand, CounterQuery, CounterReplayAnswer, CounterView>({
  mode: 'end',
  render: () => createElement('p', null, 'Counter complete.'),
});

export const gameClient = defineGameClient({
  gameId: GAME_ID,
  releaseId: 'counter-development',
  metadata: { nameKey: 'counter.name', descriptionKey: 'counter.description' },
  capabilities: { directSolo: true, room: true, replay: true, sessionControls: true },
  setup: {
    default: (): CounterSetup => ({ target: DEFAULT_TARGET }),
    getPlayerCount: () => 1,
    updatePlayerCount: (setup: JsonValue) => setup,
  },
  entry: {
    loadLive: async () => ({ default: CounterLive }),
    loadReplay: async () => ({ default: CounterReplay }),
    loadEnd: async () => ({ default: CounterEnd }),
  },
});
