import { readdir, copyFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
async function copy(directory = 'src') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await copy(path);
    else if (/\.(css|json)$/.test(path)) {
      const target = path.replace(/^src\//, 'dist/');
      await mkdir(dirname(target), { recursive: true });
      await copyFile(path, target);
    }
  }
}
await copy();
