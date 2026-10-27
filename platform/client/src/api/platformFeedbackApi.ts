import type { JsonValue } from '@board-game/contracts';
import type {
  IPlatformAutomationReplayResult,
  IPlatformAutomationTrace,
  IPlatformFeedbackListResponse,
  IPlatformFeedbackReport,
  IPlatformFeedbackSubmitRequest,
  IPlatformNativeDiagnostics,
  TPlatformAutomationTraceKind,
  TPlatformFeedbackCategory,
  TPlatformFeedbackKind,
  TPlatformFeedbackScope,
  TPlatformFeedbackStatus,
} from '@board-platform/contracts';
import { httpClient } from '@/api/httpClient';

export interface PlatformFeedbackListParams {
  readonly limit?: number;
  readonly status?: TPlatformFeedbackStatus;
  readonly gameId?: string;
  readonly kind?: TPlatformFeedbackKind;
  readonly scope?: TPlatformFeedbackScope;
}

export interface PlatformFeedbackDraft {
  readonly category: TPlatformFeedbackCategory;
  readonly message: string;
  readonly expectedBehavior?: string;
  readonly gameId?: string;
  readonly sessionId?: string;
  readonly eventSequence?: number;
}

function feedbackPath(reportId: string): string {
  return `/platform/feedback/${encodeURIComponent(reportId)}`;
}

function createEventId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export const createPlatformFeedbackEventId = createEventId;

export const platformFeedbackApi = {
  async submit(
    input: IPlatformFeedbackSubmitRequest,
  ): Promise<IPlatformFeedbackReport> {
    const response = await httpClient.post<IPlatformFeedbackReport>(
      '/platform/feedback',
      input,
      { showServerUpdateDialog: true },
    );
    return response.data;
  },

  async listMine(
    params: PlatformFeedbackListParams = {},
  ): Promise<IPlatformFeedbackListResponse> {
    const response = await httpClient.get<IPlatformFeedbackListResponse>(
      '/platform/feedback/mine',
      { showServerUpdateDialog: true, params },
    );
    return response.data;
  },

  async list(
    params: PlatformFeedbackListParams = {},
  ): Promise<IPlatformFeedbackListResponse> {
    const response = await httpClient.get<IPlatformFeedbackListResponse>(
      '/platform/feedback',
      { showServerUpdateDialog: true, params },
    );
    return response.data;
  },

  async get(reportId: string): Promise<IPlatformFeedbackReport> {
    const response = await httpClient.get<IPlatformFeedbackReport>(
      feedbackPath(reportId),
      { showServerUpdateDialog: true },
    );
    return response.data;
  },

  async getMine(reportId: string): Promise<IPlatformFeedbackReport> {
    const response = await httpClient.get<IPlatformFeedbackReport>(
      `/platform/feedback/mine/${encodeURIComponent(reportId)}`,
      { showServerUpdateDialog: true },
    );
    return response.data;
  },

  async updateStatus(
    reportId: string,
    status: TPlatformFeedbackStatus,
  ): Promise<IPlatformFeedbackReport> {
    const response = await httpClient.patch<IPlatformFeedbackReport>(
      `${feedbackPath(reportId)}/status`,
      { status },
      { showServerUpdateDialog: true },
    );
    return response.data;
  },

  async diagnostics(sessionId: string): Promise<IPlatformNativeDiagnostics> {
    const response = await httpClient.get<IPlatformNativeDiagnostics>(
      `/platform/feedback/sessions/${encodeURIComponent(sessionId)}/diagnostics`,
      { showServerUpdateDialog: true },
    );
    return response.data;
  },

  async automationTraces(
    sessionId: string,
    params: {
      readonly limit?: number;
      readonly afterCreatedAt?: number;
      readonly kind?: TPlatformAutomationTraceKind;
    } = {},
  ): Promise<readonly IPlatformAutomationTrace[]> {
    const response = await httpClient.get<readonly IPlatformAutomationTrace[]>(
      `/platform/feedback/sessions/${encodeURIComponent(sessionId)}/automation-traces`,
      { showServerUpdateDialog: true, params },
    );
    return response.data;
  },

  async replayAutomation(
    sessionId: string,
    traceId: string,
  ): Promise<IPlatformAutomationReplayResult> {
    const response = await httpClient.post<IPlatformAutomationReplayResult>(
      `/platform/feedback/sessions/${encodeURIComponent(sessionId)}/automation-traces/${encodeURIComponent(traceId)}/replay`,
      undefined,
      { showServerUpdateDialog: true },
    );
    return response.data;
  },

  async traceEvidence(reportId: string): Promise<IPlatformAutomationTrace> {
    const response = await httpClient.get<IPlatformAutomationTrace>(
      `${feedbackPath(reportId)}/trace-evidence`,
      { showServerUpdateDialog: true },
    );
    return response.data;
  },

  async replayTraceEvidence(
    reportId: string,
  ): Promise<IPlatformAutomationReplayResult> {
    const response = await httpClient.post<IPlatformAutomationReplayResult>(
      `${feedbackPath(reportId)}/trace-evidence/replay`,
      undefined,
      { showServerUpdateDialog: true },
    );
    return response.data;
  },

  async statistics(gameId: string): Promise<JsonValue> {
    const response = await httpClient.get<JsonValue>(
      `/platform/games/${encodeURIComponent(gameId)}/stats`,
      { showServerUpdateDialog: true },
    );
    return response.data;
  },
};
