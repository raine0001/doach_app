// video_ui.js — UI only. iOS-safe. No cap enforcement, no auto-end, no recording, no server writes.
// Owns: HUD, prompts, camera switcher, summary table rendering, UI updates from events.
// Exposes: showPromptMessage, ensureHudRoot, mountSessionHUD, updateSessionHUD, renderFullShotTable,
//          autoEndSessionAndSummarize (callable, not auto-triggered).

import { setOverlayInteractive, syncOverlayToVideo } from './fix_overlay_display.js';
import { speak } from './coach_voice.js';
import { enableHoopPickOnce } from './app.js';
import { getLockedHoopBox, handleHoopSelection, canonHoop } from './hoop_tracker.js';

// Soft demo toggles (ignored by logic that could conflict)
window.DEMO = true;
window.DEMO_MINIMAL_TABLE = true;

// Make these helpers reachable to other modules
window.getLockedHoopBox = getLockedHoopBox;
window.handleHoopSelection = handleHoopSelection;

/* ----------------------- iOS viewport + basics ----------------------- */
(function installMobileViewportFixes(){
  let tag = document.querySelector('meta[name="viewport"]');
  if (!tag) { tag = document.createElement('meta'); tag.name = 'viewport'; document.head.appendChild(tag); }
  tag.setAttribute('content', [
    'width=device-width',
    'initial-scale=1',
    'maximum-scale=1',
    'viewport-fit=cover',
    'user-scalable=no'
  ].join(','));

  if (!document.getElementById('doach-mobile-css')) {
    const css = document.createElement('style');
    css.id = 'doach-mobile-css';
    css.textContent = `
      html, body { margin:0; padding:0; height:100%; background:#000; overscroll-behavior:none; }
      .session-container, #videoPlayer { width:100%; height:100svh; object-fit:cover; }
      #hudRoot { inset: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); }
      .hud-card, .hud-pill { -webkit-tap-highlight-color: transparent; }
      button.vc-btn { font: 600 12px system-ui; border-radius: 10px; padding: 6px 10px; }
    `;
    document.head.appendChild(css);
  }

  window.addEventListener('load', () => {
    const v = document.getElementById('videoPlayer');
    if (v) { v.setAttribute('playsinline',''); v.muted = true; }
  });
})();

/* ---------------------------- HUD root ----------------------------- */
export function ensureHudRoot() {
  const video = document.getElementById('videoPlayer');
  const host  = video?.parentElement || document.body;
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';

  let root = document.getElementById('hudRoot');
  if (!root) {
    root = document.createElement('div');
    root.id = 'hudRoot';
    host.appendChild(root);
  }
  Object.assign(root.style, { position:'absolute', inset:'0', pointerEvents:'none', zIndex:10000 });
  return root;
}
window.ensureHudRoot = ensureHudRoot;

/* ----------------------------- Prompts ----------------------------- */
function getPromptEl() {
  const root = ensureHudRoot();
  let el = document.getElementById('overlayPrompt') || document.getElementById('promptBar');
  if (!el) {
    el = document.createElement('div');
    el.id = 'promptBar';
    root.appendChild(el);
  } else if (!root.contains(el)) {
    root.appendChild(el);
  }
  Object.assign(el.style, {
    position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
    background: 'rgba(0,0,0,0.75)', color: '#fff', padding: '18px 28px',
    borderRadius: '18px', font: '700 20px/1.4 system-ui, sans-serif',
    textAlign: 'center', minWidth: '320px',
    display: 'none', pointerEvents: 'none', zIndex: '10001',
    boxShadow: '0 12px 30px rgba(0,0,0,0.35)'
  });
  return el;
}

export function showPromptMessage(text, duration = 3000) {
  const el = getPromptEl();
  el.textContent = text;
  el.style.display = 'block';
  el.style.opacity = '1';
  clearTimeout(el.__t);
  el.__t = setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => (el.style.display = 'none'), 300);
  }, duration);
}
window.showPromptMessage = showPromptMessage;

function hidePromptMessage() {
  const el = document.getElementById('overlayPrompt') || document.getElementById('promptBar');
  if (!el) return;
  clearTimeout(el.__t);
  el.style.display = 'none';
}

/* ----------------------------- HUD bar ----------------------------- */
const ICON_AUDIO_ON = '\u{1F50A}';
const ICON_AUDIO_OFF = '\u{1F507}';
const ICON_CAMERA_FRONT = '\u{1F4F8}';
const ICON_CAMERA_BACK = '\u{1F4F7}';
const ICON_CAMERA_SWITCH = '\u{1F503}';
const SYMBOL_INFINITY = '\u{221E}';

function formatCapDisplay(cap) {
  const n = Number(cap);
  return (Number.isFinite(n) && n > 0) ? String(n) : SYMBOL_INFINITY;
}
function currentFacingLabel() {
  try {
    const f = (localStorage.getItem('doach_camera_facing') || '').toLowerCase();
    if (f === 'user' || f === 'front') return 'Front';
    if (f === 'environment' || f === 'back' || f === 'rear') return 'Back';
  } catch {}
  return 'Back';
}
function formatHudCameraLabel(lab) {
  return ((lab === 'Back') ? ICON_CAMERA_BACK : ICON_CAMERA_FRONT) + ' ' + lab + ' Camera';
}

export function mountSessionHUD() {
  const root = ensureHudRoot();
  let bar = document.getElementById('sessionHUD');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'sessionHUD';
    bar.className = 'hud-card hud-pill';
    Object.assign(bar.style, {
      position:'absolute', left:'50%', transform:'translateX(-50%)',
      bottom:'18px', gap:'20px', pointerEvents:'auto'
    });

    bar.innerHTML = `
      <button id="hudMute" class="vc-btn" title="Mute/Unmute"></button>
      <button id="hudCamFlip" class="vc-btn" title="Flip Camera"></button>
      <div class="hud-metric" id="mShots"><div class="num">0/${formatCapDisplay(window.SESSION_SIZE)}</div><div class="label">Shots Taken</div></div>
      <div class="hud-metric" id="mTime"><div class="num">0:00</div><div class="label">Time Elapsed</div></div>
    `;
    root.appendChild(bar);

    const muteBtn = bar.querySelector('#hudMute');
    const camBtn  = bar.querySelector('#hudCamFlip');

    // Voice toggle
    const applyMute = (muted) => {
      muteBtn.setAttribute('data-muted', muted ? '1' : '0');
      muteBtn.textContent = muted ? ICON_AUDIO_OFF + ' Voice Off' : ICON_AUDIO_ON + ' Voice On';
      try { localStorage.setItem('doach_muted', JSON.stringify(muted)); } catch {}
      const ev = new CustomEvent('hud:mute-toggle', { detail: { muted } });
      try { window.dispatchEvent(ev); } catch {}
    };
    let savedMuted = false;
    try { if (localStorage.getItem('doach_muted') != null) savedMuted = JSON.parse(localStorage.getItem('doach_muted')); } catch {}
    applyMute(savedMuted);
    muteBtn.addEventListener('click', (e) => { e.stopPropagation(); applyMute(muteBtn.getAttribute('data-muted') !== '1'); });

    // Camera flip
    const updateHudCamButton = () => { camBtn.textContent = formatHudCameraLabel(currentFacingLabel()); };
    updateHudCamButton();
    window.addEventListener('camera:facing-changed', updateHudCamButton);

    camBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        const cur = (localStorage.getItem('doach_camera_facing') || 'environment').toLowerCase();
        const next = (cur === 'user' || cur === 'front') ? 'environment' : 'user';
        localStorage.setItem('doach_camera_facing', next);
        if (typeof window.setPreferredFacing === 'function') await window.setPreferredFacing(next);
        else if (typeof window.flipCamera === 'function') await window.flipCamera();
      } catch (err) {
        console.warn('[hud] flip camera failed', err);
      } finally {
        updateHudCamButton();
      }
    });
  }
  return bar;
}
window.mountSessionHUD = mountSessionHUD;

export function updateSessionHUD({ taken=0, made=0, accuracy=0, elapsedSec=0 } = {}) {
  const bar = mountSessionHUD();
  const $ = (id) => bar.querySelector(`#${id} .num`);
  const mm = Math.floor(elapsedSec / 60);
  const ss = Math.floor(elapsedSec % 60).toString().padStart(2,'0');

  // Use FINALIZED rows only, never overlay pulses
  try {
    const list = Array.isArray(window.__shotList) ? window.__shotList : [];
    const finalized = list.filter(s => s && s.pending === false).length;
    taken = Math.max(Number(taken||0), finalized);
  } catch {}

  const elShots = $('mShots');
  const elTime  = $('mTime');
  if (elShots) elShots.textContent = `${taken}/${(Number(window.SESSION_SIZE)||'∞')}`;
  if (elTime)  elTime.textContent  = `${mm}:${ss}`;
}
window.updateSessionHUD = updateSessionHUD;

/* ------------------------ Camera switcher UI ------------------------ */
(function installCameraSwitcher(){
  if (window.__cameraSwitcherInstalled) return; window.__cameraSwitcherInstalled = true;

  function formatCameraFacing(label) {
    return ((label === 'Back') ? ICON_CAMERA_BACK : ICON_CAMERA_FRONT) + ' ' + label;
  }
  function readPref(){ try { return localStorage.getItem('cam_facing') || 'Back'; } catch { return 'Back'; } }
  function writePref(v){
    try { localStorage.setItem('cam_facing', v); } catch {}
    try { localStorage.setItem('doach_camera_facing', v === 'Back' ? 'environment' : 'user'); } catch {}
  }

  function stopStream(){
    const v = document.getElementById('videoPlayer');
    const s = v && v.srcObject;
    if (s?.getTracks) s.getTracks().forEach(t=>{ try{ t.stop(); }catch{} });
    if (v) v.srcObject = null;
  }
  function labelToFacing(label){ return (String(label).toLowerCase().startsWith('b')) ? 'environment' : 'user'; }

  async function startWithConstraints(cons){
    const v = document.getElementById('videoPlayer');
    if (!v) return false;
    try { v.setAttribute('playsinline',''); v.muted = true; } catch {}
    const stream = await navigator.mediaDevices.getUserMedia({ video: cons, audio: false });
    v.srcObject = stream;
    try { await v.play?.(); } catch {}
    try { syncOverlayToVideo?.(); } catch {}
    return true;
  }

  async function restartCamera(label){
    if (!navigator.mediaDevices?.getUserMedia) return false;
    // prefer facingMode path on iOS; deviceId after we learned labels
    try {
      stopStream();
      const facing = labelToFacing(label);
      const ok = await startWithConstraints({ facingMode: { exact: facing } });
      if (ok) return true;
    } catch {}
    try {
      stopStream();
      const ok = await startWithConstraints({ facingMode: labelToFacing(label) });
      if (ok) return true;
    } catch {}
    return false;
  }

  window.getCameraFacing = () => window.__CAM_FACING || readPref();
  window.setCameraFacing = async function(label){
    const current = window.getCameraFacing();
    const target  = (label === 'Front' || label === 'Back') ? label : (current === 'Back' ? 'Front' : 'Back');
    const ok = await restartCamera(target);
    if (ok) {
      window.__CAM_FACING = target;
      writePref(target);
      try {
        const hud = document.getElementById('hudCamFlip');
        if (hud) hud.textContent = formatHudCameraLabel(target);
      } catch {}
      try { window.dispatchEvent(new Event('camera:facing-changed')); } catch {}
      try { window.dispatchEvent(new CustomEvent('camera:changed', { detail:{ label: target }})); } catch {}
    }
    return ok;
  };

  // Legacy helpers to support older callsites expecting the previous camera API.
  window.setPreferredFacing = async function(pref){
    const facing = String(pref || '').toLowerCase();
    const label = (facing === 'user' || facing === 'front') ? 'Front' : 'Back';
    try {
      const ok = await window.setCameraFacing(label);
      return ok;
    } catch (err) {
      console.warn('[camera] setPreferredFacing failed', err);
      return false;
    }
  };

  window.flipCamera = async function(){
    try {
      const current = window.getCameraFacing();
      const target = current === 'Back' ? 'Front' : 'Back';
      return await window.setCameraFacing(target);
    } catch (err) {
      console.warn('[camera] flipCamera failed', err);
      return false;
    }
  };

  // Wrap startCamera so initial start honors preference
  (function wrapStartCamera(){
    const orig = window.startCamera;
    window.startCamera = async function(){
      const label = window.getCameraFacing();
      const ok = await restartCamera(label);
      if (!ok && typeof orig === 'function') return orig();
      return ok;
    };
  })();
})();

/* ------------------------ Session status badge ------------------------ */
export function setSessionStatus(text = '') {
  const root = ensureHudRoot();
  let badge = document.getElementById('sessionStatusBadge');
  if (!badge) {
    badge = document.createElement('div');
    badge.id = 'sessionStatusBadge';
    badge.className = 'hud-card';
    Object.assign(badge.style, {
      position:'absolute', bottom:'90px', left:'50%', transform:'translateX(-50%)',
      padding:'6px 10px', font:'600 12px system-ui', letterSpacing:'0.04em', pointerEvents:'none'
    });
    root.appendChild(badge);
  }
  badge.textContent = text || 'SESSION IN PROGRESS…';
  badge.style.display = text === null ? 'none' : 'block';
}
window.setSessionStatus = setSessionStatus;

/* ------------------------ Summary table (UI) ------------------------ */
const SHOT_SUMMARY_TEXT = {
  modalTitle: 'Shot Summary',
  finalizing: 'Finalizing...',
  exportCsv: 'Export CSV',
  close: 'Close',
  pending: 'Pending',
  noValue: '--',
  buttons: { make: 'Make', miss: 'Miss', replay: 'Replay', ai: 'AI Review' }
};

function ensureShotTableStyles(){
  if (document.getElementById('shotTableStyles')) return;
  const css = document.createElement('style');
  css.id = 'shotTableStyles';
  css.textContent = `
    #fullShotModal .hud-table{ width:100%; border-collapse:collapse; table-layout:fixed; }
    #fullShotModal .hud-table col#cNum{ width:42px; } #fullShotModal .hud-table col#cCoach{ width:auto; }
    #fullShotModal .hud-table col#cClip{ width:90px; text-align:center; }
    #fullShotModal .hud-table thead th{ position:sticky; top:0; background:rgba(0,0,0,0.85); z-index:2; backdrop-filter:blur(2px); }
    #fullShotModal .hud-table th, #fullShotModal .hud-table td{ padding:8px 10px; vertical-align:top; text-align:left; border-bottom:1px solid rgba(255,255,255,.12); }
    #fullShotModal .hud-table tbody tr:nth-child(even) td{ background:rgba(255,255,255,.03); }
    #fullShotModal td.num, #fullShotModal td.clip { text-align:center; }
    #fullShotModal td.coach{ white-space:normal; word-break:break-word; line-height:1.25; }
  `;
  document.head.appendChild(css);
}

function getClipHrefForShot(idx1Based, shot) {
 if (shot?.clip?.path) return shot.clip.path;
 try {
   const sid = window.__SESSION_ID;
   if (sid != null) return `/sessions/${sid}/clips/shot-${idx1Based}.webm`;
 } catch {}
 return null;
}

export function renderFullShotTable() {
  const list = (window.__shotList ||= []);
  const root = ensureHudRoot();
  const minimal = true; // skinny table only

  ensureShotTableStyles();
  let modal = document.getElementById('fullShotModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'fullShotModal';
    modal.className = 'hud-card';
    Object.assign(modal.style, {
      position:'absolute', left:'50%', transform:'translateX(-50%)', top:'12%',
      maxWidth:'74%', minWidth:'640px', zIndex:10020, pointerEvents:'auto',
      maxHeight:'78vh', overflowY:'auto', WebkitOverflowScrolling:'touch'
    });
    root.appendChild(modal);
  }

  modal.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
      <div style="font-weight:600; display:flex; align-items:center; gap:10px;">
        <span>Shot Summary (${list.length}/${formatCapDisplay(window.SESSION_SIZE)})</span>
        <span id="sessFinalBadge" style="display:none; padding:3px 8px; border-radius:10px; font:600 11px system-ui; background:#f59e0b; color:#111;">Finalizing…</span>
      </div>
      <div>
        <button id="closeFull" class="vc-btn">Close</button>
      </div>
    </div>
    <div id="sessReviewLine" style="display:none;opacity:.95;margin:4px 0 10px;line-height:1.35"></div>
    <table class="hud-table">
      <colgroup><col id="cNum"><col id="cCoach"><col id="cClip"></colgroup>
      <thead><tr><th>#</th><th>Coach Pose Assessment</th><th>Clip</th></tr></thead>
      <tbody></tbody>
    </table>
  `;

  const tbody = modal.querySelector('tbody');
  tbody.textContent = '';
  list.forEach((shot, idx) => {
    const coachSource = shot && !shot.pending
      ? (shot.doach || shot.coach || shot.coachText || shot.feedback || shot.summary || shot.text || '')
      : '';
    const coachText = coachSource ? coachSource : SHOT_SUMMARY_TEXT.pending;

    const tr = document.createElement('tr');
    tr.setAttribute('data-shot-idx', idx + 1);
    tr.innerHTML = `<td class="num">${idx + 1}</td><td class="coach"></td><td class="clip"></td>`;
    tr.querySelector('.coach').textContent = coachText;

    const tdClip = tr.querySelector('.clip');
    const href = getClipHrefForShot(idx + 1, shot);
    if (href) {
      const a = document.createElement('a'); a.href = href; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'clip';
      tdClip.appendChild(a);
    } else {
      const status = shot?.clip?.status;
      tdClip.textContent = status === 'recording' ? 'recording…' : 'processing…';
    }
    tbody.appendChild(tr);
  });

  modal.querySelector('#closeFull').onclick = () => { modal.style.display = 'none'; };
  modal.style.display = 'block';
  try { modal.style.zIndex = '10060'; } catch {}
  return modal;
}
window.renderFullShotTable = renderFullShotTable;

/* ------------------- UI sink for finalized shots ------------------- */
function computeTotals(list){
  const taken = list.length;
  const made  = list.filter(s => s.made).length;
  const acc   = taken ? (made / taken) * 100 : 0;
  return { taken, made, acc };
}

// Count finalized shots only
window.__finalizedShotIds ||= new Set();


// Record a finalized shot summary (UI only, no server)
window.recordShotSummary = function recordShotSummary(summary) {
  // de-dupe by shotId first
  const sid = Number(summary.shotId || 0);
  if (sid > 0) {
    if (window.__finalizedShotIds.has(sid)) return;
    window.__finalizedShotIds.add(sid);
  }

  // de-dupe minor repeats by value signature
  const key = `${sid||'?'}|${+!!summary.made}|${Math.round(summary.arcHeight||0)}|${summary.entryAngle}|${summary.releaseAngle}`;
  if (window.__lastShotKey === key) return;
  window.__lastShotKey = key;

  // carry coach and via
  if (!summary.doach && window.__lastCoachText) summary.doach = window.__lastCoachText;
  if (!summary.via) summary.via = window.__lastReleaseVia || summary.via || '';

  const list = (window.__shotList ||= []);
  let idx = sid;
  if (Number.isFinite(idx) && idx > 0) {
    while (list.length < idx) list.push({ pending: true });
    Object.assign(list[idx - 1], summary, { pending: false });
  } else {
    const p = list.findIndex(s => s?.pending === true);
    if (p !== -1) Object.assign(list[p], summary, { pending: false }), idx = p + 1;
    else list.push(Object.assign({ pending: false }, summary)), idx = list.length;
  }
  summary.__idx = idx;

  // If the skinny table is open, refresh the row
  const modal = document.getElementById('fullShotModal');
  if (modal) {
    const tbody = modal.querySelector('tbody');
    let tr = tbody.querySelector(`tr[data-shot-idx="${idx}"]`);
    if (!tr) {
      tr = document.createElement('tr');
      tr.setAttribute('data-shot-idx', idx);
      tr.innerHTML = `<td class="num">${idx}</td><td class="coach"></td><td class="clip"></td>`;
      tbody.appendChild(tr);
    }
    const coach = String(summary.doach || '—');
    const tdCoach = tr.querySelector('.coach');
    if (tdCoach) { tdCoach.textContent = coach; tdCoach.title = coach; }

    const tdClip = tr.querySelector('.clip');
    if (tdClip) {
      tdClip.textContent = '';
      const href = summary.clip?.path || (function(){
        try { const sid = window.__SESSION_ID; return sid != null ? `/api/sessions/${sid}/shot_video?index=${idx-1}` : null; } catch { return null; }
      })();
      if (href) {
        const a = document.createElement('a'); a.href = href; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'clip';
        tdClip.appendChild(a);
      } else {
        tdClip.textContent = summary.clip?.status === 'recording' ? 'recording…' : 'processing…';
      }
    }
  }

  // HUD counters — FINALIZED only
  try {
    const finalized = list.filter(s => s && s.pending === false).length;
    const start = (window.__sessionStart ||= Date.now());
    const elapsedSec = Math.floor((Date.now() - start) / 1000);
    updateSessionHUD?.({ taken: finalized, elapsedSec, ...computeTotals(list) });
  } catch {}
};

// capture the last release source for carry-forward
window.addEventListener('shot:release', (e)=>{ window.__lastReleaseVia = e?.detail?.via || ''; });



// Always reset playbackRate to 1× on summary (safari sanity)
window.addEventListener('shot:summary', () => {
  const v = document.getElementById('videoPlayer') || document.querySelector('video');
  if (v) { try { v.playbackRate = 1; } catch {} }
});

/* -------------------- Center prompt + countdown -------------------- */
function showCenterPrompt(msg) {
  let el = document.getElementById('overlayPrompt');
  if (!el) {
    el = document.createElement('div');
    el.id = 'overlayPrompt';
    Object.assign(el.style, {
      position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)',
      background: 'rgba(0,0,0,0.72)', color: '#fff', padding: '20px 28px',
      borderRadius: '12px', font: '700 32px/1.15 system-ui, -apple-system, Segoe UI, Arial', zIndex: 10020,
      textShadow: '0 2px 8px rgba(0,0,0,0.45)', pointerEvents: 'none', display: 'none'
    });
    ensureHudRoot().appendChild(el);
  }
  el.textContent = msg;
  el.style.display = 'block';
  return el;
}
window.showCenterPrompt = showCenterPrompt;

function startShotTrackingCountdown(sec = 5) {
  if (window.__armCountdownActive) return; window.__armCountdownActive = true;
  try { window.__shotTrackingArmed = false; } catch {}
  try { window.dispatchEvent(new CustomEvent('hud:arm-countdown', { detail: { sec } })); } catch {}

  const root = ensureHudRoot();
  let box = document.getElementById('countdownOverlay');
  if (!box) {
    box = document.createElement('div');
    box.id = 'countdownOverlay';
    Object.assign(box.style, {
      position:'absolute', left:'50%', top:'50%', transform:'translate(-50%,-50%)',
      background:'rgba(0,0,0,0.45)', color:'#fff', padding:'24px 32px', borderRadius:'16px',
      font:'900 120px/1 system-ui, -apple-system, Segoe UI, Arial',
      textShadow:'0 6px 18px rgba(0,0,0,.55)', zIndex:10040, pointerEvents:'none', display:'none'
    });
    root.appendChild(box);
  }
  const showNum = (t) => { box.style.display = 'block'; box.textContent = String(t); };
  const showGo  = () => { box.style.display = 'block'; box.textContent = 'GO'; };
  const hide    = () => { box.style.display = 'none'; };

  (async () => {
    try {
      for (let i = sec; i >= 1; i--) { showNum(i); await new Promise(r => setTimeout(r, 1000)); }
      showGo(); setTimeout(hide, 700);
      window.__shotTrackingArmed = true;
      try { window.dispatchEvent(new CustomEvent('hud:armed')); } catch {}
      try { speak('Shoot when ready.'); } catch {}
      try { window.__releaseEventSent = false; } catch {}
    } finally {
      window.__armCountdownActive = false;
    }
  })();
}
if (typeof window.startShotTrackingCountdown !== 'function') window.startShotTrackingCountdown = startShotTrackingCountdown;

/* ----------------------- Callable finalizer only ----------------------- */
// This DOES NOT trigger automatically. Call from session_manager.js when ending.
async function autoEndSessionAndSummarize() {
  // Dim background a bit for readability
  try {
    const root = ensureHudRoot?.() || document.body;
    let blk = document.getElementById('endBlackout');
    if (!blk) {
      blk = document.createElement('div'); blk.id = 'endBlackout';
      Object.assign(blk.style, { position:'absolute', inset:'0', background:'#000', opacity:'0.65', zIndex:10040, pointerEvents:'none' });
      root.appendChild(blk);
    } else {
      blk.style.display='block'; blk.style.opacity='0.65'; blk.style.zIndex='10040'; blk.style.pointerEvents='none';
    }
  } catch {}

  try { renderFullShotTable?.(); } catch {}
  try { window.dispatchEvent(new CustomEvent('hud:end-session')); } catch {}
}
if (typeof window.autoEndSessionAndSummarize !== 'function') window.autoEndSessionAndSummarize = autoEndSessionAndSummarize;

/* --------------------------- Video HUD init --------------------------- */
export function initHUDForVideo(videoEl) {
  window.__videoEl = videoEl;
  ensureHudRoot();

  const anchor = document.querySelector('.session-container') || document.body;
  if (!window.__hudMo) {
    window.__hudMo = new MutationObserver(() => ensureHudRoot());
    window.__hudMo.observe(anchor, { childList: true, subtree: true });
  }

  const boot = () => {
    ensureHudRoot();
    mountSessionHUD();
    setSessionStatus('SESSION IN PROGRESS…');
    setOverlayInteractive(true);
    try { enableHoopPickOnce?.(); } catch {}
  };

  videoEl?.addEventListener('loadeddata', () => boot(), { once:true });
  if (videoEl?.readyState >= 2) boot();

  videoEl?.addEventListener('play',  ensureHudRoot);
  videoEl?.addEventListener('pause', ensureHudRoot);

  // Elapsed time ticker
  if (window.__hudTimeTimer) clearInterval(window.__hudTimeTimer);
  window.__hudTimeTimer = setInterval(() => {
    try {
      const start = window.__sessionStart;
      if (!start) return;
      const list = (window.__shotList || window.shotLog || []);
      const taken = Array.isArray(list) ? list.length : 0;
      const elapsedSec = Math.floor((Date.now() - start) / 1000);
      updateSessionHUD({ taken, elapsedSec });
    } catch {}
  }, 1000);

  window.addEventListener('hud:end-session', () => {
    try { if (window.__hudTimeTimer) { clearInterval(window.__hudTimeTimer); window.__hudTimeTimer = null; } } catch {}
  });
}
window.initHUDForVideo = initHUDForVideo;

/* ------------------------- Hoop lock listeners ------------------------- */
window.addEventListener('hoop:locked', () => {
  window.__hoopConfirmed = true;
  try { window.__SESSION_ACTIVE = true; } catch {}
  hidePromptMessage();
  try { const v = document.getElementById('videoPlayer') || document.querySelector('video'); if (v) v.playbackRate = 1; } catch {}
  // If not armed and no countdown active, start countdown
  try {
    if (window.__shotTrackingArmed !== true && !window.__armCountdownActive) {
      window.__shotTrackingArmed = false;
      startShotTrackingCountdown?.(5);
    }
  } catch {}
});

/* ------------------- Update UI on every shot summary ------------------- */
window.addEventListener('shot:summary', () => {
  try {
    const list = window.__shotList || window.shotLog || [];
    const taken = Array.isArray(list) ? list.length : 0;
    const start = (window.__sessionStart ||= Date.now());
    const elapsedSec = Math.floor((Date.now() - start) / 1000);
    updateSessionHUD({ taken, elapsedSec });
  } catch {}
});
