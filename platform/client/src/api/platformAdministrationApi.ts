import type {
  GamePolicyVersion,
  GameServiceDescription,
  JsonValue,
  ReleaseManifest,
} from '@board-game/contracts';
import type {
  IPlatformAdminUserListParams,
  IPlatformAdminUserSummary,
} from '@board-platform/contracts/types/protocol/administration';
import type {
  IAdminInviteCodeSummary,
  IAdminTableQuery,
  IAdminTableResponse,
  IGenerateInviteCodeRequest,
} from '@board-platform/contracts/types/protocol/inviteCodes';
import { httpClient } from './httpClient.js';

export type PlatformReleaseBindingStatus =
  | 'staged'
  | 'ready'
  | 'draining'
  | 'retained'
  | 'retired';

export interface PlatformReleaseRecord {
  readonly platformId: string;
  readonly gameId: string;
  readonly releaseId: string;
  readonly manifest: ReleaseManifest;
  readonly service: GameServiceDescription;
  readonly manifestDigest: string;
  readonly serviceDigest: string;
  readonly approvedFeatures: readonly string[];
  readonly approvedModes: readonly string[];
  readonly policyBundle?: JsonValue;
  readonly policyBundleDigest?: string;
  readonly approvedPolicyVersions?: readonly GamePolicyVersion[];
  readonly createdAt: number;
}

export interface PlatformReleaseBinding {
  readonly platformId: string;
  readonly backendBindingId: string;
  readonly gameId: string;
  readonly releaseId: string;
  readonly storageBindingId: string;
  readonly ownershipEpoch: string;
  readonly deployment: 'managed' | 'external';
  readonly controlEndpoint: string;
  readonly playerEndpoint: string;
  readonly authorizationEndpoint?: string;
  readonly clientArtifactBaseUrl: string;
  readonly serviceCredentialRef: string;
  readonly status: PlatformReleaseBindingStatus;
  readonly revision: number;
  readonly readiness?: {
    readonly probeId: string;
    readonly checkedAt: number;
    readonly protocol: {
      readonly major: number;
      readonly minor: number;
      readonly serviceDigest: string;
      readonly service: GameServiceDescription;
    };
    readonly storage: {
      readonly bindingId: string;
      readonly schemaVersion: string;
    };
  };
  readonly retirement?: JsonValue;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface PlatformReleaseAdminItem {
  readonly release: PlatformReleaseRecord;
  readonly bindings: readonly PlatformReleaseBinding[];
}

export interface PlatformReleaseChannel {
  readonly platformId: string;
  readonly gameId: string;
  readonly modeId: string;
  readonly channel: string;
  readonly revision: number;
  readonly targetBackendBindingId: string;
  readonly releaseId: string;
  readonly storageBindingId: string;
  readonly ownershipEpoch: string;
  readonly operationId: string;
  readonly updatedAt: number;
}

export type PlatformReleaseReconciliationDifferenceKind =
  | 'missing-release'
  | 'missing-ready-binding'
  | 'missing-stable-channel'
  | 'channel-release-mismatch'
  | 'deployment-mismatch'
  | 'disabled-active-channel'
  | 'unconfigured-active-channel';

export interface PlatformReleaseReconciliationDifference {
  readonly gameId: string;
  readonly modeId?: string;
  readonly kind: PlatformReleaseReconciliationDifferenceKind;
  readonly expected: string | null;
  readonly actual: string | null;
}

export interface PlatformReleaseDesiredInstallation {
  readonly gameId: string;
  readonly releaseId: string;
  readonly enabled: boolean;
  readonly deployment: 'managed' | 'external';
}

/** Secret-free projection of configured and persisted release state. */
export interface PlatformReleaseReconciliation {
  readonly schemaVersion: 1;
  readonly platformId: string;
  readonly generatedAt: number;
  readonly desiredConfigured: boolean;
  readonly desired: readonly PlatformReleaseDesiredInstallation[];
  readonly actual: {
    readonly releases: readonly PlatformReleaseRecord[];
    readonly bindings: readonly PlatformReleaseBinding[];
    readonly channels: readonly PlatformReleaseChannel[];
  };
  readonly differences: readonly PlatformReleaseReconciliationDifference[];
  readonly channelHistory: readonly PlatformReleaseChannel[];
}

export interface RegisterStagedReleaseRequest {
  readonly manifest: ReleaseManifest;
  readonly service: GameServiceDescription;
  readonly approvedFeatures: readonly string[];
  readonly approvedModes: readonly string[];
  readonly policyBundle?: JsonValue;
  readonly approvedPolicyVersions?: readonly GamePolicyVersion[];
  readonly binding: {
    readonly deployment: 'managed' | 'external';
    readonly controlEndpoint: string;
    readonly playerEndpoint: string;
    readonly authorizationEndpoint?: string;
    readonly clientArtifactBaseUrl: string;
    readonly serviceCredentialRef: string;
  };
}

export interface SwitchPlatformReleaseChannelRequest {
  readonly gameId: string;
  readonly modeId: string;
  readonly channel: string;
  readonly expectedRevision: number;
  readonly targetBackendBindingId: string;
  readonly operationId: string;
}

function tableParams(
  params: IPlatformAdminUserListParams | IAdminTableQuery | undefined,
) {
  const search = params && 'search' in params ? params.search : undefined;
  return {
    ...(search ? { search } : {}),
    ...(params?.pageSize ? { pageSize: params.pageSize } : {}),
    ...(params?.pageNum ? { pageNum: params.pageNum } : {}),
    ...(params?.sort ? { sort: params.sort } : {}),
    ...(params?.filters ? { filters: JSON.stringify(params.filters) } : {}),
  };
}

export const platformAdministrationApi = {
  listUsers: async (
    params?: IPlatformAdminUserListParams,
  ): Promise<IAdminTableResponse<IPlatformAdminUserSummary>> => {
    const response = await httpClient.get<
      IAdminTableResponse<IPlatformAdminUserSummary>
    >('/platform/admin/users', { params: tableParams(params) });
    return response.data;
  },
  getUser: async (userId: string): Promise<IPlatformAdminUserSummary> => {
    const response = await httpClient.get<IPlatformAdminUserSummary>(
      `/platform/admin/users/${encodeURIComponent(userId)}`,
    );
    return response.data;
  },
  setUserRole: async (
    userId: string,
    role: string,
  ): Promise<IPlatformAdminUserSummary> => {
    const response = await httpClient.patch<IPlatformAdminUserSummary>(
      `/platform/admin/users/${encodeURIComponent(userId)}/role`,
      { role },
    );
    return response.data;
  },
  resetUserPassword: async (
    userId: string,
  ): Promise<IPlatformAdminUserSummary> => {
    const response = await httpClient.post<IPlatformAdminUserSummary>(
      `/platform/admin/users/${encodeURIComponent(userId)}/reset-password`,
    );
    return response.data;
  },
  listInviteCodes: async (
    params?: IAdminTableQuery,
  ): Promise<IAdminTableResponse<IAdminInviteCodeSummary>> => {
    const response = await httpClient.get<
      IAdminTableResponse<IAdminInviteCodeSummary>
    >('/platform/admin/invite-codes', { params: tableParams(params) });
    return response.data;
  },
  generateInviteCode: async (
    input: Partial<IGenerateInviteCodeRequest>,
  ): Promise<IAdminInviteCodeSummary> => {
    const response = await httpClient.post<IAdminInviteCodeSummary>(
      '/platform/admin/invite-codes',
      input,
    );
    return response.data;
  },
  disableInviteCode: async (
    inviteCodeId: string,
  ): Promise<IAdminInviteCodeSummary> => {
    const response = await httpClient.post<IAdminInviteCodeSummary>(
      `/platform/admin/invite-codes/${encodeURIComponent(inviteCodeId)}/disable`,
    );
    return response.data;
  },
  listReleases: async (): Promise<readonly PlatformReleaseAdminItem[]> => {
    const response = await httpClient.get<readonly PlatformReleaseAdminItem[]>(
      '/platform/admin/releases',
    );
    return response.data;
  },
  getReleaseReconciliation:
    async (): Promise<PlatformReleaseReconciliation> => {
      const response = await httpClient.get<PlatformReleaseReconciliation>(
        '/platform/admin/releases/reconciliation',
      );
      return response.data;
    },
  registerRelease: async (
    input: RegisterStagedReleaseRequest,
  ): Promise<{
    readonly release: PlatformReleaseRecord;
    readonly binding: PlatformReleaseBinding;
  }> => {
    const response = await httpClient.post<{
      readonly release: PlatformReleaseRecord;
      readonly binding: PlatformReleaseBinding;
    }>('/platform/admin/releases', input);
    return response.data;
  },
  readyBinding: async (
    backendBindingId: string,
  ): Promise<PlatformReleaseBinding> => {
    const response = await httpClient.post<PlatformReleaseBinding>(
      `/platform/admin/releases/bindings/${encodeURIComponent(backendBindingId)}/ready`,
      {},
    );
    return response.data;
  },
  activateBinding: async (
    backendBindingId: string,
  ): Promise<PlatformReleaseBinding> => {
    const response = await httpClient.post<PlatformReleaseBinding>(
      `/platform/admin/releases/bindings/${encodeURIComponent(backendBindingId)}/activate`,
      {},
    );
    return response.data;
  },
  switchChannel: async (
    input: SwitchPlatformReleaseChannelRequest,
  ): Promise<PlatformReleaseChannel> => {
    const response = await httpClient.post<PlatformReleaseChannel>(
      '/platform/admin/releases/channels/switch',
      input,
    );
    return response.data;
  },
  drainBinding: async (
    backendBindingId: string,
  ): Promise<PlatformReleaseBinding> => {
    const response = await httpClient.post<PlatformReleaseBinding>(
      `/platform/admin/releases/bindings/${encodeURIComponent(backendBindingId)}/drain`,
      {},
    );
    return response.data;
  },
  disableBinding: async (
    backendBindingId: string,
  ): Promise<PlatformReleaseBinding> => {
    const response = await httpClient.post<PlatformReleaseBinding>(
      `/platform/admin/releases/bindings/${encodeURIComponent(backendBindingId)}/disable`,
      {},
    );
    return response.data;
  },
  retainBinding: async (
    backendBindingId: string,
  ): Promise<PlatformReleaseBinding> => {
    const response = await httpClient.post<PlatformReleaseBinding>(
      `/platform/admin/releases/bindings/${encodeURIComponent(backendBindingId)}/retain`,
      {},
    );
    return response.data;
  },
};

export type { IPlatformAdminUserListParams };
