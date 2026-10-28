import {
  contractError,
  type DeveloperCommand,
  type DeveloperConsoleCatalogResponse,
  isErrorCode,
  isPlatformError,
  type SessionRoute,
  type SubmitDeveloperCommandRequest,
  type SubmitDeveloperCommandResponse,
} from '@board-game/contracts';
import type { GameHttpClient } from './runtime.js';

export type DeveloperCommandInput = Pick<
  SubmitDeveloperCommandRequest,
  'commandId' | 'expectedRevision' | 'command'
>;

/** The host supplies transport; only its server can issue operator authority. */
export interface GameDeveloperConsoleRuntime {
  readonly describe: (
    route: SessionRoute,
  ) => Promise<DeveloperConsoleCatalogResponse>;
  readonly submit: (
    route: SessionRoute,
    input: DeveloperCommandInput,
  ) => Promise<SubmitDeveloperCommandResponse>;
}

export function createDeveloperConsoleRuntime(
  http: GameHttpClient,
  path: (route: SessionRoute) => string,
  normalizeError?: (error: unknown) => unknown,
): GameDeveloperConsoleRuntime {
  async function response<T>(
    request: Promise<{ readonly data: T }>,
  ): Promise<T> {
    try {
      return (await request).data;
    } catch (error) {
      throw normalizeError?.(error) ?? error;
    }
  }
  return {
    describe: async (route) =>
      response(http.get<DeveloperConsoleCatalogResponse>(path(route))),
    submit: async (route, input) =>
      response(
        http.post<SubmitDeveloperCommandResponse>(`${path(route)}/commands`, {
          commandId: input.commandId,
          expectedRevision: input.expectedRevision,
          command: { ...input.command },
        }),
      ),
  };
}

/** Keeps an uncertain operator mutation intact across transport retries. */
export class DeveloperConsoleSession {
  private pending: DeveloperCommandInput | null = null;
  private inFlight = false;
  private uncertain = false;
  private readonly route: SessionRoute;

  constructor(
    private readonly runtime: GameDeveloperConsoleRuntime,
    route: SessionRoute,
    private readonly commandId: () => string = () => crypto.randomUUID(),
  ) {
    this.route = structuredClone(route);
  }

  get pendingCommand(): DeveloperCommandInput | null {
    return this.pending ? structuredClone(this.pending) : null;
  }

  describe(): Promise<DeveloperConsoleCatalogResponse> {
    return this.runtime.describe(this.route);
  }

  submit(
    command: DeveloperCommand,
    expectedRevision: number,
  ): Promise<SubmitDeveloperCommandResponse> {
    if (this.pending)
      throw contractError('CONFLICT', 'client.developer.retry_pending');
    this.pending = {
      commandId: this.commandId(),
      expectedRevision,
      command: structuredClone(command),
    };
    this.uncertain = false;
    return this.retryPending();
  }

  async retryPending(): Promise<SubmitDeveloperCommandResponse> {
    if (!this.pending)
      throw contractError('CONFLICT', 'client.developer.no_pending_command');
    if (this.inFlight)
      throw contractError('CONFLICT', 'client.developer.submitting');
    this.inFlight = true;
    try {
      const response = await this.runtime.submit(
        this.route,
        structuredClone(this.pending),
      );
      if (
        response.receipt.commandId !== this.pending.commandId ||
        response.receipt.sessionId !== this.route.sessionId
      ) {
        this.uncertain = true;
        throw contractError('CONFLICT', 'client.developer.receipt_mismatch');
      }
      if (response.receipt.status === 'unknown') this.uncertain = true;
      if (response.receipt.status !== 'unknown') this.pending = null;
      return response;
    } catch (error) {
      const code = isPlatformError(error)
        ? error.envelope.code
        : error && typeof error === 'object' && 'code' in error
          ? error.code
          : undefined;
      // A refused first attempt has no effect. After an unknown outcome only
      // a matching receipt can prove whether the original command committed.
      if (!this.uncertain && isErrorCode(code) && code !== 'INTERNAL') {
        this.pending = null;
      } else {
        this.uncertain = true;
      }
      throw error;
    } finally {
      this.inFlight = false;
    }
  }
}
