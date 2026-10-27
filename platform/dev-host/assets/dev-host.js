const state = {
  accounts: [],
  metadata: null,
  scenarios: [],
  token: null,
  account: null,
  rooms: [],
  room: null,
  sessionId: null,
  view: null,
  summary: null,
  events: null,
  result: null,
  replay: null,
  lastCommand: null,
  busy: new Set(),
};

const $ = (id) => document.getElementById(id);
const elements = {
  accountGrid: $('accountGrid'),
  authHint: $('authHint'),
  connectionStatus: $('connectionStatus'),
  roomForm: $('roomForm'),
  modeSelect: $('modeSelect'),
  scenarioSelect: $('scenarioSelect'),
  visibilitySelect: $('visibilitySelect'),
  seedInput: $('seedInput'),
  setupInput: $('setupInput'),
  createRoomButton: $('createRoomButton'),
  refreshRoomsButton: $('refreshRoomsButton'),
  roomCount: $('roomCount'),
  roomsList: $('roomsList'),
  welcomeView: $('welcomeView'),
  sessionView: $('sessionView'),
  errorBanner: $('errorBanner'),
  errorTitle: $('errorTitle'),
  errorDetail: $('errorDetail'),
  dismissErrorButton: $('dismissErrorButton'),
  toast: $('toast'),
  sessionKicker: $('sessionKicker'),
  sessionTitle: $('sessionTitle'),
  sessionStatus: $('sessionStatus'),
  sessionIdLabel: $('sessionIdLabel'),
  refreshSessionButton: $('refreshSessionButton'),
  resetSessionButton: $('resetSessionButton'),
  gameStateLabel: $('gameStateLabel'),
  revisionLabel: $('revisionLabel'),
  scoreStrip: $('scoreStrip'),
  yourSeatLabel: $('yourSeatLabel'),
  activeSeatLabel: $('activeSeatLabel'),
  viewEpochLabel: $('viewEpochLabel'),
  receiptStatus: $('receiptStatus'),
  receiptDetail: $('receiptDetail'),
  retryCommandButton: $('retryCommandButton'),
  commandScopeLabel: $('commandScopeLabel'),
  commandDeck: $('commandDeck'),
  queryRevisionInput: $('queryRevisionInput'),
  queryInput: $('queryInput'),
  runQueryButton: $('runQueryButton'),
  queryOutput: $('queryOutput'),
  refreshEventsButton: $('refreshEventsButton'),
  eventsList: $('eventsList'),
  loadReplayButton: $('loadReplayButton'),
  replaySummary: $('replaySummary'),
  replayOutput: $('replayOutput'),
  loadResultButton: $('loadResultButton'),
  resultSummary: $('resultSummary'),
};

class ApiError extends Error {
  constructor(envelope, status) {
    super(envelope?.messageKey || 'Request failed');
    this.name = 'ApiError';
    this.envelope = envelope || {
      code: 'INTERNAL',
      messageKey: 'dev-host.request.failed',
    };
    this.status = status;
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function pretty(value) {
  if (value === undefined) return '—';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} must be valid JSON.`);
  }
}

function setConnection(text, isError = false) {
  elements.connectionStatus.textContent = text;
  elements.connectionStatus.classList.toggle('is-error', isError);
}

function showError(error) {
  const envelope = error instanceof ApiError ? error.envelope : null;
  elements.errorTitle.textContent = envelope?.code || 'Request failed';
  elements.errorDetail.textContent =
    envelope?.messageKey ||
    error?.message ||
    'The development host did not accept the request.';
  elements.errorBanner.hidden = false;
}

function clearError() {
  elements.errorBanner.hidden = true;
}

let toastTimer;
function showToast(message) {
  window.clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  toastTimer = window.setTimeout(() => {
    elements.toast.hidden = true;
  }, 3600);
}

function setBusy(key, value) {
  if (value) state.busy.add(key);
  else state.busy.delete(key);
  document
    .querySelectorAll(`[data-busy-key="${CSS.escape(key)}"]`)
    .forEach((button) => {
      button.disabled = value;
      button.dataset.busy = value ? 'true' : 'false';
    });
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (state.token) headers.set('authorization', `Bearer ${state.token}`);
  if (options.body !== undefined && !headers.has('content-type'))
    headers.set('content-type', 'application/json');
  const response = await fetch(path, { ...options, headers });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) throw new ApiError(body?.error, response.status);
  return body;
}

function clearSessionState() {
  state.room = null;
  state.sessionId = null;
  state.view = null;
  state.summary = null;
  state.events = null;
  state.result = null;
  state.replay = null;
  state.lastCommand = null;
  elements.welcomeView.hidden = false;
  elements.sessionView.hidden = true;
}

function renderAccounts() {
  elements.accountGrid.innerHTML = state.accounts
    .map(
      (account) => `
    <button class="account-button ${state.account?.principalId === account.principalId ? 'is-active' : ''}" type="button" data-account="${escapeHtml(account.principalId)}">
      <span class="account-name">${escapeHtml(account.displayName)}</span>
      <span class="account-role">${escapeHtml(account.role)}</span>
    </button>
  `,
    )
    .join('');
  elements.accountGrid.querySelectorAll('[data-account]').forEach((button) => {
    button.addEventListener('click', () =>
      switchAccount(button.dataset.account),
    );
  });
  elements.authHint.textContent = state.account
    ? `${state.account.displayName} is active. Switching roles clears this session view and issues a new local bearer.`
    : 'Pick a fixed local account to issue a short-lived bearer.';
  elements.createRoomButton.disabled = !state.token;
}

function renderMetadata() {
  const description = state.metadata?.description;
  const modes = description?.modes || [];
  elements.modeSelect.innerHTML = modes
    .map(
      (mode) =>
        `<option value="${escapeHtml(mode.id)}">${escapeHtml(mode.id)} · ${escapeHtml(mode.minPlayers)}–${escapeHtml(mode.maxPlayers)} seats</option>`,
    )
    .join('');
  elements.scenarioSelect.innerHTML = `<option value="">No preset</option>${state.scenarios.map((scenario) => `<option value="${escapeHtml(scenario.id)}">${escapeHtml(scenario.label || scenario.id)}</option>`).join('')}`;
  updateAdmissionAction();
  renderCommands();
}

function updateAdmissionAction() {
  const mode = state.metadata?.description?.modes?.find(
    (candidate) => candidate.id === elements.modeSelect.value,
  );
  elements.createRoomButton.textContent =
    mode?.entry === 'direct-solo' ? 'Start solo session' : 'Create room';
}

function renderRooms() {
  elements.roomCount.textContent = state.token ? `${state.rooms.length}` : '—';
  if (!state.token) {
    elements.roomsList.innerHTML =
      '<div class="empty-mini">Select an operator to inspect rooms.</div>';
    return;
  }
  if (!state.rooms.length) {
    elements.roomsList.innerHTML =
      '<div class="empty-mini">No visible rooms yet. Create one above.</div>';
    return;
  }
  elements.roomsList.innerHTML = state.rooms
    .map((room) => {
      const member = room.members?.find(
        (candidate) => candidate.principalId === state.account?.principalId,
      );
      const allReady =
        room.members?.length >=
          (state.metadata?.description?.modes?.find(
            (mode) => mode.id === room.modeId,
          )?.minPlayers || 1) &&
        room.members.every((candidate) => candidate.ready);
      const selected = state.room?.id === room.id;
      return `
      <article class="room-item ${selected ? 'is-selected' : ''}">
        <div class="room-item-head"><strong>${escapeHtml(room.name || `${room.modeId} room`)}</strong><span class="status-chip ${room.status === 'started' ? 'is-active' : ''}">${escapeHtml(room.status)}</span></div>
        <div class="room-item-meta"><span>${escapeHtml(room.members?.length || 0)} seats · rev ${escapeHtml(room.revision)}</span><span>${escapeHtml(room.visibility)}</span></div>
        <div class="room-item-actions">
          ${!member && room.status === 'open' ? `<button class="mini-button" data-room-action="join" data-room-id="${escapeHtml(room.id)}">Join</button>` : ''}
          ${member && room.status === 'open' ? `<button class="mini-button ${member.ready ? 'is-ready' : ''}" data-room-action="ready" data-room-id="${escapeHtml(room.id)}">${member.ready ? 'Ready' : 'Mark ready'}</button>` : ''}
          ${room.ownerId === state.account?.principalId && room.status === 'open' && allReady ? `<button class="mini-button" data-room-action="start" data-room-id="${escapeHtml(room.id)}">Start</button>` : ''}
          ${room.status === 'started' && room.route?.sessionId ? `<button class="mini-button" data-room-action="open" data-room-id="${escapeHtml(room.id)}">Open session</button>` : ''}
        </div>
      </article>
    `;
    })
    .join('');
  elements.roomsList
    .querySelectorAll('[data-room-action]')
    .forEach((button) => {
      button.addEventListener('click', () =>
        handleRoomAction(button.dataset.roomAction, button.dataset.roomId),
      );
    });
}

function renderSession() {
  if (!state.sessionId) return;
  const payload = state.view?.payload || {};
  const summary = state.summary || {};
  const status = summary.status || payload.status || 'active';
  elements.welcomeView.hidden = true;
  elements.sessionView.hidden = false;
  elements.sessionTitle.textContent =
    state.metadata?.description?.metadata?.name ||
    state.metadata?.metadata?.name ||
    'Game session';
  elements.sessionKicker.textContent = `${state.room?.modeId || state.view?.gameId || 'GAME'} / SESSION`;
  elements.sessionStatus.textContent = status;
  elements.sessionStatus.className = `status-chip ${status === 'active' ? 'is-active' : ''} ${status === 'completed' ? 'is-completed' : ''}`;
  elements.sessionIdLabel.textContent = state.sessionId;
  elements.gameStateLabel.textContent = payload.status || status;
  elements.revisionLabel.textContent = `revision ${state.view?.revision ?? summary.sourceRevision ?? '—'}`;
  elements.yourSeatLabel.textContent = payload.you?.seatId || 'observer';
  elements.activeSeatLabel.textContent = payload.activeSeatId || '—';
  elements.viewEpochLabel.textContent = state.view?.viewEpoch || '—';
  elements.queryRevisionInput.value =
    state.view?.revision ?? summary.sourceRevision ?? 0;
  elements.commandScopeLabel.textContent =
    state.account?.role === 'player' ? 'PLAYER' : 'SPECTATOR';
  elements.retryCommandButton.disabled =
    !state.lastCommand || state.busy.has('command-retry');
  renderScores(payload.scores);
  renderEvents();
  renderResult();
  renderReplay();
}

function renderScores(scores) {
  if (!scores || typeof scores !== 'object') {
    elements.scoreStrip.innerHTML =
      '<span class="muted-copy">No score projection exposed by this game.</span>';
    return;
  }
  elements.scoreStrip.innerHTML = Object.entries(scores)
    .map(
      ([seat, score]) =>
        `<div class="score-pill"><span>${escapeHtml(seat)}</span><strong>${escapeHtml(score)}</strong></div>`,
    )
    .join('');
}

function renderCommands() {
  const commands = state.metadata?.description?.commands || [];
  if (!commands.length) {
    elements.commandDeck.innerHTML = `
      <div class="command-block">
        <div class="command-block-head"><strong>Raw command</strong><span>JSON</span></div>
        <textarea id="rawCommandInput" rows="4" spellcheck="false">{}</textarea>
        <button class="secondary-button" type="button" data-command-action="raw">Send command</button>
      </div>`;
  } else {
    elements.commandDeck.innerHTML = commands
      .map(
        (descriptor) => `
      <div class="command-block">
        <div class="command-block-head"><strong>${escapeHtml(descriptor.key)}</strong><span>${escapeHtml(descriptor.operation)}</span></div>
        <details class="command-schema">
          <summary>Input schema</summary>
          <pre>${escapeHtml(pretty(descriptor.inputSchema?.schema || { type: 'any' }))}</pre>
        </details>
        <textarea rows="3" spellcheck="false" aria-label="${escapeHtml(descriptor.key)} input" data-command-input="${escapeHtml(descriptor.key)}">{}</textarea>
        <button class="secondary-button" type="button" data-command-action="descriptor" data-command-key="${escapeHtml(descriptor.key)}">Send ${escapeHtml(descriptor.key)}</button>
      </div>
    `,
      )
      .join('');
  }
  elements.commandDeck
    .querySelectorAll('[data-command-action]')
    .forEach((button) => {
      button.addEventListener('click', () =>
        sendCommand(button.dataset.commandAction, button.dataset.commandKey),
      );
    });
}

function renderEvents() {
  if (!state.events?.events?.length) {
    elements.eventsList.innerHTML =
      '<div class="empty-mini">No projected events loaded.</div>';
    return;
  }
  elements.eventsList.innerHTML = state.events.events
    .map(
      (event) =>
        `<div class="event-row"><span class="event-sequence">#${escapeHtml(event.sequence)}</span><span class="event-payload">${escapeHtml(pretty(event.payload))}</span></div>`,
    )
    .join('');
}

function renderResult() {
  const result = state.result;
  if (!result) {
    elements.resultSummary.innerHTML =
      '<div class="empty-mini">No terminal result loaded.</div>';
    return;
  }
  elements.resultSummary.innerHTML = `
    <div class="result-stat"><span>status</span><strong>${escapeHtml(result.status || '—')}</strong></div>
    <div class="result-stat"><span>summary</span><strong>${escapeHtml(result.summary?.status || 'projection available')}</strong></div>
    <pre class="json-output">${escapeHtml(pretty(result.result || result.summary))}</pre>`;
}

function renderReplay() {
  if (!state.replay) {
    elements.replaySummary.innerHTML =
      '<div class="empty-mini">Replay appears after the session reaches a terminal state.</div>';
    elements.replayOutput.hidden = true;
    return;
  }
  const manifest = state.replay.manifest;
  const frames = state.replay.frames;
  elements.replaySummary.innerHTML = `
    <div class="replay-stat"><span>manifest</span><strong>loaded</strong></div>
    <div class="replay-stat"><span>frames</span><strong>${escapeHtml(frames?.answer?.frames?.length ?? 'bounded')}</strong></div>`;
  elements.replayOutput.textContent = pretty({
    manifest: manifest?.answer,
    frames: frames?.answer,
  });
  elements.replayOutput.hidden = false;
}

async function bootstrap() {
  try {
    const [accounts, metadata, scenarios] = await Promise.all([
      api('/v1/accounts', { auth: false }),
      api('/v1/metadata', { auth: false }),
      api('/v1/scenarios', { auth: false }),
    ]);
    state.accounts = accounts.accounts || [];
    state.metadata = metadata;
    state.scenarios = scenarios.scenarios || [];
    renderAccounts();
    renderMetadata();
    setConnection('Service ready');
  } catch (error) {
    setConnection('Service unavailable', true);
    showError(error);
  }
}

async function switchAccount(principalId) {
  if (!principalId || state.busy.has('auth')) return;
  clearError();
  setBusy('auth', true);
  state.token = null;
  state.account = null;
  state.rooms = [];
  clearSessionState();
  renderAccounts();
  renderRooms();
  try {
    const selected = await api('/v1/auth/select', {
      method: 'POST',
      body: JSON.stringify({ principalId }),
      auth: false,
    });
    state.token = selected.token;
    state.account = selected.account;
    renderAccounts();
    await refreshRooms();
    showToast(
      `${selected.account.displayName} is now the active local operator.`,
    );
  } catch (error) {
    showError(error);
  } finally {
    setBusy('auth', false);
  }
}

async function refreshRooms() {
  if (!state.token) {
    renderRooms();
    return;
  }
  try {
    const response = await api('/v1/rooms');
    state.rooms = response.rooms || [];
    renderRooms();
  } catch (error) {
    showError(error);
  }
}

async function createRoom(event) {
  event.preventDefault();
  if (!state.token || state.busy.has('create-room')) return;
  clearError();
  let setup;
  try {
    setup = parseJson(elements.setupInput.value, 'Setup');
  } catch (error) {
    showError(error);
    return;
  }
  const body = {
    modeId: elements.modeSelect.value,
    scenarioId: elements.scenarioSelect.value || undefined,
    visibility: elements.visibilitySelect.value,
    seed: elements.seedInput.value.trim() || undefined,
    setup,
  };
  setBusy('create-room', true);
  try {
    const response = await api('/v1/rooms', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    state.room = response.room;
    await refreshRooms();
    const mode = state.metadata?.description?.modes?.find(
      (candidate) => candidate.id === body.modeId,
    );
    showToast(
      mode?.entry === 'direct-solo'
        ? 'Solo session started from the real Host.'
        : 'Room created. Invite another fixed account to join.',
    );
  } catch (error) {
    showError(error);
  } finally {
    setBusy('create-room', false);
  }
}

async function handleRoomAction(action, roomId) {
  const room = state.rooms.find((candidate) => candidate.id === roomId);
  if (!room || state.busy.has(`room:${roomId}`)) return;
  clearError();
  setBusy(`room:${roomId}`, true);
  try {
    if (action === 'join') {
      const response = await api(
        `/v1/rooms/${encodeURIComponent(roomId)}/join`,
        {
          method: 'POST',
          body: JSON.stringify({ expectedRevision: room.revision }),
        },
      );
      state.room = response;
      await refreshRooms();
      showToast('Joined room. Mark this seat ready when the roster is set.');
    } else if (action === 'ready') {
      const member = room.members.find(
        (candidate) => candidate.principalId === state.account?.principalId,
      );
      const response = await api(
        `/v1/rooms/${encodeURIComponent(roomId)}/ready`,
        {
          method: 'POST',
          body: JSON.stringify({
            expectedRevision: room.revision,
            ready: !member?.ready,
          }),
        },
      );
      state.room = response;
      await refreshRooms();
    } else if (action === 'start') {
      const response = await api(
        `/v1/rooms/${encodeURIComponent(roomId)}/start`,
        {
          method: 'POST',
          body: JSON.stringify({
            expectedRevision: room.revision,
            requestId: `ui-start-${roomId}-${room.revision}`,
          }),
        },
      );
      state.room = response.room;
      await refreshRooms();
      await openSession(response.start.sessionId, response.room);
    } else if (action === 'open') {
      state.room = room;
      await openSession(room.route.sessionId, room);
    }
  } catch (error) {
    showError(error);
  } finally {
    setBusy(`room:${roomId}`, false);
  }
}

async function openSession(sessionId, room) {
  state.sessionId = sessionId;
  state.room = room || state.room;
  elements.welcomeView.hidden = true;
  elements.sessionView.hidden = false;
  renderSession();
  await refreshSession();
}

async function refreshSession() {
  if (!state.sessionId || !state.token) return;
  clearError();
  try {
    const [view, summary] = await Promise.all([
      api(`/v1/sessions/${encodeURIComponent(state.sessionId)}/view`),
      api(`/v1/sessions/${encodeURIComponent(state.sessionId)}/summary`),
    ]);
    state.view = view;
    state.summary = summary;
    renderSession();
    await Promise.all([refreshEvents(), loadResult()]);
  } catch (error) {
    showError(error);
  }
}

async function sendCommand(kind, key) {
  if (!state.sessionId || !state.token || state.busy.has('command')) return;
  clearError();
  let body;
  if (kind === 'retry') {
    if (!state.lastCommand) return;
    body = state.lastCommand;
  } else {
    const input = key
      ? parseJson(
          document.querySelector(`[data-command-input="${CSS.escape(key)}"]`)
            ?.value || '{}',
          `${key} input`,
        )
      : parseJson($('rawCommandInput')?.value || '{}', 'Command');
    body = {
      commandId: `ui-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      precondition: {
        kind: 'revision',
        expectedRevision:
          state.view?.revision ?? state.summary?.sourceRevision ?? 0,
      },
      command: key
        ? { type: '@board-game/service-command', key, input }
        : input,
    };
  }
  setBusy(kind === 'retry' ? 'command-retry' : 'command', true);
  try {
    const response = await api(
      `/v1/sessions/${encodeURIComponent(state.sessionId)}/command`,
      { method: 'POST', body: JSON.stringify(body) },
    );
    state.lastCommand = body;
    if (response.view) state.view = response.view;
    elements.receiptStatus.textContent = response.receipt?.status || 'accepted';
    elements.receiptDetail.textContent = `${response.receipt?.commandId || body.commandId} · persisted revision ${response.receipt?.persistedRevision ?? '—'}`;
    renderSession();
    await refreshSession();
    showToast(`Command ${response.receipt?.status || 'accepted'}.`);
  } catch (error) {
    showError(error);
  } finally {
    setBusy(kind === 'retry' ? 'command-retry' : 'command', false);
    elements.retryCommandButton.disabled = !state.lastCommand;
  }
}

async function runQuery() {
  if (!state.sessionId || state.busy.has('query')) return;
  clearError();
  let query;
  try {
    query = parseJson(elements.queryInput.value, 'Query');
  } catch (error) {
    showError(error);
    return;
  }
  setBusy('query', true);
  try {
    const revision = Number(elements.queryRevisionInput.value || 0);
    const response = await api(
      `/v1/sessions/${encodeURIComponent(state.sessionId)}/queries`,
      { method: 'POST', body: JSON.stringify({ revision, query }) },
    );
    elements.queryOutput.textContent = pretty(response.answer);
    showToast('Query answered by the game projection.');
  } catch (error) {
    showError(error);
  } finally {
    setBusy('query', false);
  }
}

async function refreshEvents() {
  if (!state.sessionId || !state.token) return;
  try {
    state.events = await api(
      `/v1/sessions/${encodeURIComponent(state.sessionId)}/events?afterSequence=0&limit=100`,
    );
    renderEvents();
  } catch (error) {
    showError(error);
  }
}

async function loadResult() {
  if (!state.sessionId || !state.token) return;
  try {
    state.result = await api(
      `/v1/sessions/${encodeURIComponent(state.sessionId)}/result`,
    );
    renderResult();
  } catch (error) {
    showError(error);
  }
}

async function loadReplay() {
  if (!state.sessionId || !state.token || state.busy.has('replay')) return;
  clearError();
  setBusy('replay', true);
  try {
    const id = encodeURIComponent(state.sessionId);
    const [manifest, frames] = await Promise.all([
      api(`/v1/sessions/${id}/replay/manifest`),
      api(`/v1/sessions/${id}/replay/frames?from=0&limit=100`),
    ]);
    state.replay = { manifest, frames };
    renderReplay();
    showToast('Replay projection loaded.');
  } catch (error) {
    showError(error);
  } finally {
    setBusy('replay', false);
  }
}

async function resetSession() {
  if (!state.sessionId || !state.token || state.busy.has('reset')) return;
  if (
    !window.confirm(
      'Reset this game? A new session ID will be created and every local bearer will be rotated.',
    )
  )
    return;
  clearError();
  setBusy('reset', true);
  try {
    const response = await api(
      `/v1/sessions/${encodeURIComponent(state.sessionId)}/reset`,
      { method: 'POST', body: '{}' },
    );
    state.token = null;
    state.account = null;
    state.rooms = [];
    clearSessionState();
    renderAccounts();
    renderRooms();
    showToast(
      `Reset created ${response.sessionId}. Choose an operator again; auth epochs were rotated.`,
    );
  } catch (error) {
    showError(error);
  } finally {
    setBusy('reset', false);
  }
}

elements.roomForm.addEventListener('submit', createRoom);
elements.refreshRoomsButton.addEventListener('click', refreshRooms);
elements.refreshSessionButton.addEventListener('click', refreshSession);
elements.resetSessionButton.addEventListener('click', resetSession);
elements.retryCommandButton.addEventListener('click', () =>
  sendCommand('retry'),
);
elements.runQueryButton.addEventListener('click', runQuery);
elements.refreshEventsButton.addEventListener('click', refreshEvents);
elements.loadResultButton.addEventListener('click', loadResult);
elements.loadReplayButton.addEventListener('click', loadReplay);
elements.dismissErrorButton.addEventListener('click', clearError);
elements.modeSelect.addEventListener('change', updateAdmissionAction);
elements.scenarioSelect.addEventListener('change', () => {
  const scenario = state.scenarios.find(
    (candidate) => candidate.id === elements.scenarioSelect.value,
  );
  if (scenario) elements.setupInput.value = pretty(scenario.setup);
});

bootstrap();
