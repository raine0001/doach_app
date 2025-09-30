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
      const snap = row?.poseSnapshot || window.__LAST_POSE_SNAP || null;

      const sum = {
        id: shotId,
        shotId,
        made: null, arcHeight: null, entryAngle: null, releaseAngle: null,
        poseSnapshot: snap || null
      };
      window.recordShotSummary?.(sum);
      window.dispatchEvent(new CustomEvent('shot:summary', { detail: sum }));
    } catch {}
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
    try {
      const lockedHoop = window.getLockedHoopBox?.() || null;   // OK if null
      let snap = window.snapshotAtRelease?.(lockedHoop) || null;

      // Failsafe: if history picker failed, fall back to current keypoints once
      if (!snap) {
        const kps = window.playerState?.keypoints || null;
        snap = window.extractPoseSnapshot?.(kps, lockedHoop) || null;
      }

      if (snap) {
        window.updateShot?.(shotId, { poseSnapshot: snap });
        window.__LAST_POSE_SNAP = snap; // always refresh to per-shot release
      }
    } catch {}


    // Create shot record (UI) and assign identity
    window.__REL_LAST_FIRE_MS = now;
    const rec    = window.createShot?.();
    const shotId = rec?.id || (Number(window.__SHOT_ID || 0) || 1);

    // Backend marker (async, best-effort)
    (async ()=>{
      try {
        if (!window.__SESSION_ID) {
          const rr = await fetch('/api/sessions/start', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ device:navigator.userAgent }), credentials:'include' });
          if (rr.ok) { const jj = await rr.json(); window.__SESSION_ID = jj?.id || null; }
        }
        await fetch('/api/release_mark', {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ sessionId: window.__SESSION_ID||null, shotId, frame:fnum, tMs:Date.now(), via, hoop: hoopBox }),
          credentials:'include'
        });
      } catch {}
    })();

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
    try {
      // 1) Grab a fresh snapshot right now and attach it to the shot row and cache.
      const snapNow = window.capturePoseSnapshot?.(window.playerState, window.getLockedHoopBox?.());
      if (snapNow) {
        window.__LAST_POSE_SNAP = snapNow;
        window.updateShot?.(shotId, { poseSnapshot: snapNow });
      }
    } catch {}

    setTimeout(() => {
      try {
        // 2) Re-sample once more after a short beat, then force-emit another summary.
        //    Yes, this may double-speak. You said you don’t care tonight.
        const snapLater = window.capturePoseSnapshot?.(window.playerState, window.getLockedHoopBox?.());
        if (snapLater) {
          window.__LAST_POSE_SNAP = snapLater;
          window.updateShot?.(shotId, { poseSnapshot: snapLater });
        }
        window.emitMicroclipSummary?.(shotId);
      } catch {}
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
    if (streak>=need) window.__shotTrackingArmed = true;
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

  const bootPipelines = async () => {
    try { if (!window.poseDetector) await initPoseDetector?.(); } catch {}
    startPreDetectWarm(v);
    scheduleArmWhenReady(0);
  };
  v?.addEventListener('loadedmetadata', ()=>bootPipelines(), { once:true });
  if (v?.readyState >= 1) { bootPipelines(); }

  document.getElementById('useCameraBtn')?.addEventListener('click', ()=>startCamera());

  // Re-arm when hoop is locked/confirmed
  window.addEventListener('hoop:locked',    ()=>{ window.startShotTrackingCountdown?.(5); setTimeout(()=>scheduleArmWhenReady(0), 5050); }, { passive:true });
  window.addEventListener('hoop:confirmed', ()=>{ window.startShotTrackingCountdown?.(5); setTimeout(()=>scheduleArmWhenReady(0), 5050); }, { passive:true });

  // Tiny paint loop
  function paint(){ const last=window.lastDetectedFrame||{}; drawLiveOverlay?.(last.objects||[], playerState); requestAnimationFrame(paint); }
  requestAnimationFrame(paint);
});



