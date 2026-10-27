import { describe, expect, it } from 'vitest';
import {
  assertGameServiceDescription,
  GAME_SERVICE_DESCRIPTION_VERSION,
  type GameServiceDescription,
} from '../src/index.js';

const schema = {
  name: 'fixture.setup',
  version: 1,
  schema: {
    type: 'object' as const,
    properties: {
      seed: { type: 'string' as const },
    },
    required: ['seed'],
    additionalProperties: false,
  },
};

const description: GameServiceDescription = {
  schemaVersion: GAME_SERVICE_DESCRIPTION_VERSION,
  platformId: 'platform-1',
  gameId: 'fixture',
  releaseId: 'fixture-v1',
  backendBindingId: 'backend-1',
  storageBindingId: 'storage-1',
  ownershipEpoch: 'epoch-1',
  metadata: {
    gameId: 'fixture',
    name: 'Fixture game',
    description: 'A fixture game.',
    themeId: 'fixture-theme',
  },
  modes: [
    {
      id: 'room',
      entry: 'room',
      minPlayers: 2,
      maxPlayers: 4,
      history: 'summary-and-replay',
      platformRating: false,
      concurrency: 'revision',
    },
  ],
  setupSchema: schema,
  replay: {
    manifestQuery: { type: 'replayManifest', eventLimit: 200 },
    framesQueryType: 'replayFrames',
  },
  commands: [
    {
      key: 'undo',
      operation: 'undo',
      inputSchema: schema,
    },
  ],
  controllers: {
    hotseat: true,
    automation: [
      {
        id: 'fixture-ai',
        kind: 'ai',
        label: 'Fixture AI',
        optionsSchema: schema,
        defaultOptions: { seed: 'default' },
        presets: [
          { id: 'default', label: 'Default', options: { seed: 'preset' } },
        ],
      },
    ],
  },
};

describe('game service descriptions', () => {
  it('accepts the JSON-only runtime contract and exports version one', () => {
    expect(() => assertGameServiceDescription(description)).not.toThrow();
    expect(GAME_SERVICE_DESCRIPTION_VERSION).toBe(1);
  });

  it('rejects unknown fields, identity mismatches and duplicate entries', () => {
    expect(() =>
      assertGameServiceDescription({
        ...description,
        endpoint: 'https://game',
      }),
    ).toThrow();
    expect(() =>
      assertGameServiceDescription({
        ...description,
        metadata: { ...description.metadata, gameId: 'other-game' },
      }),
    ).toThrow();
    expect(() =>
      assertGameServiceDescription({
        ...description,
        modes: [description.modes[0], description.modes[0]],
      }),
    ).toThrow();
    expect(() =>
      assertGameServiceDescription({
        ...description,
        commands: [description.commands![0], description.commands![0]],
      }),
    ).toThrow();
  });

  it('rejects non-JSON values and invalid controller descriptions', () => {
    expect(() =>
      assertGameServiceDescription({
        ...description,
        replay: { manifestQuery: () => null, framesQueryType: 'replayFrames' },
      }),
    ).toThrow();
    expect(() =>
      assertGameServiceDescription({
        ...description,
        controllers: {
          hotseat: true,
          automation: [
            {
              ...description.controllers!.automation[0],
              presets: [
                description.controllers!.automation[0].presets![0],
                description.controllers!.automation[0].presets![0],
              ],
            },
          ],
        },
      }),
    ).toThrow();
    expect(() =>
      assertGameServiceDescription({
        ...description,
        platformId: 'x'.repeat(257),
      }),
    ).toThrow();
  });

  it('bounds metadata descriptions and the serialized service description', () => {
    expect(() =>
      assertGameServiceDescription({
        ...description,
        metadata: {
          ...description.metadata,
          description: 'x'.repeat(4_097),
        },
      }),
    ).toThrow();
    expect(() =>
      assertGameServiceDescription({
        ...description,
        replay: {
          manifestQuery: 'x'.repeat(256 * 1024),
          framesQueryType: 'replayFrames',
        },
      }),
    ).toThrow();
  });
});
