// app.js — Baseline demo: hoop pick → pose-gated release → coach feedback → summary → re-arm
// Keeps it boring on purpose. No mystery globals, no dead imports.

// Boot marker
try { window.__appJsLoaded = true; } catch {}

// ---------- Imports (only what actually exists in your repo) ----------
import {
  ensureOverlayCss,
  initOverlay,
  drawLiveOverlay,
  sendFrameToDetect,
  syncOverlayToVideo,
  installOverlayTracer,
  removeOverlayTracer
} from './fix_overlay_display.js';

import {
  handleHoopSelection,
  getLockedHoopBox,
  canonHoop,
  asTopLeft,
  stabilizeLockedHoop,
  filterObjectsToLockedHoop
} from './hoop_tracker.js';

import {
  initPoseDetector,
  updatePlayerTracker,
  playerState
} from './player_tracker.js';

import {
  showPromptMessage as uiShowPromptMessage,
  requireHoopOrPrompt 
} from './video_ui.js';

import { setReleaseKnobs } from './release_gate.js';

// ---------- Minimal knobs ----------
window.SESSION_SIZE        = window.SESSION_SIZE ?? 3;            // cap shots per session
window.REL_COOLDOWN_MS     = window.REL_COOLDOWN_MS ?? 1200;
window.POSE_STREAK_NEED    = window.POSE_STREAK_NEED ?? 2;
window.__POSE_ONLY_MODE    = true;                                // allow fallback summaries
window.USE_MICROCLIP       = true;
window.__RELEASE_ONLY      = true;                                // demo: relaxed pose gate

try { setReleaseKnobs({ scoreThresh: 0.7, streakNeed: 1, hudScoreTrip: 0.5 }); } catch {}

window.REL_COOLDOWN_MS     = 2000;                                // 2s between shots
window.USE_MICROCLIP       = window.USE_MICROCLIP ?? true;        // save clips per shot
window.__MICROCLIP_MS      = window.__MICROCLIP_MS ?? 3000;       // clip length = 3 seconds

// Make the UI stop trying to “own” ending logic when app.js already does
window.SESSION_MANAGER_OWNS_ENDING = true;   // prevents several auto-end callers in video_ui
window.DEMO_MINIMAL_TABLE = true;            // force skinny table version


// demo: kill verdict UI/speech paths from shot_logger
if (window.__POSE_ONLY_MODE === true) {
  window.showShotBanner = () => {};  // no ✅/❌ banner
  window.doachOnShot    = () => {};  // no extra coach line from shot_logger
}

// ---------- Shot store (frontend record for HUD/table) ----------
(function installShotStore(){
  if (window.__shotStoreInstalled) return; window.__shotStoreInstalled = true;
  window.__shots = new Map(); window.__SHOT_ID = 0;
  window.__sessionTotals = { attempts: 0, made: 0 };

  function nextId(){ return ++window.__SHOT_ID; }
  function put(rec){ window.__shots.set(rec.id, rec); window.dispatchEvent(new CustomEvent('shots:update',{detail:{id:rec.id,rec}})); }
  function patch(id, p){ const r=window.__shots.get(id); if(!r) return; Object.assign(r,p); put(r); }

  window.createShot  = function(){ const id=nextId(); const r={id, idx:id, at:Date.now(), pending:true}; put(r); return r; };
  window.updateShot  = patch;
  window.getShotRecords = () => [...window.__shots.values()].sort((a,b)=>a.idx-b.idx);

  function cleanCoach(text){ const s=String(text||''); const ban=/\b(made|miss|went in|didn[’']?t go in)\b/i; return s.split(/(?<=[.!?])\s+/).filter(t=>!ban.test(t)).join(' ').trim(); }
window.addEventListener('shot:feedback:result', e => {
    const { shotId, text } = e?.detail || {};
    if (shotId) patch(shotId, { coach: cleanCoach(text), pending:false });
  });
  window.addEventListener('shot:summary', e => {
    const d = e?.detail || {};
    const id = Number(d.shotId || window.__SHOT_ID || 0);
    if (id) {
      patch(id, { summary:{
        made: d.made ?? null, arcHeight: d.arcHeight ?? null, entryAngle: d.entryAngle ?? null, releaseAngle: d.releaseAngle ?? null
      }, pending:false });
      if (d.made === true) window.__sessionTotals.made++;
    }
  });
window.addEventListener('hud:start-session', () => {
window.__shots = new Map(); window.__SHOT_ID = 0; window.__sessionTotals = { attempts:0, made:0 };
try { 
  window.__SESSION_ACTIVE = true; 
  window.RELOCK_HOOP_ON_DRIFT = true; 
  } catch {}
});
})();

// ---------- Prompt + greeting helpers ----------
async function fetchUserName(){
  try {
    const r = await fetch('/api/auth/me');
    const j = await r.json().catch(()=>null);
    const raw = j?.user?.name || j?.name || j?.user?.email || j?.email || 'Player';
    const nm = String(raw).split('@')[0];
    const nice = (nm.charAt(0).toUpperCase() + nm.slice(1)) || 'Player';
    window.__USER_NAME = nice;
    try { localStorage.setItem('firstname', nice); localStorage.setItem('firstname_confirmed', '1'); } catch {}
  } catch {
    window.__USER_NAME = window.__USER_NAME || (localStorage.getItem('firstname') || 'Player');
  }
}

function getDisplayName(){
  try {
    return window.__USER_NAME || localStorage.getItem('firstname') || 'Player';
  } catch {
    return window.__USER_NAME || 'Player';
  }
}

function ensureLocalPromptEl(){
  let el = document.getElementById('overlayPrompt');
  if (!el) {
    el = document.createElement('div');
    el.id = 'overlayPrompt';
    el.style.cssText = 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);background:rgba(0,0,0,0.75);color:#fff;padding:18px 28px;border-radius:18px;text-align:center;pointer-events:none;z-index:200;min-width:320px;box-shadow:0 12px 30px rgba(0,0,0,0.35);display:none;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-weight:700;font-size:28px;';
    (document.getElementById('overlay')?.parentElement || document.body).appendChild(el);
  }
  return el;
}
function localShowPrompt(text, duration = 3000){
  const el = ensureLocalPromptEl();
  const big = /^\s*(?:\d+|GO|Go|go)\s*$/.test(String(text));
  if (big) {
    el.style.fontSize = '140px';
    el.style.fontWeight = '900';
    el.style.padding = '0 32px';
    el.style.minWidth = 'auto';
  } else {
    el.style.fontSize = '28px';
    el.style.fontWeight = '700';
    el.style.padding = '18px 28px';
    el.style.minWidth = '320px';
  }
  el.textContent = text;
  el.style.display = 'block';
  el.style.opacity = '1';
  clearTimeout(el.__fade);
  el.__fade = setTimeout(()=>{
    el.style.opacity = '0';
    el.__hide = setTimeout(()=>{ el.style.display = 'none'; }, 320);
  }, duration);
}
function localHidePrompt(){
  const el = document.getElementById('overlayPrompt');
  if (!el) return;
  clearTimeout(el.__fade);
  clearTimeout(el.__hide);
  el.style.display = 'none';
}
function speakCompat(text, retry = 0){
  if (!text) return;
  try {
    if (typeof window.speak === 'function') {
      window.speak(text);
      return;
    }
  } catch {}
  try {
    const coach = window.coach || window.coachVoice || window.coachAssistant;
    if (coach && typeof coach.speak === 'function') {
      coach.speak(text);
      return;
    }
  } catch {}
  if (retry < 4) {
    clearTimeout(speakCompat.__retryTimer);
    speakCompat.__retryTimer = setTimeout(() => speakCompat(text, retry + 1), 600);
  }
}
function showPromptCompat(text, duration = 4000, opts = {}){
  const voiceEnabled = (typeof opts === 'object' && opts && 'voice' in opts) ? opts.voice !== false : true;
  if (voiceEnabled) {
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const lastText = showPromptCompat.__lastText;
    const lastAt = showPromptCompat.__lastAt || 0;
    if (text && (text !== lastText || (now - lastAt) > 1500)) {
      speakCompat(text);
      showPromptCompat.__lastText = text;
      showPromptCompat.__lastAt = now;
    }
  }
  if (typeof uiShowPromptMessage === 'function') {
    uiShowPromptMessage(text, duration);
  } else {
    localShowPrompt(text, duration);
  }
}
function hidePromptCompat(){
  if (typeof window.hidePromptMessage === 'function') {
    window.hidePromptMessage();
  } else {
    localHidePrompt();
  }
}

function runHoopCountdown(sec = 5) {
  if (typeof window.startHoopCountdown === 'function') {
    window.startHoopCountdown(sec);
    return;
  }
  if (window.__armCountdownActive) return;
  window.__armCountdownActive = true;
  try { window.__shotTrackingArmed = false; } catch {}
  try { window.dispatchEvent(new CustomEvent('hud:arm-countdown', { detail: { sec } })); } catch {}
  const name = getDisplayName();
  const total = Math.max(1, Number(sec) || 5);
  try { clearTimeout(window.__localCountdownTimer); } catch {}

  speakCompat(`Locked, ${name}. Starting in ${total} seconds.`);

  let remaining = total;
  const showNumber = (val) => showPromptCompat(String(val), 900, { voice: false });

  showNumber(remaining);
  remaining -= 1;

  const tick = () => {
    if (remaining > 0) {
      showNumber(remaining);
      remaining -= 1;
      window.__localCountdownTimer = setTimeout(tick, 1000);
      return;
    }
    showPromptCompat('GO!', 700, { voice: false });
    window.__localCountdownTimer = setTimeout(() => {
      hidePromptCompat();
      window.__armCountdownActive = false;
      try { window.__shotTrackingArmed = true; } catch {}
      try { window.dispatchEvent(new CustomEvent('hud:armed')); } catch {}
      speakCompat('Shoot when ready.');
      try { window.__releaseEventSent = false; } catch {}
      scheduleArmWhenReady(0);
    }, 650);
  };

  window.__localCountdownTimer = setTimeout(tick, 1000);
}

// ---------- Pose detector wrapper ----------
let __poseBusy=false, __poseLast=null;
async function poseDetectSerial(){
  if (!window.poseDetector || __poseBusy) return __poseLast;
  const v=document.getElementById('videoPlayer'); if(!v?.videoWidth) return __poseLast;
  __poseBusy = true;
  try{
    const ts = performance.now()|0;
    const res = await window.poseDetector.detectForVideo(v, ts);
    if (res?.landmarks?.length >= 33) __poseLast = res;
    return res;
  }catch{ return __poseLast; } finally { __poseBusy = false; }
}
window.poseDetectSerial = poseDetectSerial;

 // ---------- Microclip (3s) ----------
(function installMicroclip(){
  if (window.__mcInstalled) return; window.__mcInstalled = true;

  const supported =
    typeof MediaRecorder === 'function' &&
    (MediaRecorder.isTypeSupported?.('video/webm;codecs=vp9') ||
     MediaRecorder.isTypeSupported?.('video/webm;codecs=vp8') ||
     MediaRecorder.isTypeSupported?.('video/webm'));
  window.__CLIPS_AVAILABLE = !!supported;

  // tiny helper: emit a minimal summary for this shot
  function emitMicroclipSummary(shotId) {
    try {
      const sum = { shotId, made: null, arcHeight: null, entryAngle: null, releaseAngle: null };
      window.recordShotSummary?.(sum);
      window.dispatchEvent(new CustomEvent('shot:summary', { detail: sum }));
    } catch {}
  }

  async function startMicroClip(shotId, releaseFrame = null){
    if (!window.USE_MICROCLIP || !window.__CLIPS_AVAILABLE) {
      window.updateShot?.(shotId, { clip:{ status:'disabled' } });
      emitMicroclipSummary(shotId);
      return;
    }

    const v = document.getElementById('videoPlayer');
    // Prefer camera stream; fall back to element capture for file playback
    const stream = v?.srcObject || v?.captureStream?.();
    if (!stream) {
      window.updateShot?.(shotId, { clip:{ status:'no-stream' } });
      emitMicroclipSummary(shotId);
      return;
    }
    if (!stream.getVideoTracks?.().length) {
      window.updateShot?.(shotId, { clip:{ status:'no-video-track' } });
      emitMicroclipSummary(shotId);
      return;
    }

    const mime = ['video/webm;codecs=vp9','video/webm;codecs=vp8','video/webm']
      .find(m => { try { return MediaRecorder.isTypeSupported(m); } catch { return false; }});
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);

    const chunks = [];
    rec.ondataavailable = e => { if (e?.data?.size) chunks.push(e.data); };
    rec.onerror = e => {
      try { window.updateShot?.(shotId, { clip:{ status:'error', reason:String(e?.error || 'recorder') } }); } catch {}
    };

    rec.onstop = async () => {
      if (!chunks.length) {
        window.updateShot?.(shotId, { clip:{ status:'error', reason:'empty' } });
        emitMicroclipSummary(shotId);
        return;
      }
      const blob = new Blob(chunks, { type: mime || 'video/webm' });
      const fd = new FormData();
      fd.append('sessionId', window.__SESSION_ID || (`sess_${Date.now()}`));
      fd.append('shotId', String(shotId));
      // Most backends are happier with (Blob, filename) than constructing File()
      fd.append('clip', blob, `shot-${shotId}.webm`);

      try {
        const r  = await fetch('/api/microclip/upload', { method:'POST', body: fd });
        const j  = await r.json().catch(() => null);
        window.updateShot?.(shotId, {
          clip:{ status: r.ok ? 'saved' : 'error', path: j?.path || null, bytes: blob.size, frame: releaseFrame, ms: window.__MICROCLIP_MS }
        });
      } catch (err) {
        window.updateShot?.(shotId, { clip:{ status:'error', reason:String(err) } });
      } finally {
        // Always emit a summary so the pipeline can end at cap and show the table
        emitMicroclipSummary(shotId);
      }
    };

    // Ensure frames flow for element capture
    try { if (v?.paused) await v.play(); } catch {}

    rec.start();
    const ms = Number(window.__MICROCLIP_MS) || 3000;
    // Flush last chunk and stop
    setTimeout(() => { try { rec.requestData?.(); } catch {} }, Math.max(0, ms - 50));
    setTimeout(() => { try { rec.state !== 'inactive' && rec.stop(); } catch {} }, ms);

    window.updateShot?.(shotId, { clip:{ status:'recording', ms, frame: releaseFrame } });
    window.__sessionTotals && (window.__sessionTotals.attempts = (window.__sessionTotals.attempts || 0) + 1);
  }

  window.__startMicroClip = startMicroClip;
})();



// ---------- Helper: proxFromHoop via shot_arc.module if present ----------
function shotArcProx(hoopBox){
  try{
    const api = window.__shotArcModule?.();
    if (api?.proxFromHoop) return api.proxFromHoop(hoopBox);
  }catch{}
  return null;
}

// ---------- Release emitter + fallback summary ----------
(function installReleaseCore(){
  if (window.safeEmitRelease) return;

  function armFallbackSummary() {
    if (window.USE_MICROCLIP) return;                    // microclip will provide summary via backend/worker
    if (window.__POSE_ONLY_MODE) return;                 // in pose-only, don't arm fallback
    const dwell = Math.max(900, Number(window.MINI_SCORE_MS || 1800));
    clearTimeout(window.__releaseFallbackTimer);

    window.__releaseFallbackTimer = setTimeout(() => {
      if (!window.__lastSummary) {
        const s = { made:null, arcHeight:null, entryAngle:null, releaseAngle:null };
        try{ window.recordShotSummary?.(s); }catch{}
        window.dispatchEvent(new CustomEvent('shot:summary', { detail: s }));
      }
      const bs = window.ballState || (window.ballState = {}); bs.releaseFrame = null; bs.state='IDLE';
    }, dwell);
  }

  window.safeEmitRelease = function safeEmitRelease(frame, via='unknown', opts={}){
    // cap enforcement
    const capFn = (typeof getSessionCap === 'function') ? getSessionCap : (()=>Number(window.SESSION_SIZE||3));
    const cap   = Number(capFn());
    const taken = (window.getShotRecords?.()||[]).length;
    if (Number.isFinite(cap) && taken >= cap) { try{ window.autoEndSessionAndSummarize?.(); }catch{} return false; }

    const hoop = getLockedHoopBox?.();
    if (!hoop) return false;

    const now = performance.now();
    const since = now - (Number(window.__REL_LAST_FIRE_MS||0));
    if (since < Number(window.REL_COOLDOWN_MS||1200)) return false;

    // pose gate if available
    if (!opts?.bypassGate) {
      const hist = (window.playerState?.frameHistory || []).slice(-8);
      const gate = window.releaseGate ? window.releaseGate(hist) : { released:true, tests:{} };
      if (!gate.released) return false;
    }

    window.__REL_LAST_FIRE_MS = now;
    window.__releaseEventSent = true;

    // create shot rec
    const rec = window.createShot?.();
    const shotId = rec?.id || (window.__SHOT_ID || 1);

    // DB: ensure session id once
    (async ()=>{
      try{
        if (!window.__SESSION_ID) {
          const rr = await fetch('/api/sessions/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({device:navigator.userAgent})});
          if (rr.ok) { const jj=await rr.json(); window.__SESSION_ID = jj?.id || null; }
        }
        await fetch('/api/release_mark', {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ sessionId: window.__SESSION_ID||null, shotId, frame:Number(frame)||0, tMs:Date.now(), via, hoop })
        });
      }catch{}
    })();

    // local events
    const prox = shotArcProx(canonHoop?.(hoop) || hoop);
    window.dispatchEvent(new CustomEvent('shot:release', { detail:{ frame, via, prox, poseApproved:!!opts.poseApproved } }));

    // capture or fallback summary
    if (window.USE_MICROCLIP && window.__CLIPS_AVAILABLE) {
      window.__startMicroClip?.(shotId, Number(frame)||null);
    } else {
      armFallbackSummary();
    }

    // ask coach
    window.dispatchEvent(new CustomEvent('shot:feedback:request', { detail:{ shotId, via } }));
    return true;
  };

  // on summary: persist + end-or-rearm (wait for DB save, then dim + show table at cap)
window.addEventListener('shot:summary', (e) => {
  const W = /** @type {any} */ (window);

  clearTimeout(W.__releaseFallbackTimer);
  try { W.__releaseEventSent = false; } catch {}

  const d   = e?.detail || {};
  const sid = W.__SESSION_ID || null;
  const idx = W.__SHOT_ID || null;

  // 1) Persist the last shot BEFORE any UI change
  let savePromise = Promise.resolve();
  if (sid && idx != null) {
    savePromise = (async () => {
      try {
        await fetch(`/api/sessions/${sid}/shot`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            idx,
            t: Date.now(),
            made: d.made ?? null,
            arcHeight: d.arcHeight ?? null,
            entryAngle: d.entryAngle ?? null,
            releaseAngle: d.releaseAngle ?? null
          })
        });
      } catch {}
    })();
  }

  // 2) Cap check (also honor session manager flag if it set one)
  const taken  = (W.getShotRecords?.() || []).length;
  const capFn  = (typeof getSessionCap === 'function') ? getSessionCap : (() => Number(W.SESSION_SIZE || 3));
  const cap    = Number(capFn());
  const capped = (Number.isFinite(cap) && taken >= cap) || W.__sessionCapped === true;

  if (capped) {
    // 3) After save: stop, clean HUD status, dim, open table (no long coach wrap)
    savePromise.finally(() => {
      try { W.endSessionAtCap?.(); } catch {}

      // kill the "Waiting…" pill if present
      try { W.setCoachStatus?.('done'); } catch {}
      try {
        const badge = document.getElementById('coachStatusBadge') || document.querySelector('.hud-status');
        if (badge) badge.style.display = 'none';
      } catch {}

      // dim background a bit
      try {
        const vp = document.getElementById('videoPlayer'); if (vp) vp.style.filter = 'brightness(0.25)';
        const ov = document.getElementById('overlay');     if (ov) ov.style.opacity = '0.85';
      } catch {}

      // small settle so last clip path/coach text lands, then open minimal table
      setTimeout(() => { try { showDemoTable(); } catch {} }, 120);
    });
  } else {
    // Not at cap: disarm and re-arm soon
    W.__shotTrackingArmed = false;
    scheduleArmWhenReady(300);
    setTimeout(() => {
      try {
        const currentTaken = (W.getShotRecords?.() || []).length;
        const capFnLater = (typeof getSessionCap === 'function') ? getSessionCap : (() => Number(W.SESSION_SIZE || 3));
        const capLater = Number(capFnLater());
        if (!Number.isFinite(capLater) || currentTaken < capLater) {
          if (W.__shotTrackingArmed !== true) scheduleArmWhenReady?.(0);
        }
      } catch {}
    }, 1100);
  }
});

// Optional belt-and-suspenders if your session manager fires an end event
window.addEventListener('hud:end-session', () => {
  const W = /** @type {any} */ (window);
  try { W.setCoachStatus?.('done'); } catch {}
  setTimeout(() => { try { showDemoTable(); } catch {} }, 80);
});

})();



// Helper: show the minimal summary table using whatever name your UI exported
function showDemoTable() {
  const W = /** @type {any} */ (window);
  const fns = [
    'renderFullShotTable',      // our preferred minimal table
    'renderShotTable',
    'openShotSummaryTable',
    'openSummaryTable'
  ];
  for (const fn of fns) {
    if (typeof W[fn] === 'function') {
      try { return W[fn](); } catch {}
    }
  }
  // Last-resort event for video_ui to catch
  try { W.dispatchEvent(new CustomEvent('doach:open-summary-table')); } catch {}
}

// ---------- Arming ----------
function scheduleArmWhenReady(delay=200){
  clearTimeout(window.__armTimer);
  window.__armTimer = setTimeout(async ()=>{
    const hoop = getLockedHoopBox?.(); if (!hoop) return;
    let streak=0, need=Number(window.POSE_STREAK_NEED||2), t0=performance.now();
    while (performance.now()-t0 < 1200 && streak < need){
      const res = await poseDetectSerial();
      const ls = res?.landmarks || [];
      if (Array.isArray(ls) && ls.length >= 33) streak++; else streak=0;
      await new Promise(r=>setTimeout(r,60));
    }
    if (streak>=need) window.__shotTrackingArmed = true;
  }, Math.max(0,delay));
}
window.scheduleArmWhenReady = scheduleArmWhenReady;

(function guardEarlyEnd(){
  const W = /** @type {any} */ (window);
  if (W.__guardEarlyEndInstalled === true) return;
  W.__guardEarlyEndInstalled = true;
  window.addEventListener('hud:end-session', (evt) => {
    try {
      const taken = (W.getShotRecords?.() || []).length;
      const capFn = (typeof getSessionCap === 'function') ? getSessionCap : (() => Number(W.SESSION_SIZE || 3));
      const cap = Number(capFn());
      if (Number.isFinite(cap) && taken < cap) {
        evt.stopImmediatePropagation?.();
      }
    } catch {}
  }, { capture: true });
})();

// ---------- Hoop pick once ----------
// One-time hoop picker (tap once to lock the rim)
export function enableHoopPickOnce() {
  const ov  = document.getElementById('overlay');
  const vid = document.getElementById('videoPlayer');
  const promptEl = document.getElementById('overlayPrompt') || document.getElementById('promptBar');
  if (!ov || !vid) return;
  if (window.__hoopConfirmed) return;

  // Arm FIRST so any sync keeps overlay clickable
  window.__pickingHoop   = true;
  ov.style.pointerEvents = 'auto';
  ov.style.touchAction   = 'none';    // iOS: allow pointerdown on canvas
  ov.style.cursor        = 'crosshair';
  ov.style.zIndex        = '100';
  vid.style.pointerEvents = 'none';
  const name = getDisplayName();
  showPromptCompat(`Hi ${name}, tap the hoop to begin session`, 4000);


  // Refresh rect/mapping now that picking is armed
  syncOverlayToVideo?.();

  const finish = () => {
    window.__hoopConfirmed = true;
    window.__pickingHoop   = false;
    ov.style.cursor        = 'default';
    ov.style.pointerEvents = 'none';
    vid.style.pointerEvents = '';
    if (promptEl) promptEl.style.display = 'none';
    hidePromptCompat();

  // Lock layout to 'contain' now to avoid any size jump
  try { syncOverlayToVideo?.(); } catch {}
  const isLive = !!vid.srcObject;
  if (isLive) {
    try {
      // ensure overlay draws pose + hoop (not arc-only/clean)
      window.__overlayMode = 'coach';
      window.__overlayCleanDrawn = false;
      installPreDetectorFor?.(vid);   // warm YOLO/pose on live
      startPreDetection?.(vid);
    } catch {}
    // keep a lightweight paint loop that renders pose + hoop every frame
    try { cancelAnimationFrame(window.__coachPaintRaf); } catch {}
    const paint = () => {
      const last = window.lastDetectedFrame || {};
      drawLiveOverlay?.(last.objects || [], window.playerState);
      window.__coachPaintRaf = requestAnimationFrame(paint);
    };
    window.__coachPaintRaf = requestAnimationFrame(paint);

    // NEW: while on coach plane (live), actively sample pose at ~8–10 fps
    // so playerState keeps updating immediately after hoop lock.
    try { clearInterval(window.__coachPoseInterval); } catch {}
    const POSE_MS = Math.max(80, Number(window.COACH_POSE_MS || 120));
    window.__coachPoseInterval = setInterval(async () => {
      try {
        if (window.__coachPoseBusy) return; // prevent overlap/backlog
        window.__coachPoseBusy = true;
        const vlive = document.getElementById('videoPlayer');
        if (!vlive || !vlive.srcObject || !vlive.videoWidth) return;
        // Always serialize pose calls to avoid cross-sampler conflicts
        const res = await (window.poseDetectSerial?.() || Promise.resolve(null));
        // Accept both shapes: [33] or [[33]]; require finite xy
        const raw = res?.landmarks;
        const cand = Array.isArray(raw?.[0]) ? raw[0] : raw;
        if (!Array.isArray(cand) || cand.length < 33) return;
        if (cand.some(k => !k || !Number.isFinite(k.x) || !Number.isFinite(k.y))) return;
        const ls = cand;
        const looksNorm = ls.every(k=>k && k.x <= 1.01 && k.y <= 1.01);
        const sx = looksNorm ? (vlive.videoWidth||1)  : 1;
        const sy = looksNorm ? (vlive.videoHeight||1) : 1;
        const scaled = ls.map(k=>({ ...k, x: k.x * sx, y: k.y * sy }));
        try {
          const fidx = (() => {
            const v = document.getElementById('videoPlayer');
            const fps = Number(window.__videoFPS) || 30;
            return Math.max(0, Math.round((v?.currentTime || 0) * fps));
          })();
          updatePlayerTracker?.(scaled, fidx);
          try {
            const H = window.getLockedHoopBox?.();
            const bs = (window.ballState ||= {});
            if (H && !Number.isFinite(bs.releaseFrame) && Array.isArray(window.playerState?.keypoints) && window.playerState.keypoints.length >= 33) {
              // Unified gate: use releaseGate for decision (matches HUD greens)
              const hist = (window.playerState.frameHistory || []).slice(-8);
              const gate = (typeof window.releaseGate === 'function') ? window.releaseGate(hist) : { released:false, tests:{}, passed:0, reason:'no-gate' };
              // Keep a simple streak to avoid single-tick noise unless in releaseOnly
              window.__gateStreak = gate.released ? ((window.__gateStreak || 0) + 1) : 0;
              const need = Number(window.HEUR_STREAK_NEED || (window.__RELEASE_ONLY === true ? 1 : 2));
              // Immediate latch if all-four score reached (e.g., 1.0 when all green)
              const allScore = Number(gate?.tests?.score || 0);
              const wantAll = Number((window.REL_CFG?.scoreThresh) ?? window.REL_SCORE_THRESH ?? 1.0);
              const allGreen = allScore >= wantAll - 1e-6;
              let latched = ((window.__gateStreak || 0) >= need) || allGreen;
              try {
                const rec = { t: Date.now(), type:'gate', detail: { frame: fidx, tests: gate.tests, passed: gate.passed, reason: gate.reason }, latched };
                (window.__REL_LOG ||= []).push(rec);
                window.__LAST_GATE = rec; // expose for overlay debug HUD
                if (window.DOACH_RELEASE_TRACE === true) {
                  console.log('[gate]', { frame: fidx, ...gate.tests, passed: gate.passed, latched });
                }
              } catch {}

              if (latched) {
                // Require arming and hoop lock before firing
                try { if (window.__shotTrackingArmed !== true) latched = false; } catch {}
                try { if (!H) latched = false; } catch {}
              }
              
              if (latched) {
                try { window.__GATE_LATCH_FRAME = fidx; } catch {}
                const now = performance.now();
                const cd  = Number(window.REL_COOLDOWN_MS || (window.REL_CFG?.cooldownMs) || 2000);
                const since = now - (Number(window.__REL_LAST_FIRE_MS) || 0);
                const prox = (typeof window.proxFromHoop === 'function' && typeof window.canonHoop === 'function')
                  ? window.proxFromHoop(window.canonHoop(H)) : null;
                if (since >= cd) {
                  const ok = window.safeEmitRelease?.(fidx, 'pose-heuristic', { gate, prox, poseApproved: true, bypassGate: true });
                  if (ok === false) {
                    try { if (window.DOACH_RELEASE_TRACE === true) console.log('[gate:suppress]', { frame: fidx, reason:'safe-blocked' }); } catch {}
                  } else {
                    try { window.__REL_LAST_FIRE_MS = now; } catch {}
                  }
                } else {
                  try { if (window.DOACH_RELEASE_TRACE === true) console.log('[gate:suppress]', { frame: fidx, reason:'cooldown', remaining: Math.ceil(cd - since) }); } catch {}
                }
              }
            }
          } catch {}
        } catch {
          if (!window.playerState) window.playerState = { keypoints: [] };
          window.playerState.keypoints = scaled;
          window.__lastPoseKP = scaled; window.__lastPoseTS = performance.now();
          window.__lastPoseUpdateMs = performance.now(); window.__lastPoseWrist = scaled[16] || null;
        }
      } catch {}
      finally { window.__coachPoseBusy = false; }
    }, POSE_MS);

    // Fire one immediate pose read so the overlay has pose right away
    ;(async () => {
      try {
        if (window.__coachPoseBusy) return;
        window.__coachPoseBusy = true;
        const vlive = document.getElementById('videoPlayer');
        if (!vlive || !vlive.srcObject || !vlive.videoWidth) return;
        const res = await (window.poseDetectSerial?.() || Promise.resolve(null));
        const raw = res?.landmarks;
        const cand = Array.isArray(raw?.[0]) ? raw[0] : raw;
        if (!Array.isArray(cand) || cand.length < 33) return;
        if (cand.some(k => !k || !Number.isFinite(k.x) || !Number.isFinite(k.y))) return;
        const ls = cand;
        const looksNorm = ls.every(k=>k && k.x <= 1.01 && k.y <= 1.01);
        const sx = looksNorm ? (vlive.videoWidth||1)  : 1;
        const sy = looksNorm ? (vlive.videoHeight||1) : 1;
        const scaled = ls.map(k=>({ ...k, x: k.x * sx, y: k.y * sy }));
        try {
          const fidx = (() => {
            const v = document.getElementById('videoPlayer');
            const fps = Number(window.__videoFPS) || 30;
            return Math.max(0, Math.round((v?.currentTime || 0) * fps));
          })();
          updatePlayerTracker?.(scaled, fidx);
        } catch {
          if (!window.playerState) window.playerState = { keypoints: [] };
          window.playerState.keypoints = scaled;
          window.__lastPoseKP = scaled; window.__lastPoseTS = performance.now();
          window.__lastPoseUpdateMs = performance.now(); window.__lastPoseWrist = scaled[16] || null;
        }
        try { window.__poseFlashUntil = performance.now() + 1200; } catch {}
        try { drawLiveOverlay?.((window.lastDetectedFrame?.objects)||[], window.playerState); } catch {}
      } catch {}
      finally { window.__coachPoseBusy = false; }
    })();
  } else {
    // Keep layout stable and choose live vs upload once
    try { syncOverlayToVideo?.(); } catch {}

    const isLive = !!vid.srcObject;
    if (isLive) {
      // ✅ LIVE: stay on coach plane (pose + hoop) at 1×
      window.__overlayMode = 'live';
      window.__overlayCleanDrawn = false;

      // If something already started the analyzer, stop it now
      try { window.stopFrameAnalysis?.(); } catch {}
      window.__analyzerActive = false;

      // Make sure pre-detector runs and we keep painting
      try { installPreDetectorFor?.(vid); } catch {}
      try { startPreDetection?.(vid); } catch {}

      // Lightweight painter: draw pose + hoop every frame from lastDetectedFrame
      try { cancelAnimationFrame(window.__coachPaintRaf); } catch {}
      const paint = () => {
        const last = window.lastDetectedFrame || {};
        try { drawLiveOverlay?.(last.objects || [], window.playerState); } catch {}
        window.__coachPaintRaf = requestAnimationFrame(paint);
      };
      window.__coachPaintRaf = requestAnimationFrame(paint);
    } else {
      // 🎞️ UPLOAD: run the full analyzer
      requestAnimationFrame(() => window.startFrameAnalysis?.());
      
    }
  }
 };

  let picked = false; // Add this guard
  const pickOnce = (e) => {
    if (picked) return; // And check it here
    picked = true;

    try {
      e.preventDefault?.(); e.stopPropagation?.();

      // 1) Use your proven locker (same as uploads): sets the real “locked hoop”
      handleHoopSelection?.(e, ov, window.lastDetectedFrame, promptEl);

      // 2) Immediately mirror the locked box into ball_tracker so proximity math works this frame
      const H = getLockedHoopBox?.();
      if (H) attachHoop?.(H);

      finish();
    } finally {
      ov.removeEventListener('pointerdown', pickOnce);
      ov.removeEventListener('click',       pickOnce);
    }
  };

  // Single handler (pointerdown works best on iOS)
  ov.addEventListener('pointerdown', pickOnce, { passive: false, once: true });
  ov.addEventListener('click',       pickOnce, { passive: true  }); // desktop fallback
}

// pre-planing if needed in the future: re-pick / cancel
window.repickHoop = () => {
  window.__hoopConfirmed = false;
  window.__pickingHoop   = false;
  enableHoopPickOnce();
};
window.cancelHoopPick = () => {
  window.__pickingHoop   = false;
  const ov = document.getElementById('overlay');
  if (!ov) return;
  ov.style.cursor = 'default';
  // brute-force unbind in case handlers changed
  const clone = ov.cloneNode(true);
  ov.parentNode.replaceChild(clone, ov);
};
window.enableHoopPickOnce = enableHoopPickOnce;

// Attach the hoop to the ball state for tracking zone
export function attachHoop(hoopLocked) {
  if (!hoopLocked) return;

  // Pull size, allow 0 → fallback to previous or a sensible default
  const prev = ballState.hoop || {};
  let w = Number(hoopLocked.w ?? hoopLocked.width  ?? prev.w ?? 0);
  let h = Number(hoopLocked.h ?? hoopLocked.height ?? prev.h ?? 0);
  if (!w || !h) {
    // default ~140x100px (tuned later by detector stabilizer)
    w = w || 140;
    h = h || 100;
  }

  // Debug helpers: print current gate and last release
  try {
    if (typeof window.printPoseGate !== 'function') {
      window.printPoseGate = function printPoseGate() {
        try {
          const hist = (window.playerState?.frameHistory || []).slice(-5);
          const g = releaseGate(hist);
          const f = hist.at(-1)?.frame ?? null;
          console.log('[pose:gate]', { frame: f, ...g.tests, passed: g.passed, reason: g.reason, released: g.released });
          return g;
        } catch (e) { console.warn('printPoseGate failed', e); return null; }
      };
    }
    if (typeof window.printLastRelease !== 'function') {
      window.printLastRelease = function printLastRelease() {
        try {
          const fps = Number(window.__videoFPS) || 30;
          const f = Number.isFinite(window.ballState?.releaseFrame) ? window.ballState.releaseFrame : (window.__GATE_LATCH_FRAME ?? null);
          if (Number.isFinite(f)) {
            const t = (f / fps).toFixed(3);
            console.log('[release:last]', { frame: f, time_s: Number(t) });
            return { frame: f, time_s: Number(t) };
          }
          console.log('[release:last] none');
          return null;
        } catch (e) { console.warn('printLastRelease failed', e); return null; }
      };
    }
  } catch {}

  // Accept center or TL; normalize to a canonical object that carries both
  let cx, cy, x, y;

  if (Number.isFinite(hoopLocked.cx) && Number.isFinite(hoopLocked.cy)) {
    cx = Math.round(hoopLocked.cx);
    cy = Math.round(hoopLocked.cy);
    x  = Math.round(cx - w / 2);
    y  = Math.round(cy - h / 2);
  } else if (
    (hoopLocked.anchor === 'topleft' ||
     hoopLocked.topLeft || hoopLocked.leftTop || hoopLocked.isLeftTop) &&
    Number.isFinite(hoopLocked.x) && Number.isFinite(hoopLocked.y)
  ) {
    x  = Math.round(hoopLocked.x);
    y  = Math.round(hoopLocked.y);
    cx = x + Math.round(w / 2);
    cy = y + Math.round(h / 2);
  } else if (Number.isFinite(hoopLocked.x) && Number.isFinite(hoopLocked.y)) {
    // Treat {x,y} as center by default if no anchor specified
    cx = Math.round(hoopLocked.x);
    cy = Math.round(hoopLocked.y);
    x  = Math.round(cx - w / 2);
    y  = Math.round(cy - h / 2);
  } else {
    return;
  }

  // Canonical: store both TL and center, and mark explicit TL anchor
  ballState.hoop = {
    x, y, w, h,
    cx, cy,
    anchor: 'topleft'
  };
}



// ---------- Camera boot ----------
export async function startCamera(){
  const v=document.getElementById('videoPlayer');
  const o=document.getElementById('overlay');
  if (!v||!o) return false;

  if (v.srcObject) { try{ v.srcObject.getTracks().forEach(t=>t.stop()); }catch{} }

  v.muted = true;                      // autoplay policy
  v.setAttribute('muted','');
  v.setAttribute('playsinline','');    // iOS/WebKit won't go fullscreen
  v.autoplay = true;                   // hint

  let stream;
  try{
    stream = await navigator.mediaDevices.getUserMedia({ video:{ width:{ideal:1280}, height:{ideal:720}, frameRate:{ideal:30}}, audio:false });
  }catch(e){ console.warn('camera error', e); return false; }
  v.srcObject = stream;
  await new Promise(res=>v.addEventListener('loadedmetadata', res, { once:true }));
  try{ await v.play(); }catch(e){ console.warn('autoplay blocked'); return false; }

  if (!window.poseDetector) await initPoseDetector?.();

  ensureOverlayCss(); initOverlay?.(o); syncOverlayToVideo();
  window.__SESSION_ACTIVE = true;
  window.RELOCK_HOOP_ON_DRIFT = true;

  startPreDetectWarm(v);
  enableHoopPickOnce();
  return true;
}
window.startCamera = startCamera;



// ---------- Pre-detect loop ----------
function startPreDetectWarm(videoEl){
  if (window.__warmLoop) { try { clearTimeout(window.__warmLoop); } catch {} window.__warmLoop = null; }
  const buf=document.createElement('canvas'); const ctx=buf.getContext('2d',{willReadFrequently:true});
  let lastPD=0; const MIN_DT=100;
  async function tick(){
    if (!videoEl?.videoWidth) return schedule();
    if (buf.width!==videoEl.videoWidth || buf.height!==videoEl.videoHeight){ buf.width=videoEl.videoWidth; buf.height=videoEl.videoHeight; }
    ctx.drawImage(videoEl,0,0,buf.width,buf.height);

    const now=performance.now();
    if (now-lastPD>=MIN_DT){
      lastPD=now;
      try{
        const res=await poseDetectSerial();
        const ls=res?.landmarks||[];
        if (Array.isArray(ls)&&ls.length>=33){
          const looksNorm = ls.every(k=>k&&k.x<=1.01&&k.y<=1.01);
          const sx=looksNorm?videoEl.videoWidth:1, sy=looksNorm?videoEl.videoHeight:1;
          const scaled = ls.map(k=>({...k, x:k.x*sx, y:k.y*sy}));
          updatePlayerTracker?.(scaled,(window.__AN_IDX||0)+1);
        }
        let objects=[];
        try {
          const det=await sendFrameToDetect(buf,(window.__AN_IDX||0));
          objects = det?.objects || [];
        } catch {}
        stabilizeLockedHoop?.(objects);
        objects=filterObjectsToLockedHoop?.(objects)??objects;
        window.lastDetectedFrame = { __frameIdx:(window.__AN_IDX||0)+1, objects, poses:[] };
        drawLiveOverlay?.(objects, playerState);
      }catch{}
    }
    schedule();
  }
  function schedule(){ window.__warmLoop = setTimeout(()=>requestAnimationFrame(tick), 100); }
  schedule();
}

// ---------- Pose sampler → release ----------
(function installPoseSampler(){
  if (window.__poseSamplerInstalled) return;
  window.__poseSamplerInstalled = true;

  function tryRelease() {
    if (window.__shotTrackingArmed !== true) return;
    const hist = (window.playerState?.frameHistory || []).slice(-8); // ← give releaseGate the 8 it expects
    const gate = window.releaseGate ? window.releaseGate(hist) : { released: false };
    if (!gate.released) return;
    const f = window.playerState?.lastFrame ?? 0;
    window.safeEmitRelease?.(f, 'pose-sampler', { gate, poseApproved: true, bypassGate: true });
  }

  function loop(){ try{ tryRelease(); }catch{} window.__poseSamplerT = setTimeout(loop, Number(window.COACH_POSE_MS||120)); }
  loop();
  window.addEventListener('hud:end-session', ()=>{ try{ clearTimeout(window.__poseSamplerT); }catch{} });
})();

// ---------- Cap enforcement on summary ----------
window.addEventListener('shot:summary', ()=>{
  const taken=(window.getShotRecords?.()||[]).length;
  const capFn=(typeof getSessionCap==='function')?getSessionCap:(()=>Number(window.SESSION_SIZE||3));
  const cap=Number(capFn());
  if (Number.isFinite(cap) && taken>=cap) { try{ window.autoEndSessionAndSummarize?.(); }catch{} }
});

// ---------- Boot ----------
document.addEventListener('DOMContentLoaded', ()=>{
  const v=document.getElementById('videoPlayer');
  const ov=document.getElementById('overlay');
  if (!v||!ov) return;

  ensureOverlayCss(); 
  initOverlay?.(ov); 
  syncOverlayToVideo();

  (fetchUserName?.() ?? Promise.resolve()).catch(()=>{}).finally(() => {
    const name = getDisplayName();
    showPromptCompat(`Hi ${name}, tap the hoop to begin session`, 4000);
    const attempt = () => {
      try { if (typeof requireHoopOrPrompt === 'function') { requireHoopOrPrompt(); return; } } catch {}
      setTimeout(attempt, 300);
    };
    attempt();
  });

  const bootVideoPipelines = async () => {
    try { if (!window.poseDetector) await initPoseDetector?.(); } catch {}
    startPreDetectWarm(v);
    scheduleArmWhenReady(0);
  };
  v?.addEventListener('loadedmetadata', ()=>bootVideoPipelines(), { once:true });
  if (v?.readyState >= 1) { bootVideoPipelines(); }

  const camBtn=document.getElementById('useCameraBtn');
  camBtn?.addEventListener('click', ()=>startCamera());

  // Re-arm when hoop is locked
  window.addEventListener('hoop:locked',    ()=>{ window.startShotTrackingCountdown?.(5); setTimeout(()=>scheduleArmWhenReady(0), 5050); });
  window.addEventListener('hoop:confirmed', ()=>{ window.startShotTrackingCountdown?.(5); setTimeout(()=>scheduleArmWhenReady(0), 5050); });



  // Tiny paint loop
  function paint(){ const last=window.lastDetectedFrame||{}; drawLiveOverlay?.(last.objects||[], playerState); requestAnimationFrame(paint); }
  requestAnimationFrame(paint);
});
