// /static/js/ui_menu.js
// Hamburger menu + slideouts + floating MyDoach button
// DOES NOT TOUCH VIDEO LOADING. Uses #videoInput and handleVideoUpload in app.js.

(function () {
  // Prevent double init if the script is included twice (or with different query strings)
  if (window.__DOACH_MENU_INIT__) return;
  window.__DOACH_MENU_INIT__ = true;

  // Minimal global prompt fallback for early pages (top-center banner)
  if (typeof window.showPrompt !== 'function') {
    window.showPrompt = function (text, duration = 3000) {
      try {
        let el = document.getElementById('promptBar') || document.getElementById('overlayPrompt');
        if (!el) {
          el = document.createElement('div');
          el.id = 'promptBar';
          document.body.appendChild(el);
        }
        Object.assign(el.style, {
          position: 'fixed', top: '12px', left: '50%', transform: 'translateX(-50%)',
          background: 'rgba(0,0,0,0.78)', color: '#fff', padding: '10px 14px',
          borderRadius: '10px', font: '600 14px system-ui, sans-serif',
          zIndex: 10060, pointerEvents: 'none', display: 'block', opacity: '1'
        });
        el.textContent = String(text || '');
        if (el.__t) clearTimeout(el.__t);
        el.__t = setTimeout(() => { try { el.style.opacity = '0'; setTimeout(() => (el.style.display = 'none'), 250); } catch {} }, duration);
      } catch {}
    };
  }

  // Prefer the user's configured voice for coachSpeak by default
  if (typeof window.coachSpeak !== 'function') {
    window.coachSpeak = function (text) {
      if (!text) return;
      if (typeof window.doachSpeak === 'function') { try { return window.doachSpeak(text); } catch {} }
      try { const u = new SpeechSynthesisUtterance(String(text)); window.speechSynthesis?.speak(u); } catch {}
    };
  }

  // Center CTA: Start Doach Session button
  function showStartSessionCTA() {
    try {
      if (document.getElementById('startDoachCTA')) return;
      // Do not show if camera already active
      const v = document.getElementById('videoPlayer');
      if (v?.srcObject) return;
      const cta = document.createElement('button');
      cta.id = 'startDoachCTA';
      cta.textContent = 'Start Doach Session';
      Object.assign(cta.style, {
        position:'fixed', left:'50%', top:'50%', transform:'translate(-50%,-50%)',
        zIndex:10070, padding:'16px 22px', borderRadius:'12px', border:'1px solid rgba(255,255,255,.25)',
        font:'700 20px system-ui, -apple-system, Segoe UI, Arial', cursor:'pointer',
        color:'#fff', background:'rgba(0,0,0,.78)', boxShadow:'0 8px 28px rgba(0,0,0,.35)'
      });
      cta.onclick = () => {
        try { (document.getElementById('contentUseCamBtn')?.click()) ?? window.useCamera?.(); } catch {}
        try { cta.remove(); } catch {}
      };
      document.body.appendChild(cta);
      // Remove when camera plays
      const onPlay = () => { try { cta.remove(); } catch {}; try { v?.removeEventListener('playing', onPlay); } catch {} };
      try { (document.getElementById('videoPlayer')||document.querySelector('video'))?.addEventListener('playing', onPlay); } catch {}
    } catch {}
  }
  window.showStartSessionCTA = showStartSessionCTA;

  // ---------- Styles ----------
  if (!document.getElementById('ui-menu-css')) {
    const css = document.createElement('style');
    css.id = 'ui-menu-css';
    css.textContent = `
      .doach-hamburger {
        position: fixed; top: 12px; left: 12px; z-index: 10050;
        width: 38px; height: 38px; border-radius: 8px;
        display:flex; align-items:center; justify-content:center;
        background: rgba(0,0,0,.75); color:#fff; border:1px solid rgba(255,255,255,.15);
        cursor:pointer; user-select:none;
      }
      .doach-hamburger:hover { background: rgba(0,0,0,.88); }
      .doach-drawer {
        position: fixed; top:0; bottom:0; left:0; width: 300px; z-index:10040;
        background: rgba(12,12,14,.98); color:#fff; border-right:1px solid rgba(255,255,255,.12);
        transform: translateX(-110%); transition: transform .22s ease-out; padding: 12px;
        box-shadow: 0 10px 30px rgba(0,0,0,.35);
      }
      .doach-drawer.open { transform: translateX(0); }
      .doach-drawer h3 { margin: 4px 10px 10px; font: 600 14px/1.2 system-ui; opacity:.9; letter-spacing:.04em; }
      .doach-menu { list-style:none; margin:0; padding:0; }
      .doach-menu > li { margin: 4px 0; }
      .doach-item {
        width:100%; text-align:left; background:transparent; border:0; color:#fff;
        padding:10px 12px; border-radius:8px; cursor:pointer; font:600 14px system-ui;
      }
      .doach-submenu { list-style:none; margin:4px 0 0 16px; padding:0; display:flex; flex-direction:column; gap:4px; }
      .doach-subitem { background:transparent; border:0; color:#cfd8e3; padding:6px 12px; border-radius:8px; font:500 12px system-ui; text-align:left; cursor:pointer; }
      .doach-subitem:hover { background:rgba(255,255,255,.08); }
      .doach-item:hover { background:rgba(255,255,255,.08); }
      .doach-sidepanel {
        position: fixed; top:0; right:0; bottom:0; width:420px; z-index:10045;
        background: rgba(14,14,18,.98); color:#fff; transform: translateX(110%);
        transition: transform .22s ease-out; border-left:1px solid rgba(255,255,255,.12);
        box-shadow: -8px 0 28px rgba(0,0,0,.35);
      }
      .doach-sidepanel.open { transform: translateX(0); }
      .doach-panel-head { display:flex; align-items:center; justify-content:space-between; padding:10px 12px; border-bottom:1px solid rgba(255,255,255,.12); font: 600 14px system-ui; }
      .doach-panel-body { padding:12px; overflow:auto; height: calc(100% - 48px); }
      .doach-field { margin:10px 0; }
      .doach-field label { display:block; font:600 12px system-ui; opacity:.8; margin-bottom:4px; }
      .doach-field input[type="text"], .doach-field input[type="number"], .doach-field select {
        width:100%; padding:8px 10px; border-radius:8px; border:1px solid rgba(255,255,255,.15);
        background:#101015; color:#fff;
      }
      .doach-range { width:100%; }
      .doach-row { display:flex; gap:10px; }
      .doach-row .col { flex:1; }
      .doach-btn { background:#2d6cff; color:#fff; border:0; padding:8px 10px; border-radius:8px; cursor:pointer; font-weight:600; }
      .doach-btn.ghost { background:transparent; border:1px solid rgba(255,255,255,.22); }
      .doach-actions { display:flex; gap:8px; flex-wrap:wrap; }
      .doach-list { border:1px solid rgba(255,255,255,.12); border-radius:8px; overflow:hidden; }
      .doach-list-item { padding:8px 10px; border-bottom:1px solid rgba(255,255,255,.08); display:flex; align-items:center; justify-content:space-between;}
      .doach-list-item:last-child { border-bottom:none; }
      .doach-floating-mydoach {
        position: fixed; right: 16px; bottom: 88px; z-index: 10050;
        background: rgba(0,0,0,.78); color:#fff; border:1px solid rgba(255,255,255,.15);
        padding:10px 12px; border-radius: 999px; cursor:pointer; font:600 13px system-ui;
      }
      .doach-floating-mydoach:hover { background: rgba(0,0,0,.9); }
      .challenge-overlay {
        position:fixed; inset:0; z-index:10100; background:rgba(6,8,12,.82);
        display:none; align-items:center; justify-content:center; padding:24px;
      }
      .challenge-overlay.open { display:flex; animation:challengeFade .22s ease-out both; }
      .challenge-frame {
        width:min(960px,95vw); max-height:90vh; display:flex; flex-direction:column;
        background:rgba(10,12,18,.96); border:1px solid rgba(255,255,255,.12);
        border-radius:14px; box-shadow:0 26px 80px rgba(0,0,0,.65);
      }
      .challenge-header { display:flex; align-items:center; justify-content:space-between; padding:14px 16px; border-bottom:1px solid rgba(255,255,255,.12); font:600 15px system-ui; }
      .challenge-close { background:transparent; border:1px solid rgba(255,255,255,.18); color:#cfd8e3; padding:6px 10px; border-radius:8px; cursor:pointer; font:600 12px system-ui; }
      .challenge-close:hover { background:rgba(255,255,255,.08); }
      .challenge-scroll { flex:1; overflow:auto; padding:16px; display:flex; flex-direction:column; gap:12px; }
      .challenge-note { font:500 12px system-ui; opacity:.72; }
      .challenge-grid { display:flex; flex-direction:column; gap:8px; }
      .challenge-table { width:100%; border-collapse:collapse; font:600 13px/1.35 system-ui; }
      .challenge-table th { text-align:left; padding:6px 8px; border-bottom:1px solid rgba(255,255,255,.2); font-weight:600; font-size:12px; }
      .challenge-table td { padding:6px 8px; border-bottom:1px solid rgba(255,255,255,.08); font-weight:500; }
      @keyframes challengeFade { from { opacity:0; transform:translateY(12px); } to { opacity:1; transform:translateY(0); } }
    `;
    document.head.appendChild(css);
  }

  // ---------- helpers ----------
  const __panels = new Set();

  // ——— Close drawer + any open sidepanels ———
  let __drawer = null;
  function closeAllMenus(reason='') {
    __panels.forEach(p => p.openClose?.());
    if (__drawer) __drawer.classList.remove('open');
  }

  // ——— Auto-close menu when the video becomes ready ———
  let __doachAutoCloseWired = false;
  function wireVideoAutoClose() {
    const video = getVideoEl();
    if (!video) return;

    // don't double-wire
    if (__doachAutoCloseWired) return;
    __doachAutoCloseWired = true;

    const READY = HTMLMediaElement.HAVE_CURRENT_DATA;

    const cleanup = () => {
      ['loadedmetadata','loadeddata','canplay','playing'].forEach(ev => {
        try { video.removeEventListener(ev, onReady, opts); } catch {}
      });
      try { obs.disconnect(); } catch {}
    };

    const closeNow = (reason) => {
      closeAllMenus(reason);
      cleanup();
      __doachAutoCloseWired = false; // allow future re-wire after src change
    };

    const onReady = () => closeNow('video-ready');

    const opts = { once: true };
    ['loadedmetadata','loadeddata','canplay','playing'].forEach(ev => {
      video.addEventListener(ev, onReady, opts);
    });

    // If menu mounted after video was already ready, close immediately.
    if (video.readyState >= READY) {
      Promise.resolve().then(() => closeNow('video-already-ready'));
    }

    // Re-arm on src/srcObject change (file picker, programmatic loads)
    const obs = new MutationObserver(() => {
      cleanup();
      __doachAutoCloseWired = false;
      setTimeout(wireVideoAutoClose, 0); // attach to the next load cycle
    });
    obs.observe(video, { attributes: true, attributeFilter: ['src', 'srcObject'] });
  }

  // ——— Find the video element the app uses ———
  function getVideoEl(){
    return document.getElementById('videoPlayer') || document.querySelector('video');
  }

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
  function closeOnEsc(node, closeFn){
    const onKey = (e)=>{ if (e.key==='Escape') closeFn(); };
    node.__esc = onKey; window.addEventListener('keydown', onKey);
    node.__unesc = ()=> window.removeEventListener('keydown', onKey);
  }
  function makeSidePanel(title){
    const panel = el('div', {class:'doach-sidepanel', role:'dialog', 'aria-label':title});
    const head = el('div', {class:'doach-panel-head'},
      el('div', {}, title),
      el('button', {class:'doach-btn ghost', onclick:()=>{ panel.classList.remove('open'); panel.__unesc?.(); }}, 'Close')
    );
    const body = el('div', {class:'doach-panel-body'});
    panel.append(head, body);
    document.body.appendChild(panel);
    panel.open = ()=>{ panel.classList.add('open'); closeOnEsc(panel, panel.openClose); };
    panel.openClose = ()=>{ panel.classList.remove('open'); panel.__unesc?.(); };
    panel.setBody = (n)=>{ body.innerHTML=''; body.append(n); };
    __panels.add(panel);
    window.__makeSidePanel = makeSidePanel;
    return panel;
  }

  function attachChallengeStartHandlers(btn, slug, eventName, onComplete) {
    if (!btn || !slug) return;
    if (btn.__challengeHandler) btn.removeEventListener('click', btn.__challengeHandler);
    const prettyName = eventName || slug;
    const handler = () => {
      try { console.debug('[challenge-btn] click', { slug, eventName: prettyName }); } catch {}
      if (typeof window.startChallengeSession !== 'function') {
        window.showPrompt?.('Session manager not ready yet.');
        return;
      }
      const msg = `The ${prettyName} session can be completed 1x per day. Are you ready to start today's challenge session?`;
      if (!window.confirm(msg)) return;
      btn.disabled = true;
      const cleanup = (cb) => {
        btn.disabled = false;
        window.removeEventListener('challenge:session-started', onStarted);
        window.removeEventListener('challenge:session-start-error', onError);
        if (typeof cb === 'function') cb();
      };
      const onStarted = (e) => {
        if (!e?.detail || e.detail.slug !== slug) return;
        cleanup(() => {
          try { window.showPrompt?.('Challenge session started! Good luck.'); } catch {}
          try { onComplete?.(true, e.detail); } catch {}
        });
      };
      const onError = (e) => {
        if (!e?.detail || e.detail.slug !== slug) return;
        cleanup(() => {
          try { onComplete?.(false, e.detail); } catch {}
          const err = e.detail?.error;
          window.showPrompt?.((err && err.message) || err || 'Unable to start session.');
        });
      };
      window.addEventListener('challenge:session-started', onStarted);
      window.addEventListener('challenge:session-start-error', onError);
      try {
        window.startChallengeSession(slug);
      } catch (err) {
        cleanup();
        window.showPrompt?.((err && err.message) || err || 'Unable to start session.');
      }
    };
    btn.__challengeHandler = handler;
    btn.addEventListener('click', handler);
  }

  function formatChallengeDate(iso) {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
    catch { return String(iso); }
  }

  function challengeAction(ctx) {
    if (!ctx || !ctx.status) return { visible: false };
    const status = ctx.status;
    const eventName = (ctx.event && (ctx.event.name || ctx.event.slug)) || ctx.slug;
    const label = `Start Today’s ${eventName} Session`;
    const action = { visible: true, eventName, label, enabled: true, reason: '' };
    if (!status.registered) {
      action.visible = false;
      return action;
    } else if (status.window_state === 'upcoming') {
      action.enabled = false;
      action.reason = status.event_start ? `Opens on ${formatChallengeDate(status.event_start)}.` : 'Challenge opens soon.';
    } else if (status.window_state === 'closed') {
      action.enabled = false;
      action.reason = 'Challenge has ended.';
    } else if (!status.can_start) {
      action.enabled = false;
      if (status.today_submitted) action.reason = 'You already submitted today.';
      else if (status.today_started) action.reason = 'Session already in progress.';
      else action.reason = 'Daily limit reached. Come back tomorrow.';
    }
    return action;
  }

  function configureChallengeButton(btn, ctx, onSuccess) {
    if (!btn) return { visible: false };
    const action = challengeAction(ctx);
    try { console.debug('[challenge-config]', { ctx, action }); } catch {}
    if (!action.visible) {
      btn.style.display = 'none';
      if (btn.__challengeHandler) {
        btn.removeEventListener('click', btn.__challengeHandler);
        btn.__challengeHandler = null;
      }
      return action;
    }
    btn.style.display = 'inline-flex';
    btn.textContent = action.label;
    btn.title = action.reason || '';
    if (action.enabled) {
      btn.disabled = false;
      attachChallengeStartHandlers(btn, ctx.slug, action.eventName, onSuccess);
    } else {
      btn.disabled = false;
      if (btn.__challengeHandler) {
        btn.removeEventListener('click', btn.__challengeHandler);
        btn.__challengeHandler = null;
      }
      const reason = action.reason || 'Challenge session unavailable right now.';
      const handler = () => {
        window.showPrompt?.(reason);
      };
      btn.__challengeHandler = handler;
      btn.addEventListener('click', handler);
    }
    return action;
  }

  function syncChallengeCTA() {
    const btn = document.getElementById('btnStartChallenge');
    const note = document.getElementById('challengeBtnNote');
    if (!btn) return;
    const ctx = window.__challengeState;
    const action = configureChallengeButton(btn, ctx, () => {
      setTimeout(() => refreshChallengeState(ctx.slug), 300);
    });
    if (note) {
      if (action && action.visible && !action.enabled && action.reason) {
        note.textContent = action.reason;
        note.style.display = 'block';
      } else {
        note.textContent = '';
        note.style.display = 'none';
      }
    }
    if (!action || !action.visible) {
      if (note) note.style.display = 'none';
    }
  }

  async function refreshChallengeState(slug) {
    if (!slug) {
      window.__challengeState = null;
      syncChallengeCTA();
      return;
    }
    try {
      const res = await fetch(`/api/events/${encodeURIComponent(slug)}/status`, { credentials: 'include' });
      if (res.status === 401) {
        window.__challengeState = null;
        syncChallengeCTA();
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        window.__challengeState = null;
      } else {
        const evt = (window.__challengeEvents || {})[slug];
        window.__challengeState = { slug, event: evt, status: data };
      }
    } catch {
      window.__challengeState = null;
    }
    syncChallengeCTA();
  }

  async function prefetchChallengeState() {
    try {
      const res = await fetch('/api/events', { credentials: 'include' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok || !Array.isArray(data.events)) {
        window.__challengeState = null;
        syncChallengeCTA();
        return;
      }
      window.__challengeEvents = window.__challengeEvents || {};
      for (const ev of data.events) {
        window.__challengeEvents[ev.slug] = ev;
      }
      for (const ev of data.events) {
        await refreshChallengeState(ev.slug);
        if (window.__challengeState && window.__challengeState.status && window.__challengeState.status.registered) {
          return;
        }
      }
    } catch {
      window.__challengeState = null;
      syncChallengeCTA();
    }
  }

  window.syncChallengeCTA = syncChallengeCTA;
  window.__challengeEvents = window.__challengeEvents || {};
  window.__challengeState = window.__challengeState || null;
  window.prefetchChallengeState = prefetchChallengeState;


  // ---------- Panels ----------
async function openDiagnosticsPanel(){
  const panel = (openDiagnosticsPanel.panel ||= makeSidePanel('Coach Diagnostics'));
  const body  = document.createElement('div');
  body.style.padding = '6px';

  function row(label, btns){
    const d = document.createElement('div'); d.style.cssText='display:flex;justify-content:space-between;align-items:center;margin:8px 0;gap:8px;';
    const l = document.createElement('div'); l.textContent = label; l.style.opacity='.9';
    const r = document.createElement('div'); btns.forEach(b => r.appendChild(b));
    d.append(l,r); return d;
  }
  function mk(label, onclick){ const b=document.createElement('button'); b.className='doach-btn'; b.textContent=label; b.onclick=onclick; return b; }
  function log(text){ const p=document.createElement('pre'); p.textContent=text; p.style.maxHeight='200px'; p.style.overflow='auto'; p.style.background='#0b0f14'; p.style.border='1px solid #1f2a36'; p.style.borderRadius='8px'; p.style.padding='6px'; return p; }

  const out = document.createElement('div');
  out.appendChild(log('Diagnostics ready.'));

  const dumpBtn = mk('Dump Pose', async ()=>{
    try { const d = (typeof window.dumpPoseData==='function') ? window.dumpPoseData() : null; out.appendChild(log(JSON.stringify(d,null,2))); } catch(e){ out.appendChild(log('dump error: '+(e.message||e))); }
  });
  const testBtn = mk('Test AI', async ()=>{
    try {
      let snap = (typeof window.__getPoseSnapshot==='function') ? window.__getPoseSnapshot() : null;
      if (!snap && typeof window.__samplePoseSnapshotNow==='function') snap = await window.__samplePoseSnapshotNow();
      if (!snap) { out.appendChild(log('No snapshot available')); return; }
      const body = { prompt: 'You are a concise basketball shooting coach. Using only these metrics, give 1-3 specific release cues (no fluff). Metrics: '+JSON.stringify(snap), model:(window.DOACH&&window.DOACH.model)||'gpt-4o-mini', lang:'en-US', shot:snap, profile:(localStorage.getItem('doachProfile')||'') };
      const r = await fetch('/api/coach', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
      const j = await r.json(); out.appendChild(log(JSON.stringify(j,null,2))); if (j?.text) (window.doachSpeak||window.coachSpeak||console.log)(j.text);
    } catch(e){ out.appendChild(log('AI test error: '+(e.message||e))); }
  });
  const traceBtn = mk('Toggle Trace', ()=>{ window.DOACH_RELEASE_TRACE = !window.DOACH_RELEASE_TRACE; out.appendChild(log('Trace: '+window.DOACH_RELEASE_TRACE)); });
  const startObs = mk('Start Observe', ()=>{ try { window.startObserverStreaming?.(2); out.appendChild(log('Observe start')); } catch(e){ out.appendChild(log('Observe start error: '+(e.message||e))); } });
  const stopObs  = mk('Stop Observe', ()=>{ try { window.stopObserverStreaming?.(); out.appendChild(log('Observe stop')); } catch(e){ out.appendChild(log('Observe stop error: '+(e.message||e))); } });

  body.append(
    row('Pose', [dumpBtn]),
    row('AI',   [testBtn, traceBtn]),
    row('Observe', [startObs, stopObs]),
    document.createElement('hr'), out
  );

  panel.setBody(body); panel.open();
}
async function openContentPanel(){
  const panel = (openContentPanel.panel ||= makeSidePanel('Content'));
  const body  = el('div');

  // Fetch recent list (server first, then local)
  let vidList = [];
  try {
    const r = await fetch('/videos', { cache: 'no-store' });
    if (r.ok) {
      const j = await r.json();
      if (Array.isArray(j.videos)) vidList = j.videos;
    }
  } catch {}
  if (!vidList.length) {
    try {
      const loc = JSON.parse(localStorage.getItem('doachVideos') || '[]');
      if (Array.isArray(loc)) vidList = loc;
    } catch {}
  }

  // helpers
  function triggerFilePicker(){
    const input = document.getElementById('videoInput');
    if (!input) { alert('Upload control not found on this page.'); return; }
    __panels?.forEach?.(p => p.openClose?.());
    input.click();
  }
  function loadViaURL(u){
    if (!u) return alert('No URL for this item.');
    window.dispatchEvent(new CustomEvent('content:url-picked', { detail: { url: u } }));
    __panels?.forEach?.(p => p.openClose?.());
  }

  // render recent list
  const list = el('div', { class:'doach-list' },
    ...(vidList.length ? vidList.map(v =>
      el('div', { class:'doach-list-item' },
        el('div', {}, v.name || v.filename || 'Untitled'),
        el('div', {},
          el('button', { class:'doach-btn ghost', onclick:()=>loadViaURL(v.url||v.path) }, 'Use URL')
        )
      )
    ) : [ el('div', { class:'doach-list-item' }, 'No saved videos yet') ])
  );

  body.append(
    el('div', { class:'doach-field' }, el('label', {}, 'Recent'), list),
    el('div', { style:{ height:'10px' } }),
    el('div', { class:'doach-actions' },
      el('button', { class:'doach-btn', onclick:triggerFilePicker }, 'Upload / Load New')
    )
  );

  // === Source controls: Upload / Camera ===
  const sourceRow = document.createElement('div');
  sourceRow.style.cssText = 'display:flex; gap:8px; align-items:center; margin:10px 0;';
  sourceRow.innerHTML = `
    <button id="contentUseCamBtn" class="doach-btn">Use camera</button>
    <button id="contentStopCamBtn" class="doach-btn">Stop camera</button>
    <span id="contentCamHint" style="margin-left:8px; opacity:.8;"></span>
  `;
  body.append(sourceRow); // ✅ append to body (setBody won't wipe it)

  // wire from the subtree we'll pass to the panel
  const uploadBtn = body.querySelector('#contentUploadBtn');
  const camBtn    = body.querySelector('#contentUseCamBtn');
  const stopBtn   = body.querySelector('#contentStopCamBtn');
  const hintEl    = body.querySelector('#contentCamHint');

  if (uploadBtn) uploadBtn.addEventListener('click', () => {
    const input = document.getElementById('videoInput');
    if (!input) { alert('Upload input not found'); return; }
    input.click();
  });

  if (camBtn || stopBtn) {
    const canCamera = !!(navigator.mediaDevices?.getUserMedia);
    const httpsOk   = (location.protocol === 'https:' ||
                       location.hostname === 'localhost' ||
                       location.hostname === '127.0.0.1');
    const allowPref = () => (window.PREF_ALLOW_CAMERA === true);

    const updateButtons = () => {
      const on = canCamera && httpsOk && allowPref();
      if (camBtn)  camBtn.disabled  = !on;
      if (stopBtn) stopBtn.disabled = !on;
      if (hintEl) {
        if (!canCamera)         hintEl.textContent = 'Camera not supported in this browser.';
        else if (!httpsOk)      hintEl.textContent = 'Camera requires HTTPS (or localhost).';
        else if (!allowPref())  hintEl.textContent = 'Enable “Allow camera access” in Preferences.';
        else                    hintEl.textContent = '';
      }
    };
    updateButtons();

    
    if (stopBtn) stopBtn.addEventListener('click', () => {
      try { window.stopCamera?.(); if (hintEl) hintEl.textContent = 'Camera stopped.'; }
      catch (e) { if (hintEl) hintEl.textContent = 'Stop failed: ' + (e?.message || e); }
    });

    // reflect "Allow camera" toggle live
    window.addEventListener('change', (e) => {
      if (e.target?.id === 'pf_allow_cam') updateButtons();
    });
  }

  panel.setBody(body);
  panel.open();
}



  function field(label, input){ return el('div', {class:'doach-field'}, el('label', {}, label), input); }
  




function ensureChallengeOverlay() {
  if (openChallengesPanel.overlay) return openChallengesPanel.overlay;
  const root = el('div', {
    id: 'challengeOverlay',
    class: 'challenge-overlay',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-hidden': 'true'
  });
  const frame = el('div', { class: 'challenge-frame' });
  const titleEl = el('div', {}, 'Challenges');
  const closeBtn = el('button', { class: 'challenge-close' }, 'Close');
  const header = el('div', { class: 'challenge-header' }, titleEl, closeBtn);
  const scroll = el('div', { class: 'challenge-scroll' });
  frame.append(header, scroll);
  root.append(frame);
  document.body.appendChild(root);

  function onKey(e) {
    if (e.key === 'Escape') overlay.close();
  }

  const overlay = {
    root,
    body: scroll,
    setTitle(txt) { titleEl.textContent = txt || 'Challenges'; },
    open(txt) {
      overlay.setTitle(txt);
      root.style.display = 'flex';
      requestAnimationFrame(() => root.classList.add('open'));
      root.setAttribute('aria-hidden', 'false');
      document.addEventListener('keydown', onKey);
    },
    close() {
      root.classList.remove('open');
      root.style.display = 'none';
      root.setAttribute('aria-hidden', 'true');
      document.removeEventListener('keydown', onKey);
    }
  };

  closeBtn.addEventListener('click', () => overlay.close());
  root.addEventListener('click', (e) => { if (e.target === root) overlay.close(); });

  openChallengesPanel.overlay = overlay;
  return overlay;
}

async function openChallengesPanel(initialSlug) {
  closeAllMenus('open-challenges');
  const overlay = ensureChallengeOverlay();
  overlay.open('Challenges');
  const state = (openChallengesPanel.state ||= {
    events: null,
    selectedSlug: null,
    category: 'overall',
    age: '14-16',
    ageSource: 'auto',
    status: null,
    statusAuth: true,
    statusError: null,
    requestId: 0,
  });
  if (initialSlug) {
    state.selectedSlug = initialSlug;
    if (state.ageSource !== 'manual') state.ageSource = 'auto';
  }
  const content = overlay.body;

  const ageGroups = ['<11', '11-14', '14-16', '17-19', '>19'];
  const ageLabels = { '<11': 'Under 11', '11-14': '11–14', '14-16': '14–16', '17-19': '17–19', '>19': '19+' };
  const categories = [
    { value: 'overall', label: 'Best Overall', description: 'Score = total makes across all eligible sessions.' },
    { value: 'best_session', label: 'Best Single Session', description: 'Score = most makes recorded in a single eligible challenge session.' },
    { value: 'improvement', label: 'Most Improved', description: 'Score = last three-session average minus first four-session average.' },
  ];

  content.innerHTML = '';
  content.append(el('div', { style: { font: '600 13px system-ui', opacity: '.8' } }, 'Loading challenges…'));

  try {
    if (!state.events) {
      const res = await fetch('/api/events', { credentials: 'include' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        throw new Error(data?.err || ('HTTP ' + res.status));
      }
      state.events = Array.isArray(data.events) ? data.events : [];
      window.__challengeEvents = window.__challengeEvents || {};
      state.events.forEach(ev => { window.__challengeEvents[ev.slug] = ev; });
    }
  } catch (err) {
    content.innerHTML = '';
    window.__challengeState = null;
    syncChallengeCTA();
    content.append(
      el('div', { style: { font: '600 13px system-ui', color: '#ffaeae' } }, 'Unable to load challenges.'),
      el('div', { style: { font: '500 12px system-ui', opacity: '.75' } }, String((err && err.message) || err || 'Unknown error')),
    );
    return;
  }

  if (!state.events || !state.events.length) {
    content.innerHTML = '';
    window.__challengeState = null;
    syncChallengeCTA();
    content.append(el('div', { style: { font: '600 13px system-ui', opacity: '.85' } }, 'No challenges are currently available.'));
    return;
  }

  if (!state.selectedSlug || !state.events.find(ev => ev.slug === state.selectedSlug)) {
    state.selectedSlug = state.events[0].slug;
  }

  await refreshStatus(false);
  render();

  async function refreshStatus(shouldRender = true) {
    state.statusError = null;
    state.status = null;
    state.statusAuth = true;
    try {
      const slug = encodeURIComponent(state.selectedSlug || '');
      if (!slug) throw new Error('event slug missing');
      const res = await fetch('/api/events/' + slug + '/status', { credentials: 'include' });
      if (res.status === 401) {
        state.statusAuth = false;
        state.status = null;
      } else {
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data?.ok) {
          throw new Error(data?.err || ('HTTP ' + res.status));
        }
        state.status = data;
        if (state.ageSource !== 'manual' && data.age_group) {
          state.age = data.age_group;
        }
      }
    } catch (err) {
      state.statusError = err;
    }
    if (shouldRender) render();
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    } catch (err) {
      return iso;
    }
  }
  function fmtPercent(v) {
    if (v === null || v === undefined || Number.isNaN(v)) return '—';
    return (v * 100).toFixed(1) + '%';
  }
  function fmtFloat(v, digits = 2) {
    if (v === null || v === undefined || Number.isNaN(v)) return '—';
    return Number(v).toFixed(digits);
  }
  function fmtInt(v) {
    if (v === null || v === undefined || Number.isNaN(v)) return '—';
    return String(v);
  }

  function render() {
    content.innerHTML = '';
    const event = state.events.find(ev => ev.slug === state.selectedSlug) || state.events[0];
    if (!event) return;
    state.selectedSlug = event.slug;
    window.__challengeEvents = window.__challengeEvents || {};
    window.__challengeEvents[event.slug] = event;
    if (state.status) {
      window.__challengeState = { slug: state.selectedSlug, event, status: state.status };
    } else {
      window.__challengeState = null;
    }
    syncChallengeCTA();

    const eventSel = el('select', {}, ...state.events.map(ev => el('option', { value: ev.slug, selected: ev.slug === state.selectedSlug }, ev.name || ev.slug)));
    eventSel.addEventListener('change', async () => {
      state.selectedSlug = eventSel.value;
      if (state.ageSource !== 'manual') state.ageSource = 'auto';
      await refreshStatus(false);
      render();
    });

    const catSel = el('select', {}, ...categories.map(opt => el('option', { value: opt.value, selected: opt.value === state.category }, opt.label)));
    catSel.addEventListener('change', () => { state.category = catSel.value; updateData(); });

    const ageSel = el('select', {}, ...ageGroups.map(age => el('option', { value: age, selected: age === state.age }, ageLabels[age] || age)));
    ageSel.addEventListener('change', () => { state.age = ageSel.value; state.ageSource = 'manual'; updateData(); });

    const infoLines = [];
    if (event.start_date && event.end_date) infoLines.push(fmtDate(event.start_date) + ' – ' + fmtDate(event.end_date));
    infoLines.push('Min shots per session: ' + (event.min_shots ?? 0));
    if (event.daily_limit) infoLines.push('Daily limit: ' + event.daily_limit);

    const selectedStatus = state.status;
    const statusAuth = state.statusAuth;
    const statusError = state.statusError;

    function makeCard(title) {
      const wrap = el('div', {
        style: {
          background: 'rgba(12,15,22,.92)',
          border: '1px solid rgba(255,255,255,.14)',
          borderRadius: '12px',
          padding: '10px',
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
        },
      });
      const heading = el('div', { style: { font: '600 12px system-ui', letterSpacing: '.02em' } }, title);
      const contentEl = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', font: '500 12px system-ui', opacity: '.88' } });
      wrap.append(heading, contentEl);
      wrap.body = contentEl;
      wrap.setTitle = (text) => { heading.textContent = text; };
      return wrap;
    }

    function fillRegistration(target) {
      target.innerHTML = '';
      if (!statusAuth) {
        target.append(el('div', { style: { font: '500 12px system-ui', opacity: '.75' } }, 'Sign in to join this challenge.'));
        return;
      }
      if (statusError) {
        target.append(el('div', { style: { font: '500 12px system-ui', color: '#ffaeae' } }, 'Status unavailable: ' + String((statusError && statusError.message) || statusError)));
        return;
      }
      if (!selectedStatus) {
        target.append(el('div', { style: { font: '500 12px system-ui', opacity: '.75' } }, 'Loading status…'));
        return;
      }
      const inputStyle = { background: '#0b0f14', color: '#fff', border: '1px solid rgba(255,255,255,.22)', borderRadius: '8px', padding: '7px 10px', font: '500 12px system-ui' };
      if (!selectedStatus.registered) {
        target.append(el('div', { style: { font: '500 12px system-ui' } }, 'Enter your birthdate to be ranked in the right age group.'));
        const dobInput = el('input', { type: 'date', value: selectedStatus.dob || '', style: inputStyle });
        const actions = el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } });
        const registerBtn = el('button', { class: 'doach-btn' }, 'Sign Up');
        registerBtn.addEventListener('click', async () => {
          registerBtn.disabled = true;
          try {
            const slug = encodeURIComponent(state.selectedSlug || '');
            const res = await fetch('/api/events/' + slug + '/register', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({ dob: dobInput.value || null }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data?.ok) throw new Error((data && data.err) || ('HTTP ' + res.status));
            window.showPrompt?.('Registered for the challenge!');
            await refreshStatus(false);
            render();
          } catch (err) {
            window.showPrompt?.(String((err && err.message) || err || 'Unable to register.'));
          } finally {
            registerBtn.disabled = false;
          }
        });
        actions.append(registerBtn);
        target.append(dobInput, actions);
      } else {
        target.append(el('div', { style: { font: '500 12px system-ui' } }, 'Registered · ' + (ageLabels[selectedStatus.age_group] || selectedStatus.age_group)));
        if (selectedStatus.dob) target.append(el('div', { style: { font: '500 12px system-ui', opacity: '.7' } }, 'DOB: ' + fmtDate(selectedStatus.dob)));
        if (selectedStatus.registered_at) target.append(el('div', { style: { font: '500 12px system-ui', opacity: '.65' } }, 'Joined: ' + fmtDate(selectedStatus.registered_at)));
        const row = el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' } });
        const dobInput = el('input', { type: 'date', value: selectedStatus.dob || '', style: inputStyle });
        const updateBtn = el('button', { class: 'doach-btn ghost' }, 'Update DOB');
        updateBtn.addEventListener('click', async () => {
          updateBtn.disabled = true;
          try {
            const slug = encodeURIComponent(state.selectedSlug || '');
            const res = await fetch('/api/events/' + slug + '/register', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({ dob: dobInput.value || null }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data?.ok) throw new Error((data && data.err) || ('HTTP ' + res.status));
            window.showPrompt?.('Profile updated.');
            await refreshStatus(false);
            render();
          } catch (err) {
            window.showPrompt?.(String((err && err.message) || err || 'Unable to update DOB.'));
          } finally {
            updateBtn.disabled = false;
          }
        });
        row.append(dobInput, updateBtn);
        target.append(row);
        const quickCtx = { slug: state.selectedSlug, event, status: selectedStatus };
        const quickWrap = el('div', { style: { marginTop: '6px', display: 'flex', flexDirection: 'column', gap: '6px' } });
        const quickBtn = el('button', { class: 'doach-btn' }, '');
        const quickAction = configureChallengeButton(quickBtn, quickCtx, () => {
          setTimeout(() => refreshStatus(true), 300);
        });
        if (quickAction.visible) {
          quickWrap.append(quickBtn);
          if (!quickAction.enabled && quickAction.reason) {
            quickWrap.append(el('div', { class: 'challenge-note' }, quickAction.reason));
          }
          target.append(quickWrap);
        }
      }
    }

    function fillDaily(target) {
      target.innerHTML = '';
      if (!statusAuth) {
        target.append(el('div', { style: { font: '500 12px system-ui', opacity: '.75' } }, 'Sign in to log challenge sessions.'));
        return;
      }
      if (statusError) {
        target.append(el('div', { style: { font: '500 12px system-ui', color: '#ffaeae' } }, 'Status unavailable: ' + String((statusError && statusError.message) || statusError)));
        return;
      }
      if (!selectedStatus) {
        target.append(el('div', { style: { font: '500 12px system-ui', opacity: '.75' } }, 'Loading status…'));
        return;
      }
      const tzNote = selectedStatus.tz ? ' · ' + selectedStatus.tz : '';
      target.append(el('div', { style: { font: '500 12px system-ui' } }, 'Today: ' + fmtDate(selectedStatus.today_date) + tzNote));

      if (!selectedStatus.registered) {
        target.append(el('div', { style: { font: '500 12px system-ui', opacity: '.75' } }, 'Register above to unlock challenge sessions.'));
        return;
      }

      if (selectedStatus.window_state === 'upcoming') {
        target.append(el('div', { style: { font: '500 12px system-ui', opacity: '.75' } }, 'Challenge opens on ' + fmtDate(selectedStatus.event_start) + '.'));
        return;
      }
      if (selectedStatus.window_state === 'closed') {
        target.append(el('div', { style: { font: '500 12px system-ui', opacity: '.75' } }, 'Challenge ended on ' + fmtDate(selectedStatus.event_end) + '.'));
        return;
      }

      if (selectedStatus.min_shots || selectedStatus.daily_limit) {
        const limitText = selectedStatus.daily_limit ? (selectedStatus.daily_limit + ' session/day') : 'Unlimited sessions/day';
        target.append(el('div', { style: { font: '500 12px system-ui', opacity: '.75' } }, limitText + ' · Min ' + (selectedStatus.min_shots || 0) + ' attempts'));
      }

      if (Array.isArray(selectedStatus.today_sessions) && selectedStatus.today_sessions.length) {
        selectedStatus.today_sessions.forEach(sess => {
          const line = sess.analyzed
            ? "Today's session: " + fmtInt(sess.makes) + ' / ' + fmtInt(sess.attempts)
            : "Challenge session started — waiting for analysis.";
          target.append(el('div', { style: { font: '500 12px system-ui' } }, line));
        });
      }

      if (selectedStatus.today_submitted) {
        target.append(el('div', { style: { font: '600 12px system-ui', color: '#34d399' } }, '✅ Today’s challenge is complete.'));
      } else if (selectedStatus.today_started) {
        target.append(el('div', { style: { font: '500 12px system-ui', opacity: '.75' } }, 'Session started — wrap up to lock in your score.'));
      }

      const dailyCtx = { slug: state.selectedSlug, event, status: selectedStatus };
      const dailyWrap = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } });
      const dailyBtn = el('button', { class: 'doach-btn' }, '');
      const dailyAction = configureChallengeButton(dailyBtn, dailyCtx, () => { setTimeout(() => refreshStatus(true), 300); });
      if (dailyAction.visible) {
        dailyWrap.append(dailyBtn);
        if (!dailyAction.enabled && dailyAction.reason) {
          dailyWrap.append(el('div', { class: 'challenge-note' }, dailyAction.reason));
        }
        target.append(dailyWrap);
      } else if (!selectedStatus.today_submitted && selectedStatus.today_started) {
        target.append(el('div', { style: { font: '500 12px system-ui', opacity: '.75' } }, 'Daily entry already in progress.'));
      } else if (!selectedStatus.today_submitted) {
        target.append(el('div', { style: { font: '500 12px system-ui', opacity: '.75' } }, 'Daily entry already used.'));
      }

      if (selectedStatus.last_session_date) {
        target.append(el('div', { style: { font: '500 12px system-ui', opacity: '.7' } }, 'Last submission: ' + fmtDate(selectedStatus.last_session_date)));
      }
    }

    const cardsWrap = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '8px' } });
    const descEl = el('div', { class: 'challenge-note' }, categories.find(opt => opt.value === state.category)?.description || '');

    const registrationCard = makeCard('Sign Up');
    const dailyCard = makeCard('Daily Participation');
    const myRankCard = makeCard('My Position');
    const leaderboardCard = makeCard('Leaderboard');

    const registrationBody = registrationCard.body;
    const dailyBody = dailyCard.body;
    const myRankWrap = myRankCard.body;
    const leaderboardWrap = leaderboardCard.body;
    leaderboardWrap.style.minHeight = '180px';

    cardsWrap.append(registrationCard, dailyCard, myRankCard);

    content.append(
      el('div', { class: 'doach-field' }, el('label', {}, 'Event'), eventSel),
      el('div', { class: 'doach-field' }, el('label', {}, 'Category'), catSel),
      el('div', { class: 'doach-field' }, el('label', {}, 'Age Group'), ageSel),
      el('div', { style: { font: '500 12px system-ui', opacity: '.75' } }, infoLines.join(' · ')),
      descEl,
      cardsWrap,
      leaderboardCard,
    );

    fillRegistration(registrationBody);
    fillDaily(dailyBody);
    myRankWrap.innerHTML = '';
    myRankWrap.append(el('div', { style: { font: '500 12px system-ui', opacity: '.75' } }, statusAuth ? 'Loading…' : 'Sign in to track your rank.'));

    updateData();

    function setTable(entries) {
      leaderboardWrap.innerHTML = '';
      if (!entries || !entries.length) {
        leaderboardWrap.append(el('div', { style: { font: '600 13px system-ui', opacity: '.8' } }, 'No eligible sessions yet.'));
        return;
      }
      const table = el('table', { class: 'challenge-table' });
      const thead = el('thead');
      const tbody = el('tbody');
      const headers = [];
      if (state.category === 'overall') {
        headers.push('Rank', 'Player', 'Makes', 'Attempts', 'Accuracy', 'Last Session');
      } else if (state.category === 'best_session') {
        headers.push('Rank', 'Player', 'Makes', 'Attempts', 'Accuracy', 'Session Date');
      } else {
        headers.push('Rank', 'Player', 'Score', 'Last 3 Avg', 'First 4 Avg', 'Sessions', 'Last Session');
      }
      const headerRow = el('tr', {}, ...headers.map(h => el('th', {}, h)));
      thead.append(headerRow);

      entries.forEach(row => {
        let cells;
        if (state.category === 'overall') {
          cells = [
            row.rank,
            row.handle,
            fmtInt(row.makes),
            fmtInt(row.attempts),
            fmtPercent(row.accuracy),
            row.last_session_date ? fmtDate(row.last_session_date) : '—',
          ];
        } else if (state.category === 'best_session') {
          const acc = row.attempts ? row.makes / row.attempts : null;
          cells = [
            row.rank,
            row.handle,
            fmtInt(row.makes),
            fmtInt(row.attempts),
            fmtPercent(acc),
            row.session_date ? fmtDate(row.session_date) : '—',
          ];
        } else {
          const firstLabel = row.provisional_first ? fmtFloat(row.first_avg) + '*' : fmtFloat(row.first_avg);
          const lastLabel = row.provisional_last ? fmtFloat(row.last_avg) + '*' : fmtFloat(row.last_avg);
          cells = [
            row.rank,
            row.handle,
            fmtFloat(row.score, 2),
            lastLabel,
            firstLabel,
            fmtInt(row.sessions),
            row.last_session_date ? fmtDate(row.last_session_date) : '—',
          ];
        }
        const tr = el('tr', {}, ...cells.map(value => el('td', {}, value)));
        tbody.append(tr);
      });

      table.append(thead, tbody);
      leaderboardWrap.append(table);
      if (state.category === 'improvement') {
        leaderboardWrap.append(el('div', { class: 'challenge-note' }, '* Asterisk denotes provisional averages when fewer than the suggested sessions are available.'));
      }
    }

    async function updateData() {
      if (!state.selectedSlug) return;
      const reqId = ++state.requestId;
      const currentCategory = categories.find(opt => opt.value === state.category) || categories[0];
      const ageName = ageLabels[state.age] || state.age;
      leaderboardCard.setTitle('Leaderboard · ' + currentCategory.label + ' · ' + ageName);
      descEl.textContent = currentCategory.description;
      leaderboardWrap.innerHTML = '';
      leaderboardWrap.append(el('div', { style: { font: '600 13px system-ui', opacity: '.8' } }, 'Loading leaderboard…'));
      myRankWrap.innerHTML = '';
      myRankWrap.append(el('div', { style: { font: '500 12px system-ui', opacity: '.75' } }, 'Loading…'));
      try {
        const params = new URLSearchParams({ category: state.category, age: state.age });
        const res = await fetch('/api/events/' + encodeURIComponent(state.selectedSlug) + '/leaderboard?' + params.toString(), { credentials: 'include' });
        const data = await res.json().catch(() => ({}));
        if (reqId !== state.requestId) return;
        if (!res.ok || !data?.ok) {
          throw new Error((data && data.err) || ('HTTP ' + res.status));
        }
        setTable(Array.isArray(data.top) ? data.top : []);
      } catch (err) {
        if (reqId !== state.requestId) return;
        leaderboardWrap.innerHTML = '';
        leaderboardWrap.append(el('div', { style: { font: '600 13px system-ui', color: '#ffaeae' } }, 'Unable to load leaderboard.'));
        leaderboardWrap.append(el('div', { style: { font: '500 12px system-ui', opacity: '.75' } }, String((err && err.message) || err || 'Unknown error')));
      }
      updateMyRank(reqId);
    }

    async function updateMyRank(checkId) {
      if (!statusAuth) {
        myRankWrap.innerHTML = '';
        myRankWrap.append(el('div', { style: { font: '500 12px system-ui', opacity: '.75' } }, 'Sign in to see your rank.'));
        return;
      }
      try {
        const params = new URLSearchParams({ category: state.category });
        const res = await fetch('/api/events/' + encodeURIComponent(state.selectedSlug) + '/my_rank?' + params.toString(), { credentials: 'include' });
        if (checkId !== state.requestId) return;
        if (res.status === 401) {
          myRankWrap.innerHTML = '';
          myRankWrap.append(el('div', { style: { font: '500 12px system-ui', opacity: '.75' } }, 'Sign in to see your rank.'));
          return;
        }
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data?.ok) throw new Error((data && data.err) || ('HTTP ' + res.status));
        myRankWrap.innerHTML = '';
        if (data.rank == null) {
          myRankWrap.append(el('div', { style: { font: '500 12px system-ui', opacity: '.75' } }, 'Log a challenge session to appear on the board.'));
          return;
        }
        myRankWrap.append(el('div', { style: { font: '600 13px system-ui' } }, 'You are #' + data.rank + ' in ' + (ageLabels[data.age_group] || data.age_group) + '.'));
        if (state.category === 'overall') {
          myRankWrap.append(el('div', { style: { font: '500 12px system-ui', opacity: '.78' } }, 'Makes: ' + fmtInt(data.makes) + ' / ' + fmtInt(data.attempts) + ' (' + fmtPercent(data.accuracy) + ').'));
        } else if (state.category === 'best_session') {
          const dateLine = data.session_date ? ' on ' + fmtDate(data.session_date) : '';
          myRankWrap.append(el('div', { style: { font: '500 12px system-ui', opacity: '.78' } }, 'Best session: ' + fmtInt(data.makes) + ' / ' + fmtInt(data.attempts) + ' (' + fmtPercent(data.accuracy) + ')' + dateLine + '.'));
        } else {
          const firstLabel = data.provisional_first ? fmtFloat(data.first_avg) + '*' : fmtFloat(data.first_avg);
          const lastLabel = data.provisional_last ? fmtFloat(data.last_avg) + '*' : fmtFloat(data.last_avg);
          myRankWrap.append(el('div', { style: { font: '500 12px system-ui', opacity: '.78' } }, 'Improvement: ' + fmtFloat(data.score) + ' (last 3 avg ' + lastLabel + ', first 4 avg ' + firstLabel + ').'));
        }
        if (data.last_session_date) {
          myRankWrap.append(el('div', { style: { font: '500 12px system-ui', opacity: '.7' } }, 'Last challenge session: ' + fmtDate(data.last_session_date) + '.'));
        }
      } catch (err) {
        if (checkId !== state.requestId) return;
        myRankWrap.innerHTML = '';
        myRankWrap.append(el('div', { style: { font: '500 12px system-ui', color: '#ffaeae' } }, 'Unable to load your rank.'));
        myRankWrap.append(el('div', { style: { font: '500 12px system-ui', opacity: '.75' } }, String((err && err.message) || err || 'Unknown error')));
      }
    }
  }
}

async function openMyDoachPanel(){
    const panel = (openMyDoachPanel.panel ||= makeSidePanel('My Doach'));
    const prefs = (window.doachGetPrefs?.() || {voice:'alloy', tts:'openai', speed:1, pitch:1, volume:1, bassDb:0, trebleDb:0, lang:'en-US'});
    const body = el('div');

    const ttsSel   = el('select', {}, ...['openai','web'].map(v=> el('option',{value:v, selected:(prefs.tts===v)}, v)));
    const voiceInp = el('input', {type:'text', value:(prefs.voice||'alloy')});
    const speed    = el('input', {type:'range', class:'doach-range', min:'0.5', max:'1.5', step:'0.05', value: prefs.speed??1});
    const pitch    = el('input', {type:'range', class:'doach-range', min:'0.5', max:'2.0', step:'0.05', value: prefs.pitch??1});
    const volume   = el('input', {type:'range', class:'doach-range', min:'0',   max:'1.0', step:'0.05', value: prefs.volume??1});
    const bassDb   = el('input', {type:'number', value: prefs.bassDb??0, step:'1'});
    const trebDb   = el('input', {type:'number', value: prefs.trebleDb??0, step:'1'});
    const langSel  = el('input', {type:'text', value: prefs.lang || 'en-US'});

    const presetSel = el('select');
    const nameInp   = el('input', {type:'text', placeholder:'Preset name'});
    async function refreshPresets(){
      presetSel.innerHTML = '';
      const presets = (await window.doachLoadPresets?.()) || [];
      presetSel.append(...[el('option',{value:''}, '— Select preset —'), ...presets.map(p => el('option', {value:p.name}, p.name))]);
    }
    await refreshPresets();

    presetSel.addEventListener('change', async ()=>{
      if (!presetSel.value) return;
      const presets = (await window.doachLoadPresets?.()) || [];
      const p = presets.find(x=>x.name===presetSel.value);
      if (!p) return;
      ttsSel.value = p.tts || prefs.tts;
      voiceInp.value = p.voice || prefs.voice;
      speed.value = p.speed ?? 1;
      pitch.value = p.pitch ?? 1;
      volume.value = p.volume ?? 1;
      bassDb.value = p.bassDb ?? 0;
      trebDb.value = p.trebleDb ?? 0;
      langSel.value = p.lang || 'en-US';
    });

    const rowEq = el('div', {class:'doach-row'},
      el('div', {class:'col'}, field('Bass dB', bassDb)),
      el('div', {class:'col'}, field('Treble dB', trebDb))
    );

    const actions = el('div', {class:'doach-actions'},
      el('button', {class:'doach-btn', onclick:applyNow}, 'Apply to Session'),
      el('button', {class:'doach-btn ghost', onclick:testVoice}, 'Test Voice'),
      el('button', {class:'doach-btn', onclick:savePreset}, 'Save as Preset'),
      el('button', {class:'doach-btn ghost', onclick:refreshPresets}, 'Reload Presets')
    );

    body.append(
      field('TTS Engine', ttsSel),
      field('Voice', voiceInp),
      field('Language', langSel),
      field('Speed', speed),
      field('Pitch (Web TTS only)', pitch),
      field('Volume', volume),
      rowEq,
      el('div', {class:'doach-field'}, el('label', {}, 'Presets'), el('div', {class:'doach-row'},
        el('div', {class:'col'}, presetSel),
        el('div', {class:'col'}, nameInp)
      )),
      actions
    );

    panel.setBody(body); panel.open();

    function readUI(){
      return {
        tts: ttsSel.value,
        voice: voiceInp.value.trim() || 'alloy',
        speed: Number(speed.value),
        pitch: Number(pitch.value),
        volume: Number(volume.value),
        bassDb: Number(bassDb.value),
        trebleDb: Number(trebDb.value),
        lang: (langSel.value||'en-US').trim()
      };
    }
    function applyNow(){ const p = readUI(); window.doachSetPrefs?.(p); window.doachSpeak?.('Voice settings applied.'); }
    function testVoice(){ const p = readUI(); window.doachSetPrefs?.(p); window.doachSpeak?.('This is your Doach voice.'); }
    async function savePreset(){
      const name = (nameInp.value||'').trim();
      if (!name) { alert('Enter a preset name'); return; }
      const ok = await window.doachSavePreset?.({ name, ...readUI() });
      if (ok) { nameInp.value=''; await refreshPresets(); alert('Preset saved.'); }
    }
  }

  // Simple Auth panel (Login / Create Account)
  async function openAuthPanel() {
    const panel = (openAuthPanel.panel ||= makeSidePanel('Login / Account'));
    const body = document.createElement('div');

    const status = document.createElement('div');
    status.style.margin = '6px 0 12px';
    status.style.opacity = '0.9';

    const nameRow = document.createElement('div');
    nameRow.className = 'doach-field';
    const nameLab = document.createElement('label'); nameLab.textContent = 'Name (for account creation)';
    const nameInp = document.createElement('input'); nameInp.type = 'text'; nameInp.placeholder = 'Jane Doe';
    nameRow.append(nameLab, nameInp);

    const emailRow = document.createElement('div');
    emailRow.className = 'doach-field';
    const emailLab = document.createElement('label'); emailLab.textContent = 'Email';
    const emailInp = document.createElement('input'); emailInp.type = 'text'; emailInp.placeholder = 'you@example.com';
    emailRow.append(emailLab, emailInp);

    const pwRow = document.createElement('div');
    pwRow.className = 'doach-field';
    const pwLab = document.createElement('label'); pwLab.textContent = 'Password';
    const pwInp = document.createElement('input'); pwInp.type = 'password'; pwInp.placeholder = '••••••••';
    pwRow.append(pwLab, pwInp);

    const actions = document.createElement('div'); actions.className = 'doach-actions';
    const btnLogin = document.createElement('button'); btnLogin.className = 'doach-btn'; btnLogin.textContent = 'Login';
    const btnCreate = document.createElement('button'); btnCreate.className = 'doach-btn ghost'; btnCreate.textContent = 'Create Account';
    const btnLogout = document.createElement('button'); btnLogout.className = 'doach-btn ghost'; btnLogout.textContent = 'Logout'; btnLogout.style.display = 'none';
    const btnSessions = document.createElement('button'); btnSessions.className = 'doach-btn'; btnSessions.textContent = 'My Sessions';
    actions.append(btnLogin, btnCreate, btnLogout, btnSessions);

    body.append(status, nameRow, emailRow, pwRow, actions);

    async function fetchJSON(url, opts) {
      const r = await fetch(url, opts);
      const j = await r.json().catch(()=>({}));
      if (!r.ok) throw new Error(j?.error || ('HTTP '+r.status));
      return j;
    }
    async function me(){
      try {
        const u = await fetchJSON('/api/auth/me');
        if (u?.user) {
          status.textContent = `Signed in as ${u.user.name || u.user.email}`;
          btnLogout.style.display = '';
          nameRow.style.display = 'none';
        } else {
          status.textContent = 'Not signed in';
          btnLogout.style.display = 'none';
          nameRow.style.display = '';
        }
      } catch (e) {
        status.textContent = 'Not signed in';
        btnLogout.style.display = 'none';
        nameRow.style.display = '';
      }
    }

    btnLogin.onclick = async ()=>{
      try {
        const j = await fetchJSON('/api/auth/login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ email: emailInp.value.trim(), password: pwInp.value }) });
        status.textContent = `Welcome, ${j.name || j.email}`;
        try { localStorage.setItem('firstname', (j.name||'').split(' ')[0] || 'player'); } catch {}
        btnLogout.style.display = '';
        nameRow.style.display = 'none';
        // Defer greeting until camera (or video) actually starts
        window.__welcomePending = true; window.showStartSessionCTA?.();
        try { window.enableHoopPickOnce?.(); } catch {}
        try { await window.prefetchChallengeState?.(); } catch {}
      } catch (e) { alert('Login failed: ' + e.message); }
    };
    btnCreate.onclick = async ()=>{
      try {
        const j = await fetchJSON('/api/auth/register', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name: nameInp.value.trim(), email: emailInp.value.trim(), password: pwInp.value }) });
        status.textContent = `Account created: ${j.name || j.email}`;
        try { localStorage.setItem('firstname', (j.name||'').split(' ')[0] || 'player'); } catch {}
        btnLogout.style.display = '';
        nameRow.style.display = 'none';
        // Defer greeting until camera (or video) actually starts
        window.__welcomePending = true; window.showStartSessionCTA?.();
        try { window.enableHoopPickOnce?.(); } catch {}
        try { await window.prefetchChallengeState?.(); } catch {}
      } catch (e) { alert('Create failed: ' + e.message); }
    };
    btnLogout.onclick = async ()=>{
      try { await fetchJSON('/api/auth/logout', { method:'POST' }); } catch {}
      status.textContent = 'Signed out';
      btnLogout.style.display = 'none';
      nameRow.style.display = '';
      try { window.__challengeState = null; window.syncChallengeCTA?.(); } catch {}
    };
    btnSessions.onclick = ()=> window.open('/static/my_sessions.html','_blank');

    panel.setBody(body);
    panel.open();
    me();
  }

// ---------- Mount Menu ----------
function mountHamburgerMenu(){
  if (document.getElementById('doach-menu-mounted')) return;
  const marker = document.createElement('meta');
  marker.id = 'doach-menu-mounted';
  document.head.appendChild(marker);

  const drawer = el('div', {class:'doach-drawer'},
    el('h3', {}, 'Menu'),
    el('ul', {class:'doach-menu'},
      el('li', {}, el('button', {class:'doach-item', onclick:openContentPanel}, 'Content')),
      el('li', {}, el('button', {class:'doach-item', onclick:openMyDoachPanel}, 'My Doach')),
      el('li', {}, el('button', {class:'doach-item', onclick:openAuthPanel}, 'Login / Account')),
      el('li', {},
        el('button', {class:'doach-item', onclick:openChallengesPanel}, 'Challenges'),
        el('ul', {class:'doach-submenu'},
          el('li', {}, el('button', {class:'doach-subitem', onclick:() => openChallengesPanel('cav-camps-2025')}, 'CAV Camps 2025'))
        )
      ),
      el('li', {}, el('button', {class:'doach-item', onclick:() => window.open('/static/my_sessions.html','_blank')}, 'My Sessions')),
      el('li', {}, el('button', {class:'doach-item', onclick:openDiagnosticsPanel}, 'Coach Diagnostics')),
      // ✅ one Preferences item only
      el('li', {}, el('button', {
        class:'doach-item',
        onclick: () => window.openPreferencesPanel?.()
      }, 'Preferences'))
    )
  );
  document.body.appendChild(drawer);
  __drawer = drawer;

  const btn = el('div', {class:'doach-hamburger', title:'Menu (M)', onclick:toggle}, '☰');
  document.body.appendChild(btn);
  window.addEventListener('keydown', (e)=>{ if ((e.key||'').toLowerCase()==='m') toggle(); });
  function toggle(){ drawer.classList.toggle('open'); }

  const floater = el('button', {class:'doach-floating-mydoach', onclick:openMyDoachPanel}, 'MyDoach ⚙️');
  document.body.appendChild(floater);

  wireVideoAutoClose();
}

  // Expose for non-module usage and export for module usage
  window.mountHamburgerMenu = mountHamburgerMenu;
  try { if (typeof module !== 'undefined') module.exports = { mountHamburgerMenu }; } catch {}
  // Auto-mount after DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { mountHamburgerMenu(); prefetchChallengeState(); });
  } else {
    mountHamburgerMenu();
    prefetchChallengeState();
  }
})();


// ---------- Preferences (pop-out) ----------
function loadDoachPrefs() {
  try { return JSON.parse(localStorage.getItem('doach_prefs')) || {}; } catch { return {}; }
}
function saveDoachPrefs(p) {
  localStorage.setItem('doach_prefs', JSON.stringify(p||{}));
}

// ---------- Preferences (pop-out) :: DEMO-LEAN ----------

// 1) Defaults with demo toggles included
function getDefaults() {
  return {
    // scoring (kept)
    scorerMode: (window.SHOT_SCORER_MODE || 'weighted'),
    weightedThresh: Number(window.WEIGHTED_THRESH ?? 0.75),

    // overlay visibility (basic)
    show: {
      ball: (window.PREF_SHOW?.ball ?? true),
      trails: (window.PREF_SHOW?.trails ?? true),
      player: (window.PREF_SHOW?.player ?? true),
      hoop: (window.PREF_SHOW?.hoop ?? true),
      backboard: (window.PREF_SHOW?.backboard ?? false),
      net: (window.PREF_SHOW?.net ?? false),

      // NEW demo toggles
      poseLines: (window.SHOW_POSE_LINES === true),
      releaseGate: (window.SHOW_RELEASE_GATE === true)
    },

    // audio/permissions
    audioOn: (window.PREF_AUDIO_ENABLED !== false),
    allowMic: (window.PREF_ALLOW_MIC !== false),
    allowCamera: !!window.PREF_ALLOW_CAMERA
  };
}

function loadDoachPrefs() {
  try { return JSON.parse(localStorage.getItem('doach_prefs')) || {}; } catch { return {}; }
}
function saveDoachPrefs(p) {
  localStorage.setItem('doach_prefs', JSON.stringify(p||{}));
}

// 2) Apply prefs to globals (ties SHOW_POSE_LINES + SHOW_RELEASE_GATE)
function applyPrefs(p) {
  // scoring
  window.SHOT_SCORER_MODE = String(p.scorerMode || 'weighted').toLowerCase();
  window.WEIGHTED_THRESH  = Math.max(0.5, Math.min(0.95, Number(p.weightedThresh)||0.75));

  // visibility
  const show = {
    ball: !!p.show.ball, trails: !!p.show.trails, player: !!p.show.player,
    hoop: !!p.show.hoop, backboard: !!p.show.backboard, net: !!p.show.net
  };
  window.PREF_SHOW = show;

  // demo toggles -> hard globals
  window.SHOW_POSE_LINES   = !!p.show.poseLines;
  window.SHOW_RELEASE_GATE = !!p.show.releaseGate;

  // audio / mic / camera
  window.PREF_AUDIO_ENABLED = !!p.audioOn;
  window.PREF_ALLOW_MIC     = !!p.allowMic;
  window.PREF_ALLOW_CAMERA  = !!p.allowCamera;

  saveDoachPrefs(p);

  // let overlays react immediately
  try { window.dispatchEvent(new CustomEvent('prefs:changed', { detail: { prefs: p } })); } catch {}
  // force an overlay repaint if available
  try { window.drawLiveOverlay?.(window.lastDetectedFrame?.objects || [], window.playerState); } catch {}

  console.log('[prefs] applied (demo lean)', p);
}

// 3) Minimal Preferences panel UI
async function openPreferencesPanel() {
  console.log('[menu] openPreferencesPanel (demo lean)');
  const factory = window.__makeSidePanel || (title => {
    // tiny fallback panel if someone forgets to export makeSidePanel
    const wrap = document.createElement('div');
    wrap.className = 'doach-sidepanel open';
    wrap.style.cssText = 'position:fixed;top:0;right:0;bottom:0;width:420px;z-index:10045;background:rgba(14,14,18,.98);color:#fff;border-left:1px solid rgba(255,255,255,.12);';
    const head = document.createElement('div');
    head.className = 'doach-panel-head';
    head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.12);font:600 14px system-ui;';
    head.innerHTML = `<div>${title||'Preferences'}</div>`;
    const close = document.createElement('button');
    close.className = 'doach-btn ghost';
    close.textContent = 'Close';
    close.onclick = () => document.body.removeChild(wrap);
    head.appendChild(close);
    const body = document.createElement('div');
    body.className = 'doach-panel-body';
    body.style.cssText = 'padding:12px;overflow:auto;height:calc(100% - 48px);';
    wrap.append(head, body);
    document.body.appendChild(wrap);
    return {
      setBody(n){ body.innerHTML=''; body.appendChild(n); },
      open(){ /* already open */ },
      openClose(){ try{ document.body.removeChild(wrap); }catch{} }
    };
  });
  const panel = (openPreferencesPanel.panel ||= factory('Preferences'));

  const body  = document.createElement('div');

  const defs  = getDefaults();
  const saved = loadDoachPrefs();
  const prefs = {
    ...defs,
    ...saved,
    show: { ...defs.show, ...(saved.show || {}) }
  };

  // simple helpers
  const field = (label, input) => {
    const row = document.createElement('div'); row.className = 'doach-field';
    const lab = document.createElement('label'); lab.textContent = label;
    row.append(lab, input); return row;
  };
  const chk = (id, label, checked) => {
    const input = document.createElement('input'); input.type = 'checkbox'; input.id = id; input.checked = !!checked;
    return field(label, input);
  };
  const sel = (id, label, options, value) => {
    const s = document.createElement('select'); s.id = id;
    options.forEach(([v,t])=>{ const o=document.createElement('option'); o.value=v; o.textContent=t; o.selected=(v===value); s.appendChild(o); });
    return field(label, s);
  };
  const rng = (id, label, min, max, step, val, hint='') => {
    const wrap=document.createElement('div'); wrap.className='doach-field';
    const lab=document.createElement('label'); lab.textContent=label; if (hint) lab.title=hint;
    const r=document.createElement('input'); r.type='range'; r.className='doach-range';
    r.min=min; r.max=max; r.step=step; r.value=val;
    const out=document.createElement('output'); out.value=val; r.oninput=()=> out.value=r.value;
    r.id=id; wrap.append(lab, r, out); return wrap;
  };

  // DISPLAY
  body.append(document.createElement('hr'));
  const hDisp = document.createElement('div'); hDisp.textContent = 'Display'; hDisp.style.cssText='font:600 13px system-ui; opacity:.85; margin:6px 0;';
  body.append(hDisp);
  body.append(chk('pf_show_poseLines', 'Show pose lines', prefs.show.poseLines));
  body.append(chk('pf_show_releaseGate', 'Show release gate HUD', prefs.show.releaseGate));
  // body.append(chk('pf_show_player', 'Show players', prefs.show.player));
  // body.append(chk('pf_show_ball',   'Show ball',    prefs.show.ball));
  // body.append(chk('pf_show_trails', 'Show ball trail', prefs.show.trails));
  // body.append(chk('pf_show_hoop',   'Show hoop',    prefs.show.hoop));
  // body.append(chk('pf_show_bb',     'Show backboard', prefs.show.backboard));
  // body.append(chk('pf_show_net',    'Show net',     prefs.show.net));

  // SCORER
  // body.append(document.createElement('hr'));
  // const hScore = document.createElement('div'); hScore.textContent = 'Scorer'; hScore.style.cssText='font:600 13px system-ui; opacity:.85; margin:6px 0;';
  // body.append(hScore);
  // body.append(sel('pf_mode', 'Mode', [['weighted','Weighted'],['hybrid','Hybrid']], (prefs.scorerMode||'weighted')));
  // body.append(rng('pf_thresh', 'Make threshold', 0.5, 0.95, 0.01, Number(prefs.weightedThresh ?? 0.75)));

  // PERMISSIONS / AUDIO
  body.append(document.createElement('hr'));
  const hPerm = document.createElement('div'); hPerm.textContent = 'Permissions & Audio'; hPerm.style.cssText='font:600 13px system-ui; opacity:.85; margin:6px 0;';
  body.append(hPerm);
  body.append(chk('pf_audio_on','Audio on (TTS)', prefs.audioOn));
  body.append(chk('pf_allow_mic','Allow microphone', prefs.allowMic));
  body.append(chk('pf_allow_cam','Allow camera', prefs.allowCamera));

  // Actions
  const actions = document.createElement('div'); actions.className='doach-actions';
  const applyBtn = document.createElement('button'); applyBtn.className='doach-btn'; applyBtn.textContent='Apply';
  const resetBtn = document.createElement('button'); resetBtn.className='doach-btn ghost'; resetBtn.textContent='Reset defaults';
  actions.append(applyBtn, resetBtn);
  body.append(actions);

  function readPrefsFromUI() {
    return {
      scorerMode: (body.querySelector('#pf_mode')?.value || 'weighted'),
      weightedThresh: Number(body.querySelector('#pf_thresh').value),
      show: {
        poseLines: body.querySelector('#pf_show_poseLines').checked,
        releaseGate: body.querySelector('#pf_show_releaseGate').checked,
        player:  body.querySelector('#pf_show_player').checked,
        ball:    body.querySelector('#pf_show_ball').checked,
        trails:  body.querySelector('#pf_show_trails').checked,
        hoop:    body.querySelector('#pf_show_hoop').checked,
        backboard: body.querySelector('#pf_show_bb').checked,
        net:     body.querySelector('#pf_show_net').checked
      },
      audioOn:    body.querySelector('#pf_audio_on').checked,
      allowMic:   body.querySelector('#pf_allow_mic').checked,
      allowCamera:body.querySelector('#pf_allow_cam').checked
    };
  }

  applyBtn.onclick = () => { applyPrefs(readPrefsFromUI()); panel.openClose?.(); };
  resetBtn.onclick = () => { const d=getDefaults(); saveDoachPrefs(d); applyPrefs(d); panel.openClose?.(); };

  panel.setBody(body);
  panel.open();
}

// expose for menu item
window.openPreferencesPanel = openPreferencesPanel;

