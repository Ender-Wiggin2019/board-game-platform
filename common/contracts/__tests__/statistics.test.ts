import { describe, expect, it } from 'vitest';
import {
  assertGameServiceStatisticsDescription,
  assertGameStatisticsServiceRequest,
  assertGameStatisticsServiceResponse,
} from '../src/index.js';

const schema = {
  name: 'statistics.query',
  version: 1,
  schema: {
    type: 'object' as const,
    properties: { range: { type: 'string' as const } },
    required: ['range'],
    additionalProperties: false,
  },
};

const description = {
  protocolVersion: 1 as const,
  operations: [
    {
      key: 'personalSummary',
      audience: 'self' as const,
      requestSchema: schema,
      responseSchema: {
        ...schema,
        name: 'statistics.response',
        schema: {
          type: 'object' as const,
          properties: { total: { type: 'integer' as const, minimum: 0 } },
          required: ['total'],
          additionalProperties: false,
        },
      },
    },
  ],
};

const request = {
  protocolVersion: 1 as const,
  route: {
    gameId: 'seti',
    releaseId: 'seti-v2',
    backendBindingId: 'seti-backend-v2',
    storageBindingId: 'seti-storage-v2',
    ownershipEpoch: 'seti-owner-v2',
  },
  operation: 'personalSummary',
  audience: 'self' as const,
  accessContext: {
    principalId: 'principal-1',
    scopes: ['statistics:read'],
    authEpoch: 'epoch-1',
  },
  query: { range: '30d' },
};

describe('native statistics contracts', () => {
  it('accepts strict descriptors and service payloads', () => {
    expect(() =>
      assertGameServiceStatisticsDescription(description),
    ).not.toThrow();
    expect(() => assertGameStatisticsServiceRequest(request)).not.toThrow();
    expect(() =>
      assertGameStatisticsServiceResponse({
        operation: 'personalSummary',
        audience: 'self',
        payload: { total: 4 },
      }),
    ).not.toThrow();
  });

  it('rejects unknown fields, duplicate operations, and identity forgery', () => {
    expect(() =>
      assertGameServiceStatisticsDescription({
        ...description,
        operations: [description.operations[0], description.operations[0]],
      }),
    ).toThrow();
    expect(() =>
      assertGameServiceStatisticsDescription({
        ...description,
        extra: true,
      }),
    ).toThrow();
    expect(() =>
      assertGameStatisticsServiceRequest({
        ...request,
        route: { ...request.route, unexpected: 'binding' },
      }),
    ).toThrow();
    expect(() =>
      assertGameStatisticsServiceRequest({
        ...request,
        accessContext: {
          ...request.accessContext,
          principalId: undefined,
        },
      }),
    ).toThrow();
  });

  it('bounds query and response JSON', () => {
    expect(() =>
      assertGameStatisticsServiceRequest({
        ...request,
        query: { range: 'x'.repeat(256 * 1024) },
      }),
    ).toThrow();
    expect(() =>
      assertGameStatisticsServiceResponse({
        operation: 'personalSummary',
        audience: 'self',
        payload: 'x'.repeat(512 * 1024),
      }),
    ).toThrow();
  });
});
