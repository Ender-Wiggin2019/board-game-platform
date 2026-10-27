import {
  type IClientCrashEnvironment,
  type IClientCrashErrorContext,
  type IClientCrashReport,
  CLIENT_CRASH_MAX_LENGTHS as LIMITS,
} from '@board-platform/contracts/types/protocol/clientCrash';
import { readStaleChunkRecoveryAt } from './staleChunkRecovery';

export interface ICrashContext {
  source: IClientCrashReport['source'];
  componentStack?: string;
  errorContext?: IClientCrashErrorContext;
}
export interface ICrashReportState {
  status: 'idle' | 'sending' | 'sent' | 'failed' | 'limited';
  reportId?: string;
}
export interface ICrashIncident {
  subscribe(listener: () => void): () => void;
  getSnapshot(): ICrashReportState;
  submit(): Promise<void>;
}

type TCrashTokenGetter = () => string | null | undefined;

const STORAGE_KEY = 'seti:crash-reports:v1';
const WINDOW_MS = 60_000;
const MAX_AUTOMATIC_REPORTS = 5;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESOURCE_PATH_PATTERN =
  /(?:\/assets\/|\.(?:css|js|mjs|json|wasm)(?::\d+(?::\d+)?)?$)/i;
const URL_TOKEN_PATTERN = /https?:\/\/[^\s)"'<>]+|\/[^\s)"'<>]+/g;
const incidents = new Map<string, { incident: ICrashIncident; at: number }>();
let installed = false;
let attempts: number[] = [];
let crashContextProvider: TCrashTokenGetter | null = null;

/**
 * Install the one small piece of authenticated context the collector needs.
 * The provider itself is never persisted and is evaluated only at capture
 * time, so a later logout or account switch cannot change an old incident.
 */
export function setCrashContextProvider(
  provider: TCrashTokenGetter | null,
): void {
  crashContextProvider = provider;
}

function readCrashToken(): string | undefined {
  try {
    const token = crashContextProvider?.();
    return typeof token === 'string' && token.length > 0 ? token : undefined;
  } catch {
    /* Auth state is optional for an anonymous crash report. */
  }
  return undefined;
}

function readValue<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

function boundedString(
  value: unknown,
  limit: number = LIMITS.environmentText,
): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value.slice(0, limit);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

type IConnectionLike = {
  effectiveType?: unknown;
  downlink?: unknown;
  rtt?: unknown;
  saveData?: unknown;
};
type IExtendedNavigator = Navigator & {
  connection?: IConnectionLike;
  deviceMemory?: unknown;
  standalone?: unknown;
};

function collectEnvironment(): IClientCrashEnvironment | undefined {
  const environment: IClientCrashEnvironment = {};
  const browserNavigator = readValue(() => navigator) as
    | IExtendedNavigator
    | undefined;
  const browserWindow = readValue(() => window);
  const browserDocument = readValue(() => document);

  const timezone = readValue(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const timezoneText = boundedString(timezone);
  if (timezoneText) environment.timezone = timezoneText;

  if (browserNavigator) {
    const languages = readValue(() => browserNavigator.languages);
    if (Array.isArray(languages)) {
      const values = languages
        .filter((language): language is string => typeof language === 'string')
        .map((language) => language.slice(0, LIMITS.locale))
        .filter(Boolean)
        .slice(0, LIMITS.languageCount);
      if (values.length > 0) environment.languages = values;
    }

    const platform = boundedString(readValue(() => browserNavigator.platform));
    if (platform) environment.platform = platform;
    const vendor = boundedString(readValue(() => browserNavigator.vendor));
    if (vendor) environment.vendor = vendor;

    const online = readValue(() => browserNavigator.onLine);
    if (typeof online === 'boolean') environment.online = online;

    const hardwareConcurrency = finiteNumber(
      readValue(() => browserNavigator.hardwareConcurrency),
    );
    if (hardwareConcurrency !== undefined) {
      environment.hardwareConcurrency = hardwareConcurrency;
    }
    const deviceMemory = finiteNumber(
      readValue(() => browserNavigator.deviceMemory),
    );
    if (deviceMemory !== undefined) environment.deviceMemory = deviceMemory;
    const maxTouchPoints = finiteNumber(
      readValue(() => browserNavigator.maxTouchPoints),
    );
    if (maxTouchPoints !== undefined) {
      environment.maxTouchPoints = maxTouchPoints;
    }

    const cookieEnabled = readValue(() => browserNavigator.cookieEnabled);
    if (typeof cookieEnabled === 'boolean') {
      environment.cookieEnabled = cookieEnabled;
    }

    const nativeStandalone = readValue(() => browserNavigator.standalone);
    if (typeof nativeStandalone === 'boolean') {
      environment.standalone = nativeStandalone;
    } else {
      const displayModeStandalone = readValue(
        () => browserWindow?.matchMedia?.('(display-mode: standalone)').matches,
      );
      if (typeof displayModeStandalone === 'boolean') {
        environment.standalone = displayModeStandalone;
      }
    }

    const serviceWorker = readValue(() => browserNavigator.serviceWorker);
    if (serviceWorker !== undefined) {
      const controller = readValue(() => serviceWorker?.controller);
      environment.serviceWorker = controller ? 'controlled' : 'supported';
    }

    const connection = readValue(() => browserNavigator.connection);
    if (connection && typeof connection === 'object') {
      const connectionEnvironment: NonNullable<
        IClientCrashEnvironment['connection']
      > = {};
      const effectiveType = boundedString(
        readValue(() => connection.effectiveType),
      );
      if (effectiveType) connectionEnvironment.effectiveType = effectiveType;
      const downlink = finiteNumber(readValue(() => connection.downlink));
      if (downlink !== undefined) connectionEnvironment.downlink = downlink;
      const rtt = finiteNumber(readValue(() => connection.rtt));
      if (rtt !== undefined) connectionEnvironment.rtt = rtt;
      const saveData = readValue(() => connection.saveData);
      if (typeof saveData === 'boolean') {
        connectionEnvironment.saveData = saveData;
      }
      if (Object.keys(connectionEnvironment).length > 0) {
        environment.connection = connectionEnvironment;
      }
    }
  }

  const visibilityState = boundedString(
    readValue(() => browserDocument?.visibilityState),
  );
  if (visibilityState) environment.visibilityState = visibilityState;
  const readyState = boundedString(
    readValue(() => browserDocument?.readyState),
  );
  if (readyState) environment.readyState = readyState;

  const viewportWidth = finiteNumber(
    readValue(() => browserWindow?.innerWidth),
  );
  const viewportHeight = finiteNumber(
    readValue(() => browserWindow?.innerHeight),
  );
  if (viewportWidth !== undefined && viewportHeight !== undefined) {
    environment.viewport = { width: viewportWidth, height: viewportHeight };
  }

  const screenWidth = finiteNumber(
    readValue(() => browserWindow?.screen?.width),
  );
  const screenHeight = finiteNumber(
    readValue(() => browserWindow?.screen?.height),
  );
  const colorDepth = finiteNumber(
    readValue(() => browserWindow?.screen?.colorDepth),
  );
  if (
    screenWidth !== undefined &&
    screenHeight !== undefined &&
    colorDepth !== undefined
  ) {
    environment.screen = {
      width: screenWidth,
      height: screenHeight,
      colorDepth,
    };
  }

  const devicePixelRatio = finiteNumber(
    readValue(() => browserWindow?.devicePixelRatio),
  );
  if (devicePixelRatio !== undefined) {
    environment.devicePixelRatio = devicePixelRatio;
  }

  return Object.keys(environment).length > 0 ? environment : undefined;
}

function sanitizeCrashUrl(url: URL): string {
  const pathname = url.pathname.replace(
    /^(\/(?:replay\/shared|t|setup))\/[^/]+/,
    '$1/[redacted]',
  );
  return `${url.origin}${pathname}`;
}

function currentUrl(): URL | undefined {
  return readValue(() => new URL(window.location.href));
}

function sanitizeUrlToken(raw: string): string {
  const base = currentUrl();
  try {
    const url = new URL(raw, base?.href ?? 'http://localhost');
    return sanitizeCrashUrl(url);
  } catch {
    return '[url]';
  }
}

/** Strip credentials and URL query/hash values before diagnostics leave the browser. */
export function sanitizeCrashText(value: string, limit: number): string {
  return value
    .replace(/https?:\/\/[^\s)"'<>]+/g, (raw) => sanitizeUrlToken(raw))
    .replace(
      /(^|[\s:(])((?:\/|\.\/|\.\.\/)[^\s)"'<>]+[?#][^\s)"'<>]*)/g,
      (_match, prefix: string, raw: string) =>
        `${prefix}${sanitizeUrlToken(raw)}`,
    )
    .replace(/(bearer\s+)[\w.~-]+/gi, '$1[redacted]')
    .replace(
      /(["']?(?:[\w-]*token|password|secret|authorization|api[_-]?key|cookie)["']?\s*[=:]\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s&,;}]+)/gi,
      (_match, prefix: string, raw: string) => {
        const quote = raw.startsWith('"') || raw.startsWith("'") ? raw[0] : '';
        return `${prefix}${quote}[redacted]${quote}`;
      },
    )
    .slice(0, limit);
}

function errorDetails(error: unknown): {
  name: string;
  message: string;
  stack?: string;
} {
  try {
    if (error instanceof Error) {
      return {
        name: error.name,
        message: error.message,
        stack: typeof error.stack === 'string' ? error.stack : undefined,
      };
    }
    if (
      error &&
      typeof error === 'object' &&
      'message' in error &&
      typeof error.message === 'string'
    ) {
      return {
        name:
          'name' in error && typeof error.name === 'string'
            ? error.name
            : 'Error',
        message: error.message,
        stack:
          'stack' in error && typeof error.stack === 'string'
            ? error.stack
            : undefined,
      };
    }
    return {
      name: 'Error',
      message: typeof error === 'string' ? error : String(error),
    };
  } catch {
    return { name: 'Error', message: 'Unserializable error' };
  }
}

type TSavedIncident = {
  key: string;
  eventId: string;
  at: number;
  sent: boolean;
  reportId?: string;
};

function sessionStore(): Pick<Storage, 'getItem' | 'setItem'> | undefined {
  return readValue(() => sessionStorage);
}

function readSaved(): { reports: TSavedIncident[]; attempts: number[] } {
  try {
    const storage = sessionStore();
    const data = JSON.parse(storage?.getItem(STORAGE_KEY) ?? '{}');
    return {
      reports: Array.isArray(data.reports)
        ? data.reports
            .filter(
              (item: TSavedIncident) =>
                typeof item.key === 'string' &&
                typeof item.eventId === 'string' &&
                typeof item.at === 'number' &&
                Date.now() - item.at < WINDOW_MS,
            )
            .map((item: TSavedIncident) => ({
              ...item,
              ...(typeof item.reportId === 'string'
                ? { reportId: item.reportId }
                : {}),
            }))
            .slice(-20)
        : [],
      attempts: Array.isArray(data.attempts)
        ? data.attempts.filter(
            (at: number) =>
              typeof at === 'number' && Date.now() - at < WINDOW_MS,
          )
        : [],
    };
  } catch {
    return { reports: [], attempts: [] };
  }
}

function saveIncident(
  key: string,
  eventId: string,
  sent: boolean,
  reportId?: string,
): void {
  try {
    const storage = sessionStore();
    if (!storage) return;
    const saved = readSaved();
    saved.reports = saved.reports.filter((item) => item.key !== key);
    saved.reports.push({
      key,
      eventId,
      at: Date.now(),
      sent,
      ...(reportId ? { reportId } : {}),
    });
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({ reports: saved.reports.slice(-20), attempts }),
    );
  } catch {
    /* Reporting must still work when browser storage is unavailable. */
  }
}

function fingerprint(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++)
    hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16);
}

function classifyCrashFailureKind(
  source: IClientCrashReport['source'],
  message: string,
  errorContext: IClientCrashErrorContext | undefined,
): 'opaque' | 'exception' {
  if (
    errorContext?.opaque === true ||
    errorContext?.errorPresent === false ||
    (source === 'window' && message === 'Script error.')
  ) {
    return 'opaque';
  }
  return 'exception';
}

function sanitizeEventContext(
  context: ICrashContext['errorContext'] | undefined,
  message: string,
  source: IClientCrashReport['source'],
): IClientCrashErrorContext | undefined {
  const normalized: IClientCrashErrorContext = {};
  if (typeof context?.opaque === 'boolean') normalized.opaque = context.opaque;
  if (typeof context?.errorPresent === 'boolean') {
    normalized.errorPresent = context.errorPresent;
  }
  if (typeof context?.isTrusted === 'boolean') {
    normalized.isTrusted = context.isTrusted;
  }
  if (typeof context?.filename === 'string') {
    normalized.filename = sanitizeCrashText(context.filename, LIMITS.url);
  }
  if (finiteNumber(context?.line) !== undefined) {
    normalized.line = context?.line;
  }
  if (finiteNumber(context?.column) !== undefined) {
    normalized.column = context?.column;
  }

  const resourceUrl =
    context?.resourceUrl ?? extractFirstPartyResourceUrl(message);
  if (resourceUrl) {
    const sanitizedResource = extractFirstPartyResourceUrl(resourceUrl);
    if (sanitizedResource) normalized.resourceUrl = sanitizedResource;
  }

  const previousRecoveryAt =
    context?.previousRecoveryAt ??
    (source === 'resource' || normalized.resourceUrl
      ? readStaleChunkRecoveryAt(sessionStore())
      : undefined);
  if (previousRecoveryAt) {
    const timestamp = Number(previousRecoveryAt);
    const recoveryDate = Number.isFinite(timestamp)
      ? readValue(() => new Date(timestamp).toISOString())
      : readValue(() => new Date(previousRecoveryAt).toISOString());
    if (recoveryDate) normalized.previousRecoveryAt = recoveryDate;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function extractFirstPartyResourceUrl(text: string): string | undefined {
  const pageUrl = currentUrl();
  if (!pageUrl) return undefined;
  const candidates = text.match(URL_TOKEN_PATTERN) ?? [];
  for (const candidate of candidates) {
    const raw = candidate.replace(/[.,;:)\]}]+$/, '');
    const parsed = readValue(() => new URL(raw, pageUrl.href));
    if (!parsed || parsed.origin !== pageUrl.origin) continue;
    if (!RESOURCE_PATH_PATTERN.test(parsed.pathname)) continue;
    return sanitizeCrashUrl(parsed).slice(0, LIMITS.url);
  }
  return undefined;
}

function extractGameId(url: URL | undefined): string | undefined {
  if (!url || !/^\/game\//i.test(url.pathname)) return undefined;
  const segment = url.pathname.split('/')[2];
  return segment && UUID_PATTERN.test(segment) ? segment : undefined;
}

function makeEventId(): string {
  const randomUuid = readValue(() => globalThis.crypto?.randomUUID?.());
  if (randomUuid) return randomUuid;
  return '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (digit) =>
    (Number(digit) ^ ((Math.random() * 16) >> (Number(digit) / 4))).toString(
      16,
    ),
  );
}

function utf8ByteLength(text: string): number {
  let length = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code <= 0x7f) {
      length += 1;
    } else if (code <= 0x7ff) {
      length += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        length += 4;
        index += 1;
      } else {
        length += 3;
      }
    } else {
      length += 3;
    }
  }
  return length;
}

function byteLength(text: string): number {
  return (
    readValue(() => new TextEncoder().encode(text).byteLength) ??
    utf8ByteLength(text)
  );
}

function serializePayload(payload: IClientCrashReport): string {
  let body = JSON.stringify(payload);
  while (byteLength(body) > 60_000) {
    const nextStack = payload.stack?.slice(
      0,
      Math.floor(payload.stack.length / 2),
    );
    const nextComponentStack = payload.componentStack?.slice(
      0,
      Math.floor(payload.componentStack.length / 2),
    );
    if (
      nextStack === payload.stack &&
      nextComponentStack === payload.componentStack
    ) {
      break;
    }
    payload.stack = nextStack;
    payload.componentStack = nextComponentStack;
    body = JSON.stringify(payload);
  }
  return body;
}

/** No stores, router, React, i18n or authenticated HTTP client in this dependency graph. */
export function captureCrash(
  error: unknown,
  context: ICrashContext,
): ICrashIncident {
  const detail = errorDetails(error);
  const message = sanitizeCrashText(detail.message, LIMITS.message);
  const stack = detail.stack
    ? sanitizeCrashText(detail.stack, LIMITS.stack)
    : undefined;
  const pageUrl = currentUrl();
  const url = pageUrl ? sanitizeCrashUrl(pageUrl).slice(0, LIMITS.url) : '';
  const appVersion =
    boundedString(
      readValue(() => import.meta.env.VITE_APP_VERSION),
      LIMITS.appVersion,
    ) ?? 'development';
  const errorContext = sanitizeEventContext(
    context.errorContext,
    `${message}\n${stack ?? ''}`,
    context.source,
  );
  const failureKind = classifyCrashFailureKind(
    context.source,
    message,
    errorContext,
  );
  const key = fingerprint(
    `${failureKind}|${appVersion}|${url}|${message}|${stack ?? ''}|${errorContext?.resourceUrl ?? ''}|${errorContext?.filename ?? ''}|${errorContext?.line ?? ''}|${errorContext?.column ?? ''}`,
  );
  const existing = incidents.get(key);
  if (
    existing &&
    (Date.now() - existing.at < WINDOW_MS ||
      existing.incident.getSnapshot().status === 'sending')
  ) {
    return existing.incident;
  }
  const saved = readSaved();
  const previous = saved.reports.find((item) => item.key === key);
  const eventId = previous?.eventId ?? makeEventId();
  const authorizationToken = readCrashToken();
  const browserNavigator = readValue(() => navigator) as Navigator | undefined;
  const userAgent =
    boundedString(
      readValue(() => browserNavigator?.userAgent),
      LIMITS.userAgent,
    ) ?? '';
  const locale =
    boundedString(
      readValue(() => browserNavigator?.language),
      LIMITS.locale,
    ) ?? '';
  const payload: IClientCrashReport = {
    eventId,
    source: context.source,
    name: sanitizeCrashText(detail.name, LIMITS.name),
    message,
    stack,
    componentStack: context.componentStack
      ? sanitizeCrashText(context.componentStack, LIMITS.componentStack)
      : undefined,
    url,
    appVersion,
    userAgent,
    locale,
    capturedAt: new Date().toISOString(),
    gameId: extractGameId(pageUrl),
    environment: collectEnvironment(),
    errorContext,
  };
  let state: ICrashReportState = previous?.sent
    ? { status: 'sent', reportId: previous.reportId ?? previous.eventId }
    : { status: 'idle' };
  let pending: Promise<void> | undefined;
  const listeners = new Set<() => void>();
  const setState = (next: ICrashReportState) => {
    state = next;
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        /* A broken UI subscriber must not break reporting. */
      }
    }
  };
  const submit = (): Promise<void> => {
    if (pending) return pending;
    if (state.status === 'sent') return Promise.resolve();
    setState({ status: 'sending' });
    saveIncident(key, eventId, false);
    pending = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const controller = new AbortController();
        timer = setTimeout(() => controller.abort(), 10_000);
        const base = import.meta.env.DEV
          ? (import.meta.env.VITE_API_URL ?? '/api')
          : '/api';
        const body = serializePayload(payload);
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };
        if (authorizationToken) {
          headers.Authorization = `Bearer ${authorizationToken}`;
        }
        const response = await fetch(
          `${base.replace(/\/$/, '')}/platform/feedback/client-crash`,
          {
            method: 'POST',
            headers,
            credentials: 'omit',
            body,
            signal: controller.signal,
            keepalive: true,
          },
        );
        if (!response.ok) throw new Error('Report rejected');
        const result: unknown = await response.json();
        if (
          !result ||
          typeof result !== 'object' ||
          !('id' in result) ||
          typeof result.id !== 'string' ||
          result.id !== eventId
        ) {
          throw new Error('Invalid report receipt');
        }
        // Older deployments used the event id as the canonical report id.
        // Grouped responses keep id as the event receipt and return reportId
        // for the canonical group, so preserve that legacy fallback.
        const reportId =
          'reportId' in result &&
          typeof result.reportId === 'string' &&
          result.reportId.length > 0
            ? result.reportId
            : result.id;
        saveIncident(key, eventId, true, reportId);
        setState({ status: 'sent', reportId });
      } catch {
        // Never log/rethrow a reporting failure: that would recursively report itself.
        setState({ status: 'failed' });
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    })().finally(() => {
      pending = undefined;
    });
    return pending;
  };
  const incident: ICrashIncident = {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => state,
    submit,
  };
  incidents.set(key, { incident, at: Date.now() });
  if (incidents.size > 20)
    incidents.delete(incidents.keys().next().value as string);
  if (state.status !== 'sent') {
    attempts = (
      saved.attempts.length > attempts.length ? saved.attempts : attempts
    ).filter((at) => Date.now() - at < WINDOW_MS);
    if (attempts.length >= MAX_AUTOMATIC_REPORTS) {
      setState({ status: 'limited' });
    } else {
      attempts.push(Date.now());
      saveIncident(key, eventId, false);
      void submit();
    }
  }
  return incident;
}

function isErrorEvent(event: Event): event is ErrorEvent {
  return (
    (typeof ErrorEvent !== 'undefined' && event instanceof ErrorEvent) ||
    'message' in event
  );
}

function eventErrorContext(event: ErrorEvent): IClientCrashErrorContext {
  const errorPresent = event.error !== null && event.error !== undefined;
  return {
    opaque: !errorPresent,
    errorPresent,
    isTrusted: event.isTrusted,
    filename: event.filename,
    line: finiteNumber(event.lineno),
    column: finiteNumber(event.colno),
    resourceUrl: extractFirstPartyResourceUrl(event.message),
  };
}

export function installCrashReporting(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('error', (event) => {
    if (!isErrorEvent(event)) return;
    const errorEvent = event as ErrorEvent;
    const error = errorEvent.error ?? (errorEvent.message || 'Uncaught error');
    captureCrash(error, {
      source: 'window',
      errorContext: eventErrorContext(errorEvent),
    });
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    captureCrash(reason ?? 'Unhandled promise rejection', {
      source: 'unhandledrejection',
      errorContext: {
        opaque: reason === null || reason === undefined,
        errorPresent: reason !== null && reason !== undefined,
        isTrusted: event.isTrusted,
      },
    });
  });
  window.addEventListener('vite:preloadError', (event) => {
    const payload = (event as Event & { payload?: unknown }).payload;
    captureCrash(payload ?? 'Failed to load a client resource', {
      source: 'resource',
      errorContext: {
        opaque: payload === null || payload === undefined,
        errorPresent: payload !== null && payload !== undefined,
        isTrusted: event.isTrusted,
        resourceUrl: extractFirstPartyResourceUrl(
          errorDetails(payload).message,
        ),
      },
    });
  });
}
