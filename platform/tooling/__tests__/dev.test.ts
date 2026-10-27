import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { loadDevelopmentGame } from '../src/dev.js';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

describe('bgp dev', () => {
  it('loads a public server export and starts a real memory Host', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bgp-dev-cli-'));
    roots.push(root);
    const client = join(root, 'packages', 'ui');
    const server = join(root, 'runtime', 'server');
    await mkdir(join(client, 'dist'), { recursive: true });
    await mkdir(join(server, 'dist'), { recursive: true });
    await writeFile(
      join(client, 'package.json'),
      JSON.stringify({
        name: '@board-games/dev-cli-client',
        exports: { '.': './dist/index.js' },
      }),
    );
    await writeFile(
      join(client, 'dist/index.js'),
      'export const client = true;\n',
    );
    await writeFile(
      join(server, 'package.json'),
      JSON.stringify({
        name: '@board-games/dev-cli-server',
        exports: { '.': './dist/index.js' },
      }),
    );
    await writeFile(join(server, 'dist/index.js'), developmentServerSource());
    await writeFile(
      join(root, 'game.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'dev-cli',
        title: 'Development CLI',
        client: { package: '@board-games/dev-cli-client', export: '.' },
        server: { package: '@board-games/dev-cli-server', export: '.' },
        status: 'ready',
      }),
    );

    const captured = captureOutput();
    try {
      await runCli(['dev', '.', '--once', '--workspace', root]);
    } finally {
      captured.restore();
    }
    expect(JSON.parse(captured.value())).toMatchObject({
      started: true,
      mode: 'development',
      gameId: 'dev-cli',
      releaseId: 'dev-cli-v1',
      accounts: expect.arrayContaining([
        expect.objectContaining({ principalId: 'player1', role: 'player' }),
      ]),
      description: {
        platformId: 'development',
        gameId: 'dev-cli',
        releaseId: 'dev-cli-v1',
      },
    });
    expect(await readFile(join(server, 'dist/index.js'), 'utf8')).not.toContain(
      'board-game-utopia',
    );
  });

  it('detects a native export when Node cannot import the client CSS', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bgp-dev-native-detect-'));
    roots.push(root);
    const client = join(root, 'packages', 'ui');
    const server = join(root, 'runtime', 'server');
    await mkdir(join(client, 'dist'), { recursive: true });
    await mkdir(join(server, 'dist'), { recursive: true });
    await writeFile(
      join(client, 'package.json'),
      JSON.stringify({
        name: '@board-games/native-detect-client',
        exports: { '.': './dist/index.js' },
      }),
    );
    await writeFile(
      join(client, 'dist/index.js'),
      "import './styles.css';\nexport const brassGameClient = { gameId: 'native-detect', entry: {} };\n",
    );
    await writeFile(join(client, 'dist/styles.css'), '.native-detect {}\n');
    await writeFile(
      join(server, 'package.json'),
      JSON.stringify({
        name: '@board-games/native-detect-server',
        exports: { '.': './dist/index.js' },
      }),
    );
    await writeFile(
      join(server, 'dist/index.js'),
      developmentServerSource().replaceAll('dev-cli', 'native-detect'),
    );
    await writeFile(
      join(root, 'game.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'native-detect',
        title: 'Native Detection',
        client: {
          package: '@board-games/native-detect-client',
          export: '.',
        },
        server: {
          package: '@board-games/native-detect-server',
          export: '.',
        },
        status: 'ready',
      }),
    );

    const loaded = await loadDevelopmentGame(root, root);
    expect(loaded.nativeClientAvailable).toBe(true);
  });
});

function captureOutput() {
  const originalWrite = process.stdout.write;
  let output = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  return {
    value: () => output,
    restore: () => {
      process.stdout.write = originalWrite;
    },
  };
}

function developmentServerSource(): string {
  return `export const server = {
  manifest: { gameId: 'dev-cli', releaseId: 'dev-cli-v1' },
  module: {
    gameId: 'dev-cli',
    releaseId: 'dev-cli-v1',
    stateSchemaVersion: 1,
    viewSchemaVersion: 1,
    modes: [{ id: 'room', entry: 'room', minPlayers: 1, maxPlayers: 1, history: 'summary-and-replay', platformRating: false, concurrency: 'revision' }],
    schemas: {
      setup: { name: 'dev-cli.setup', version: 1, schema: { type: 'object', additionalProperties: true } },
      command: { name: 'dev-cli.command', version: 1, schema: { type: 'object', additionalProperties: true } },
      query: { name: 'dev-cli.query', version: 1, schema: { type: 'object', additionalProperties: true } },
    },
    rules: {
      create: (_setup, context) => ({ count: 0, playerId: context.participants[0]?.principalId ?? 'player1' }),
      execute: (state, command) => command.type === 'increment'
        ? { ok: true, state: { ...state, count: state.count + 1 }, events: [] }
        : { ok: false, error: { code: 'INVALID', messageKey: 'dev-cli.invalid' } },
      project: (state) => ({ count: state.count }),
      projectEvent: () => null,
      encode: (state) => state,
      decode: (saved) => saved,
    },
    turn: () => null,
    summarize: (state) => ({ count: state.count }),
    collectFacts: () => [],
    result: (state) => ({ kind: 'solo', participantIds: [state.playerId], outcome: 'completed', score: state.count }),
    completion: () => ({ finished: false }),
  },
  services: {},
};
`;
}
