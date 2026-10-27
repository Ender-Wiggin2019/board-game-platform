import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

export interface GameInitResult {
  readonly directory: string;
  readonly gameId: string;
  readonly files: readonly string[];
}

function projectId(directory: string): string {
  const name = basename(directory)
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return name || 'board-game';
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function gameJson(id: string): string {
  const title = id
    .split('-')
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ');
  return json({
    schemaVersion: 1,
    id,
    title,
    client: { package: `@board-games/${id}-client`, export: '.' },
    server: { package: `@board-games/${id}-server`, export: '.' },
    status: 'scaffold',
  });
}

function rootPackageJson(id: string): string {
  return json({
    name: `${id}-game`,
    version: '0.1.0',
    private: true,
    type: 'module',
    scripts: {
      build:
        'pnpm --dir common build && pnpm --dir engine build && pnpm --dir server build && pnpm --dir client build',
      typecheck:
        'pnpm --dir common typecheck && pnpm --dir engine typecheck && pnpm --dir server typecheck && pnpm --dir client typecheck',
      test: 'pnpm run build && node --test test/*.test.mjs',
      dev: 'bgp dev',
    },
    devDependencies: { '@board-platform/cli': '^0.1.0' },
  });
}

function workspaceConfig(): string {
  return 'packages:\n  - common\n  - engine\n  - server\n  - client\n';
}

function packageJson(
  id: string,
  role: 'common' | 'engine' | 'server' | 'client',
): string {
  const name = `@board-games/${id}-${role}`;
  const dependencies: Record<string, string> = {};
  if (role === 'engine') {
    dependencies['@board-game/sdk'] = '^0.1.0';
    dependencies[`@board-games/${id}-common`] = 'file:../common';
  }
  if (role === 'server') {
    dependencies['@board-game/contracts'] = '^0.1.0';
    dependencies['@board-game/server'] = '^0.1.0';
    dependencies[`@board-games/${id}-common`] = 'file:../common';
    dependencies[`@board-games/${id}-engine`] = 'file:../engine';
  }
  if (role === 'client')
    Object.assign(dependencies, {
      [`@board-games/${id}-common`]: 'file:../common',
      '@board-game/client': '^0.1.0',
      '@board-game/components': '^0.1.0',
      '@board-game/contracts': '^0.1.0',
      react: '18.3.1',
      'react-dom': '18.3.1',
    });
  return json({
    name,
    version: '0.1.0',
    private: true,
    type: 'module',
    exports: {
      '.': { types: './dist/index.d.ts', import: './dist/index.js' },
    },
    scripts: {
      build: 'tsc -p tsconfig.build.json',
      typecheck: 'tsc -p tsconfig.json --noEmit',
    },
    ...(Object.keys(dependencies).length > 0 ? { dependencies } : {}),
    devDependencies: {
      typescript: '^5.9.3',
      '@types/react': '^18.3.28',
      '@types/react-dom': '^18.3.7',
    },
  });
}

function tsconfig(role: 'common' | 'engine' | 'server' | 'client'): string {
  return json({
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
    include:
      role === 'client' ? ['src/**/*.ts', 'src/**/*.tsx'] : ['src/**/*.ts'],
  });
}

function buildTsconfig(): string {
  return json({
    extends: './tsconfig.json',
    compilerOptions: { noEmit: false },
  });
}

function commonSource(id: string): string {
  return `export const GAME_ID = '${id}' as const;
export const DEFAULT_TARGET = 3;
export type CounterSetup = { readonly target?: number };
export type CounterCommand = { readonly type: 'increment' | 'undo' };
export type CounterQuery =
  | { readonly type: 'replayManifest'; readonly eventLimit: number }
  | { readonly type: 'replayFrames'; readonly from: number; readonly limit: number };
export type CounterView = {
  readonly count: number;
  readonly target: number;
  readonly status: 'active' | 'completed';
  readonly playerId: string;
  readonly canIncrement: boolean;
  readonly canUndo: boolean;
};
export type CounterEvent = { readonly type: 'changed'; readonly count: number };
export type CounterReplayAnswer = {
  readonly kind: 'manifest';
  readonly releaseId: string;
  readonly limit: number;
  readonly frames: readonly { readonly revision: number; readonly count: number }[];
} | {
  readonly kind: 'frames';
  readonly releaseId: string;
  readonly from: number;
  readonly limit: number;
  readonly frames: readonly { readonly revision: number; readonly count: number }[];
};
`;
}

function engineSource(id: string): string {
  return `import {
  defineGame,
  sequentialTurn,
  type GameModule,
  type JsonValue,
} from '@board-game/sdk';
import {
  DEFAULT_TARGET,
  GAME_ID,
  type CounterCommand,
  type CounterEvent,
  type CounterQuery,
  type CounterReplayAnswer,
  type CounterSetup,
  type CounterView,
} from '@board-games/${id}-common';

type State = {
  readonly revision: number;
  readonly count: number;
  readonly target: number;
  readonly previous: number | null;
  readonly playerIds: readonly string[];
  readonly seatIds: readonly string[];
};

type Module = GameModule<
  State,
  CounterSetup,
  CounterCommand,
  CounterView,
  CounterEvent,
  CounterQuery,
  CounterReplayAnswer
>;

function targetFromSetup(setup: CounterSetup): number {
  const target = setup.target ?? DEFAULT_TARGET;
  if (!Number.isSafeInteger(target) || target < 1 || target > 10)
    throw new Error('target must be an integer between 1 and 10');
  return target;
}

export function createCounterGame(releaseId = '${id}-development'): Module {
  return defineGame({
    gameId: GAME_ID,
    releaseId,
    stateSchemaVersion: 1,
    viewSchemaVersion: 1,
    modes: [{
      id: 'solo',
      entry: 'room',
      minPlayers: 1,
      maxPlayers: 2,
      history: 'summary-and-replay',
      platformRating: false,
      concurrency: 'revision',
    }],
    schemas: {
      setup: {
        name: '${id}.setup',
        version: 1,
        schema: {
          type: 'object',
          properties: { target: { type: 'integer', minimum: 1, maximum: 10 } },
          additionalProperties: false,
        },
      },
      command: {
        name: '${id}.command',
        version: 1,
        schema: {
          type: 'object',
          properties: { type: { type: 'string', enum: ['increment', 'undo'] } },
          required: ['type'],
          additionalProperties: false,
        },
      },
      query: {
        name: '${id}.query',
        version: 1,
        schema: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['replayManifest', 'replayFrames'] },
            eventLimit: { type: 'integer', minimum: 1, maximum: 200 },
            from: { type: 'integer', minimum: 0 },
            limit: { type: 'integer', minimum: 1, maximum: 100 },
          },
          required: ['type'],
          additionalProperties: false,
        },
      },
    },
    rules: {
      create: (setup, context): State => {
        const players = context.participants.filter((actor) => actor.kind === 'player');
        if (players.length === 0) throw new Error('A player is required');
        if (players.some((player) => !player.seatId)) throw new Error('A player seat is required');
        return {
          revision: 0,
          count: 0,
          target: targetFromSetup(setup),
          previous: null,
          playerIds: players.map((player) => player.principalId),
          seatIds: players.map((player) => player.seatId as string),
        };
      },
      execute: (state: State, command, context) => {
        if (context.actor.kind !== 'player' || !state.playerIds.includes(context.actor.principalId))
          return { ok: false, error: { code: 'FORBIDDEN', messageKey: 'counter.playerRequired' } };
        if (state.count >= state.target)
          return { ok: false, error: { code: 'CLOSED', messageKey: 'counter.completed' } };
        if (command.type === 'undo') {
          if (state.previous === null)
            return { ok: false, error: { code: 'NO_UNDO', messageKey: 'counter.noUndo' } };
          return {
            ok: true,
            state: { ...state, revision: state.revision + 1, count: state.previous, previous: null },
            events: [{ type: 'changed', count: state.previous }],
          };
        }
        return {
          ok: true,
          state: { ...state, revision: state.revision + 1, previous: state.count, count: state.count + 1 },
          events: [{ type: 'changed', count: state.count + 1 }],
        };
      },
      project: (state, viewer) => ({
        count: state.count,
        target: state.target,
        status: state.count >= state.target ? 'completed' : 'active',
        playerId: state.playerIds[0] as string,
        canIncrement: viewer.principalId !== undefined && state.playerIds.includes(viewer.principalId) && state.count < state.target,
        canUndo: viewer.principalId !== undefined && state.playerIds.includes(viewer.principalId) && state.previous !== null && state.count < state.target,
      }),
      projectEvent: (event) => event,
      query: (state: State, query): CounterReplayAnswer => {
        if (query.type === 'replayManifest')
          return { kind: 'manifest', releaseId, frames: [], limit: query.eventLimit };
        return {
          kind: 'frames',
          releaseId,
          from: query.from,
          limit: query.limit,
          frames: [{ revision: state.revision, count: state.count }],
        };
      },
      encode: (state): JsonValue => ({ ...state }),
      decode: (saved): State => {
        if (!saved || typeof saved !== 'object' || Array.isArray(saved))
          throw new Error('Unsupported counter checkpoint');
        const value = saved as Record<string, JsonValue>;
        const revision = value.revision;
        const count = value.count;
        const target = value.target;
        const previous = value.previous;
        const playerIds = value.playerIds;
        const seatIds = value.seatIds;
        const integer = (candidate: JsonValue): candidate is number =>
          typeof candidate === 'number' && Number.isSafeInteger(candidate);
        if (!integer(revision) || revision < 0 ||
          !integer(count) || count < 0 ||
          !integer(target) || target < 1 || target > 10 ||
          (previous !== null && (!integer(previous) || previous < 0 || previous >= count)) ||
          !Array.isArray(playerIds) || playerIds.length === 0 ||
          playerIds.some((playerId) => typeof playerId !== 'string') ||
          !Array.isArray(seatIds) || seatIds.length !== playerIds.length ||
          seatIds.some((seatId) => typeof seatId !== 'string'))
          throw new Error('Unsupported counter checkpoint');
        return { revision, count, target, previous, playerIds, seatIds };
      },
    },
    turn: (state) => state.count >= state.target ? null : sequentialTurn('turn:' + state.revision, state.seatIds[state.revision % state.seatIds.length] ?? null),
    summarize: (state) => ({ count: state.count, target: state.target, status: state.count >= state.target ? 'completed' : 'active' }),
    collectFacts: () => [],
    result: (state) => ({ kind: state.playerIds.length === 1 ? 'solo' : 'cooperative', participantIds: state.playerIds, outcome: 'completed', score: state.count }),
    completion: (state) => ({ finished: state.count >= state.target }),
  });
}

export const game = createCounterGame();
`;
}

function serverSource(id: string): string {
  return `import { defineGameServer } from '@board-game/server';
import { GAME_ID, type CounterCommand } from '@board-games/${id}-common';
import { createCounterGame } from '@board-games/${id}-engine';

export const game = createCounterGame();
export const server = defineGameServer({
  manifest: { gameId: GAME_ID, releaseId: game.releaseId },
  module: game,
  services: {
    replay: {
      queries: {
        manifest: (eventLimit) => ({ type: 'replayManifest', eventLimit }),
        frames: (from, limit) => ({ type: 'replayFrames', from, limit }),
      },
    },
  },
});

export const developmentScenarios = [
  {
    id: 'complete',
    label: 'Complete the counter',
    setup: { target: 3 },
    commands: [
      { principalId: 'player1', command: { type: 'increment' as CounterCommand['type'] } },
      { principalId: 'player1', command: { type: 'increment' as CounterCommand['type'] } },
      { principalId: 'player1', command: { type: 'increment' as CounterCommand['type'] } },
    ],
  },
];
`;
}

function clientSource(id: string): string {
  return `import { createElement } from 'react';
import { defineGameClient, defineGameComponent } from '@board-game/components';
import type { JsonValue } from '@board-game/contracts';
import { GAME_ID, DEFAULT_TARGET, type CounterCommand, type CounterQuery, type CounterReplayAnswer, type CounterSetup, type CounterView } from '@board-games/${id}-common';

function isView(value: JsonValue | undefined): value is CounterView {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && typeof (value as { count?: unknown }).count === 'number';
}

const CounterLive = defineGameComponent<'live', CounterCommand, CounterQuery, CounterReplayAnswer, CounterView>({
  mode: 'live',
  session: {},
  render: ({ entry, session }) => {
    const view = session?.state.snapshot?.payload;
    const model = isView(view) ? view : undefined;
    const send = (command: CounterCommand) => {
      if (!session) return;
      void session.submitAction(crypto.randomUUID(), command).catch(() => undefined);
    };
    return createElement('section', { 'data-counter-status': model?.status ?? session?.state.status ?? 'loading' },
      createElement('h2', null, GAME_ID + ' / ' + (entry.mode === 'live' ? 'live' : entry.mode)),
      createElement('p', null, model ? ('Count ' + model.count + ' / ' + model.target) : 'Loading view…'),
      createElement('p', null, model ? ('Turn: ' + model.playerId) : ''),
      createElement('button', { type: 'button', disabled: !model?.canIncrement, onClick: () => send({ type: 'increment' }) }, 'Increment'),
      createElement('button', { type: 'button', disabled: !model?.canUndo, onClick: () => send({ type: 'undo' }) }, 'Undo'),
      createElement('button', { type: 'button', onClick: () => { if (session) void session.queryOptions({ type: 'replayManifest', eventLimit: 20 }).catch(() => undefined); } }, 'Query replay'),
      createElement('pre', null, session?.state.query ? JSON.stringify(session.state.query.answer, null, 2) : ''),
    );
  },
});

const CounterReplay = defineGameComponent<'replay', CounterCommand, CounterQuery, CounterReplayAnswer, CounterView>({
  mode: 'replay',
  render: () => createElement('p', null, 'Replay is available through the host query surface.'),
});

const CounterEnd = defineGameComponent<'end', CounterCommand, CounterQuery, CounterReplayAnswer, CounterView>({
  mode: 'end',
  render: () => createElement('p', null, 'Counter complete.'),
});

export const gameClient = defineGameClient({
  gameId: GAME_ID,
  releaseId: '${id}-development',
  metadata: { nameKey: '${id}.name', descriptionKey: '${id}.description' },
  capabilities: { directSolo: true, room: true, replay: true, sessionControls: true },
  setup: {
    default: (): CounterSetup => ({ target: DEFAULT_TARGET }),
    getPlayerCount: () => 1,
    updatePlayerCount: (setup: JsonValue) => setup,
  },
  entry: {
    loadLive: async () => ({ default: CounterLive }),
    loadReplay: async () => ({ default: CounterReplay }),
    loadEnd: async () => ({ default: CounterEnd }),
  },
});
`;
}

function testSource(id: string): string {
  return `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { server } from '../server/dist/index.js';

test('counter supports setup, increment, undo, query and completion', () => {
  const player = { kind: 'player', principalId: 'player1', seatId: 'seat-1' };
  const state = server.module.rules.create({ target: 2 }, {
    sessionId: 'fixture-session', modeId: 'solo', seed: 'fixture-seed', participants: [player],
  });
  const first = server.module.rules.execute(state, { type: 'increment' }, { actor: player, logicalTime: 1 });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const undone = server.module.rules.execute(first.state, { type: 'undo' }, { actor: player, logicalTime: 2 });
  assert.equal(undone.ok, true);
  if (!undone.ok) return;
  const query = server.module.rules.query?.(undone.state, { type: 'replayManifest', eventLimit: 20 }, { principalId: player.principalId, audience: 'player', epoch: 'fixture' });
  assert.equal(query?.kind, 'manifest');
  let completed = undone.state;
  for (let index = 0; index < 2; index += 1) {
    const transition = server.module.rules.execute(completed, { type: 'increment' }, { actor: player, logicalTime: index + 3 });
    assert.equal(transition.ok, true);
    if (!transition.ok) return;
    completed = transition.state;
  }
  assert.deepEqual(server.module.completion(completed), { finished: true });
  assert.equal(server.module.result?.(completed).kind, 'solo');
});
`;
}

function readme(id: string): string {
  return `# ${id}

This is an independently runnable REST-first counter game. It owns the rule
module, server definition, setup schema, undo command, query/replay surface,
terminal result, native client component and deterministic development fixture.
The client entry is loaded by \`bgp dev\` through a Vite/HMR shell.

\`\`\`sh
corepack pnpm install
corepack pnpm run build
corepack pnpm dev
\`\`\`

The dev command starts a loopback memory Host and a native Vite client, then
prints JSON containing both URLs. It does not use Docker or production
credentials. Select one of the fixed player accounts with \`POST
/v1/auth/select\`, then use the client controls or the rooms and sessions REST
endpoints documented by the development host. One or two player accounts can
join the room; turns alternate between joined players. The \`complete\` scenario
is available from \`GET /v1/scenarios\` and can be selected when creating a room.
`;
}

function fixtureJson(): string {
  return json([
    {
      id: 'complete',
      label: 'Complete the counter',
      setup: { target: 3 },
      commands: [
        { principalId: 'player1', command: { type: 'increment' } },
        { principalId: 'player1', command: { type: 'increment' } },
        { principalId: 'player1', command: { type: 'increment' } },
      ],
    },
  ]);
}

function filesFor(id: string): Map<string, string> {
  return new Map([
    ['game.json', gameJson(id)],
    ['package.json', rootPackageJson(id)],
    ['pnpm-workspace.yaml', workspaceConfig()],
    ['README.md', readme(id)],
    ['.gitignore', 'node_modules/\ndist/\n*.tsbuildinfo\n'],
    ['common/package.json', packageJson(id, 'common')],
    ['common/tsconfig.json', tsconfig('common')],
    ['common/tsconfig.build.json', buildTsconfig()],
    ['common/src/index.ts', commonSource(id)],
    ['engine/package.json', packageJson(id, 'engine')],
    ['engine/tsconfig.json', tsconfig('engine')],
    ['engine/tsconfig.build.json', buildTsconfig()],
    ['engine/src/index.ts', engineSource(id)],
    ['server/package.json', packageJson(id, 'server')],
    ['server/tsconfig.json', tsconfig('server')],
    ['server/tsconfig.build.json', buildTsconfig()],
    ['server/src/index.ts', serverSource(id)],
    ['client/package.json', packageJson(id, 'client')],
    ['client/tsconfig.json', tsconfig('client')],
    ['client/tsconfig.build.json', buildTsconfig()],
    ['client/src/index.tsx', clientSource(id)],
    ['fixtures/scenarios.json', fixtureJson()],
    ['test/counter.test.mjs', testSource(id)],
  ]);
}

/** Creates a portable, source-owned counter game without installing dependencies. */
export async function initializeGameProject(
  directory: string,
): Promise<GameInitResult> {
  const output = resolve(directory);
  const gameId = projectId(output);
  await mkdir(dirname(output), { recursive: true });
  try {
    await mkdir(output, { mode: 0o755 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error(`Destination already exists: ${output}`);
    throw error;
  }
  const files = filesFor(gameId);
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
  for (const path of files.keys()) await readFile(resolve(output, path));
  return { directory: output, gameId, files: [...files.keys()] };
}
