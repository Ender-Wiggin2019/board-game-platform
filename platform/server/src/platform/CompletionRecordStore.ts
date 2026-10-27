import { createHash, randomUUID } from 'node:crypto';
import {
  assertGameResult,
  assertJsonPayloadSize,
  assertParticipant,
  assertSessionRoute,
  type CompletionAchievementSource,
  type CompletionProcessingState,
  type CompletionRecordConflict,
  type CompletionRecordSource,
  type CompletionReplayRef,
  canonicalStableStringify,
  type GameResult,
  type MatchAdmission,
  type PlatformCompletionRecord,
  type PlatformCompletionStatus,
  type SessionRoute,
} from '@board-game/contracts';
import type { Pool } from 'pg';

export const DEFAULT_COMPLETION_SCHEMA = 'board_platform_completion';
const MAX_CONFLICTS = 1_000;
const MAX_RECORD_BYTES = 1024 * 1024;
const TERMINAL_STATUSES: readonly PlatformCompletionStatus[] = [
  'completed',
  'cancelled',
  'aborted',
  'invalid',
];

export type CompletionAdmissionLookup = Pick<
  import('@board-game/core').AdmissionStore,
  'getAdmission'
>;

export interface CompletionRecordInput {
  readonly platformId: string;
  readonly admission: MatchAdmission;
  readonly status: PlatformCompletionStatus;
  readonly resultRevision: number;
  readonly sourceRevision?: number;
  readonly endedAt: number;
  readonly result?: GameResult;
  readonly resultSchemaVersion?: number;
  readonly replayRef?: CompletionReplayRef;
  readonly achievementSources?: readonly CompletionAchievementSource[];
  readonly source?: CompletionRecordSource;
}

/** Bounded business identity retained for an imported historical result. */
export interface HistoricalCompletionBaseline {
  readonly sourceSystem: string;
  readonly sourceKey: string;
  readonly sourceDigest: string;
}

/** Operator-only input for importing a result already settled by a legacy writer. */
export interface HistoricalCompletionImportInput {
  readonly record: CompletionRecordInput;
  readonly baseline: HistoricalCompletionBaseline;
}

export interface HistoricalCompletionImportResult {
  readonly status: 'imported' | 'duplicate';
  readonly record: PlatformCompletionRecord;
  readonly baseline: HistoricalCompletionBaseline;
}

/** Shape accepted from the durable Inbox without coupling contracts to Inbox types. */
export interface CompletionFactEnvelope {
  readonly producerId: string;
  readonly eventId: string;
  readonly sessionId?: string;
  readonly kind: string;
  readonly schemaVersion: number;
  readonly sourceRelease: string;
  readonly aggregateSequence?: number;
  readonly payload: unknown;
  readonly digest?: string;
  readonly occurredAt?: number;
  readonly receivedAt?: number;
}

export interface CompletionRecordStoreOptions {
  /** Default used by the envelope overload of accept. */
  readonly platformId?: string;
  readonly schema?: string;
  readonly admission?: CompletionAdmissionLookup;
  readonly now?: () => number;
}

export interface CompletionAcceptResult {
  readonly status: 'accepted' | 'duplicate';
  readonly record: PlatformCompletionRecord;
}

export interface CompletionClaim {
  readonly record: PlatformCompletionRecord;
  readonly owner: string;
  readonly token: string;
  readonly leaseUntil: number;
}

export interface CompletionClaimOptions {
  readonly owner: string;
  readonly limit?: number;
  readonly leaseMs?: number;
  readonly now?: number;
}

export interface CompletionProcessOptions {
  readonly settle?: (record: PlatformCompletionRecord) => Promise<void>;
}

export type CompletionRecordStoreErrorCode =
  | 'INVALID_ARGUMENT'
  | 'ADMISSION_NOT_FOUND'
  | 'ROUTE_MISMATCH'
  | 'RESULT_INVALID'
  | 'REVISION_NOT_ALLOWED'
  | 'CONFLICT'
  | 'NOT_FOUND'
  | 'CLAIM_LOST'
  | 'INVALID_STATE';

export class CompletionRecordStoreError extends Error {
  readonly name = 'CompletionRecordStoreError';

  constructor(
    readonly code: CompletionRecordStoreErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
  }
}

export interface CompletionRecordStore {
  accept(input: CompletionRecordInput): Promise<CompletionAcceptResult>;
  accept(
    envelope: CompletionFactEnvelope,
    admission: MatchAdmission,
  ): Promise<CompletionAcceptResult>;
  /**
   * Operator-only historical import. Never expose this through fact ingress or
   * public HTTP: the imported record is already settled by its legacy writer.
   */
  importSettledHistorical(
    input: HistoricalCompletionImportInput,
  ): Promise<HistoricalCompletionImportResult>;
  getHistoricalBaseline(
    platformId: string,
    sessionId: string,
    resultRevision?: number,
  ): Promise<HistoricalCompletionBaseline | null>;
  get(
    platformId: string,
    sessionId: string,
    resultRevision?: number,
  ): Promise<PlatformCompletionRecord | null>;
  listConflicts(
    platformId: string,
    sessionId?: string,
    limit?: number,
  ): Promise<readonly CompletionRecordConflict[]>;
  claimNext(options: CompletionClaimOptions): Promise<CompletionClaim | null>;
  renewClaim(
    claim: CompletionClaim,
    leaseMs?: number,
  ): Promise<CompletionClaim>;
  markResultStored(claim: CompletionClaim): Promise<PlatformCompletionRecord>;
  markSettling(claim: CompletionClaim): Promise<PlatformCompletionRecord>;
  markSettled(claim: CompletionClaim): Promise<PlatformCompletionRecord>;
  fail(
    claim: CompletionClaim,
    error: unknown,
    nextAttemptAt?: number,
  ): Promise<PlatformCompletionRecord>;
  processClaim(
    claim: CompletionClaim,
    options?: CompletionProcessOptions,
  ): Promise<PlatformCompletionRecord>;
  migrate?(): Promise<void>;
  close?(): Promise<void>;
}

function assertSchemaName(schema: string): void {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(schema))
    throw new CompletionRecordStoreError(
      'INVALID_ARGUMENT',
      'Completion schema must be a lower-case SQL identifier',
    );
}

function tableName(
  schema: string,
  table: 'records' | 'conflicts' | 'historical_baselines',
): string {
  assertSchemaName(schema);
  return `"${schema}"."${table}"`;
}

export function completionRecordMigrationStatements(
  schema = DEFAULT_COMPLETION_SCHEMA,
): readonly string[] {
  assertSchemaName(schema);
  const records = tableName(schema, 'records');
  const conflicts = tableName(schema, 'conflicts');
  const historicalBaselines = tableName(schema, 'historical_baselines');
  return [
    `CREATE SCHEMA IF NOT EXISTS "${schema}"`,
    `CREATE TABLE IF NOT EXISTS ${records} (
      platform_id text NOT NULL,
      session_id text NOT NULL,
      result_revision integer NOT NULL CHECK (result_revision >= 1),
      admission_id text NOT NULL,
      route jsonb NOT NULL,
      status text NOT NULL CHECK (status IN ('completed', 'cancelled', 'aborted', 'invalid')),
      result_schema_version integer NOT NULL CHECK (result_schema_version >= 1),
      source_revision integer NOT NULL CHECK (source_revision >= 1),
      result jsonb,
      participants jsonb NOT NULL,
      validity_policy_version text NOT NULL,
      rating jsonb,
      ended_at double precision NOT NULL,
      replay_ref jsonb,
      achievement_sources jsonb,
      source jsonb,
      digest text NOT NULL,
      processing_state text NOT NULL CHECK (processing_state IN ('received', 'result-stored', 'settling', 'settled', 'conflict')),
      attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      next_attempt_at double precision,
      processing_error text,
      claim_owner text,
      claim_token text,
      lease_until double precision,
      received_at double precision NOT NULL,
      updated_at double precision NOT NULL,
      PRIMARY KEY (platform_id, session_id, result_revision)
    )`,
    `ALTER TABLE ${records} ADD COLUMN IF NOT EXISTS source_revision integer`,
    `ALTER TABLE ${records} ADD COLUMN IF NOT EXISTS achievement_sources jsonb`,
    `UPDATE ${records}
        SET source_revision = result_revision
      WHERE source_revision IS NULL`,
    `ALTER TABLE ${records} ALTER COLUMN source_revision SET NOT NULL`,
    `ALTER TABLE ${records} DROP CONSTRAINT IF EXISTS "${schema}_records_source_revision_check"`,
    `ALTER TABLE ${records}
      ADD CONSTRAINT "${schema}_records_source_revision_check"
      CHECK (source_revision >= 1)`,
    `CREATE INDEX IF NOT EXISTS "${schema}_records_pending_idx"
      ON ${records} (processing_state, next_attempt_at, updated_at, session_id, result_revision)
      WHERE processing_state IN ('received', 'result-stored', 'settling')`,
    `CREATE TABLE IF NOT EXISTS ${historicalBaselines} (
      platform_id text NOT NULL,
      session_id text NOT NULL,
      result_revision integer NOT NULL CHECK (result_revision >= 1),
      source_system text NOT NULL CHECK (char_length(source_system) BETWEEN 1 AND 512),
      source_key text NOT NULL CHECK (char_length(source_key) BETWEEN 1 AND 512),
      source_digest text NOT NULL CHECK (char_length(source_digest) BETWEEN 1 AND 512),
      record_digest text NOT NULL,
      created_at double precision NOT NULL,
      PRIMARY KEY (platform_id, session_id, result_revision),
      FOREIGN KEY (platform_id, session_id, result_revision)
        REFERENCES ${records} (platform_id, session_id, result_revision)
        ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS ${conflicts} (
      conflict_id uuid PRIMARY KEY,
      platform_id text NOT NULL,
      session_id text NOT NULL,
      result_revision integer NOT NULL CHECK (result_revision >= 1),
      existing_digest text NOT NULL,
      incoming_digest text NOT NULL,
      incoming jsonb NOT NULL,
      source jsonb,
      created_at double precision NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS "${schema}_conflicts_key_idx"
      ON ${conflicts} (platform_id, session_id, result_revision, created_at DESC)`,
  ];
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

function key(
  platformId: string,
  sessionId: string,
  resultRevision: number,
): string {
  return JSON.stringify([platformId, sessionId, resultRevision]);
}

function requireString(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0)
    throw new CompletionRecordStoreError(
      'INVALID_ARGUMENT',
      `${name} must be a non-empty string`,
    );
}

function requireTimestamp(
  value: unknown,
  name: string,
): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new CompletionRecordStoreError(
      'INVALID_ARGUMENT',
      `${name} must be a finite non-negative timestamp`,
    );
}

function requireRevision(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new CompletionRecordStoreError(
      'INVALID_ARGUMENT',
      'resultRevision must be a positive safe integer',
    );
}

function validateSource(source: CompletionRecordSource | undefined): void {
  if (!source) return;
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined) requireString(value, `source.${name}`);
  }
  assertJsonPayloadSize(source, 8 * 1024);
}

function validateReplayRef(
  replayRef: CompletionReplayRef | undefined,
  input: CompletionRecordInput,
): void {
  if (replayRef === undefined) return;
  if (
    replayRef === null ||
    typeof replayRef !== 'object' ||
    Array.isArray(replayRef)
  )
    throw new CompletionRecordStoreError(
      'INVALID_ARGUMENT',
      'replayRef must be an object',
    );
  const requiredKeys = [
    'platformId',
    'gameId',
    'sessionId',
    'replayId',
    'releaseId',
    'storageBindingId',
    'formatVersion',
  ] as const;
  const replayKeys = Object.keys(replayRef).sort();
  if (
    replayKeys.length !== requiredKeys.length ||
    replayKeys.some((value, index) => value !== [...requiredKeys].sort()[index])
  )
    throw new CompletionRecordStoreError(
      'INVALID_ARGUMENT',
      'replayRef has missing or unsupported fields',
    );
  for (const [name, value] of Object.entries(replayRef)) {
    if (name === 'formatVersion') {
      if (
        typeof value !== 'number' ||
        !Number.isSafeInteger(value) ||
        value < 1
      )
        throw new CompletionRecordStoreError(
          'INVALID_ARGUMENT',
          'replayRef.formatVersion must be a positive safe integer',
        );
    } else requireString(value, `replayRef.${name}`);
  }
  if (
    replayRef.platformId !== input.platformId ||
    replayRef.gameId !== input.admission.route.gameId ||
    replayRef.sessionId !== input.admission.route.sessionId ||
    replayRef.releaseId !== input.admission.route.releaseId ||
    replayRef.storageBindingId !== input.admission.route.storageBindingId
  )
    throw new CompletionRecordStoreError(
      'ROUTE_MISMATCH',
      'replayRef does not match the frozen route',
    );
  assertJsonPayloadSize(replayRef, 16 * 1024);
}

const ACHIEVEMENT_FACT_ENVELOPE_KIND =
  /^[a-z][a-z0-9-]{0,63}:completed-achievement-facts$/u;
const MAX_ACHIEVEMENT_SOURCES = 256;
const MAX_ACHIEVEMENT_FACTS = 1_000;
const MAX_ACHIEVEMENT_FACT_BYTES = 64 * 1024;

function validateAchievementSources(
  sources: readonly CompletionAchievementSource[] | undefined,
  participants: readonly MatchAdmission['participants'][number][],
): void {
  if (sources === undefined) return;
  if (!Array.isArray(sources) || sources.length > MAX_ACHIEVEMENT_SOURCES)
    throw new CompletionRecordStoreError(
      'INVALID_ARGUMENT',
      'achievementSources must be a bounded array',
    );
  const participantIds = new Set(
    participants.map((participant) => participant.principalId),
  );
  const seen = new Set<string>();
  for (const source of sources) {
    if (
      !source ||
      typeof source !== 'object' ||
      Array.isArray(source) ||
      Object.keys(source).some((key) => !['facts', 'principalId'].includes(key))
    )
      throw new CompletionRecordStoreError(
        'INVALID_ARGUMENT',
        'achievementSources contains an unsupported source',
      );
    requireString(source.principalId, 'achievementSources.principalId');
    if (!participantIds.has(source.principalId) || seen.has(source.principalId))
      throw new CompletionRecordStoreError(
        'ROUTE_MISMATCH',
        'achievementSources principal does not match the frozen participants',
      );
    seen.add(source.principalId);
    if (
      !Array.isArray(source.facts) ||
      source.facts.length > MAX_ACHIEVEMENT_FACTS
    )
      throw new CompletionRecordStoreError(
        'INVALID_ARGUMENT',
        'achievementSources facts are unbounded or invalid',
      );
    for (const fact of source.facts)
      assertJsonPayloadSize(
        fact,
        MAX_ACHIEVEMENT_FACT_BYTES,
        'achievement fact',
      );
  }
  assertJsonPayloadSize(sources, 256 * 1024, 'achievementSources');
}

function achievementSourcesFromRows(
  rows: unknown,
  participants: readonly MatchAdmission['participants'][number][],
  principalField: 'principalId' | 'userId',
): readonly CompletionAchievementSource[] {
  if (!Array.isArray(rows))
    throw new CompletionRecordStoreError(
      'INVALID_ARGUMENT',
      'achievement facts must contain an array of sources',
    );
  const sources = rows.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new CompletionRecordStoreError(
        'INVALID_ARGUMENT',
        'achievement facts source is invalid',
      );
    const row = value as Record<string, unknown>;
    const keys = Object.keys(row).sort();
    const expected = [principalField, 'facts'].sort();
    if (
      keys.length !== expected.length ||
      keys.some((key, index) => key !== expected[index])
    )
      throw new CompletionRecordStoreError(
        'INVALID_ARGUMENT',
        'achievement facts source contains unsupported fields',
      );
    return {
      principalId: row[principalField] as string,
      facts: row.facts as readonly import('@board-game/contracts').JsonValue[],
    };
  });
  validateAchievementSources(sources, participants);
  return sources;
}

/** Extract only public achievement facts from a completion progress payload. */
export function extractCompletionAchievementSources(
  progress: unknown,
  participants: readonly MatchAdmission['participants'][number][],
): readonly CompletionAchievementSource[] | undefined {
  if (
    progress === null ||
    typeof progress !== 'object' ||
    Array.isArray(progress)
  )
    return undefined;
  const envelope = (progress as Record<string, unknown>).achievementFacts;
  if (envelope === undefined) return undefined;
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope))
    throw new CompletionRecordStoreError(
      'INVALID_ARGUMENT',
      'achievementFacts envelope is invalid',
    );
  const value = envelope as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  const expected = ['facts', 'kind', 'schemaVersion'].sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index]) ||
    value.schemaVersion !== 1 ||
    typeof value.kind !== 'string' ||
    !ACHIEVEMENT_FACT_ENVELOPE_KIND.test(value.kind)
  )
    throw new CompletionRecordStoreError(
      'INVALID_ARGUMENT',
      'achievementFacts envelope is unsupported',
    );
  return achievementSourcesFromRows(value.facts, participants, 'userId');
}

function digestPayload(
  input: CompletionRecordInput,
  sourceRevision: number,
): string {
  const canonical = canonicalStableStringify({
    platformId: input.platformId,
    admissionId: input.admission.id,
    route: input.admission.route,
    status: input.status,
    resultSchemaVersion: input.resultSchemaVersion ?? 1,
    resultRevision: input.resultRevision,
    sourceRevision,
    result: input.result ?? null,
    participants: input.admission.participants,
    validityPolicyVersion: input.admission.validityPolicyVersion,
    rating: input.admission.rating,
    endedAt: input.endedAt,
    replayRef: input.replayRef ?? null,
    achievementSources: input.achievementSources ?? null,
  });
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

function completionInputFromEnvelope(
  envelope: CompletionFactEnvelope,
  admission: MatchAdmission,
  platformId: string | undefined,
): CompletionRecordInput {
  requireString(platformId, 'platformId');
  requireString(envelope.producerId, 'envelope.producerId');
  requireString(envelope.eventId, 'envelope.eventId');
  requireString(envelope.kind, 'envelope.kind');
  requireString(envelope.sourceRelease, 'envelope.sourceRelease');
  if (envelope.schemaVersion !== 1)
    throw new CompletionRecordStoreError(
      'INVALID_ARGUMENT',
      'Completion fact schemaVersion must be 1',
    );
  if (
    envelope.sessionId === undefined ||
    envelope.sessionId !== admission.route.sessionId
  )
    throw new CompletionRecordStoreError(
      'ROUTE_MISMATCH',
      'Completion fact sessionId does not match the frozen admission',
    );
  if (envelope.sourceRelease !== admission.route.releaseId)
    throw new CompletionRecordStoreError(
      'ROUTE_MISMATCH',
      'Completion fact sourceRelease does not match the frozen admission',
    );
  const expectedProducer = `game:${admission.route.gameId}:session:${admission.route.sessionId}`;
  if (envelope.producerId !== expectedProducer)
    throw new CompletionRecordStoreError(
      'ROUTE_MISMATCH',
      'Completion fact producerId does not match the frozen admission',
    );
  requireRevision(envelope.aggregateSequence);
  if (
    !envelope.payload ||
    typeof envelope.payload !== 'object' ||
    Array.isArray(envelope.payload)
  )
    throw new CompletionRecordStoreError(
      'RESULT_INVALID',
      'SessionCompleted payload must be an object',
    );
  const payload = envelope.payload as Record<string, unknown>;

  if (envelope.kind === 'SessionControlled') {
    const allowedKeys = new Set(['action', 'principalId', 'status', 'summary']);
    if (Object.keys(payload).some((key) => !allowedKeys.has(key)))
      throw new CompletionRecordStoreError(
        'INVALID_ARGUMENT',
        'SessionControlled payload contains an unsupported field',
      );
    if (
      payload.action !== 'cancel' ||
      (payload.status !== undefined && payload.status !== 'cancelled')
    )
      throw new CompletionRecordStoreError(
        'INVALID_ARGUMENT',
        'Only cancelled SessionControlled facts can create a completion record',
      );
    if (payload.principalId !== undefined)
      requireString(payload.principalId, 'payload.principalId');
    if (payload.summary !== undefined)
      assertJsonPayloadSize(payload.summary, MAX_RECORD_BYTES);
    if (envelope.occurredAt === undefined)
      throw new CompletionRecordStoreError(
        'INVALID_ARGUMENT',
        'Cancelled SessionControlled facts require occurredAt',
      );
    requireTimestamp(envelope.occurredAt, 'envelope.occurredAt');
    return {
      platformId,
      admission,
      status: 'cancelled',
      resultRevision: 1,
      sourceRevision: envelope.aggregateSequence,
      endedAt: envelope.occurredAt,
      source: {
        producerId: envelope.producerId,
        eventId: envelope.eventId,
        ...(envelope.digest ? { sourceDigest: envelope.digest } : {}),
      },
    };
  }

  if (envelope.kind !== 'SessionCompleted')
    throw new CompletionRecordStoreError(
      'INVALID_ARGUMENT',
      'Only SessionCompleted or cancelled SessionControlled facts can create a completion record',
    );
  const resultRevision =
    payload.resultRevision === undefined ? 1 : payload.resultRevision;
  const endedAt =
    payload.endedAt === undefined
      ? (envelope.occurredAt ?? envelope.receivedAt)
      : payload.endedAt;
  const allowedKeys = new Set([
    'summary',
    'progress',
    'participants',
    'principalId',
    'result',
    'resultRevision',
    'endedAt',
    'resultSchemaVersion',
    'replayRef',
  ]);
  if (Object.keys(payload).some((key) => !allowedKeys.has(key)))
    throw new CompletionRecordStoreError(
      'INVALID_ARGUMENT',
      'SessionCompleted payload contains an unsupported field',
    );
  if (payload.participants !== undefined) {
    if (!Array.isArray(payload.participants))
      throw new CompletionRecordStoreError(
        'INVALID_ARGUMENT',
        'SessionCompleted participants must be an array',
      );
    for (const participant of payload.participants)
      assertParticipant(participant);
    if (
      canonicalStableStringify(payload.participants) !==
      canonicalStableStringify(admission.participants)
    )
      throw new CompletionRecordStoreError(
        'ROUTE_MISMATCH',
        'SessionCompleted participants do not match the frozen admission',
      );
  }
  if (payload.principalId !== undefined)
    requireString(payload.principalId, 'payload.principalId');
  if (payload.summary !== undefined)
    assertJsonPayloadSize(payload.summary, MAX_RECORD_BYTES);
  if (payload.progress !== undefined)
    assertJsonPayloadSize(payload.progress, MAX_RECORD_BYTES);
  const achievementSources = extractCompletionAchievementSources(
    payload.progress,
    admission.participants,
  );
  if (typeof resultRevision !== 'number' || typeof endedAt !== 'number')
    throw new CompletionRecordStoreError(
      'INVALID_ARGUMENT',
      'SessionCompleted payload metadata is invalid',
    );
  if (
    payload.resultSchemaVersion !== undefined &&
    typeof payload.resultSchemaVersion !== 'number'
  )
    throw new CompletionRecordStoreError(
      'INVALID_ARGUMENT',
      'SessionCompleted resultSchemaVersion is invalid',
    );
  return {
    platformId,
    admission,
    status: 'completed',
    resultRevision,
    sourceRevision: envelope.aggregateSequence,
    endedAt,
    ...(payload.result === undefined
      ? {}
      : { result: payload.result as GameResult }),
    ...(payload.resultSchemaVersion === undefined
      ? {}
      : { resultSchemaVersion: payload.resultSchemaVersion as number }),
    ...(payload.replayRef === undefined
      ? {}
      : { replayRef: payload.replayRef as CompletionReplayRef }),
    ...(achievementSources ? { achievementSources } : {}),
    source: {
      producerId: envelope.producerId,
      eventId: envelope.eventId,
      ...(envelope.digest ? { sourceDigest: envelope.digest } : {}),
    },
  };
}

function normalizeAcceptInput(
  input: CompletionRecordInput | CompletionFactEnvelope,
  admission: MatchAdmission | undefined,
  options: CompletionRecordStoreOptions,
): CompletionRecordInput {
  return admission
    ? completionInputFromEnvelope(
        input as CompletionFactEnvelope,
        admission,
        options.platformId,
      )
    : (input as CompletionRecordInput);
}

interface PreparedCompletion {
  readonly record: PlatformCompletionRecord;
}

async function prepare(
  input: CompletionRecordInput,
  options: CompletionRecordStoreOptions,
  now: number,
): Promise<PreparedCompletion> {
  if (!input || typeof input !== 'object')
    throw new CompletionRecordStoreError(
      'INVALID_ARGUMENT',
      'completion input is required',
    );
  requireString(input.platformId, 'platformId');
  if (
    options.platformId !== undefined &&
    input.platformId !== options.platformId
  )
    throw new CompletionRecordStoreError(
      'INVALID_ARGUMENT',
      'Completion platformId does not match the configured platform',
    );
  requireString(input.admission?.id, 'admission.id');
  assertSessionRoute(input.admission.route);
  if (input.admission.route.sessionId.length === 0)
    throw new CompletionRecordStoreError(
      'INVALID_ARGUMENT',
      'sessionId is required',
    );
  if (!TERMINAL_STATUSES.includes(input.status))
    throw new CompletionRecordStoreError(
      'INVALID_ARGUMENT',
      'invalid completion status',
    );
  requireRevision(input.resultRevision);
  if (input.resultRevision !== 1)
    throw new CompletionRecordStoreError(
      'REVISION_NOT_ALLOWED',
      'Result revisions other than 1 require an explicit correction workflow',
    );
  if (
    input.sourceRevision !== undefined &&
    typeof input.sourceRevision !== 'number'
  )
    throw new CompletionRecordStoreError(
      'INVALID_ARGUMENT',
      'sourceRevision must be a number',
    );
  const sourceRevision = input.sourceRevision ?? input.resultRevision;
  requireRevision(sourceRevision);
  requireTimestamp(input.endedAt, 'endedAt');
  if (
    input.resultSchemaVersion !== undefined &&
    typeof input.resultSchemaVersion !== 'number'
  )
    throw new CompletionRecordStoreError(
      'INVALID_ARGUMENT',
      'resultSchemaVersion must be a number',
    );
  const resultSchemaVersion = input.resultSchemaVersion ?? 1;
  requireRevision(resultSchemaVersion);
  if (
    !Array.isArray(input.admission.participants) ||
    input.admission.participants.length === 0
  )
    throw new CompletionRecordStoreError(
      'INVALID_ARGUMENT',
      'admission participants are required',
    );
  const principalIds = new Set<string>();
  const seatIds = new Set<string>();
  for (const participant of input.admission.participants) {
    assertParticipant(participant);
    if (
      principalIds.has(participant.principalId) ||
      seatIds.has(participant.seatId)
    )
      throw new CompletionRecordStoreError(
        'INVALID_ARGUMENT',
        'admission participants must be unique',
      );
    principalIds.add(participant.principalId);
    seatIds.add(participant.seatId);
  }
  validateAchievementSources(
    input.achievementSources,
    input.admission.participants,
  );
  if (input.status === 'completed' && !input.result)
    throw new CompletionRecordStoreError(
      'RESULT_INVALID',
      'completed result is required',
    );
  if (input.result) {
    try {
      assertGameResult(input.result, input.admission.participants);
    } catch (error) {
      throw new CompletionRecordStoreError(
        'RESULT_INVALID',
        'result does not match the frozen participants',
        { cause: error instanceof Error ? error.message : String(error) },
      );
    }
  }
  validateReplayRef(input.replayRef, input);
  validateSource(input.source);
  assertJsonPayloadSize(input.admission, MAX_RECORD_BYTES);
  assertJsonPayloadSize(input.result ?? null, MAX_RECORD_BYTES);
  if (options.admission) {
    const frozen = await options.admission.getAdmission(
      input.admission.route.sessionId,
    );
    if (!frozen)
      throw new CompletionRecordStoreError(
        'ADMISSION_NOT_FOUND',
        `No persisted admission exists for ${input.admission.route.sessionId}`,
      );
    if (
      canonicalStableStringify(frozen) !==
      canonicalStableStringify(input.admission)
    )
      throw new CompletionRecordStoreError(
        'ROUTE_MISMATCH',
        'Completion admission does not match the persisted frozen admission',
      );
  }
  const record: PlatformCompletionRecord = {
    platformId: input.platformId,
    admissionId: input.admission.id,
    route: copy(input.admission.route),
    sessionId: input.admission.route.sessionId,
    status: input.status,
    resultSchemaVersion,
    resultRevision: input.resultRevision,
    sourceRevision,
    digest: digestPayload({ ...input, resultSchemaVersion }, sourceRevision),
    participants: copy(input.admission.participants),
    validityPolicyVersion: input.admission.validityPolicyVersion,
    rating: copy(input.admission.rating),
    endedAt: input.endedAt,
    ...(input.result ? { result: copy(input.result) } : {}),
    ...(input.replayRef ? { replayRef: copy(input.replayRef) } : {}),
    ...(input.achievementSources
      ? { achievementSources: copy(input.achievementSources) }
      : {}),
    ...(input.source ? { source: copy(input.source) } : {}),
    processingState: 'received',
    attempts: 0,
    receivedAt: now,
    updatedAt: now,
  };
  assertJsonPayloadSize(record, MAX_RECORD_BYTES);
  return { record };
}

async function prepareHistorical(
  input: HistoricalCompletionImportInput,
  options: CompletionRecordStoreOptions,
  now: number,
): Promise<{
  readonly record: PlatformCompletionRecord;
  readonly baseline: HistoricalCompletionBaseline;
}> {
  if (!input || typeof input !== 'object')
    throw new CompletionRecordStoreError(
      'INVALID_ARGUMENT',
      'historical completion import is required',
    );
  validateHistoricalBaseline(input.baseline);
  if (input.record?.status !== 'completed')
    throw new CompletionRecordStoreError(
      'INVALID_ARGUMENT',
      'historical completion import requires a completed result',
    );
  const prepared = await prepare(input.record, options, now);
  return {
    record: {
      ...prepared.record,
      processingState: 'settled',
      claimOwner: undefined,
      claimToken: undefined,
      leaseUntil: undefined,
      nextAttemptAt: undefined,
      processingError: undefined,
    },
    baseline: copy(input.baseline),
  };
}

function conflictError(
  existing: PlatformCompletionRecord,
  incoming: PlatformCompletionRecord,
): CompletionRecordStoreError {
  return new CompletionRecordStoreError(
    'CONFLICT',
    'Completion key already contains a different canonical digest',
    {
      platformId: incoming.platformId,
      sessionId: incoming.sessionId,
      resultRevision: incoming.resultRevision,
      existingDigest: existing.digest,
      incomingDigest: incoming.digest,
    },
  );
}

function claimHandle(record: PlatformCompletionRecord): CompletionClaim {
  if (
    !record.claimOwner ||
    !record.claimToken ||
    record.leaseUntil === undefined
  )
    throw new CompletionRecordStoreError(
      'CLAIM_LOST',
      'Completion claim is missing',
    );
  return {
    record: copy(record),
    owner: record.claimOwner,
    token: record.claimToken,
    leaseUntil: record.leaseUntil,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateClaimOptions(
  options: CompletionClaimOptions,
  fallbackNow = Date.now(),
): {
  readonly owner: string;
  readonly limit: number;
  readonly leaseMs: number;
  readonly now: number;
} {
  requireString(options.owner, 'claim owner');
  const limit = options.limit ?? 1;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new CompletionRecordStoreError(
      'INVALID_ARGUMENT',
      'claim limit must be between 1 and 100',
    );
  const leaseMs = options.leaseMs ?? 30_000;
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 86_400_000)
    throw new CompletionRecordStoreError(
      'INVALID_ARGUMENT',
      'leaseMs must be between 1 and 86400000',
    );
  const now = options.now ?? fallbackNow;
  requireTimestamp(now, 'now');
  return { owner: options.owner, limit, leaseMs, now };
}

function isDue(record: PlatformCompletionRecord, now: number): boolean {
  return (
    (record.nextAttemptAt === undefined || record.nextAttemptAt <= now) &&
    (record.claimToken === undefined ||
      record.leaseUntil === undefined ||
      record.leaseUntil <= now) &&
    (record.processingState === 'received' ||
      record.processingState === 'result-stored' ||
      record.processingState === 'settling')
  );
}

function isForPlatform(
  record: PlatformCompletionRecord,
  platformId: string | undefined,
): boolean {
  return platformId === undefined || record.platformId === platformId;
}

function assertClaimActive(
  record: PlatformCompletionRecord,
  claim: CompletionClaim,
  now: number,
): void {
  if (
    record.claimOwner !== claim.owner ||
    record.claimToken !== claim.token ||
    record.leaseUntil === undefined ||
    record.leaseUntil <= now
  )
    throw new CompletionRecordStoreError(
      'CLAIM_LOST',
      'Completion claim lease has expired',
    );
}

/** Clone-isolated reference implementation used by local runtimes and tests. */
export class MemoryCompletionRecordStore implements CompletionRecordStore {
  private readonly records = new Map<string, PlatformCompletionRecord>();
  private readonly historicalBaselines = new Map<
    string,
    HistoricalCompletionBaseline
  >();
  private readonly conflicts: CompletionRecordConflict[] = [];
  private tail: Promise<void> = Promise.resolve();
  private readonly options: CompletionRecordStoreOptions;
  private readonly now: () => number;

  constructor(options: CompletionRecordStoreOptions = {}) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  private async run<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  async accept(input: CompletionRecordInput): Promise<CompletionAcceptResult>;
  async accept(
    envelope: CompletionFactEnvelope,
    admission: MatchAdmission,
  ): Promise<CompletionAcceptResult>;
  async accept(
    input: CompletionRecordInput | CompletionFactEnvelope,
    admission?: MatchAdmission,
  ): Promise<CompletionAcceptResult> {
    const normalized = normalizeAcceptInput(input, admission, this.options);
    const prepared = await prepare(normalized, this.options, this.now());
    return this.run(async () => {
      const recordKey = key(
        prepared.record.platformId,
        prepared.record.sessionId,
        prepared.record.resultRevision,
      );
      const existing = this.records.get(recordKey);
      if (existing) {
        if (existing.digest === prepared.record.digest)
          return { status: 'duplicate', record: copy(existing) };
        this.auditConflict(existing, prepared.record);
        throw conflictError(existing, prepared.record);
      }
      this.records.set(recordKey, copy(prepared.record));
      return { status: 'accepted', record: copy(prepared.record) };
    });
  }

  async importSettledHistorical(
    input: HistoricalCompletionImportInput,
  ): Promise<HistoricalCompletionImportResult> {
    const prepared = await prepareHistorical(input, this.options, this.now());
    return this.run(async () => {
      const recordKey = key(
        prepared.record.platformId,
        prepared.record.sessionId,
        prepared.record.resultRevision,
      );
      const existing = this.records.get(recordKey);
      const existingBaseline = this.historicalBaselines.get(recordKey);
      if (existing) {
        if (
          existing.processingState === 'settled' &&
          existing.status === 'completed' &&
          existing.digest === prepared.record.digest &&
          sameHistoricalBaseline(existingBaseline, prepared.baseline)
        )
          return {
            status: 'duplicate',
            record: copy(existing),
            baseline: copy(prepared.baseline),
          };
        this.auditConflict(existing, prepared.record, {
          record: prepared.record,
          historicalBaseline: prepared.baseline,
        });
        throw historicalConflictError(existing);
      }
      this.records.set(recordKey, copy(prepared.record));
      this.historicalBaselines.set(recordKey, copy(prepared.baseline));
      return {
        status: 'imported',
        record: copy(prepared.record),
        baseline: copy(prepared.baseline),
      };
    });
  }

  private auditConflict(
    existing: PlatformCompletionRecord,
    incoming: PlatformCompletionRecord,
    incomingAudit: unknown = incoming,
  ): void {
    this.conflicts.push({
      conflictId: randomUUID(),
      platformId: incoming.platformId,
      sessionId: incoming.sessionId,
      resultRevision: incoming.resultRevision,
      existingDigest: existing.digest,
      incomingDigest: incoming.digest,
      incoming: copy(incomingAudit),
      ...(incoming.source ? { source: copy(incoming.source) } : {}),
      createdAt: this.now(),
    });
    if (this.conflicts.length > MAX_CONFLICTS) this.conflicts.shift();
  }

  async get(
    platformId: string,
    sessionId: string,
    resultRevision?: number,
  ): Promise<PlatformCompletionRecord | null> {
    requireString(platformId, 'platformId');
    requireString(sessionId, 'sessionId');
    if (resultRevision !== undefined) requireRevision(resultRevision);
    const matches = [...this.records.values()].filter(
      (record) =>
        record.platformId === platformId &&
        record.sessionId === sessionId &&
        (resultRevision === undefined ||
          record.resultRevision === resultRevision),
    );
    matches.sort((left, right) => right.resultRevision - left.resultRevision);
    return matches[0] ? copy(matches[0]) : null;
  }

  async getHistoricalBaseline(
    platformId: string,
    sessionId: string,
    resultRevision?: number,
  ): Promise<HistoricalCompletionBaseline | null> {
    requireString(platformId, 'platformId');
    requireString(sessionId, 'sessionId');
    if (resultRevision !== undefined) requireRevision(resultRevision);
    const matches = [...this.records.keys()]
      .filter((recordKey) => {
        const parsed = JSON.parse(recordKey) as [string, string, number];
        return (
          parsed[0] === platformId &&
          parsed[1] === sessionId &&
          (resultRevision === undefined || parsed[2] === resultRevision)
        );
      })
      .sort((left, right) => {
        const leftRevision = (JSON.parse(left) as [string, string, number])[2];
        const rightRevision = (
          JSON.parse(right) as [string, string, number]
        )[2];
        return rightRevision - leftRevision;
      });
    const recordKey = matches[0];
    const baseline = recordKey
      ? this.historicalBaselines.get(recordKey)
      : undefined;
    return baseline ? copy(baseline) : null;
  }

  async listConflicts(
    platformId: string,
    sessionId?: string,
    limit = 100,
  ): Promise<readonly CompletionRecordConflict[]> {
    requireString(platformId, 'platformId');
    if (sessionId !== undefined) requireString(sessionId, 'sessionId');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CONFLICTS)
      throw new CompletionRecordStoreError(
        'INVALID_ARGUMENT',
        'invalid conflict limit',
      );
    return this.conflicts
      .filter(
        (conflict) =>
          conflict.platformId === platformId &&
          (sessionId === undefined || conflict.sessionId === sessionId),
      )
      .slice(-limit)
      .reverse()
      .map(copy);
  }

  async claimNext(
    options: CompletionClaimOptions,
  ): Promise<CompletionClaim | null> {
    const values = validateClaimOptions(options, this.now());
    return this.run(async () => {
      const candidates = [...this.records.values()]
        .filter(
          (record) =>
            isForPlatform(record, this.options.platformId) &&
            isDue(record, values.now),
        )
        .sort(
          (left, right) =>
            left.updatedAt - right.updatedAt ||
            left.sessionId.localeCompare(right.sessionId) ||
            left.resultRevision - right.resultRevision,
        )
        .slice(0, values.limit);
      const first = candidates[0];
      if (!first) return null;
      const token = randomUUID();
      const updated: PlatformCompletionRecord = {
        ...first,
        attempts: first.attempts + 1,
        claimOwner: values.owner,
        claimToken: token,
        leaseUntil: values.now + values.leaseMs,
        updatedAt: values.now,
      };
      this.records.set(
        key(updated.platformId, updated.sessionId, updated.resultRevision),
        updated,
      );
      return claimHandle(updated);
    });
  }

  async renewClaim(
    claim: CompletionClaim,
    leaseMs = 30_000,
  ): Promise<CompletionClaim> {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 86_400_000)
      throw new CompletionRecordStoreError(
        'INVALID_ARGUMENT',
        'leaseMs must be between 1 and 86400000',
      );
    return this.run(async () => {
      const now = this.now();
      const found = this.records.get(
        key(
          claim.record.platformId,
          claim.record.sessionId,
          claim.record.resultRevision,
        ),
      );
      if (!found)
        throw new CompletionRecordStoreError(
          'NOT_FOUND',
          'Completion record not found',
        );
      assertClaimActive(found, claim, now);
      const updated = { ...found, leaseUntil: now + leaseMs, updatedAt: now };
      this.records.set(
        key(updated.platformId, updated.sessionId, updated.resultRevision),
        updated,
      );
      return claimHandle(updated);
    });
  }

  private async transition(
    claim: CompletionClaim,
    state: Exclude<CompletionProcessingState, 'received' | 'conflict'>,
  ): Promise<PlatformCompletionRecord> {
    return this.run(async () => {
      const record = this.records.get(
        key(
          claim.record.platformId,
          claim.record.sessionId,
          claim.record.resultRevision,
        ),
      );
      if (!record)
        throw new CompletionRecordStoreError(
          'NOT_FOUND',
          'Completion record not found',
        );
      if (record.processingState === 'settled') return copy(record);
      const alreadyAtOrPast =
        (state === 'result-stored' &&
          ['result-stored', 'settling'].includes(record.processingState)) ||
        (state === 'settling' && record.processingState === 'settling');
      if (alreadyAtOrPast) {
        assertClaimActive(record, claim, this.now());
        return copy(record);
      }
      assertClaimActive(record, claim, this.now());
      const allowed =
        state === 'result-stored'
          ? record.processingState === 'received'
          : state === 'settling'
            ? record.processingState === 'result-stored'
            : record.processingState === 'result-stored' ||
              record.processingState === 'settling';
      if (!allowed)
        throw new CompletionRecordStoreError(
          'INVALID_STATE',
          `Cannot move ${record.processingState} to ${state}`,
        );
      const updated: PlatformCompletionRecord = {
        ...record,
        processingState: state,
        processingError: undefined,
        ...(state === 'settled'
          ? {
              claimOwner: undefined,
              claimToken: undefined,
              leaseUntil: undefined,
            }
          : {}),
        updatedAt: this.now(),
      };
      this.records.set(
        key(updated.platformId, updated.sessionId, updated.resultRevision),
        updated,
      );
      return copy(updated);
    });
  }

  async markResultStored(
    claim: CompletionClaim,
  ): Promise<PlatformCompletionRecord> {
    return this.transition(claim, 'result-stored');
  }

  async markSettling(
    claim: CompletionClaim,
  ): Promise<PlatformCompletionRecord> {
    return this.transition(claim, 'settling');
  }

  async markSettled(claim: CompletionClaim): Promise<PlatformCompletionRecord> {
    return this.transition(claim, 'settled');
  }

  async fail(
    claim: CompletionClaim,
    error: unknown,
    nextAttemptAt = this.now() + 1_000,
  ): Promise<PlatformCompletionRecord> {
    requireTimestamp(nextAttemptAt, 'nextAttemptAt');
    return this.run(async () => {
      const record = this.records.get(
        key(
          claim.record.platformId,
          claim.record.sessionId,
          claim.record.resultRevision,
        ),
      );
      if (!record)
        throw new CompletionRecordStoreError(
          'NOT_FOUND',
          'Completion record not found',
        );
      if (record.processingState === 'settled') return copy(record);
      assertClaimActive(record, claim, this.now());
      const updated: PlatformCompletionRecord = {
        ...record,
        processingError: errorMessage(error),
        nextAttemptAt,
        claimOwner: undefined,
        claimToken: undefined,
        leaseUntil: undefined,
        updatedAt: this.now(),
      };
      this.records.set(
        key(updated.platformId, updated.sessionId, updated.resultRevision),
        updated,
      );
      return copy(updated);
    });
  }

  async processClaim(
    claim: CompletionClaim,
    options: CompletionProcessOptions = {},
  ): Promise<PlatformCompletionRecord> {
    let current = claim;
    try {
      let record = await this.markResultStored(current);
      if (record.processingState === 'settled') return record;
      current = claimHandle(record);
      if (options.settle) {
        record = await this.markSettling(current);
        current = claimHandle(record);
        await options.settle(copy(record));
      }
      return await this.markSettled(current);
    } catch (error) {
      await this.fail(current, error).catch(() => undefined);
      throw error;
    }
  }

  async close(): Promise<void> {
    // The memory implementation owns no external resource.
  }
}

function requireBoundedSourceString(
  value: unknown,
  name: string,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim().length === 0 ||
    value.length > 512 ||
    /\p{Cc}/u.test(value)
  )
    throw new CompletionRecordStoreError(
      'INVALID_ARGUMENT',
      `${name} must be a bounded source identity`,
    );
}

function validateHistoricalBaseline(
  baseline: HistoricalCompletionBaseline,
): void {
  if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline))
    throw new CompletionRecordStoreError(
      'INVALID_ARGUMENT',
      'historical baseline is required',
    );
  const keys = Object.keys(baseline).sort();
  if (
    keys.length !== 3 ||
    keys.some(
      (value, index) =>
        value !== ['sourceDigest', 'sourceKey', 'sourceSystem'].sort()[index],
    )
  )
    throw new CompletionRecordStoreError(
      'INVALID_ARGUMENT',
      'historical baseline contains unsupported fields',
    );
  requireBoundedSourceString(baseline.sourceSystem, 'baseline.sourceSystem');
  requireBoundedSourceString(baseline.sourceKey, 'baseline.sourceKey');
  requireBoundedSourceString(baseline.sourceDigest, 'baseline.sourceDigest');
  assertJsonPayloadSize(baseline, 8 * 1024, 'historical baseline');
}

function sameHistoricalBaseline(
  left: HistoricalCompletionBaseline | undefined,
  right: HistoricalCompletionBaseline,
): boolean {
  return (
    left !== undefined &&
    left.sourceSystem === right.sourceSystem &&
    left.sourceKey === right.sourceKey &&
    left.sourceDigest === right.sourceDigest
  );
}

function historicalConflictError(
  existing: PlatformCompletionRecord,
): CompletionRecordStoreError {
  return new CompletionRecordStoreError(
    'CONFLICT',
    existing.processingState === 'settled'
      ? 'Historical completion import conflicts with the settled record'
      : 'Historical completion import cannot replace an unsettled record',
    {
      platformId: existing.platformId,
      sessionId: existing.sessionId,
      resultRevision: existing.resultRevision,
      existingDigest: existing.digest,
      existingProcessingState: existing.processingState,
    },
  );
}

export interface PostgresCompletionRecordStoreOptions
  extends CompletionRecordStoreOptions {
  readonly pool: Pool;
}

function jsonOrNull(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return JSON.parse(value);
  return value;
}

function jsonParameter(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

function numberOrUndefined(value: unknown): number | undefined {
  return value === null || value === undefined ? undefined : Number(value);
}

function recordFromRow(row: Record<string, unknown>): PlatformCompletionRecord {
  const route = jsonOrNull(row.route) as SessionRoute;
  const result = jsonOrNull(row.result) as GameResult | null;
  const replayRef = jsonOrNull(row.replay_ref) as CompletionReplayRef | null;
  const achievementSources = jsonOrNull(row.achievement_sources) as
    | PlatformCompletionRecord['achievementSources']
    | null;
  const source = jsonOrNull(row.source) as CompletionRecordSource | null;
  return {
    platformId: String(row.platform_id),
    admissionId: String(row.admission_id),
    route: copy(route),
    sessionId: String(row.session_id),
    status: String(row.status) as PlatformCompletionStatus,
    resultSchemaVersion: Number(row.result_schema_version),
    resultRevision: Number(row.result_revision),
    sourceRevision: Number(row.source_revision ?? row.result_revision),
    digest: String(row.digest),
    participants: copy(
      jsonOrNull(row.participants) as PlatformCompletionRecord['participants'],
    ),
    validityPolicyVersion: String(row.validity_policy_version),
    rating: copy(jsonOrNull(row.rating) as MatchAdmission['rating']),
    endedAt: Number(row.ended_at),
    ...(result === null ? {} : { result: copy(result) }),
    ...(replayRef === null ? {} : { replayRef: copy(replayRef) }),
    ...(achievementSources === null
      ? {}
      : { achievementSources: copy(achievementSources) }),
    ...(source === null ? {} : { source: copy(source) }),
    processingState: String(row.processing_state) as CompletionProcessingState,
    attempts: Number(row.attempts),
    ...(numberOrUndefined(row.next_attempt_at) === undefined
      ? {}
      : { nextAttemptAt: Number(row.next_attempt_at) }),
    ...(row.processing_error === null || row.processing_error === undefined
      ? {}
      : { processingError: String(row.processing_error) }),
    ...(row.claim_owner === null || row.claim_owner === undefined
      ? {}
      : { claimOwner: String(row.claim_owner) }),
    ...(row.claim_token === null || row.claim_token === undefined
      ? {}
      : { claimToken: String(row.claim_token) }),
    ...(numberOrUndefined(row.lease_until) === undefined
      ? {}
      : { leaseUntil: Number(row.lease_until) }),
    receivedAt: Number(row.received_at),
    updatedAt: Number(row.updated_at),
  };
}

function conflictFromRow(
  row: Record<string, unknown>,
): CompletionRecordConflict {
  const source = jsonOrNull(row.source) as CompletionRecordSource | null;
  return {
    conflictId: String(row.conflict_id),
    platformId: String(row.platform_id),
    sessionId: String(row.session_id),
    resultRevision: Number(row.result_revision),
    existingDigest: String(row.existing_digest),
    incomingDigest: String(row.incoming_digest),
    incoming: copy(jsonOrNull(row.incoming)),
    ...(source === null ? {} : { source: copy(source) }),
    createdAt: Number(row.created_at),
  };
}

function claimFromRow(row: Record<string, unknown>): CompletionClaim {
  const record = recordFromRow(row);
  return claimHandle(record);
}

/** PostgreSQL authority with explicit migration and fenced worker claims. */
export class PostgresCompletionRecordStore implements CompletionRecordStore {
  readonly schema: string;
  private readonly pool: Pool;
  private readonly options: CompletionRecordStoreOptions;
  private readonly now: () => number;

  constructor(options: PostgresCompletionRecordStoreOptions | Pool) {
    this.pool = 'query' in options ? options : options.pool;
    this.options = 'query' in options ? {} : options;
    this.schema =
      'query' in options
        ? DEFAULT_COMPLETION_SCHEMA
        : (options.schema ?? DEFAULT_COMPLETION_SCHEMA);
    this.now = this.options.now ?? Date.now;
    assertSchemaName(this.schema);
  }

  async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const statement of completionRecordMigrationStatements(this.schema))
        await client.query(statement);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async accept(input: CompletionRecordInput): Promise<CompletionAcceptResult>;
  async accept(
    envelope: CompletionFactEnvelope,
    admission: MatchAdmission,
  ): Promise<CompletionAcceptResult>;
  async accept(
    input: CompletionRecordInput | CompletionFactEnvelope,
    admission?: MatchAdmission,
  ): Promise<CompletionAcceptResult> {
    const normalized = normalizeAcceptInput(input, admission, this.options);
    const prepared = await prepare(normalized, this.options, this.now());
    const client = await this.pool.connect();
    const records = tableName(this.schema, 'records');
    const conflicts = tableName(this.schema, 'conflicts');
    try {
      await client.query('BEGIN');
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [
          key(
            prepared.record.platformId,
            prepared.record.sessionId,
            prepared.record.resultRevision,
          ),
        ],
      );
      const existingResult = await client.query(
        `SELECT * FROM ${records}
         WHERE platform_id = $1 AND session_id = $2 AND result_revision = $3
         FOR UPDATE`,
        [
          prepared.record.platformId,
          prepared.record.sessionId,
          prepared.record.resultRevision,
        ],
      );
      if (existingResult.rows.length > 0) {
        const existing = recordFromRow(existingResult.rows[0]);
        if (existing.digest === prepared.record.digest) {
          await client.query('COMMIT');
          return { status: 'duplicate', record: existing };
        }
        await client.query(
          `INSERT INTO ${conflicts}
             (conflict_id, platform_id, session_id, result_revision,
              existing_digest, incoming_digest, incoming, source, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            randomUUID(),
            prepared.record.platformId,
            prepared.record.sessionId,
            prepared.record.resultRevision,
            existing.digest,
            prepared.record.digest,
            jsonParameter(prepared.record),
            jsonParameter(prepared.record.source),
            this.now(),
          ],
        );
        await client.query('COMMIT');
        throw conflictError(existing, prepared.record);
      }
      const insertResult = await client.query(
        `INSERT INTO ${records}
          (platform_id, session_id, result_revision, admission_id, route,
           status, result_schema_version, source_revision, result, participants,
           validity_policy_version, rating, ended_at, replay_ref,
           achievement_sources, source, digest, processing_state, attempts,
           received_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
         RETURNING *`,
        [
          prepared.record.platformId,
          prepared.record.sessionId,
          prepared.record.resultRevision,
          prepared.record.admissionId,
          jsonParameter(prepared.record.route),
          prepared.record.status,
          prepared.record.resultSchemaVersion,
          prepared.record.sourceRevision,
          jsonParameter(prepared.record.result),
          jsonParameter(prepared.record.participants),
          prepared.record.validityPolicyVersion,
          jsonParameter(prepared.record.rating),
          prepared.record.endedAt,
          jsonParameter(prepared.record.replayRef),
          jsonParameter(prepared.record.achievementSources),
          jsonParameter(prepared.record.source),
          prepared.record.digest,
          prepared.record.processingState,
          prepared.record.attempts,
          prepared.record.receivedAt,
          prepared.record.updatedAt,
        ],
      );
      await client.query('COMMIT');
      return {
        status: 'accepted',
        record: recordFromRow(insertResult.rows[0]),
      };
    } catch (error) {
      if (
        error instanceof CompletionRecordStoreError &&
        error.code === 'CONFLICT'
      )
        throw error;
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async importSettledHistorical(
    input: HistoricalCompletionImportInput,
  ): Promise<HistoricalCompletionImportResult> {
    const prepared = await prepareHistorical(input, this.options, this.now());
    const client = await this.pool.connect();
    const records = tableName(this.schema, 'records');
    const conflicts = tableName(this.schema, 'conflicts');
    const historicalBaselines = tableName(this.schema, 'historical_baselines');
    let committed = false;
    try {
      await client.query('BEGIN');
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [
          key(
            prepared.record.platformId,
            prepared.record.sessionId,
            prepared.record.resultRevision,
          ),
        ],
      );
      const existingResult = await client.query(
        `SELECT * FROM ${records}
         WHERE platform_id = $1 AND session_id = $2 AND result_revision = $3
         FOR UPDATE`,
        [
          prepared.record.platformId,
          prepared.record.sessionId,
          prepared.record.resultRevision,
        ],
      );
      const existing =
        existingResult.rows.length === 0
          ? undefined
          : recordFromRow(existingResult.rows[0]);
      let existingBaseline: HistoricalCompletionBaseline | undefined;
      let existingBaselineRecordDigest: string | undefined;
      if (existing) {
        const baselineResult = await client.query(
          `SELECT source_system, source_key, source_digest, record_digest
             FROM ${historicalBaselines}
            WHERE platform_id = $1 AND session_id = $2 AND result_revision = $3
            FOR UPDATE`,
          [
            prepared.record.platformId,
            prepared.record.sessionId,
            prepared.record.resultRevision,
          ],
        );
        const row = baselineResult.rows[0] as
          | Record<string, unknown>
          | undefined;
        if (row) {
          existingBaseline = {
            sourceSystem: String(row.source_system),
            sourceKey: String(row.source_key),
            sourceDigest: String(row.source_digest),
          };
          existingBaselineRecordDigest = String(row.record_digest);
        }
        if (
          existing.processingState === 'settled' &&
          existing.status === 'completed' &&
          existing.digest === prepared.record.digest &&
          existingBaselineRecordDigest === existing.digest &&
          sameHistoricalBaseline(existingBaseline, prepared.baseline)
        ) {
          await client.query('COMMIT');
          committed = true;
          return {
            status: 'duplicate',
            record: existing,
            baseline: copy(prepared.baseline),
          };
        }
        await client.query(
          `INSERT INTO ${conflicts}
             (conflict_id, platform_id, session_id, result_revision,
              existing_digest, incoming_digest, incoming, source, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            randomUUID(),
            prepared.record.platformId,
            prepared.record.sessionId,
            prepared.record.resultRevision,
            existing.digest,
            prepared.record.digest,
            jsonParameter({
              record: prepared.record,
              historicalBaseline: prepared.baseline,
            }),
            jsonParameter(prepared.record.source),
            this.now(),
          ],
        );
        await client.query('COMMIT');
        committed = true;
        throw historicalConflictError(existing);
      }

      const inserted = await client.query(
        `INSERT INTO ${records}
          (platform_id, session_id, result_revision, admission_id, route,
           status, result_schema_version, source_revision, result, participants,
           validity_policy_version, rating, ended_at, replay_ref,
           achievement_sources, source, digest, processing_state, attempts,
           received_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
         RETURNING *`,
        [
          prepared.record.platformId,
          prepared.record.sessionId,
          prepared.record.resultRevision,
          prepared.record.admissionId,
          jsonParameter(prepared.record.route),
          prepared.record.status,
          prepared.record.resultSchemaVersion,
          prepared.record.sourceRevision,
          jsonParameter(prepared.record.result),
          jsonParameter(prepared.record.participants),
          prepared.record.validityPolicyVersion,
          jsonParameter(prepared.record.rating),
          prepared.record.endedAt,
          jsonParameter(prepared.record.replayRef),
          jsonParameter(prepared.record.achievementSources),
          jsonParameter(prepared.record.source),
          prepared.record.digest,
          prepared.record.processingState,
          prepared.record.attempts,
          prepared.record.receivedAt,
          prepared.record.updatedAt,
        ],
      );
      await client.query(
        `INSERT INTO ${historicalBaselines}
          (platform_id, session_id, result_revision, source_system,
           source_key, source_digest, record_digest, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          prepared.record.platformId,
          prepared.record.sessionId,
          prepared.record.resultRevision,
          prepared.baseline.sourceSystem,
          prepared.baseline.sourceKey,
          prepared.baseline.sourceDigest,
          prepared.record.digest,
          this.now(),
        ],
      );
      await client.query('COMMIT');
      committed = true;
      return {
        status: 'imported',
        record: recordFromRow(inserted.rows[0]),
        baseline: copy(prepared.baseline),
      };
    } catch (error) {
      if (!committed) await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async get(
    platformId: string,
    sessionId: string,
    resultRevision?: number,
  ): Promise<PlatformCompletionRecord | null> {
    requireString(platformId, 'platformId');
    requireString(sessionId, 'sessionId');
    if (resultRevision !== undefined) requireRevision(resultRevision);
    const result = await this.pool.query(
      `SELECT * FROM ${tableName(this.schema, 'records')}
       WHERE platform_id = $1 AND session_id = $2
         ${resultRevision === undefined ? '' : 'AND result_revision = $3'}
       ORDER BY result_revision DESC LIMIT 1`,
      resultRevision === undefined
        ? [platformId, sessionId]
        : [platformId, sessionId, resultRevision],
    );
    return result.rows.length === 0 ? null : recordFromRow(result.rows[0]);
  }

  async getHistoricalBaseline(
    platformId: string,
    sessionId: string,
    resultRevision?: number,
  ): Promise<HistoricalCompletionBaseline | null> {
    requireString(platformId, 'platformId');
    requireString(sessionId, 'sessionId');
    if (resultRevision !== undefined) requireRevision(resultRevision);
    const result = await this.pool.query(
      `SELECT source_system, source_key, source_digest
         FROM ${tableName(this.schema, 'historical_baselines')}
        WHERE platform_id = $1 AND session_id = $2
          ${resultRevision === undefined ? '' : 'AND result_revision = $3'}
        ORDER BY result_revision DESC LIMIT 1`,
      resultRevision === undefined
        ? [platformId, sessionId]
        : [platformId, sessionId, resultRevision],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row
      ? {
          sourceSystem: String(row.source_system),
          sourceKey: String(row.source_key),
          sourceDigest: String(row.source_digest),
        }
      : null;
  }

  async listConflicts(
    platformId: string,
    sessionId?: string,
    limit = 100,
  ): Promise<readonly CompletionRecordConflict[]> {
    requireString(platformId, 'platformId');
    if (sessionId !== undefined) requireString(sessionId, 'sessionId');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CONFLICTS)
      throw new CompletionRecordStoreError(
        'INVALID_ARGUMENT',
        'invalid conflict limit',
      );
    const result = await this.pool.query(
      `SELECT * FROM ${tableName(this.schema, 'conflicts')}
       WHERE platform_id = $1 ${sessionId === undefined ? '' : 'AND session_id = $2'}
       ORDER BY created_at DESC, conflict_id DESC LIMIT ${limit}`,
      sessionId === undefined ? [platformId] : [platformId, sessionId],
    );
    return result.rows.map(conflictFromRow);
  }

  async claimNext(
    options: CompletionClaimOptions,
  ): Promise<CompletionClaim | null> {
    const values = validateClaimOptions(options, this.now());
    const client = await this.pool.connect();
    const records = tableName(this.schema, 'records');
    try {
      await client.query('BEGIN');
      const platformWhere =
        this.options.platformId === undefined ? '' : 'platform_id = $1 AND ';
      const nowParameter = this.options.platformId === undefined ? '$1' : '$2';
      const result = await client.query(
        `SELECT * FROM ${records}
         WHERE ${platformWhere}processing_state IN ('received', 'result-stored', 'settling')
           AND (next_attempt_at IS NULL OR next_attempt_at <= ${nowParameter})
           AND (claim_token IS NULL OR lease_until IS NULL OR lease_until <= ${nowParameter})
         ORDER BY updated_at, session_id, result_revision
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
        this.options.platformId === undefined
          ? [values.now]
          : [this.options.platformId, values.now],
      );
      if (result.rows.length === 0) {
        await client.query('COMMIT');
        return null;
      }
      const token = randomUUID();
      const updated = await client.query(
        `UPDATE ${records}
           SET attempts = attempts + 1, claim_owner = $1, claim_token = $2,
               lease_until = $3, updated_at = $4
         WHERE platform_id = $5 AND session_id = $6 AND result_revision = $7
         RETURNING *`,
        [
          values.owner,
          token,
          values.now + values.leaseMs,
          values.now,
          result.rows[0].platform_id,
          result.rows[0].session_id,
          result.rows[0].result_revision,
        ],
      );
      await client.query('COMMIT');
      return claimFromRow(updated.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async renewClaim(
    claim: CompletionClaim,
    leaseMs = 30_000,
  ): Promise<CompletionClaim> {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 86_400_000)
      throw new CompletionRecordStoreError(
        'INVALID_ARGUMENT',
        'leaseMs must be between 1 and 86400000',
      );
    const now = this.now();
    const result = await this.pool.query(
      `UPDATE ${tableName(this.schema, 'records')}
          SET lease_until = $1, updated_at = $2
        WHERE platform_id = $3 AND session_id = $4 AND result_revision = $5
          AND claim_owner = $6 AND claim_token = $7 AND lease_until > $2
        RETURNING *`,
      [
        now + leaseMs,
        now,
        claim.record.platformId,
        claim.record.sessionId,
        claim.record.resultRevision,
        claim.owner,
        claim.token,
      ],
    );
    if (result.rows.length === 0)
      throw new CompletionRecordStoreError(
        'CLAIM_LOST',
        'Completion claim is no longer owned or has expired',
      );
    return claimFromRow(result.rows[0]);
  }

  private async transition(
    claim: CompletionClaim,
    state: Exclude<CompletionProcessingState, 'received' | 'conflict'>,
  ): Promise<PlatformCompletionRecord> {
    const now = this.now();
    const records = tableName(this.schema, 'records');
    const keyValues = [
      claim.record.platformId,
      claim.record.sessionId,
      claim.record.resultRevision,
    ];
    const settled = await this.pool.query(
      `SELECT * FROM ${records}
        WHERE platform_id = $1 AND session_id = $2 AND result_revision = $3
          AND processing_state = 'settled'`,
      keyValues,
    );
    if (settled.rows.length > 0) return recordFromRow(settled.rows[0]);
    const stateCondition =
      state === 'result-stored'
        ? "processing_state IN ('received', 'result-stored', 'settling')"
        : state === 'settling'
          ? "processing_state IN ('result-stored', 'settling')"
          : "processing_state IN ('result-stored', 'settling')";
    const nextState = state;
    const clearClaim = state === 'settled';
    const result = await this.pool.query(
      `UPDATE ${records}
          SET processing_state = CASE
                WHEN $1 = 'result-stored' AND processing_state = 'settling' THEN 'settling'
                ELSE $1
              END,
              processing_error = NULL,
              claim_owner = CASE WHEN $2 THEN NULL ELSE claim_owner END,
              claim_token = CASE WHEN $2 THEN NULL ELSE claim_token END,
              lease_until = CASE WHEN $2 THEN NULL ELSE lease_until END,
              updated_at = $3
        WHERE platform_id = $4 AND session_id = $5 AND result_revision = $6
          AND ${stateCondition}
          AND (
            claim_owner = $7 AND claim_token = $8 AND lease_until > $3
          )
        RETURNING *`,
      [
        nextState,
        clearClaim,
        now,
        claim.record.platformId,
        claim.record.sessionId,
        claim.record.resultRevision,
        claim.owner,
        claim.token,
      ],
    );
    if (result.rows.length === 0) {
      const settledAfterRace = await this.pool.query(
        `SELECT * FROM ${records}
          WHERE platform_id = $1 AND session_id = $2 AND result_revision = $3
            AND processing_state = 'settled'`,
        keyValues,
      );
      if (settledAfterRace.rows.length > 0)
        return recordFromRow(settledAfterRace.rows[0]);
      throw new CompletionRecordStoreError(
        'CLAIM_LOST',
        'Completion claim is no longer owned or has expired',
        {
          platformId: claim.record.platformId,
          sessionId: claim.record.sessionId,
        },
      );
    }
    return recordFromRow(result.rows[0] as Record<string, unknown>);
  }

  async markResultStored(
    claim: CompletionClaim,
  ): Promise<PlatformCompletionRecord> {
    return this.transition(claim, 'result-stored');
  }

  async markSettling(
    claim: CompletionClaim,
  ): Promise<PlatformCompletionRecord> {
    return this.transition(claim, 'settling');
  }

  async markSettled(claim: CompletionClaim): Promise<PlatformCompletionRecord> {
    return this.transition(claim, 'settled');
  }

  async fail(
    claim: CompletionClaim,
    error: unknown,
    nextAttemptAt = this.now() + 1_000,
  ): Promise<PlatformCompletionRecord> {
    requireTimestamp(nextAttemptAt, 'nextAttemptAt');
    const now = this.now();
    const result = await this.pool.query(
      `UPDATE ${tableName(this.schema, 'records')}
          SET processing_error = $1, next_attempt_at = $2,
              claim_owner = NULL, claim_token = NULL, lease_until = NULL,
              updated_at = $3
        WHERE platform_id = $4 AND session_id = $5 AND result_revision = $6
          AND processing_state <> 'settled'
          AND claim_owner = $7 AND claim_token = $8 AND lease_until > $3
        RETURNING *`,
      [
        errorMessage(error),
        nextAttemptAt,
        now,
        claim.record.platformId,
        claim.record.sessionId,
        claim.record.resultRevision,
        claim.owner,
        claim.token,
      ],
    );
    if (result.rows.length === 0)
      throw new CompletionRecordStoreError(
        'CLAIM_LOST',
        'Completion claim is no longer owned or has expired',
      );
    return recordFromRow(result.rows[0]);
  }

  async processClaim(
    claim: CompletionClaim,
    options: CompletionProcessOptions = {},
  ): Promise<PlatformCompletionRecord> {
    let current = claim;
    try {
      let record = await this.markResultStored(current);
      if (record.processingState === 'settled') return record;
      current = claimHandle(record);
      if (options.settle) {
        record = await this.markSettling(current);
        current = claimHandle(record);
        await options.settle(copy(record));
      }
      return await this.markSettled(current);
    } catch (error) {
      await this.fail(current, error).catch(() => undefined);
      throw error;
    }
  }

  async close(): Promise<void> {
    // Pool ownership remains with the application, matching the other platform stores.
  }
}
