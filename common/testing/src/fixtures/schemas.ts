import type { GameSchemas } from '@board-game/sdk';

const anyObject = {
  type: 'object' as const,
  additionalProperties: true as const,
};

export function fixtureSchemas(): GameSchemas {
  return {
    setup: { name: 'fixture.setup', version: 1, schema: anyObject },
    command: { name: 'fixture.command', version: 1, schema: anyObject },
    result: { name: 'fixture.result', version: 1, schema: anyObject },
  };
}
