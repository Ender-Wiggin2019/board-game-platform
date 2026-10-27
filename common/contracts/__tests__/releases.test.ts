import { describe, expect, it } from 'vitest';
import {
  assertReleaseManifest,
  publicReleaseManifest,
  type ReleaseManifest,
} from '../src/releases.js';

const artifact = { artifactId: 'build-1', digest: `sha256:${'a'.repeat(64)}` };
const manifest: ReleaseManifest = {
  manifestVersion: '1.0',
  gameId: 'fixture',
  releaseId: 'v1',
  displayVersion: '1.0.0',
  publisherId: 'first-party',
  integration: {
    profile: 'native-module-v1',
    protocolMajor: 1,
    requiredFeatures: ['session-lifecycle-v1'],
  },
  artifacts: {
    client: artifact,
    server: { ...artifact, artifactId: 'secret-server' },
    publicAssets: artifact,
    privateContent: { ...artifact, artifactId: 'secret-content' },
  },
  versions: {
    ruleset: '1',
    content: '1',
    stateSchema: 1,
    viewSchema: 1,
    commandSchema: 1,
    resultSchema: 1,
    eventSchema: 1,
  },
  capabilities: {
    minPlayers: 1,
    maxPlayers: 4,
    features: ['stats', 'ranking', 'replay'],
  },
  modes: [
    {
      id: 'solo',
      entry: 'direct-solo',
      minPlayers: 1,
      maxPlayers: 1,
      concurrency: 'revision',
      history: 'progress-only',
      platformRating: false,
    },
  ],
  presentation: {
    mount: 'platform-route',
    layoutProfile: 'board',
    locales: ['zh-CN', 'en-US'],
  },
  budgetProfile: 'turn-based-standard-v1',
};

describe('immutable release manifests', () => {
  it('requires version 1.1 for a standalone client runtime while retaining 1.0', () => {
    const clientRuntime = {
      abiVersion: 'board-game-react18-v1',
      format: 'esm',
      entry: 'entry.js',
      exportName: 'gameClientRelease',
      styles: [],
      shared: [{ specifier: 'react', version: '18.3.1' }],
    };
    expect(() =>
      assertReleaseManifest({
        ...manifest,
        manifestVersion: '1.1',
        clientRuntime,
      }),
    ).not.toThrow();
    expect(() =>
      assertReleaseManifest({ ...manifest, clientRuntime }),
    ).toThrow();
    expect(() =>
      assertReleaseManifest({ ...manifest, manifestVersion: '1.1' }),
    ).toThrow();
  });
  it('validates real digests and rejects deployment credentials and invalid capability claims', () => {
    expect(() => assertReleaseManifest(manifest)).not.toThrow();
    for (const invalid of [
      {
        ...manifest,
        artifacts: {
          ...manifest.artifacts,
          server: { ...artifact, digest: 'example-sha256' },
        },
      },
      { ...manifest, hostUrl: 'https://internal.example' },
      { ...manifest, trusted: true },
      {
        ...manifest,
        integration: { ...manifest.integration, protocolMajor: 2 },
      },
      { ...manifest, modes: [manifest.modes[0], manifest.modes[0]] },
      {
        ...manifest,
        capabilities: { ...manifest.capabilities, minPlayers: 2 },
      },
    ])
      expect(() => assertReleaseManifest(invalid)).toThrow();
  });

  it('exposes only approved and available features/modes without private artifact identity', () => {
    const projected = publicReleaseManifest(manifest, {
      approvedFeatures: ['stats', 'ranking'],
      runtimeFeatures: ['stats', 'replay'],
      approvedModes: ['solo'],
      runtimeModes: ['solo'],
    });
    expect(projected.capabilities.features).toEqual(['stats']);
    expect(projected.modes).toHaveLength(1);
    expect(JSON.stringify(projected)).not.toContain('secret-');
    projected.modes.splice(0);
    expect(manifest.modes).toHaveLength(1);
    expect(
      publicReleaseManifest(manifest, {
        approvedFeatures: [],
        runtimeFeatures: ['ranking'],
        approvedModes: [],
        runtimeModes: ['solo'],
      }).modes,
    ).toEqual([]);
  });
});
