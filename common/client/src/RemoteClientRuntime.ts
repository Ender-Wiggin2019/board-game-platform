import {
  assertClientReleaseLocator,
  type ClientReleaseLocator,
  canonicalStableStringify,
  clientArtifactUrl,
  clientReleaseKey,
  contractError,
} from '@board-game/contracts';

export const SHARED_CLIENT_RUNTIME_SYMBOL = 'board-game.client-runtime.v1';
export interface SharedClientModule {
  readonly version: string;
  /** A shell may expose a getter after loadSharedModules has loaded its own chunk. */
  readonly module: Readonly<Record<string, unknown>>;
}
export interface SharedClientRuntime {
  readonly abiVersion: string;
  readonly modules: Readonly<Record<string, SharedClientModule>>;
  readonly assetUrl: (
    gameId: string,
    releaseId: string,
    path: string,
  ) => string;
  readonly registerRelease: (locator: ClientReleaseLocator) => void;
}

type RuntimeGlobal = typeof globalThis & {
  [key: symbol]: SharedClientRuntime | undefined;
};

/** Installs the actual shell module instances before any trusted remote is evaluated. */
export function installSharedClientRuntime(
  abiVersion: string,
  modules: Readonly<Record<string, SharedClientModule>>,
): SharedClientRuntime {
  const global = globalThis as RuntimeGlobal;
  const key = Symbol.for(SHARED_CLIENT_RUNTIME_SYMBOL);
  const existing = global[key];
  if (existing) {
    if (
      existing.abiVersion !== abiVersion ||
      Object.keys(existing.modules).length !== Object.keys(modules).length ||
      Object.entries(modules).some(
        ([name, shared]) =>
          existing.modules[name]?.module !== shared.module ||
          existing.modules[name]?.version !== shared.version,
      )
    )
      throw contractError('CONFLICT', 'client.runtime.singleton_conflict');
    return existing;
  }
  const releases = new Map<string, ClientReleaseLocator>();
  const releaseIdentity = (gameId: string, releaseId: string) =>
    JSON.stringify([gameId, releaseId]);
  const runtime: SharedClientRuntime = Object.freeze({
    abiVersion,
    modules: Object.freeze(
      Object.fromEntries(
        Object.entries(modules).map(([name, value]) => [
          name,
          Object.freeze({
            version: value.version,
            get module() {
              return value.module;
            },
          }),
        ]),
      ),
    ),
    registerRelease(locator: ClientReleaseLocator) {
      const identity = releaseIdentity(locator.gameId, locator.releaseId);
      const previous = releases.get(identity);
      if (
        previous &&
        (clientReleaseKey(previous) !== clientReleaseKey(locator) ||
          canonicalStableStringify(previous.runtime) !==
            canonicalStableStringify(locator.runtime))
      )
        throw contractError('CONFLICT', 'client.release.immutable');
      // A retained module keeps the resource root with which it was first loaded.
      if (!previous) releases.set(identity, structuredClone(locator));
    },
    assetUrl(gameId: string, releaseId: string, path: string) {
      const locator = releases.get(releaseIdentity(gameId, releaseId));
      if (!locator)
        throw contractError('NOT_READY', 'client.release.not_loaded');
      return clientArtifactUrl(locator, path);
    },
  });
  Object.defineProperty(global, key, {
    value: runtime,
    configurable: false,
    writable: false,
  });
  return runtime;
}

export interface RemoteClientModule<Definition = unknown> {
  readonly gameId: string;
  readonly releaseId: string;
  readonly abiVersion: string;
  readonly definition: Definition;
}

export interface RemoteClientModuleLoaderOptions {
  readonly runtime: SharedClientRuntime;
  readonly allowInsecureLocalhost?: boolean;
  readonly importModule?: (url: string) => Promise<Record<string, unknown>>;
  /** Resolves only shell-owned public modules, never URLs supplied by a game. */
  readonly loadSharedModules?: (
    modules: ClientReleaseLocator['runtime']['shared'],
  ) => Promise<void>;
}

/** Cache keys include release and ABI. Missing or incompatible releases never load a current alias. */
export class RemoteClientModuleLoader {
  private readonly modules = new Map<string, Promise<RemoteClientModule>>();
  constructor(private readonly options: RemoteClientModuleLoaderOptions) {}

  load<Definition>(
    locator: ClientReleaseLocator,
  ): Promise<RemoteClientModule<Definition>> {
    assertClientReleaseLocator(locator, this.options.allowInsecureLocalhost);
    const runtime = this.options.runtime;
    if (
      locator.runtime.format !== 'esm' ||
      locator.runtime.abiVersion !== runtime.abiVersion
    )
      throw contractError('NOT_READY', 'client.runtime.incompatible');
    for (const shared of locator.runtime.shared) {
      if (runtime.modules[shared.specifier]?.version !== shared.version)
        throw contractError('NOT_READY', 'client.runtime.shared_incompatible');
    }
    runtime.registerRelease(locator);
    const key = clientReleaseKey(locator);
    let pending = this.modules.get(key);
    if (!pending) {
      const load =
        this.options.importModule ??
        ((url: string) => import(/* @vite-ignore */ url));
      pending = Promise.resolve()
        .then(() => this.options.loadSharedModules?.(locator.runtime.shared))
        .then(() => {
          return load(clientArtifactUrl(locator, locator.runtime.entry));
        })
        .then((module) => {
          const exported = module[locator.runtime.exportName];
          if (!exported || typeof exported !== 'object')
            throw contractError(
              'INVALID_REQUEST',
              'client.release.export_invalid',
            );
          const candidate = exported as RemoteClientModule;
          if (
            candidate.gameId !== locator.gameId ||
            candidate.releaseId !== locator.releaseId ||
            candidate.abiVersion !== locator.runtime.abiVersion ||
            !candidate.definition ||
            typeof candidate.definition !== 'object' ||
            (candidate.definition as { gameId?: unknown }).gameId !==
              locator.gameId
          )
            throw contractError(
              'FORBIDDEN',
              'client.release.identity_mismatch',
            );
          return candidate;
        })
        .catch((error) => {
          this.modules.delete(key);
          throw error;
        });
      this.modules.set(key, pending);
    }
    return pending as Promise<RemoteClientModule<Definition>>;
  }
}

/** Styles are retained only while a release is mounted, including simultaneous mounts. */
export class ClientReleaseStyles {
  private readonly entries = new Map<
    string,
    {
      references: number;
      links: HTMLLinkElement[];
      ready: Promise<void>;
      cancel: () => void;
    }
  >();
  constructor(
    private readonly document: Document,
    private readonly timeoutMs = 30_000,
  ) {}

  async acquire(locator: ClientReleaseLocator): Promise<() => void> {
    const key = clientReleaseKey(locator);
    let entry = this.entries.get(key);
    if (!entry) {
      const links = locator.runtime.styles.map((path) => {
        const link = this.document.createElement('link');
        link.rel = 'stylesheet';
        link.href = clientArtifactUrl(locator, path);
        link.dataset.gameRelease = `${locator.gameId}/${locator.releaseId}`;
        return link;
      });
      const cancel: (() => void)[] = [];
      const ready = Promise.all(
        links.map(
          (link) =>
            new Promise<void>((resolve, reject) => {
              let done = false;
              const finish = (error?: Error) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                link.onload = null;
                link.onerror = null;
                error ? reject(error) : resolve();
              };
              const timer = setTimeout(
                () => finish(new Error('client.styles.timeout')),
                this.timeoutMs,
              );
              cancel.push(() => finish(new Error('client.styles.cancelled')));
              link.onload = () => finish();
              link.onerror = () =>
                finish(new Error('client.styles.unavailable'));
              this.document.head.append(link);
            }),
        ),
      ).then(() => undefined);
      entry = {
        references: 0,
        links,
        ready,
        cancel: () => cancel.forEach((stop) => stop()),
      };
      this.entries.set(key, entry);
    }
    entry.references += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (--entry.references === 0) {
        entry.cancel();
        for (const link of entry.links) link.remove();
        this.entries.delete(key);
      }
    };
    try {
      await entry.ready;
    } catch (error) {
      release();
      throw error;
    }
    return release;
  }
}
