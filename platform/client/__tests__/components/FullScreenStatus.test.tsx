import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FullScreenStatus } from '@/components/FullScreenStatus';
import i18n from '@/i18n';

describe('FullScreenStatus loading copy', () => {
  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    await i18n.changeLanguage('en');
  });

  it('selects different messages on separate loads, including the final option', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    const firstLoad = render(<FullScreenStatus />);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Preparing the table…',
    );
    firstLoad.unmount();

    random.mockReturnValue(0.9999);
    render(<FullScreenStatus />);
    expect(screen.getByRole('status')).toHaveAccessibleName(
      'Preparing your view…',
    );
  });

  it('keeps the selected message across rerenders and translates it when language changes', async () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    const view = render(<FullScreenStatus />);
    random.mockReturnValue(0.9999);
    view.rerender(<FullScreenStatus />);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Preparing the table…',
    );

    await act(async () => {
      await i18n.changeLanguage('zh-CN');
    });
    expect(screen.getByRole('status')).toHaveTextContent(
      '正在准备游戏桌…',
    );
  });

  it('preserves failure copy and chooses a new message when loading resumes', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    const view = render(<FullScreenStatus />);
    view.rerender(<FullScreenStatus state='error' label='Connection failed' />);
    expect(screen.getByRole('alert')).toHaveAccessibleName('Connection failed');
    expect(
      screen.queryByText('Preparing the table…'),
    ).not.toBeInTheDocument();

    random.mockReturnValue(0.9999);
    view.rerender(<FullScreenStatus />);
    expect(screen.getByRole('status')).toHaveAccessibleName(
      'Preparing your view…',
    );
  });
});
