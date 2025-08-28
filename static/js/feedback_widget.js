// feedback_widget.js — Floating crash catcher + user feedback sender

// tiny DOM helper (local to this file)
function el(tag, attrs={}, ...kids){
  const d = document.createElement(tag);
  Object.entries(attrs||{}).forEach(([k,v])=>{
    if (k==='style' && typeof v==='object') Object.assign(d.style, v);
    else if (k.startsWith('on') && typeof v==='function') d.addEventListener(k.slice(2), v);
    else if (v!=null) d.setAttribute(k, v);
  });
  kids.flat().forEach(k => d.append(k instanceof Node ? k : document.createTextNode(String(k))));
  return d;
}


(function injectFeedbackCSS(){
  if (document.getElementById('doach-feedback-css')) return;
  const css = document.createElement('style');
  css.id = 'doach-feedback-css';
  css.textContent = `
  .doach-fb-fab {
    position:fixed; right:16px; bottom:16px; z-index:10060;
    width:44px; height:44px; border-radius:50%;
    display:flex; align-items:center; justify-content:center;
    background:#2d6cff; color:#fff; font-size:20px; border:0; cursor:pointer;
    box-shadow:0 8px 20px rgba(0,0,0,.35);
  }
  .doach-fb-panel {
    position:fixed; right:0; top:0; bottom:0; width:440px; z-index:10055;
    background:rgba(16,16,20,.98); color:#fff; transform:translateX(110%); transition:transform .22s;
    border-left:1px solid rgba(255,255,255,.12); box-shadow:-8px 0 28px rgba(0,0,0,.35);
  }
  .doach-fb-panel.open{ transform:translateX(0); }
  .doach-fb-head {
    display:flex; align-items:center; justify-content:space-between; padding:10px 12px;
    border-bottom:1px solid rgba(255,255,255,.12); font:600 14px system-ui;
  }
  .doach-fb-body { padding:12px; overflow:auto; height: calc(100% - 48px); }
  .doach-fb-text { width:100%; height:120px; border-radius:8px; padding:8px 10px; border:1px solid rgba(255,255,255,.15); background:#0f1014; color:#fff; }
  .doach-fb-email { width:100%; border-radius:8px; padding:8px 10px; border:1px solid rgba(255,255,255,.15); background:#0f1014; color:#fff; }
  .doach-fb-logs { border:1px solid rgba(255,255,255,.12); border-radius:8px; overflow:hidden; }
  .doach-fb-logrow { padding:8px 10px; border-bottom:1px solid rgba(255,255,255,.08); font:12px/1.3 ui-monospace, Menlo, monospace; white-space:pre-wrap; }
  .doach-fb-logrow:last-child{ border-bottom:none; }
  .doach-fb-btn { background:#2d6cff; color:#fff; border:0; padding:8px 10px; border-radius:8px; cursor:pointer; font-weight:600; }
  .doach-fb-btn.ghost { background:transparent; border:1px solid rgba(255,255,255,.22); }
  .doach-fb-row { display:flex; gap:8px; flex-wrap:wrap; }
  `;
  document.head.appendChild(css);
})();

const FB_MAX = 60;
const feedbackStore = {
  logs: [],
  push(e){ this.logs.push(e); if (this.logs.length>FB_MAX) this.logs = this.logs.slice(-FB_MAX); saveLocal(); renderLogs(); },
  clear(){ this.logs = []; saveLocal(); renderLogs(); }
};

function saveLocal(){ try{ localStorage.setItem('doachFeedbackLogs', JSON.stringify(feedbackStore.logs)); }catch{} }
function loadLocal(){ try{ const a=JSON.parse(localStorage.getItem('doachFeedbackLogs')||'[]'); if(Array.isArray(a)) feedbackStore.logs=a; }catch{} }

// Capture errors
function installGlobalCatcher(){
  window.addEventListener('error', (ev)=>{
    const data = {
      type:'error', time: Date.now(),
      message: ev?.error?.message || ev.message || 'Error',
      stack: ev?.error?.stack || null,
      source: ev?.filename, line: ev?.lineno, col: ev?.colno
    };
    feedbackStore.push(data);
  });
  window.addEventListener('unhandledrejection', (ev)=>{
    const r = ev?.reason;
    const data = {
      type:'unhandledrejection', time: Date.now(),
      message: (r && (r.message||r.toString())) || 'Unhandled rejection',
      stack: r?.stack || null
    };
    feedbackStore.push(data);
  });
  // Optional: capture console.error
  const origErr = console.error;
  console.error = function(...args){
    try { feedbackStore.push({ type:'console.error', time: Date.now(), message: args.map(a=>typeof a==='string'?a:JSON.stringify(a)).join(' ') }); } catch {}
    origErr.apply(console, args);
  };
  // public API for app code
  window.reportClientEvent = (label, data)=> feedbackStore.push({ type:'event', time: Date.now(), message: label, data });
}

// UI
let panel, logsBox, msgInput, emailInput, includeLogsChk, includeStateChk, sending=false;

function makePanel(){
  if (panel) return panel;
  panel = document.createElement('div'); panel.className='doach-fb-panel';

  const head = document.createElement('div'); head.className='doach-fb-head';
  head.innerHTML = `<div>Feedback & Error Log</div>`;
  const closeBtn = document.createElement('button'); closeBtn.className='doach-fb-btn ghost'; closeBtn.textContent='Close';
  closeBtn.onclick = ()=> panel.classList.remove('open');
  head.appendChild(closeBtn);

  const body = document.createElement('div'); body.className='doach-fb-body';

  msgInput = document.createElement('textarea'); msgInput.className='doach-fb-text'; msgInput.placeholder='What happened? Suggestions welcome.';
  emailInput = document.createElement('input'); emailInput.className='doach-fb-email'; emailInput.placeholder='Email (optional for follow-up)';

  includeLogsChk  = document.createElement('input'); includeLogsChk.type='checkbox'; includeLogsChk.checked=true;
  includeStateChk = document.createElement('input'); includeStateChk.type='checkbox'; includeStateChk.checked=true;

  const toggles = el('div', {class:'doach-fb-row'},
    el('label', {}, includeLogsChk, ' Include recent errors'),
    el('label', {}, includeStateChk, ' Include session stats')
  );

  logsBox = document.createElement('div'); logsBox.className='doach-fb-logs';

  const btnRow = el('div', {class:'doach-fb-row'},
    el('button', {class:'doach-fb-btn', onclick:send}, 'Send'),
    el('button', {class:'doach-fb-btn ghost', onclick:()=>{ feedbackStore.clear(); }}, 'Clear Log')
  );

  body.append(
    el('div', {class:'doach-field'}, el('label', {}, 'Message'), msgInput),
    el('div', {class:'doach-field'}, el('label', {}, 'Contact'), emailInput),
    toggles,
    el('div', {class:'doach-field'}, el('label', {}, 'Recent Errors'), logsBox),
    btnRow
  );

  panel.append(head, body);
  document.body.appendChild(panel);
  return panel;

  function el(tag, attrs={}, ...kids){
    const d = document.createElement(tag);
    Object.entries(attrs||{}).forEach(([k,v])=>{
      if (k==='class') d.className=v;
      else if (k.startsWith('on') && typeof v==='function') d.addEventListener(k.slice(2), v);
      else d.setAttribute(k,v);
    });
    kids.forEach(k=> d.append(k instanceof Node?k:document.createTextNode(k)));
    return d;
  }
}

function renderLogs(){
  if (!logsBox) return;
  logsBox.innerHTML='';
  const rows = feedbackStore.logs.slice(-40); // last 40
  if (!rows.length) { logsBox.append(el('div',{class:'doach-fb-logrow'}, 'No errors captured yet.')); return; }
  rows.forEach(r=>{
    const t = new Date(r.time).toLocaleTimeString();
    const text = `[${t}] ${r.type}: ${r.message || ''}${r.stack?'\n'+r.stack:''}`;
    const row = document.createElement('div'); row.className='doach-fb-logrow'; row.textContent = text;
    logsBox.append(row);
  });
}

async function send(){
  if (sending) return;
  sending = true;
  const payload = {
    message: (msgInput.value||'').trim(),
    email: (emailInput.value||'').trim(),
    userAgent: navigator.userAgent,
    time: Date.now()
  };
  if (includeLogsChk.checked) payload.logs = feedbackStore.logs.slice(-40);
  if (includeStateChk.checked) {
    try {
      payload.session = {
        shotList: (window.__shotList||[]).slice(-12),
        accuracy: (()=>{ const a = window.__shotList||[]; const m=a.filter(s=>s.made).length; return a.length? Math.round(100*m/a.length):0; })(),
        prefs: window.doachGetPrefs?.()
      };
    } catch {}
  }

  try {
    const r = await fetch('/api/feedback', { 
      method: 'POST', 
      headers: {'Content-Type': 'application/json'}, 
      body: JSON.stringify(payload) 
    });
    if (!r.ok) {
      throw new Error(`Failed to submit feedback: ${r.status} ${await r.text()}`);
    }
    msgInput.value = '';
  } catch (err) {
    console.error('Feedback submission failed:', err);
    // queue locally if offline
    try {
      const q = JSON.parse(localStorage.getItem('doachFeedbackQueue')||'[]');
      q.push(payload); localStorage.setItem('doachFeedbackQueue', JSON.stringify(q));
      alert('Saved locally (offline). We will retry later.');
    } catch {}
  } finally {
    sending = false;
  }
}

export function installFeedbackWidget(){
  loadLocal(); installGlobalCatcher(); makePanel(); renderLogs();
  const fab = document.createElement('button'); fab.className='doach-fb-fab'; fab.title='Feedback / Errors';
  fab.textContent = '💬'; fab.onclick = ()=> { panel.classList.add('open'); renderLogs(); };
  document.body.appendChild(fab);

  // Optional: retry queued feedback on load
  setTimeout(async ()=>{
    try {
      const q = JSON.parse(localStorage.getItem('doachFeedbackQueue')||'[]'); if (!q.length) return;
      const rest = [];
        for (const p of q) {
          try {
            const r = await fetch('/api/feedback', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(p)
            });
            if (!r.ok) throw new Error('Failed to send feedback');
          } catch { rest.push(p); }
        }
        localStorage.setItem('doachFeedbackQueue', JSON.stringify(rest));
      } catch {} 
    }, 2000);
  }
  
