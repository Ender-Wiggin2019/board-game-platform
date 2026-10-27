import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalStableStringify } from '@board-game/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assetRuntimeModule,
  digestClientArtifactDirectory,
  isClientOwnedAssetModule,
  rewriteClientCssAssetUrls,
  scopeClientCss,
} from '../src/client-build.js';
import { digestArtifact } from '../src/release.js';

const runtimeSymbol = Symbol.for('board-game.client-runtime.v1');
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

describe('client artifact CSS asset URLs', () => {
  it('rebases known root-relative assets under the artifact public root', () => {
    expect(
      rewriteClientCssAssetUrls(
        ".hero { background: url('/assets/seti/scenes/profile.webp'); }\n" +
          ".remote { background: url('/external/profile.webp'); }",
        ['assets/seti'],
      ),
    ).toBe(
      ".hero { background: url('../../public/assets/seti/scenes/profile.webp'); }\n" +
        ".remote { background: url('/external/profile.webp'); }",
    );
  });
});

describe('client artifact asset rewrite boundary', () => {
  it('does not rewrite shared rule/content modules', () => {
    const clientDirectory = '/workspace/games/arnak/client';
    expect(
      isClientOwnedAssetModule(
        '/workspace/games/arnak/client/dist/registration.js',
        clientDirectory,
      ),
    ).toBe(true);
    expect(
      isClientOwnedAssetModule(
        '/workspace/games/arnak/common/dist/rules/content/registry.js',
        clientDirectory,
      ),
    ).toBe(false);
    expect(
      isClientOwnedAssetModule(
        '/workspace/games/arnak/client/node_modules/some-package/dist/index.js',
        clientDirectory,
      ),
    ).toBe(false);
    expect(
      isClientOwnedAssetModule(
        '/workspace/games/arnak/client/dist/entry.js?commonjs-proxy',
        clientDirectory,
      ),
    ).toBe(true);
  });
});

describe('client artifact digests', () => {
  it('matches release digests with raw path ordering', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bgp-client-digest-'));
    roots.push(root);
    await mkdir(join(root, 'nested'));
    await writeFile(join(root, 'a'), 'lowercase');
    await writeFile(join(root, 'B'), 'uppercase');
    await writeFile(join(root, 'nested', 'ä'), 'nested');

    const expectedHash = createHash('sha256');
    for (const path of ['B', 'a', 'nested/ä']) {
      const bytes = await readFile(join(root, path));
      expectedHash.update(
        canonicalStableStringify({ path, size: bytes.byteLength }),
      );
      expectedHash.update('\n');
      expectedHash.update(bytes);
    }
    const expected = `sha256:${expectedHash.digest('hex')}`;
    expect(await digestArtifact(root)).toBe(expected);
    expect(await digestClientArtifactDirectory(root)).toBe(expected);
  });
});

describe('client artifact runtime asset URLs', () => {
  it('preserves a safe query and hash while validating only the path body', async () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, runtimeSymbol);
    Object.defineProperty(globalThis, runtimeSymbol, {
      configurable: true,
      value: {
        assetUrl: (gameId: string, releaseId: string, path: string) => {
          expect([gameId, releaseId, path]).toEqual([
            'arnak',
            'v0.1-artfix',
            'public/arnak/artifact-04.webp',
          ]);
          return `https://assets.example/arnak/v0.1-artfix/${path}`;
        },
      },
    });
    try {
      const module = (await import(
        `data:text/javascript,${encodeURIComponent(assetRuntimeModule('arnak', 'v0.1-artfix'))}`
      )) as { assetUrl(path: string): string };
      expect(
        module.assetUrl('/arnak/artifact-04.webp?v=v0.1-artfix#board'),
      ).toBe(
        'https://assets.example/arnak/v0.1-artfix/public/arnak/artifact-04.webp?v=v0.1-artfix#board',
      );
    } finally {
      if (previous) Object.defineProperty(globalThis, runtimeSymbol, previous);
      else delete (globalThis as Record<symbol, unknown>)[runtimeSymbol];
    }
  });
});

describe('client artifact CSS scoping', () => {
  it('qualifies ordinary and existing single-scope styles with the release root', () => {
    expect(scopeClientCss('.card { color: red; }', 'brass/v1')).toBe(
      '@scope ([data-game-release="brass/v1"]) {\n.card { color: red; }\n}\n',
    );
    expect(
      scopeClientCss(
        '@scope (.brass-game) { .card { color: red; } }',
        'brass/v1',
      ),
    ).toBe(
      '@scope ([data-game-release="brass/v1"]) {\n.card { color: red; }\n}\n',
    );
  });

  it('allows universal and pseudo-element selectors inside the release scope', () => {
    expect(
      scopeClientCss(
        '*, ::before, ::after { box-sizing: border-box; }',
        'seti/v1',
      ),
    ).toBe(
      '@scope ([data-game-release="seti/v1"]) {\n*, ::before, ::after { box-sizing: border-box; }\n}\n',
    );
  });

  it('moves a game-owned :root theme onto the release root', () => {
    expect(scopeClientCss(':root, .card { color: red; }', 'seti/v1')).toBe(
      '@scope ([data-game-release="seti/v1"]) {\n[data-game-release="seti/v1"], .card { color: red; }\n}\n',
    );
  });

  it('rejects selectors that cannot be safely qualified', () => {
    for (const selector of ['html', 'body']) {
      expect(() =>
        scopeClientCss(`${selector} { color: red; }`, 'brass/v1'),
      ).toThrow('unknown global selector');
    }
    expect(() =>
      scopeClientCss('.card :global(body) { color: red; }', 'brass/v1'),
    ).toThrow('unknown global selector');
    expect(() =>
      scopeClientCss('.card :global(*) { color: red; }', 'brass/v1'),
    ).toThrow('unknown global selector');
    expect(() =>
      scopeClientCss('.card :not(body) { color: red; }', 'brass/v1'),
    ).toThrow('unknown global selector');
  });

  it('ignores comments when checking selectors', () => {
    expect(
      scopeClientCss(
        '/* body { color: red; } */ .card { color: blue; }',
        'brass/v1',
      ),
    ).toContain('.card { color: blue; }');
  });
});
