import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { createContext, type ReactNode, useContext } from 'react';
import { useTranslation } from 'react-i18next';
import { afterEach, describe, expect, it } from 'vitest';
import { createDevelopmentGameProviders } from '../src/DevelopmentGameProviders.js';
import type { GameClientRegistration } from '../src/GameClientRegistration.js';

afterEach(cleanup);

const ProviderMarker = createContext('missing');

function registration(): GameClientRegistration {
  return {
    gameId: 'development-fixture',
    releaseId: 'development-fixture-v1',
    metadata: { nameKey: 'development-fixture.name' },
    locales: {
      en: { 'development-fixture': { greeting: 'Development ready' } },
      'zh-CN': { 'development-fixture': { greeting: '开发环境就绪' } },
    },
    providers: RegistrationProviders,
    theme: { dataTheme: 'development-fixture-theme' },
    setup: {
      default: () => ({}),
      getPlayerCount: () => 1,
      updatePlayerCount: (setup) => setup,
    },
    entry: { loadLive: async () => ({ default: () => null }) },
  };
}

function RegistrationProviders({
  children,
}: {
  readonly children: ReactNode;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const router = useRouter();
  const { t } = useTranslation('development-fixture');
  return (
    <ProviderMarker.Provider
      value={`${String(Boolean(queryClient))}:${router.state.location.pathname}:${t('greeting')}`}
    >
      {children}
    </ProviderMarker.Provider>
  );
}

function ProviderProbe(): React.JSX.Element {
  const queryClient = useQueryClient();
  const router = useRouter();
  const providerMarker = useContext(ProviderMarker);
  const { i18n, t } = useTranslation('development-fixture');
  return (
    <>
      <span data-testid='query-client'>{String(Boolean(queryClient))}</span>
      <span data-testid='router-path'>{router.state.location.pathname}</span>
      <span data-testid='registration-provider'>{providerMarker}</span>
      <span data-testid='greeting'>{t('greeting')}</span>
      <button type='button' onClick={() => void i18n.changeLanguage('zh-CN')}>
        Change language
      </button>
    </>
  );
}

describe('createDevelopmentGameProviders', () => {
  it('installs isolated query/router/i18n contexts around game providers', async () => {
    const Providers = await createDevelopmentGameProviders(registration());
    render(
      <Providers>
        <ProviderProbe />
      </Providers>,
    );

    expect(screen.getByTestId('query-client')).toHaveTextContent('true');
    expect(screen.getByTestId('router-path')).toHaveTextContent('/');
    expect(screen.getByTestId('registration-provider')).toHaveTextContent(
      'true:/:Development ready',
    );
    expect(screen.getByTestId('greeting')).toHaveTextContent(
      'Development ready',
    );
    expect(
      document.querySelector('[data-game="development-fixture"]'),
    ).toHaveAttribute('data-theme', 'development-fixture-theme');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Change language' }));
    });
    expect(screen.getByTestId('greeting')).toHaveTextContent('开发环境就绪');
  });
});
