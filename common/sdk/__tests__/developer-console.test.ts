import { describe, expect, it } from 'vitest';
import { defineDeveloperConsole, type Transition } from '../src/index.js';

const inputSchema = {
  name: 'developer.input',
  version: 1,
  schema: { type: 'object' as const, additionalProperties: false },
};

function command(name: string) {
  return {
    name,
    label: name,
    inputSchema,
    execute: (
      state: Readonly<{ count: number }>,
    ): Transition<{ count: number }, { type: 'changed' }> => ({
      ok: true,
      state: { count: state.count + 1 },
      events: [{ type: 'changed' }],
    }),
  };
}

describe('defineDeveloperConsole', () => {
  it('freezes the catalog and retains mode eligibility', () => {
    const plugin = defineDeveloperConsole({
      commands: [command('boost')],
      isModeEnabled: (modeId) =>
        modeId === 'ranked'
          ? { enabled: false, reason: 'test.disabled' }
          : true,
    });
    expect(Object.isFrozen(plugin)).toBe(true);
    expect(Object.isFrozen(plugin.commands)).toBe(true);
    expect(plugin.commands[0]?.name).toBe('boost');
    expect(plugin.isModeEnabled?.('ranked')).toEqual({
      enabled: false,
      reason: 'test.disabled',
    });
  });

  it('rejects duplicate names and invalid metadata', () => {
    expect(() =>
      defineDeveloperConsole({
        commands: [command('boost'), command('boost')],
      }),
    ).toThrow(/duplicateCommand/);
    expect(() =>
      defineDeveloperConsole({
        commands: [{ ...command('bad name'), name: 'bad name' }],
      }),
    ).toThrow(/invalidCommand/);
    expect(() =>
      defineDeveloperConsole({
        commands: [
          {
            ...command('missing-executor'),
            execute: undefined as never,
          },
        ],
      }),
    ).toThrow(/invalidCommand/);
  });
});
