import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

export type InitProfile =
  | 'native-module'
  | 'legacy-service'
  | 'integrated-game';

export interface InitResult {
  readonly directory: string;
  readonly profile: InitProfile;
  readonly files: readonly string[];
}

function projectId(directory: string): string {
  const name = basename(directory)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return name || 'board-game';
}

function packageJson(id: string): string {
  return `${JSON.stringify(
    {
      name: id,
      version: '0.1.0',
      private: true,
      type: 'module',
      scripts: {
        build: 'tsc -p tsconfig.json',
        typecheck: 'tsc -p tsconfig.json --noEmit',
      },
      dependencies: { '@board-game/sdk': '^0.1.0' },
    },
    null,
    2,
  )}\n`;
}

const tsconfig = `${JSON.stringify(
  {
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      skipLibCheck: true,
      isolatedModules: true,
      verbatimModuleSyntax: true,
      declaration: true,
      rootDir: 'src',
      outDir: 'dist',
    },
    include: ['src/**/*.ts'],
  },
  null,
  2,
)}\n`;

function nativeSource(id: string): string {
  return `import {
  defineGame,
  sequentialTurn,
  type GameModule,
  type Transition,
} from '@board-game/sdk';
import type { Actor, JsonValue, Viewer } from '@board-game/sdk';

type Setup = Record<string, never>;
type Command = { readonly type: 'noop' };
type Event = { readonly type: 'noop' };
type Query = null;
type Answer = null;

interface State {
  readonly revision: number;
  readonly participants: readonly {
    readonly principalId: string;
    readonly seatId: string;
  }[];
}

type View = {
  readonly status: 'active';
  readonly revision: number;
};

const objectSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
} as const;

const rules: GameModule<
  State,
  Setup,
  Command,
  View,
  Event,
  Query,
  Answer
>['rules'] = {
  create: (_setup, context) => ({
    revision: 0,
    participants: context.participants
      .filter((actor) => actor.kind === 'player')
      .map((actor, index) => ({
        principalId: actor.principalId,
        seatId: actor.seatId ?? \`seat-\${index + 1}\`,
      })),
  }),
  execute: (
    state,
    command,
    context,
  ): Transition<State, Event> => {
    const active = state.participants[state.revision % state.participants.length];
    if (context.actor.kind !== 'player' || context.actor.principalId !== active?.principalId)
      return { ok: false, error: { code: 'FORBIDDEN', messageKey: 'game.turn.inactive' } };
    if (command.type !== 'noop')
      return {
        ok: false,
        error: { code: 'INVALID_COMMAND', messageKey: 'game.command.invalid' },
      };
    return {
      ok: true,
      state: { ...state, revision: state.revision + 1 },
      events: [{ type: 'noop' }],
    };
  },
  project: (state, _viewer: Viewer): View => ({
    status: 'active',
    revision: state.revision,
  }),
  projectEvent: (event: Event, _viewer: Viewer): JsonValue => event,
  encode: (state): JsonValue => ({
    revision: state.revision,
    participants: state.participants.map((participant) => ({ ...participant })),
  }),
  decode: (saved): State => saved as unknown as State,
};

export const game = defineGame({
  gameId: '${id}',
  releaseId: '${id}-development',
  stateSchemaVersion: 1,
  viewSchemaVersion: 1,
  modes: [
    {
      id: 'standard',
      entry: 'room',
      minPlayers: 1,
      maxPlayers: 4,
      history: 'summary-and-replay',
      platformRating: false,
      concurrency: 'revision',
    },
  ],
  schemas: {
    setup: {
      name: '${id}.setup',
      version: 1,
      schema: objectSchema,
    },
    command: {
      name: '${id}.command',
      version: 1,
      schema: {
        type: 'object',
        properties: { type: { type: 'string', enum: ['noop'] } },
        required: ['type'],
        additionalProperties: false,
      },
    },
  },
  rules,
  turn: (state) => sequentialTurn('turn:' + state.revision, state.participants[state.revision % state.participants.length]?.seatId ?? null),
  summarize: (state) => ({ status: 'active', revision: state.revision }),
  collectFacts: (_before, _transition) => [],
  completion: (_state) => ({ finished: false }),
});

export type NativeGameModule = typeof game;
export type NativeGameState = State;
export type NativeGameCommand = Command;
export type NativeGameSetup = Setup;
export type NativeGameView = View;
export type NativeGameEvent = Event;
export type NativeGameActor = Actor;
`;
}

function legacySource(): string {
  return `/**
 * Explicit legacy-service contract starter.
 *
 * This describes the boundary only. It does not claim that a legacy service
 * is a compatible Host, and it deliberately provides no runtime transport.
 */
export interface LegacyServiceAdapterStarter {
  readonly profile: 'legacy-service-v1';
  readonly endpoint: string;
}

export function createLegacyServiceAdapterStarter(
  endpoint: string,
): LegacyServiceAdapterStarter {
  if (!/^https?:\\/\\//u.test(endpoint))
    throw new Error('Legacy service endpoint must be an explicit HTTP URL');
  return { profile: 'legacy-service-v1', endpoint };
}

`;
}

function integratedGameJson(id: string): string {
  const title = id
    .split('-')
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ');
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      id,
      title,
      client: {
        package: `@board-games/${id}-client`,
        export: '.',
      },
      server: {
        package: `@board-games/${id}-server`,
        export: '.',
      },
      status: 'scaffold',
    },
    null,
    2,
  )}\n`;
}

function integratedPackageJson(
  id: string,
  role: 'common' | 'engine' | 'client' | 'server',
): string {
  const name = `@board-games/${id}-${role}`;
  const dependencies: Record<string, string> = {
    ...(role === 'engine'
      ? {
          '@board-game/contracts': 'workspace:*',
          '@board-game/sdk': 'workspace:*',
          [`@board-games/${id}-common`]: 'workspace:*',
        }
      : {}),
    ...(role === 'client'
      ? {
          '@board-game/client': 'workspace:*',
          '@board-game/components': 'workspace:*',
          '@board-game/contracts': 'workspace:*',
          react: '18.3.1',
          [`@board-games/${id}-common`]: 'workspace:*',
        }
      : {}),
    ...(role === 'server'
      ? {
          '@board-game/server': 'workspace:*',
          '@board-game/contracts': 'workspace:*',
          '@board-platform/server': 'workspace:*',
          [`@board-games/${id}-common`]: 'workspace:*',
          [`@board-games/${id}-engine`]: 'workspace:*',
        }
      : {}),
  };
  const devDependencies: Record<string, string> = {
    '@types/node': '^22.15.3',
    typescript: '^5.9.3',
    vitest: '^3.2.6',
    ...(role === 'client'
      ? {
          '@types/react': '18.3.28',
          '@types/react-dom': '18.3.7',
        }
      : {}),
  };
  return `${JSON.stringify(
    {
      name,
      version: '0.1.0',
      private: true,
      type: 'module',
      exports: {
        '.': {
          types: './dist/index.d.ts',
          import: './dist/index.js',
        },
      },
      scripts: {
        build: 'tsc -p tsconfig.build.json',
        typecheck: 'tsc -p tsconfig.json --noEmit',
        test: 'vitest run',
      },
      ...(Object.keys(dependencies).length > 0 ? { dependencies } : {}),
      devDependencies,
    },
    null,
    2,
  )}\n`;
}

function integratedTsConfig(
  role: 'common' | 'engine' | 'client' | 'server',
): string {
  return `${JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        lib: role === 'client' ? ['ES2022', 'DOM'] : ['ES2022'],
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        skipLibCheck: true,
        isolatedModules: true,
        verbatimModuleSyntax: true,
        forceConsistentCasingInFileNames: true,
        esModuleInterop: true,
        jsx: role === 'client' ? 'react-jsx' : undefined,
        rootDir: '.',
        outDir: 'dist',
        noEmit: true,
      },
      include: [
        'src/**/*.ts',
        ...(role === 'client' ? ['src/**/*.tsx'] : []),
        '__tests__/**/*.ts',
      ],
    },
    null,
    2,
  )}\n`;
}

function integratedBuildTsConfig(): string {
  return `${JSON.stringify(
    {
      extends: './tsconfig.json',
      compilerOptions: {
        declaration: true,
        declarationMap: true,
        noEmit: false,
        rootDir: 'src',
        outDir: 'dist',
      },
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: ['__tests__/**/*.ts', 'dist'],
    },
    null,
    2,
  )}\n`;
}

function integratedCommonSource(id: string): string {
  return `export const GAME_ID = '${id}' as const;
export const COUNTER_TARGET = 3;
export type CounterCommand = { readonly type: 'increment' | 'undo' };
export type CounterView = {
  readonly player: { readonly principalId: string; readonly seatId: string | null; readonly displayName: string };
  readonly count: number;
  readonly target: number;
  readonly status: 'active' | 'completed';
  readonly canIncrement: boolean;
  readonly canUndo: boolean;
};
`;
}

function integratedEngineSource(id: string): string {
  return `import { defineGame, sequentialTurn, type GameModule, type JsonValue } from '@board-game/sdk';
import {
  GAME_ID, COUNTER_TARGET, type CounterCommand, type CounterView,
} from '@board-games/${id}-common';

type State = { revision: number; count: number; previous: number | null; playerId: string; seatId: string | null; displayName: string };
type Event = { type: 'changed'; count: number };
type Module = GameModule<State, Record<string, never>, CounterCommand, CounterView, Event, null, null>;

export function createCounterGame(releaseId = '${id}-development'): Module {
  return defineGame<State, Record<string, never>, CounterCommand, CounterView, Event, null, null>({
    gameId: GAME_ID,
    releaseId,
    stateSchemaVersion: 1,
    viewSchemaVersion: 1,
    modes: [{ id: 'solo', entry: 'direct-solo', minPlayers: 1, maxPlayers: 1,
      history: 'ephemeral-result', platformRating: false, concurrency: 'revision' }],
    schemas: {
      setup: { name: '${id}.setup', version: 1,
        schema: { type: 'object', properties: {}, additionalProperties: false } },
      command: { name: '${id}.command', version: 1,
        schema: { type: 'object', properties: { type: { type: 'string', enum: ['increment', 'undo'] } },
          required: ['type'], additionalProperties: false } },
    },
    rules: {
      create: (_setup, context) => {
        const player = context.participants.find((actor) => actor.kind === 'player');
        if (!player) throw new Error('A player is required');
        return { revision: 0, count: 0, previous: null, playerId: player.principalId,
          seatId: player.seatId ?? null, displayName: player.publicProfile?.displayName ?? 'Player' };
      },
      execute: (state, command, context) => {
        if (context.actor.kind !== 'player' || context.actor.principalId !== state.playerId)
          return { ok: false, error: { code: 'FORBIDDEN', messageKey: 'counter.playerRequired' } };
        if (state.count >= COUNTER_TARGET)
          return { ok: false, error: { code: 'CLOSED', messageKey: 'counter.completed' } };
        if (command.type === 'undo') {
          if (state.previous === null)
            return { ok: false, error: { code: 'NO_UNDO', messageKey: 'counter.noUndo' } };
          return { ok: true, state: { ...state, revision: state.revision + 1, count: state.previous, previous: null },
            events: [{ type: 'changed', count: state.previous }] };
        }
        if (command.type !== 'increment')
          return { ok: false, error: { code: 'INVALID_COMMAND', messageKey: 'counter.command' } };
        return { ok: true, state: { ...state, revision: state.revision + 1, previous: state.count, count: state.count + 1 },
          events: [{ type: 'changed', count: state.count + 1 }] };
      },
      project: (state, viewer) => ({
        player: { principalId: state.playerId, seatId: state.seatId, displayName: state.displayName },
        count: state.count, target: COUNTER_TARGET,
        status: state.count >= COUNTER_TARGET ? 'completed' : 'active',
        canIncrement: viewer.principalId === state.playerId && state.count < COUNTER_TARGET,
        canUndo: viewer.principalId === state.playerId && state.previous !== null && state.count < COUNTER_TARGET,
      }),
      projectEvent: (event) => event,
      encode: (state) => ({ ...state }),
      decode: (saved, version) => {
        if (version !== 1 || !saved || typeof saved !== 'object' || Array.isArray(saved))
          throw new Error('Unsupported counter checkpoint');
        const checkpoint = saved as { readonly [key: string]: JsonValue };
        const revision = checkpoint.revision;
        const count = checkpoint.count;
        const previous = checkpoint.previous;
        const playerId = checkpoint.playerId;
        const seatId = checkpoint.seatId;
        const displayName = checkpoint.displayName;
        if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0
          || typeof count !== 'number' || !Number.isInteger(count)
          || count < 0 || count > COUNTER_TARGET || typeof playerId !== 'string'
          || (seatId !== null && typeof seatId !== 'string') || typeof displayName !== 'string'
          || (previous !== null && (typeof previous !== 'number' || !Number.isInteger(previous)
            || previous < 0 || previous >= count)))
          throw new Error('Unsupported counter checkpoint');
        return { revision, count, previous, playerId, seatId, displayName };
      },
    },
    turn: (state) => state.count >= COUNTER_TARGET ? null : sequentialTurn('turn:' + state.revision, state.seatId),
    summarize: (state) => ({ count: state.count, target: COUNTER_TARGET }),
    collectFacts: () => [],
    completion: (state) => ({ finished: state.count >= COUNTER_TARGET }),
  });
}
`;
}

function integratedClientSource(id: string): string {
  return `import { createElement } from 'react';
import {
  defineGameClient, defineGameComponent, GameActionBar, GameTable, type GameFramePresentationProps,
} from '@board-game/components';
import '@board-game/components/layout.css';
import { GAME_ID, type CounterCommand, type CounterView } from '@board-games/${id}-common';

function Presentation({ slot, session }: GameFramePresentationProps<CounterView, CounterCommand, null, null, CounterView>) {
  if (slot === 'loading') return createElement('p', null, 'Loading session…');
  if (slot === 'error' || slot === 'action')
    return createElement('button', { onClick: () => void session.resume().catch(() => undefined) }, 'Refresh session');
  if (slot === 'reconnecting') return createElement('p', null, 'Reconnecting…');
  return null;
}

const CounterLive = defineGameComponent<'live', CounterCommand, null, null, CounterView, CounterView>({
  mode: 'live',
  session: {},
  project: ({ snapshot }) => snapshot?.payload,
  frame: {
    project: ({ entry, model }) => ({ sessionStatus: model?.status ?? entry.status,
      players: model ? [{ ...model.player, connection: 'unknown', needsAttention: model.status === 'active' }] : [] }),
    Presentation,
  },
  render: ({ entry, session, model, frame }) => {
    if (!session || !model) return null;
    const submit = async (type: CounterCommand['type']) => {
      const snapshot = session.state.snapshot;
      if (!snapshot || entry.readOnly || frame?.state.actionsDisabled) return false;
      const result = await session.submitCommand({ commandId: crypto.randomUUID(), command: { type },
        precondition: type === 'undo' ? { kind: 'revision', expectedRevision: snapshot.revision }
          : snapshot.actionPrecondition ?? { kind: 'revision', expectedRevision: snapshot.revision } });
      return result.receipt.status === 'accepted' || result.receipt.status === 'duplicate';
    };
    const disabled = entry.readOnly || frame?.state.actionsDisabled === true;
    return createElement(GameTable, {
      players: frame?.players ?? [],
      board: createElement('p', null, model.count + ' / ' + model.target),
      actions: createElement(GameActionBar, {
        disabled,
        status: model.status === 'completed' ? 'Complete' : 'Your turn',
        actions: model.status === 'completed' ? [] : [
          { id: 'increment', label: 'Add one', kind: 'primary', disabled: !model.canIncrement, onAction: () => submit('increment') },
          { id: 'undo', label: 'Undo', kind: 'undo', disabled: !model.canUndo, onAction: () => submit('undo') },
        ],
      }),
    });
  },
});

export const gameClient = defineGameClient({
  gameId: GAME_ID,
  metadata: { nameKey: 'Counter example' },
  capabilities: { directSolo: true, replay: false },
  setup: { default: () => ({}), getPlayerCount: () => 1, updatePlayerCount: (setup) => setup },
  entry: { loadLive: async () => ({ default: CounterLive }) },
});
`;
}

function integratedServerSource(id: string): string {
  return `import { defineCommandService, defineGameServer } from '@board-game/server';
import { contractError } from '@board-game/contracts';
import { GAME_ID, type CounterCommand } from '@board-games/${id}-common';
import { createCounterGame } from '@board-games/${id}-engine';
import { PlatformIdentity } from '@board-platform/server/platform/PlatformIdentity.js';
import type { PlatformApplicationRuntime } from '@board-platform/server/platform/PlatformApplicationRuntime.js';
import { installPlatformGameServer } from '@board-platform/server/platform/GameServerInstaller.js';

export function createGameServer(releaseId = '${id}-development') {
  return defineGameServer({
    manifest: { gameId: GAME_ID, releaseId },
    module: createCounterGame(releaseId),
    services: {
      commands: [defineCommandService<null, CounterCommand>({
        key: 'undo', operation: 'undo',
        parse: (input) => {
          if (input !== null) throw contractError('INVALID_REQUEST', 'counter.undoInput');
          return null;
        },
        toCommand: () => ({ type: 'undo' }),
      })],
    },
  });
}

/** Call from this game's Nest provider; the application only imports this server entry. */
export function registerGame(platform: PlatformApplicationRuntime, releaseId = '${id}-development') {
  const definition = createGameServer(releaseId);
  return installPlatformGameServer(defineGameServer({
    ...definition,
    manifest: {
      ...definition.manifest,
      metadata: { gameId: GAME_ID, name: 'Counter example', description: 'A playable integration starter', themeId: GAME_ID },
      identity: new PlatformIdentity(platform.options.db, platform.admissionStore, GAME_ID),
      backendBindingId: 'embedded:' + releaseId,
      storageBindingId: GAME_ID + '-postgres-v1',
      ownershipEpoch: '1',
      capacity: () => 1,
      freezePolicy: async () => ({
        rating: null,
        validityPolicyVersion: '${id}-counter-v1',
      }),
    },
  }), { platform });
}
`;
}

function integratedTestSource(
  role: 'common' | 'engine' | 'client' | 'server',
  id: string,
): string {
  if (role === 'common')
    return `import { expect, it } from 'vitest';
import { COUNTER_TARGET } from '../src/index.js';
it('uses a finite positive completion target', () => {
  expect(Number.isSafeInteger(COUNTER_TARGET) && COUNTER_TARGET > 1).toBe(true);
});
`;
  if (role === 'engine')
    return `import { expect, it } from 'vitest';
import { createCounterGame } from '../src/index.js';
const player = { kind: 'player' as const, principalId: 'player-1', seatId: 'seat-1' };
const viewer = { principalId: player.principalId, audience: 'player', epoch: 'test' };
const game = createCounterGame();
const initial = () => game.rules.create({}, { sessionId: 'test', modeId: 'solo', seed: 'fixed', participants: [player] });
const execute = (state: ReturnType<typeof initial>, type: 'increment' | 'undo') =>
  game.rules.execute(state, { type }, { actor: player, logicalTime: 1 });
it('restores a checkpoint and undoes without changing the previous snapshot', () => {
  const before = initial();
  const changed = execute(before, 'increment');
  if (!changed.ok) throw new Error('Increment was rejected');
  const restored = game.rules.decode(game.rules.encode(changed.state), 1);
  const undone = execute(restored, 'undo');
  expect(undone).toMatchObject({ ok: true, state: { count: 0, previous: null } });
  expect(before.count).toBe(0);
  expect(restored.count).toBe(1);
});
it('rejects another actor and cannot keep incrementing after completion', () => {
  expect(game.rules.execute(initial(), { type: 'increment' }, {
    actor: { ...player, principalId: 'outsider' }, logicalTime: 1,
  }).ok).toBe(false);
  let state = initial();
  while (!game.completion(state).finished) {
    const changed = execute(state, 'increment');
    if (!changed.ok) throw new Error('Increment was rejected');
    state = changed.state;
  }
  expect(execute(state, 'increment').ok).toBe(false);
  expect(game.rules.project(state, viewer)).toMatchObject({ status: 'completed', canIncrement: false });
});
`;
  if (role === 'client')
    return `import { expect, it } from 'vitest';
import { gameClient } from '../src/index.js';
it('loads the native component while leaving unsupported replay unavailable', async () => {
  expect((await gameClient.entry.loadLive()).default).toBeTypeOf('function');
  expect(gameClient.capabilities.replay).toBe(false);
});
`;
  return `import { expect, it } from 'vitest';
import { createGameServer } from '../src/index.js';
it('pins the module to the requested release and validates undo inputs', () => {
  const server = createGameServer('test-release');
  expect(server.module.releaseId).toBe('test-release');
  const undo = server.services.commands?.[0];
  if (!undo) throw new Error('Undo registration missing');
  expect(() => undo.parse({ state: 'client-owned' })).toThrow();
  expect(undo.toCommand(undo.parse(null))).toEqual({ type: 'undo' });
});
`;
}

function integratedFiles(id: string): Map<string, string> {
  const files = new Map<string, string>([
    ['game.json', integratedGameJson(id)],
    [
      'README.md',
      `# ${id}\n\nPlayable counter integration scaffold. Build from the workspace with \`corepack pnpm game:verify games/${id}\`. Register \`gameClient\` in the browser composition and call \`registerGame(platform)\` from a game-owned server provider. The manifest stays scaffold until real rules, UI, identity policy, replay/privacy and recovery acceptance tests are implemented. This example supports one player, increment, undo and completion; it does not claim replay support.\n`,
    ],
  ]);
  const sources: Record<'common' | 'engine' | 'client' | 'server', string> = {
    common: integratedCommonSource(id),
    engine: integratedEngineSource(id),
    client: integratedClientSource(id),
    server: integratedServerSource(id),
  };
  for (const role of ['common', 'engine', 'client', 'server'] as const) {
    const directory = role;
    files.set(`${directory}/package.json`, integratedPackageJson(id, role));
    files.set(`${directory}/tsconfig.json`, integratedTsConfig(role));
    files.set(`${directory}/tsconfig.build.json`, integratedBuildTsConfig());
    files.set(`${directory}/src/index.ts`, sources[role]);
    files.set(
      `${directory}/__tests__/index.test.ts`,
      integratedTestSource(role, id),
    );
  }
  return files;
}

function readme(id: string, profile: InitProfile): string {
  if (profile === 'native-module')
    return `# ${id}\n\nNative Board Platform game-module scaffold.\n\nRun \`corepack pnpm install\` and then \`corepack pnpm run typecheck\`. Replace the placeholder rules and release identity before registering the module.\n`;
  return `# ${id}\n\nLegacy-service integration contract starter.\n\nThis profile only records the explicit legacy boundary. It does not implement a runtime adapter or claim Host compatibility. Add and test a real authenticated transport before registering a release.\n`;
}

/** Initializes a new project without installing dependencies or overwriting any path. */
export async function initializeProject(
  directory: string,
  profile: InitProfile,
): Promise<InitResult> {
  if (
    profile !== 'native-module' &&
    profile !== 'legacy-service' &&
    profile !== 'integrated-game'
  )
    throw new Error(
      'Profile must be native-module, legacy-service, or integrated-game',
    );
  const output = resolve(directory);
  const id = projectId(output);
  await mkdir(dirname(output), { recursive: true });
  try {
    await mkdir(output, { mode: 0o755 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error(`Destination already exists: ${output}`);
    throw error;
  }
  const files =
    profile === 'integrated-game'
      ? integratedFiles(id)
      : new Map<string, string>([
          ['package.json', packageJson(id)],
          ['tsconfig.json', tsconfig],
          ['README.md', readme(id, profile)],
          [
            profile === 'native-module'
              ? 'src/index.ts'
              : 'src/legacy-adapter.ts',
            profile === 'native-module' ? nativeSource(id) : legacySource(),
          ],
        ]);
  try {
    for (const [path, content] of files) {
      const target = resolve(output, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, { flag: 'wx', mode: 0o644 });
    }
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
  // A read confirms the files are present before the result becomes visible.
  for (const path of files.keys()) await readFile(resolve(output, path));
  return { directory: output, profile, files: [...files.keys()] };
}
