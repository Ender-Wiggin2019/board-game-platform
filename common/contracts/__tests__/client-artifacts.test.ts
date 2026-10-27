import { describe, expect, it } from 'vitest';
import {
  assertClientReleaseLocator,
  type ClientReleaseLocator,
  clientArtifactUrl,
  clientReleaseKey,
  REACT_CLIENT_RUNTIME_ABI,
} from '../src/client-artifacts.js';

const digest = `sha256:${'a'.repeat(64)}`;
const locator: ClientReleaseLocator = {
  schemaVersion: 1,
  gameId: 'brass',
  releaseId: 'v1',
  clientDigest: digest,
  publicAssetsDigest: digest,
  baseUrl: `https://assets.example/releases/brass/v1/${digest.slice(7)}/`,
  runtime: {
    abiVersion: REACT_CLIENT_RUNTIME_ABI,
    format: 'esm',
    entry: 'entry.js',
    exportName: 'gameClientRelease',
    styles: ['styles/game.css'],
    shared: [{ specifier: 'react', version: '18.3.1' }],
  },
};
describe('release client artifacts', () => {
  it('supports public SDK subpath catalogs while bounding manifest size', () => {
    const shared = Array.from({ length: 256 }, (_, index) => ({
      specifier: `@board-platform/client/module-${index}.js`,
      version: '0.1.0',
    }));
    expect(() =>
      assertClientReleaseLocator({
        ...locator,
        runtime: { ...locator.runtime, shared },
      }),
    ).not.toThrow();
    expect(() =>
      assertClientReleaseLocator({
        ...locator,
        runtime: {
          ...locator.runtime,
          shared: [...shared, { specifier: 'react', version: '18.3.1' }],
        },
      }),
    ).toThrow();
  });
  it('binds JS, CSS and assets to one immutable release root', () => {
    expect(() => assertClientReleaseLocator(locator)).not.toThrow();
    expect(clientArtifactUrl(locator, 'assets/board.webp')).toBe(
      `${locator.baseUrl}assets/board.webp`,
    );
    expect(
      clientArtifactUrl(
        locator,
        'public/assets/seti/corporations/Cosmos Strategy Group.jpg',
      ),
    ).toBe(
      `${locator.baseUrl}public/assets/seti/corporations/Cosmos%20Strategy%20Group.jpg`,
    );
    expect(clientReleaseKey(locator)).not.toBe(
      clientReleaseKey({ ...locator, releaseId: 'v2' }),
    );
    expect(() =>
      assertClientReleaseLocator({
        ...locator,
        baseUrl: 'https://assets.example/releases/brass/latest/',
      }),
    ).toThrow();
    for (const path of [
      '../private',
      '/other.js',
      'https://other.example/file',
      'assets/../file',
      'assets/%2e%2e/file',
      'assets/a?token=secret',
      'assets\\file',
      'assets/a#fragment',
      'assets/a\nfile',
      'assets/a\tfile',
      'assets/ .. /file',
      'assets/file ',
      'assets/Cosmos%20Strategy.jpg',
    ])
      expect(() => clientArtifactUrl(locator, path)).toThrow();
  });
  it('rejects credentials, executable URLs, duplicate shared modules and unpinned dependency versions', () => {
    for (const value of [
      {
        ...locator,
        baseUrl: `https://user:secret@assets.example/releases/brass/v1/${digest.slice(7)}/`,
      },
      { ...locator, baseUrl: 'javascript:alert(1)' },
      {
        ...locator,
        runtime: {
          ...locator.runtime,
          shared: [{ specifier: 'react', version: '^18.3.1' }],
        },
      },
      {
        ...locator,
        runtime: {
          ...locator.runtime,
          shared: [locator.runtime.shared[0], locator.runtime.shared[0]],
        },
      },
    ])
      expect(() => assertClientReleaseLocator(value)).toThrow();
  });
});
