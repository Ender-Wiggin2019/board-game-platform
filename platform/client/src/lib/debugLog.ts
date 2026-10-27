// biome-ignore-all lint/suspicious/noConsole: this module intentionally wraps console to capture diagnostics
import type { ILogEntry, TLogLevel } from '../types/log.js';

/**
 * Lightweight in-memory diagnostic ring buffer. Captures console output,
 * uncaught errors, and a summary of WebSocket traffic so a submitted error
 * report carries the run-up to the failure. Bounded to MAX_ENTRIES; oldest
 * lines are dropped first. No-op until `setupDebugLog()` runs at bootstrap.
 */

const MAX_ENTRIES = 300;
/** Cap on stringified `message`/`data` length to keep the buffer bounded. */
const MAX_FIELD_LENGTH = 2000;

const buffer: ILogEntry[] = [];
let installed = false;

function truncate(text: string): string {
  return text.length > MAX_FIELD_LENGTH
    ? `${text.slice(0, MAX_FIELD_LENGTH)}…[truncated ${text.length - MAX_FIELD_LENGTH}]`
    : text;
}

function stringifyArg(arg: unknown): string {
  if (typeof arg === 'string') {
    return arg;
  }
  if (arg instanceof Error) {
    return `${arg.name}: ${arg.message}`;
  }
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

/** Append one structured entry to the ring buffer. */
export function logDebug(
  level: TLogLevel,
  source: string,
  message: string,
  data?: unknown,
): void {
  const entry: ILogEntry = {
    ts: Date.now(),
    level,
    source,
    message: truncate(message),
  };
  if (data !== undefined) {
    entry.data = truncate(stringifyArg(data));
  }
  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) {
    buffer.splice(0, buffer.length - MAX_ENTRIES);
  }
}

/** Return a copy of the current buffer (oldest-first). */
export function getLogSnapshot(): ILogEntry[] {
  return buffer.slice();
}

/**
 * Patch console methods and install global error listeners. Idempotent and
 * safe to call once at app bootstrap. Original console behavior is preserved.
 */
export function setupDebugLog(): void {
  if (installed || typeof window === 'undefined') {
    return;
  }
  installed = true;

  const levels: TLogLevel[] = ['debug', 'info', 'warn', 'error'];
  const consoleMethods: Record<TLogLevel, 'debug' | 'info' | 'warn' | 'error'> =
    { debug: 'debug', info: 'info', warn: 'warn', error: 'error' };

  for (const level of levels) {
    const method = consoleMethods[level];
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      original(...args);
      logDebug(level, 'console', args.map(stringifyArg).join(' '));
    };
  }

  window.addEventListener('error', (event) => {
    logDebug('error', 'window', event.message, {
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      stack: event.error instanceof Error ? event.error.stack : undefined,
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    logDebug(
      'error',
      'window',
      reason instanceof Error
        ? `Unhandled rejection: ${reason.message}`
        : 'Unhandled rejection',
      reason instanceof Error ? reason.stack : reason,
    );
  });
}
