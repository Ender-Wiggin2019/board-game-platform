import { createRequire } from 'node:module';

export interface BrowserDevelopmentVerificationOptions {
  readonly baseURL: string;
  readonly gameId: string;
}

export type BrowserVerificationScope =
  | 'full-lifecycle'
  | 'native-mount'
  | 'metadata-only';

export interface BrowserDevelopmentVerificationResult {
  /** The browser verifier completed at the scope reported below. */
  readonly browserVerified: true;
  readonly gameId: string;
  readonly pages: number;
  readonly sessionId?: string;
  readonly modeId: string;
  readonly modeEntry: 'room' | 'direct-solo';
  readonly playerCount: number;
  readonly scenarioId?: string;
  readonly setupSource: 'scenario' | 'schema-minimum' | 'empty';
  readonly scope: BrowserVerificationScope;
  readonly nativeClientLoaded: boolean;
  readonly resultChecked: boolean;
  readonly replayChecked: boolean;
  readonly replayReady: boolean;
  readonly notes: readonly string[];
}

interface PlaywrightPage {
  goto(url: string): Promise<unknown>;
  waitForSelector(
    selector: string,
    options?: Record<string, unknown>,
  ): Promise<unknown>;
  waitForFunction(
    expression: string,
    arg?: unknown,
    options?: Record<string, unknown>,
  ): Promise<unknown>;
  selectOption(selector: string, value: string): Promise<unknown>;
  fill(selector: string, value: string): Promise<unknown>;
  click(selector: string): Promise<unknown>;
  inputValue(selector: string): Promise<string>;
  textContent(selector: string): Promise<string | null>;
  evaluate<T>(expression: string, arg?: unknown): Promise<T>;
  locator(selector: string): {
    count(): Promise<number>;
    click(): Promise<unknown>;
  };
  close(): Promise<void>;
}

interface PlaywrightBrowser {
  newPage(): Promise<PlaywrightPage>;
  close(): Promise<void>;
}

interface PlaywrightModule {
  chromium: {
    launch(options: Record<string, unknown>): Promise<PlaywrightBrowser>;
  };
}

interface ModeMetadata {
  readonly id: string;
  readonly entry: 'room' | 'direct-solo';
  readonly minPlayers: number;
  readonly maxPlayers: number;
}

interface ScenarioMetadata {
  readonly id: string;
  readonly setup: unknown;
  readonly hasCommands: boolean;
}

interface DevelopmentMetadata {
  readonly gameId: string;
  readonly modes: readonly ModeMetadata[];
  readonly setupSchema?: unknown;
}

interface DevelopmentRoom {
  readonly id: string;
  readonly revision: number;
  readonly status: string;
}

interface DevelopmentSessionState {
  readonly token: string;
  readonly sessionId: string;
}

function requirePlaywright(): string {
  try {
    return createRequire(import.meta.url).resolve('playwright');
  } catch (error) {
    throw new Error(
      'Playwright is required for browser verification; install it in @board-platform/cli',
      { cause: error },
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function integerValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value)
    ? value
    : undefined;
}

function metadataValue(value: unknown): DevelopmentMetadata {
  if (!isRecord(value))
    throw new Error('Development metadata is not an object');
  const gameId = stringValue(value.gameId);
  const modes = Array.isArray(value.modes)
    ? value.modes.flatMap((candidate): ModeMetadata[] => {
        if (!isRecord(candidate)) return [];
        const id = stringValue(candidate.id);
        const entry = candidate.entry;
        const minPlayers = integerValue(candidate.minPlayers);
        const maxPlayers = integerValue(candidate.maxPlayers);
        if (
          !id ||
          (entry !== 'room' && entry !== 'direct-solo') ||
          minPlayers === undefined ||
          maxPlayers === undefined ||
          minPlayers < 1 ||
          maxPlayers < minPlayers
        )
          return [];
        return [{ id, entry, minPlayers, maxPlayers }];
      })
    : [];
  if (!gameId || modes.length === 0)
    throw new Error('Development metadata did not publish a usable mode');
  return {
    gameId,
    modes,
    ...(value.setupSchema !== undefined
      ? { setupSchema: value.setupSchema }
      : {}),
  };
}

function scenariosValue(value: unknown): readonly ScenarioMetadata[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate): ScenarioMetadata[] => {
    if (!isRecord(candidate)) return [];
    const id = stringValue(candidate.id);
    if (!id || !Object.hasOwn(candidate, 'setup')) return [];
    return [
      {
        id,
        setup: candidate.setup,
        hasCommands:
          Array.isArray(candidate.commands) && candidate.commands.length > 0,
      },
    ];
  });
}

function jsonSchemaMinimum(schema: unknown): unknown {
  if (!isRecord(schema) || typeof schema.type !== 'string') return {};
  switch (schema.type) {
    case 'any':
      return {};
    case 'null':
      return null;
    case 'boolean':
      return false;
    case 'number':
    case 'integer': {
      const minimum =
        typeof schema.minimum === 'number' && Number.isFinite(schema.minimum)
          ? schema.minimum
          : 0;
      const maximum =
        typeof schema.maximum === 'number' && Number.isFinite(schema.maximum)
          ? schema.maximum
          : undefined;
      const candidate =
        schema.type === 'integer' ? Math.ceil(minimum) : minimum;
      const upperBound =
        schema.type === 'integer' && maximum !== undefined
          ? Math.floor(maximum)
          : maximum;
      return upperBound !== undefined && candidate > upperBound
        ? upperBound
        : candidate;
    }
    case 'string': {
      const values = schema.enum;
      if (Array.isArray(values) && typeof values[0] === 'string')
        return values[0];
      const minLength =
        typeof schema.minLength === 'number' && schema.minLength > 0
          ? Math.min(schema.minLength, 256)
          : 0;
      return 'v'.repeat(minLength);
    }
    case 'array': {
      const minItems =
        typeof schema.minItems === 'number' && schema.minItems > 0
          ? Math.min(schema.minItems, 32)
          : 0;
      return Array.from({ length: minItems }, () =>
        jsonSchemaMinimum(schema.items),
      );
    }
    case 'object': {
      const output: Record<string, unknown> = {};
      const properties = isRecord(schema.properties) ? schema.properties : {};
      const required = Array.isArray(schema.required)
        ? schema.required.filter(
            (key): key is string => typeof key === 'string',
          )
        : [];
      for (const key of required) {
        if (Object.hasOwn(properties, key))
          output[key] = jsonSchemaMinimum(properties[key]);
      }
      return output;
    }
    default:
      return {};
  }
}

function chooseSetup(
  metadata: DevelopmentMetadata,
  scenario: ScenarioMetadata | undefined,
): {
  readonly value: unknown;
  readonly source: 'scenario' | 'schema-minimum' | 'empty';
} {
  if (scenario) return { value: scenario.setup, source: 'scenario' };
  const schema = isRecord(metadata.setupSchema)
    ? metadata.setupSchema.schema
    : undefined;
  if (schema === undefined) return { value: {}, source: 'empty' };
  return { value: jsonSchemaMinimum(schema), source: 'schema-minimum' };
}

async function waitForReady(page: PlaywrightPage): Promise<void> {
  await page.waitForFunction(
    "document.querySelectorAll('#account option').length >= 2 && document.querySelector('#status')?.textContent?.includes('authenticated')",
    undefined,
    { timeout: 30_000 },
  );
}

async function loadMetadata(page: PlaywrightPage): Promise<{
  readonly metadata: DevelopmentMetadata;
  readonly scenarios: readonly ScenarioMetadata[];
}> {
  const payload = await page.evaluate<unknown>(`(async () => {
    const [metadataResponse, scenariosResponse] = await Promise.all([
      fetch('/v1/metadata'),
      fetch('/v1/scenarios'),
    ]);
    if (!metadataResponse.ok)
      throw new Error('Unable to read development metadata: HTTP ' + metadataResponse.status);
    if (!scenariosResponse.ok)
      throw new Error('Unable to read development scenarios: HTTP ' + scenariosResponse.status);
    return {
      metadata: await metadataResponse.json(),
      scenarios: await scenariosResponse.json(),
    };
  })()`);
  if (!isRecord(payload))
    throw new Error('Development metadata response is invalid');
  const metadataPayload = payload.metadata;
  const scenariosPayload = payload.scenarios;
  if (!isRecord(metadataPayload) || !isRecord(scenariosPayload))
    throw new Error('Development metadata response is invalid');
  return {
    metadata: metadataValue(metadataPayload.description),
    scenarios: scenariosValue(scenariosPayload.scenarios),
  };
}

const NATIVE_UI_ERROR_EXPRESSION = `(() => {
    const pageErrors = globalThis.__BGP_VERIFY_PAGE_ERRORS__;
    if (Array.isArray(pageErrors) && typeof pageErrors[0] === 'string')
      return pageErrors[0];
    const candidates = [
      '#errorBanner:not([hidden])',
      '#game-root [data-testid="render-error"]',
      '#game-root [data-testid="game-error"]',
      '#game-root [role="alert"]',
    ];
    for (const selector of candidates) {
      const text = document.querySelector(selector)?.textContent?.trim();
      if (text) return text;
    }
    const output = document.querySelector('#output')?.textContent?.trim() || '';
    if (/^(?:Error|TypeError|ReferenceError):/iu.test(output)) return output;
    if (/(?:failed|unsupported|not found|invalid|denied|unauthenticated)/iu.test(output)) return output;
    return null;
  })()`;

async function visibleUiError(page: PlaywrightPage): Promise<string | null> {
  return page.evaluate<string | null>(NATIVE_UI_ERROR_EXPRESSION);
}

async function assertNoVisibleUiError(page: PlaywrightPage): Promise<void> {
  const error = await visibleUiError(page);
  if (error)
    throw new Error(`Native development UI reported an error: ${error}`);
}

const NATIVE_SURFACE_EXPRESSION = `(() => {
  const root = document.querySelector('#game-root');
  if (!root) return false;
  const placeholder = [...root.children].some((child) =>
    child.textContent?.trim() === 'Start a room to load the native game client',
  );
  if (placeholder) return false;
  return Boolean(root.querySelector(
    '[data-testid], [data-game-release], [data-counter-status], canvas, [role="main"], [class*="board"], [class*="game"]',
  ));
})()`;

async function waitForNativeMount(page: PlaywrightPage): Promise<void> {
  await page.waitForFunction(
    `(() => ${NATIVE_SURFACE_EXPRESSION} || Boolean(${NATIVE_UI_ERROR_EXPRESSION}))()`,
    undefined,
    { timeout: 60_000 },
  );
  await assertNoVisibleUiError(page);
  const mounted = await page.evaluate<boolean>(NATIVE_SURFACE_EXPRESSION);
  if (!mounted)
    throw new Error(
      'Native game client did not mount a game surface after session start',
    );
}

async function syncRoom(
  page: PlaywrightPage,
  roomId: string,
): Promise<DevelopmentRoom> {
  const room = await page.evaluate<unknown>(
    `(async ({ roomId }) => {
      const state = globalThis.__BGP_DEV_STATE__;
      const response = await fetch('/v1/rooms/' + encodeURIComponent(roomId), {
        headers: { authorization: 'Bearer ' + state.token },
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error?.messageKey || 'Unable to read room');
      state.room = value;
      return value;
    })(${JSON.stringify({ roomId })})`,
  );
  if (!isRecord(room) || typeof room.id !== 'string')
    throw new Error('Development host returned an invalid room');
  const revision = integerValue(room.revision);
  if (revision === undefined)
    throw new Error('Development host returned an invalid room revision');
  return {
    id: room.id,
    revision,
    status: typeof room.status === 'string' ? room.status : 'unknown',
  };
}

async function stateValue(
  page: PlaywrightPage,
): Promise<DevelopmentSessionState> {
  const state = await page.evaluate<unknown>(
    `({ token: globalThis.__BGP_DEV_STATE__?.token, sessionId: globalThis.__BGP_DEV_STATE__?.session?.sessionId })`,
  );
  if (!isRecord(state))
    throw new Error('Development client state is unavailable');
  const token = stringValue(state.token);
  const sessionId = stringValue(state.sessionId);
  if (!token || !sessionId)
    throw new Error('Development client did not publish an active session');
  return { token, sessionId };
}

async function endpointChecks(
  page: PlaywrightPage,
  state: DevelopmentSessionState,
): Promise<{
  readonly resultChecked: boolean;
  readonly replayChecked: boolean;
  readonly replayReady: boolean;
}> {
  return page.evaluate<{
    readonly resultChecked: boolean;
    readonly replayChecked: boolean;
    readonly replayReady: boolean;
  }>(
    `(async ({ sessionId, token }) => {
      const headers = { authorization: 'Bearer ' + token };
      const resultResponse = await fetch('/v1/sessions/' + encodeURIComponent(sessionId) + '/result', { headers });
      const replayResponse = await fetch('/v1/sessions/' + encodeURIComponent(sessionId) + '/replay/manifest', { headers });
      let replayReady = false;
      let replayChecked = replayResponse.ok;
      if (replayResponse.ok) replayReady = true;
      else if (replayResponse.status === 409) {
        const body = await replayResponse.json().catch(() => null);
        replayChecked = body?.error?.messageKey === 'server.runner.replay.not_completed';
      }
      return {
        resultChecked: resultResponse.ok,
        replayChecked,
        replayReady,
      };
    })(${JSON.stringify(state)})`,
  );
}

async function selectAccount(
  page: PlaywrightPage,
  baseURL: string,
  account: string,
): Promise<void> {
  const separator = baseURL.includes('?') ? '&' : '?';
  await page.goto(
    `${baseURL}${separator}account=${encodeURIComponent(account)}`,
  );
  await page.evaluate(`(() => {
    if (Array.isArray(globalThis.__BGP_VERIFY_PAGE_ERRORS__)) return;
    globalThis.__BGP_VERIFY_PAGE_ERRORS__ = [];
    window.addEventListener('error', (event) => {
      globalThis.__BGP_VERIFY_PAGE_ERRORS__.push(event.error?.message || event.message || 'page error');
    });
    window.addEventListener('unhandledrejection', (event) => {
      globalThis.__BGP_VERIFY_PAGE_ERRORS__.push(String(event.reason?.message || event.reason || 'unhandled rejection'));
    });
  })()`);
  await waitForReady(page);
  await page.selectOption('#account', account);
  await page.waitForFunction(
    "document.querySelector('#status')?.textContent?.includes('authenticated')",
    undefined,
    { timeout: 30_000 },
  );
  await assertNoVisibleUiError(page);
}

async function clickCounterButton(
  page: PlaywrightPage,
  label: string,
): Promise<void> {
  const clicked = await page.evaluate<boolean>(`(() => {
    const buttonLabel = ${JSON.stringify(label)};
    const button = [...document.querySelectorAll('#game-root button')].find(
      (candidate) => candidate.textContent?.trim() === buttonLabel,
    );
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`Native game button is unavailable: ${label}`);
  await assertNoVisibleUiError(page);
}

async function verifyCounterLifecycle(page: PlaywrightPage): Promise<void> {
  if ((await page.locator('[data-counter-status]').count()) === 0) return;
  const target = await page.evaluate<number>(
    "Number(document.querySelector('#game-root')?.textContent?.match(/Count \\d+ \\/ (\\d+)/)?.[1] || 0)",
  );
  if (!Number.isSafeInteger(target) || target < 2 || target > 10)
    throw new Error('Native counter client exposed an invalid target');
  await clickCounterButton(page, 'Increment');
  await page.waitForFunction(
    `document.querySelector('#game-root')?.textContent?.includes('Count 1 / ${target}')`,
    undefined,
    { timeout: 30_000 },
  );
  await clickCounterButton(page, 'Undo');
  await page.waitForFunction(
    `document.querySelector('#game-root')?.textContent?.includes('Count 0 / ${target}')`,
    undefined,
    { timeout: 30_000 },
  );
  for (let count = 1; count <= target; count += 1) {
    await clickCounterButton(page, 'Increment');
    await page.waitForFunction(
      `document.querySelector('#game-root')?.textContent?.includes('Count ${count} / ${target}') || document.querySelector('[data-counter-status]')?.getAttribute('data-counter-status') === 'completed'`,
      undefined,
      { timeout: 30_000 },
    );
  }
  await page.waitForFunction(
    "document.querySelector('[data-counter-status]')?.getAttribute('data-counter-status') === 'completed'",
    undefined,
    { timeout: 30_000 },
  );
  await clickCounterButton(page, 'Query replay');
  await page.waitForFunction(
    "document.querySelector('#game-root')?.textContent?.includes('manifest')",
    undefined,
    { timeout: 30_000 },
  );
}

export async function verifyDevelopmentBrowser(
  options: BrowserDevelopmentVerificationOptions,
): Promise<BrowserDevelopmentVerificationResult> {
  const loaded = (await import(requirePlaywright())) as unknown as {
    readonly default?: PlaywrightModule;
  } & PlaywrightModule;
  const playwright = loaded.default ?? loaded;
  const browser = await playwright.chromium.launch({ headless: true });
  const pages: PlaywrightPage[] = [];
  try {
    const metadataPage = await browser.newPage();
    pages.push(metadataPage);
    await selectAccount(metadataPage, options.baseURL, 'player1');
    const { metadata, scenarios } = await loadMetadata(metadataPage);
    if (metadata.gameId !== options.gameId)
      throw new Error(
        `Development metadata game mismatch: expected ${options.gameId}, got ${metadata.gameId}`,
      );
    const mode =
      metadata.modes.find((candidate) => candidate.entry === 'room') ??
      metadata.modes.find((candidate) => candidate.entry === 'direct-solo');
    if (!mode)
      throw new Error(
        'Development metadata did not publish a room or solo mode',
      );
    const playerCount = mode.entry === 'direct-solo' ? 1 : mode.minPlayers;
    if (playerCount > 4)
      throw new Error(
        `Development verifier supports at most four fixed player accounts; ${mode.id} requires ${playerCount}`,
      );
    const scenario = scenarios[0];
    // A command-bearing preset is a terminal fixture in many games. Keep its
    // setup, but do not replay the preset before the native client mounts: the
    // starter counter must still exercise Increment → Undo → terminal → replay.
    const scenarioForHost = scenario?.hasCommands ? undefined : scenario;
    const setup = chooseSetup(metadata, scenario);
    await metadataPage.selectOption('#mode', mode.id);
    if (scenarioForHost)
      await metadataPage.selectOption('#scenario', scenarioForHost.id);
    await metadataPage.fill('#setup', JSON.stringify(setup.value));

    const notes: string[] = [];
    if (scenario?.hasCommands)
      notes.push(
        `Scenario ${scenario.id} publishes commands; its setup was used without pre-applying commands so the native verifier can exercise the game UI.`,
      );
    let roomId: string | undefined;
    if (mode.entry === 'room') {
      await metadataPage.click('#create');
      await metadataPage.waitForFunction(
        "document.querySelector('#room-id')?.value?.length > 0",
        undefined,
        { timeout: 30_000 },
      );
      roomId = await metadataPage.inputValue('#room-id');
      if (!roomId) throw new Error('Development host did not return a room id');
      let room = await syncRoom(metadataPage, roomId);
      const playerPages = [metadataPage];
      for (let index = 1; index < playerCount; index += 1) {
        const account = `player${index + 1}`;
        const page = await browser.newPage();
        pages.push(page);
        await selectAccount(page, options.baseURL, account);
        await page.fill('#room-id', roomId);
        await syncRoom(page, roomId);
        await page.click('#join');
        await page.click('#ready');
        await assertNoVisibleUiError(page);
        room = await syncRoom(metadataPage, roomId);
        playerPages.push(page);
      }
      await syncRoom(metadataPage, roomId);
      await metadataPage.click('#ready');
      room = await syncRoom(metadataPage, roomId);
      if (room.status === 'open') await metadataPage.click('#start');
      else if (room.status !== 'started')
        throw new Error(`Room did not reach a startable state: ${room.status}`);
      for (const page of playerPages) await assertNoVisibleUiError(page);
    } else {
      // The development host treats a direct mode as an immediate private start;
      // the native shell still exposes the same Start control for rendering.
      await metadataPage.click('#create');
      await metadataPage.waitForFunction(
        "document.querySelector('#room-id')?.value?.length > 0",
        undefined,
        { timeout: 30_000 },
      );
      roomId = await metadataPage.inputValue('#room-id');
      if (!roomId)
        throw new Error(
          'Development host did not return a direct session fence',
        );
      await metadataPage.click('#start');
    }

    await waitForNativeMount(metadataPage);
    const nativeClientLoaded = await metadataPage.evaluate<boolean>(
      NATIVE_SURFACE_EXPRESSION,
    );
    await verifyCounterLifecycle(metadataPage);
    const state = await stateValue(metadataPage);
    const endpoints = await endpointChecks(metadataPage, state);
    if (!endpoints.resultChecked)
      throw new Error('Result endpoint was not available to the browser');
    const lifecycleEvidence =
      endpoints.replayReady ||
      (await metadataPage.locator('[data-counter-status]').count()) > 0;
    const scope: BrowserVerificationScope = lifecycleEvidence
      ? 'full-lifecycle'
      : nativeClientLoaded
        ? 'native-mount'
        : 'metadata-only';
    if (!lifecycleEvidence)
      notes.push(
        scenarioForHost
          ? 'The published scenario did not expose a terminal replay in the browser; lifecycle is scoped to native mount and result query.'
          : 'No game-owned completion scenario was published; lifecycle is scoped to native mount and result query.',
      );
    if (!endpoints.replayChecked)
      notes.push('Replay manifest is not supported by this game release.');
    return {
      browserVerified: true,
      gameId: options.gameId,
      pages: pages.length,
      sessionId: state.sessionId,
      modeId: mode.id,
      modeEntry: mode.entry,
      playerCount,
      ...(scenarioForHost ? { scenarioId: scenarioForHost.id } : {}),
      setupSource: setup.source,
      scope,
      nativeClientLoaded,
      resultChecked: endpoints.resultChecked,
      replayChecked: endpoints.replayChecked,
      replayReady: endpoints.replayReady,
      notes,
    };
  } finally {
    await Promise.all(pages.map((page) => page.close()));
    await browser.close();
  }
}
