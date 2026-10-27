import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as schema from '@board-platform/server/persistence/schema/index.js';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';

// Use Drizzle's ESM API: the CLI's require hook cannot load import-only public packages.
const folder = new URL('../drizzle/', import.meta.url);
const meta = new URL('meta/', folder);
const journalFile = new URL('_journal.json', meta);
await mkdir(meta, { recursive: true });
let journal;
try {
  journal = JSON.parse(await readFile(journalFile, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  journal = { version: '7', dialect: 'postgresql', entries: [] };
}
const last = journal.entries.at(-1);
const previous = last
  ? JSON.parse(
      await readFile(
        new URL(`${String(last.idx).padStart(4, '0')}_snapshot.json`, meta),
        'utf8',
      ),
    )
  : generateDrizzleJson({});
const current = generateDrizzleJson(schema, last ? previous.id : undefined);
const statements = await generateMigration(previous, current);
if (statements.length === 0) {
  console.log('Platform schema is unchanged.');
} else {
  const name =
    process.argv[2] ?? (last ? 'platform_update' : 'platform_baseline');
  if (!/^[a-z][a-z0-9_]{0,63}$/u.test(name))
    throw new Error(
      'Migration name must use lowercase letters, digits and underscores.',
    );
  const idx = journal.entries.length;
  const prefix = String(idx).padStart(4, '0');
  const tag = `${prefix}_${name}`;
  await writeFile(
    new URL(`${tag}.sql`, folder),
    `${statements.join('\n--> statement-breakpoint\n')}\n`,
    { flag: 'wx' },
  );
  await writeFile(
    new URL(`${prefix}_snapshot.json`, meta),
    `${JSON.stringify(current, null, 2)}\n`,
    { flag: 'wx' },
  );
  journal.entries.push({
    idx,
    version: '7',
    when: Date.now(),
    tag,
    breakpoints: true,
  });
  await writeFile(journalFile, `${JSON.stringify(journal, null, 2)}\n`);
  console.log(
    `Generated platform-only migration: ${fileURLToPath(new URL(`${tag}.sql`, folder))}`,
  );
}
