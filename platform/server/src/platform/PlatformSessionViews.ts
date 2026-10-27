import { contractError } from '@board-game/contracts';
import type {
  AdmissionStore,
  CommandInput,
  PlatformIdentityReference,
  ResumeInput,
  SessionGateway,
} from '@board-game/core';

type SessionPresenter = Pick<SessionGateway, 'view' | 'resume' | 'command'>;

interface PresenterRegistration {
  readonly presenter: SessionPresenter;
  readonly default: boolean;
}

function key(gameId: string, releaseId: string): string {
  return JSON.stringify([gameId, releaseId]);
}

/** A game may optimize its delivery codec without replacing session authorization. */
export class PlatformSessionViews {
  private readonly presenters = new Map<string, PresenterRegistration>();

  constructor(
    _sessions: SessionGateway,
    private readonly admissions: AdmissionStore,
    private readonly changed: (sessionId: string, revision: number) => void,
  ) {}

  register(
    gameId: string,
    releaseId: string,
    presenter: SessionPresenter,
  ): void {
    const registrationKey = key(gameId, releaseId);
    const existing = this.presenters.get(registrationKey);
    if (existing && !existing.default)
      throw contractError('CONFLICT', 'platform.view.already_registered');
    this.presenters.set(registrationKey, { presenter, default: false });
  }

  registerDefault(
    gameId: string,
    releaseId: string,
    presenter: SessionPresenter,
  ): void {
    const registrationKey = key(gameId, releaseId);
    if (this.presenters.has(registrationKey))
      throw contractError('CONFLICT', 'platform.view.already_registered');
    this.presenters.set(registrationKey, { presenter, default: true });
  }

  unregister(gameId: string, releaseId: string): void {
    this.presenters.delete(key(gameId, releaseId));
  }

  private async presenter(sessionId: string): Promise<SessionPresenter> {
    const admission = await this.admissions.getAdmission(sessionId);
    if (!admission)
      throw contractError('NOT_FOUND', 'platform.admission.missing');
    const registration = this.presenters.get(
      key(admission.route.gameId, admission.route.releaseId),
    );
    if (!registration)
      throw contractError(
        'NOT_READY',
        'platform.view.release_unavailable',
        true,
      );
    return registration.presenter;
  }

  async view(reference: PlatformIdentityReference, sessionId: string) {
    return (await this.presenter(sessionId)).view(reference, sessionId);
  }

  async resume(
    reference: PlatformIdentityReference,
    sessionId: string,
    input: ResumeInput,
  ) {
    return (await this.presenter(sessionId)).resume(
      reference,
      sessionId,
      input,
    );
  }

  async command(
    reference: PlatformIdentityReference,
    sessionId: string,
    input: CommandInput,
  ) {
    const result = await (await this.presenter(sessionId)).command(
      reference,
      sessionId,
      input,
    );
    if (result.receipt.persistedRevision !== undefined)
      this.changed(sessionId, result.receipt.persistedRevision);
    return result;
  }
}
