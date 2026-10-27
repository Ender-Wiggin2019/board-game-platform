export interface IAdminMigrationReceipt {
  id: string;
  sourceSystem: string;
  legacyUserId: string;
  newUserId: string;
  snapshotId: string;
  policyVersion: string;
  counts: Record<string, unknown>;
  createdAt: string;
}

export interface IAdminAccountSecurityEvent {
  id: string;
  actorUserId: string | null;
  subjectUserId: string | null;
  eventKind: string;
  requestId: string | null;
  context: Record<string, unknown> | null;
  createdAt: string;
}

export interface IAdminAccountSecurityList<T> {
  items: T[];
}
