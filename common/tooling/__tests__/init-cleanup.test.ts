import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async () => {
  const actual =
    await vi.importActual<typeof import('node:fs/promises')>(
      'node:fs/promises',
    );
  const writeFile = vi.fn(actual.writeFile);
  writeFile.mockImplementationOnce(actual.writeFile);
  writeFile.mockRejectedValueOnce(new Error('synthetic write failure'));
  return { ...actual, writeFile };
});

const { initializeProject } = await import('../src/init.js');

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

describe('integrated scaffold cleanup', () => {
  it('removes a partially written destination after a file write fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bgp-init-cleanup-'));
    roots.push(root);
    const output = join(root, 'game');
    await expect(initializeProject(output, 'integrated-game')).rejects.toThrow(
      'synthetic write failure',
    );
    await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
