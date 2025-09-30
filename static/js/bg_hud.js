// bg_hud.js -- diagnostic HUD for the background plane (FBF)
// Provides live stats, ball detection log, mini-map, and diagnostic controls.

(function installBGHud(){
  if (window.__BG_HUD_INSTALLED) return; window.__BG_HUD_INSTALLED = true;

  function createStyles(){
    if (document.getElementById('bgHudControlStyles')) return;
    const st = document.createElement('style');
    st.id = 'bgHudControlStyles';
    st.textContent = [
      '#bgHud{backdrop-filter:blur(10px);}',
      '#bgHud .bgHudControls{margin-top:8px;display:flex;flex-direction:column;gap:6px;}',
      '#bgHud .bgHudGroup{display:flex;flex-wrap:wrap;gap:4px;align-items:center;}',
      '#bgHud .bgHudGroup label{font-weight:600;font-size:11px;opacity:0.78;margin-right:2px;}',
      '#bgHud .bgHudControls button{padding:3px 6px;border-radius:4px;border:1px solid rgba(255,255,255,0.32);',
      'background:rgba(255,255,255,0.08);color:#fff;font:600 11px system-ui, sans-serif;cursor:pointer;pointer-events:auto;}',
      '#bgHud .bgHudControls button.bg-on{background:#24d05a;color:#111;border-color:#24d05a;}',
      '#bgHud .bgHudControls button:active{transform:translateY(1px);}',
      '#bgHud .bgHudControls button:focus{outline:1px solid rgba(255,255,255,0.35);outline-offset:1px;}',
      '#bgHud canvas.bgHudMini{margin-top:6px;width:100%;height:140px;border-radius:6px;border:1px solid rgba(255,255,255,0.18);',
      'background:rgba(255,255,255,0.03);pointer-events:none;box-shadow:inset 0 0 0 1px rgba(0,0,0,0.18);}',
      '#bgHud .bgHudLog{margin-top:6px;padding:6px;border-radius:6px;background:rgba(0,0,0,0.35);font:500 10px/1.35 monospace;',
      'max-height:160px;overflow:auto;color:#d8f9ff;white-space:pre-wrap;pointer-events:auto;}',
      '#bgHud .bgHudLog span.event{color:#ffd166;}',
      '#bgHud .bgHudLog span.warn{color:#ff8c69;}'
    ].join('');
    document.head.appendChild(st);
  }
  createStyles();

  const hud = document.createElement('div');
  hud.id = 'bgHud';
  Object.assign(hud.style, {
    position: 'fixed', right: '12px', top: '12px', zIndex: 10080,
    background: 'rgba(0,0,0,0.78)', color: '#fff',
    font: '600 12px system-ui, sans-serif', padding: '8px 10px',
    borderRadius: '10px', pointerEvents: 'none', minWidth: '220px', maxWidth: '280px',
    boxShadow: '0 16px 40px rgba(0,0,0,0.42)'
  });

  hud.innerHTML = [
    '<div style="margin-bottom:4px">BG Plane</div>',
    '<div id="bg_f">f: -</div>',
    '<div id="bg_rel">release: -</div>',
    '<div id="bg_enter">enter: -</div>',
    '<div id="bg_exit">exit: -</div>',
    '<div id="bg_arc">arc pts: 0</div>',
    '<div id="bg_arcRef">arc refined: 0</div>',
    '<div id="bg_below">below ok: -</div>',
    '<div id="bg_session">session: -</div>',
    '<div id="bg_overlay">overlay: -</div>',
    '<div id="bg_bgloop">bg sampler: -</div>',
    '<div id="bg_analyzer">analyzer: -</div>',
    '<div id="bg_detect">detect src: -</div>',
    '<div id="bg_objs">objects: 0</div>',
    '<div id="bg_trail">ball trail: 0</div>',
    '<div class="bgHudControls" id="bg_controls">',
    '  <div class="bgHudGroup"><label>Overlay</label>',
    '    <button data-action="overlay-live">Live</button>',
    '    <button data-action="overlay-coach">Coach</button>',
    '    <button data-action="overlay-debug">Debug</button>',
    '    <button data-action="overlay-arc">Arc</button>',
    '  </div>',
    '  <div class="bgHudGroup"><label>BG</label>',
    '    <button data-action="bg-start">Start</button>',
    '    <button data-action="bg-stop">Stop</button>',
    '  </div>',
    '  <div class="bgHudGroup"><label>Analyzer</label>',
    '    <button data-action="an-start">Start</button>',
    '    <button data-action="an-stop">Stop</button>',
    '    <button data-action="an-step">Step</button>',
    '  </div>',
    '  <div class="bgHudGroup"><label>Tools</label>',
    '    <button data-action="snapshot">Snapshot</button>',
    '    <button data-action="pose">Pose</button>',
    '  </div>',
    '  <div class="bgHudGroup"><label>Diag</label>',
    '    <button data-action="diag-toggle">Toggle</button>',
    '  </div>',
    '</div>',
    '<canvas id="bg_mini" class="bgHudMini" width="220" height="140"></canvas>',
    '<div class="bgHudLog" id="bg_log">(no detections yet)</div>'
  ].join('');
  document.body.appendChild(hud);

  const controlsBox = hud.querySelector('#bg_controls');
  if (controlsBox) {
    controlsBox.style.pointerEvents = 'auto';
    controlsBox.addEventListener('click', (evt) => evt.stopPropagation());
  }
  const logBox = document.getElementById('bg_log');
  let logAutoStick = true;
  if (logBox) {
    logBox.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
    logBox.addEventListener('scroll', () => {
      const nearBottom = (logBox.scrollTop + logBox.clientHeight) >= (logBox.scrollHeight - 6);
      logAutoStick = nearBottom;
    }, { passive: true });
  }

  let diagCanvas = null;
  let diagCtx = null;
  let diagParent = null;
  let diagVideo = null;
  let diagSizeKey = '';

  function ensureDiagCanvas(video) {
    if (!video) return;
    if (!diagCanvas) {
      diagVideo = video;
      diagCanvas = document.createElement('canvas');
      diagCanvas.id = 'bgDiagCanvas';
      diagCanvas.style.position = 'absolute';
      diagCanvas.style.top = '0';
      diagCanvas.style.left = '0';
      diagCanvas.style.width = '100%';
      diagCanvas.style.height = '100%';
      diagCanvas.style.pointerEvents = 'none';
      diagCanvas.style.zIndex = '60';
      diagParent = video.parentElement || document.body;
      if (diagParent && getComputedStyle(diagParent).position === 'static') {
        diagParent.style.position = 'relative';
      }
      if (diagParent) diagParent.insertBefore(diagCanvas, video);
      diagCtx = diagCanvas.getContext('2d');
    }
    syncDiagCanvasSize(video);
    try { video.style.visibility = 'hidden'; } catch {}
    diagVideo = video;
  }

  function syncDiagCanvasSize(video) {
    if (!diagCanvas || !video) return;
    const vw = video.videoWidth || video.clientWidth || diagCanvas.width || 0;
    const vh = video.videoHeight || video.clientHeight || diagCanvas.height || 0;
    if (!vw || !vh) return;
    const key = vw + 'x' + vh;
    if (diagSizeKey === key) return;
    diagSizeKey = key;
    diagCanvas.width = vw;
    diagCanvas.height = vh;
  }

  function drawDiagFrame(video) {
    if (!diagCanvas || !diagCtx || !video) return;
    syncDiagCanvasSize(video);
    try { diagCtx.drawImage(video, 0, 0, diagCanvas.width, diagCanvas.height); } catch {}
  }

  function removeDiagCanvas(video) {
    const target = video || diagVideo || document.getElementById('videoPlayer');
    if (diagCanvas) {
      try { diagCanvas.remove(); } catch {}
      diagCanvas = null;
      diagCtx = null;
      diagParent = null;
      diagVideo = null;
      diagSizeKey = '';
    }
    if (target) {
      try { target.style.visibility = ''; } catch {}
    }
  }

  function canonHoopLocal(H){
    try { if (typeof window.canonHoop === 'function') return window.canonHoop(H); } catch {}
    if (!H) return null;
    const w = Math.max(1, H.w ?? H.width ?? ((H.x2 ?? 0) - (H.x1 ?? 0)));
    const h = Math.max(1, H.h ?? H.height ?? ((H.y2 ?? 0) - (H.y1 ?? 0)));
    const cx = Number.isFinite(H.cx) ? H.cx : (Number.isFinite(H.x) ? H.x + w / 2 : 0);
    const cy = Number.isFinite(H.cy) ? H.cy : (Number.isFinite(H.y) ? H.y + h / 2 : 0);
    return { cx, cy, w, h, rimTop: cy - h / 2 };
  }

  function makeProxRect(Hc){
    if (!Hc) return null;
    const px = Number(window.proxX ?? 200);
    const pyAbove = Number(window.proxYAbove ?? 170);
    const pyBelow = Number(window.proxYBelow ?? 100);
    return {
      x: Hc.cx - px,
      y: Hc.rimTop - pyAbove,
      w: px * 2,
      h: pyAbove + pyBelow,
      yBot: Hc.rimTop + pyBelow
    };
  }

  function nowArcPoints(){
    try {
      const t = (window.ballArc && Array.isArray(window.ballArc.trail)) ? window.ballArc.trail : [];
      return t.length || 0;
    } catch { return 0; }
  }

  function exitBelowCheck(){
    try {
      const H = (window.getLockedHoopBox?.()) || null; if (!H) return '-';
      const C = canonHoopLocal(H); if (!C) return '-';
      const rimBottom = C.rimTop + C.h;
      const margin = Number(window.EXIT_BELOW_MARGIN || 12);
      const pts = (window.ballArc && Array.isArray(window.ballArc.trail)) ? window.ballArc.trail : [];
      if (!pts.length) return '-';
      const last = pts[pts.length - 1];
      const ok = (last && Number.isFinite(last.y)) ? (last.y > (rimBottom + margin)) : false;
      return ok ? 'yes' : 'no';
    } catch { return '-'; }
  }

  function text(id, v){ const el = document.getElementById(id); if (el) el.textContent = v; }

  const logState = {
    active: false,
    entries: [],
    releaseFrame: null,
    stopFrame: null,
    dirty: true,
    notedLive: false,
  };

  function pushLog(entry) {
    if (!entry) return;
    logState.entries.push(entry);
    if (logState.entries.length > 160) logState.entries.splice(0, logState.entries.length - 160);
    logState.dirty = true;
  }

  function startLog(label, frame) {
    logState.active = true;
    logState.releaseFrame = Number.isFinite(frame) ? frame : (window.ballState?.releaseFrame ?? null);
    logState.stopFrame = null;
    logState.entries = [];
    pushLog({ type: 'event', frame: logState.releaseFrame ?? '-', label: label || 'release' });
  }

  function stopLog(label, frame) {
    if (!logState.active) return;
    logState.active = false;
    logState.stopFrame = Number.isFinite(frame) ? frame : (logState.stopFrame ?? frame ?? null);
    pushLog({ type: 'event', frame: frame ?? '-', label: label || 'stop' });
  }

  function detectSourceLabel(){
    try {
      if (window.__forceServerDetect) return 'server';
      if (window.__detWorker && window.__detReady) return 'worker';
      return window.__detCache?._source || '-';
    } catch { return '-'; }
  }

  let diagTimer = null;
  function diagStepLoopStart(video, fps){
    diagStepLoopStop();
    if (!video) return;
    const stepSeconds = 1 / Math.max(1, fps || 10);
    const interval = Math.max(40, Math.round(1000 / Math.max(1, fps || 10)));
    diagTimer = setInterval(() => {
      try {
        if (video.srcObject) {
          ensureDiagCanvas(video);
          drawDiagFrame(video);
        } else {
          if (video.paused) {
            const dur = Number(video.duration) || Infinity;
            const next = Math.min((video.currentTime || 0) + stepSeconds, dur - 0.001);
            if (Number.isFinite(next) && next > (video.currentTime || 0)) {
              video.currentTime = next;
            }
          }
        }
      } catch {}
      try { window.dispatchEvent(new Event('analyzer:step')); } catch {}
    }, interval);
  }

  function diagStepLoopStop(){
    if (diagTimer) {
      try { clearInterval(diagTimer); } catch {}
      diagTimer = null;
    }
    if (diagVideo) {
      removeDiagCanvas(diagVideo);
      diagVideo = null;
    }
  }

  function activateDiagnostics(auto = false) {
    if (window.__BG_DIAG_ACTIVE) return true;
    window.__BG_DIAG_ACTIVE = true;
    logState.notedLive = false;
    try { window.DOACH_OVERLAY_TRACE = true; window.FORCE_POSE_DRAW = true; window.ARC_TRIM_TOP = false; } catch {}
    try { window.setOverlayMode?.('debug'); } catch {}
    try { window.startBgSampler?.({ fps: Number(window.__BG_FPS) || 10 }); } catch {}
    const v = document.getElementById('videoPlayer');
    if (v) {
      if (!v.srcObject) {
        try { v.pause(); } catch {}
        diagStepLoopStart(v, Number(window.__BG_FPS) || 10);
        try { window.startFrameAnalysis?.(); } catch {}
      } else {
        logState.notedLive = true;
        ensureDiagCanvas(v);
        diagStepLoopStart(v, Number(window.__BG_FPS) || 10);
        pushLog({ type: 'event', frame: '-', label: 'diag:live-stream' });
      }
    }
    pushLog({ type: 'event', frame: '-', label: auto ? 'diag:auto-on' : 'diag:on' });
    return true;
  }

  function deactivateDiagnostics() {
    if (!window.__BG_DIAG_ACTIVE) return false;
    window.__BG_DIAG_ACTIVE = false;
    diagStepLoopStop();
    try { window.DOACH_OVERLAY_TRACE = false; window.FORCE_POSE_DRAW = false; } catch {}
    const mode = window.__SESSION_ACTIVE ? 'coach' : 'live';
    try { window.setOverlayMode?.(mode); } catch {}
    const v = document.getElementById('videoPlayer');
    if (v) {
      if (!v.srcObject) {
        try { v.play(); } catch {}
      }
      removeDiagCanvas(v);
    }
    pushLog({ type: 'event', frame: '-', label: 'diag:off' });
    logState.notedLive = false;
    return true;
  }

  function bind(action, handler){
    try {
      const btn = controlsBox?.querySelector(`[data-action="${action}"]`);
      if (!btn) return;
      btn.addEventListener('click', (evt) => {
        evt.preventDefault(); evt.stopPropagation();
        try {
          const out = handler?.();
          if (out && typeof out.then === 'function') out.catch((err) => console.warn('[bgHud] action failed:', action, err));
        } catch (err) {
          console.warn('[bgHud] action failed:', action, err);
        }
      });
    } catch {}
  }

  bind('overlay-live', () => { try { window.setOverlayMode?.('live'); } catch {} });
  bind('overlay-coach', () => { try { window.setOverlayMode?.('coach'); } catch {} });
  bind('overlay-debug', () => { try { window.setOverlayMode?.('debug'); window.DOACH_OVERLAY_TRACE = true; } catch {} });
  bind('overlay-arc', () => { try { window.setOverlayMode?.('arc-only'); } catch {} });

  bind('bg-start', () => { try { window.startBgSampler?.({}); } catch {} });
  bind('bg-stop', () => { try { window.stopBgSampler?.(); } catch {} });

  bind('an-start', () => { try { window.startFrameAnalysis?.(); } catch {} });
  bind('an-stop', () => { try { window.stopFrameAnalysis?.(); } catch {} });
  bind('an-step', () => { try { window.dispatchEvent(new Event('analyzer:step')); } catch {} });

  bind('snapshot', () => {
    try {
      const payload = {
        frame: window.lastDetectedFrame?.__frameIdx ?? null,
        overlayMode: window.__overlayMode ?? null,
        sessionActive: window.__SESSION_ACTIVE === true,
        bgSampler: window.__BG_LOOP_ON === true,
        analyzerActive: window.__analyzerActive === true,
        detSource: detectSourceLabel(),
        ballState: window.ballState || null,
        arcTrail: window.ballArc?.trail || [],
        refinedTrail: window.ballArc?.refinedTrail || [],
        diag: window.__BG_DIAG_ACTIVE === true,
        log: [...logState.entries],
        fbf: window.__fbf || null
      };
      console.groupCollapsed('[bgHud] snapshot');
      console.log(payload);
      console.groupEnd();
    } catch (err) {
      console.warn('[bgHud] snapshot failed:', err);
    }
  });

  bind('pose', async () => {
    try {
      const res = await (window.poseDetectSerial?.() || Promise.resolve(null));
      console.log('[bgHud] pose sample', res);
      return res;
    } catch (err) {
      console.warn('[bgHud] pose sample failed:', err);
    }
  });

  bind('diag-toggle', () => {
    if (window.__BG_DIAG_ACTIVE) return deactivateDiagnostics();
    return activateDiagnostics(false);
  });

  const urlHasDiag = /[?&]__diag(?:=1)?/i.test(location.search || '');
  if (urlHasDiag || window.__BG_ONLY === true) activateDiagnostics(true);

  window.addEventListener('shot:release', (e) => startLog('shot:release', e?.detail?.frame), { passive: true });
  window.addEventListener('shot:end', (e) => stopLog('shot:end', e?.detail?.frame), { passive: true });
  window.addEventListener('shot:summary', (e) => stopLog('shot:summary', e?.detail?.frame), { passive: true });
  window.addEventListener('fbf:start', (e) => pushLog({ type: 'event', frame: e?.detail?.frame ?? '-', label: 'fbf:start' }), { passive: true });
  window.addEventListener('fbf:stop', (e) => pushLog({ type: 'event', frame: e?.detail?.frame ?? '-', label: 'fbf:stop' }), { passive: true });

  function currentOverlayMode(){
    try {
      const raw = window.__overlayMode || (window.__SESSION_ACTIVE ? 'coach' : 'live');
      return String(raw || '').toLowerCase() || '-';
    } catch { return '-'; }
  }

  function processDetections(frameIdx, proxRect, objects){
    if (!logState.active) return;
    if (!Array.isArray(objects) || !objects.length) return;
    const balls = objects.filter(o => {
      const lbl = (o?.label || o?.name || o?.class || '').toLowerCase();
      return lbl.includes('ball');
    });
    if (!balls.length) return;
    for (const det of balls) {
      const box = Array.isArray(det.box) ? det.box : null;
      if (!box || box.length < 4) continue;
      const cx = (Number(box[0]) + Number(box[2])) / 2;
      const cy = (Number(box[1]) + Number(box[3])) / 2;
      if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;
      const conf = Number(det.conf ?? det.score ?? det.confidence ?? det.p ?? det.prob ?? NaN);
      let inProx = null;
      if (proxRect) {
        inProx = (cx >= proxRect.x && cx <= proxRect.x + proxRect.w && cy >= proxRect.y && cy <= proxRect.y + proxRect.h);
      }
      pushLog({ type: 'det', frame: frameIdx, x: cx, y: cy, inProx, conf: Number.isFinite(conf) ? conf : null });
    }
  }

  function renderLogBox(){
    if (!logState.dirty) return;
    logState.dirty = false;
    if (!logBox) return;
    if (!logState.entries.length) {
      logBox.innerHTML = '(no detections yet)';
      return;
    }
    const lines = logState.entries.slice(-80).map((e) => {
      if (e.type === 'event') {
        return `<span class="event">[${e.frame ?? '-'}] ${e.label}</span>`;
      }
      const flag = e.inProx == null ? '?' : (e.inProx ? 'IN' : 'out');
      const conf = Number.isFinite(e.conf) ? ` c${e.conf.toFixed(2)}` : '';
      return `f${e.frame} ${flag} (${e.x.toFixed(1)},${e.y.toFixed(1)})${conf}`;
    });
    logBox.innerHTML = lines.join('\n');
    if (logAutoStick) {
      logBox.scrollTop = logBox.scrollHeight;
    }
  }

  function renderMiniMap(Hc, proxRect){
    const canvas = document.getElementById('bg_mini');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(10,15,22,0.55)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (!Hc || !proxRect) {
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.font = '11px system-ui';
      ctx.fillText('No hoop/ROI', 10, 20);
      return;
    }

    const scale = Math.min(canvas.width / proxRect.w, canvas.height / proxRect.h);
    const offX = (canvas.width - proxRect.w * scale) / 2;
    const offY = (canvas.height - proxRect.h * scale) / 2;
    const mapX = (x) => (x - proxRect.x) * scale + offX;
    const mapY = (y) => (y - proxRect.y) * scale + offY;

    ctx.strokeStyle = 'rgba(0,200,255,0.8)';
    ctx.lineWidth = 2;
    ctx.strokeRect(offX, offY, proxRect.w * scale, proxRect.h * scale);

    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    ctx.arc(mapX(Hc.cx), mapY(Hc.cy), 4, 0, Math.PI * 2);
    ctx.fill();

    const bs = window.ballState || {};
    const arcRaw = window.ballArc && Array.isArray(window.ballArc.trail) ? window.ballArc.trail : [];
    const arcRef = window.ballArc && Array.isArray(window.ballArc.refinedTrail) ? window.ballArc.refinedTrail : null;
    const trail = Array.isArray(bs.trail) ? bs.trail : [];
    const releaseFrame = Number.isFinite(logState.releaseFrame) ? logState.releaseFrame : (Number.isFinite(bs.releaseFrame) ? bs.releaseFrame : null);
    const stopFrame = Number.isFinite(logState.stopFrame) ? logState.stopFrame : (Number.isFinite(bs.proxExitFrame) ? bs.proxExitFrame : null);

    const arcPoints = (arcRef && arcRef.length ? arcRef : arcRaw).filter(p => {
      if (!Number.isFinite(p?.x) || !Number.isFinite(p?.y)) return false;
      if (releaseFrame != null && Number.isFinite(p.frame)) return p.frame >= releaseFrame - 1;
      return true;
    });

    if (arcPoints.length) {
      ctx.strokeStyle = 'rgba(255,215,60,0.9)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(mapX(arcPoints[0].x), mapY(arcPoints[0].y));
      for (let i = 1; i < arcPoints.length; i++) ctx.lineTo(mapX(arcPoints[i].x), mapY(arcPoints[i].y));
      ctx.stroke();
    }

    if (trail.length) {
      const recent = trail.slice(-60);
      ctx.strokeStyle = 'rgba(186,130,255,0.55)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(mapX(recent[0].x), mapY(recent[0].y));
      for (let i = 1; i < recent.length; i++) ctx.lineTo(mapX(recent[i].x), mapY(recent[i].y));
      ctx.stroke();
    }

    if (releaseFrame != null) {
      ctx.fillStyle = 'rgba(255,90,90,0.9)';
      const rel = arcPoints.find(p => Number.isFinite(p.frame) && p.frame >= releaseFrame) || trail.find(p => Number.isFinite(p.frame) && p.frame >= releaseFrame);
      if (rel) { ctx.beginPath(); ctx.arc(mapX(rel.x), mapY(rel.y), 3, 0, Math.PI * 2); ctx.fill(); }
    }

    if (stopFrame != null) {
      ctx.fillStyle = 'rgba(80,220,120,0.9)';
      const exit = arcPoints.find(p => Number.isFinite(p.frame) && p.frame >= stopFrame) || trail.find(p => Number.isFinite(p.frame) && p.frame >= stopFrame);
      if (exit) { ctx.beginPath(); ctx.arc(mapX(exit.x), mapY(exit.y), 3, 0, Math.PI * 2); ctx.fill(); }
    }

    const dets = logState.entries.filter(e => e.type === 'det');
    if (dets.length) {
      for (const det of dets) {
        if (!Number.isFinite(det.x) || !Number.isFinite(det.y)) continue;
        const isOut = det.inProx === false;
        ctx.fillStyle = isOut ? 'rgba(255,110,110,0.75)' : 'rgba(0,255,200,0.85)';
        ctx.beginPath();
        ctx.arc(mapX(det.x), mapY(det.y), 2.3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  function ensureLogActiveFromState(bs){
    try {
      const rel = Number.isFinite(bs?.releaseFrame) ? bs.releaseFrame : null;
      if (rel != null && (!logState.active || logState.releaseFrame !== rel)) {
        startLog('release@state', rel);
      }
      if (logState.active && Number.isFinite(bs?.proxExitFrame)) {
        logState.stopFrame = bs.proxExitFrame;
      }
      if (!Number.isFinite(bs?.releaseFrame) && !Number.isFinite(logState.releaseFrame) && logState.active) {
        stopLog('release-cleared', bs?.proxExitFrame ?? null);
      }
    } catch {}
  }

  function tick(){
    try {
      const f = (window.lastDetectedFrame && Number.isFinite(window.lastDetectedFrame.__frameIdx)) ? window.lastDetectedFrame.__frameIdx : '-';
      const bs = (window.ballState || {});
      ensureLogActiveFromState(bs);
      const objs = window.lastDetectedFrame?.objects;

      const hoop = window.getLockedHoopBox?.() || null;
      const Hc = canonHoopLocal(hoop);
      const proxRect = makeProxRect(Hc);
      if (Number.isFinite(f)) processDetections(f, proxRect, objs);

      const overlayMode = currentOverlayMode();
      const sessionState = window.__SESSION_ACTIVE === true ? 'active' : 'idle';
      const arcRawLen = window.ballArc && Array.isArray(window.ballArc.trail) ? window.ballArc.trail.length : 0;
      const arcRefLen = window.ballArc && Array.isArray(window.ballArc.refinedTrail) ? window.ballArc.refinedTrail.length : 0;
      const trailLen = Array.isArray(bs.trail) ? bs.trail.length : (Array.isArray(window.ballState?.trail) ? window.ballState.trail.length : 0);

      text('bg_f', `f: ${f}`);
      text('bg_rel', `release: ${bs.releaseFrame ?? '-'}`);
      text('bg_enter', `enter: ${bs.proxEnterFrame ?? '-'}`);
      text('bg_exit', `exit: ${bs.proxExitFrame ?? '-'}`);
      text('bg_arc', `arc pts: ${arcRawLen}`);
      text('bg_arcRef', `arc refined: ${arcRefLen}`);
      text('bg_below', `below ok: ${exitBelowCheck()}`);
      text('bg_session', `session: ${sessionState}`);
      text('bg_overlay', `overlay: ${overlayMode}`);
      text('bg_bgloop', `bg sampler: ${window.__BG_LOOP_ON === true ? 'on' : 'off'}`);
      text('bg_analyzer', `analyzer: ${window.__analyzerActive === true ? 'on' : 'off'}`);
      text('bg_detect', `detect src: ${detectSourceLabel()}`);
      text('bg_objs', `objects: ${Array.isArray(objs) ? objs.length : 0}`);
      text('bg_trail', `ball trail: ${trailLen}`);

      highlight('overlay-live', overlayMode === 'live');
      highlight('overlay-coach', overlayMode === 'coach');
      highlight('overlay-debug', overlayMode === 'debug');
      highlight('overlay-arc', overlayMode === 'arc-only');
      highlight('bg-start', window.__BG_LOOP_ON === true);
      highlight('bg-stop', window.__BG_LOOP_ON !== true);
      highlight('an-start', window.__analyzerActive === true);
      highlight('an-stop', window.__analyzerActive !== true);
      highlight('diag-toggle', window.__BG_DIAG_ACTIVE === true);

      renderLogBox();
      renderMiniMap(Hc, proxRect);
    } catch {}
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
})();














