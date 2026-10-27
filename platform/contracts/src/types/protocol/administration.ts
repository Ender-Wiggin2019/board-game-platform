import type { INavigatorAccess } from '../../auth/navigator.js';
import type { ERole } from '../../auth/roles.js';
import type { IAdminTableResponse } from './inviteCodes.js';

/** Account fields exposed to the platform administration surface. */
export interface IPlatformAdminUserSummary {
  id: string;
  name: string;
  email: string;
  role: ERole;
  baseRole: ERole;
  navigator: INavigatorAccess;
  createdAt: Date | string;
  updatedAt: Date | string;
}

/** Wire query accepted by platform account administration tables. */
export interface IPlatformAdminUserListParams {
  search?: string;
  pageSize?: number;
  pageNum?: number;
  sort?: string;
  filters?: Record<string, string | string[]>;
}

export type IPlatformAdminUserListResponse =
  IAdminTableResponse<IPlatformAdminUserSummary>;

/** Process-wide measurements; available even when no game is installed. */
export interface IPlatformPerformanceSnapshot {
  readonly capturedAt: string;
  readonly uptimeSeconds: number;
  readonly sampleWindowMs: number;
  /** One fully occupied CPU core is 100%; worker threads may make this exceed 100. */
  readonly cpuPercent: number | null;
  readonly memoryBytes: {
    readonly rss: number;
    readonly heapUsed: number;
    readonly heapTotal: number;
    readonly external: number;
    readonly arrayBuffers: number;
  };
  readonly eventLoopLagMs: {
    readonly mean: number;
    readonly p95: number;
    readonly max: number;
  } | null;
}
