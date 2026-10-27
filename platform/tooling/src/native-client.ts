import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export interface NativeDevelopmentClientOptions {
  readonly gameClientEntry: string;
  readonly gameDirectory: string;
  readonly hostURL: string;
}

export interface NativeDevelopmentClient {
  readonly baseURL: string;
  close(): Promise<void>;
}

interface ViteServer {
  readonly resolvedUrls?: { readonly local?: readonly string[] };
  listen(): Promise<void>;
  close(): Promise<void>;
}

interface ViteModule {
  createServer(options: Record<string, unknown>): Promise<ViteServer>;
}

function packageRootForFile(file: string): string {
  let current = dirname(file);
  while (current !== dirname(current)) {
    if (existsSync(join(current, 'package.json'))) return realpathSync(current);
    current = dirname(current);
  }
  throw new Error(`Client entry is not inside a package: ${file}`);
}

function packageDirectoryFor(packageRoot: string, packageName: string): string {
  let current = packageRoot;
  while (true) {
    const candidate = join(current, 'node_modules', ...packageName.split('/'));
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`Package ${packageName} is not installed for ${packageRoot}`);
}

function packageImportEntry(packageRoot: string, packageName: string): string {
  const directory = packageDirectoryFor(packageRoot, packageName);
  const manifest = JSON.parse(
    readFileSync(join(directory, 'package.json'), 'utf8'),
  ) as { exports?: Record<string, unknown>; module?: string; main?: string };
  const rootExport = manifest.exports?.['.'];
  const importPath =
    rootExport && typeof rootExport === 'object' && !Array.isArray(rootExport)
      ? (rootExport as { import?: unknown }).import
      : undefined;
  const entry =
    typeof importPath === 'string'
      ? importPath
      : typeof manifest.module === 'string'
        ? manifest.module
        : manifest.main;
  if (!entry) throw new Error(`Package ${packageName} has no import entry`);
  return join(directory, entry);
}

function shellSource(): string {
  return `
const React = await import('react');
const ReactDOM = await import('react-dom/client');
const clientModule = await import('__BGP_GAME_CLIENT__');
const state = { account: null, token: null, metadata: null, room: null, session: null, route: null };
const byId = (id) => document.getElementById(id);
const output = byId('output');
const gameRoot = byId('game-root');
const accountSelect = byId('account');
const scenarioSelect = byId('scenario');
const modeSelect = byId('mode');
const setupInput = byId('setup');
const roomInput = byId('room-id');
const status = byId('status');

function show(value) {
  output.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

async function api(path, init = {}) {
  const headers = { 'content-type': 'application/json', ...(init.headers || {}) };
  if (state.token) headers.authorization = 'Bearer ' + state.token;
  const response = await fetch(path, { ...init, headers });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error?.messageKey || 'HTTP ' + response.status);
  return value;
}

function selectedAccount() {
  return accountSelect.value;
}

async function selectAccount() {
  const selected = await api('/v1/auth/select', { method: 'POST', body: JSON.stringify({ principalId: selectedAccount() }) });
  state.account = selected.account;
  state.token = selected.token;
  status.textContent = selected.account.displayName + ' · authenticated';
  await refreshRooms();
}

async function refreshRooms() {
  if (!state.token) return;
  const value = await api('/v1/rooms');
  const current = state.room && value.rooms.find((room) => room.id === state.room.id);
  if (current) state.room = current;
  byId('rooms').textContent = value.rooms.map((room) => room.id + ' · ' + room.status + ' · rev ' + room.revision).join('\\n') || 'No rooms';
}

async function createRoom() {
  const setup = JSON.parse(setupInput.value || '{}');
  const value = await api('/v1/rooms', { method: 'POST', body: JSON.stringify({ modeId: modeSelect.value, scenarioId: scenarioSelect.value || undefined, setup }) });
  state.room = value.room;
  roomInput.value = value.room.id;
  show(value);
  await refreshRooms();
}

async function joinRoom() {
  const value = await api('/v1/rooms/' + encodeURIComponent(roomInput.value) + '/join', { method: 'POST', body: JSON.stringify({ expectedRevision: state.room?.revision ?? 0 }) });
  state.room = value;
  show(value);
  await refreshRooms();
}

async function readyRoom() {
  const value = await api('/v1/rooms/' + encodeURIComponent(roomInput.value) + '/ready', { method: 'POST', body: JSON.stringify({ expectedRevision: state.room?.revision ?? 0, ready: true }) });
  state.room = value;
  show(value);
  await refreshRooms();
}

async function startRoom() {
  const value = await api('/v1/rooms/' + encodeURIComponent(roomInput.value) + '/start', { method: 'POST', body: JSON.stringify({ expectedRevision: state.room?.revision ?? 0 }) });
  state.session = value.start;
  state.route = value.start.route;
  state.room = value.room || state.room;
  show(value);
  await refreshRooms();
  await renderGame();
}

async function createRuntime() {
  const http = {
    get: async (url) => ({ data: await api(url) }),
    post: async (url, body) => ({ data: await api(url, { method: 'POST', body: JSON.stringify(body) }) }),
  };
  const transportModule = await import('@board-game/client');
  const transport = (route, seatId) => transportModule.createSessionTransport(http, {
    path: (frozenRoute, operation) => {
      const name = operation === 'commands' ? 'commands' : operation;
      const suffix = seatId ? '?seatId=' + encodeURIComponent(seatId) : '';
      return '/v1/sessions/' + encodeURIComponent(frozenRoute.sessionId) + '/' + name + suffix;
    },
  });
  return {
    http,
    session: {
      signals: { subscribeRevision: () => () => {}, setForeground: () => {}, isConnected: true },
      createTransport: transport,
      selectedSeatId: undefined,
    },
    signals: { subscribeRevision: () => () => {}, setForeground: () => {}, isConnected: true },
    viewer: {
      principalId: state.account?.principalId,
      accountPrincipalId: state.account?.principalId,
      identityKey: state.account ? 'dev:' + state.account.principalId : null,
    },
    navigation: { platformHref: '/', replayHref: () => '/' },
  };
}

async function renderGame() {
  if (!state.route) return;
  const definition = clientModule.gameClientRelease?.definition || clientModule.gameClient || Object.values(clientModule).find((value) => value && typeof value === 'object' && value.gameId && value.entry);
  if (!definition?.entry?.loadLive) throw new Error('Client export does not provide entry.loadLive');
  const loaded = await definition.entry.loadLive();
  const Component = loaded.default;
  ReactDOM.createRoot(gameRoot).render(React.createElement(Component, {
    route: state.route,
    status: 'active',
    spectate: false,
    controlledPlayerId: state.account?.principalId,
    runtime: await createRuntime(),
  }));
}

async function boot() {
  const metadata = await api('/v1/metadata');
  state.metadata = metadata;
  byId('title').textContent = metadata.metadata?.name || metadata.description?.gameId || 'Board game';
  for (const account of (await api('/v1/accounts')).accounts) {
    const option = document.createElement('option');
    option.value = account.principalId;
    option.textContent = account.displayName + ' (' + account.role + ')';
    accountSelect.append(option);
  }
  for (const mode of metadata.description.modes || []) {
    const option = document.createElement('option');
    option.value = mode.id;
    option.textContent = mode.id;
    modeSelect.append(option);
  }
  for (const scenario of (await api('/v1/scenarios')).scenarios || []) {
    const option = document.createElement('option');
    option.value = scenario.id;
    option.textContent = scenario.label || scenario.id;
    scenarioSelect.append(option);
  }
  accountSelect.addEventListener('change', () => selectAccount().catch((error) => show(error.message)));
  byId('create').addEventListener('click', () => createRoom().catch((error) => show(error.message)));
  byId('join').addEventListener('click', () => joinRoom().catch((error) => show(error.message)));
  byId('ready').addEventListener('click', () => readyRoom().catch((error) => show(error.message)));
  byId('start').addEventListener('click', () => startRoom().catch((error) => show(error.message)));
  const initialAccount = new URLSearchParams(location.search).get('account') || 'player1';
  accountSelect.value = initialAccount;
  await selectAccount();
}

globalThis.__BGP_DEV_STATE__ = state;
globalThis.__BGP_DEV_REFRESH__ = refreshRooms;
boot().catch((error) => show(error.message));
`;
}

function shellHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>bgp dev</title><style>body{font:14px system-ui;margin:0;background:#10151b;color:#e8edf2}main{max-width:1200px;margin:auto;padding:20px}button,select,input,textarea{font:inherit;margin:.25rem;padding:.4rem;background:#1d2833;color:inherit;border:1px solid #435463;border-radius:4px}textarea{width:20rem;height:3rem;vertical-align:top}pre{background:#0a0e12;padding:10px;white-space:pre-wrap;min-height:4rem}.grid{display:grid;grid-template-columns:25rem 1fr;gap:20px}#game-root{min-height:30rem}[data-game-release]{min-height:30rem}</style></head><body><main><h1 id="title">bgp dev</h1><p id="status">Connecting…</p><section><label>Account <select id="account"></select></label><label>Mode <select id="mode"></select></label><label>Scene <select id="scenario"><option value="">none</option></select></label></section><section><label>Setup <textarea id="setup">{}</textarea></label><button id="create">Create room</button><input id="room-id" placeholder="room id"><button id="join">Join</button><button id="ready">Ready</button><button id="start">Start</button></section><div class="grid"><pre id="rooms">No rooms</pre><section id="game-root"><p>Start a room to load the native game client.</p></section></div><pre id="output"></pre></main><script type="module" src="/src/main.js"></script></body></html>`;
}

async function loadVite(clientEntry: string): Promise<ViteModule> {
  const candidates = [
    createRequire(import.meta.url),
    createRequire(join(packageRootForFile(clientEntry), 'package.json')),
  ];
  let resolved: string | undefined;
  for (const resolver of candidates) {
    try {
      resolved = resolver.resolve('vite');
      break;
    } catch {
      // The published CLI owns Vite; a source game may also carry it locally.
    }
  }
  if (!resolved)
    throw new Error(
      'Vite is required for bgp dev; install it in @board-platform/cli or the game client',
    );
  return (await import(resolved)) as unknown as ViteModule;
}

export async function startNativeDevelopmentClient(
  options: NativeDevelopmentClientOptions,
): Promise<NativeDevelopmentClient> {
  const directory = await mkdtemp(join(tmpdir(), 'bgp-native-dev-'));
  await writeFile(join(directory, 'index.html'), shellHtml());
  await mkdir(join(directory, 'src'), { recursive: true });
  await writeFile(join(directory, 'src', 'main.js'), shellSource());
  const vite = await loadVite(options.gameClientEntry);
  const clientRoot = packageRootForFile(options.gameClientEntry);
  const clientRequire = createRequire(join(clientRoot, 'package.json'));
  const clientRuntimeEntry = packageImportEntry(
    clientRoot,
    '@board-game/client',
  );
  const server = await vite.createServer({
    root: directory,
    server: {
      host: '127.0.0.1',
      port: 0,
      strictPort: false,
      proxy: {
        '/v1': {
          target: options.hostURL,
          changeOrigin: true,
          headers: { origin: options.hostURL },
        },
      },
      fs: { allow: [directory, options.gameDirectory, clientRoot] },
    },
    resolve: {
      alias: [
        { find: '__BGP_GAME_CLIENT__', replacement: options.gameClientEntry },
        {
          find: 'react-dom/client',
          replacement: clientRequire.resolve('react-dom/client'),
        },
        { find: /^react$/u, replacement: clientRequire.resolve('react') },
        { find: '@board-game/client', replacement: clientRuntimeEntry },
      ],
    },
  });
  try {
    await server.listen();
    const baseURL = server.resolvedUrls?.local?.[0];
    if (!baseURL)
      throw new Error('Vite did not expose a local development URL');
    return {
      baseURL,
      close: async () => {
        await server.close();
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await server.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
