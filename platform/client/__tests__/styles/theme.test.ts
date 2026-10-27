import { readFile } from 'node:fs/promises';
import path from 'node:path';
import tailwind from '@tailwindcss/postcss';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

describe('client theme compilation', () => {
  it('emits the actual surface, typography and interaction utilities', async () => {
    const from = path.resolve('src/styles/globals.css');
    const result = await postcss([tailwind()]).process(
      '@import "tailwindcss";\n@config "./tailwind.config.ts";\n@source inline("bg-surface-panel surface-panel surface-raised surface-instrument text-text-100 font-display bg-accent-500/20");\n' + await readFile(from, 'utf8'),
      { from },
    );
    for (const selector of [
      '.bg-surface-panel',
      '.surface-panel',
      '.surface-raised',
      '.surface-instrument',
      '.text-text-100',
      '.font-display',
      '.bg-accent-500\\/20',
    ]) {
      let found = false;
      result.root.walkRules(selector, () => {
        found = true;
      });
      expect(found, `${selector} must survive the real PostCSS pipeline`).toBe(
        true,
      );
    }
    const rootVariables = new Set<string>();
    result.root.walkDecls(/^--/, (decl) => {
      rootVariables.add(decl.prop);
    });
    const mapping = await readFile(path.resolve('src/config/theme.ts'), 'utf8');
    for (const match of mapping.matchAll(/var\((--[\w-]+)\)/g)) {
      expect(
        rootVariables.has(match[1]),
        `${match[1]} needs an owned color value`,
      ).toBe(true);
    }
  });
});
