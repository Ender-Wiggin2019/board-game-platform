import type { GameSetupOption } from '@board-game/components';
import type { JsonObject, JsonValue } from '@board-game/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  GameClientRegistration,
  GamePlayerColorPickerProps,
  GameSetupEditorProps,
} from '@/GameClientRegistration.js';
import { createGameClientRegistry } from '@/gameClientRegistry.js';
import i18n from '@/i18n.js';
import { PlatformLobbyPage } from '@/pages/platform/PlatformLobbyPage.js';
import { PlatformRoomPage } from '@/pages/platform/PlatformRoomPage.js';
import { configurePlatformGameClientRegistry } from '@/platform/gameClientRegistry.js';
import { useAuthStore } from '@/stores/authStore.js';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  requestId: vi.fn(() => 'request-1'),
  api: {
    catalog: vi.fn(),
    listRooms: vi.fn(),
    listInvitations: vi.fn(),
    listSessions: vi.fn(),
    getRoom: vi.fn(),
    createRoom: vi.fn(),
    createSolo: vi.fn(),
    joinRoom: vi.fn(),
    addBot: vi.fn(),
    setRoomController: vi.fn(),
    leaveRoom: vi.fn(),
    configureRoom: vi.fn(),
    readyRoom: vi.fn(),
    startRoom: vi.fn(),
    cancelStart: vi.fn(),
    renameRoom: vi.fn(),
    deleteRoom: vi.fn(),
    kickRoomMember: vi.fn(),
    inviteToRoom: vi.fn(),
    revokeRoomInvite: vi.fn(),
    acceptInvitation: vi.fn(),
    declineInvitation: vi.fn(),
    setRoomColor: vi.fn(),
    getRoomChat: vi.fn(),
    sendRoomChat: vi.fn(),
    markRoomChatRead: vi.fn(),
  },
  friends: { listFriends: vi.fn() },
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    params,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
    to: string;
    params?: Record<string, string>;
  }) => (
    <a
      {...props}
      href={Object.entries(params ?? {}).reduce(
        (path, [key, value]) => path.replace(`$${key}`, value),
        to,
      )}
    >
      {children}
    </a>
  ),
  useNavigate: () => mocks.navigate,
  useParams: () => ({ roomId: 'room-1' }),
}));

vi.mock('@/api/platformApi.js', () => ({
  platformApi: mocks.api,
  createPlatformRequestId: mocks.requestId,
  resolvePlatformRequestIntent: (
    current: { key: string; requestId: string } | null,
    key: string,
  ) => (current?.key === key ? current : { key, requestId: mocks.requestId() }),
}));
vi.mock('@/api/friendApi.js', () => ({
  friendApi: mocks.friends,
}));
vi.mock('@/components/layout/SceneBackground.js', () => ({
  useSceneHero: vi.fn(),
}));

const catalog = [
  {
    gameId: 'seti',
    releaseId: 'seti-native-v1',
    mode: {
      id: 'casual-multiplayer',
      entry: 'room',
      minPlayers: 2,
      maxPlayers: 4,
      history: 'summary-and-replay',
      platformRating: false,
      concurrency: 'revision',
    },
  },
  {
    gameId: 'seti',
    releaseId: 'seti-native-v1',
    mode: {
      id: 'direct-solo',
      entry: 'direct-solo',
      minPlayers: 1,
      maxPlayers: 1,
      history: 'summary-and-replay',
      platformRating: false,
      concurrency: 'revision',
    },
  },
] as const;

const brassCatalogEntry = {
  gameId: 'brass-test',
  releaseId: 'brass-v1',
  metadata: { name: 'BRASS', description: 'Industrial network building.' },
  mode: {
    id: 'brass-room',
    entry: 'room',
    minPlayers: 2,
    maxPlayers: 4,
    history: 'summary-and-replay',
    platformRating: false,
    concurrency: 'revision',
  },
} as const;

function asJsonObject(value: JsonValue): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function TestSetiSetupEditor({
  setup,
  readOnly,
  disabled = false,
  onChange,
}: GameSetupEditorProps): React.JSX.Element {
  const base = asJsonObject(setup) ?? {};
  const rawOptions = asJsonObject(base.options) ?? {};
  const options = {
    ...rawOptions,
    playerCount:
      typeof rawOptions.playerCount === 'number' ? rawOptions.playerCount : 2,
    undoAllowed: rawOptions.undoAllowed !== false,
    autoStartWhenFull: rawOptions.autoStartWhenFull !== false,
    promoCardsEnabled: rawOptions.promoCardsEnabled !== false,
    alienModulesEnabled: asJsonObject(rawOptions.alienModulesEnabled) ?? {
      1: true,
    },
    spectateLevel: rawOptions.spectateLevel ?? 'ALL',
  };
  const update = (patch: JsonObject): void => {
    onChange({ ...base, options: { ...options, ...patch } });
  };
  return (
    <div>
      <label>
        <input
          type='checkbox'
          role='switch'
          aria-label='Anomalies'
          aria-checked={Boolean(options.alienModulesEnabled[1])}
          checked={Boolean(options.alienModulesEnabled[1])}
          disabled={readOnly || disabled}
          onChange={(event) =>
            update({
              alienModulesEnabled: {
                ...options.alienModulesEnabled,
                1: event.target.checked,
              },
            })
          }
        />
        Anomalies
      </label>
      <label>
        <input
          type='checkbox'
          role='switch'
          aria-label='Start automatically when full'
          aria-checked={Boolean(options.autoStartWhenFull)}
          checked={Boolean(options.autoStartWhenFull)}
          disabled={readOnly || disabled}
          onChange={(event) =>
            update({ autoStartWhenFull: event.target.checked })
          }
        />
        Start automatically when full
      </label>
      <details>
        <summary>More settings</summary>
        <label>
          <input
            type='checkbox'
            role='switch'
            aria-label='Promo Cards'
            aria-checked={Boolean(options.promoCardsEnabled)}
            checked={Boolean(options.promoCardsEnabled)}
            disabled={readOnly || disabled}
            onChange={(event) =>
              update({ promoCardsEnabled: event.target.checked })
            }
          />
          Promo Cards
        </label>
      </details>
    </div>
  );
}

function TestPlayerColorPicker({
  selected,
  disabled,
  onSelect,
}: GamePlayerColorPickerProps): React.JSX.Element {
  return (
    <div>
      {['orange', 'purple'].map((color) => (
        <button
          key={color}
          type='button'
          aria-pressed={selected === color}
          disabled={disabled}
          onClick={() => onSelect(color)}
        >
          {color[0]?.toUpperCase() + color.slice(1)}
        </button>
      ))}
    </div>
  );
}

const setiClientFixture: GameClientRegistration = {
  gameId: 'seti',
  metadata: {
    nameKey: 'test.seti.name',
    descriptionKey: 'test.seti.description',
  },
  setup: {
    default: (modeId): JsonValue =>
      modeId === 'direct-solo'
        ? ({
            options: { playerCount: 1, isSoloMode: true, soloDifficulty: 1 },
          } as JsonValue)
        : ({ options: { playerCount: 2 } } as JsonValue),
    setupEditor: async () => ({ default: TestSetiSetupEditor }),
    playerColorPicker: async () => ({ default: TestPlayerColorPicker }),
    getPreferredPlayerColor: () => 'purple',
    getPlayerCount: (setup, fallback) => {
      const options = asJsonObject(asJsonObject(setup)?.options ?? null);
      return typeof options?.playerCount === 'number'
        ? options.playerCount
        : fallback;
    },
    updatePlayerCount: (setup, count) => {
      const base = asJsonObject(setup) ?? {};
      const options = asJsonObject(base.options) ?? {};
      return { ...base, options: { ...options, playerCount: count } };
    },
  },
  theme: {
    dataTheme: 'seti',
    tokens: { '--platform-accent': '#e17832' },
  },
  capabilities: {
    playerColorSelection: true,
    supportsSeed: true,
    room: true,
    directSolo: true,
  },
  legacyRoutes: [{ pathPrefix: '/my-games' }],
  entry: {
    loadLive: async () => ({ default: () => null }),
  },
};

const brassClient: GameClientRegistration = {
  gameId: 'brass-test',
  metadata: {
    nameKey: 'test.brass.name',
    descriptionKey: 'test.brass.description',
  },
  setup: {
    default: () => ({ options: { size: 2 } }),
    getPlayerCount: (setup: JsonValue, fallback: number) => {
      const options = asJsonObject(asJsonObject(setup)?.options ?? null);
      if (typeof options?.size === 'number') {
        return options.size;
      }
      return fallback;
    },
    updatePlayerCount: (setup: JsonValue, count: number) => {
      const base = asJsonObject(setup) ?? {};
      const options = asJsonObject(base.options) ?? {};
      return { ...base, options: { ...options, size: count } };
    },
  },
  theme: {
    dataTheme: 'brass-test',
    tokens: { '--platform-accent': '#3b82f6' },
  },
  entry: {
    loadLive: async () => ({ default: () => null }),
  },
};

const registeredOptions: readonly GameSetupOption[] = [
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

const optionsCatalogEntry = {
  gameId: 'options-test',
  releaseId: 'options-v1',
  metadata: { name: 'Options Test', description: 'Options test game.' },
  mode: {
    id: 'options-room',
    entry: 'room',
    minPlayers: 2,
    maxPlayers: 4,
    history: 'summary-and-replay',
    platformRating: false,
    concurrency: 'revision',
  },
} as const;

const optionsClient: GameClientRegistration = {
  gameId: 'options-test',
  metadata: { nameKey: 'test.options.name' },
  setup: {
    default: () => ({
      playerCount: 2,
      undoEnabled: true,
      difficulty: 'standard',
      turnTimeLimitMs: 30,
    }),
    options: registeredOptions,
    getPlayerCount: (setup, fallback) => {
      const values = asJsonObject(setup);
      return typeof values?.playerCount === 'number'
        ? values.playerCount
        : fallback;
    },
    updatePlayerCount: (setup, count) => {
      const base = asJsonObject(setup) ?? {};
      return { ...base, playerCount: count };
    },
  },
  capabilities: { room: true },
  entry: { loadLive: async () => ({ default: () => null }) },
};

const route = {
  gameId: 'seti',
  modeId: 'casual-multiplayer',
  sessionId: 'session-1',
  releaseId: 'seti-native-v1',
  backendBindingId: 'backend-1',
  storageBindingId: 'storage-1',
  ownershipEpoch: 'epoch-1',
};

function room(ready = false) {
  return {
    id: 'room-1',
    ownerId: 'player-1',
    gameId: 'seti',
    modeId: 'casual-multiplayer',
    releaseId: 'seti-native-v1',
    visibility: 'public',
    setup: { options: { playerCount: 2 } },
    members: [
      {
        principalId: 'player-1',
        seatId: 'seat-1',
        ready,
        publicProfile: { displayName: 'Player One' },
      },
      {
        principalId: 'player-2',
        seatId: 'seat-2',
        ready: true,
        publicProfile: { displayName: 'Player Two' },
      },
    ],
    metadata: {
      passwordProtected: false,
      capacity: 4,
      reservations: [],
    },
    revision: ready ? 1 : 0,
    startGeneration: 0,
    status: 'open',
  } as const;
}

function renderWithQuery(ui: React.ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
  return { queryClient };
}

describe('platform lobby and room entry', () => {
  beforeAll(() =>
    configurePlatformGameClientRegistry(
      createGameClientRegistry([setiClientFixture, brassClient, optionsClient]),
    ),
  );

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.requestId.mockReset().mockReturnValue('request-1');
    await i18n.changeLanguage('en');
    await i18n.loadNamespaces('platform');
    useAuthStore.setState({
      token: 'token',
      user: {
        id: 'player-1',
        name: 'Player One',
        email: 'player@example.com',
        preferences: { language: 'en' },
      },
      isAuthenticated: true,
      isRestoring: false,
    });
    mocks.api.catalog.mockResolvedValue(catalog);
    mocks.api.listRooms.mockResolvedValue({
      rooms: [room()],
      nextCursor: undefined,
    });
    mocks.api.listInvitations.mockResolvedValue({
      items: [],
      nextCursor: undefined,
    });
    mocks.api.listSessions.mockResolvedValue({
      items: [
        {
          sessionId: 'session-history-1',
          admissionId: 'admission-1',
          route: { ...route },
          visibility: 'private',
          participants: [{ principalId: 'player-1', seatId: 'seat-1' }],
          status: 'active',
          latestAggregateSequence: 3,
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      nextCursor: undefined,
    });
    mocks.api.createRoom.mockResolvedValue(room());
    mocks.api.createSolo.mockResolvedValue({
      state: 'active',
      route: { ...route, modeId: 'direct-solo' },
    });
    mocks.api.getRoom.mockResolvedValue(room());
    mocks.api.addBot.mockResolvedValue(room());
    mocks.api.setRoomController.mockResolvedValue(room());
    mocks.api.readyRoom.mockResolvedValue(room(true));
    mocks.api.startRoom.mockResolvedValue({ state: 'active', route });
    mocks.api.configureRoom.mockResolvedValue(room());
    mocks.api.renameRoom.mockResolvedValue(room());
    mocks.api.deleteRoom.mockResolvedValue({ ...room(), status: 'closed' });
    mocks.api.kickRoomMember.mockResolvedValue(room());
    mocks.api.inviteToRoom.mockResolvedValue(room());
    mocks.api.revokeRoomInvite.mockResolvedValue(room());
    mocks.api.acceptInvitation.mockResolvedValue(room());
    mocks.api.declineInvitation.mockResolvedValue(room());
    mocks.api.setRoomColor.mockResolvedValue(room());
    mocks.api.getRoomChat.mockResolvedValue({
      gameId: 'room-1',
      messages: [],
      readState: { readThroughSeq: 0, throughSeq: 0, unreadCount: 0 },
    });
    mocks.friends.listFriends.mockResolvedValue({
      items: [{ id: 'friend-1', name: 'Friend One' }],
    });
  });

  it('browses rooms, creates a room, and starts direct solo through platform routes', async () => {
    renderWithQuery(<PlatformLobbyPage gameId='seti' />);

    expect(await screen.findByText('Open rooms')).toBeInTheDocument();
    expect(await screen.findByText('2 / 4 players')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('platform-open-create-room'));
    const roomDialog = await screen.findByRole('dialog');
    expect(
      within(roomDialog).queryByRole('switch', { name: 'Anomalies' }),
    ).not.toBeInTheDocument();
    fireEvent.click(within(roomDialog).getByText('Advanced settings'));
    expect(
      await within(roomDialog).findByRole('switch', { name: 'Anomalies' }),
    ).toBeInTheDocument();
    fireEvent.click(
      within(roomDialog).getByRole('button', { name: 'Create room' }),
    );
    await waitFor(() =>
      expect(mocks.api.createRoom).toHaveBeenCalledWith(
        expect.objectContaining({
          modeId: 'casual-multiplayer',
          releaseId: 'seti-native-v1',
          requestId: 'request-1',
          visibility: 'public',
          setup: { options: { playerCount: 2 } },
          color: 'purple',
        }),
      ),
    );
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: '/platform/rooms/$roomId',
      params: { roomId: 'room-1' },
    });

    fireEvent.click(screen.getByTestId('platform-open-solo-setup'));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: 'Start solo challenge',
      }),
    );
    await waitFor(() =>
      expect(mocks.api.createSolo).toHaveBeenCalledWith(
        expect.objectContaining({
          modeId: 'direct-solo',
          releaseId: 'seti-native-v1',
          requestId: 'request-1',
          setup: {
            options: { playerCount: 1, isSoloMode: true, soloDifficulty: 1 },
          },
        }),
      ),
    );
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: '/game/$gameId',
      params: { gameId: 'session-1' },
    });
  });

  it('does not leave the room browser pending when only solo mode is available', async () => {
    mocks.api.catalog.mockResolvedValue([catalog[1]]);

    renderWithQuery(<PlatformLobbyPage gameId='seti' />);

    expect(
      await screen.findByText('No public rooms are waiting.'),
    ).toBeInTheDocument();
    expect(mocks.api.listRooms).not.toHaveBeenCalled();
  });

  it('reuses a solo launch intent after a lost reply instead of creating another session', async () => {
    mocks.requestId
      .mockReturnValueOnce('solo-intent-1')
      .mockReturnValueOnce('solo-intent-2');
    mocks.api.createSolo.mockRejectedValueOnce(new Error('Reply lost'));
    renderWithQuery(<PlatformLobbyPage gameId='seti' />);
    fireEvent.click(await screen.findByTestId('platform-open-solo-setup'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Start solo challenge' }),
    );
    await waitFor(() =>
      expect(
        within(dialog).getByRole('button', { name: 'Start solo challenge' }),
      ).not.toBeDisabled(),
    );
    expect(mocks.api.createSolo).toHaveBeenCalledOnce();
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Start solo challenge' }),
    );
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalled());
    expect(mocks.api.createSolo.mock.calls[0]?.[0].requestId).toBe(
      'solo-intent-1',
    );
    expect(mocks.api.createSolo.mock.calls[1]?.[0].requestId).toBe(
      'solo-intent-1',
    );
    expect(mocks.requestId).toHaveBeenCalledOnce();
  });

  it('reuses a room creation intent after a lost reply', async () => {
    mocks.requestId
      .mockReturnValueOnce('room-intent-1')
      .mockReturnValueOnce('room-intent-2');
    mocks.api.createRoom.mockRejectedValueOnce(new Error('Reply lost'));
    renderWithQuery(<PlatformLobbyPage gameId='seti' />);
    fireEvent.click(await screen.findByTestId('platform-open-create-room'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Create room' }),
    );
    await waitFor(() =>
      expect(
        within(dialog).getByRole('button', { name: 'Create room' }),
      ).not.toBeDisabled(),
    );
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Create room' }),
    );
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalled());
    expect(mocks.api.createRoom.mock.calls[0]?.[0].requestId).toBe(
      'room-intent-1',
    );
    expect(mocks.api.createRoom.mock.calls[1]?.[0].requestId).toBe(
      'room-intent-1',
    );
    expect(mocks.requestId).toHaveBeenCalledOnce();
  });

  it('starts a new room intent when the failed payload changes or the dialog is reopened', async () => {
    mocks.requestId
      .mockReturnValueOnce('room-intent-1')
      .mockReturnValueOnce('room-intent-2')
      .mockReturnValueOnce('room-intent-3');
    mocks.api.createRoom.mockRejectedValueOnce(new Error('Reply lost'));
    renderWithQuery(<PlatformLobbyPage gameId='seti' />);
    fireEvent.click(await screen.findByTestId('platform-open-create-room'));
    let dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Room name'), {
      target: { value: 'First payload' },
    });
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Create room' }),
    );
    await waitFor(() =>
      expect(
        within(dialog).getByRole('button', { name: 'Create room' }),
      ).not.toBeDisabled(),
    );
    fireEvent.change(within(dialog).getByLabelText('Room name'), {
      target: { value: 'Changed payload' },
    });
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Create room' }),
    );
    await waitFor(() => expect(mocks.api.createRoom).toHaveBeenCalledTimes(2));
    expect(mocks.api.createRoom.mock.calls[0]?.[0].requestId).toBe(
      'room-intent-1',
    );
    expect(mocks.api.createRoom.mock.calls[1]?.[0].requestId).toBe(
      'room-intent-2',
    );

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByTestId('platform-open-create-room'));
    dialog = await screen.findByRole('dialog');
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Create room' }),
    );
    await waitFor(() => expect(mocks.api.createRoom).toHaveBeenCalledTimes(3));
    expect(mocks.api.createRoom.mock.calls[2]?.[0].requestId).toBe(
      'room-intent-3',
    );
  });

  it('opens the waiting room when a solo launch is still activating', async () => {
    mocks.api.createSolo.mockResolvedValueOnce({
      state: 'activating',
      roomId: 'direct:pending',
      route,
    });
    renderWithQuery(<PlatformLobbyPage gameId='seti' />);
    fireEvent.click(await screen.findByTestId('platform-open-solo-setup'));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: 'Start solo challenge',
      }),
    );
    await waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith({
        to: '/platform/rooms/$roomId',
        params: { roomId: 'direct:pending' },
      }),
    );
  });

  it('keeps loaded rooms visible when refresh fails and retries in place', async () => {
    mocks.api.listRooms
      .mockResolvedValueOnce({ rooms: [room()] })
      .mockRejectedValueOnce(new Error('Network unavailable'))
      .mockResolvedValue({ rooms: [room()] });
    renderWithQuery(<PlatformLobbyPage gameId='seti' />);
    expect(await screen.findByText('2 / 4 players')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh rooms' }));
    const notice = await screen.findByRole('alert');
    expect(notice).toHaveTextContent(
      'Could not update. Showing the last loaded results.',
    );
    expect(screen.getByText('2 / 4 players')).toBeInTheDocument();
    fireEvent.click(within(notice).getByRole('button', { name: 'Try again' }));
    await waitFor(() =>
      expect(screen.queryByRole('alert')).not.toBeInTheDocument(),
    );
    expect(mocks.api.listRooms).toHaveBeenCalledTimes(3);
  });

  it('keeps the lobby and open setup form when its catalog refresh fails', async () => {
    const { queryClient } = renderWithQuery(
      <PlatformLobbyPage gameId='seti' />,
    );
    fireEvent.click(await screen.findByTestId('platform-open-create-room'));
    fireEvent.change(
      within(await screen.findByRole('dialog')).getByLabelText('Room name'),
      {
        target: { value: 'Draft mission' },
      },
    );
    mocks.api.catalog.mockRejectedValueOnce(new Error('Network unavailable'));
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['platform', 'catalog'] });
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not update.',
    );
    expect(
      within(screen.getByRole('dialog')).getByLabelText('Room name'),
    ).toHaveValue('Draft mission');
    expect(screen.getByText('2 / 4 players')).toBeInTheDocument();
  });

  it('retries a failed history page with its cursor while keeping earlier sessions', async () => {
    const firstPage = await mocks.api.listSessions();
    mocks.api.listSessions
      .mockClear()
      .mockResolvedValueOnce({ ...firstPage, nextCursor: 'next-page' })
      .mockRejectedValueOnce(new Error('Network unavailable'))
      .mockResolvedValue({
        items: [{ ...firstPage.items[0], sessionId: 'session-history-2' }],
      });
    renderWithQuery(<PlatformLobbyPage gameId='seti' view='sessions' />);
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    const notice = await screen.findByRole('alert');
    expect(screen.getByRole('link', { name: 'Resume' })).toHaveAttribute(
      'href',
      '/game/session-history-1',
    );
    fireEvent.click(within(notice).getByRole('button', { name: 'Try again' }));
    await waitFor(() =>
      expect(screen.getAllByRole('link', { name: 'Resume' })).toHaveLength(2),
    );
    expect(mocks.api.listSessions).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: 'next-page', gameId: 'seti' }),
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('accepts and declines incoming platform room invitations', async () => {
    mocks.api.listInvitations.mockResolvedValue({
      items: [
        {
          grantId: 'grant-1',
          roomId: 'room-1',
          gameId: 'seti',
          modeId: 'casual-multiplayer',
          releaseId: 'seti-native-v1',
          roomName: 'Mission Alpha',
          ownerId: 'owner-1',
          ownerName: 'Owner One',
          reservedSeatId: 'seat-2',
        },
        {
          grantId: 'grant-other-game',
          roomId: 'room-other-game',
          gameId: 'brass-test',
          modeId: 'brass-room',
          releaseId: 'brass-v1',
          roomName: 'Other Game Mission',
          ownerId: 'owner-2',
        },
      ],
    });

    renderWithQuery(<PlatformLobbyPage gameId='seti' />);

    expect(await screen.findByText('Room invitations')).toBeInTheDocument();
    expect(await screen.findByText('Mission Alpha')).toBeInTheDocument();
    expect(screen.queryByText('Other Game Mission')).not.toBeInTheDocument();
    expect(await screen.findByText(/Invited by Owner One/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('platform-invitation-accept-grant-1'));
    await waitFor(() =>
      expect(mocks.api.acceptInvitation).toHaveBeenCalledWith(
        'room-1',
        'grant-1',
      ),
    );
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: '/platform/rooms/$roomId',
      params: { roomId: 'room-1' },
    });

    cleanup();
    renderWithQuery(<PlatformLobbyPage gameId='seti' />);
    fireEvent.click(
      await screen.findByTestId('platform-invitation-decline-grant-1'),
    );
    await waitFor(() =>
      expect(mocks.api.declineInvitation).toHaveBeenCalledWith(
        'room-1',
        'grant-1',
      ),
    );
  });

  it('pages through invitations while keeping the game filter applied', async () => {
    mocks.api.listInvitations.mockImplementation(
      (params?: { cursor?: string }) =>
        Promise.resolve(
          params?.cursor
            ? {
                items: [
                  {
                    grantId: 'grant-page-2',
                    roomId: 'room-page-2',
                    gameId: 'seti',
                    modeId: 'casual-multiplayer',
                    releaseId: 'seti-native-v1',
                    roomName: 'Mission Beta',
                    ownerId: 'owner-2',
                  },
                ],
                nextCursor: undefined,
              }
            : { items: [], nextCursor: 'cursor-page-2' },
        ),
    );

    renderWithQuery(<PlatformLobbyPage gameId='seti' />);

    expect(
      await screen.findByTestId('platform-invitations-load-more'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('platform-invitations-load-more'));
    expect(await screen.findByText('Mission Beta')).toBeInTheDocument();
    expect(mocks.api.listInvitations).toHaveBeenNthCalledWith(1, {
      limit: 20,
    });
    expect(mocks.api.listInvitations).toHaveBeenNthCalledWith(2, {
      limit: 20,
      cursor: 'cursor-page-2',
    });
  });

  it('ignores a late invitation response after the authenticated account changes', async () => {
    mocks.api.listInvitations.mockResolvedValue({
      items: [
        {
          grantId: 'grant-1',
          roomId: 'room-1',
          gameId: 'seti',
          modeId: 'casual-multiplayer',
          releaseId: 'seti-native-v1',
          ownerId: 'owner-1',
        },
      ],
    });
    let resolveAccept!: (value: ReturnType<typeof room>) => void;
    mocks.api.acceptInvitation.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveAccept = resolve;
        }),
    );

    renderWithQuery(<PlatformLobbyPage gameId='seti' />);
    fireEvent.click(
      await screen.findByTestId('platform-invitation-accept-grant-1'),
    );
    await waitFor(() =>
      expect(mocks.api.acceptInvitation).toHaveBeenCalledWith(
        'room-1',
        'grant-1',
      ),
    );
    act(() => useAuthStore.setState({ authEpoch: 1 }));
    await act(async () => resolveAccept(room()));

    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('uses the explicit game id and does not fall back to another catalog game', async () => {
    mocks.api.catalog.mockResolvedValue([
      ...catalog,
      brassCatalogEntry,
      {
        ...brassCatalogEntry,
        gameId: 'unknown-game',
        metadata: { name: 'Mystery Game' },
        mode: { ...brassCatalogEntry.mode, id: 'mystery-room' },
      },
    ]);
    mocks.api.listRooms.mockResolvedValue({ rooms: [], nextCursor: undefined });

    renderWithQuery(<PlatformLobbyPage gameId='brass-test' />);

    await waitFor(() =>
      expect(mocks.api.listRooms).toHaveBeenCalledWith({
        gameId: 'brass-test',
        status: 'open',
        limit: 20,
      }),
    );
    expect(screen.getByTestId('platform-lobby-page')).toHaveAttribute(
      'data-game-theme',
      'brass-test',
    );

    fireEvent.click(screen.getByTestId('platform-open-create-room'));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: 'Create room',
      }),
    );
    await waitFor(() =>
      expect(mocks.api.createRoom).toHaveBeenCalledWith(
        expect.objectContaining({
          gameId: 'brass-test',
          modeId: 'brass-room',
          releaseId: 'brass-v1',
          setup: { options: { size: 2 } },
        }),
      ),
    );
  });

  it('mounts registered boolean, select, and integer options in room creation', async () => {
    mocks.api.catalog.mockResolvedValue([...catalog, optionsCatalogEntry]);
    mocks.api.listRooms.mockResolvedValue({ rooms: [], nextCursor: undefined });

    renderWithQuery(<PlatformLobbyPage gameId='options-test' />);

    expect(await screen.findByText('Open rooms')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('platform-open-create-room'));
    const dialog = await screen.findByRole('dialog');

    fireEvent.click(
      within(dialog).getByRole('switch', { name: 'Undo enabled' }),
    );
    fireEvent.change(within(dialog).getByLabelText('Difficulty'), {
      target: { value: 'expert' },
    });
    fireEvent.change(within(dialog).getByLabelText('Turn time limit'), {
      target: { value: '60' },
    });
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Create room' }),
    );

    await waitFor(() =>
      expect(mocks.api.createRoom).toHaveBeenCalledWith(
        expect.objectContaining({
          gameId: 'options-test',
          setup: {
            playerCount: 2,
            undoEnabled: false,
            difficulty: 'expert',
            turnTimeLimitMs: 60,
          },
        }),
      ),
    );
  });

  it('mounts registered options in room settings and preserves unrelated setup values', async () => {
    const optionsRoom = {
      ...room(),
      gameId: 'options-test',
      modeId: 'options-room',
      releaseId: 'options-v1',
      setup: {
        playerCount: 2,
        undoEnabled: true,
        difficulty: 'standard',
        turnTimeLimitMs: 30,
        unrelated: 'keep-me',
      },
    } as const;
    mocks.api.catalog.mockResolvedValue([...catalog, optionsCatalogEntry]);
    mocks.api.getRoom.mockResolvedValue(optionsRoom);
    mocks.api.configureRoom.mockResolvedValue(optionsRoom);

    renderWithQuery(<PlatformRoomPage />);

    expect(await screen.findByText('Platform room')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: 'Undo enabled' }));
    fireEvent.change(screen.getByLabelText('Difficulty'), {
      target: { value: 'expert' },
    });
    fireEvent.change(screen.getByLabelText('Turn time limit'), {
      target: { value: '60' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));

    await waitFor(() =>
      expect(mocks.api.configureRoom).toHaveBeenCalledWith('room-1', 0, {
        playerCount: 2,
        undoEnabled: false,
        difficulty: 'expert',
        turnTimeLimitMs: 60,
        unrelated: 'keep-me',
      }),
    );
  });

  it('renders registered room options as read-only for a non-owner member', async () => {
    const optionsRoom = {
      ...room(),
      gameId: 'options-test',
      modeId: 'options-room',
      releaseId: 'options-v1',
      setup: {
        playerCount: 2,
        undoEnabled: true,
        difficulty: 'expert',
        turnTimeLimitMs: 60,
      },
    } as const;
    useAuthStore.setState({
      user: {
        id: 'player-2',
        name: 'Player Two',
        email: 'two@example.com',
      },
    });
    mocks.api.catalog.mockResolvedValue([...catalog, optionsCatalogEntry]);
    mocks.api.getRoom.mockResolvedValue(optionsRoom);

    renderWithQuery(<PlatformRoomPage />);

    expect(await screen.findByText('Enabled')).toBeInTheDocument();
    expect(screen.getByText('Expert')).toBeInTheDocument();
    expect(screen.getByText('60')).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'Undo enabled' })).toBeNull();
  });

  it('keeps an unknown game unavailable without loading another game', async () => {
    mocks.api.catalog.mockResolvedValue([
      ...catalog,
      {
        ...brassCatalogEntry,
        gameId: 'unknown-game',
        metadata: { name: 'Mystery Game' },
        mode: { ...brassCatalogEntry.mode, id: 'mystery-room' },
      },
    ]);

    renderWithQuery(<PlatformLobbyPage gameId='unknown-game' />);

    expect(
      await screen.findByTestId('platform-lobby-unavailable'),
    ).toBeInTheDocument();
    expect(mocks.api.listRooms).not.toHaveBeenCalled();
    expect(mocks.api.listSessions).not.toHaveBeenCalled();
  });

  it('uses the selected game setup boundary in the shared room page', async () => {
    const brassRoom = {
      ...room(),
      gameId: 'brass-test',
      modeId: 'brass-room',
      releaseId: 'brass-v1',
      setup: { options: { size: 2 } },
    } as const;
    mocks.api.catalog.mockResolvedValue([...catalog, brassCatalogEntry]);
    mocks.api.getRoom.mockResolvedValue(brassRoom);
    mocks.api.configureRoom.mockResolvedValue(brassRoom);

    renderWithQuery(<PlatformRoomPage />);

    expect(await screen.findByText('Platform room')).toBeInTheDocument();
    expect(screen.getByTestId('platform-room-page')).toHaveAttribute(
      'data-game-theme',
      'brass-test',
    );
    expect(
      screen.getByText('Game setup is not available in this client.'),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Players'), {
      target: { value: '3' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));

    await waitFor(() =>
      expect(mocks.api.configureRoom).toHaveBeenCalledWith('room-1', 0, {
        options: { size: 3 },
      }),
    );
  });

  it('passes a platform seed without changing the game setup schema', async () => {
    renderWithQuery(<PlatformLobbyPage gameId='seti' />);

    expect(await screen.findByText('Open rooms')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('platform-open-create-room'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByText('Advanced settings'));
    fireEvent.change(within(dialog).getByLabelText('Preset seed'), {
      target: { value: 'shared-seed-1' },
    });
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Create room' }),
    );
    fireEvent.click(
      await within(await screen.findByRole('dialog')).findByRole('button', {
        name: 'Use seed and create',
      }),
    );

    await waitFor(() =>
      expect(mocks.api.createRoom).toHaveBeenCalledWith(
        expect.objectContaining({
          seed: 'shared-seed-1',
          setup: {
            options: { playerCount: 2 },
          },
        }),
      ),
    );
  });

  it('lets the owner add a bot when the room allows bots and has a seat', async () => {
    const botRoom = {
      ...room(),
      metadata: {
        ...room().metadata,
        botsAllowed: true,
      },
    } as const;
    const startedRoom = {
      ...botRoom,
      status: 'started',
      route,
    } as const;
    mocks.api.getRoom.mockResolvedValue(botRoom);
    mocks.api.addBot.mockResolvedValue(startedRoom);

    renderWithQuery(<PlatformRoomPage />);

    expect(
      await screen.findByRole('button', { name: 'Add bot' }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add bot' }));

    await waitFor(() =>
      expect(mocks.api.addBot).toHaveBeenCalledWith('room-1', 0),
    );
    await waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith({
        to: '/game/$gameId',
        params: { gameId: 'session-1' },
        replace: true,
      }),
    );
  });

  it('saves a registered hot-seat controller and hides the legacy bot action', async () => {
    const controllerRoom = {
      ...room(),
      metadata: {
        ...room().metadata,
        controllers: {
          hotseat: true,
          automation: [
            { id: 'basic-ai', kind: 'ai' as const, label: 'Basic AI' },
          ],
        },
      },
    } as const;
    mocks.api.getRoom.mockResolvedValue(controllerRoom);
    mocks.api.setRoomController.mockResolvedValue(controllerRoom);

    renderWithQuery(<PlatformRoomPage />);

    expect(
      await screen.findByText('Add a seat controller'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add bot' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Controller'), {
      target: { value: 'hotseat' },
    });
    fireEvent.change(screen.getByLabelText('Display name (optional)'), {
      target: { value: 'Table seat' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add controller' }));

    await waitFor(() =>
      expect(mocks.api.setRoomController).toHaveBeenCalledWith('room-1', 0, {
        kind: 'hotseat',
        displayName: 'Table seat',
      }),
    );
  });

  it('sends the selected named automation preset without exposing engine options', async () => {
    const controllerRoom = {
      ...room(),
      metadata: {
        ...room().metadata,
        controllers: {
          hotseat: false,
          automation: [
            {
              id: 'brass-ai',
              kind: 'ai' as const,
              label: 'BRASS AI',
              defaultOptions: { searchDepth: 1 },
              presets: [
                {
                  id: 'strong',
                  label: 'Strong',
                  options: { profile: 'strong' },
                },
              ],
            },
          ],
        },
      },
    } as const;
    mocks.api.getRoom.mockResolvedValue(controllerRoom);
    mocks.api.setRoomController.mockResolvedValue(controllerRoom);

    renderWithQuery(<PlatformRoomPage />);

    expect(
      await screen.findByText('Add a seat controller'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Strategy preset')).toHaveValue('strong');
    fireEvent.click(screen.getByRole('button', { name: 'Add controller' }));

    await waitFor(() =>
      expect(mocks.api.setRoomController).toHaveBeenCalledWith('room-1', 0, {
        kind: 'ai',
        controllerId: 'brass-ai',
        options: { profile: 'strong' },
      }),
    );
  });

  it('hides the add bot action when bots are disabled, the room is full, or the viewer is not the owner', async () => {
    mocks.api.getRoom.mockResolvedValue(room());
    renderWithQuery(<PlatformRoomPage />);

    expect(await screen.findByText('Platform room')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Add bot' }),
    ).not.toBeInTheDocument();

    cleanup();
    const fullRoom = {
      ...room(),
      members: [
        ...room().members,
        {
          principalId: 'player-3',
          seatId: 'seat-3',
          ready: true,
          publicProfile: { displayName: 'Player Three' },
        },
        {
          principalId: 'player-4',
          seatId: 'seat-4',
          ready: true,
          publicProfile: { displayName: 'Player Four' },
        },
      ],
      metadata: {
        ...room().metadata,
        botsAllowed: true,
      },
    } as const;
    mocks.api.getRoom.mockResolvedValue(fullRoom);
    renderWithQuery(<PlatformRoomPage />);
    expect(await screen.findByText('4 / 4 players')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Add bot' }),
    ).not.toBeInTheDocument();

    cleanup();
    useAuthStore.setState({
      user: {
        id: 'player-2',
        name: 'Player Two',
        email: 'two@example.com',
      },
    });
    mocks.api.getRoom.mockResolvedValue({
      ...room(),
      metadata: {
        ...room().metadata,
        botsAllowed: true,
      },
    });
    renderWithQuery(<PlatformRoomPage />);
    expect(await screen.findByText('Platform room')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Add bot' }),
    ).not.toBeInTheDocument();
  });

  it('renders bots without human readiness UI and removes them through the kick flow', async () => {
    const botRoom = {
      ...room(),
      members: [
        room().members[0],
        {
          principalId: 'bot-1',
          seatId: 'seat-2',
          ready: true,
          controller: 'bot',
          publicProfile: { displayName: 'Chronos Bot' },
        },
      ],
      metadata: {
        ...room().metadata,
        botsAllowed: true,
      },
    } as const;
    mocks.api.getRoom.mockResolvedValue(botRoom);
    mocks.api.kickRoomMember.mockResolvedValue(botRoom);

    renderWithQuery(<PlatformRoomPage />);

    expect(await screen.findByText('Chronos Bot')).toBeInTheDocument();
    expect(screen.getByText('Bot')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Remove bot Chronos Bot' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Mark ready' }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'Remove bot Chronos Bot' }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Remove bot' }));

    await waitFor(() =>
      expect(mocks.api.kickRoomMember).toHaveBeenCalledWith(
        'room-1',
        0,
        'bot-1',
      ),
    );
  });

  it('refreshes the room after an add bot stale revision error', async () => {
    const botRoom = {
      ...room(),
      metadata: {
        ...room().metadata,
        botsAllowed: true,
      },
    } as const;
    mocks.api.getRoom.mockResolvedValue(botRoom);
    mocks.api.addBot.mockRejectedValue({ responseCode: 'STALE_REVISION' });

    renderWithQuery(<PlatformRoomPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add bot' }));

    await waitFor(() => expect(mocks.api.getRoom).toHaveBeenCalledTimes(2));
  });

  it('lists native history and links an owned session back to the platform game', async () => {
    renderWithQuery(<PlatformLobbyPage gameId='seti' view='sessions' />);

    expect(await screen.findByText('Game session history')).toBeInTheDocument();
    expect(await screen.findByText('Casual')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Legacy games' })).toHaveAttribute(
      'href',
      '/my-games',
    );
    expect(screen.getByRole('link', { name: 'Resume' })).toHaveAttribute(
      'href',
      '/game/session-history-1',
    );
    expect(mocks.api.listSessions).toHaveBeenCalledWith({
      gameId: 'seti',
      scope: 'mine',
      status: 'active',
      limit: 20,
    });
    expect(mocks.api.listRooms).not.toHaveBeenCalled();
    expect(mocks.api.listInvitations).not.toHaveBeenCalled();
  });

  it('opens completed sessions on their retained result page', async () => {
    mocks.api.listSessions.mockResolvedValue({
      items: [
        {
          sessionId: 'session-history-1',
          admissionId: 'admission-1',
          route: { ...route },
          visibility: 'private',
          participants: [{ principalId: 'player-1', seatId: 'seat-1' }],
          status: 'completed',
          latestAggregateSequence: 3,
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      nextCursor: undefined,
    });

    renderWithQuery(<PlatformLobbyPage gameId='seti' view='sessions' />);

    expect(
      await screen.findByRole('link', { name: 'View result' }),
    ).toHaveAttribute('href', '/game/session-history-1/end');
  });

  it('lets a room member become ready and the owner start the native session', async () => {
    renderWithQuery(<PlatformRoomPage />);

    expect(await screen.findByText('Platform room')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Mark ready' }));
    await waitFor(() =>
      expect(mocks.api.readyRoom).toHaveBeenCalledWith('room-1', 0, true),
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Start game' }));
    await waitFor(() =>
      expect(mocks.api.startRoom).toHaveBeenCalledWith(
        'room-1',
        1,
        'request-1',
      ),
    );
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: '/game/$gameId',
      params: { gameId: 'session-1' },
      replace: true,
    });
  });

  it('reuses the room start intent after a lost reply', async () => {
    mocks.requestId
      .mockReturnValueOnce('start-intent-1')
      .mockReturnValueOnce('start-intent-2');
    mocks.api.startRoom
      .mockRejectedValueOnce(new Error('Reply lost'))
      .mockResolvedValue({ state: 'active', route });

    renderWithQuery(<PlatformRoomPage />);
    expect(await screen.findByText('Platform room')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Mark ready' }));
    await waitFor(() =>
      expect(mocks.api.readyRoom).toHaveBeenCalledWith('room-1', 0, true),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Start game' }));
    await waitFor(() => expect(mocks.api.startRoom).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: 'Start game' }));
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalled());

    expect(mocks.api.startRoom.mock.calls[0]?.[2]).toBe('start-intent-1');
    expect(mocks.api.startRoom.mock.calls[1]?.[2]).toBe('start-intent-1');
    expect(mocks.requestId).toHaveBeenCalledOnce();
  });

  it('ignores a late room start response after the authenticated account changes', async () => {
    let resolveStart!: (value: {
      state: 'active';
      route: typeof route;
    }) => void;
    mocks.api.startRoom.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStart = resolve;
        }),
    );

    renderWithQuery(<PlatformRoomPage />);
    expect(await screen.findByText('Platform room')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Mark ready' }));
    await waitFor(() =>
      expect(mocks.api.readyRoom).toHaveBeenCalledWith('room-1', 0, true),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Start game' }));
    await waitFor(() => expect(mocks.api.startRoom).toHaveBeenCalledOnce());

    const currentUser = useAuthStore.getState().user;
    if (!currentUser) throw new Error('test account is not loaded');
    act(() =>
      useAuthStore.setState({
        authEpoch: useAuthStore.getState().authEpoch + 1,
        user: { ...currentUser, id: 'player-2' },
      }),
    );
    await act(async () => resolveStart({ state: 'active', route }));

    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('refreshes an open native room while waiting for remote changes', async () => {
    vi.useFakeTimers();
    try {
      const initialRoom = {
        ...room(),
        members: [room().members[0]],
      };
      const refreshedRoom = {
        ...initialRoom,
        revision: 1,
        members: [
          ...initialRoom.members,
          { ...room().members[1], ready: true },
        ],
      };
      mocks.api.getRoom
        .mockResolvedValueOnce(initialRoom)
        .mockResolvedValueOnce(refreshedRoom);

      renderWithQuery(<PlatformRoomPage />);
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.getByText('Platform room')).toBeInTheDocument();
      expect(mocks.api.getRoom).toHaveBeenCalledTimes(1);
      expect(screen.getByText('1 / 4 players')).toBeInTheDocument();
      expect(screen.queryByText('Player Two')).not.toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
        await Promise.resolve();
      });

      expect(mocks.api.getRoom).toHaveBeenCalledTimes(2);
      expect(screen.getByText('2 / 4 players')).toBeInTheDocument();
      expect(screen.getByText('Player Two')).toBeInTheDocument();
      expect(screen.getByText('Ready')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the loaded room visible when a background refresh fails', async () => {
    const { queryClient } = renderWithQuery(<PlatformRoomPage />);

    expect(await screen.findByText('Platform room')).toBeInTheDocument();
    mocks.api.getRoom.mockRejectedValueOnce(new Error('Network unavailable'));
    await act(async () => {
      await queryClient.refetchQueries({
        queryKey: ['platform', 'room', 'room-1'],
      });
    });

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not update.',
    );
    expect(screen.getByText('2 / 4 players')).toBeInTheDocument();
    mocks.api.getRoom.mockResolvedValueOnce(room());
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() =>
      expect(screen.queryByRole('alert')).not.toBeInTheDocument(),
    );
  });

  it('navigates when a background room refresh reports a started session', async () => {
    vi.useFakeTimers();
    try {
      mocks.api.getRoom.mockResolvedValueOnce(room()).mockResolvedValueOnce({
        ...room(),
        revision: 1,
        status: 'started',
        route,
      });

      renderWithQuery(<PlatformRoomPage />);
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.getByText('Platform room')).toBeInTheDocument();
      expect(mocks.navigate).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
        await Promise.resolve();
      });

      expect(mocks.navigate).toHaveBeenCalledWith({
        to: '/game/$gameId',
        params: { gameId: 'session-1' },
        replace: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps an initially started room open for room management', async () => {
    mocks.api.getRoom.mockResolvedValueOnce({
      ...room(),
      status: 'started',
      route,
    });

    renderWithQuery(<PlatformRoomPage />);

    expect(await screen.findByText('Platform room')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Enter game' })).toHaveAttribute(
      'href',
      '/game/session-1',
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('keeps unsaved room settings and name while live room data refreshes', async () => {
    const { queryClient } = renderWithQuery(<PlatformRoomPage />);

    expect(await screen.findByText('Platform room')).toBeInTheDocument();
    fireEvent.click(await screen.findByText('More settings'));
    fireEvent.click(screen.getByRole('switch', { name: 'Promo Cards' }));
    expect(screen.getByRole('switch', { name: 'Promo Cards' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Rename room' }));
    const nameInput = screen.getByRole('textbox', { name: 'Rename room' });
    fireEvent.change(nameInput, { target: { value: 'Draft mission' } });

    const current = queryClient.getQueryData<ReturnType<typeof room>>([
      'platform',
      'room',
      'room-1',
      useAuthStore.getState().authEpoch,
    ]);
    expect(current).toBeDefined();
    if (!current) throw new Error('room query did not load');
    mocks.api.getRoom.mockResolvedValueOnce({
      ...current,
      revision: (current?.revision ?? 0) + 1,
      members: [
        ...current.members,
        {
          principalId: 'player-3',
          seatId: 'seat-3',
          ready: false,
          publicProfile: { displayName: 'Player Three' },
        },
      ],
    });
    await act(async () => {
      await queryClient.refetchQueries({
        queryKey: ['platform', 'room', 'room-1'],
      });
    });

    expect(await screen.findByText('Player Three')).toBeInTheDocument();
    await waitFor(() => {
      expect(
        screen.getByRole('switch', { name: 'Promo Cards' }),
      ).toHaveAttribute('aria-checked', 'false');
      expect(screen.getByRole('textbox', { name: 'Rename room' })).toHaveValue(
        'Draft mission',
      );
    });
  });

  it('keeps older room responses readable before metadata rollout', async () => {
    const legacyRoom = { ...room() } as Record<string, unknown>;
    delete legacyRoom.metadata;
    mocks.api.getRoom.mockResolvedValue(legacyRoom);

    renderWithQuery(<PlatformRoomPage />);

    expect(await screen.findByText('Platform room')).toBeInTheDocument();
    expect(screen.getByText('2 / 4 players')).toBeInTheDocument();
  });

  it('edits the shared game settings and preserves native room lifecycle options', async () => {
    renderWithQuery(<PlatformRoomPage />);

    expect(await screen.findByText('Platform room')).toBeInTheDocument();
    expect(
      screen.getByRole('switch', { name: 'Start automatically when full' }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('switch', { name: 'Anomalies' }));
    fireEvent.click(screen.getByText('More settings'));
    fireEvent.click(screen.getByRole('switch', { name: 'Promo Cards' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));

    await waitFor(() =>
      expect(mocks.api.configureRoom).toHaveBeenCalledWith(
        'room-1',
        0,
        expect.objectContaining({
          options: expect.objectContaining({
            playerCount: 2,
            undoAllowed: true,
            promoCardsEnabled: false,
            alienModulesEnabled: expect.objectContaining({ 1: false }),
          }),
        }),
      ),
    );
    const [, , setup] = mocks.api.configureRoom.mock.calls[0] as [
      string,
      number,
      { options: Record<string, unknown> },
    ];
    expect(setup.options).toHaveProperty('autoStartWhenFull', true);
    expect(setup.options).toHaveProperty('spectateLevel', 'ALL');
    expect(setup.options).not.toHaveProperty('stepByStepCardResolution');
  });

  it('creates a named password room and exposes owner room controls', async () => {
    renderWithQuery(<PlatformLobbyPage gameId='seti' />);

    expect(await screen.findByText('Open rooms')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('platform-open-create-room'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Room name'), {
      target: { value: 'Mission Alpha' },
    });
    fireEvent.change(within(dialog).getByLabelText('Password'), {
      target: { value: 'room-secret' },
    });
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Create room' }),
    );
    await waitFor(() =>
      expect(mocks.api.createRoom).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Mission Alpha',
          password: 'room-secret',
        }),
      ),
    );

    cleanup();
    mocks.api.getRoom.mockResolvedValue({
      ...room(),
      name: 'Mission Alpha',
      metadata: {
        passwordProtected: true,
        capacity: 4,
        reservations: [],
      },
    });
    renderWithQuery(<PlatformRoomPage />);
    expect(await screen.findByText('Mission Alpha')).toBeInTheDocument();
    expect(screen.getByText('Password protected')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Rename room' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Rename room' }), {
      target: { value: 'Mission Beta' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save room name' }));
    await waitFor(() =>
      expect(mocks.api.renameRoom).toHaveBeenCalledWith(
        'room-1',
        0,
        'Mission Beta',
      ),
    );
  });

  it('joins a password protected public room with the entered password', async () => {
    useAuthStore.setState({
      token: 'token',
      user: {
        id: 'player-3',
        name: 'Player Three',
        email: 'three@example.com',
      },
      isAuthenticated: true,
      isRestoring: false,
    });
    mocks.api.getRoom.mockResolvedValue({
      ...room(),
      metadata: {
        passwordProtected: true,
        capacity: 4,
        reservations: [],
      },
    });
    renderWithQuery(<PlatformRoomPage />);
    expect(await screen.findByText('Password protected')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Room password'), {
      target: { value: 'room-secret' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Join with password' }));
    await waitFor(() =>
      expect(mocks.api.joinRoom).toHaveBeenCalledWith('room-1', 0, {
        password: 'room-secret',
        color: 'purple',
      }),
    );
  });

  it('keeps invite, reservation, kick, color, and delete actions on platform revisions', async () => {
    renderWithQuery(<PlatformRoomPage />);

    expect(await screen.findByText('Platform room')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Invite' }));
    await waitFor(() =>
      expect(mocks.api.inviteToRoom).toHaveBeenCalledWith(
        'room-1',
        0,
        'friend-1',
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reserve seat' }));
    await waitFor(() =>
      expect(mocks.api.inviteToRoom).toHaveBeenCalledWith(
        'room-1',
        0,
        'friend-1',
        expect.stringContaining('platform:room-1:seat:'),
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove Player Two' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(mocks.api.kickRoomMember).toHaveBeenCalledWith(
        'room-1',
        0,
        'player-2',
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Orange' }));
    await waitFor(() =>
      expect(mocks.api.setRoomColor).toHaveBeenCalledWith(
        'room-1',
        0,
        'orange',
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delete room' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete room' })[1]);
    await waitFor(() =>
      expect(mocks.api.deleteRoom).toHaveBeenCalledWith('room-1', 0),
    );
  });
});
