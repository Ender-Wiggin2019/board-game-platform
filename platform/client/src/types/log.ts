/** Severity of a captured diagnostic log line. */
export type TLogLevel = 'debug' | 'info' | 'warn' | 'error';

/** A bounded line in the platform client diagnostic ring buffer. */
export interface ILogEntry {
  ts: number;
  level: TLogLevel;
  source: string;
  message: string;
  data?: unknown;
}
