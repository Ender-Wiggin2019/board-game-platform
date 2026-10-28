import type { JsonValue } from './json.js';
import type { SchemaDescriptor } from './schema.js';
import type {
  AccessContext,
  CommandId,
  ProtocolRequest,
  SafeCommandReceipt,
  SessionRoute,
} from './types.js';

/** One game-owned, operator-authenticated mutation request. */
export interface DeveloperCommand {
  readonly name: string;
  readonly input: JsonValue;
}

/** Safe metadata exposed to an operator before a command is submitted. */
export interface DeveloperConsoleCatalogEntry {
  readonly name: string;
  readonly label: string;
  readonly description?: string;
  readonly inputSchema: SchemaDescriptor;
}

export interface DeveloperConsoleCatalogRequest extends ProtocolRequest {
  readonly accessContext: AccessContext;
  readonly route: SessionRoute;
}

export interface DeveloperConsoleCatalogResponse {
  readonly catalog: readonly DeveloperConsoleCatalogEntry[];
  readonly enabled: boolean;
  readonly reason?: string;
  readonly revision: number;
}

export interface SubmitDeveloperCommandRequest extends ProtocolRequest {
  readonly accessContext: AccessContext;
  readonly route: SessionRoute;
  readonly commandId: CommandId;
  readonly expectedRevision: number;
  readonly command: DeveloperCommand;
}

export interface SubmitDeveloperCommandResponse {
  readonly receipt: SafeCommandReceipt;
  readonly revision: number;
}
