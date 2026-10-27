import { serveAutomationPolicy } from '../../dist/automation-worker.js';

serveAutomationPolicy((input) => {
  if (input.view === 'spin') {
    for (;;) {
      /* Deliberately exceeds the worker budget. */
    }
  }
  if (input.view === 'invalid') return undefined;
  if (input.view === 'diagnostics')
    return {
      kind: 'automation-decision',
      command: {
        type: 'choose',
        seatId: input.actor.seatId,
        value: input.view,
      },
      diagnostics: { nodes: 7 },
    };
  return { type: 'choose', seatId: input.actor.seatId, value: input.view };
});
