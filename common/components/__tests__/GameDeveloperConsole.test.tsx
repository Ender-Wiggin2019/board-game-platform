import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GameDeveloperConsole,
  type GameDeveloperConsoleLine,
} from '../src/index.js';

afterEach(cleanup);

const lines: readonly GameDeveloperConsoleLine[] = [
  { id: 1, text: 'ready', tone: 'info' },
  { id: 2, text: 'output', tone: 'output' },
  { id: 3, text: 'failure', tone: 'error' },
];

describe('GameDeveloperConsole', () => {
  it('renders the controlled log, target summary, and fill-only presets', () => {
    const onSubmit = vi.fn();
    render(
      <GameDeveloperConsole
        embedded
        lines={lines}
        targetSummary='game: fixture · target: auto'
        presets={[{ label: 'State', command: 'state' }]}
        presetsLabel='Quick commands'
        onSubmit={onSubmit}
      />,
    );

    expect(screen.getByTestId('dev-console')).toBeTruthy();
    expect(screen.getByText('ready')).toBeTruthy();
    expect(screen.getByText('game: fixture · target: auto')).toBeTruthy();

    const input = screen.getByTestId('dev-console-input');
    expect(screen.getByRole('group', { name: 'Quick commands' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'State: state' }));
    expect(input).toHaveProperty('value', 'state');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('recalls controlled command history and submits the trimmed command', () => {
    const onSubmit = vi.fn();
    render(
      <GameDeveloperConsole
        embedded
        lines={[]}
        history={['first', 'second']}
        onSubmit={onSubmit}
      />,
    );
    const input = screen.getByTestId('dev-console-input');

    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input).toHaveProperty('value', 'second');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input).toHaveProperty('value', 'first');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input).toHaveProperty('value', 'second');
    fireEvent.change(input, { target: { value: '  run now  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onSubmit).toHaveBeenCalledExactlyOnceWith('run now');
    expect(input).toHaveProperty('value', '');
  });

  it('keeps raw input during an async submission and clears it on success', async () => {
    let resolve: (value?: void | boolean) => void = () => undefined;
    const onSubmit = vi.fn(
      () =>
        new Promise<void | boolean>((done) => {
          resolve = done;
        }),
    );
    render(<GameDeveloperConsole embedded lines={[]} onSubmit={onSubmit} />);
    const input = screen.getByTestId('dev-console-input');
    const panel = screen.getByTestId('dev-console');

    fireEvent.change(input, { target: { value: 'rollback 0' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onSubmit).toHaveBeenCalledExactlyOnceWith('rollback 0');
    expect(input).toHaveProperty('value', 'rollback 0');
    expect(panel.getAttribute('aria-busy')).toBe('true');

    resolve();
    await waitFor(() => expect(input).toHaveProperty('value', ''));
    expect(panel.getAttribute('aria-busy')).toBe('false');
  });

  it('retains raw input after a rejected submission', async () => {
    const onSubmit = vi.fn(async () => {
      throw new Error('network failure');
    });
    render(<GameDeveloperConsole embedded lines={[]} onSubmit={onSubmit} />);
    const input = screen.getByTestId('dev-console-input');

    fireEvent.change(input, { target: { value: 'list games' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledExactlyOnceWith('list games'),
    );
    expect(input).toHaveProperty('value', 'list games');
    expect(screen.getByTestId('dev-console').getAttribute('aria-busy')).toBe(
      'false',
    );
  });

  it('closes on Escape only for the non-embedded shell', () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <GameDeveloperConsole lines={[]} onClose={onClose} onSubmit={vi.fn()} />,
    );
    fireEvent.keyDown(screen.getByTestId('dev-console-input'), {
      key: 'Escape',
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(
      <GameDeveloperConsole
        embedded
        lines={[]}
        onClose={onClose}
        onSubmit={vi.fn()}
      />,
    );
    fireEvent.keyDown(screen.getByTestId('dev-console-input'), {
      key: 'Escape',
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
