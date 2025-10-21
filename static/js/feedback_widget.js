// feedback_widget.js — Unified in-app support + diagnostics widget

const SUPPORT_QUICK_ACTIONS = [
  { label: 'Missed shot', message: "That last shot didn't log.", autosend: true },
  { label: 'Call me…', message: () => {
      const guess = (
        window.__USER_NAME ||
        window.__USER_DISPLAY_NAME ||
        localStorage.getItem('firstname') ||
        'Player'
      );
      return `Please call me ${guess}.`;
    }, autosend: true },
  { label: 'Camera setup', message: "Where do I setup the camera?", autosend: true },
  { label: 'Progress', message: "How am I doing coach?", autosend: true },
  { label: 'Tech check', message: "Any technical issue I should know about?", autosend: true },
  { label: 'Account setup', message: "How do I setup my account?", autosend: true },
  { label: 'Challenge', message: "How do I join a challenge?", autosend: true },
  { label: 'Shot miscount', message: "That wasn't a shot.", autosend: true },
];

const SUPPORT_MAX_LIMIT = 80;
const LOG_HISTORY_LIMIT = 60;

// --------------------------------------------------------------------------- //
//  Utility helpers
// --------------------------------------------------------------------------- //

function q(selector, root = document) { return root.querySelector(selector); }
function qq(selector, root = document) { return Array.from(root.querySelectorAll(selector)); }

function mk(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null) continue;
    if (key === 'class') node.className = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  children.flat().forEach((child) => {
    if (child == null) return;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  });
  return node;
}

function niceTime(ts) {
  try {
    if (!ts) return '';
    const d = typeof ts === 'number' ? new Date(ts) : new Date(String(ts));
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch { return ''; }
}

function getActiveSessionId() {
  try { if (window.__SESSION_ID) return window.__SESSION_ID; } catch {}
  try { return sessionStorage.getItem('doach_active_session') || null; } catch {}
  return null;
}

function getLikelyShotId() {
  try {
    if (window.__SHOT_ID) return String(window.__SHOT_ID);
    const list = window.__shotList || [];
    if (list.length) return String(list[list.length - 1]?.shotId ?? list.length);
  } catch {}
  return null;
}

function debounce(fn, ms = 200) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(null, args), ms);
  };
}

// --------------------------------------------------------------------------- //
//  Error log capture (reused from legacy feedback widget)
// --------------------------------------------------------------------------- //

const feedbackStore = {
  logs: [],
  push(entry) {
    this.logs.push(entry);
    if (this.logs.length > LOG_HISTORY_LIMIT) this.logs = this.logs.slice(-LOG_HISTORY_LIMIT);
    saveLogs();
    renderLogs();
  },
  clear() {
    this.logs = [];
    saveLogs();
    renderLogs();
  },
};

function saveLogs() {
  try { localStorage.setItem('doachFeedbackLogs', JSON.stringify(feedbackStore.logs)); } catch {}
}

function loadLogs() {
  try {
    const raw = JSON.parse(localStorage.getItem('doachFeedbackLogs') || '[]');
    if (Array.isArray(raw)) feedbackStore.logs = raw;
  } catch { feedbackStore.logs = []; }
}

function installGlobalLogCatcher() {
  window.addEventListener('error', (ev) => {
    feedbackStore.push({
      type: 'error',
      time: Date.now(),
      message: ev?.error?.message || ev.message || 'Error',
      stack: ev?.error?.stack || null,
      source: ev?.filename,
      line: ev?.lineno,
      col: ev?.colno,
    });
  });

  window.addEventListener('unhandledrejection', (ev) => {
    const reason = ev?.reason;
    feedbackStore.push({
      type: 'unhandledrejection',
      time: Date.now(),
      message: (reason && (reason.message || reason.toString())) || 'Unhandled rejection',
      stack: reason?.stack || null,
    });
  });

  const origErr = console.error;
  console.error = function (...args) {
    try {
      feedbackStore.push({
        type: 'console.error',
        time: Date.now(),
        message: args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '),
      });
    } catch {}
    origErr.apply(console, args);
  };

  window.reportClientEvent = (label, data) => {
    feedbackStore.push({
      type: 'event',
      time: Date.now(),
      message: label,
      data,
    });
  };
}

// --------------------------------------------------------------------------- //
//  Support state + rendering
// --------------------------------------------------------------------------- //

const supportState = {
  loaded: false,
  loading: false,
  sending: false,
  thread: [],
  lastLoadError: null,
};

let panel,
    tabs,
    threadBox,
    supportInput,
    supportSendButton,
    quickRow,
    supportStatus,
    logsBox,
    includeLogsCheckbox,
    includeStateCheckbox,
    fabButton;

function ensureSupportCSS() {
  if (document.getElementById('doach-support-css')) return;
  const css = document.createElement('style');
  css.id = 'doach-support-css';
  css.textContent = `
  .doach-fb-fab {
    position: fixed; right: 16px; bottom: 16px; z-index: 10060;
    width: 48px; height: 48px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    background: #2d6cff; color: #fff; font-size: 20px;
    border: 0; cursor: pointer; box-shadow: 0 12px 28px rgba(0,0,0,.35);
  }
  .doach-fb-panel {
    position: fixed; right: 0; top: 0; bottom: 0; width: 460px;
    background: rgba(15,16,22,.96); color: #fff; z-index: 10055;
    transform: translateX(110%); transition: transform .22s ease;
    border-left: 1px solid rgba(255,255,255,.12);
    box-shadow: -10px 0 24px rgba(0,0,0,.45);
    display: flex; flex-direction: column;
  }
  .doach-fb-panel.open { transform: translateX(0); }
  .doach-fb-fab.hidden { opacity: 0; pointer-events: none; transform: scale(0.92); }
  .doach-fb-head {
    padding: 12px 16px; display: flex; align-items: center; justify-content: space-between;
    border-bottom: 1px solid rgba(255,255,255,.08);
  }
  .doach-fb-title { font: 600 16px/1 system-ui, -apple-system, Segoe UI, sans-serif; }
  .doach-fb-tabs {
    display: flex; padding: 6px 14px; gap: 8px; border-bottom: 1px solid rgba(255,255,255,.08);
  }
  .doach-fb-tab {
    border: 0; background: rgba(255,255,255,.08); color: #fff;
    padding: 6px 12px; border-radius: 999px; font: 600 13px system-ui;
    cursor: pointer; transition: background .15s;
  }
  .doach-fb-tab.active { background: #2d6cff; }
  .doach-fb-body { flex: 1; overflow: hidden; display: flex; flex-direction: column; }
  .doach-support-view, .doach-logs-view { flex: 1; display: none; overflow: hidden; }
  .doach-support-view.active, .doach-logs-view.active { display: flex; flex-direction: column; }
  .doach-support-thread {
    flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 10px;
  }
  .doach-support-msg {
    max-width: 92%; padding: 10px 14px; border-radius: 14px; font: 14px/1.5 system-ui;
    background: rgba(255,255,255,.08); position: relative; word-break: break-word;
  }
  .doach-support-msg.user { margin-left: auto; background: #2d6cff; color: #fff; }
  .doach-support-msg.doach { background: rgba(26,28,34,.95); border: 1px solid rgba(255,255,255,.08); }
  .doach-support-msg .meta {
    display: block; margin-top: 6px; font: 11px/1 system-ui; opacity: .65;
  }
  .doach-support-quick {
    padding: 10px 16px 0; display: flex; gap: 8px; flex-wrap: wrap;
  }
  .doach-support-chip {
    background: rgba(255,255,255,.08); border: 0; color:#fff;
    border-radius: 999px; padding: 6px 12px; font: 600 12px system-ui;
    cursor: pointer; transition: background .15s;
  }
  .doach-support-chip:hover { background: rgba(255,255,255,.18); }
  .doach-support-input {
    padding: 12px 16px; border-top: 1px solid rgba(255,255,255,.08);
    display: flex; flex-direction: column; gap: 8px;
  }
  .doach-support-input textarea {
    width: 100%; min-height: 72px; border-radius: 10px; border: 1px solid rgba(255,255,255,.12);
    background: rgba(12,13,18,.92); color: #fff; padding: 10px 12px; resize: vertical;
    font: 14px/1.4 system-ui;
  }
  .doach-support-actions {
    display: flex; gap: 8px; justify-content: space-between; align-items: center;
  }
  .doach-support-actions .left {
    display: flex; align-items: center; gap: 10px; font: 12px system-ui;
    color: rgba(255,255,255,.65);
  }
  .doach-support-send {
    background: #2d6cff; color: #fff; border: 0; padding: 8px 18px; border-radius: 999px;
    font: 600 14px system-ui; cursor: pointer; transition: opacity .15s;
  }
  .doach-support-send[disabled] { opacity: .6; cursor: progress; }
  .doach-support-status { font: 12px system-ui; color: rgba(255,255,255,.65); min-height: 16px; }
  .doach-logs-view { padding: 16px; gap: 12px; overflow: hidden; }
  .doach-logs-controls { display: flex; gap: 8px; align-items: center; }
  .doach-logs-box {
    flex: 1; overflow-y: auto; border: 1px solid rgba(255,255,255,.12); border-radius: 10px;
    padding: 10px;
    background: rgba(12,13,18,.92); font: 12px/1.35 ui-monospace, Menlo, Consolas, monospace;
  }
  .doach-log-row { padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,.08); white-space: pre-wrap; }
  .doach-log-row:last-child { border-bottom: 0; }
  .doach-checkbox { display:flex; align-items:center; gap:6px; cursor:pointer; }
  .doach-close-btn {
    border: 0; background: rgba(255,255,255,.1); color: #fff; padding: 6px 10px; border-radius: 8px; cursor: pointer;
  }
  `;
  document.head.appendChild(css);
}

function createPanel() {
  if (panel) return panel;
  ensureSupportCSS();
  loadLogs();
  installGlobalLogCatcher();

  panel = mk('div', { class: 'doach-fb-panel', id: 'doachSupportPanel' });

  const head = mk('div', { class: 'doach-fb-head' },
    mk('div', { class: 'doach-fb-title' }, 'Help & Support'),
    mk('button', { class: 'doach-close-btn', onclick: closeSupportPanel }, 'Close')
  );

  tabs = {
    support: mk('button', { class: 'doach-fb-tab active', dataset: { tab: 'support' } }, 'Support'),
    logs: mk('button', { class: 'doach-fb-tab', dataset: { tab: 'logs' } }, 'Diagnostics'),
  };
  const tabRow = mk('div', { class: 'doach-fb-tabs' }, tabs.support, tabs.logs);
  tabs.support.addEventListener('click', () => showTab('support'));
  tabs.logs.addEventListener('click', () => showTab('logs'));

  const body = mk('div', { class: 'doach-fb-body' });

  // Support view
  const supportView = mk('div', { class: 'doach-support-view active' });
  threadBox = mk('div', { class: 'doach-support-thread', id: 'doachSupportThread' });
  quickRow = mk('div', { class: 'doach-support-quick' });
  renderQuickActions();

  supportStatus = mk('div', { class: 'doach-support-status' });

  supportInput = mk('textarea', { placeholder: "Tell Doach what's going on…" });
  supportSendButton = mk('button', { class: 'doach-support-send' }, 'Send');
  supportSendButton.addEventListener('click', handleSupportSend);
  supportInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      handleSupportSend();
    }
  });

  includeLogsCheckbox = mk('input', { type: 'checkbox', checked: true });
  includeStateCheckbox = mk('input', { type: 'checkbox', checked: true });

  const actionsRow = mk('div', { class: 'doach-support-actions' },
    mk('div', { class: 'left' },
      mk('label', { class: 'doach-checkbox' }, includeLogsCheckbox, 'Attach recent diagnostics'),
      mk('label', { class: 'doach-checkbox' }, includeStateCheckbox, 'Attach session snapshot')
    ),
    supportSendButton
  );

  const inputWrap = mk('div', { class: 'doach-support-input' },
    supportInput,
    actionsRow,
    supportStatus
  );

  supportView.append(threadBox, quickRow, inputWrap);

  // Logs view
  const logsView = mk('div', { class: 'doach-logs-view' });
  logsBox = mk('div', { class: 'doach-logs-box' });
  const logsControls = mk('div', { class: 'doach-logs-controls' },
    mk('button', { class: 'doach-support-send', onclick: () => feedbackStore.clear() }, 'Clear log'),
    mk('button', {
      class: 'doach-close-btn',
      onclick: () => navigator.clipboard?.writeText(logsBox.innerText || '').catch(() => {}),
    }, 'Copy')
  );
  logsView.append(logsControls, logsBox);

  body.append(supportView, logsView);
  panel.append(head, tabRow, body);
  document.body.appendChild(panel);

  renderLogs();
  renderSupportThread();

  window.openSupportPanel = openSupportPanel;
  return panel;
}

function renderQuickActions() {
  if (!quickRow) return;
  quickRow.innerHTML = '';
  SUPPORT_QUICK_ACTIONS.forEach((action) => {
    const btn = mk('button', { class: 'doach-support-chip' }, action.label);
    btn.addEventListener('click', () => {
      const text = typeof action.message === 'function' ? action.message() : action.message;
      if (action.autosend) {
        supportInput.value = text;
        handleSupportSend();
      } else {
        supportInput.value = text;
        supportInput.focus();
      }
    });
    quickRow.append(btn);
  });
}

function showTab(tabName) {
  const supportView = q('.doach-support-view', panel);
  const logsView = q('.doach-logs-view', panel);
  if (!supportView || !logsView) return;

  if (tabName === 'logs') {
    supportView.classList.remove('active');
    logsView.classList.add('active');
    tabs.support.classList.remove('active');
    tabs.logs.classList.add('active');
    renderLogs();
  } else {
    supportView.classList.add('active');
    logsView.classList.remove('active');
    tabs.support.classList.add('active');
    tabs.logs.classList.remove('active');
    renderSupportThread();
  }
}

function renderLogs() {
  if (!logsBox) return;
  logsBox.innerHTML = '';
  const rows = feedbackStore.logs.slice(-LOG_HISTORY_LIMIT);
  if (!rows.length) {
    logsBox.append(mk('div', { class: 'doach-log-row' }, 'No diagnostics captured yet.'));
    return;
  }
  rows.forEach((row) => {
    const t = new Date(row.time).toLocaleTimeString();
    const body = `[${t}] ${row.type}: ${row.message || ''}${row.stack ? '\n' + row.stack : ''}`;
    logsBox.append(mk('div', { class: 'doach-log-row' }, body));
  });
}

function renderSupportThread() {
  if (!threadBox) return;
  threadBox.innerHTML = '';
  if (supportState.loading) {
    threadBox.append(mk('div', { class: 'doach-support-msg doach' }, 'Loading conversation…'));
    return;
  }
  if (supportState.thread.length === 0) {
    threadBox.append(mk('div', { class: 'doach-support-msg doach' }, 'Need a hand? Ask me anything about your session, setup, or account.'));
    return;
  }
  supportState.thread.sort((a, b) => {
    const ta = new Date(a.created_at || a.time || 0).getTime();
    const tb = new Date(b.created_at || b.time || 0).getTime();
    return ta - tb;
  });
  supportState.thread.forEach((msg) => {
    const role = (msg.role || '').toLowerCase();
    const bubble = mk('div', { class: `doach-support-msg ${role === 'user' ? 'user' : 'doach'}` },
      msg.message || '(no message)'
    );
    const metaParts = [];
    if (msg.created_at) metaParts.push(niceTime(msg.created_at));
    if (msg.result_status && msg.result_status !== 'resolved') {
      metaParts.push(msg.result_status.replace(/_/g, ' '));
    }
    if (msg.related_ticket_id) metaParts.push(`ticket #${msg.related_ticket_id}`);
    if (metaParts.length) bubble.append(mk('span', { class: 'meta' }, metaParts.join(' · ')));
    threadBox.append(bubble);
  });
  threadBox.scrollTop = threadBox.scrollHeight;
}

function addOrUpdateMessages(list) {
  if (!Array.isArray(list)) return;
  const index = new Map(supportState.thread.map((m) => [m.id, m]));
  let dirty = false;
  list.forEach((msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.id && index.has(msg.id)) {
      Object.assign(index.get(msg.id), msg);
      dirty = true;
    } else {
      supportState.thread.push(msg);
      dirty = true;
    }
  });
  if (dirty) renderSupportThread();
}

async function loadSupportHistory(force = false) {
  if (supportState.loading || (supportState.loaded && !force)) return;
  try {
    supportState.loading = true;
    renderSupportThread();
    const params = new URLSearchParams();
    params.set('limit', String(SUPPORT_MAX_LIMIT));
    const sid = getActiveSessionId();
    if (sid) params.set('session_id', sid);
    const res = await fetch(`/api/support/history?${params.toString()}`, { credentials: 'include' });
    if (res.status === 401) {
      supportState.thread = [];
      supportState.loaded = true;
      supportState.lastLoadError = 'unauthorized';
      return;
    }
    if (!res.ok) {
      supportState.lastLoadError = `http-${res.status}`;
      return;
    }
    const data = await res.json();
    supportState.thread = Array.isArray(data?.interactions) ? data.interactions : [];
    supportState.loaded = true;
    supportState.lastLoadError = null;
  } catch (err) {
    if (supportState.lastLoadError !== 'unauthorized') {
      console.error('[support] history error', err);
    }
    supportState.lastLoadError = err?.message || String(err);
  } finally {
    supportState.loading = false;
    renderSupportThread();
  }
}

async function handleSupportSend() {
  const text = (supportInput.value || '').trim();
  if (!text || supportState.sending) return;
  const attachLogs = includeLogsCheckbox?.checked;
  const attachState = includeStateCheckbox?.checked;

  supportState.sending = true;
  supportSendButton.disabled = true;
  supportStatus.textContent = 'Sending…';
  try {
    const payload = {
      message: text,
      session_id: getActiveSessionId(),
      shot_id: getLikelyShotId(),
    };
    if (attachLogs) payload.meta = { logs: feedbackStore.logs.slice(-12) };
    if (attachState) {
      try {
        payload.action_taken = {
          snapshot: {
            shots: (window.__shotList || []).slice(-12),
            totals: (window.__shotList || []).length,
            prefs: window.doachGetPrefs?.(),
          },
        };
      } catch {}
    }
    const res = await fetch('/api/support/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`Support request failed (${res.status})`);
    const data = await res.json();
    const messagesToAdd = [];
    if (data?.interaction) messagesToAdd.push(data.interaction);
    if (data?.response) messagesToAdd.push(data.response);
    addOrUpdateMessages(messagesToAdd);
    if (data?.handler?.result_status) {
      supportStatus.textContent = `Status: ${data.handler.result_status.replace(/_/g, ' ')}`;
    } else {
      supportStatus.textContent = 'Sent.';
    }
    supportInput.value = '';
  } catch (err) {
    console.error('[support] send failed', err);
    supportStatus.textContent = 'Failed to send. Try again in a moment.';
  } finally {
    supportState.sending = false;
    supportSendButton.disabled = false;
    setTimeout(() => { supportStatus.textContent = ''; }, 4000);
  }
}

// --------------------------------------------------------------------------- //
//  Public entrypoint
// --------------------------------------------------------------------------- //

export function installFeedbackWidget() {
  if (window.__DOACH_SUPPORT_WIDGET_READY) return;
  const root = createPanel();
  fabButton = mk('button', { class: 'doach-fb-fab', title: 'Help & Support' }, '💬');
  fabButton.addEventListener('click', () => openSupportPanel());
  document.body.appendChild(fabButton);
  window.__DOACH_SUPPORT_WIDGET_READY = true;

  // attempt to hydrate history quietly in the background
  setTimeout(() => loadSupportHistory(), 1200);
}

function openSupportPanel() {
  const root = createPanel();
  root.classList.add('open');
  if (fabButton) fabButton.classList.add('hidden');
  renderLogs();
  loadSupportHistory();
  supportInput?.focus();
}

function closeSupportPanel() {
  if (!panel) return;
  panel.classList.remove('open');
  if (fabButton) fabButton.classList.remove('hidden');
}

if (typeof window !== 'undefined') {
  window.installFeedbackWidget = installFeedbackWidget;
  window.openSupportPanel = openSupportPanel;
}
