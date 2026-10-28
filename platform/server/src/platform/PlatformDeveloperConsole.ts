import {
  contractError,
  type SubmitDeveloperCommandRequest,
} from '@board-game/contracts';
import type { PlatformIdentityReference } from '@board-game/core';
import type { PlatformApplicationRuntime } from './PlatformApplicationRuntime.js';

export type PlatformDeveloperCommandInput = Pick<
  SubmitDeveloperCommandRequest,
  'commandId' | 'expectedRevision' | 'command'
>;

/** Operator tools follow the session's pinned release, including remote Hosts. */
export class PlatformDeveloperConsole {
  constructor(
    private readonly runtime: Pick<
      PlatformApplicationRuntime,
      'admissionStore' | 'releaseGame' | 'resolveBackend'
    >,
  ) {}

  private async context(
    reference: PlatformIdentityReference,
    sessionId: string,
  ) {
    const admission = await this.runtime.admissionStore.getAdmission(sessionId);
    if (!admission)
      throw contractError('NOT_FOUND', 'platform.session.not_found');
    const { route } = admission;
    const game = this.runtime.releaseGame(route.gameId, route.releaseId);
    if (!game.identity.developerAccess)
      throw contractError('NOT_READY', 'platform.developer.unavailable');
    const accessContext = await game.identity.developerAccess(reference, route);
    return {
      backend: this.runtime.resolveBackend(route),
      request: { protocolVersion: 1 as const, route, accessContext },
    };
  }

  async describe(reference: PlatformIdentityReference, sessionId: string) {
    const { backend, request } = await this.context(reference, sessionId);
    if (!backend.getDeveloperConsole)
      throw contractError('NOT_READY', 'platform.developer.unavailable');
    return backend.getDeveloperConsole(request);
  }

  async submit(
    reference: PlatformIdentityReference,
    sessionId: string,
    input: PlatformDeveloperCommandInput,
  ) {
    const { backend, request } = await this.context(reference, sessionId);
    if (!backend.submitDeveloperCommand)
      throw contractError('NOT_READY', 'platform.developer.unavailable');
    return backend.submitDeveloperCommand({
      ...request,
      commandId: input.commandId,
      expectedRevision: input.expectedRevision,
      command: input.command,
    });
  }
}
