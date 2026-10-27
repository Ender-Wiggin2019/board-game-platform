import { catalog } from 'virtual:platform-shared-modules';
import {
  installSharedClientRuntime,
  type SharedClientModule,
} from '@board-game/client';
import {
  type ClientRuntimeManifest,
  contractError,
  REACT_CLIENT_RUNTIME_ABI,
} from '@board-game/contracts';

const loaded = new Map<string, Readonly<Record<string, unknown>>>();
const pending = new Map<string, Promise<void>>();
const modules: Record<string, SharedClientModule> = {};
for (const [specifier, entry] of Object.entries(catalog)) {
  modules[specifier] = {
    version: entry.version,
    get module() {
      const value = loaded.get(specifier);
      if (!value)
        throw contractError('NOT_READY', 'client.runtime.module_not_loaded');
      return value;
    },
  };
}

export const sharedRuntime = installSharedClientRuntime(
  REACT_CLIENT_RUNTIME_ABI,
  modules,
);

/** The catalog is compiled from the shell's public exports; a remote cannot add a URL. */
export async function loadSharedModules(
  requirements: ClientRuntimeManifest['shared'],
): Promise<void> {
  await Promise.all(
    requirements.map(async ({ specifier, version }) => {
      const entry = catalog[specifier];
      if (!entry || entry.version !== version)
        throw contractError('NOT_READY', 'client.runtime.shared_incompatible');
      let loading = pending.get(specifier);
      if (!loading) {
        loading = entry
          .load()
          .then((module) => {
            loaded.set(specifier, module);
          })
          .catch((error) => {
            pending.delete(specifier);
            throw error;
          });
        pending.set(specifier, loading);
      }
      await loading;
    }),
  );
}
