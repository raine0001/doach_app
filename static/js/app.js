// app.js — Single-owner: release + microclip. No cap checks. No enders. No UI table.
// Emits:  shot:release, shot:summary
// Reads:  getLockedHoopBox, releaseGate, playerState
// Calls:  video_ui (for prompts only), microclip upload endpoint
// Leaves: session start/end, cap, persistence, table rendering to other modules.

try { window.__appJsLoaded = true; } catch {}

// ---------- Imports (only what this file actually uses) ----------
import {
  ensureOverlayCss,
  initOverlay,
  drawLiveOverlay,
  sendFrameToDetect,
  syncOverlayToVideo,
} from './fix_overlay_display.js';

import {
  handleHoopSelection,
  getLockedHoopBox,
  canonHoop,
  stabilizeLockedHoop,
  filterObjectsToLockedHoop
} from '/static/arc_mm/hoop_tracker.js';

import {
  initPoseDetector,
  updatePlayerTracker,
  playerState
} from './player_tracker.js';

import { showPromptMessage as uiShowPromptMessage } from './video_ui.js';
import { setReleaseKnobs } from './release_gate.js';
import { speak } from './coach_voice.js';


// ---------- Ownership contract ----------
window.DOACH_OWNER = Object.freeze({
  releaseOwner: 'app',
  clipOwner: 'app',
  // endOwner and capOwner intentionally not here; other modules own them
});

// ---------- Minimal knobs (no cap logic here) ----------
window.REL_COOLDOWN_MS  = window.REL_COOLDOWN_MS ?? 2000; // UI lockout between releases
window.POSE_STREAK_NEED = window.POSE_STREAK_NEED ?? 2;   // arming pose streak
window.__POSE_ONLY_MODE = true;                           // allow fallback summaries if clip disabled
window.USE_MICROCLIP    = window.USE_MICROCLIP ?? true;
window.__MICROCLIP_MS   = window.__MICROCLIP_MS ?? 3000;  // 3s clip

window.NEXT_SHOT_UNLOCK_MS = 800;     // UI unlock sooner
window.DOACH_RELEASE_TRACE = true;    // logs snapshots and forced summaries
window.ENTRY_ARM_COOLDOWN_MS = window.ENTRY_ARM_COOLDOWN_MS ?? 1500; // ms cooldown after arming before release allowed

// set some sane release gate defaults
try { setReleaseKnobs({ scoreThresh: 0.7, streakNeed: 1, hudScoreTrip: 0.5 }); } catch {}


// ---------- Tiny prompt helpers ----------
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
  el.style.fontSize = big ? '140px' : '28px';
  el.style.fontWeight = big ? '900' : '700';
  el.style.padding = big ? '0 32px' : '18px 28px';
  el.style.minWidth = big ? 'auto' : '320px';
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
function showPromptCompat(text, duration = 4000, opts = {}){
  const voice = opts.voice !== false;
  if (voice) { try { speak(text); } catch {} }
  if (typeof uiShowPromptMessage === 'function') uiShowPromptMessage(text, duration);
  else localShowPrompt(text, duration);
}
function hidePromptCompat(){
  if (typeof window.hidePromptMessage === 'function') window.hidePromptMessage();
  else localHidePrompt();
}


// ---------- Shot store (frontend HUD backing only; no server writes here) ----------
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

  function cleanCoach(text){ const s=String(text||''); const ban=/\b(made|miss|went in|did not go in)\b/i; return s.split(/(?<=[.!?])\s+/).filter(t=>!ban.test(t)).join(' ').trim(); }
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
  });
})();


// ---------- Pose detect (serialized) ----------
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


// ---------- Microclip (3s) → emits one shot:summary ----------
(function installMicroclip(){
  if (window.__mcInstalled) return; window.__mcInstalled = true;

  const supported =
    typeof MediaRecorder === 'function' &&
    (MediaRecorder.isTypeSupported?.('video/webm;codecs=vp9') ||
     MediaRecorder.isTypeSupported?.('video/webm;codecs=vp8') ||
     MediaRecorder.isTypeSupported?.('video/webm'));
  window.__CLIPS_AVAILABLE = !!supported;

  function emitMicroclipSummary(shotId) {
    try {
      const list = window.__shotList || [];
      const row  = list.find(r => r && (r.id === shotId || r.idx === shotId)) || list.at?.(-1) || {};
      const hadRowSnapshot = !!row?.poseSnapshot;
      const storeSnap = Number.isFinite(shotId) ? (window.poseStore?.get(shotId) || null) : null;
      const snap = row?.poseSnapshot || storeSnap || null;
      if (!hadRowSnapshot && snap) {
        console.warn('[pose:summary] using cached pose snapshot', { shotId, source: storeSnap ? 'store' : 'row' });
      }
      if (!snap) {
        console.error('[pose:summary] no pose snapshot available for summary', { shotId, storeHasPose: !!storeSnap });
      }

      const sum = {
        id: shotId,
        shotId,
        made: null, arcHeight: null, entryAngle: null, releaseAngle: null,
        poseSnapshot: snap || null
      };
      window.recordShotSummary?.(sum);
      window.dispatchEvent(new CustomEvent('shot:summary', { detail: sum }));
    } catch (err) {
      console.error('[pose:summary] emit failed', { shotId, error: String(err) });
    }
  }
  window.emitMicroclipSummary = emitMicroclipSummary; // keep fallback callable

  async function startMicroClip(shotId, releaseFrame = null){
    if (!window.USE_MICROCLIP || !window.__CLIPS_AVAILABLE) {
      window.updateShot?.(shotId, { clip:{ status:'disabled' } });
      emitMicroclipSummary(shotId);
      return;
    }

    const v = document.getElementById('videoPlayer');
    const stream = v?.srcObject || v?.captureStream?.();
    if (!stream || !stream.getVideoTracks?.().length) {
      window.updateShot?.(shotId, { clip:{ status: stream ? 'no-video-track' : 'no-stream' } });
      emitMicroclipSummary(shotId);
      return;
    }

    const mime = ['video/webm;codecs=vp9','video/webm;codecs=vp8','video/webm']
      .find(m => { try { return MediaRecorder.isTypeSupported(m); } catch { return false; }});
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks = [];

    rec.ondataavailable = e => { if (e?.data?.size) chunks.push(e.data); };
    rec.onerror = e => { window.updateShot?.(shotId, { clip:{ status:'error', reason:String(e?.error || 'recorder') } }); };

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
      fd.append('clip', blob, `shot-${shotId}.webm`);

      try {
        const r  = await fetch('/api/microclip/upload', { method:'POST', body: fd });
        const j  = await r.json().catch(() => null);
        const sid  = window.__SESSION_ID || null;
        const file = sid ? `/sessions/${sid}/clips/shot-${shotId}.webm` : null;
        window.updateShot?.(shotId, {
          clip:{ status: r.ok ? 'saved' : 'error', path: j?.path || file, bytes: blob.size, frame: releaseFrame, ms: window.__MICROCLIP_MS }
        });
      } catch (err) {
        window.updateShot?.(shotId, { clip:{ status:'error', reason:String(err) } });
      } finally {
        emitMicroclipSummary(shotId);
      }
    };

    try { if (v?.paused) await v.play(); } catch {}
    rec.start();
    const ms = Number(window.__MICROCLIP_MS) || 3000;
    setTimeout(() => { try { rec.requestData?.(); } catch {} }, Math.max(0, ms - 50));
    setTimeout(() => { try { rec.state !== 'inactive' && rec.stop(); } catch {} }, ms);

    window.updateShot?.(shotId, { clip:{ status:'recording', ms, frame: releaseFrame } });
    if (window.__sessionTotals) window.__sessionTotals.attempts = (window.__sessionTotals.attempts || 0) + 1;
  }

  window.__startMicroClip = startMicroClip;
})();



// ---------- Optional arc helper ----------
function shotArcProx(hoopBox){
  try { return window.__shotArcModule?.()?.proxFromHoop?.(hoopBox) ?? null; } catch { return null; }
}

// --- Pick the best release frame from very recent history and snapshot it
(function(){
  // local helpers (no global pollution)
  function angleFromHorizontal(u){
    if (!u || !Number.isFinite(u.x) || !Number.isFinite(u.y)) return null;
    return Math.abs(Math.atan2(u.y, u.x) * 180 / Math.PI); // 0=horiz, 90=vertical
  }

  // Score a frame: higher is more "release-like"
  function scoreFrameKP(kp){
    if (!Array.isArray(kp) || kp.length < 33) return -1e9;
    const sh = kp[12], wr = kp[16]; // right side (more stable for most)
    if (!sh || !wr) return -1e9;

    // 1) wrist above shoulder (strong cue)
    const wristAbove = (wr.y < sh.y) ? 1 : 0;

    // 2) forearm verticality (closer to 90 better)
    const fore = { x: wr.x - sh.x, y: wr.y - sh.y };
    const angH = angleFromHorizontal(fore);        // 0..90
    const vertScore = Number.isFinite(angH) ? (90 - Math.abs(90 - angH)) : -90; // 90 at perfect vertical

    // 3) small bias toward frames with higher wrist (lower y in screen coords)
    const wristHeightBias = Number.isFinite(wr.y) ? (-wr.y) : 0;

    // composite: weight wristAbove strongly, then verticality, then small height bias
    return wristAbove * 200 + vertScore * 2 + wristHeightBias * 0.02;
  }

  // Choose the "best" frame from the last ~10 frames and snapshot it
  window.snapshotAtRelease = function snapshotAtRelease(hoopBox){
    try {
      const hist = (window.playerState?.frameHistory || []);
      if (!hist.length) return null;

      // Look at the last ~10 frames; widen to 14 if you want more slack
      const slice = hist.slice(-10);
      let best = null, bestScore = -1e9;

      for (const f of slice) {
        const kp = f?.keypoints;
        const s = scoreFrameKP(kp);
        if (s > bestScore) { bestScore = s; best = kp; }
      }
      if (!best) return null;

      return window.extractPoseSnapshot?.(best, hoopBox) || null;
    } catch { return null; }
  };
})();


function clonePoseSnapshotLocal(snap) {
  if (!snap || typeof snap !== 'object') return null;
  try { return structuredClone ? structuredClone(snap) : JSON.parse(JSON.stringify(snap)); } catch {
    try { return JSON.parse(JSON.stringify(snap)); } catch { return null; }
  }
}

// ---------- Pose snapshot store ----------
(function installPoseSnapshotStore(){
  if (window.__poseSnapshotStoreInstalled) return;
  window.__poseSnapshotStoreInstalled = true;

  const store = new Map();
  const meta  = new Map();

  function normalizeShotId(id) {
    const num = Number(id);
    return Number.isFinite(num) && num > 0 ? num : null;
  }

  function cloneForStore(snap) {
    if (!snap || typeof snap !== 'object') return null;
    try { return structuredClone ? structuredClone(snap) : JSON.parse(JSON.stringify(snap)); } catch {
      try { return JSON.parse(JSON.stringify(snap)); } catch { return null; }
    }
  }

  const api = {
    set(shotId, snap, opts = {}) {
      const id = normalizeShotId(shotId);
      if (!id || !snap || typeof snap !== 'object') return false;
      const overwrite = opts.overwrite === true;
      if (!overwrite && store.has(id)) return false;
      const cloned = cloneForStore(snap);
      if (!cloned) return false;
      store.set(id, cloned);
      meta.set(id, { source: opts.source || 'unknown', capturedAt: Date.now() });
      try { window.__LAST_POSE_SNAP = cloneForStore(cloned) || cloned; } catch {}
      return true;
    },
    get(shotId) {
      const id = normalizeShotId(shotId);
      if (!id) return null;
      const value = store.get(id);
      return value ? (cloneForStore(value) || value) : null;
    },
    has(shotId) {
      const id = normalizeShotId(shotId);
      return id ? store.has(id) : false;
    },
    info(shotId) {
      const id = normalizeShotId(shotId);
      return id ? (meta.get(id) || null) : null;
    },
    clear() {
      store.clear();
      meta.clear();
    },
    entries() {
      return Array.from(store.entries()).map(([id, snap]) => ({ id, snap: cloneForStore(snap) || snap, meta: meta.get(id) || null }));
    }
  };

  window.poseStore = api;
  window.__POSE_RELEASES = store;

  const reset = () => { try { api.clear(); } catch {}; };
  window.addEventListener('hud:start-session', reset, { passive: true });
})();

function setPoseIfMissing(shotId, snap) {
  if (!snap || typeof snap !== 'object') return null;
  let resolved = clonePoseSnapshotLocal(snap) || null;
  if (!resolved && typeof snap === 'object') resolved = snap;
  try {
    const map = window.__shots;
    const existing = map?.get?.(shotId)?.poseSnapshot;
    if (existing && typeof existing === 'object') {
      resolved = existing;
    } else if (resolved) {
      window.updateShot?.(shotId, { poseSnapshot: resolved });
    }
  } catch {}
  try { if (resolved) window.poseStore?.set(shotId, resolved, { source: 'shot-store', overwrite: false }); } catch {}
  return resolved || null;
}

// ---------- Release emitter (single source) ----------
(function installReleaseCore(){
  if (window.safeEmitRelease) return;

  // The main export: safeEmitRelease(frame, via, opts)
  window.safeEmitRelease = function safeEmitRelease(frame, via='unknown', opts={}) {
    // short cooldown latch
    const now = performance.now();
    const __now = performance.now();
    if (window.__RELEASE_LOCK_UNTIL && __now < window.__RELEASE_LOCK_UNTIL) return false;
    {
      const need = Number(window.REL_COOLDOWN_MS || 1200);
      const ui   = Number(window.NEXT_SHOT_UNLOCK_MS ?? 1200);
      // lock until the longer of UI unlock or cooldown
      window.__RELEASE_LOCK_UNTIL = __now + Math.max(need, ui);
    }

    // time latch
    if (Number.isFinite(window.__releaseLatchUntil) && now < window.__releaseLatchUntil) return false;
    window.__releaseLatchUntil = now + 800;

    // frame latch
    const fnum = Number(frame || 0);
    if (Number.isFinite(window.__LAST_FIRED_FRAME) &&
        Math.abs(fnum - window.__LAST_FIRED_FRAME) <= 2) return false;
    window.__LAST_FIRED_FRAME = fnum;

    // Hoop guard
    const hoopBox = (window.getLockedHoopBox?.()) || (typeof getLockedHoopBox === 'function' ? getLockedHoopBox() : null);
    if (!hoopBox) { console.warn('[safeEmitRelease] no hoop'); return false; }

    // cooldown vs last fire
    const since = now - (Number(window.__REL_LAST_FIRE_MS||0));
    const need  = Number(window.REL_COOLDOWN_MS||1200);
    if (since < need) return false;

    // Release gate (unless bypass)
    if (!opts?.bypassGate) {
      const hist = (window.playerState?.frameHistory || []).slice(-8);
      const gate = (typeof window.releaseGate === 'function') ? window.releaseGate(hist) : { released:true, tests:{} };
      if (!gate.released) return false;
    }

    // Capture the release snapshot from recent history (not the idle/reset pose)
    const poseHistory = window.playerState?.frameHistory || [];
    const poseHistoryFrames = poseHistory.slice(-12)
      .map(f => Number.isFinite(f?.frame) ? f.frame : null)
      .filter(f => f !== null);
    let poseCaptureSource = 'history';
    let poseCaptureOk = false;
    let poseCaptureError = null;
    let releaseSnapshot = null;
    let canonicalSnapshot = null;
    const gatePayload = opts?.gate || null;

    const persistReleaseMark = async (snapshot, label = via) => {
      if (!snapshot) return false;
      try {
        if (!window.__SESSION_ID) {
          try {
            const started = await window.doachSession?.start?.();
            if (!window.__SESSION_ID && started) window.__SESSION_ID = started;
          } catch {
            console.warn('[pose:release] unable to start session for release mark', { shotId, label });
          }
        }
        if (!window.__SESSION_ID) {
          console.warn('[pose:release] skipping release_mark persist (no session id)', { shotId, label });
          return false;
        }
        await fetch('/api/release_mark', {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ sessionId: window.__SESSION_ID||null, shotId, frame:fnum, tMs:Date.now(), via: label, hoop: hoopBox, poseSnapshot: snapshot, gate: gatePayload }),
          credentials:'include'
        });
        return true;
      } catch (err) {
        console.warn('[pose:release] persist failed', { shotId, label, error: String(err) });
        return false;
      }
    };
    const summarizePose = (snap) => {
      if (!snap || typeof snap !== 'object') return null;
      const keys = ['stanceWidthFeet','stanceWidth','stanceRatio','elbowExtDeg','armVerticalityDeg','torsoLeanAngle','kneeFlex','feetAngleDiff','headToHoopDeg','followThroughHoldFrames'];
      const out = {};
      for (const key of keys) {
        const val = snap[key];
        if (typeof val === 'number') out[key] = Number(val.toFixed(1));
      }
      return out;
    };
    try {
      const lockedHoop = window.getLockedHoopBox?.() || null;   // OK if null
      let snap = window.snapshotAtRelease?.(lockedHoop) || null;

      if (!snap) {
        poseCaptureSource = 'history-miss';
        const kps = window.playerState?.keypoints || null;
        snap = window.extractPoseSnapshot?.(kps, lockedHoop) || null;
        if (snap) poseCaptureSource = 'current-keypoints';
      }

      if (snap) {
        releaseSnapshot = snap;
        window.__LAST_POSE_SNAP = snap; // always refresh to per-shot release
        poseCaptureOk = true;
      } else if (poseCaptureSource === 'history') {
        poseCaptureSource = 'empty-history';
      }
    } catch (err) {
      poseCaptureError = err;
      poseCaptureSource = 'error';
    }

    // Create shot record (UI) and assign identity
    window.__REL_LAST_FIRE_MS = now;
    const rec    = window.createShot?.();
    const shotId = rec?.id || (Number(window.__SHOT_ID || 0) || 1);

    if (releaseSnapshot) {
      canonicalSnapshot = setPoseIfMissing(shotId, releaseSnapshot) || releaseSnapshot;
      try { window.poseStore?.set(shotId, canonicalSnapshot, { source: 'release', overwrite: true }); } catch {}
      console.log('[shot:update] release snapshot set', { shotId, snapshot: summarizePose(canonicalSnapshot) });
    }

    if (window.DOACH_RELEASE_TRACE === true || !poseCaptureOk) {
      const payload = {
        shotId,
        frame: fnum,
        via,
        poseCaptureOk,
        poseCaptureSource,
        historyFrames: poseHistory.length,
        historyFrameIds: poseHistoryFrames,
        snapshot: summarizePose(releaseSnapshot)
      };
      if (poseCaptureError) payload.poseCaptureError = String(poseCaptureError);
      const logFn = poseCaptureOk ? console.log : console.warn;
      try { logFn('[pose:release] capture status', JSON.stringify(payload)); } catch { logFn('[pose:release] capture status', payload); }
    }

    // Backend marker (async, best-effort)
    persistReleaseMark(canonicalSnapshot).catch(() => {});

    // Emit release (with identity)
    const prox = shotArcProx(hoopBox);
    window.dispatchEvent(new CustomEvent('shot:release', { detail:{ shotId, frame:fnum, via, prox, poseApproved:!!opts.poseApproved } }));

    // Microclip or summary fallback
    if (window.USE_MICROCLIP && window.__CLIPS_AVAILABLE) {
      window.__startMicroClip?.(shotId, fnum);
    } else {
      try { window.emitMicroclipSummary?.(shotId); } catch {}
    }

    // ===== BRUTAL MODE: guarantee usable pose + a summary even if clip stalls =====
    let snapNowStatus = 'not-run';
    let snapNowSummary = null;
    try {
      const snapNow = window.capturePoseSnapshot?.(window.playerState, window.getLockedHoopBox?.());
      if (snapNow) {
        const storedSnap = setPoseIfMissing(shotId, snapNow) || snapNow;
        if (!canonicalSnapshot && storedSnap) {
          canonicalSnapshot = storedSnap;
          try { window.poseStore?.set(shotId, canonicalSnapshot, { source: 'release-immediate', overwrite: true }); } catch {}
          persistReleaseMark(canonicalSnapshot, 'release-immediate').catch(() => {});
        } else {
          try { window.poseStore?.set(shotId, storedSnap, { source: 'release-immediate', overwrite: false }); } catch {}
        }
        snapNowStatus = 'captured';
        snapNowSummary = summarizePose(storedSnap);
      } else {
        snapNowStatus = 'empty';
      }
    } catch (err) {
      snapNowStatus = 'error';
      console.warn('[pose:brutal] immediate capture error', { shotId, frame: fnum, error: String(err) });
    }
    if (window.DOACH_RELEASE_TRACE === true || snapNowStatus !== 'captured') {
      const payload = { shotId, frame: fnum, snapNowStatus, snapshot: snapNowSummary || null };
      if (!payload.snapshot) delete payload.snapshot;
      console.log('[pose:brutal] immediate capture status', payload)
    }

    setTimeout(() => {
      let snapLaterStatus = 'not-run';
      let snapLaterSummary = null;
      try {
        const snapLater = window.capturePoseSnapshot?.(window.playerState, window.getLockedHoopBox?.());
        if (snapLater) {
          const storedSnap = setPoseIfMissing(shotId, snapLater) || snapLater;
          if (!canonicalSnapshot && storedSnap) {
            canonicalSnapshot = storedSnap;
            try { window.poseStore?.set(shotId, canonicalSnapshot, { source: 'release-delayed', overwrite: true }); } catch {}
            persistReleaseMark(canonicalSnapshot, 'release-delayed').catch(() => {});
          } else {
            try { window.poseStore?.set(shotId, storedSnap, { source: 'release-delayed', overwrite: false }); } catch {}
          }
          snapLaterStatus = 'captured';
          snapLaterSummary = summarizePose(storedSnap);
        } else {
          snapLaterStatus = 'empty';
        }
        window.emitMicroclipSummary?.(shotId);
      } catch (err) {
        snapLaterStatus = 'error';
        console.warn('[pose:brutal] delayed capture error', { shotId, frame: fnum, error: String(err) });
      } finally {
        if (window.DOACH_RELEASE_TRACE === true || snapLaterStatus !== 'captured') {
          const payload = { shotId, frame: fnum, snapLaterStatus, snapshot: snapLaterSummary || null };
          if (!payload.snapshot) delete payload.snapshot;
          console.log('[pose:brutal] delayed capture status', payload)
        }
      }
    }, 650);





    // Ask coach (UI can overlay tips, voice happens on summary)
    window.dispatchEvent(new CustomEvent('shot:feedback:request', { detail:{ shotId, via } }));

    // Disarm immediately; re-arm after a short settle
    try { window.__shotTrackingArmed = false; } catch {}
    try { window.armAfterArmDown?.({ sampleMs: 90, minDownFrames: 8 }); } catch {}

    return true;
  };
})();

// --- Pose-reset rearm: wait for wrist below shoulder (no timer spam)
function armAfterArmDown(opts = {}) {
  const sampleMs = Number(opts.sampleMs ?? 90);
  const needDownFrames = Number(opts.minDownFrames ?? 8); // ~0.7s @ 90ms
  const shoulderMarginPx = Number(opts.shoulderMarginPx ?? 6); // tiny hysteresis
  let streak = 0;

  try { clearInterval(window.__armDownTimer); } catch {}
  window.__armDownTimer = setInterval(() => {
    try {
      const k = window.playerState?.keypoints;
      if (!Array.isArray(k) || k.length < 33) { streak = 0; return; }

      const sh = k[12];   // RIGHT_SHOULDER
      const wr = k[16];   // RIGHT_WRIST
      if (!sh || !wr || !Number.isFinite(sh.y) || !Number.isFinite(wr.y)) { streak = 0; return; }

      // 1) Wrist truly back below shoulder
      const wristBelowShoulder = wr.y > (sh.y - shoulderMarginPx);

      // 2) Not in “release posture” anymore (use your exported helper)
      const notInReleasePose = (typeof window.isPoseInReleasePosition === 'function')
        ? !window.isPoseInReleasePosition(k)
        : true; // if unknown, err on the cautious side

      if (wristBelowShoulder && notInReleasePose) streak++; else streak = 0;

      if (streak >= needDownFrames) {
        clearInterval(window.__armDownTimer);
        window.__shotTrackingArmed = true;
        try { window.__ENTRY_ARM_BLOCK_UNTIL = Date.now() + Number(window.ENTRY_ARM_COOLDOWN_MS || 1500); } catch {}
        window.dispatchEvent(new CustomEvent('hud:armed'));
      }
    } catch { streak = 0; }
  }, sampleMs);
}
window.armAfterArmDown = window.armAfterArmDown || armAfterArmDown;




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
    if (streak>=need) {
      window.__shotTrackingArmed = true;
      try { window.__ENTRY_ARM_BLOCK_UNTIL = Date.now() + Number(window.ENTRY_ARM_COOLDOWN_MS || 1500); } catch {}
    }
  }, Math.max(0,delay));
}
window.scheduleArmWhenReady = scheduleArmWhenReady;


// ---------- Hoop pick once ----------
export function enableHoopPickOnce() {
  const ov  = document.getElementById('overlay');
  const vid = document.getElementById('videoPlayer');
  if (!ov || !vid) return;
  if (window.__hoopConfirmed) return;

  window.__pickingHoop   = true;
  ov.style.pointerEvents = 'auto';
  ov.style.touchAction   = 'none';
  ov.style.cursor        = 'crosshair';
  ov.style.zIndex        = '100';
  vid.style.pointerEvents = 'none';

  showPromptCompat('Tap the Hoop to Begin', 4000);

  syncOverlayToVideo?.();

  const finish = () => {
    window.__hoopConfirmed = true;
    window.__pickingHoop   = false;
    ov.style.cursor        = 'default';
    ov.style.pointerEvents = 'none';
    vid.style.pointerEvents = '';
    hidePromptCompat();

    // live paint + periodic pose sample to keep tracker fresh
    try { cancelAnimationFrame(window.__coachPaintRaf); } catch {}
    const paint = () => {
      const last = window.lastDetectedFrame || {};
      try { drawLiveOverlay?.(last.objects || [], window.playerState); } catch {}
      window.__coachPaintRaf = requestAnimationFrame(paint);
    };
    window.__coachPaintRaf = requestAnimationFrame(paint);

    try { clearInterval(window.__coachPoseInterval); } catch {}
    window.__coachPoseInterval = setInterval(async ()=>{
      try {
        if (window.__coachPoseBusy) return;
        window.__coachPoseBusy = true;
        const v = document.getElementById('videoPlayer');
        if (!v?.videoWidth) return;
        const res = await (window.poseDetectSerial?.() || Promise.resolve(null));
        const raw = res?.landmarks;
        const cand = Array.isArray(raw?.[0]) ? raw[0] : raw;
        if (!Array.isArray(cand) || cand.length < 33) return;
        const looksNorm = cand.every(k=>k && Number.isFinite(k.x) && Number.isFinite(k.y) && k.x<=1.01 && k.y<=1.01);
        const sx = looksNorm ? v.videoWidth : 1;
        const sy = looksNorm ? v.videoHeight: 1;
        const scaled = cand.map(k=>({ ...k, x:k.x*sx, y:k.y*sy }));
        const fps = Number(window.__videoFPS) || 30;
        const fidx = Math.max(0, Math.round((v.currentTime || 0) * fps));
        updatePlayerTracker?.(scaled, fidx);

        
      } finally { window.__coachPoseBusy = false; }
    }, Math.max(80, Number(window.COACH_POSE_MS || 120)));
  };

  let picked = false;
  const pickOnce = (e) => {
    if (picked) return;
    picked = true;
    try {
      e.preventDefault?.(); e.stopPropagation?.();
      handleHoopSelection?.(e, ov, window.lastDetectedFrame, document.getElementById('overlayPrompt'));
      const H = getLockedHoopBox?.(); if (H) attachHoop?.(H);
      finish();
    } finally {
      ov.removeEventListener('pointerdown', pickOnce);
      ov.removeEventListener('click',       pickOnce);
    }
  };

  ov.addEventListener('pointerdown', pickOnce, { passive:false, once:true });
  ov.addEventListener('click',       pickOnce, { passive:true  });
}
window.enableHoopPickOnce = enableHoopPickOnce;

export function attachHoop(hoopLocked){
  if (!hoopLocked) return;
  const prev = (window.ballState ||= {}).hoop || {};
  let w = Number(hoopLocked.w ?? hoopLocked.width  ?? prev.w ?? 140);
  let h = Number(hoopLocked.h ?? hoopLocked.height ?? prev.h ?? 100);
  let cx, cy, x, y;

  if (Number.isFinite(hoopLocked.cx) && Number.isFinite(hoopLocked.cy)) {
    cx = Math.round(hoopLocked.cx); cy = Math.round(hoopLocked.cy);
    x  = Math.round(cx - w / 2);    y  = Math.round(cy - h / 2);
  } else if (Number.isFinite(hoopLocked.x) && Number.isFinite(hoopLocked.y) && hoopLocked.anchor === 'topleft') {
    x = Math.round(hoopLocked.x); y = Math.round(hoopLocked.y);
    cx = x + Math.round(w/2);    cy = y + Math.round(h/2);
  } else if (Number.isFinite(hoopLocked.x) && Number.isFinite(hoopLocked.y)) {
    cx = Math.round(hoopLocked.x); cy = Math.round(hoopLocked.y);
    x  = Math.round(cx - w / 2);   y  = Math.round(cy - h / 2);
  } else return;

  window.ballState.hoop = { x, y, w, h, cx, cy, anchor:'topleft' };
}


// ---------- Camera boot ----------
export async function startCamera(){
  const v=document.getElementById('videoPlayer');
  const o=document.getElementById('overlay');
  if (!v||!o) return false;

  if (v.srcObject) { try{ v.srcObject.getTracks().forEach(t=>t.stop()); }catch{} }

  v.muted = true;
  v.setAttribute('muted','');
  v.setAttribute('playsinline','');
  v.autoplay = true;

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width:{ideal:1280}, height:{ideal:720}, frameRate:{ideal:30} },
      audio: false
    });
  } catch (errIdeal) {
    console.warn('[camera] ideal constraints failed', errIdeal);
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    } catch (errFallback) {
      console.error('[camera] fallback getUserMedia failed', errFallback);
      return false;
    }
  }

  v.srcObject = stream;
  await new Promise(res=>v.addEventListener('loadedmetadata', res, { once:true }));
  try{ await v.play(); }catch(e){ console.warn('autoplay blocked'); return false; }

  if (!window.poseDetector) await initPoseDetector?.();

  ensureOverlayCss(); initOverlay?.(o); syncOverlayToVideo();
  window.__SESSION_ACTIVE = true;

  startPreDetectWarm(v);
  enableHoopPickOnce();
  return true;
}
window.startCamera = startCamera;


// ---------- Pre-detect loop (lightweight) ----------
function startPreDetectWarm(videoEl){
  if (window.__warmLoop) { try { clearTimeout(window.__warmLoop); } catch {} window.__warmLoop = null; }
  const buf=document.createElement('canvas'); const ctx=buf.getContext('2d',{willReadFrequently:true});
  let lastPD=0; const MIN_DT = Number(window.__PREDETECT_MIN_DT || 100);

  async function tick(){
    if (!videoEl?.videoWidth) return schedule();
    if (buf.width!==videoEl.videoWidth || buf.height!==videoEl.videoHeight){ buf.width=videoEl.videoWidth; buf.height=videoEl.videoHeight; }
    ctx.drawImage(videoEl,0,0,buf.width,buf.height);

    const now=performance.now();
    if (now-lastPD>=MIN_DT){
      lastPD=now;
      try{
        // advance the analysis frame index once per iteration
        const nextIdx = (Number(window.__AN_IDX || 0) + 1) | 0;
        window.__AN_IDX = nextIdx;

        const res=await poseDetectSerial();
        const ls=res?.landmarks||[];
        if (Array.isArray(ls)&&ls.length>=33){
          const looksNorm = ls.every(k=>k&&k.x<=1.01&&k.y<=1.01);
          const sx=looksNorm?videoEl.videoWidth:1, sy=looksNorm?videoEl.videoHeight:1;
          const scaled = ls.map(k=>({...k, x:k.x*sx, y:k.y*sy}));
          updatePlayerTracker?.(scaled,nextIdx);
        }

        let objects=[];
        try {
          const det=await sendFrameToDetect(buf,nextIdx);
          objects = det?.objects || [];
        } catch {}
        stabilizeLockedHoop?.(objects);
        objects=filterObjectsToLockedHoop?.(objects)??objects;
        window.lastDetectedFrame = { __frameIdx: nextIdx, objects, poses:[] };
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
    if (Date.now() < (window.__ENTRY_ARM_BLOCK_UNTIL || 0)) return;
    const hist = (window.playerState?.frameHistory || []).slice(-8);
    const gate = window.releaseGate ? window.releaseGate(hist) : { released: false };
    if (!gate.released) return;
    const f = window.playerState?.lastFrame ?? 0;
    window.safeEmitRelease?.(f, 'pose-sampler', { gate, poseApproved: true, bypassGate: true });
  }

  function loop(){ try{ tryRelease(); }catch{} window.__poseSamplerT = setTimeout(loop, Number(window.COACH_POSE_MS||120)); }
  loop();

  window.addEventListener('hud:end-session', ()=>{ try{ clearTimeout(window.__poseSamplerT); }catch{} }, { passive:true });
})();

// === Sampler stand-down after a release (no duplicate shots during cooldown) ===
(function(){
  // block the sampler until this time
  window.__SAMPLER_BLOCK_UNTIL = 0;

  // set block on each release
  window.addEventListener('shot:release', () => {
    const need = Number(window.REL_COOLDOWN_MS || 1200);
    window.__SAMPLER_BLOCK_UNTIL = performance.now() + need;
  }, { passive:true });

  // tiny guard for the sampler loop (add at the top of tryRelease)
  const _origTryRelease = window.__TRY_RELEASE_ORIG__ || null;
  if (!_origTryRelease && typeof tryRelease === 'function') {
    window.__TRY_RELEASE_ORIG__ = tryRelease;
    window.tryRelease = function(){
      if (performance.now() < (window.__SAMPLER_BLOCK_UNTIL || 0)) return;
      return window.__TRY_RELEASE_ORIG__.apply(this, arguments);
    };
  }
})();






// ---------- Boot ----------
document.addEventListener('DOMContentLoaded', ()=>{
  const v=document.getElementById('videoPlayer');
  const ov=document.getElementById('overlay');
  if (!v||!ov) return;

  ensureOverlayCss(); 
  initOverlay?.(ov); 
  syncOverlayToVideo();

  window.__IOS_VID_LOCK = window.__IOS_VID_LOCK || {};
  window.__IOS_VID_LOCK.get = () => window.__IOS_VID_LOCK.state || 'open';
  window.__IOS_VID_LOCK.set = (s) => { window.__IOS_VID_LOCK.state = s; };

const bootPipelines = async () => {
    try { if (!window.poseDetector) await initPoseDetector?.(); } catch {}
    startPreDetectWarm(v);
    scheduleArmWhenReady(0);
  };
  v?.addEventListener('loadedmetadata', ()=>{
    window.__IOS_VID_LOCK.set('open');
    bootPipelines();
  }, { once:true });
  if (v?.readyState >= 1) {
    window.__IOS_VID_LOCK.set('open');
    bootPipelines();
  }

  document.getElementById('useCameraBtn')?.addEventListener('click', async ()=>{
    window.__IOS_VID_LOCK.set('opening');
    try { await startCamera(); } finally { window.__IOS_VID_LOCK.set('open'); }
  });

  window.addEventListener('orientationchange', async () => {
    window.__IOS_VID_LOCK.set('rotating');
    try {
      const label = window.getCameraFacing ? window.getCameraFacing() : null;
      const ok = label && window.setCameraFacing ? await window.setCameraFacing(label) : false;
      if (!ok) {
        try { await startCamera(); } catch (err) { console.warn('[camera] rehydrate after rotation failed', err); }
      }
    } finally {
      window.__IOS_VID_LOCK.set('open');
    }
  });

  // Re-arm when hoop is locked/confirmed
  window.addEventListener('hoop:locked',    ()=>{ window.startShotTrackingCountdown?.(5); setTimeout(()=>scheduleArmWhenReady(0), 5050); }, { passive:true });
  window.addEventListener('hoop:confirmed', ()=>{ window.startShotTrackingCountdown?.(5); setTimeout(()=>scheduleArmWhenReady(0), 5050); }, { passive:true });

  // Tiny paint loop
  function paint(){ const last=window.lastDetectedFrame||{}; drawLiveOverlay?.(last.objects||[], playerState); requestAnimationFrame(paint); }
  requestAnimationFrame(paint);
});



(function installObserverStreamer(){
  if (window.__observerStreamerInstalled) return;
  window.__observerStreamerInstalled = true;

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { alpha: false });
  let timer = null;
  let inFlight = false;
  let seq = 0;
  let targetSid = null;
  const EVENT_CAP = 80;
  const events = [];

  function pushEvent(type, detail){
    try {
      events.push({
        type: String(type || 'event'),
        detail: detail ?? null,
        frame: Number(window.__AN_IDX || null) || null,
        ts: Date.now()
      });
      if (events.length > EVENT_CAP) events.splice(0, events.length - EVENT_CAP);
    } catch {}
  }

  function safePoint(pt){
    if (!pt || typeof pt !== 'object') return null;
    const x = Number(pt.x);
    const y = Number(pt.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const out = { x, y };
    if (Number.isFinite(pt.z)) out.z = Number(pt.z);
    return out;
  }

  function copyTrail(list, cap = 140){
    if (!Array.isArray(list) || !list.length) return [];
    const out = [];
    const start = Math.max(0, list.length - cap);
    for (let i = start; i < list.length; i += 1){
      const pt = safePoint(list[i]);
      if (pt) out.push(pt);
    }
    return out;
  }

  function copyObjects(objs){
    if (!Array.isArray(objs)) return [];
    return objs.slice(0, 12).map((o) => {
      const label = o?.label || o?.class || o?.type || null;
      const score = Number.isFinite(o?.score) ? Number(o.score) : (Number(o?.confidence) || null);
      let box = null;
      if (Array.isArray(o?.box)) box = o.box.slice(0, 6);
      else if (Array.isArray(o?.bbox)) box = o.bbox.slice(0, 6);
      else if (Array.isArray(o?.rect)) box = o.rect.slice(0, 6);
      return { label, score, box };
    });
  }

  function safeClone(src){
    if (!src || typeof src !== 'object') return null;
    try { return JSON.parse(JSON.stringify(src)); }
    catch { return null; }
  }

  const shotFields = ['id','idx','frameStart','frameEnd','made','pending','result','gate','poseSnapshot','trail','clip'];
  function copyShots(list){
    if (!Array.isArray(list)) return [];
    return list.slice(-8).map((shot) => {
      if (!shot || typeof shot !== 'object') return null;
      const out = {};
      shotFields.forEach((key) => {
        if (shot[key] == null) return;
        if (key === 'trail') out.trail = copyTrail(shot.trail, 80);
        else if (key === 'poseSnapshot') {
          const pose = safeClone(shot.poseSnapshot);
          if (pose?.landmarks) delete pose.landmarks;
          out.poseSnapshot = pose;
        } else if (typeof shot[key] === 'object') {
          out[key] = safeClone(shot[key]);
        } else {
          out[key] = shot[key];
        }
      });
      return out;
    }).filter(Boolean);
  }

  function buildState(width, height){
    const frameIdx = Number(window.__AN_IDX || null) || null;
    const bs = window.ballState || {};
    const arc = window.ballArc || {};
    const detectSrc = window.__DETECT_SOURCE || (window.__forceServerDetect ? 'server' : 'client');
    const last = window.__lastSummary || null;
    const gate = window.__releaseGateLast || null;
    const pose = Number(window.__poseGateStreak ?? window.__POSE_STREAK__ ?? 0);
    const lastFrame = window.lastDetectedFrame || {};
    const shots = copyShots(window.__shotList);

    return {
      ts: Date.now(),
      frame: frameIdx,
      seq: ++seq,
      detectSource: detectSrc,
      overlayMode: window.__OVERLAY_MODE || null,
      view: { vw: width, vh: height },
      bg: { width, height },
      events: events.slice(-40),
      ballStateTrailLen: Array.isArray(bs.trail) ? bs.trail.length : 0,
      ballArcTrailLen: Array.isArray(arc.trail) ? arc.trail.length : 0,
      ballArcRefLen: Array.isArray(arc.refinedTrail) ? arc.refinedTrail.length : 0,
      ballState: {
        state: bs.state || null,
        releaseFrame: bs.releaseFrame ?? null,
        proxEnterFrame: bs.proxEnterFrame ?? null,
        proxExitFrame: bs.proxExitFrame ?? null,
        shots: Array.isArray(bs.frozenShots) ? bs.frozenShots.length : (bs.shots ?? null),
        trail: copyTrail(bs.trail, 160)
      },
      proxRect: safeClone(window.__proxRect || window.__PROX_RECT || null),
      ballArc: {
        trail: copyTrail(arc.trail, 160),
        refinedTrail: copyTrail(arc.refinedTrail, 160),
        releasePoint: safeClone(arc.releasePoint),
        apexPoint: safeClone(arc.apexPoint),
        rimCrossingPoint: safeClone(arc.rimCrossingPoint)
      },
      lastSummary: safeClone(last),
      ballStateFrozen: Array.isArray(bs.frozenShots) ? copyShots(bs.frozenShots) : [],
      objects: copyObjects(lastFrame.objects),
      shots,
      shotCount: Array.isArray(window.__shotList) ? window.__shotList.length : (window.__SESSION_SHOT_COUNT || 0),
      pose: { streak: pose },
      analyzer: { frame: frameIdx },
      gate: gate && typeof gate === 'object' ? safeClone(gate.best || gate) : null,
      detect: lastFrame._source || null
    };
  }

  function stopStreaming(){
    if (timer) { clearInterval(timer); timer = null; }
    targetSid = null;
  }

  async function sendSnapshot(){
    if (!targetSid || inFlight) return;
    const video = document.getElementById('videoPlayer');
    const overlay = document.getElementById('overlay');
    if (!video || !video.videoWidth || !video.videoHeight) return;
    const width = video.videoWidth;
    const height = video.videoHeight;
    canvas.width = width;
    canvas.height = height;
    try { ctx.drawImage(video, 0, 0, width, height); } catch {}
    try {
      if (overlay && overlay.width && overlay.height) {
        ctx.drawImage(overlay, 0, 0, overlay.width, overlay.height, 0, 0, width, height);
      }
    } catch {}
    const blob = await new Promise((resolve) => { canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.7); });
    if (!blob) return;
    const state = buildState(width, height);
    const form = new FormData();
    form.append('image', blob, `frame-${Date.now()}.jpg`);
    try { form.append('state', JSON.stringify(state)); } catch {}
    const base = (typeof window.__API_BASE === 'string') ? window.__API_BASE : '';
    const url = base + '/api/sessions/' + encodeURIComponent(targetSid) + '/observer_frame';
    inFlight = true;
    try {
      await fetch(url, { method: 'POST', body: form, credentials: 'include' });
    } catch (err) {
      console.warn('[observer] upload failed', err);
    } finally {
      inFlight = false;
    }
  }

  window.startObserverStreaming = function startObserverStreaming(fps = 2, sidOverride){
    const sid = sidOverride || window.__SESSION_ID || null;
    if (!sid) {
      console.warn('[observer] no session id available');
      return false;
    }
    targetSid = String(sid);
    const intervalMs = Math.max(300, Math.round(1000 / Math.max(1, Number(fps) || 1)));
    stopStreaming();
    timer = setInterval(sendSnapshot, intervalMs);
    events.length = 0;
    pushEvent('observer:start', { intervalMs });
    sendSnapshot();
    console.info(`[observer] streaming to ${targetSid} every ${intervalMs}ms`);
    return true;
  };

  window.stopObserverStreaming = function stopObserverStreaming(){
    pushEvent('observer:stop', {});
    stopStreaming();
  };

  window.__logObserverEvent = function logObserverEvent(type, detail){
    pushEvent(type, detail);
  };

  window.setObserverAutoStreaming = function(enabled = true, fps = 2){
    try { localStorage.setItem('doach_observer_auto', enabled ? '1' : '0'); } catch {}
    try { localStorage.setItem('doach_observer_fps', String(fps)); } catch {}
    if (enabled) return window.startObserverStreaming(fps);
    window.stopObserverStreaming();
    return true;
  };

  window.getObserverAutoStreaming = function(){
    try { return localStorage.getItem('doach_observer_auto') === '1'; } catch { return false; }
  };

  window.addEventListener('hud:start-session', () => {
    try {
      if (window.getObserverAutoStreaming?.()) {
        const fps = Number(localStorage.getItem('doach_observer_fps')) || 2;
        window.startObserverStreaming?.(fps);
      }
    } catch {}
  }, { passive: true });

  window.addEventListener('hud:end-session', () => {
    try { window.stopObserverStreaming?.(); } catch {}
  }, { passive: true });

})();
