export const CLIENT_CRASH_KINDS = ['exception', 'opaque', 'resource'] as const;
export type TClientCrashKind = (typeof CLIENT_CRASH_KINDS)[number];

/**
 * A report target supplied by a client is only a lookup hint. The server must
 * resolve and authorize the native session before persisting it.
 */
export interface IErrorReportNativeTarget {
  kind: 'native-session';
  sessionId: string;
}

/** Optional browser capabilities are omitted when the browser does not expose them. */
export interface IClientCrashEnvironment {
  timezone?: string;
  languages?: string[];
  platform?: string;
  vendor?: string;
  online?: boolean;
  visibilityState?: string;
  readyState?: string;
  viewport?: { width: number; height: number };
  screen?: { width: number; height: number; colorDepth: number };
  devicePixelRatio?: number;
  hardwareConcurrency?: number;
  deviceMemory?: number;
  maxTouchPoints?: number;
  cookieEnabled?: boolean;
  standalone?: boolean;
  serviceWorker?: string;
  connection?: {
    effectiveType?: string;
    downlink?: number;
    rtt?: number;
    saveData?: boolean;
  };
}

/** Original browser event data, never a stack synthesized by the reporter. */
export interface IClientCrashErrorContext {
  opaque?: boolean;
  errorPresent?: boolean;
  isTrusted?: boolean;
  filename?: string;
  line?: number;
  column?: number;
  resourceUrl?: string;
  previousRecoveryAt?: string;
}

/** Sources that can report a client crash before a user is authenticated. */
export const CLIENT_CRASH_SOURCES = [
  'bootstrap',
  'window',
  'unhandledrejection',
  'route',
  'react',
  'section',
  'resource',
] as const;
export type TClientCrashSource = (typeof CLIENT_CRASH_SOURCES)[number];

export const CLIENT_CRASH_MAX_LENGTHS = {
  message: 2000,
  name: 100,
  stack: 16000,
  componentStack: 16000,
  url: 2048,
  appVersion: 100,
  userAgent: 512,
  locale: 40,
  capturedAt: 40,
  environmentText: 200,
  languageCount: 10,
} as const;

/** Minimal, bounded crash evidence accepted by the anonymous crash endpoint. */
export interface IClientCrashReport {
  eventId: string;
  source: TClientCrashSource;
  message: string;
  name?: string | null;
  stack?: string | null;
  componentStack?: string | null;
  url: string;
  appVersion?: string | null;
  userAgent: string;
  locale: string;
  capturedAt: string;
  gameId?: string | null;
  target?: IErrorReportNativeTarget;
  environment?: IClientCrashEnvironment;
  errorContext?: IClientCrashErrorContext;
}

export interface IClientCrashReportResponse {
  /** Receipt for this event; remains stable when an upload is retried. */
  id: string;
  /** Canonical report group containing the event. */
  reportId: string;
}
