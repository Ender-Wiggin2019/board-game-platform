import type { ClientSessionTransport } from '@board-game/client';
import { GameClientBoundary } from '@board-game/components';
import type { JsonValue, SessionRoute } from '@board-game/contracts';
import { can, ECapability } from '@board-platform/contracts/auth/permissions';
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query';
import {
  createRootRoute,
  createRoute,
  createRouter,
  Navigate,
  Outlet,
  RouterProvider,
  useParams,
  useRouterState,
  useSearch,
} from '@tanstack/react-router';
import {
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { I18nextProvider, useTranslation } from 'react-i18next';
import { DeferredToaster } from './components/DeferredToaster.js';
import { FullScreenStatus } from './components/FullScreenStatus.js';
import { AppShell } from './components/layout/AppShell.js';
import { ShellBadgesProvider } from './components/layout/ShellBadges.js';
import { PlatformLoadingStatus } from './components/PlatformLoadingStatus.js';
import { PlatformSessionResult } from './components/PlatformSessionResult.js';
import { RequestRecoveryStatus } from './components/RequestRecoveryStatus.js';
import { RouteErrorPage } from './components/RouteErrorPage.js';
import { ServerUpdateDialogLoader } from './components/ServerUpdateDialogLoader.js';
import { GameClientProviders } from './GameClientProviders.js';
import type {
  ApplicationGlobalsScope,
  GameClientRegistration,
  GameLiveEntryProps,
  GameSeatHandoffLabels,
  LazyComponent,
} from './GameClientRegistration.js';
import type { GameClientRegistry } from './gameClientRegistry.js';
import { useCurrentUser } from './hooks/useAuth.js';
import { effectiveAuthRole, usePermissions } from './hooks/usePermissions.js';
import i18n from './i18n.js';
import { subscribeQueryRecovery } from './lib/queryRecovery.js';
import { safeReturnTo } from './lib/returnNavigation.js';
import {
  createPlatformReplayTransport,
  type PlatformRouteDescriptor,
  probePlatformReplayRoute,
  probePlatformRoute,
} from './PlatformSessionTransport.js';
import { configurePlatformGameClientRegistry } from './platform/gameClientRegistry.js';
import { useResolvedGameClient } from './platform/useGameClient.js';
import { AccountQueryCacheBoundary } from './providers/AccountQueryCacheBoundary.js';
import { AuthSessionBootstrap } from './providers/AuthSessionBootstrap.js';
import { PlatformAccountEffects } from './providers/PlatformAccountEffects.js';
import { usePlatformConfiguration } from './providers/PlatformConfiguration.js';
import { PlatformNotificationEffects } from './providers/PlatformNotificationEffects.js';
import { PlatformNotificationOwnershipProvider } from './providers/PlatformNotificationOwnership.js';
import { PlatformSocketLifecycle } from './providers/PlatformSocketLifecycle.js';
import { SessionTerminationListener } from './providers/SessionTerminationListener.js';
import {
  createBrowserPlatformRuntime,
  type GameEntryRuntime,
  withPlatformConnectionMode,
} from './runtime.js';
import { useAuthStore } from './stores/authStore.js';

const AccessPage = lazy(() =>
  import('./pages/platform/PlatformAccessPage.js').then((module) => ({
    default: module.PlatformAccessPage,
  })),
);

const SessionChat = lazy(() =>
  import('./features/chat/PlatformSessionChat.js').then((module) => ({
    default: module.PlatformSessionChat,
  })),
);

const FeedbackPage = lazy(() =>
  import('./pages/platform/PlatformFeedbackPage.js').then((module) => ({
    default: module.PlatformFeedbackPage,
  })),
);
const OperationsPage = lazy(() =>
  import('./pages/platform/PlatformOperationsPage.js').then((module) => ({
    default: module.PlatformOperationsPage,
  })),
);
const AdministrationPage = lazy(() =>
  import('./pages/admin/PlatformAdministrationPage.js').then((module) => ({
    default: module.PlatformAdministrationPage,
  })),
);
const PerformancePage = lazy(() =>
  import('./pages/admin/PlatformPerformancePage.js').then((module) => ({
    default: module.PlatformPerformancePage,
  })),
);

const AccountPage = lazy(() =>
  import('./pages/account/AccountPage.js').then((module) => ({
    default: module.AccountPage,
  })),
);
const AuthPage = lazy(() =>
  import('./pages/auth/AuthPage.js').then((module) => ({
    default: module.AuthPage,
  })),
);
const PasswordResetPage = lazy(() =>
  import('./pages/auth/PasswordResetPage.js').then((module) => ({
    default: module.PasswordResetPage,
  })),
);
const ActivationPage = lazy(() =>
  import('./pages/activation/ActivationPage.js').then((module) => ({
    default: module.ActivationPage,
  })),
);
const HomePage = lazy(() =>
  import('./pages/platform/GameHomePage.js').then((module) => ({
    default: module.GameHomePage,
  })),
);
const Workspace = lazy(() =>
  import('./pages/platform/GameWorkspace.js').then((module) => ({
    default: module.GameWorkspace,
  })),
);
const SessionsPage = lazy(() =>
  import('./pages/platform/PlatformSessionsPage.js').then((module) => ({
    default: module.PlatformSessionsPage,
  })),
);
const RoomPage = lazy(() =>
  import('./pages/platform/PlatformRoomPage.js').then((module) => ({
    default: module.PlatformRoomPage,
  })),
);
export interface PlatformAppProps {
  readonly registry: GameClientRegistry;
  readonly runtime?: GameEntryRuntime;
}

function Loading({ children }: { children: ReactNode }): React.JSX.Element {
  return <Suspense fallback={<PlatformLoadingStatus />}>{children}</Suspense>;
}

function matchGameRoute(registry: GameClientRegistry, pathname: string) {
  return registry
    .list()
    .flatMap((game) =>
      (game.legacyRoutes ?? []).map((route) => ({ game, route })),
    )
    .filter(
      ({ route }) =>
        pathname === route.pathPrefix ||
        pathname.startsWith(`${route.pathPrefix}/`),
    )
    .sort(
      (left, right) =>
        right.route.pathPrefix.length - left.route.pathPrefix.length,
    )[0];
}

function RootLayout({
  registry,
  runtime,
}: {
  registry: GameClientRegistry;
  runtime: GameEntryRuntime;
}): React.JSX.Element {
  const authenticated = useAuthStore((state) => state.isAuthenticated);
  const expired = useAuthStore((state) => state.sessionExpired);
  const epoch = useAuthStore((state) => state.authEpoch);
  const user = useAuthStore((state) => state.user);
  const currentUser = useCurrentUser();
  const location = useRouterState({ select: (state) => state.location });
  const pathname = location.pathname;
  const isAuth = pathname === '/auth';
  const gameRouteAccess = matchGameRoute(registry, pathname)?.route.access;
  const publicRoute =
    pathname.startsWith('/auth') || gameRouteAccess === 'public';
  const search = location.search as Record<string, unknown>;
  const returnTo =
    safeReturnTo(search.returnTo) ??
    (isAuth
      ? registry
          .list()
          .map((game) =>
            safeReturnTo(game.account?.resolveSignInReturnTo?.(search)),
          )
          .find(Boolean)
      : undefined);
  if ((!authenticated || expired) && !publicRoute) {
    return (
      <Navigate
        to='/auth'
        search={{ returnTo: safeReturnTo(location.href) }}
        replace
      />
    );
  }
  if (authenticated && !currentUser.data && !publicRoute) {
    return (
      <RequestRecoveryStatus
        key={`profile:${epoch}`}
        error={currentUser.error}
        isRetrying={currentUser.isFetching}
        onRetry={() => currentUser.refetch()}
        retryTestId='current-user-retry'
      />
    );
  }
  const canPlay = can(effectiveAuthRole(user), ECapability.GAME_PLAY);
  if (authenticated && isAuth) {
    return <Navigate to={canPlay ? (returnTo ?? '/') : '/activate'} replace />;
  }
  if (
    authenticated &&
    !canPlay &&
    !publicRoute &&
    !['/activate', '/account'].includes(pathname) &&
    gameRouteAccess !== 'authenticated'
  ) {
    return (
      <Navigate
        to='/activate'
        search={{ returnTo: safeReturnTo(location.href) }}
        replace
      />
    );
  }
  if (authenticated && canPlay && pathname === '/activate')
    return <Navigate to={returnTo ?? '/'} replace />;
  return (
    <>
      <PlatformAccountEffects />
      {registry.list().map((registration) => (
        <ApplicationGlobals
          key={registration.gameId}
          registration={registration}
          pathname={pathname}
          runtime={runtime}
          scope='root'
        />
      ))}
      <Outlet />
    </>
  );
}

function ApplicationGlobals({
  registration,
  pathname,
  runtime,
  scope,
}: {
  registration: GameClientRegistration;
  pathname: string;
  runtime: GameEntryRuntime;
  scope: ApplicationGlobalsScope;
}): React.JSX.Element | null {
  const shouldRender = shouldRenderApplicationGlobals(
    registration,
    pathname,
    scope,
  );
  const Globals = useMemo(
    () =>
      registration.applicationGlobals
        ? lazy(registration.applicationGlobals)
        : null,
    [registration.applicationGlobals],
  );
  if (!shouldRender || !Globals) return null;
  return (
    <Suspense fallback={null}>
      <Globals runtime={runtime} gameId={registration.gameId} scope={scope} />
    </Suspense>
  );
}

function shouldRenderApplicationGlobals(
  registration: GameClientRegistration,
  pathname: string,
  scope: ApplicationGlobalsScope,
): boolean {
  if (!registration.applicationGlobals) return false;
  if (scope === 'session') return true;
  const rootEligible =
    !isSessionRoutePath(pathname) &&
    (registration.applicationGlobalsWhen?.(pathname) ?? true);
  return scope === 'root' ? rootEligible : !rootEligible;
}

function isSessionRoutePath(pathname: string): boolean {
  return pathname === '/game' || pathname.startsWith('/game/');
}

function LegacyRoute({
  registry,
  runtime,
  pathname,
}: {
  registry: GameClientRegistry;
  runtime: GameEntryRuntime;
  pathname: string;
}): React.JSX.Element {
  const { t } = useTranslation('platform');
  const match = matchGameRoute(registry, pathname);
  const Entry = useMemo(
    () => (match?.route.load ? lazy(match.route.load) : null),
    [match?.route.load],
  );
  if (!match || !Entry)
    return (
      <FullScreenStatus
        state='error'
        label={t('route.unavailable', {
          defaultValue: 'This page is unavailable.',
        })}
      />
    );
  return (
    <>
      <ApplicationGlobals
        registration={match.game}
        pathname={pathname}
        runtime={runtime}
        scope='legacy'
      />
      <GameClientProviders registration={match.game}>
        <Loading>
          <Entry runtime={runtime} />
        </Loading>
      </GameClientProviders>
    </>
  );
}

function SessionEntry({
  descriptor,
  registry,
  runtime,
  kind,
  pathname,
  initialSeatId,
}: {
  descriptor: PlatformRouteDescriptor;
  registry: GameClientRegistry;
  runtime: GameEntryRuntime;
  kind: 'live' | 'spectate' | 'replay' | 'end';
  pathname: string;
  initialSeatId?: string;
}): React.JSX.Element {
  const { t } = useTranslation('platform');
  const { features } = usePlatformConfiguration();
  const seatHandoffLabels = useMemo<GameSeatHandoffLabels>(
    () => ({
      seat: t('game.seat_handoff.seat'),
      selectSeat: t('game.seat_handoff.select'),
      chooseSeat: t('game.seat_handoff.choose'),
      loadingSeat: t('game.seat_handoff.loading'),
      pendingAction: t('game.seat_handoff.pending'),
      revealingSeat: t('game.seat_handoff.revealing'),
      ready: (seatLabel) => t('game.seat_handoff.ready', { name: seatLabel }),
      revealSeat: t('game.seat_handoff.reveal'),
    }),
    [t],
  );
  const [selectedSeatId, setSelectedSeatId] = useState(initialSeatId);
  const selectSeat = useCallback((seatId: string | undefined) => {
    setSelectedSeatId(seatId);
  }, []);
  useEffect(() => {
    setSelectedSeatId(initialSeatId);
  }, [descriptor.route.sessionId, initialSeatId]);
  const resolvedClient = useResolvedGameClient(
    descriptor.route.gameId,
    descriptor.route.releaseId,
    descriptor.route,
  );
  const registration = resolvedClient.registration;
  const loader =
    kind === 'replay'
      ? registration?.capabilities?.replay === false
        ? undefined
        : registration?.entry.loadReplay
      : kind === 'end'
        ? registration?.entry.loadEnd
        : registration?.entry.loadLive;
  const Entry = useMemo(
    () => (loader ? lazy(loader as LazyComponent<GameLiveEntryProps>) : null),
    [loader],
  );
  const gameRuntime = useMemo(
    () => ({
      ...runtime,
      session: {
        ...runtime.session,
        selectedSeatId,
        selectSeat,
        createTransport<
          Command extends JsonValue = JsonValue,
          Query extends JsonValue = JsonValue,
          Answer extends JsonValue = JsonValue,
          View extends JsonValue = JsonValue,
        >(
          route: SessionRoute,
          seatId?: string,
        ): ClientSessionTransport<Command, Query, Answer, View> {
          if (kind === 'replay')
            return createPlatformReplayTransport<Command, Query, Answer, View>(
              runtime.http,
            );
          return runtime.session.createTransport<Command, Query, Answer, View>(
            route,
            seatId === undefined ? selectedSeatId : seatId,
          );
        },
      },
      viewer: {
        ...runtime.viewer,
        identityKey: `${runtime.viewer.identityKey ?? 'anonymous'}:seat:${selectedSeatId ?? ''}`,
        seatId: selectedSeatId,
        accountPrincipalId:
          runtime.viewer.accountPrincipalId ?? runtime.viewer.principalId,
      },
      navigation: {
        ...runtime.navigation,
        platformHref: `/games/${encodeURIComponent(descriptor.route.gameId)}/lobby`,
        ...(descriptor.roomId
          ? {
              roomHref: `/platform/rooms/${encodeURIComponent(descriptor.roomId)}`,
            }
          : {}),
      },
    }),
    [
      runtime,
      selectedSeatId,
      selectSeat,
      descriptor.route.gameId,
      descriptor.roomId,
      kind,
    ],
  );
  const entryRuntime =
    kind === 'replay'
      ? gameRuntime
      : withPlatformConnectionMode(
          gameRuntime,
          kind === 'spectate' ? 'viewer' : 'player',
        );
  const [boundaryAttempt, setBoundaryAttempt] = useState(0);
  const globals = registration ? (
    <ApplicationGlobals
      registration={registration}
      pathname={pathname}
      runtime={entryRuntime}
      scope='session'
    />
  ) : null;
  const safeGlobals =
    kind === 'end' && globals ? (
      <GameClientBoundary fallback={() => null}>
        {() => globals}
      </GameClientBoundary>
    ) : (
      globals
    );
  const renderSurface = (content: React.JSX.Element): React.JSX.Element =>
    kind === 'end' ? (
      <div className='space-y-5'>
        <PlatformSessionResult sessionId={descriptor.route.sessionId} />
        {content}
      </div>
    ) : (
      content
    );
  if (resolvedClient.isPending)
    return renderSurface(
      <>
        {safeGlobals}
        <PlatformLoadingStatus />
      </>,
    );
  if (resolvedClient.isError || resolvedClient.isUnavailable)
    return renderSurface(
      <>
        {safeGlobals}
        <FullScreenStatus
          state='error'
          label={t('route.unavailable', {
            defaultValue: 'This game release is unavailable.',
          })}
          action={{
            label: t('status.retry'),
            onClick: async () => {
              await resolvedClient.refetch();
              setBoundaryAttempt((value) => value + 1);
            },
          }}
          secondaryAction={{
            label: t('room.back', { defaultValue: 'Back to lobby' }),
            href: `/games/${encodeURIComponent(descriptor.route.gameId)}/lobby`,
          }}
        />
      </>,
    );
  if (!registration || !Entry)
    return renderSurface(
      <>
        {safeGlobals}
        <FullScreenStatus
          state='error'
          label={t('route.unavailable', {
            defaultValue: 'This page is unavailable.',
          })}
          secondaryAction={{
            label: t('room.back', { defaultValue: 'Back to lobby' }),
            href: `/games/${encodeURIComponent(descriptor.route.gameId)}/lobby`,
          }}
        />
      </>,
    );
  if (
    descriptor.status === 'creating' ||
    descriptor.status === 'activating' ||
    descriptor.status === 'cancelling'
  )
    return renderSurface(
      <>
        {safeGlobals}
        <PlatformLoadingStatus />
      </>,
    );
  return renderSurface(
    <>
      {safeGlobals}
      <GameClientBoundary
        key={`${descriptor.route.gameId}:${descriptor.route.releaseId}:${descriptor.route.sessionId}:${boundaryAttempt}`}
        fallback={() => (
          <FullScreenStatus
            state='error'
            label={t('route.unavailable', {
              defaultValue: 'This game page is unavailable.',
            })}
            action={{
              label: t('status.retry'),
              onClick: () => setBoundaryAttempt((value) => value + 1),
            }}
            secondaryAction={{
              label: t('room.back', { defaultValue: 'Back to lobby' }),
              href: `/games/${encodeURIComponent(descriptor.route.gameId)}/lobby`,
            }}
          />
        )}
      >
        {(reportError) => (
          <GameClientProviders registration={registration}>
            <Loading>
              <Entry
                route={descriptor.route}
                runtime={{
                  ...entryRuntime,
                  reportError: (error) => {
                    entryRuntime.reportError?.(error);
                    reportError(error);
                  },
                }}
                status={descriptor.status as GameLiveEntryProps['status']}
                spectate={kind === 'spectate'}
                seatHandoffLabels={seatHandoffLabels}
              />
              {(kind === 'live' || kind === 'end') &&
              descriptor.status !== 'cancelled' &&
              registration.sessionChat !== 'game' &&
              features.chat ? (
                <Suspense fallback={null}>
                  <SessionChat
                    key={descriptor.route.sessionId}
                    sessionId={descriptor.route.sessionId}
                  />
                </Suspense>
              ) : null}
            </Loading>
          </GameClientProviders>
        )}
      </GameClientBoundary>
    </>,
  );
}

function SessionPage({
  registry,
  runtime,
  kind,
}: {
  registry: GameClientRegistry;
  runtime: GameEntryRuntime;
  kind: 'live' | 'spectate' | 'replay' | 'end';
}): React.JSX.Element {
  const { gameId } = useParams({ strict: false }) as { gameId: string };
  const epoch = useAuthStore((state) => state.authEpoch);
  const userId = useAuthStore((state) => state.user?.id);
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const search = useRouterState({
    select: (state) => state.location.search,
  }) as unknown as Record<string, unknown>;
  const query = useQuery({
    queryKey: ['platform', 'route', kind, gameId, epoch, userId],
    queryFn: () =>
      kind === 'replay'
        ? probePlatformReplayRoute(gameId, runtime.http)
        : probePlatformRoute(gameId, runtime.http),
    retry: false,
  });
  if (query.isPending) return <PlatformLoadingStatus />;
  if (query.isError)
    return (
      <RequestRecoveryStatus
        error={query.error}
        isRetrying={query.isFetching}
        onRetry={() => query.refetch()}
      />
    );
  if (query.data.kind === 'legacy')
    return (
      <LegacyRoute registry={registry} runtime={runtime} pathname={pathname} />
    );
  return (
    <SessionEntry
      descriptor={query.data.descriptor}
      registry={registry}
      runtime={runtime}
      kind={kind}
      pathname={pathname}
      initialSeatId={
        typeof search.seatId === 'string' && search.seatId.length > 0
          ? search.seatId
          : undefined
      }
    />
  );
}

function GameAdministrationIndex({
  registry,
}: {
  readonly registry: GameClientRegistry;
}): React.JSX.Element {
  const { gameId = '' } = useParams({ strict: false });
  const permissions = usePermissions();
  const adminPage = registry
    .get(gameId)
    ?.administration?.find(
      (page) =>
        !page.requiredCapability || permissions.can(page.requiredCapability),
    )?.id;
  if (!gameId || !adminPage) return <Navigate to='/admin' replace />;
  return (
    <Navigate
      to='/admin/$gameId/$adminPage'
      params={{ gameId, adminPage }}
      replace
    />
  );
}

/** The platform owns account and native-game routes. Installed games contribute only their retained legacy paths. */
export function createPlatformRouter(
  registry: GameClientRegistry,
  runtime: GameEntryRuntime,
) {
  const root = createRootRoute({
    component: () => <RootLayout registry={registry} runtime={runtime} />,
    errorComponent: RouteErrorPage,
    notFoundComponent: () => {
      const pathname = useRouterState({
        select: (state) => state.location.pathname,
      });
      return (
        <LegacyRoute
          registry={registry}
          runtime={runtime}
          pathname={pathname}
        />
      );
    },
  });
  const shell = createRoute({
    getParentRoute: () => root,
    id: 'platform-shell',
    component: () => (
      <AppShell>
        <Loading>
          <Outlet />
        </Loading>
      </AppShell>
    ),
  });
  const index = createRoute({
    getParentRoute: () => shell,
    path: '/',
    component: HomePage,
  });
  const auth = createRoute({
    getParentRoute: () => shell,
    path: '/auth',
    validateSearch: (search: Record<string, unknown>) => ({
      ...search,
      returnTo: safeReturnTo(search.returnTo),
    }),
    component: AuthPage,
  });
  const forgot = createRoute({
    getParentRoute: () => shell,
    path: '/auth/password/forgot',
    component: PasswordResetPage,
  });
  const reset = createRoute({
    getParentRoute: () => shell,
    path: '/auth/password/reset',
    component: PasswordResetPage,
  });
  const activate = createRoute({
    getParentRoute: () => shell,
    path: '/activate',
    validateSearch: (search: Record<string, unknown>) => ({
      returnTo: safeReturnTo(search.returnTo),
    }),
    component: ActivationPage,
  });
  const account = createRoute({
    getParentRoute: () => shell,
    path: '/account',
    component: AccountPage,
  });
  const lobby = createRoute({
    getParentRoute: () => shell,
    path: '/platform',
    component: () => <Navigate to='/' replace />,
  });
  const sessions = createRoute({
    getParentRoute: () => shell,
    path: '/platform/sessions',
    component: SessionsPage,
  });
  const gameIndex = createRoute({
    getParentRoute: () => shell,
    path: '/games/$gameId',
    component: () => {
      const { gameId } = useParams({ strict: false });
      return (
        <Navigate
          to='/games/$gameId/$section'
          params={{ gameId: gameId ?? '', section: 'lobby' }}
          replace
        />
      );
    },
  });
  const gameWorkspace = createRoute({
    getParentRoute: () => shell,
    path: '/games/$gameId/$section',
    validateSearch: (search: Record<string, unknown>) => ({
      ...search,
      principalId:
        typeof search.principalId === 'string' ? search.principalId : undefined,
    }),
    component: () => <Workspace runtime={runtime} />,
  });
  const gameAdministration = createRoute({
    getParentRoute: () => shell,
    path: '/games/$gameId/admin/$adminPage',
    component: () => <Workspace runtime={runtime} />,
  });
  const gameAdministrationAlias = createRoute({
    getParentRoute: () => shell,
    path: '/admin/$gameId/$adminPage',
    component: () => <Workspace runtime={runtime} />,
  });
  const gameAdministrationIndex = createRoute({
    getParentRoute: () => shell,
    path: '/admin/$gameId',
    component: () => <GameAdministrationIndex registry={registry} />,
  });
  const access = createRoute({
    getParentRoute: () => shell,
    path: '/platform/access',
    component: AccessPage,
  });
  const feedback = createRoute({
    getParentRoute: () => shell,
    path: '/platform/feedback',
    component: FeedbackPage,
    validateSearch: (search: Record<string, unknown>) => ({
      gameId: typeof search.gameId === 'string' ? search.gameId : undefined,
      sessionId:
        typeof search.sessionId === 'string' ? search.sessionId : undefined,
    }),
  });
  const operations = createRoute({
    getParentRoute: () => shell,
    path: '/platform/operations',
    component: OperationsPage,
  });
  const administration = createRoute({
    getParentRoute: () => shell,
    path: '/platform/admin',
    component: AdministrationPage,
  });
  const platformAdminPerformance = createRoute({
    getParentRoute: () => shell,
    path: '/platform/admin/performance',
    component: PerformancePage,
  });
  const admin = createRoute({
    getParentRoute: () => shell,
    path: '/admin',
    component: AdministrationPage,
  });
  const adminPerformance = createRoute({
    getParentRoute: () => shell,
    path: '/admin/performance',
    component: PerformancePage,
  });
  const room = createRoute({
    getParentRoute: () => shell,
    path: '/platform/rooms/$roomId',
    component: RoomPage,
  });
  const validateProfile = (search: Record<string, unknown>) => ({
    gameId: typeof search.gameId === 'string' ? search.gameId : undefined,
    principalId:
      typeof search.principalId === 'string' ? search.principalId : undefined,
    tab: typeof search.tab === 'string' ? search.tab : undefined,
  });
  function LegacyProfile({ section }: { section: string }) {
    const search = useSearch({ strict: false }) as ReturnType<
      typeof validateProfile
    >;
    const gameId = search.gameId;
    if (!gameId) return <Navigate to='/' replace />;
    const requested = search.tab ?? section;
    const tab = ['profile', 'achievements', 'rankings', 'wallet'].includes(
      requested,
    )
      ? requested
      : section;
    return (
      <Navigate
        to='/games/$gameId/$section'
        params={{ gameId, section: tab }}
        search={{ principalId: search.principalId }}
        replace
      />
    );
  }
  const profile = createRoute({
    getParentRoute: () => shell,
    path: '/platform/profile',
    validateSearch: validateProfile,
    component: () => <LegacyProfile section='profile' />,
  });
  const achievements = createRoute({
    getParentRoute: () => shell,
    path: '/platform/achievements',
    validateSearch: validateProfile,
    component: () => <LegacyProfile section='achievements' />,
  });
  const rankings = createRoute({
    getParentRoute: () => shell,
    path: '/platform/rankings',
    validateSearch: validateProfile,
    component: () => <LegacyProfile section='rankings' />,
  });
  const wallet = createRoute({
    getParentRoute: () => shell,
    path: '/platform/wallet',
    validateSearch: validateProfile,
    component: () => <LegacyProfile section='wallet' />,
  });
  const live = createRoute({
    getParentRoute: () => root,
    path: '/game/$gameId',
    component: () => (
      <SessionPage registry={registry} runtime={runtime} kind='live' />
    ),
  });
  const spectate = createRoute({
    getParentRoute: () => root,
    path: '/game/$gameId/spectate',
    component: () => (
      <SessionPage registry={registry} runtime={runtime} kind='spectate' />
    ),
  });
  const replay = createRoute({
    getParentRoute: () => root,
    path: '/game/$gameId/replay',
    component: () => (
      <SessionPage registry={registry} runtime={runtime} kind='replay' />
    ),
  });
  const end = createRoute({
    getParentRoute: () => root,
    path: '/game/$gameId/end',
    component: () => (
      <SessionPage registry={registry} runtime={runtime} kind='end' />
    ),
  });
  const legacy = createRoute({
    getParentRoute: () => root,
    path: '$',
    component: () => {
      const pathname = useRouterState({
        select: (state) => state.location.pathname,
      });
      return (
        <LegacyRoute
          registry={registry}
          runtime={runtime}
          pathname={pathname}
        />
      );
    },
  });
  const gameRoutes = registry.list().flatMap((registration) => {
    if (!registration.createRoutes) return [];
    const gameRoot = createRoute({
      getParentRoute: () => root,
      id: `game-contributions-${registration.gameId}`,
      component: () => (
        <Loading>
          <GameClientProviders registration={registration}>
            <Outlet />
          </GameClientProviders>
        </Loading>
      ),
    });
    return [
      gameRoot.addChildren([
        ...registration.createRoutes({ rootRoute: gameRoot, runtime }),
      ]),
    ];
  });
  return createRouter({
    routeTree: root.addChildren([
      shell.addChildren([
        index,
        auth,
        forgot,
        reset,
        activate,
        account,
        lobby,
        sessions,
        gameIndex,
        gameWorkspace,
        gameAdministration,
        gameAdministrationAlias,
        gameAdministrationIndex,
        room,
        profile,
        achievements,
        rankings,
        wallet,
        access,
        feedback,
        operations,
        administration,
        platformAdminPerformance,
        admin,
        adminPerformance,
      ]),
      live,
      spectate,
      replay,
      end,
      ...gameRoutes,
      legacy,
    ]),
    defaultPreload: 'intent',
  });
}

export function PlatformApp({
  registry,
  runtime: suppliedRuntime,
}: PlatformAppProps): React.JSX.Element {
  const runtime = useMemo(
    () => suppliedRuntime ?? createBrowserPlatformRuntime(),
    [suppliedRuntime],
  );
  const queryClient = useMemo(() => new QueryClient(), []);
  const router = useMemo(() => {
    configurePlatformGameClientRegistry(registry);
    return createPlatformRouter(registry, runtime);
  }, [registry, runtime]);
  useEffect(() => subscribeQueryRecovery(queryClient), [queryClient]);
  return (
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <PlatformNotificationOwnershipProvider>
          <AccountQueryCacheBoundary />
          <AuthSessionBootstrap>
            <SessionTerminationListener />
            <PlatformSocketLifecycle />
            <PlatformNotificationEffects />
            <ShellBadgesProvider>
              <RouterProvider router={router} />
            </ShellBadgesProvider>
            <DeferredToaster />
            <ServerUpdateDialogLoader
              onRetry={(notification) =>
                queryClient.refetchQueries(
                  {
                    type: 'active',
                    predicate: (query) => {
                      const error =
                        query.state.error ?? query.state.fetchFailureReason;
                      return (
                        !!notification.requestKey &&
                        error !== null &&
                        typeof error === 'object' &&
                        (error as { requestKey?: string }).requestKey ===
                          notification.requestKey
                      );
                    },
                  },
                  { throwOnError: true },
                )
              }
            />
          </AuthSessionBootstrap>
        </PlatformNotificationOwnershipProvider>
      </I18nextProvider>
    </QueryClientProvider>
  );
}
