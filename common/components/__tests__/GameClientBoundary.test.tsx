import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { GameClientBoundary } from '../src/GameClientBoundary.js';

afterEach(cleanup);

describe('GameClientBoundary', () => {
  it('contains render failures and explicit async/event failures', () => {
    function Throwing(): React.JSX.Element {
      throw new Error('render-failed');
    }
    render(
      <GameClientBoundary
        fallback={(error) => <output>{(error as Error).message}</output>}
      >
        {(reportError) => (
          <button onClick={() => reportError(new Error('event-failed'))}>
            fail
          </button>
        )}
      </GameClientBoundary>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'fail' }));
    expect(screen.getByText('event-failed')).toBeTruthy();

    cleanup();
    render(
      <GameClientBoundary
        fallback={(error) => <output>{(error as Error).message}</output>}
      >
        {() => <Throwing />}
      </GameClientBoundary>,
    );
    expect(screen.getByText('render-failed')).toBeTruthy();
  });
});
