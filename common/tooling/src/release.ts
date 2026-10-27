import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import {
  assertReleaseManifest,
  canonicalStableStringify,
  type ReleaseArtifact,
  type ReleaseManifest,
} from '@board-game/contracts';

export type ArtifactSources = Readonly<
  Record<'client' | 'server' | 'publicAssets', string> & {
    privateContent?: string;
  }
>;
interface ArtifactEntry {
  readonly path: string;
  readonly bytes: Buffer;
}

async function collect(
  directory: string,
  prefix = '',
): Promise<ArtifactEntry[]> {
  const root = await lstat(directory);
  if (!root.isDirectory() || root.isSymbolicLink())
    throw new Error('Artifact source must be a directory without symlinks');
  const entries: ArtifactEntry[] = [];
  for (const name of (await readdir(directory)).sort()) {
    if (
      ['.env', '.git', 'node_modules'].includes(name) ||
      name.startsWith('.env.')
    )
      throw new Error('Artifact contains development files or credentials');
    const source = join(directory, name);
    const path = prefix ? `${prefix}/${name}` : name;
    const stat = await lstat(source);
    if (stat.isSymbolicLink())
      throw new Error('Artifact symlinks are not allowed');
    if (stat.isDirectory()) entries.push(...(await collect(source, path)));
    else if (stat.isFile())
      entries.push({ path, bytes: await readFile(source) });
    else throw new Error('Artifact contains a non-regular file');
  }
  return entries;
}

/** Digest covers normalized relative paths and exact content, independent of filesystem metadata. */
export async function digestArtifact(directory: string): Promise<string> {
  return digestEntries(await collect(directory));
}

function digestEntries(entries: readonly ArtifactEntry[]): string {
  const hash = createHash('sha256');
  for (const entry of entries) {
    hash.update(
      canonicalStableStringify({ path: entry.path, size: entry.bytes.length }),
    );
    hash.update('\n');
    hash.update(entry.bytes);
  }
  return `sha256:${hash.digest('hex')}`;
}

export async function readReleaseManifest(
  path: string,
): Promise<ReleaseManifest> {
  const bytes = await readFile(path);
  if (bytes.length > 128 * 1024)
    throw new Error('Release manifest exceeds 128 KiB');
  const manifest: unknown = JSON.parse(bytes.toString('utf8'));
  assertReleaseManifest(manifest);
  return manifest;
}

/** Builds a local immutable package. This function never uploads, registers, or activates it. */
export async function packRelease(
  manifest: ReleaseManifest,
  sources: ArtifactSources,
  outputDirectory: string,
): Promise<ReleaseManifest> {
  assertReleaseManifest(manifest);
  const keys = Object.keys(
    manifest.artifacts,
  ) as (keyof ReleaseManifest['artifacts'])[];
  if (
    Object.keys(sources).some(
      (key) => !keys.includes(key as keyof ReleaseManifest['artifacts']),
    ) ||
    keys.some((key) => typeof sources[key] !== 'string')
  )
    throw new Error('Artifact sources must exactly match manifest artifacts');
  const output = resolve(outputDirectory);
  for (const key of keys) {
    const source = resolve(sources[key] as string);
    const subpath = relative(source, output);
    if (
      subpath === '' ||
      (!subpath.startsWith(`..${sep}`) &&
        subpath !== '..' &&
        !isAbsolute(subpath))
    )
      throw new Error('Output must not be inside an artifact source');
  }
  const staged = join(
    dirname(output),
    `.${basename(output)}.${process.pid}.${Date.now()}.tmp`,
  );
  // Reserve the final destination, avoiding overwrite even when two packers race.
  await mkdir(output, { mode: 0o700 });
  try {
    await mkdir(staged, { mode: 0o700 });
    const artifacts: Partial<
      Record<keyof ReleaseManifest['artifacts'], ReleaseArtifact>
    > = {};
    for (const key of keys) {
      const entries = await collect(resolve(sources[key] as string));
      if (entries.length === 0) throw new Error('Artifact directory is empty');
      const base = join(
        staged,
        key === 'server' || key === 'privateContent' ? 'private' : 'public',
        key,
      );
      await mkdir(base, { recursive: true, mode: 0o700 });
      for (const entry of entries) {
        const destination = join(base, entry.path);
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        await writeFile(destination, entry.bytes, { flag: 'wx', mode: 0o600 });
      }
      const original = manifest.artifacts[key];
      if (!original) throw new Error('Missing artifact identity');
      artifacts[key] = {
        artifactId: original.artifactId,
        digest: digestEntries(entries),
      };
    }
    const packed = { ...structuredClone(manifest), artifacts };
    assertReleaseManifest(packed);
    await writeFile(
      join(staged, 'release.json'),
      `${JSON.stringify(packed, null, 2)}\n`,
      { flag: 'wx', mode: 0o600 },
    );
    // The reserved output directory is still empty and owned by this operation.
    await rename(staged, output);
    return packed;
  } catch (error) {
    await rm(staged, { recursive: true, force: true });
    await rm(output, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyPackedRelease(
  directory: string,
): Promise<ReleaseManifest> {
  await assertLayout(directory, ['release.json', 'private', 'public']);
  const manifest = await readReleaseManifest(join(directory, 'release.json'));
  await assertLayout(join(directory, 'public'), ['client', 'publicAssets']);
  await assertLayout(join(directory, 'private'), [
    'server',
    ...(manifest.artifacts.privateContent ? ['privateContent'] : []),
  ]);
  for (const [key, artifact] of Object.entries(manifest.artifacts)) {
    const location = join(
      directory,
      key === 'server' || key === 'privateContent' ? 'private' : 'public',
      key,
    );
    if ((await digestArtifact(location)) !== artifact.digest)
      throw new Error(`Artifact digest mismatch: ${key}`);
  }
  return manifest;
}

async function assertLayout(
  directory: string,
  expected: readonly string[],
): Promise<void> {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error('Release directories must not be symlinks');
  const names = await readdir(directory);
  if (
    names.length !== expected.length ||
    names.some((name) => !expected.includes(name))
  )
    throw new Error('Release contains unexpected files');
}
