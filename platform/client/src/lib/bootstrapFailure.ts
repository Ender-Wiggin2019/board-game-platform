import { captureCrash, type ICrashContext } from './crashReporter';
import { forceReloadLatestVersion } from './forceReloadLatestVersion';
import './bootstrapFailure.css';

// This emergency surface deliberately runs without application/i18n modules.
const messages = {
  en: {
    title: 'This page could not be opened',
    reload: 'Refresh page',
    home: 'Return home',
    report: 'Report error',
    sending: 'Sending error report…',
    sent: 'Error reported',
    failed: 'Could not send the report. Try again when you are online.',
    details: 'Technical details',
  },
  'zh-CN': {
    title: '页面无法打开',
    reload: '刷新页面',
    home: '返回首页',
    report: '上报错误',
    sending: '正在上报错误…',
    sent: '错误已上报',
    failed: '上报失败，请联网后重试。',
    details: '技术详情',
  },
  'pt-BR': {
    title: 'Não foi possível abrir esta página',
    reload: 'Atualizar página',
    home: 'Voltar ao início',
    report: 'Relatar erro',
    sending: 'Enviando relatório…',
    sent: 'Erro relatado',
    failed: 'Não foi possível enviar. Tente novamente quando estiver online.',
    details: 'Detalhes técnicos',
  },
};

export function showBootstrapFailure(
  error: unknown,
  context: ICrashContext = { source: 'bootstrap' },
): void {
  if (document.getElementById('bootstrap-failure')) return;
  const language = navigator.language.toLowerCase();
  const t =
    messages[
      language.startsWith('zh')
        ? 'zh-CN'
        : language.startsWith('pt')
          ? 'pt-BR'
          : 'en'
    ];
  const incident = captureCrash(error, context);
  const surface = document.createElement('main');
  surface.id = 'bootstrap-failure';
  surface.setAttribute('role', 'alert');
  const panel = document.createElement('section');
  const title = document.createElement('h1');
  title.textContent = t.title;
  const actions = document.createElement('div');
  actions.className = 'bootstrap-actions';
  const reload = document.createElement('button');
  reload.textContent = t.reload;
  reload.onclick = async () => {
    reload.disabled = true;
    try {
      await forceReloadLatestVersion();
    } finally {
      reload.disabled = false;
    }
  };
  const home = document.createElement('a');
  home.href = '/';
  home.textContent = t.home;
  const report = document.createElement('button');
  report.textContent = t.report;
  report.onclick = () => {
    void incident.submit();
  };
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  const update = () => {
    const state = incident.getSnapshot();
    report.disabled = state.status === 'sending' || state.status === 'sent';
    report.setAttribute('aria-busy', String(state.status === 'sending'));
    status.textContent =
      state.status === 'sent'
        ? `${t.sent} · ${state.reportId}`
        : state.status === 'sending'
          ? t.sending
          : state.status === 'failed'
            ? t.failed
            : '';
  };
  incident.subscribe(update);
  update();
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = t.details;
  const trace = document.createElement('pre');
  trace.textContent =
    error instanceof Error
      ? (error.stack ?? error.message)
      : typeof error === 'string'
        ? error
        : 'Unknown startup error';
  details.append(summary, trace);
  actions.append(reload, home, report);
  panel.append(title, actions, status, details);
  surface.append(panel);
  const root = document.getElementById('root');
  if (root) root.hidden = true;
  document.body.append(surface);
}
