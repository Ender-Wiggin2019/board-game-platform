import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReleaseManifest } from '@board-game/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  digestArtifact,
  packRelease,
  verifyPackedRelease,
} from '../src/release.js';

const roots: string[] = [];
const artifact = { artifactId: 'a', digest: `sha256:${'0'.repeat(64)}` };
const manifest: ReleaseManifest = {
  manifestVersion: '1.0',
  gameId: 'test',
  releaseId: 'r1',
  displayVersion: '1.0',
  publisherId: 'test',
  integration: {
    profile: 'native-module-v1',
    protocolMajor: 1,
    requiredFeatures: [],
  },
  artifacts: {
    client: artifact,
    server: artifact,
    publicAssets: artifact,
    privateContent: artifact,
  },
  versions: {
    ruleset: 'r1',
    content: 'c1',
    stateSchema: 1,
    viewSchema: 1,
    commandSchema: 1,
    resultSchema: 1,
    eventSchema: 1,
  },
  capabilities: { minPlayers: 1, maxPlayers: 1, features: [] },
  modes: [
    {
      id: 'solo',
      entry: 'direct-solo',
      minPlayers: 1,
      maxPlayers: 1,
      history: 'progress-only',
      platformRating: false,
      concurrency: 'revision',
    },
  ],
  presentation: {
    mount: 'platform-route',
    layoutProfile: 'board',
    locales: ['en-US'],
  },
  budgetProfile: 'test',
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'bgp-release-'));
  roots.push(root);
  const sources = {
    client: join(root, 'client'),
    server: join(root, 'server'),
    publicAssets: join(root, 'assets'),
    privateContent: join(root, 'content'),
  };
  for (const [key, directory] of Object.entries(sources)) {
    await mkdir(directory);
    await writeFile(join(directory, 'data.txt'), `${key}-bytes`);
  }
  return { root, sources, output: join(root, 'packed') };
}
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

describe('release packing and validation', () => {
  it('separates private artifacts, computes real digests, verifies bytes, and rejects tampering', async () => {
    const { sources, output } = await fixture();
    const packed = await packRelease(manifest, sources, output);
    expect(packed.artifacts.server.digest).not.toBe(artifact.digest);
    expect(await verifyPackedRelease(output)).toEqual(packed);
    expect(
      await readFile(join(output, 'private/server/data.txt'), 'utf8'),
    ).toBe('server-bytes');
    await writeFile(join(output, 'public/client/data.txt'), 'tampered');
    await expect(verifyPackedRelease(output)).rejects.toThrow(
      'digest mismatch',
    );
  });
  it('does not overwrite existing output or traverse symlinks into private files', async () => {
    const { sources, output } = await fixture();
    await mkdir(output);
    await writeFile(join(output, 'keep'), 'existing');
    await expect(packRelease(manifest, sources, output)).rejects.toThrow();
    expect(await readFile(join(output, 'keep'), 'utf8')).toBe('existing');
    await symlink(
      join(sources.server, 'data.txt'),
      join(sources.client, 'linked'),
    );
    await expect(digestArtifact(sources.client)).rejects.toThrow('symlinks');
  });
  it('rejects accidental environment inclusion and output inside an input tree', async () => {
    const { sources, output } = await fixture();
    await expect(
      packRelease(manifest, sources, join(sources.client, 'out')),
    ).rejects.toThrow('inside');
    await writeFile(join(sources.client, '.env.local'), 'private');
    await expect(packRelease(manifest, sources, output)).rejects.toThrow(
      'credentials',
    );
    await expect(readFile(join(output, 'release.json'))).rejects.toThrow();
  });
});
