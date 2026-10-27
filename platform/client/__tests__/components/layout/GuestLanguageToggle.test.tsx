import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GuestLanguageToggle } from '@/components/layout/GuestLanguageToggle';
import i18n from '@/i18n';

describe('GuestLanguageToggle', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh-CN');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await i18n.changeLanguage('en');
  });

  it('names each language in its own script and marks the current one', () => {
    render(<GuestLanguageToggle />);

    const chinese = screen.getByRole('button', { name: '中文' });
    const english = screen.getByRole('button', { name: 'English' });
    expect(chinese).toHaveAttribute('aria-pressed', 'true');
    expect(chinese).toHaveAttribute('lang', 'zh-CN');
    expect(english).toHaveAttribute('aria-pressed', 'false');
    expect(english).toHaveAttribute('lang', 'en');
  });

  it('switches the interface and remembers the visitor choice on this device', async () => {
    render(<GuestLanguageToggle />);

    fireEvent.click(screen.getByRole('button', { name: 'English' }));

    await waitFor(() => expect(i18n.language).toBe('en'));
    expect(screen.getByRole('button', { name: 'English' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(window.localStorage.getItem('seti-ui-language')).toBe('en');
  });

  it('shows the requested language as selected while it loads', async () => {
    let finishEnglishLoad!: () => void;
    const englishLoad = new Promise<void>((resolve) => {
      finishEnglishLoad = resolve;
    });
    const originalChangeLanguage = i18n.changeLanguage.bind(i18n);
    vi.spyOn(i18n, 'changeLanguage').mockImplementation((language, callback) =>
      language === 'en'
        ? (englishLoad.then(() =>
            originalChangeLanguage(language, callback),
          ) as ReturnType<typeof i18n.changeLanguage>)
        : originalChangeLanguage(language, callback),
    );
    render(<GuestLanguageToggle />);

    fireEvent.click(screen.getByRole('button', { name: 'English' }));

    expect(i18n.language).toBe('zh-CN');
    expect(screen.getByRole('button', { name: 'English' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: '中文' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    await act(async () => {
      finishEnglishLoad();
      await englishLoad;
    });
    await waitFor(() => expect(i18n.language).toBe('en'));
  });
});
