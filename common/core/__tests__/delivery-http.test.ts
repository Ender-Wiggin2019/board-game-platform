import type { MatchAdmission, SessionRoute } from '@board-game/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HttpFactIngressClient,
  HttpFactIngressServer,
  TrustedFactIngestor,
  type TrustedSourceIdentity,
} from '../src/delivery/index.js';
import { MemoryInboxStore } from '../src/inbox/memory.js';
import type { FactEnvelope } from '../src/inbox/types.js';

const route: SessionRoute = {
  gameId: 'remote-game',
  modeId: 'ranked',
  sessionId: 'remote-session-1',
  releaseId: 'remote-release-1',
  backendBindingId: 'remote-backend-1',
  storageBindingId: 'remote-storage-1',
  ownershipEpoch: 'remote-epoch-1',
};

const source: TrustedSourceIdentity = {
  gameId: route.gameId,
  releaseId: route.releaseId,
  backendBindingId: route.backendBindingId,
  ownershipEpoch: route.ownershipEpoch,
};

const admission: MatchAdmission = {
  id: 'remote-admission-1',
  route,
  participants: [
    { principalId: 'player-1', seatId: 'seat-1' },
    { principalId: 'player-2', seatId: 'seat-2' },
  ],
  visibility: 'private',
  rating: null,
  validityPolicyVersion: 'policy-1',
  createdAt: 1,
};

function fact(eventId = 'event-1'): FactEnvelope {
  return {
    producerId: `game:${route.gameId}:session:${route.sessionId}`,
    eventId,
    sessionId: route.sessionId,
    kind: 'session.completed',
    schemaVersion: 1,
    sourceRelease: route.releaseId,
    payload: { eventId },
    aggregateSequence: 1,
    occurredAt: 10,
  };
}

describe('HTTP trusted fact ingress', () => {
  const servers: HttpFactIngressServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  async function fixture() {
    const inbox = new MemoryInboxStore();
    const receiver = new TrustedFactIngestor({
      inbox,
      admission: { getAdmission: async () => admission },
      authorizeSource: () => true,
      allowedKinds: ['session.completed'],
    });
    const server = new HttpFactIngressServer({
      receiver,
      credentials: [
        { token: 'a'.repeat(32), platformId: 'platform-1', source },
      ],
      maxRequestBytes: 64 * 1024,
    });
    const address = await server.listen();
    servers.push(server);
    const client = new HttpFactIngressClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: 'a'.repeat(32),
      platformId: 'platform-1',
      source,
      allowInsecureLocalhost: true,
    });
    return { inbox, server, client };
  }

  it('requires high-entropy ingress credentials', () => {
    const receiver = {
      ingest: async () => {
        throw new Error('not reached');
      },
    };
    expect(
      () =>
        new HttpFactIngressServer({
          receiver,
          credentials: [{ token: 'short', platformId: 'platform-1', source }],
        }),
    ).toThrow('32 characters');
    expect(
      () =>
        new HttpFactIngressClient({
          baseUrl: 'https://example.test',
          token: 'short',
          platformId: 'platform-1',
          source,
        }),
    ).toThrow('32 characters');
  });

  it('ACKs only after Inbox persistence and deduplicates a retried delivery', async () => {
    const { inbox, client } = await fixture();
    const first = await client.ingest({ source, route, fact: fact() });
    expect(first.eventId).toBe('event-1');
    const repeated = await client.ingest({ source, route, fact: fact() });
    expect(repeated).toEqual(first);
    expect((await inbox.getEnvelope(first.envelopeKey))?.eventId).toBe(
      'event-1',
    );
  });

  it('keeps the body source untrusted and rejects a source/route mismatch', async () => {
    const { client } = await fixture();
    const mismatchedRoute = { ...route, releaseId: 'other-release' };
    await expect(
      client.ingest({ source, route: mismatchedRoute, fact: fact('mismatch') }),
    ).rejects.toMatchObject({
      code: 'SOURCE_UNAUTHORIZED',
    });
    const response = await fetch(`${clientUrl(client)}/v1/facts`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${'a'.repeat(32)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        protocolVersion: 1,
        platformId: 'platform-1',
        deliveries: [
          {
            route,
            fact: fact('body-source'),
            source: { ...source, releaseId: 'forged' },
          },
        ],
      }),
    });
    expect(response.status).toBe(400);
  });

  it('returns 401 for an unknown bearer token', async () => {
    const { server } = await fixture();
    const address = server.server.address();
    if (!address || typeof address === 'string')
      throw new Error('server address missing');
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/facts`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer wrong-token',
        'content-type': 'application/json',
      },
      body: '{}',
    });
    expect(response.status).toBe(401);
  });

  it('allows retry after an ACK is lost without duplicating the Inbox fact', async () => {
    const { inbox, server } = await fixture();
    const address = server.server.address();
    if (!address || typeof address === 'string')
      throw new Error('server address missing');
    let loseAck = true;
    const realFetch = globalThis.fetch;
    const client = new HttpFactIngressClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: 'a'.repeat(32),
      platformId: 'platform-1',
      source,
      allowInsecureLocalhost: true,
      fetchImpl: async (input, init) => {
        const response = await realFetch(input, init);
        if (loseAck) {
          loseAck = false;
          await response.arrayBuffer();
          throw new Error('simulated lost ACK');
        }
        return response;
      },
    });
    const delivery = { source, route, fact: fact('lost-ack') };
    await expect(client.ingest(delivery)).rejects.toThrow('lost ACK');
    const ack = await client.ingest(delivery);
    expect(ack.eventId).toBe('lost-ack');
    expect(await inbox.listPending('consumer', { limit: 10 })).toHaveLength(1);
  });

  it('does not expose an unexpected receiver error over the wire', async () => {
    const server = new HttpFactIngressServer({
      receiver: {
        ingest: async () => {
          throw new Error('postgres password and SQL statement');
        },
      },
      credentials: [
        { token: 'b'.repeat(32), platformId: 'platform-1', source },
      ],
    });
    const address = await server.listen();
    servers.push(server);
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/facts`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${'b'.repeat(32)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        protocolVersion: 1,
        platformId: 'platform-1',
        deliveries: [{ route, fact: fact('unexpected-error') }],
      }),
    });
    const body = await response.json();
    expect(body).toMatchObject({
      errors: [
        {
          code: 'FACT_REJECTED',
          message: 'Fact receiver unavailable',
          retryable: true,
        },
      ],
    });
    expect(JSON.stringify(body)).not.toContain('postgres password');
  });
});

function clientUrl(client: HttpFactIngressClient): string {
  // The test only uses this helper to exercise the raw body boundary.
  return (client as unknown as { baseUrl: URL }).baseUrl.origin;
}
