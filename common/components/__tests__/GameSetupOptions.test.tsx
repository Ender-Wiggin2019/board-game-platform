import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  defineGameClient,
  defineGameOptions,
  type GameSetupOption,
  GameSetupOptions,
} from '../src/index.js';

afterEach(cleanup);

const options: readonly GameSetupOption[] = [
  {
    type: 'boolean',
    key: 'undoEnabled',
    labelKey: 'Undo enabled',
    defaultValue: true,
  },
  {
    type: 'select',
    key: 'difficulty',
    labelKey: 'Difficulty',
    defaultValue: 'standard',
    options: [
      { value: 'standard', labelKey: 'Standard' },
      { value: 'expert', labelKey: 'Expert' },
    ],
  },
  {
    type: 'integer',
    key: 'turnTimeLimitMs',
    labelKey: 'Turn time limit',
    defaultValue: 30,
    min: 0,
    max: 120,
  },
];

describe('GameSetupOptions', () => {
  it('updates boolean, select, and integer options while preserving setup fields', () => {
    const onChange = vi.fn();
    render(
      <GameSetupOptions
        options={options}
        legendLabel='Room settings'
        setup={{
          undoEnabled: true,
          difficulty: 'standard',
          turnTimeLimitMs: 30,
          options: { legacy: true },
          unrelated: 'preserve-me',
        }}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole('switch', { name: 'Undo enabled' }));
    fireEvent.change(screen.getByLabelText('Difficulty'), {
      target: { value: 'expert' },
    });
    fireEvent.change(screen.getByLabelText('Turn time limit'), {
      target: { value: '60' },
    });

    expect(onChange).toHaveBeenNthCalledWith(1, {
      undoEnabled: false,
      difficulty: 'standard',
      turnTimeLimitMs: 30,
      options: { legacy: true },
      unrelated: 'preserve-me',
    });
    expect(onChange).toHaveBeenNthCalledWith(2, {
      undoEnabled: true,
      difficulty: 'expert',
      turnTimeLimitMs: 30,
      options: { legacy: true },
      unrelated: 'preserve-me',
    });
    expect(onChange).toHaveBeenNthCalledWith(3, {
      undoEnabled: true,
      difficulty: 'standard',
      turnTimeLimitMs: 60,
      options: { legacy: true },
      unrelated: 'preserve-me',
    });
    expect(screen.getByText('Room settings')).toBeTruthy();
  });

  it('rejects integer values outside the declared range', () => {
    const onChange = vi.fn();
    render(
      <GameSetupOptions
        options={options}
        setup={{
          undoEnabled: true,
          difficulty: 'standard',
          turnTimeLimitMs: 30,
        }}
        onChange={onChange}
      />,
    );

    fireEvent.change(screen.getByLabelText('Turn time limit'), {
      target: { value: '121' },
    });

    expect(onChange).not.toHaveBeenCalled();
  });

  it('renders read-only option values as text', () => {
    render(
      <GameSetupOptions
        options={options}
        setup={{
          undoEnabled: true,
          difficulty: 'expert',
          turnTimeLimitMs: 60,
        }}
        readOnly
        onChange={() => undefined}
      />,
    );

    expect(screen.getByText('Enabled')).toBeTruthy();
    expect(screen.getByText('Expert')).toBeTruthy();
    expect(screen.getByText('60')).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('spinbutton')).toBeNull();
  });

  it('locks controls while disabled', () => {
    const onChange = vi.fn();
    render(
      <GameSetupOptions
        options={options}
        setup={{
          undoEnabled: true,
          difficulty: 'standard',
          turnTimeLimitMs: 30,
        }}
        disabled
        onChange={onChange}
      />,
    );

    const toggle = screen.getByRole('switch', { name: 'Undo enabled' });
    expect(toggle.hasAttribute('disabled')).toBe(true);
    expect(screen.getByLabelText('Difficulty').hasAttribute('disabled')).toBe(
      true,
    );
    expect(
      screen.getByLabelText('Turn time limit').hasAttribute('disabled'),
    ).toBe(true);
    fireEvent.click(toggle);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('defineGameOptions', () => {
  it('provides defaults, safe updates, and validation for declared fields', () => {
    const definition = defineGameOptions(options);

    expect(definition.defaults).toEqual({
      undoEnabled: true,
      difficulty: 'standard',
      turnTimeLimitMs: 30,
    });
    expect(
      definition.update({ unrelated: 'preserve-me' }, 'difficulty', 'expert'),
    ).toEqual({ unrelated: 'preserve-me', difficulty: 'expert' });
    expect(definition.validate({ difficulty: 'expert' })).toBe(true);
    expect(definition.validate({ difficulty: 'unknown' })).toBe(false);
  });

  it('validates options attached to a game client definition', () => {
    expect(() =>
      defineGameClient({
        gameId: 'options-test',
        metadata: { nameKey: 'options-test.name' },
        setup: {
          default: () => ({}),
          options: [
            {
              type: 'integer',
              key: 'turnTimeLimitMs',
              labelKey: 'Turn time limit',
              defaultValue: 30,
              step: 0,
            },
          ],
          getPlayerCount: (_setup, fallback) => fallback,
          updatePlayerCount: (setup) => setup,
        },
        entry: { loadLive: async () => ({ default: () => null }) },
      }),
    ).toThrow('Invalid integer step');
  });

  it('validates integer steps', () => {
    const definition = defineGameOptions([
      {
        type: 'integer',
        key: 'limit',
        labelKey: 'Limit',
        defaultValue: 10,
        min: 0,
        step: 5,
      },
    ]);

    expect(definition.validate({ limit: 15 })).toBe(true);
    expect(definition.validate({ limit: 12 })).toBe(false);
    expect(() =>
      defineGameOptions([
        {
          type: 'integer',
          key: 'invalidStep',
          labelKey: 'Invalid step',
          defaultValue: 1,
          step: 0,
        },
      ]),
    ).toThrow('Invalid integer step');
  });
});
