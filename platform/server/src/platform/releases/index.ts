import {
  type BindingProbeClient,
  type BindingProbeRequest,
  type BindingReadinessEvidence,
  type BindingRetirementEvidence,
  type BindingRetirementProbe,
  type BindingRetirementProbeRequest,
  type ChangeBindingStateInput,
  type ChannelRecord,
  type CompareAndSwapChannelInput,
  type RegisterBindingInput,
  type RegisterReleaseInput,
  type ReleaseBindingRecord,
  type ReleaseRecord,
  ReleaseRegistryError,
  type ReleaseRegistryStore,
  type RetireBindingInput,
  type UpdateBindingEndpointsInput,
} from './types.js';

export * from './store.js';
export * from './types.js';

/** Service boundary for registration, readiness probes, channel changes and retirement. */
export class ReleaseRegistry {
  constructor(private readonly store: ReleaseRegistryStore) {}

  registerRelease(input: RegisterReleaseInput): Promise<ReleaseRecord> {
    return this.store.registerRelease(input);
  }

  listReleases(
    platformId: string,
    gameId?: string,
  ): Promise<readonly ReleaseRecord[]> {
    return this.store.listReleases(platformId, gameId);
  }

  registerBinding(input: RegisterBindingInput): Promise<ReleaseBindingRecord> {
    return this.store.registerBinding(input);
  }

  getRelease(
    platformId: string,
    gameId: string,
    releaseId: string,
  ): Promise<ReleaseRecord | null> {
    return this.store.getRelease(platformId, gameId, releaseId);
  }

  getBinding(
    platformId: string,
    backendBindingId: string,
  ): Promise<ReleaseBindingRecord | null> {
    return this.store.getBinding(platformId, backendBindingId);
  }

  listBindings(
    platformId: string,
    gameId?: string,
  ): Promise<readonly ReleaseBindingRecord[]> {
    return this.store.listBindings(platformId, gameId);
  }

  updateBindingEndpoints(
    input: UpdateBindingEndpointsInput,
  ): Promise<ReleaseBindingRecord> {
    return this.store.updateBindingEndpoints(input);
  }

  async readyBinding(
    platformId: string,
    backendBindingId: string,
    probe: BindingProbeClient,
  ): Promise<ReleaseBindingRecord> {
    const context = await this.probeContext(platformId, backendBindingId);
    const evidence = await probe.probe({
      platformId,
      release: context.release,
      binding: context.binding,
    });
    return this.store.recordBindingReadiness({
      platformId,
      backendBindingId,
      evidence,
      expectedRevision: context.binding.revision,
    });
  }

  drainBinding(input: ChangeBindingStateInput): Promise<ReleaseBindingRecord> {
    return this.store.drainBinding(input);
  }

  retainBinding(input: ChangeBindingStateInput): Promise<ReleaseBindingRecord> {
    return this.store.retainBinding(input);
  }

  async retireBinding(
    input: Omit<RetireBindingInput, 'evidence'>,
    probe: BindingRetirementProbe,
  ): Promise<ReleaseBindingRecord> {
    const context = await this.probeContext(
      input.platformId,
      input.backendBindingId,
    );
    const evidence = await probe.probe({
      platformId: input.platformId,
      release: context.release,
      binding: context.binding,
    });
    return this.store.retireBinding({ ...input, evidence });
  }

  listChannels(platformId: string): Promise<readonly ChannelRecord[]> {
    return this.store.listChannels(platformId);
  }

  listChannelHistory(
    platformId: string,
    limit = 100,
  ): Promise<readonly ChannelRecord[]> {
    return this.store.listChannelHistory(platformId, limit);
  }

  getChannel(
    platformId: string,
    gameId: string,
    modeId: string,
    channel: string,
  ): Promise<ChannelRecord | null> {
    return this.store.getChannel(platformId, gameId, modeId, channel);
  }

  compareAndSwapChannel(
    input: CompareAndSwapChannelInput,
  ): Promise<ChannelRecord> {
    return this.store.compareAndSwapChannel(input);
  }

  private async probeContext(
    platformId: string,
    backendBindingId: string,
  ): Promise<{
    readonly release: ReleaseRecord;
    readonly binding: ReleaseBindingRecord;
  }> {
    const binding = await this.store.getBinding(platformId, backendBindingId);
    if (!binding)
      throw new ReleaseRegistryError('NOT_FOUND', 'binding not found');
    const release = await this.store.getRelease(
      platformId,
      binding.gameId,
      binding.releaseId,
    );
    if (!release)
      throw new ReleaseRegistryError('NOT_FOUND', 'release not found');
    return { release, binding };
  }
}

export type {
  BindingProbeClient,
  BindingProbeRequest,
  BindingReadinessEvidence,
  BindingRetirementProbe,
  BindingRetirementProbeRequest,
  BindingRetirementEvidence,
};
