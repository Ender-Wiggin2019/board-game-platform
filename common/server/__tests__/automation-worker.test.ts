import type { AutomationDecisionInput } from '@board-game/sdk';
import { describe, expect, it } from 'vitest';
import { createWorkerAutomationPolicy } from '../src/index.js';

const input: AutomationDecisionInput = {
  view: { legal: ['pass'] },
  actor: {
    kind: 'player',
    principalId: 'robot',
    seatId: 'seat-2',
    controller: 'ai',
  },
  turn: { id: 'turn-1', mode: 'sequential', activeSeatIds: ['seat-2'] },
  seed: 'fixed',
  options: null,
};

function policy(timeoutMs = 2_000) {
  return createWorkerAutomationPolicy({
    id: 'worker',
    kind: 'ai',
    label: 'Worker AI',
    timeoutMs,
    workerUrl: new URL('./fixtures/automation-worker.mjs', import.meta.url),
  });
}

describe('isolated automation workers', () => {
  it('runs the public worker entry with only the supplied projection', async () => {
    await expect(
      policy().decide(input, new AbortController().signal),
    ).resolves.toEqual({
      type: 'choose',
      seatId: 'seat-2',
      value: { legal: ['pass'] },
    });
  });

  it('returns bounded private diagnostics alongside the command', async () => {
    await expect(
      policy().decide(
        { ...input, view: 'diagnostics' },
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      kind: 'automation-decision',
      command: {
        type: 'choose',
        seatId: 'seat-2',
        value: 'diagnostics',
      },
      diagnostics: { nodes: 7 },
    });
  });

  it('terminates CPU-bound work without blocking the host event loop', async () => {
    const start = Date.now();
    const promise = policy(100).decide(
      { ...input, view: 'spin' },
      new AbortController().signal,
    );
    let responsive = false;
    setTimeout(() => {
      responsive = true;
    }, 10);
    await expect(promise).rejects.toMatchObject({
      envelope: { messageKey: 'server.automation.timeout' },
    });
    expect(responsive).toBe(true);
    expect(Date.now() - start).toBeLessThan(2_000);
  });

  it('rejects aborted and invalid results', async () => {
    const signal = new AbortController();
    signal.abort();
    await expect(policy().decide(input, signal.signal)).rejects.toMatchObject({
      envelope: { messageKey: 'server.automation.aborted' },
    });
    await expect(
      policy().decide(
        { ...input, view: 'invalid' },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      envelope: { messageKey: 'server.automation.workerResult' },
    });
  });
});
