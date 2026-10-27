import { test } from 'node:test';
import assert from 'node:assert/strict';
import { server } from '../server/dist/index.js';

test('counter supports setup, increment, undo, query and completion', () => {
  const player = { kind: 'player', principalId: 'player1', seatId: 'seat-1' };
  const state = server.module.rules.create({ target: 2 }, {
    sessionId: 'fixture-session', modeId: 'solo', seed: 'fixture-seed', participants: [player],
  });
  const first = server.module.rules.execute(state, { type: 'increment' }, { actor: player, logicalTime: 1 });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const undone = server.module.rules.execute(first.state, { type: 'undo' }, { actor: player, logicalTime: 2 });
  assert.equal(undone.ok, true);
  if (!undone.ok) return;
  const query = server.module.rules.query?.(undone.state, { type: 'replayManifest', eventLimit: 20 }, { principalId: player.principalId, audience: 'player', epoch: 'fixture' });
  assert.equal(query?.kind, 'manifest');
  let completed = undone.state;
  for (let index = 0; index < 2; index += 1) {
    const transition = server.module.rules.execute(completed, { type: 'increment' }, { actor: player, logicalTime: index + 3 });
    assert.equal(transition.ok, true);
    if (!transition.ok) return;
    completed = transition.state;
  }
  assert.deepEqual(server.module.completion(completed), { finished: true });
  assert.equal(server.module.result?.(completed).kind, 'solo');
});
