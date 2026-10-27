import type {
  AutomationDecision,
  AutomationTrace,
  AutomationTraceReadOptions,
  CommandReceipt,
  DomainEvent,
  DueSession,
  DueSessionReadOptions,
  EventReadOptions,
  HeadWriteOptions,
  OutboxKey,
  OutboxReadOptions,
  OutboxRecord,
  ReceiptInput,
  SessionCreateOptions,
  SessionHead,
  SessionOwner,
  StorageCapabilities,
  TerminalCleanupOptions,
} from './types.js';

export interface SessionTransaction {
  readonly sessionId: string;
  getHead(): Promise<SessionHead>;
  setHead(next: SessionHead, options?: HeadWriteOptions): Promise<SessionHead>;
  getAutomationDecision(decisionId: string): Promise<AutomationDecision | null>;
  putAutomationDecision(
    decision: AutomationDecision,
  ): Promise<AutomationDecision>;
  deleteAutomationDecision(decisionId: string): Promise<void>;
  clearAutomationDecisions(): Promise<void>;
  getAutomationTrace(traceId: string): Promise<AutomationTrace | null>;
  putAutomationTrace(trace: AutomationTrace): Promise<AutomationTrace>;
  getReceipt(
    commandId: string,
    actorPrincipalId?: string,
  ): Promise<CommandReceipt | null>;
  putReceipt(receipt: ReceiptInput): Promise<CommandReceipt>;
  appendEvents(events: readonly DomainEvent[]): Promise<readonly DomainEvent[]>;
  appendEvent(event: DomainEvent): Promise<DomainEvent>;
  appendOutboxMany(
    messages: readonly OutboxRecord[],
  ): Promise<readonly OutboxRecord[]>;
  appendOutbox(message: OutboxRecord): Promise<OutboxRecord>;
  /** Atomically removes private state and event history while retaining head/outbox/receipts. */
  clearPrivateState(options?: TerminalCleanupOptions): Promise<SessionHead>;
}

export interface StorageDriver {
  readonly capabilities: StorageCapabilities;

  /** Idempotently creates the initial head, enforcing (sessionId, startId). */
  createSession(
    head: SessionHead,
    options?: SessionCreateOptions,
  ): Promise<SessionHead>;
  getHead(sessionId: string): Promise<SessionHead | null>;
  getReceipt(
    sessionId: string,
    commandId: string,
    actorPrincipalId?: string,
  ): Promise<CommandReceipt | null>;

  /** The callback and all head/receipt/event/outbox writes share one transaction. */
  transaction<T>(
    sessionId: string,
    owner: SessionOwner,
    callback: (tx: SessionTransaction) => Promise<T>,
  ): Promise<T>;

  readEvents(
    sessionId: string,
    options: EventReadOptions,
  ): Promise<readonly DomainEvent[]>;
  readAutomationTraces(
    sessionId: string,
    options: AutomationTraceReadOptions,
  ): Promise<readonly AutomationTrace[]>;
  /** Removes expired private traces even when a session is otherwise idle. */
  pruneAutomationTraces(now?: number): Promise<number>;
  /** Returns a bounded, indexed view of active deadlines; it never scans history. */
  readDueSessions(
    options: DueSessionReadOptions,
  ): Promise<readonly DueSession[]>;
  readOutboxBatch(options: OutboxReadOptions): Promise<readonly OutboxRecord[]>;
  markOutboxDelivered(
    keys: readonly OutboxKey[],
    deliveredAt?: number,
  ): Promise<number>;

  /** Defers a failed delivery without discarding its durable fact. */
  markOutboxFailed(
    keys: readonly OutboxKey[],
    nextAttemptAt: number,
  ): Promise<number>;

  /** Atomically prunes terminal private state/events while retaining receipts and outbox rows. */
  clearTerminalSession(
    sessionId: string,
    options?: TerminalCleanupOptions,
  ): Promise<void>;
  close(): Promise<void>;
}

export type SessionStorageDriver = StorageDriver;
export type StorageTransaction = SessionTransaction;
