// app.js with overlay drawing integrated
// app.js with overlay drawing integrated
// boot marker for E2E
try { window.__appJsLoaded = true; } catch {}
try { if (typeof window.__sessionContinue === 'undefined') window.__sessionContinue = false; } catch {}
import { initOverlay, drawLiveOverlay, sendFrameToDetect,
         syncOverlayToVideo, updateDebugOverlay, ensureOverlayCss,
         installOverlayTracer, removeOverlayTracer } from './fix_overlay_display.js';
import { analyzeVideoFrameByFrame as runAnalyzer } from './analyzer.js';
import { resetShotStats, checkShotConditions, detectNetMotion,
         drawNetMotionStatus, bufferDetectedObjects, scoringTick,
         isBallInProximityZone } from './shot_logger.js';
import { playerState, resetPlayerTracker, updatePlayerTracker, initPoseDetector, markRelease as poseMarkRelease } from './player_tracker.js';
import { stabilizeLockedHoop, getLockedHoopBox, handleHoopSelection, filterObjectsToLockedHoop } from './hoop_tracker.js';
import { createPlaybackControls, initHUDForVideo } from './video_ui.js';
import { ballState, updateBall, resetAll, stepFBFArc, fillArcGaps } from './ball_tracker.js';
import { disposeFrameCollection as disposeMicroClipFrameCollection, serializeError as serializeMicroclipError } from './microclip_core.js';
// Load shot arc FSM (release/exit timing); available for incremental adoption
import { resetShotFSM as _arcReset, updateShotArcTick as _arcTick, proxFromHoop } from './shot_arc.js';
import { asTopLeft, canonHoop, detectNetMotionFromCanvas } from './hoop_tracker.js';
import { mountPrefs } from './ui_prefs.js';
import { initReleaseConfig, releaseGate } from './release_gate.js';

// Global defaults (overridable via console when needed)
window.POSE_WARMUP_FRAMES = 20;          // frames of ok pose before warm status
window.BALL_MIN_SCORE     = 0.30;        // min detector conf for ball
window.BALL_LABELS        = ['ball', 'basketball', 'sports_ball', 'sports ball'];
window.MIN_TRAIL_TO_ARM   = 1;           // at least one fresh sample post-arm
window.__FORCE_LOCAL_DETECTOR__ = window.__FORCE_LOCAL_DETECTOR__ ?? false;
window.__DEV_ALLOW_STALE_TRAIL__ = false; // set true via console only when debugging


// pose detection global settings
window.POSE_REQUIRE_PLAYER_BOX ??= true;   // must see a 'player'/'person' box
window.POSE_MIN_IOU_PLAYER     ??= 0.18;   // overlap with player box
window.POSE_MIN_H              ??= 110;    // min pose height (px)
window.POSE_MIN_AREA_FRAC      ??= 0.006;  // min area vs frame (0.6%)
window.POSE_BELOW_RIM_MIN      ??= 80;     // ankles must be â‰¥80px BELOW rim y
window.POSE_STREAK_NEED        ??= 2;      // require 2 consecutive frames to accept
window.REL_MIN_BALL_POINTS ??= 3;      // minimum ball samples before release
window.REL_MAX_BALL_MS     ??= 260;    // max ms since last ball point
window.PROX_IN_CONSEC_MIN  ??= 2;      // inside-prox streak requirement
window.REL_MIN_SEP_MS      ??= 500;    // min ms between releases
window.REL_MIN_TRAIL_BEFORE_RELEASE ??= 4;

window.__armWhenReadyTimer ??= null;
window.__readyForScoring ??= false;
window.__POSE_WARMUP_OK ??= false;
window.__POSE_STREAK__ ??= 0;
window.__readyForScoringArmedAtMs ??= 0;
window.__readyForScoringBallMsAtArm ??= 0;
window.__armedAtMs ??= 0;
window.__DETECT_SOURCE ??= 'unknown';

window.__REL_LAST_FRAME ??= null;
window.__lastReleaseFrame ??= null;
window.__lastReleaseTs ??= 0;

// ==== Debug Panel (toggleable) ===============================================
(function installDebugPanel(){
  try {
    const path = String(location.pathname || '');
    if (!path.toLowerCase().includes('d_admin')) return;
  } catch {}
  if (window.__dbgPanelInstalled) return;
  window.__dbgPanelInstalled = true;
  function attach(){
    try {
      if (!document || !document.body) { setTimeout(attach, 80); return; }
      if (document.getElementById('doach-debug')) return;
      const el = document.createElement('div');
      el.id = 'doach-debug';
      el.style.cssText = [
        'position:fixed','z-index:999999','right:8px','bottom:8px',
        'width:380px','max-height:46vh','overflow:auto','font:12px/1.35 monospace',
        'background:rgba(0,0,0,0.65)','color:#cfe8ff','border:1px solid #2a6',
        'border-radius:8px','padding:8px 8px 6px'
      ].join(';');
      el.innerHTML = '<div style="margin-bottom:6px;display:flex;gap:8px;align-items:center">' +
                     '<strong>Doach Debug</strong>' +
                     '<button id="dbg-toggle" style="margin-left:auto">pause</button>' +
                     '<button id="dbg-clear">clear</button></div><pre id="dbg-log"></pre>';
      document.body.appendChild(el);
      let paused = false;
      const pre = el.querySelector('#dbg-log');
      const cap = 300;
      function line(t){
        if (paused) return;
        try {
          const ts = new Date().toLocaleTimeString();
          pre.textContent += `[${ts}] ${t}\n`;
          const lines = pre.textContent.split('\n');
          if (lines.length > cap) pre.textContent = lines.slice(-cap).join('\n');
          pre.scrollTop = pre.scrollHeight;
        } catch {}
      }
      window.__dbgLine = line;
      const toggleBtn = el.querySelector('#dbg-toggle');
      if (toggleBtn) {
        toggleBtn.onclick = function(){
          paused = !paused;
          this.textContent = paused ? 'resume' : 'pause';
        };
      }
      const clearBtn = el.querySelector('#dbg-clear');
      if (clearBtn) clearBtn.onclick = function(){ pre.textContent = ''; };
    } catch {}
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attach, { once: true });
  } else {
    attach();
  }
})();

(function gateTicker(){
  try {
    const path = String(location.pathname || '');
    if (!path.toLowerCase().includes('d_admin')) return;
  } catch {}
  if (window.__dbgGateTicker) return;
  window.__dbgGateTicker = true;
  const last = { txt: '' };
  setInterval(() => {
    try {
      const bs = window.ballState || {};
      const flags = [
        `armed:${!!window.__shotTrackingArmed}`,
        `ready:${!!window.__readyForScoring}`,
        `pose:${!!window.__POSE_WARMUP_OK}`,
        `hoop:${!!window.__hoopConfirmed}`
      ].join(' ');
      const trailLen = Array.isArray(bs.trail) ? bs.trail.length : 0;
      const enter = Number.isFinite(bs.proxEnterFrame) ? bs.proxEnterFrame : '-';
      const exit = Number.isFinite(bs.proxExitFrame) ? bs.proxExitFrame : '-';
      const prox = `prox:${enter}->${exit}`;
      const frameIdx = Number(window.__AN_IDX ?? window.__REL_LAST_FRAME ?? 0) || 0;
      const txt = `[gate] ${flags} trail:${trailLen} ${prox} f:${frameIdx}`;
      if (txt !== last.txt) {
        last.txt = txt;
        window.__dbgLine?.(txt);
      }
    } catch {}
  }, 250);
})();

if (typeof window.__dbgBlock !== 'function') {
  window.__dbgBlock = function(reason, extra = {}) {
    try { window.dispatchEvent(new CustomEvent('gate:block', { detail: { reason, extra } })); } catch {}
    try {
      const payload = JSON.stringify(extra);
      window.__dbgLine?.(`[gate:block] ${reason} ${payload}`);
    } catch {
      try { window.__dbgLine?.(`[gate:block] ${reason}`); } catch {}
    }
  };
}

if (typeof window.__dbgMicroclip !== 'function') {
  window.__dbgMicroclip = function(type, payload) {
    try { window.dispatchEvent(new CustomEvent('microclip:echo', { detail: { type, payload } })); } catch {}
    try {
      const safe = JSON.stringify(payload, (key, value) => {
        if (Array.isArray(value) && value.length > 12) return value.slice(0, 12);
        if (typeof value === 'number' && !Number.isFinite(value)) return null;
        return value;
      });
      window.__dbgLine?.(`[microclip:${type}] ${safe.slice(0, 160)}`);
    } catch {
      try { window.__dbgLine?.(`[microclip:${type}] ${String(payload)}`); } catch {}
    }
  };
}

function isBallLabel(label) {
  if (label == null) return false;
  try {
    const list = Array.isArray(window.BALL_LABELS) ? window.BALL_LABELS : [];
    const needle = String(label).toLowerCase();
    return list.includes(needle);
  } catch {
    return false;
  }
}
window.isBallLabel = isBallLabel;

function updatePoseWarmup(resultOrBool) {
  let ok;
  if (typeof resultOrBool === 'object') {
    const marks = resultOrBool?.landmarks;
    if (Array.isArray(marks) && marks.length) {
      if (marks.length >= 33 && typeof marks[0]?.x === 'number') {
        ok = true;
      } else if (Array.isArray(marks[0]) && marks[0].length >= 33) {
        ok = true;
      } else if (typeof marks[0] === 'number' && marks.length >= 99) {
        ok = true;
      } else {
        ok = false;
      }
    } else {
      ok = false;
    }
  } else {
    ok = !!resultOrBool;
  }
  const prev = Number(window.__POSE_STREAK__ || 0);
  const streak = ok ? (prev + 1) : 0;
  window.__POSE_STREAK__ = streak;
  const need = Number(window.POSE_WARMUP_FRAMES ?? 20);
  window.__POSE_WARMUP_OK = streak >= need;
  try { window.__dbgLine?.(`[pose] ok=${ok} streak=${streak}`); } catch {}
  try {
    window.dispatchEvent(new CustomEvent('pose:state', {
      detail: {
        ok,
        streak,
        warm: window.__POSE_WARMUP_OK,
        frame: Number(window.__AN_IDX) || 0
      }
    }));
  } catch {}
  return window.__POSE_WARMUP_OK;
}
window.updatePoseWarmup = updatePoseWarmup;

function ingestServerDetections(dets, tMs = performance.now(), frame) {
  const frameIdx = Number.isFinite(frame) ? Number(frame) : (Number(window.__AN_IDX) || 0);
  const items = Array.isArray(dets) ? dets : [];
  try {
    const summary = items.map(d => `${d?.label ?? d?.class ?? d?.type}:${Number(d?.score ?? d?.confidence ?? 0).toFixed(2)}`).join(', ');
    window.__dbgLine?.(`[det] ${summary || 'none'}`);
    if (summary) console.log('[server:det]', summary); else console.log('[server:det] none');
  } catch {}
  try {
    return (window.__detBroadcast || (() => null))(items, frameIdx, tMs, 'server');
  } catch (err) {
    console.warn('[server-dets] ingest error', err);
    return null;
  }
}
window.ingestServerDetections = ingestServerDetections;

function chooseDetector() {
  try {
    const wantLocal = window.__FORCE_LOCAL_DETECTOR__ === true;
    if (wantLocal && typeof window.enableLocalDetector === 'function') {
      window.__forceServerDetect = false;
      window.__LOCAL_DETECTOR = true;
      const ok = window.enableLocalDetector();
      window.__DETECT_SOURCE = ok ? 'local' : 'server';
      window.__dbgLine?.(ok ? '[LocalDetector] enabled (forced)' : '[LocalDetector] fallback to server');
      if (!ok) window.useServerDetector?.();
    } else {
      window.useServerDetector?.();
      window.__DETECT_SOURCE = 'server';
      window.__dbgLine?.('[ServerDetector] enabled');
    }
  } catch (err) {
    console.warn('[LocalDetector] chooser error', err);
  }
}

window.chooseDetector = chooseDetector;
chooseDetector();

(function bindArcWorker(){
  if (window.__arcBound) return;
  window.__arcBound = true;

  window.addEventListener('shot:release', () => {
    try { window.ballArc = { trail: [], refinedTrail: [] }; } catch {}
  }, { passive: true });

  window.addEventListener('ball:trail-step', (e) => {
    try {
      const d = e?.detail || {};
      const arc = (window.ballArc ||= { trail: [], refinedTrail: [] });
      arc.trail = Array.isArray(arc.trail) ? arc.trail : [];
      arc.trail.push({ x: d.x, y: d.y, frame: d.frame, tMs: d.tMs });
      window.refineArc?.();
      const tLen = arc.trail?.length || 0;
      const rLen = arc.refinedTrail?.length || 0;
      window.__dbgLine?.(`[arc] trail=${tLen} arc=${rLen}`);
    } catch (err) {
      console.warn('[arc] trail-step handler error', err);
    }
  }, { passive: true });

  window.__dbgLine?.('[arc] worker bound to ball:trail-step');
})();

(function ensureCanonHoop(){
  if (window.__canonHoopEnsured) return;
  window.__canonHoopEnsured = true;

  function storeCanon(hb) {
    if (!hb) return null;
    const x = Math.max(0, Math.round(hb.x ?? hb.left ?? 0));
    const y = Math.max(0, Math.round(hb.y ?? hb.top ?? 0));
    const w = Math.max(1, Math.round(hb.w ?? hb.width ?? ((hb.right ?? x) - x)));
    const h = Math.max(1, Math.round(hb.h ?? hb.height ?? ((hb.bottom ?? y) - y)));
    const box = { x, y, w, h, cx: x + w / 2, cy: y + h / 2 };
    window.__canonHoopBox = box;
    return box;
  }

  window.addEventListener('hoop:locked', (e) => {
    const hb = e?.detail?.box || window.getLockedHoopBox?.();
    const box = storeCanon(hb);
    if (!box) window.__dbgLine?.('[hoop] canon missing, waiting for update');
    else window.__dbgLine?.(`[hoop] canon ${box.x},${box.y},${box.w}x${box.h}`);
  }, { passive: true });

  window.addEventListener('hoop:confirmed', (e) => {
    const hb = e?.detail?.box || window.getLockedHoopBox?.();
    storeCanon(hb);
  }, { passive: true });

window.getCanonicalHoopBox = function getCanonicalHoopBox() {
  return window.__canonHoopBox || window.getLockedHoopBox?.() || null;
};
})();

function installBallMotionFallback(videoEl) {
  if (!videoEl) return;
  if (window.__ballMotionInstalled) return;
  window.__ballMotionInstalled = true;

  const cvs = document.createElement('canvas');
  const ctx = cvs.getContext('2d', { willReadFrequently: true });
  let prevROI = null;

  const roiRect = () => {
    const hb = window.getCanonicalHoopBox?.() || window.getLockedHoopBox?.();
    const vw = videoEl.videoWidth || 1280;
    const vh = videoEl.videoHeight || 720;
    if (!hb || !Number.isFinite(hb.x)) {
      const w = Math.round(Math.min(420, vw * 0.3));
      const h = Math.round(Math.min(300, vh * 0.25));
      const x = Math.round(Math.max(0, vw * 0.55 - w * 0.5));
      const y = Math.round(Math.max(0, vh * 0.05));
      return { x, y, w, h };
    }
    const w = Math.max(180, Math.min(480, hb.w * 2.4));
    const h = Math.max(160, Math.min(360, hb.h * 3.2));
    const x = Math.max(0, Math.floor(hb.x + hb.w * 0.1 - w * 0.2));
    const y = Math.max(0, Math.floor(hb.y + hb.h * 0.2 - h * 0.1));
    return { x, y, w: Math.min(w, vw - x), h: Math.min(h, vh - y) };
  };

  const handleFrame = (e) => {
    if (!videoEl.videoWidth || !videoEl.videoHeight) return;
    const frame = Number.isFinite(e?.detail?.frame) ? Number(e.detail.frame) : (Number(window.__AN_IDX) || 0);
    const tMs = Number.isFinite(e?.detail?.tMs) ? Number(e.detail.tMs) : performance.now();

    const { x, y, w, h } = roiRect();
    if (w <= 0 || h <= 0) return;
    cvs.width = w;
    cvs.height = h;
    try {
      ctx.drawImage(videoEl, x, y, w, h, 0, 0, w, h);
    } catch {
      return;
    }
    let cur;
    try {
      cur = ctx.getImageData(0, 0, w, h);
    } catch {
      return;
    }

    if (prevROI && prevROI.width === w && prevROI.height === h) {
      const a = cur.data;
      const b = prevROI.data;
      let max = 0;
      let idx = -1;
      for (let i = 0; i < a.length; i += 4) {
        const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
        if (d > max) { max = d; idx = i; }
      }
      if (idx >= 0 && max > 45) {
        const p = (idx / 4) | 0;
        const px = p % w;
        const py = (p / w) | 0;
        const bx = x + px;
        const by = y + py;
        const conf = Math.min(0.99, max / 255);
        if (Number(window.__lastMotionFrame) === frame) {
          prevROI = cur;
          return;
        }
        if (Number(window.__lastDetectorBallFrame) === frame) {
          prevROI = cur;
          return;
        }
        try { if (!window.__DETECT_SOURCE || window.__DETECT_SOURCE === 'unknown') window.__DETECT_SOURCE = 'motion'; } catch {}
        try {
          window.dispatchEvent(new CustomEvent('ball:point', {
            detail: { x: bx, y: by, conf, frame, tMs, via: 'motion' }
          }));
        } catch {}
        window.__lastMotionFrame = frame;
      }
    }

    prevROI = cur;
  };

  window.addEventListener('video:frame', handleFrame, { passive: true });

  if (!window.__videoFramePump) {
    window.__videoFramePump = setInterval(() => {
      try {
        if (!videoEl.parentNode) return;
        if (videoEl.readyState < 2) return;
        const detail = { frame: Number(window.__AN_IDX) || 0, tMs: performance.now() };
        window.dispatchEvent(new CustomEvent('video:frame', { detail }));
      } catch {}
    }, 160);
  }

  window.__dbgLine?.('[fallback] ball-from-motion active');
}

(function armLoop() {
  if (window.__armLoopBound) return;
  window.__armLoopBound = true;
  const periodMs = 150;
  setInterval(() => {
    try {
      const bs = window.ballState || {};
      const trail = Array.isArray(bs.trail) ? bs.trail : [];
      const last = trail.at?.(-1) || null;
      const hoopOk = !!window.__hoopConfirmed || !!window.getLockedHoopBox?.();
      const poseOk = !!window.__POSE_WARMUP_OK;
      const ready = hoopOk && poseOk;
      if (ready) {
        if (!window.__shotTrackingArmed) {
          window.__shotTrackingArmed = true;
          const armedAt = performance.now();
          window.__armedAtMs = armedAt;
          window.__readyForScoringArmedAtMs = armedAt;
          const lastMs = Number(last?.tMs);
          if (Number.isFinite(lastMs)) window.__readyForScoringBallMsAtArm = lastMs;
          window.__dbgLine?.('[armed] ceremony satisfied (hoop+pose)');
        }
      } else if (window.__shotTrackingArmed) {
        window.__shotTrackingArmed = false;
        window.__armedAtMs = 0;
        window.__readyForScoringArmedAtMs = 0;
        window.__readyForScoringBallMsAtArm = 0;
        window.__dbgLine?.('[disarm] requirement lost');
      }
    } catch (err) {
      console.warn('[armLoop] error', err);
    }
  }, periodMs);
})();

if (!window.__dbgEvtsBound) {
  window.__dbgEvtsBound = true;
  window.addEventListener('shot:release', (e) => {
    const detail = e?.detail || {};
    window.__dbgLine?.(`[release] via=${detail.via ?? 'unknown'} f=${detail.frame ?? 'n/a'}`);
  });
  window.addEventListener('shot:summary', (e) => {
    const s = e?.detail || {};
    window.__dbgLine?.(`[summary] made=${s.made} arcH=${s.arcHeight} rel=${s.releaseAngle} entry=${s.entryAngle}`);
  });
  window.addEventListener('shot:end', () => {
    window.__dbgLine?.('[shot:end]');
  });
}

const MICROCLIP_BUFFER_DEFAULT_MS = 3800;

window.USE_MICROCLIP ??= false;

window.__SCORING_DELEGATED ??= false;

class MicroClipRingBuffer {
  constructor(opts = {}) {
    this.windowMs = Number(opts.windowMs) > 0 ? Number(opts.windowMs) : Number(window.MICROCLIP_BUFFER_MS || MICROCLIP_BUFFER_DEFAULT_MS);
    this.frames = [];
    this.fps = Number(opts.fps) > 0 ? Number(opts.fps) : (Number(window.__videoFPS) > 0 ? Number(window.__videoFPS) : 30);
    this.maxFrames = Number(opts.maxFrames) > 0 ? Number(opts.maxFrames) : this._calcMaxFrames();
    this._captureInFlight = 0;
    this._warnedCaptureFail = false;
    this._captureDisabled = false;
  }

  _calcMaxFrames() {
    const fps = this.fps || 30;
    const windowMs = this.windowMs || 0;
    return Math.max(45, Math.ceil((windowMs / 1000) * fps) + 15);
  }

  setWindowMs(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return;
    this.windowMs = ms;
    this.maxFrames = this._calcMaxFrames();
    this._trim();
  }

  setFps(fps) {
    if (!Number.isFinite(fps) || fps <= 0) return;
    this.fps = fps;
    this.maxFrames = this._calcMaxFrames();
    this._trim();
  }

  clear() {
    if (!this.frames.length) return;
    const old = this.frames.splice(0, this.frames.length);
    for (const entry of old) {
      try { entry.bitmap?.close?.(); } catch {}
    }
  }

  captureFromCanvas(canvas, frameIdx, mediaTime) {
    if (this._captureDisabled) return;
    if (!window.USE_MICROCLIP) return;
    if (!canvas || canvas.width === 0 || canvas.height === 0) return;
    if (typeof createImageBitmap !== 'function') {
      this._captureDisabled = true;
      if (!this._warnedCaptureFail) {
        console.warn('[microclip] createImageBitmap unavailable; ring buffer disabled');
        this._warnedCaptureFail = true;
      }
      return;
    }
    if (this._captureInFlight >= 2) return;
    this._captureInFlight += 1;
    const finalize = (bitmap) => {
      this._captureInFlight = Math.max(0, this._captureInFlight - 1);
      if (!(bitmap instanceof ImageBitmap)) return;
      this.frames.push({
        bitmap,
        frameIdx,
        mediaTime,
        wallClockMs: performance.now(),
        width: canvas.width,
        height: canvas.height
      });
      this._trim();
    };
    const onError = (err) => {
      this._captureInFlight = Math.max(0, this._captureInFlight - 1);
      if (!this._warnedCaptureFail) {
        console.warn('[microclip] Failed to snapshot frame', err);
        this._warnedCaptureFail = true;
      }
    };
    try {
      const maybe = createImageBitmap(canvas);
      if (maybe && typeof maybe.then === 'function') {
        maybe.then(finalize).catch(onError);
      } else if (maybe instanceof ImageBitmap) {
        finalize(maybe);
      } else {
        onError(new Error('unexpected createImageBitmap result'));
      }
    } catch (err) {
      onError(err);
    }
  }

  _trim() {
    const max = this.maxFrames || this._calcMaxFrames();
    if (this.frames.length <= max) return;
    const remove = this.frames.splice(0, this.frames.length - max);
    for (const entry of remove) {
      try { entry.bitmap?.close?.(); } catch {}
    }
  }

  sliceAroundFrame(frameIdx, opts = {}) {
    if (!Number.isFinite(frameIdx) || !this.frames.length) return null;
    const fps = this.fps || 30;
    const preMs = Number.isFinite(opts.preMs) ? opts.preMs : 700;
    const postMs = Number.isFinite(opts.postMs) ? opts.postMs : 2200;
    const preFrames = Math.max(0, Math.round((preMs / 1000) * fps));
    const postFrames = Math.max(0, Math.round((postMs / 1000) * fps));
    const minFrame = frameIdx - preFrames;
    const maxFrame = frameIdx + postFrames;
    const selected = [];
    for (const entry of this.frames) {
      const fi = Number(entry.frameIdx);
      if (!Number.isFinite(fi)) continue;
      if (fi < minFrame) continue;
      if (fi > maxFrame) break;
      selected.push(entry);
    }
    if (!selected.length) return null;
    let releaseOffset = selected.findIndex((entry) => entry.frameIdx >= frameIdx);
    if (releaseOffset < 0) releaseOffset = selected.length - 1;
    return {
      frames: selected.map((entry) => ({ ...entry })),
      releaseOffset,
      targetFrame: frameIdx,
      fps,
      preMs,
      postMs
    };
  }

  getFrameCount() {
    return this.frames.length;
  }
}

function ensureMicroClipRingBuffer() {
  if (window.__microClipRingBuffer) return window.__microClipRingBuffer;
  const inst = new MicroClipRingBuffer();
  window.__microClipRingBuffer = inst;
  return inst;
}

if (typeof window.getMicroClipRingBuffer !== 'function') {
  window.getMicroClipRingBuffer = function getMicroClipRingBuffer() {
    return ensureMicroClipRingBuffer();
  };
}




const MICROCLIP_PRE_MS_DEFAULT = 700;
const MICROCLIP_POST_MS_DEFAULT = 2200;
const MICROCLIP_DETECT_STRIDE_DEFAULT = 6;

async function cloneFramesForWorker(frames) {
  if (!Array.isArray(frames) || frames.length === 0) return [];
  if (typeof createImageBitmap !== 'function') {
    throw new Error('[microclip] createImageBitmap unavailable for worker cloning');
  }
  const clones = [];
  for (let i = 0; i < frames.length; i++) {
    const entry = frames[i];
    const src = entry?.bitmap;
    if (!(src instanceof ImageBitmap)) continue;
    try {
      const bitmap = await createImageBitmap(src);
      clones.push({
        bitmap,
        frameIdx: Number.isFinite(entry.frameIdx) ? entry.frameIdx : i,
        ts: Number.isFinite(entry.wallClockMs) ? entry.wallClockMs : (Number(entry.ts) || null)
      });
    } catch (err) {
      disposeMicroClipFrameCollection(clones);
      throw err;
    }
  }
  if (!clones.length) throw new Error('[microclip] no frames available to process');
  return clones;
}

function armReleaseFallbackTimer(reason = 'auto') {
  if (window.USE_MICROCLIP === true) return;
  try {
    const dwell = Math.max(900, Number(window.MINI_SCORE_MS || 1800));
    try { window.__SCORING_DELEGATED = false; } catch {}
    disarmRelease('fallback');
    if (window.__releaseFallbackTimer) clearTimeout(window.__releaseFallbackTimer);
    window.__releaseFallbackTimer = setTimeout(() => {
      try {
        if (!window.__lastSummary) {
          const summary = { made: null, arcHeight: null, entryAngle: null, releaseAngle: null, status: reason };
          window.recordShotSummary?.(summary);
          window.dispatchEvent(new CustomEvent('shot:summary', { detail: summary }));
        }
        if (window.ballState) { window.ballState.releaseFrame = null; window.ballState.state = 'IDLE'; }
      } catch {} finally {
        try { window.__releaseFallbackTimer = null; } catch {}
      }
    }, dwell);
  } catch {}
}

function clearArmWhenReadyTimer() {
  if (window.__armWhenReadyTimer) {
    try { clearTimeout(window.__armWhenReadyTimer); } catch {}
    window.__armWhenReadyTimer = null;
  }
}

function disarmRelease(reason = 'pending') {
  clearArmWhenReadyTimer();
  try { window.setReleaseArmed?.(false); } catch {}
  window.__readyForScoring = false;
  window.__POSE_WARMUP_OK = false;
  window.__readyForScoringArmedAtMs = 0;
  window.__readyForScoringBallMsAtArm = 0;
  if (window.DOACH_REL_LOG === true && reason) {
    try { console.log('[disarmRelease]', reason); } catch {}
  }
}

function markPoseWarmStatus(resultOrOk) {
  updatePoseWarmup(resultOrOk);
}

function scheduleArmWhenReady(delay = 320) {
  if (window.__hoopConfirmed !== true) return;
  if (window.__readyForScoring === true) return;
  clearArmWhenReadyTimer();
  window.__armWhenReadyTimer = setTimeout(() => {
    armWhenReady().catch(() => {});
  }, Math.max(0, delay));
}

async function armWhenReady() {
  if (window.__hoopConfirmed !== true) return false;
  if (window.__readyForScoring === true && window.__POSE_WARMUP_OK === true) {
    clearArmWhenReadyTimer();
    return true;
  }

  disarmRelease('arming');

  let pdOk = true;
  if (typeof waitForPDWarm === 'function') {
    try { pdOk = await waitForPDWarm(4, 800); } catch { pdOk = false; }
  }
  if (!pdOk) {
    scheduleArmWhenReady(400);
    return false;
  }

  const needPose = Number(window.POSE_STREAK_NEED ?? 2);
  const timeoutMs = Number(window.POSE_WARMUP_TIMEOUT_MS ?? 1200);
  let streak = 0;
  const start = performance.now();
  while ((performance.now() - start) < timeoutMs && streak < needPose) {
    await new Promise((resolve) => setTimeout(resolve, 36));
    const poseOk = !!(window.playerState?.keypoints?.length >= 33);
    streak = poseOk ? (streak + 1) : 0;
  }
  if (streak < needPose) {
    scheduleArmWhenReady(400);
    return false;
  }
  window.__POSE_WARMUP_OK = true;

  const maxMs = Number(window.REL_MAX_BALL_MS ?? 260);
  const last = window.ballState?.trail?.at?.(-1) || null;
  const nowMs = performance.now();
  const lastMs = Number.isFinite(last?.tMs) ? last.tMs : NaN;
  if (!last || !Number.isFinite(lastMs) || (nowMs - lastMs) > maxMs) {
    scheduleArmWhenReady(400);
    return false;
  }

  const armedAtMs = performance.now();
  window.__readyForScoringBallMsAtArm = lastMs;
  window.__readyForScoringArmedAtMs = armedAtMs;
  window.__readyForScoring = true;
  window.setReleaseArmed?.(true);
  clearArmWhenReadyTimer();
  if (window.DOACH_REL_LOG === true) {
    try { console.log('[armWhenReady] ARMED', { streak, gapMs: Math.round(nowMs - lastMs), armedAtMs: Math.round(armedAtMs), ballMs: Math.round(lastMs) }); } catch {}
  }
  return true;
}

const __verifyHoopCanon = () => {
  try {
    const hb = window.getLockedHoopBox?.();
    if (!hb || !Number.isFinite(hb?.x)) {
      window.__dbgLine?.('[hoop] locked but missing canonical box - recomputing');
    }
    window.getCanonicalHoopBox?.();
  } catch {}
};
try {
  window.addEventListener('hoop:locked', () => {
    disarmRelease('hoop-locked');
    __verifyHoopCanon();
    scheduleArmWhenReady(0);
  });
} catch {}
try {
  window.addEventListener('hoop:confirmed', () => {
    disarmRelease('hoop-confirmed');
    __verifyHoopCanon();
    scheduleArmWhenReady(0);
  });
} catch {}
if (window.__hoopConfirmed === true) scheduleArmWhenReady(0);

function ensureMicroClipWorkerManager() {
  if (window.__microClipWorkerManager) return window.__microClipWorkerManager;

  const manager = {
    worker: null,
    jobs: new Map(),
    ensureWorker() {
      if (this.worker) return this.worker;
      let worker;
      try {
        const url = new URL('./microclip_worker.js', import.meta.url);
        worker = new Worker(url, { type: 'module' });
      } catch (err) {
        console.error('[microclip] failed to start worker', err);
        throw err;
      }
      worker.addEventListener('message', (event) => this.handleMessage(event));
      worker.addEventListener('error', (err) => {
        console.error('[microclip] worker runtime error', err);
      });
      try { worker.postMessage({ type: 'init', id: 'boot' }); } catch {}
      this.worker = worker;
      return this.worker;
    },
    enqueue(jobInput) {
      const id = jobInput.id || `mc:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`;
      const job = {
        id,
        shot: jobInput.shot || null,
        clip: jobInput.clip,
        prox: jobInput.prox ?? null,
        releaseFrame: jobInput.releaseFrame,
        releaseTime: jobInput.releaseTime ?? null,
        fps: jobInput.fps ?? null,
        hoop: jobInput.hoop ?? null,
        detectStride: jobInput.detectStride ?? null,
        status: 'queued'
      };
      const registry = (window.__microClipJobsByFrame ||= new Map());
      if (Number.isFinite(job.releaseFrame) && registry.has(job.releaseFrame)) {
        return registry.get(job.releaseFrame);
      }

      this.jobs.set(id, job);
      this.updateShotState(job, (state) => {
        state.status = 'queued';
        state.releaseFrame = job.releaseFrame;
        state.prox = job.prox ?? null;
        state.queuedAt = performance.now();
      });

      const queuedDetail = { id, shot: job.shot, releaseFrame: job.releaseFrame };
      window.dispatchEvent(new CustomEvent('microclip:queued', { detail: queuedDetail }));
      window.__dbgMicroclip?.('queued', queuedDetail);

      if (Number.isFinite(job.releaseFrame)) {
        registry.set(job.releaseFrame, id);
      }

      const run = async () => {
        let payload = null;
        let transferred = false;
        try {
          payload = await cloneFramesForWorker(job.clip.frames);
          this.ensureWorker();
          this.updateShotState(job, (state) => {
            state.status = 'processing';
            state.framesTotal = payload.length;
          });
          job.status = 'processing';
          const startedDetail = { id, shot: job.shot, framesTotal: payload.length, nFrames: payload.length };
          window.dispatchEvent(new CustomEvent('microclip:started', { detail: startedDetail }));
          window.__dbgMicroclip?.('started', startedDetail);
          try { window.setSessionStatus?.('Scoring...'); } catch {}
          const transfer = payload.map((entry) => entry.bitmap);
          this.worker.postMessage({
            type: 'process',
            id,
            frames: payload,
            fps: job.fps,
            hoop: job.hoop,
            releaseFrame: job.releaseFrame,
            releaseTime: job.releaseTime,
            detectStride: job.detectStride,
            prox: job.prox
          }, transfer);
          transferred = true;
        } catch (err) {
          if (!transferred && payload) disposeMicroClipFrameCollection(payload);
          job.status = 'error';
          this.unregister(job);
          const errorPayload = serializeMicroclipError(err);
          this.updateShotState(job, (state) => {
            state.status = 'error';
            state.error = errorPayload;
          });
          this.jobs.delete(id);
          const errorDetail = { id, shot: job.shot, error: errorPayload };
          window.dispatchEvent(new CustomEvent('microclip:error', { detail: errorDetail }));
          window.__dbgMicroclip?.('error', errorDetail);
          try { window.__SCORING_DELEGATED = false; } catch {}
          disarmRelease('microclip-error');
          scheduleArmWhenReady(400);
          armReleaseFallbackTimer('microclip-error');
        }
      };
      run();
      return id;
    },
    handleMessage(event) {
      const data = event?.data || {};
      const type = data.type;
      const id = data.id;
      if (type === 'init:ok') {
        const readyDetail = { id };
        window.dispatchEvent(new CustomEvent('microclip:ready', { detail: readyDetail }));
        window.__dbgMicroclip?.('ready', readyDetail);
        return;
      }
      const job = id ? this.jobs.get(id) : null;
      if (!job) {
        if (type === 'error') console.warn('[microclip] worker error (no job)', data);
        return;
      }
      switch (type) {
        case 'progress':
          job.status = 'processing';
          job.lastProgress = data;
          this.updateShotState(job, (state) => {
            state.status = 'processing';
            if (Number.isFinite(data.framesProcessed)) state.framesProcessed = data.framesProcessed;
            if (Number.isFinite(data.framesTotal)) state.framesTotal = data.framesTotal;
            if (Number.isFinite(data.trailLength)) state.trailLength = data.trailLength;
            if (Number.isFinite(data.proxEnter)) state.proxEnter = data.proxEnter;
            if (Number.isFinite(data.proxExit)) state.proxExit = data.proxExit;
          });
          const progressDetail = {
            id,
            shot: job.shot,
            frame: data.frameIndex,
            framesProcessed: data.framesProcessed,
            framesTotal: data.framesTotal,
            trailLength: data.trailLength,
            proxEnter: data.proxEnter ?? null,
            proxExit: data.proxExit ?? null,
            progress: { ...data, id }
          };
          window.dispatchEvent(new CustomEvent('microclip:progress', { detail: progressDetail }));
          window.__dbgMicroclip?.('progress', progressDetail);
          break;
        case 'result':
          job.status = 'done';
          job.summary = data.summary || null;
          this.updateShotState(job, (state) => {
            state.status = 'done';
            state.summary = data.summary || null;
          });
          this.unregister(job);
          this.jobs.delete(id);
          const summaryPayload = data.summary || null;
          const summaryDetail = summaryPayload ? {
            made: summaryPayload.made ?? null,
            arcHeight: summaryPayload.arcHeight ?? null,
            entryAngle: summaryPayload.entryAngle ?? null,
            releaseAngle: summaryPayload.releaseAngle ?? null,
            trailLength: Array.isArray(summaryPayload.trailSample) ? summaryPayload.trailSample.length : undefined
          } : {};
          const doneDetail = { id, shot: job.shot, summary: summaryPayload, ...summaryDetail };
          window.dispatchEvent(new CustomEvent('microclip:done', { detail: doneDetail }));
          window.__dbgMicroclip?.('done', doneDetail);
          try { window.__SCORING_DELEGATED = false; } catch {}
          try { window.setSessionStatus?.('SESSION IN PROGRESS...'); } catch {}
          break;
        case 'error':
          job.status = 'error';
          job.error = data.error || null;
          this.updateShotState(job, (state) => {
            state.status = 'error';
            state.error = data.error || null;
          });
          this.unregister(job);
          this.jobs.delete(id);
          const errDetail = { id, shot: job.shot, error: data.error || null };
          window.dispatchEvent(new CustomEvent('microclip:error', { detail: errDetail }));
          window.__dbgMicroclip?.('error', errDetail);
          try { window.__SCORING_DELEGATED = false; } catch {}
          disarmRelease('microclip-error');
          scheduleArmWhenReady(400);
          armReleaseFallbackTimer('microclip-error');
          try { window.setSessionStatus?.('SESSION IN PROGRESS...'); } catch {}
          break;
        case 'cancelled':
          job.status = 'cancelled';
          this.updateShotState(job, (state) => { state.status = 'cancelled'; });
          this.unregister(job);
          this.jobs.delete(id);
          const cancelledDetail = { id, shot: job.shot };
          window.dispatchEvent(new CustomEvent('microclip:cancelled', { detail: cancelledDetail }));
          window.__dbgMicroclip?.('cancelled', cancelledDetail);
          try { window.__SCORING_DELEGATED = false; } catch {}
          disarmRelease('microclip-cancelled');
          scheduleArmWhenReady(400);
          armReleaseFallbackTimer('microclip-cancelled');
          try { window.setSessionStatus?.('SESSION IN PROGRESS...'); } catch {}
          break;
        default:
          console.warn('[microclip] unhandled worker message', data);
      }
    },
    updateShotState(job, mutate) {
      if (!job || typeof mutate !== 'function') return;
      const shot = job.shot;
      if (!shot) return;
      const state = (shot.microclip ||= { id: job.id });
      state.id = job.id;
      mutate(state);
    },
    unregister(job) {
      const registry = window.__microClipJobsByFrame;
      if (!job || !registry) return;
      if (Number.isFinite(job.releaseFrame)) {
        try { registry.delete(job.releaseFrame); } catch {}
      }
    }
  };

  window.__microClipWorkerManager = manager;
  return manager;
}

function scheduleMicroClipForRelease({ frame, via, prox, shot }) {
  if (window.USE_MICROCLIP !== true) return;
  if (!Number.isFinite(frame)) return;
  try {
    const buffer = ensureMicroClipRingBuffer();
    const clip = buffer.sliceAroundFrame(frame, {
      preMs: Number(window.MICROCLIP_PRE_MS || MICROCLIP_PRE_MS_DEFAULT),
      postMs: Number(window.MICROCLIP_POST_MS || MICROCLIP_POST_MS_DEFAULT)
    });
    if (!clip || !Array.isArray(clip.frames) || clip.frames.length === 0) {
      if (shot) {
        shot.microclip = { id: null, status: 'clip-missing', reason: 'insufficient_frames', releaseFrame: frame };
      }
      const skippedDetail = { shot, releaseFrame: frame, reason: 'insufficient_frames' };
      window.dispatchEvent(new CustomEvent('microclip:skipped', { detail: skippedDetail }));
      window.__dbgMicroclip?.('skipped', skippedDetail);
      try { window.__SCORING_DELEGATED = false; } catch {}
      disarmRelease('microclip-skip');
      scheduleArmWhenReady(400);
      armReleaseFallbackTimer('microclip-skip');
      return;
    }
    const manager = ensureMicroClipWorkerManager();
    const hoopLocked = typeof window.getLockedHoopBox === 'function' ? window.getLockedHoopBox() : null;
    let jobHoop = null;
    if (hoopLocked && typeof canonHoop === 'function') {
      try {
        const Hc = canonHoop(hoopLocked);
        jobHoop = { x: Hc.x1, y: Hc.y1, w: Hc.w, h: Hc.h, cx: Hc.cx, cy: Hc.cy, rimTop: Hc.rimTop ?? Hc.y1 };
      } catch {}
    }
    const jobInfo = {
      shot: shot || null,
      clip,
      releaseFrame: frame,
      releaseTime: clip.frames?.[clip.releaseOffset ?? 0]?.wallClockMs ?? performance.now(),
      fps: clip.fps ?? (Number(window.__videoFPS) || null),
      hoop: jobHoop,
      detectStride: Number(window.MICROCLIP_DETECT_STRIDE || MICROCLIP_DETECT_STRIDE_DEFAULT),
      prox: prox || null
    };
    manager.enqueue(jobInfo);
  } catch (err) {
    const payload = serializeMicroclipError(err);
    if (shot) {
      shot.microclip = { id: null, status: 'error', error: payload, releaseFrame: frame };
    }
    const finalErrDetail = { shot, releaseFrame: frame, error: payload };
    window.dispatchEvent(new CustomEvent('microclip:error', { detail: finalErrDetail }));
    window.__dbgMicroclip?.('error', finalErrDetail);
    try { window.__SCORING_DELEGATED = false; } catch {}
    disarmRelease('microclip-error');
    scheduleArmWhenReady(400);
    armReleaseFallbackTimer('microclip-error');
  }
}

window.addEventListener('microclip:done', (event) => {
  try {
    if (window.__releaseFallbackTimer) {
      clearTimeout(window.__releaseFallbackTimer);
      window.__releaseFallbackTimer = null;
    }
  } catch {}
  try { window.__SCORING_DELEGATED = false; } catch {}
  const detail = event?.detail || {};
  const summary = detail.summary || null;
  if (!summary) return;
  const shot = detail.shot || null;
  const merged = { ...summary, source: 'microclip' };
  if (shot) {
    if (merged.frameRelease == null && Number.isFinite(shot.frameRelease)) merged.frameRelease = shot.frameRelease;
    if (merged.frameExit == null && Number.isFinite(shot.proxExitFrame)) merged.frameExit = shot.proxExitFrame;
    if (!merged.shotId && Number.isFinite(shot.__idx)) merged.shotId = shot.__idx;
  }
  try {
    window.recordShotSummary?.(merged);
    window.dispatchEvent(new CustomEvent('shot:summary', { detail: merged }));
    window.__lastSummary = merged;
  } catch (err) {
    console.error('[microclip] failed to record summary', err);
  }
  const summaryDetail = { shot, summary: merged };
  window.dispatchEvent(new CustomEvent('microclip:summary', { detail: summaryDetail }));
  window.__dbgMicroclip?.('summary', summaryDetail);
});


// =========================== Pose Release Pipeline ===========================
// One function to install all release-related wiring exactly once.
// It keeps release authority in release_gate.js, makes HUD purely visual,
// prevents double-fires, and guarantees the guard resets between attempts.

(function installPoseReleasePipeline(){
  if (window.__poseReleasePipelineInstalled) return;
  window.__poseReleasePipelineInstalled = true;

  // ---- 0) Config + defaults -------------------------------------------------
  try { initReleaseConfig?.(); } catch {}
  // Keep HUD visual-only unless you explicitly enable the bridge
  window.HUD_BRIDGE_ENABLE   ??= false;
  window.HUD_LOCAL_PULSE     ??= false;   // no HUD-local shot counting
  window.DISABLE_HUD_FALLBACK??= true;    // no HUD fallback emitter
  window.POSE_FIRST_ONLY     ??= true;    // only pose-gate approved releases pass
  // Tighter UX: shorter cooldown but require wrist-drop reset before next shot
  window.REL_COOLDOWN_MS     ??= 1200;     // lower to reduce missed fast throws
  window.NEXT_SHOT_UNLOCK_MS ??= 1200;     // keep UI cooldown aligned
  // Keep HUD trip equal to gate trip so "green HUD == release ok"
  try {
    const k = (typeof getReleaseKnobs === 'function') ? getReleaseKnobs() : (window.REL_CFG||{});
    if (k?.scoreThresh != null && (k?.hudScoreTrip == null || k.hudScoreTrip !== k.scoreThresh)) {
      setReleaseKnobs?.({ hudScoreTrip: k.scoreThresh });
    }
  } catch {}

  // ---- 1) Single point to ARM/DISARM the gate -------------------------------
  window.setReleaseArmed = function setReleaseArmed(on){
    window.__shotTrackingArmed = !!on;
  };

  // ---- 2) Guarded release marker (used by all producers) --------------------
  if (typeof window.__markReleasePose !== 'function') {
    window.__markReleasePose = function guardedMarkRelease(frame, opts) {
      try {
        const armed = (window.__shotTrackingArmed === true);
        const confirmed = (window.__hoopConfirmed === true);
        const H = window.getLockedHoopBox?.();
        if (!armed || !confirmed || !H) return false;
        const payload = { ...(opts || {}), __fromSafe: true };
        return poseMarkRelease?.(frame, payload);
      } catch { return false; }
    };
  }

  try {
    if (typeof window.markRelease !== 'function') {
      window.markRelease = function poseMarkReleaseWrapper(frame, opts) {
        return poseMarkRelease?.(frame, { ...(opts || {}), __fromSafe: true });
      };
    }
  } catch {}

  // ---- 3) Canonical counter (event-driven)
  // Avoid double-binding if fix_overlay_display already installed the HUD pulse.
  if (!window.__scoreCanonBound && !window.__hudPulseBound) {
    window.__scoreCanonBound = true;
    window.addEventListener('shot:release', () => {
      window.__SCORE_SHOT_COUNT = (window.__SCORE_SHOT_COUNT || 0) + 1;
      window.__SCORE_FLASH_UNTIL = performance.now() + Math.max(400, Number(window.SCORE_FLASH_MS || 1200));
    });
  }

  // ---- 4) Reset guard when an attempt ends + watchdog for stuck sessions ----
  if (!window.__relGuardResetInstalled) {
    window.__relGuardResetInstalled = true;
    const reset = () => {
      window.__releaseEventSent = false; window.__REL_LAST_FIRE_MS = 0;
      disarmRelease('summary-reset');
      scheduleArmWhenReady(320);
    };
    window.addEventListener('shot:summary', reset);
    window.addEventListener('shot:end',     reset);
  }
  if (!window.__relGuardWatchInstalled) {
    window.__relGuardWatchInstalled = true;
    window.REL_GUARD_MAX_MS ??= 7000; // auto-unstick after 7s if no summary/end
    setInterval(() => {
      try {
        const now  = performance.now();
        const last = Number(window.__REL_LAST_FIRE_MS || 0);
        const stuck = (window.__releaseEventSent === true) && last && (now - last > Number(window.REL_GUARD_MAX_MS));
        if (stuck) {
          if (window.DOACH_RELEASE_TRACE) console.warn('[rel-guard:reset]', { since: (now - last)|0 });
          window.__releaseEventSent = false; // keep last-fire timestamp to honor cooldown
        }
      } catch {}
    }, 800);
  }

  // ---- 4b) Wrist-drop reset between attempts -------------------------------
  // Require that the shooting wrist falls below the shoulder at least once after
  // a release before a new release can be emitted. Prevents double-firing while
  // the player keeps the wrist high.
  try {
    if (!window.__resetBelowInstalled) {
      window.__resetBelowInstalled = true;
      window.__RESET_SEEN_BELOW = true; // true at boot so first release allowed
      window.addEventListener('shot:release', () => { try { window.__RESET_SEEN_BELOW = false; } catch {} });
      window.addEventListener('analyzer:frame-done', () => {
        try {
          if (window.__RESET_SEEN_BELOW === true) return;
          const kps = (window.playerState?.keypoints || []);
          const wr = kps[16]; // right wrist
          const sh = kps[12]; // right shoulder
          if (wr && sh && Number.isFinite(wr.y) && Number.isFinite(sh.y)) {
            const margin = Number(window.WRIST_BELOW_MARGIN || 6);
            if (wr.y > (sh.y + margin)) window.__RESET_SEEN_BELOW = true;
          }
        } catch {}
      });
    }
  } catch {}

  // ---- 5) Single safe end Release_shot point emitter  --------------------
  if (typeof window.safeEmitRelease !== 'function') {
    window.safeEmitRelease = function safeEmitRelease(frame, via='unknown', opts={}) {
      try {
        if (opts && opts.bypassGate === true) {
          const detail = { frame, via, tMs: performance.now(), ...opts };
          window.dispatchEvent(new CustomEvent('shot:release', { detail }));
          window.__dbgLine?.('[safeEmitRelease] bypass fired');
          return true;
        }

        // Hard stop at session cap/end
        if (window.__sessionEnded === true || (window.__sessionCapped === true && window.__sessionContinue !== true)) return false;
        try {
          const capSrc = (typeof window.getSessionCap === 'function')
            ? window.getSessionCap()
            : (window.SESSION_SIZE ?? 10);
          const cap   = Number(capSrc);
          const taken = Array.isArray(window.__shotList) ? window.__shotList.length : Number(window.__SCORE_SHOT_COUNT || 0);
          // Block when we've already logged cap attempts; the current (cap-th) release occurs when taken == cap-1
          if (window.__sessionContinue === true) {
            try { window.__sessionCapped = false; } catch {}
            try { window.__capAwait = false; } catch {}
          } else if (Number.isFinite(cap) && taken >= cap) {
            try { window.autoEndSessionAndSummarize?.(); } catch {}
            return false;
          }
        } catch {}

        // Basic preconditions
        const armed = (window.__shotTrackingArmed === true);
        const confirmed = (window.__hoopConfirmed === true);
        const H = window.getLockedHoopBox?.();
        if (!armed || !confirmed || !H) return false;

        // Cooldown + â€œalready firedâ€ guard
        const now = performance.now();
        const minSepMs = Number(window.REL_MIN_SEP_MS ?? 500);
        const sinceMs  = now - (Number(window.__REL_LAST_FIRE_MS) || 0);
        const sameFrame = Number.isFinite(window.__REL_LAST_FRAME) && window.__REL_LAST_FRAME === frame;
        if (sameFrame || sinceMs < minSepMs) return false;
        const cd  = Number(window.REL_COOLDOWN_MS || (window.REL_CFG?.cooldownMs) || 1200);
        if (sinceMs < cd || window.__releaseEventSent) return false;

        // Require wrist-drop reset since the previous release
        if (window.__RESET_SEEN_BELOW === false) return false;

        // Canonical gate approval (pose-first authority lives in release_gate.js)
        const hist = (window.playerState?.frameHistory || []).slice(-5);
        let approved = false, t = {};
        if (typeof window.releaseGate === 'function') {
          const g = window.releaseGate(hist) || { released:false, tests:{} };
          approved = !!g.released; t = g.tests || {};
        }
        if (!approved) return false;

        // Optional: strict HUD parity (0.26 weights all-four) to match your HUD visuals
        try {
          const useUp = (window.REL_SCORE_USE_UPTREND === true);
          const wA=0.26,wB=0.26,wC=0.26,wD=0.26, tot=wA+wB+wC+wD;
          const sc = (t.wristAboveElbow?wA:0)+(t.elbowExtended?wB:0)+(t.alignOK?wC:0)+((useUp?t.wristUpTrend:t.wristAboveShoulder)?wD:0);
          if (!(Number.isFinite(sc) && sc >= (tot - 1e-6))) return false;
        } catch {}

        // Proximity (compute if not provided)
        let prox = opts?.prox || null;
        try {
          if (!prox && typeof window.proxFromHoop === 'function' && typeof window.canonHoop === 'function') {
            prox = window.proxFromHoop(window.canonHoop(H));
          }
        } catch {}

        // Mark + dispatch (canonical)
        const markPayload = { ...opts, prox, via, requirePose: true, __fromSafe: true };
        (window.__markReleasePose || window.markRelease)?.(frame, markPayload);
        window.dispatchEvent(new CustomEvent('pose:release', { detail: { frame, via } }));
        window.__releaseEventSent = true; window.__REL_LAST_FIRE_MS = now; window.__REL_LAST_VIA = via;
        const detail = { frame, via, prox, tMs: now, ...opts };
        window.dispatchEvent(new CustomEvent('shot:release', { detail }));
        window.__REL_LAST_FRAME = frame;

        try { __reportReleaseToServer?.({ frame, via, tMs: Date.now(), prox }); } catch {}

        try { window.__lastSummary = null; } catch {}

        try {
          const list = (window.__shotList ||= []);
          const last = list.at?.(-1) || null;
          const same = last && Number.isFinite(last.frameRelease) && last.frameRelease === frame;
          if (!same) {
            const snap = (typeof window.extractPoseSnapshot === 'function' && window.playerState?.keypoints)
              ? window.extractPoseSnapshot(window.playerState.keypoints, window.getLockedHoopBox?.())
              : null;
            const shotEntry = { pending: true, frameRelease: frame, tMs: Date.now(), poseSnapshot: snap };
            list.push(shotEntry);
            try { window.__SHOT_IDX = list.length - 1; } catch {}
            if (window.USE_MICROCLIP === true) {
              try { if (window.__releaseFallbackTimer) { clearTimeout(window.__releaseFallbackTimer); window.__releaseFallbackTimer = null; } } catch {}
              try { window.__SCORING_DELEGATED = true; } catch {}
              try { scheduleMicroClipForRelease({ frame, via, prox, shot: shotEntry }); } catch (err) { console.warn('[microclip] schedule failed', err); }
            }
          }
        } catch {}

        if (window.USE_MICROCLIP !== true) {
          armReleaseFallbackTimer('fallback');
        }

        return true;
      } catch { return false; }
    };
  }

  if (!window.__hardCapEnd) {
    window.__hardCapEnd = function(reason='cap'){
      try { window.__sessionCapped = true; window.__sessionEnded = true; window.__SESSION_ACTIVE = false; } catch {}
      try { window.stopPoseReleaseSampler?.(); window.stopFrameAnalysis?.(); } catch {}
      try { window.setSessionStatus?.('Session complete'); } catch {}
      try { window.dispatchEvent(new CustomEvent('hud:end-session', { detail: { reason } })); } catch {}
    };
  }

  if (!window.__hardCapListener) {
    window.__hardCapListener = true;
    window.addEventListener('shot:summary', () => {
      try { window.__SESSION_SHOT_COUNT = Number(window.__SESSION_SHOT_COUNT || 0) + 1; } catch {}
      try {
        const capFn = (typeof getSessionCap === 'function') ? getSessionCap : (() => Number(window.__SESSION_CAP ?? window.SESSION_CAP ?? window.SESSION_SIZE ?? 10));
        const cap = Number(capFn());
        if (Number.isFinite(cap) && cap > 0 && Number(window.__SESSION_SHOT_COUNT || 0) >= cap) {
          (window.autoEndSessionAndSummarize || window.__hardCapEnd)?.('summary-cap');
        }
      } catch {}
    });
  }

  // ---- 6) Capture-phase gate: swallow invalid releases globally -------------
  if (!window.__captureGateBound) {
    window.__captureGateBound = true;
    window.addEventListener('shot:release', (e) => {
      let lastTrailPoint = null;
      let lastTrailMs = NaN;
      try {
        const frameId = Number(e?.detail?.frame);
        const nowTs = performance.now();
        if (Number.isFinite(frameId)) {
          const lastFrame = window.__lastReleaseFrame;
          const lastTs = Number(window.__lastReleaseTs || 0);
          if (lastFrame === frameId && (nowTs - lastTs) < 120) {
            e.stopImmediatePropagation();
            return;
          }
          window.__lastReleaseFrame = frameId;
          window.__lastReleaseTs = nowTs;
        }
        else {
          window.__lastReleaseTs = nowTs;
        }
        const detail = e?.detail || {};
        if (detail?.bypassGate === true) {
          window.__dbgLine?.('[gate:bypass] dev');
          return;
        }
        const devAllowStaleTrail = (window.__DEV_ALLOW_STALE_TRAIL__ === true);
        if (window.__shotTrackingArmed !== true) {
          window.__releaseEventSent = false;
          window.__dbgBlock?.('not-armed');
          e.stopImmediatePropagation();
          return;
        }
        if (window.__POSE_WARMUP_OK !== true) {
          window.__releaseEventSent = false;
          window.__dbgBlock?.('pose-not-warm', { streak: Number(window.__POSE_STREAK__ || 0), need: Number(window.POSE_WARMUP_FRAMES || 0) });
          e.stopImmediatePropagation();
          return;
        }
        // Do not allow a release unless ball trail exists and is fresh (use ms, not frame deltas)
        try {
          const bs = window.ballState || {};
          const trail = Array.isArray(bs.trail) ? bs.trail : [];
          const minPtsRaw = Number(window.REL_MIN_BALL_POINTS ?? 3);
          const minTrail = Math.max(minPtsRaw, Number(window.REL_MIN_TRAIL_BEFORE_RELEASE ?? 4));
          if (trail.length < minTrail) {
            window.__releaseEventSent = false;
            window.__dbgBlock?.('min-trail-before-release', { trailLen: trail.length, minTrail });
            e.stopImmediatePropagation(); return;
          }
          lastTrailPoint = trail.at?.(-1) || null;
          const nowMs = performance.now();
          const maxMs = Number(window.REL_MAX_BALL_MS ?? 260);
          const candidateMs = Number(lastTrailPoint?.tMs);
          if (!lastTrailPoint || !Number.isFinite(candidateMs)) {
            window.__releaseEventSent = false;
            window.__dbgBlock?.('ball-sample-missing', { hasPoint: !!lastTrailPoint });
            e.stopImmediatePropagation(); return;
          }
          const armedAt = Number(window.__armedAtMs || 0);
          if (!devAllowStaleTrail && Number.isFinite(armedAt) && armedAt > 0 && candidateMs < armedAt) {
            window.__releaseEventSent = false;
            window.__dbgBlock?.('fresh-trail-missing', { armedAt, lastTrail: candidateMs });
            e.stopImmediatePropagation(); return;
          }
          if ((nowMs - candidateMs) > maxMs && !devAllowStaleTrail) {
            window.__releaseEventSent = false;
            window.__dbgBlock?.('fresh-trail-missing', { armedAt, lastTrail: candidateMs, ageMs: Math.round(nowMs - candidateMs) });
            e.stopImmediatePropagation(); return;
          }
          lastTrailMs = candidateMs;
        } catch {}

        // Require a proximity streak (or segment-cross) before releases can pass
        try {
          const enter = Number(window.ballState?.proxEnterFrame ?? NaN);
          const insideStreak = Number(window.ballState?._proxInsideStreak || 0);
          const needInside = Number(window.PROX_IN_CONSEC_MIN ?? 2);
          const frameIdx = Number.isFinite(frameId) ? frameId : Number(window.__REL_LAST_FRAME ?? NaN);
          if (!Number.isFinite(enter) && insideStreak < needInside) {
            window.__releaseEventSent = false;
            window.__dbgBlock?.('prox-inside', { streak: insideStreak, needInside });
            e.stopImmediatePropagation(); return;
          }
          if (Number.isFinite(enter) && Number.isFinite(frameIdx)) {
            const maxLag = Number(window.REL_PROX_MAX_LAG_FRAMES || 120);
            if ((frameIdx - enter) > maxLag) {
              window.__releaseEventSent = false;
              window.__dbgBlock?.('prox-lag', { frameIdx, enter, maxLag });
              e.stopImmediatePropagation(); return;
            }
          }
        } catch {}

        // Startup anti-ghost: require readiness + pose warmup before any release can pass
        if (window.__readyForScoring !== true) {
          window.__dbgBlock?.('not-ready', { ready: window.__readyForScoring, poseWarm: window.__POSE_WARMUP_OK });
          e.stopImmediatePropagation(); return;
        }
        // Hard-stop guard at session cap/end
        if (window.__sessionEnded === true || (window.__sessionCapped === true && window.__sessionContinue !== true)) {
          window.__dbgBlock?.('session-ended', { ended: window.__sessionEnded, capped: window.__sessionCapped });
          e.stopImmediatePropagation(); return;
        }
        if (window.SESSION_MANAGER_OWNS_ENDING !== true) {
          try {
            const capSrc = (typeof window.getSessionCap === 'function')
              ? window.getSessionCap()
              : (window.SESSION_SIZE ?? 10);
            const cap   = Number(capSrc);
            const taken = Math.max(
              Array.isArray(window.__shotList) ? window.__shotList.length : 0,
              Number(window.__SCORE_SHOT_COUNT || 0)
            );
            if (window.__sessionContinue === true) {
              try { window.__sessionCapped = false; } catch {}
              try { window.__capAwait = false; } catch {}
            } else if (Number.isFinite(cap) && taken >= cap) {
              // Do NOT end immediately; wait for final summary with a grace timer
              try { window.__sessionCapped = true; } catch {}
              try { window.__capAwait = true; } catch {}
              try { if (window.__capTimer) clearTimeout(window.__capTimer); } catch {}
              try {
                window.__capTimer = setTimeout(() => {
                  try { if (window.__capAwait && window.__summaryShown !== true) window.autoEndSessionAndSummarize?.(); } catch {}
                }, Math.max(1200, Number(window.CAP_SUMMARY_GRACE_MS || 1600)));
              } catch {}
              // swallow this event to avoid double counting while we await summary
              window.__dbgBlock?.('session-cap', { cap, taken });
              e.stopImmediatePropagation();
              return;
            }
          } catch {}
        }

        // Ball freshness sanity: use timestamps so cross-clock drift doesn�t kill releases
        try {
          const nowMs = performance.now();
          const lastPt = window.ballState?.trail?.at?.(-1) || null;
          const lastMs = Number(lastPt?.tMs);
          const freshMs = Number(window.REL_MAX_BALL_MS || 360);
          if (!Number.isFinite(lastMs) || (nowMs - lastMs) > freshMs) {
            if (window.DOACH_RELEASE_TRACE === true) console.warn('[REL:warn] prox/ball stale', { gapMs: nowMs - (lastMs || nowMs) });
          }
        } catch {}


        // Cooldown suppression
        const now = performance.now();
        const cd  = Number(window.REL_COOLDOWN_MS || (window.REL_CFG?.cooldownMs) || 1800);
        const last= Number(window.__REL_LAST_FIRE_MS || 0);
        if (last && (now - last) < cd) {
          window.__dbgBlock?.('cooldown', { elapsed: Math.round(now - last), cooldownMs: cd });
          e.stopImmediatePropagation(); return;
        }

        // Require hoop + armed
        const H = window.getLockedHoopBox?.();
        if (!H || window.__hoopConfirmed !== true || window.__shotTrackingArmed !== true) {
          window.__releaseEventSent = false;
          window.__dbgBlock?.('not-armed', { hoop: window.__hoopConfirmed, armed: window.__shotTrackingArmed });
          e.stopImmediatePropagation(); return;
        }

        // Pose-first: only keep releases approved by releaseGate (and 0.26 all-four)
        if (window.POSE_FIRST_ONLY === true) {
          const hist = (window.playerState?.frameHistory || []).slice(-5);
          let ok = false, t = {};
          if (typeof window.releaseGate === 'function') {
            const g = window.releaseGate(hist) || { released:false, tests:{} };
            ok = !!g.released; t = g.tests || {};
          }
          if (!ok) {
            window.__releaseEventSent = false;
            window.__poseGateStreak = 0;
            window.__dbgBlock?.('pose-gate', { via: 'releaseGate', tests: t });
            e.stopImmediatePropagation(); return;
          }
          try {
            const useUp = (window.REL_SCORE_USE_UPTREND === true);
            const wA=0.26,wB=0.26,wC=0.26,wD=0.26, tot=wA+wB+wC+wD;
            const sc = (t.wristAboveElbow?wA:0)+(t.elbowExtended?wB:0)+(t.alignOK?wC:0)+((useUp?t.wristUpTrend:t.wristAboveShoulder)?wD:0);
            const all4 = (Number.isFinite(sc) && sc >= (tot - 1e-6));
            const need = Number.isFinite(window.POSE_STREAK_NEED) ? Number(window.POSE_STREAK_NEED) : 2;
            if (all4) { window.__poseGateStreak = (Number(window.__poseGateStreak)||0) + 1; }
            else {
              window.__poseGateStreak = 0;
              window.__releaseEventSent = false;
              window.__dbgBlock?.('pose-tests', { all4, tests: t });
              e.stopImmediatePropagation(); return;
            }
            if (window.__poseGateStreak < need) {
              window.__dbgBlock?.('pose-streak', { streak: window.__poseGateStreak, need });
              e.stopImmediatePropagation(); return;
            }
          } catch {}
        }
      } catch {}
    }, true); // capture
  }

    if (!window.__dbgEvtsBound) {
    window.__dbgEvtsBound = true;
    window.addEventListener('shot:release', (e) => {
      const d = e?.detail || {};
      const via = d.via || 'unknown';
      const frameIdx = Number(d.frame ?? 0) || 0;
      window.__dbgLine?.(`[release] via=${via} f=${frameIdx}`);
    });
    window.addEventListener('shot:summary', (e) => {
      const s = e?.detail || {};
      window.__dbgLine?.(`[summary] made=${s.made} arcH=${s.arcHeight} rel=${s.releaseAngle} entry=${s.entryAngle}`);
    });
    window.addEventListener('shot:end', () => { window.__dbgLine?.('[shot:end]'); });
  }

  // ---- 7) Post-phase handlers (report, mini-score, re-arm, cleanup) ---------
  if (!window.__postHandlersBound) {
    window.__postHandlersBound = true;

    window.addEventListener('shot:release', (e) => {
      // Ensure session shot list and HUD reflect this release immediately
      try {
        const list = (window.__shotList ||= []);
        const rf = Number(e?.detail?.frame || 0);
        const lastEntry = list.at?.(-1) || null;
        const same = lastEntry && Number.isFinite(lastEntry.frameRelease) && lastEntry.frameRelease === rf;
        if (!same) {
          const snap = (typeof window.extractPoseSnapshot === 'function' && window.playerState?.keypoints)
            ? window.extractPoseSnapshot(window.playerState.keypoints, window.getLockedHoopBox?.())
            : null;
          list.push({ pending: true, frameRelease: rf, tMs: Date.now(), poseSnapshot: snap });
          try { window.__SHOT_IDX = (list.length - 1); } catch {}
        }
        const taken = list.length;
        const made = (window.shotLog?.filter?.(s => s.made).length || 0);
        const acc  = taken ? Math.round((made / taken) * 100) : 0;
        window.mountSessionHUD?.();
        window.updateSessionHUD?.({ taken, made, accuracy: acc, elapsedSec: Math.floor((Date.now() - (window.__sessionStart||Date.now()))/1000) });
        window.setSessionStatus?.('Shot ' + taken + ' in progress');
      } catch {}

      // Track last via + optional reporting
      try { window.__REL_LAST_VIA = String(e?.detail?.via || ''); } catch {}
      // Keep mini-scoring alive during RELEASE_ONLY probes
      try { if (window.__RELEASE_ONLY === true) window.__TEMP_SCORE_UNTIL = performance.now() + (Number(window.MINI_SCORE_MS || 1800)); } catch {}
    });

    window.addEventListener('shot:summary', (e) => {
      disarmRelease('summary');
      scheduleArmWhenReady(320);
      try { __reportSummaryToServer?.(e?.detail || {}); } catch {}
      try { if (window.ballState) { window.ballState.releaseFrame = null; window.ballState.state = 'IDLE'; } } catch {}
      try { window.__TEMP_SCORE_UNTIL = 0; } catch {}
      try { window.__releaseEventSent = false; window.__gateStreak = 0; } catch {}
      try { if (window.__releaseFallbackTimer) { clearTimeout(window.__releaseFallbackTimer); window.__releaseFallbackTimer = null; } } catch {}
    });

    window.addEventListener('shot:end', () => {
      try { if (window.__coachPoseInterval) { clearInterval(window.__coachPoseInterval); delete window.__coachPoseInterval; } } catch {}
      try { if (window.__coachPaintRaf != null) { cancelAnimationFrame(window.__coachPaintRaf); window.__coachPaintRaf = null; } } catch {}
      try { if (window.ballState) delete window.ballState.__poseLatchAt; } catch {}
      try { if (window.__BG_STOP) window.__BG_STOP(); } catch {}
    });

    // Keep a unified analyzer frame index for debug/tools
    window.addEventListener('analyzer:frame-done', (e) => {
      try { const k = Number(e?.detail?.__frameIdx); if (Number.isFinite(k)) window.__AN_IDX = k; } catch {}
    });
  }

  // ---- 8) Optional debug logger (toggle with window.DOACH_REL_LOG=true) -----
  if (!window.__relLoggerInstalled) {
    window.__relLoggerInstalled = true;
    function poseTests() {
      try {
        const hist = (window.playerState?.frameHistory || []).slice(-5);
        if (typeof window.releaseGate === 'function') {
          const g = window.releaseGate(hist) || { tests: {} };
          const th = Number((window.REL_CFG?.scoreThresh) ?? window.REL_SCORE_THRESH ?? 1.0);
          return { all4: (Number(g.tests?.score||0) >= th - 1e-6), score: g.tests?.score ?? null, th, tests: g.tests||{} };
        }
      } catch {}
      return { all4:false, score:null, th:null, tests:{} };
    }
    function logRelease(ev){
      if (window.DOACH_REL_LOG !== true) return;
      try {
        const d = ev?.detail || {};
        const now = performance.now();
        const since = now - (Number(window.__REL_EVT_LAST_MS || 0));
        window.__REL_EVT_LAST_MS = now;
        const pt = poseTests();
        console.log('[REL:event]', {
          via: d.via || 'unknown', frame: Number(d.frame||0),
          all4: pt.all4, score: pt.score, th: pt.th, tests: pt.tests,
          sinceMs: Math.round(Number.isFinite(since) ? since : 0),
          eventSent: !!window.__releaseEventSent,
          state: (window.ballState||{}).state,
          shotsTaken: (window.__shotList||[]).length,
        });
      } catch {}
    }
    window.addEventListener('shot:release', logRelease);
    window.addEventListener('shot:summary', (e)=>{ if (window.DOACH_REL_LOG) console.log('[REL:summary]', e?.detail||null); });
    window.addEventListener('shot:end',     (e)=>{ if (window.DOACH_REL_LOG) console.log('[REL:end]', e?.detail||null); });
  }
})(); 

// ---- Pre-Decoder / Pre-Detector (PD) pipeline ----
// Decodes frames on a hidden <video> slightly ahead of UI playback, runs detection,
// and buffers results for the analyzer to consume.
function installPreDetectorFor(srcVideo) {
  try {
    if (!srcVideo) return;
    if (window.__preVid && window.__preVid.__boundFor === srcVideo) return;

    const fps = Number(window.__videoFPS) > 0 ? Number(window.__videoFPS) : 30;
    const leadFrames = Number(window.__PD_LEAD_FRAMES || 6);
    const PD = (window.__PREDET ||= { map: new Map(), fps, size: 128, lead: leadFrames, ready: 0 });
    PD.fps = fps; PD.lead = leadFrames;

    // Create hidden video and offscreen canvas
    const preVid = document.createElement('video');
    preVid.muted = true; preVid.playsInline = true; preVid.preload = 'auto';
    preVid.style.position = 'fixed'; preVid.style.left = '-9999px'; preVid.style.top = '-9999px';
    try { document.body.appendChild(preVid); } catch {}
    preVid.src = srcVideo.currentSrc || srcVideo.src || '';
    window.__preVid = preVid; preVid.__boundFor = srcVideo;

    const off = document.createElement('canvas');
    const octx = off.getContext('2d', { willReadFrequently: true });
    const ensureSize = () => {
      const vw = srcVideo.videoWidth || 1280, vh = srcVideo.videoHeight || 720;
      if (off.width !== vw || off.height !== vh) { off.width = vw; off.height = vh; }
    };

    // Simple RVFC pump for preVid
    let rv = null; let lastIdx = -1;
    const tick = async (now, meta) => {
      try {
        const t = meta?.mediaTime ?? preVid.currentTime;
        const idx = Math.max(0, Math.round(t * fps));
        if (idx === lastIdx) { rv = preVid.requestVideoFrameCallback(tick); return; }
        lastIdx = idx; ensureSize(); octx.drawImage(preVid, 0, 0, off.width, off.height);
        try {
          const det = await sendFrameToDetect(off, idx);
          // buffer into ring map
          PD.map.set(idx, { objects: det?.objects || [], idx });
          // trim old
          if (PD.map.size > PD.size) {
            const keys = Array.from(PD.map.keys()).sort((a,b)=> a-b);
            const drop = PD.map.size - PD.size; for (let i=0;i<drop;i++) PD.map.delete(keys[i]);
          }
          PD.ready = PD.map.size;
        } catch {}
      } finally {
        try { rv = preVid.requestVideoFrameCallback(tick); } catch {}
      }
    };
    preVid.addEventListener('loadeddata', async () => {
      try { await preVid.play(); } catch {}
      try { rv = preVid.requestVideoFrameCallback(tick); } catch {}
    }, { once: true });
    try { preVid.load(); } catch {}
  } catch (e) { console.warn('[PD] init failed', e); }
}

async function waitForPDWarm(minLead = 4, timeoutMs = 500) {
  const t0 = performance.now();
  while (performance.now() - t0 < timeoutMs) {
    try { if ((window.__PREDET?.ready || 0) >= minLead) return true; } catch {}
    await new Promise(r => setTimeout(r, 30));
  }
  return false;
}


// --- scorer tuning knobs (optional) ---
window.PROX_OUT_CONSEC_MIN = 2;    // frames outside required before EXIT latch
window.PROX_EXIT_PAD        = 4;   // extra px below bottom to confirm EXIT


// ---- Pure pose-gate helper for release latch (pose-only) ----
// Accepts the last N frames of keypoints (3â€“5), returns tests and immediate decision.
// Caller can apply a multi-tick streak if desired.
function release_gate(lastFrames) {
  try { return releaseGate(lastFrames); } catch (e) { return { released:false, passed:0, tests:{}, reason:'error' }; }
}


// Attach the hoop to the ball state for tracking zone
export function attachHoop(hoopLocked) {
  if (!hoopLocked) return;

  // Pull size, allow 0 â†’ fallback to previous or a sensible default
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

const H = getLockedHoopBox?.();
 if (H) {
   const Hc = canonHoop(H);
   attachHoop?.({...asTopLeft(Hc), anchor:'topleft'});  // tracker wants TL
}

export const frameArchive = [];

window.madeShotSound = new Audio('/static/assets/swish.mp3');
window.missedShotSound = new Audio('/static/assets/miss_bounce.mp3');
window.lastDetectedFrame = { __frameIdx: 0, objects: [], poses: [] };

let isTracking = false;
let __stopAnalyze = null;

window.stopFrameAnalysis = () => { try { __stopAnalyze?.(); } finally { __stopAnalyze = null; } };
window.__analyzerActive = false;

// Pointer-events helper (off by default)
let _overlayEl = null;
export function setOverlayInteractive(on) {
  _overlayEl = _overlayEl || document.getElementById('overlay');
  if (!_overlayEl) return;
  _overlayEl.style.pointerEvents = on ? 'auto' : 'none';
}

// --- Non-blocking detection queue (latest-wins) ---
let __detBusy = false;
let __detLatest = null;
let __lastDetObjects = []; // consumed by analyzer loop

async function kickDetect(frameCanvas, frameIdx) {
  // store the most recent frame; drop older ones
  __detLatest = { canvas: frameCanvas, idx: frameIdx };
  if (__detBusy) return;

  __detBusy = true;
  try {
    while (__detLatest) {
      const job = __detLatest;
      __detLatest = null;
      try {
        const det = await sendFrameToDetect(job.canvas, job.idx);
        __lastDetObjects = det?.objects || [];
      } catch (e) {
        console.warn('[detect] frame inference failed:', e);
      }
    }
  } finally {
    __detBusy = false;
  }
}

//--------------------------------------------------------------//
//           ------  Initialize overlay elements  -----         //
//--------------------------------------------------------------//

// ---- Camera control (robust for iOS/Android/Desktop) ----
// Choose and remember a preferred camera (deviceId). Tries:
// 1) saved id in localStorage
// 2) label match for EMEET SmartCam S600 (328F:00ad)
// 3) first external / non-virtual camera
async function pickPreferredCameraId() {
  try {
    const key = 'doach_camera_id';
    const saved = localStorage.getItem(key);
    if (saved) return saved;

    // Respect a preferred facing hint if provided and no saved deviceId
    let preferFacing = null;
    try {
      preferFacing = localStorage.getItem('doach_camera_facing') || window.__preferFacing || window.DOACH_CAM_FACING || null;
      // Default to back camera on mobile on first run
      if (!preferFacing) {
        const ua = (navigator.userAgent || '').toLowerCase();
        const isMobile = /android|iphone|ipad|ipod|mobile/.test(ua);
        if (isMobile) { preferFacing = 'environment'; localStorage.setItem('doach_camera_facing', 'environment'); }
      }
    } catch {} if (preferFacing) return null;

    // Ensure labels are populated â€” requires one permissive getUserMedia call
    try {
      const ua = (navigator.userAgent || '').toLowerCase();
      const isMobile = /android|iphone|ipad|ipod|mobile/.test(ua);
      if (!isMobile) {
        const tmp = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        try { tmp.getTracks().forEach(t => t.stop()); } catch {}
      }
    } catch {}

    const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
    if (!devices.length) return null;

    const byLabel = (s) => devices.find(d => (d.label || '').toLowerCase().includes(s));
    const emeet = byLabel('emeet smartcam s600') || byLabel('328f:00ad') || byLabel('emeet');
    const nonVirtual = devices.find(d => !/virtual|obs|snap|manycam|camlink/i.test(d.label || ''));
    // If a facing is preferred, try to pick a device with that hint in the label
    let byFacing = null;
    try {
      if (preferFacing) {
        const want = String(preferFacing).toLowerCase();
        if (want === 'user' || want === 'front') byFacing = byLabel('front') || byLabel('user');
        if (want === 'environment' || want === 'back' || want === 'rear') byFacing = byLabel('back') || byLabel('environment');
      }
    } catch {}
    const chosen = emeet || nonVirtual || devices[0];
    if (chosen?.deviceId) localStorage.setItem(key, chosen.deviceId);
    return chosen?.deviceId || null;
  } catch { return null; }
}

export async function startCamera() {
  const v = document.getElementById('videoPlayer');
  const o = document.getElementById('overlay');
  if (!v || !o) return false;

  try { stopFrameAnalysis?.(); } catch {}
  try { stopPreDetection?.(); } catch {}
  stopCamera();

  v.setAttribute('playsinline', '');
  v.autoplay = true;
  v.muted = true;

  // Build constraints with preferred deviceId when available
  const preferredId = await pickPreferredCameraId();
  const baseVid = { width: { ideal:1280, max:1920 }, height:{ ideal:720, max:1080 }, frameRate:{ ideal:30, max:30 } };
  let videoConst;
  let preferFacing = null;
  if (preferredId) {
    videoConst = { deviceId: { exact: preferredId }, ...baseVid };
  } else {
    preferFacing = null;
    try {
      preferFacing = localStorage.getItem('doach_camera_facing') || window.__preferFacing || window.DOACH_CAM_FACING || null;
      // Default to back camera on mobile when nothing chosen yet
      if (!preferFacing) {
        const ua = (navigator.userAgent || '').toLowerCase();
        const isMobile = /android|iphone|ipad|ipod|mobile/.test(ua);
        if (isMobile) { preferFacing = 'environment'; localStorage.setItem('doach_camera_facing', 'environment'); }
      }
    } catch {}
    if (preferFacing) {
      videoConst = { facingMode: { exact: String(preferFacing) }, ...baseVid };
    } else {
      videoConst = { facingMode: { ideal: 'environment' }, ...baseVid };
    }
  }
  let constraints = { audio: false, video: videoConst };

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    // Fallbacks: drop resolution, or try without deviceId
    console.warn('[camera] gUM failed (preferred):', err?.name, err?.message);
    try {
      let vc;
      if (preferredId && preferFacing) {
        // Switch to facingMode exact as a fallback if deviceId failed
        vc = { facingMode: { exact: String(preferFacing) }, ...baseVid };
        constraints = { audio: false, video: vc };
        stream = await navigator.mediaDevices.getUserMedia(constraints);
      } else if (preferredId) {
        // Remove exact device; allow browser to choose with ideal environment
        vc = { facingMode: { ideal: 'environment' }, ...baseVid };
        constraints = { audio: false, video: vc };
        stream = await navigator.mediaDevices.getUserMedia(constraints);
      } else {
        // Already using facingMode â€” relax to ideal or flip to user if environment fails
        const want = String(preferFacing || 'environment').toLowerCase();
        const alt = want === 'environment' ? 'user' : 'environment';
        try {
          vc = { facingMode: { ideal: want }, ...baseVid };
          constraints = { audio: false, video: vc };
          stream = await navigator.mediaDevices.getUserMedia(constraints);
        } catch (eAlt1) {
          vc = { facingMode: { ideal: alt }, ...baseVid };
          constraints = { audio: false, video: vc };
          stream = await navigator.mediaDevices.getUserMedia(constraints);
        }
      }
    } catch (e2) {
      console.warn('[camera] gUM failed (fallback):', e2?.name, e2?.message);
      const msg = (err?.name === 'NotAllowedError' || e2?.name === 'NotAllowedError')
        ? 'Camera permission blocked â€” enable camera for this site in your browser settings and reload.'
        : 'No camera found or in use by another app. Check OS permissions and try again.';
      window.showPrompt?.(msg);
      return false;
    }
  }

  // Ensure PoseLandmarker is ready (loads once)
  try { if (!window.poseDetector) await initPoseDetector?.(); } catch {}

  // Persist the actual deviceId used
  try {
    const track = stream.getVideoTracks?.()[0];
    const id = track?.getSettings?.().deviceId || null;
    if (id) localStorage.setItem('doach_camera_id', String(id));
  } catch {}

  v.srcObject = stream;

  await new Promise(res => {
    if (v.readyState >= 1 && v.videoWidth) res();
    else v.addEventListener('loadedmetadata', res, { once: true });
  });
  

  try { await v.play(); } catch (e) {
    console.warn('[camera] video.play() blocked â€” call from a user gesture.');
    // Even if autoplay is blocked, stream is live â€” clear prompt so user can tap play
    window.hidePrompt?.();
    return false;
  }
  try { window.hidePrompt?.(); } catch {}
  // Reset counters/guards at the start of a live session as well
  try { window.resetReleaseSessionCounters?.(); } catch {}

  // âœ… Arm overlay for picking BEFORE any sync so pointer-events stay 'auto'

  try { startPreDetection?.(v); } catch {}
  try { initPoseDetector?.(); } catch {}

  window.__pickingHoop = true;
  o.style.pointerEvents = 'auto';
  o.style.touchAction   = 'none';     // iOS needs this
  o.style.zIndex        = '1000';     // ensure above video during pick
  v.style.pointerEvents = 'none';

  try { syncOverlayToVideo?.(); } catch {}

  try {
   const ov = document.getElementById('overlay');
   if (ov && !window.__overlayInited) {
     initOverlay?.(ov);
      window.__overlayInited = true;
    }
    if (!window.__controlsInited) {
      createPlaybackControls?.(v);
      window.__controlsInited = true;
    }
  } catch (e) { console.warn('[camera] overlay/controls init failed:', e); }

  window.addEventListener('orientationchange', () => setTimeout(() => syncOverlayToVideo?.(), 120), { passive:true });
  if (!v.__ro) {
    v.__ro = new ResizeObserver(() => syncOverlayToVideo?.());
    v.__ro.observe(v.parentElement || v);
  }

  console.log('[camera] ready', { vw:v.videoWidth, vh:v.videoHeight });
  return true;
}

export function stopCamera() {
  const v = document.getElementById('videoPlayer');
  if (v?.srcObject) {
    v.srcObject.getTracks().forEach(t => t.stop());
    v.srcObject = null;
  }
}

// Expose selected helpers to window for tests/automation
try {
  if (typeof window.startCamera !== 'function') window.startCamera = startCamera;
  // Utility helpers to manage camera selection at runtime
  if (typeof window.listCameras !== 'function') {
    window.listCameras = async function listCameras(){
      try {
        const devs = await navigator.mediaDevices.enumerateDevices();
        const cams = devs.filter(d => d.kind === 'videoinput');
        console.table(cams.map(d => ({ label: d.label || '(no label)', deviceId: d.deviceId })));
        return cams;
      } catch (e) { console.warn('listCameras failed', e); return []; }
    };
  }
  if (typeof window.setPreferredCamera !== 'function') {
    window.setPreferredCamera = async function setPreferredCamera(deviceId){
      try { localStorage.setItem('doach_camera_id', String(deviceId || '')); } catch {}
      try { stopCamera(); await startCamera(); } catch {}
      try {
        const facing = localStorage.getItem('doach_camera_facing') || null;
        window.dispatchEvent(new CustomEvent('camera:facing-changed', { detail: { facing } }));
      } catch {}
    };
  }
  if (typeof window.setPreferredFacing !== 'function') {
    window.setPreferredFacing = async function setPreferredFacing(facing){
      try { localStorage.setItem('doach_camera_facing', String(facing || 'environment')); } catch {}
      try { localStorage.removeItem('doach_camera_id'); } catch {}
      try { stopCamera(); await startCamera(); } catch {}
      try { window.dispatchEvent(new CustomEvent('camera:facing-changed', { detail: { facing } })); } catch {}
    };
  }
  if (typeof window.flipCamera !== 'function') {
    window.flipCamera = async function flipCamera(){
      try {
        const cur = localStorage.getItem('doach_camera_facing') || 'environment';
        const next = (String(cur).toLowerCase() === 'user') ? 'environment' : 'user';
        localStorage.setItem('doach_camera_facing', next);
        localStorage.removeItem('doach_camera_id');
        stopCamera(); await startCamera();
        try { window.dispatchEvent(new CustomEvent('camera:facing-changed', { detail: { facing: next } })); } catch {}
      } catch (e) { console.warn('flipCamera failed', e); }
    };
  }
} catch {}

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
  if (promptEl) { promptEl.style.display = 'block'; promptEl.textContent = 'ðŸ“ Tap the hoop to lock it'; }

  // Refresh rect/mapping now that picking is armed
  syncOverlayToVideo?.();

  const finish = () => {
    window.__hoopConfirmed = true;
    window.__pickingHoop   = false;
    ov.style.cursor        = 'default';
    ov.style.pointerEvents = 'none';
    vid.style.pointerEvents = '';
    if (promptEl) promptEl.style.display = 'none';

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

    // NEW: while on coach plane (live), actively sample pose at ~8â€“10 fps
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
              // HUD-only evaluator (0.26 all-four). Expose tests and attempt canonical release via safe helper
              try {
                const useUp = (window.REL_SCORE_USE_UPTREND === true);
                const kps = window.playerState.keypoints;
                const side = (window.__LAST_GATE?.detail?.tests?.side === 'L') ? 'L' : 'R';
                const S = (side === 'L') ? 11 : 12; const E = (side === 'L') ? 13 : 14; const W = (side === 'L') ? 15 : 16;
                const sh=kps[S], el=kps[E], wr=kps[W];
                const c = window.REL_CFG || {}; const yTol=Number(c.yTol ?? window.REL_Y_TOL ?? 12); const ySh=Number(c.shYTol ?? window.REL_SH_Y_TOL ?? 8);
                const wristAboveElbow=(wr&&el)?(wr.y < (el.y - yTol)):false; const wristAboveShoulder=(wr&&sh)?(wr.y < (sh.y - ySh)):false;
                let elbowAngleDeg=0, elbowExtended=false; try { const v1x=sh.x-el.x,v1y=sh.y-el.y,v2x=wr.x-el.x,v2y=wr.y-el.y; const dot=(v1x*v2x+v1y*v2y); const den=(Math.hypot(v1x,v1y)*Math.hypot(v2x,v2y)+1e-6); const a=Math.acos(Math.max(-1,Math.min(1,dot/den)))*180/Math.PI; elbowAngleDeg=a; const th=Number(c.elbowExtMin ?? window.REL_ELBOW_EXT_MIN ?? 155); elbowExtended=(a>=th);} catch {}
                const dx=Math.abs((wr?.x??0)-(sh?.x??0)); const dy=Math.abs((sh?.y??0)-(wr?.y??0)); const nearlyVertical=(dx<Number(c.dxMax ?? window.REL_DX_MAX ?? 90))&&(dy>Number(c.dyMin ?? window.REL_DY_MIN ?? 18)); const dSE=Math.hypot((el?.x??0)-(sh?.x??0),(el?.y??0)-(sh?.y??0)); const dSW=Math.hypot((wr?.x??0)-(sh?.x??0),(wr?.y??0)-(sh?.y??0)); const armExtended=dSW>(dSE+Number(c.extMargin ?? window.REL_EXT_MARGIN ?? 10)); const alignOK=nearlyVertical||armExtended;
                let wristUpTrend=false; try { const h=(window.playerState.frameHistory||[]).slice(-3); if(h.length>=2){const wy1=h[h.length-2]?.keypoints?.[W]?.y; const wy2=h[h.length-1]?.keypoints?.[W]?.y; if(Number.isFinite(wy1)&&Number.isFinite(wy2)) wristUpTrend=(wy2<(wy1-Number(c.upDy ?? window.REL_UP_DY ?? 6))); if(!wristUpTrend && h.length>=3){ const wy0=h[h.length-3]?.keypoints?.[W]?.y; if(Number.isFinite(wy0)&&Number.isFinite(wy1)){ const d=Number(c.upDy ?? window.REL_UP_DY ?? 6); wristUpTrend=(wy2<(wy1-d))&&(wy1<(wy0-d)); } } } } catch {}
                const norm=(x,d)=>{ const n=Number(x); return (Number.isFinite(n)&&n>=0)?n:d; }; const cfgW=(window.REL_CFG&&window.REL_CFG.weights)||{}; const wA=norm((cfgW.wrist ?? window.REL_W_WRIST ?? window.REL_W_A),0.26); const wB=norm((cfgW.elbow ?? window.REL_W_ELBOW ?? window.REL_W_B),0.26); const wC=norm((cfgW.align ?? window.REL_W_ALIGN ?? window.REL_W_C),0.26); const wDsrc=useUp?(cfgW.uptrend ?? window.REL_W_UPTREND ?? window.REL_W_D):(cfgW.shoulder ?? window.REL_W_SHOULDER ?? window.REL_W_D); const wD=norm(wDsrc,0.26);
                const score=(wristAboveElbow?wA:0)+(elbowExtended?wB:0)+(alignOK?wC:0)+((useUp?wristUpTrend:wristAboveShoulder)?wD:0); const tot=wA+wB+wC+wD; const allFour=(Number.isFinite(score)&&score>=(tot-1e-6));
                const rec = { t: Date.now(), type:'gate', detail: { frame: fidx, tests: { side, wristAboveElbow, wristAboveShoulder, elbowExtended, alignOK, wristUpTrend, elbowAngleDeg:Math.round(elbowAngleDeg), dx:Math.round(dx), dy:Math.round(dy), dSW:Math.round(dSW), dSE:Math.round(dSE), score:Number(score.toFixed?.(3)||score), tot:Number(tot.toFixed?.(3)||tot) }, passed: ['wristAboveShoulder','elbowExtended','alignOK'].map(k=>({wristAboveShoulder,elbowExtended,alignOK}[k])).filter(Boolean).length, reason: allFour ? 'all-four' : 'not-enough' }, latched: allFour };
                (window.__REL_LOG ||= []).push(rec); window.__LAST_GATE = rec;
              } catch {}

              // Attempt canonical release via safe helper; helper enforces cooldown/guards
              try {
                const prox = (typeof window.proxFromHoop === 'function' && typeof window.canonHoop === 'function')
                              ? window.proxFromHoop(window.canonHoop(H)) : null;
                window.safeEmitRelease?.(fidx, 'pose-heuristic', { prox });
              } catch {}
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
      window.__overlayMode = 'live';
      window.__overlayCleanDrawn = false;

      // Ensure analyzer, PD, and painter all run together
      try { runAnalyzer?.(vid, ov); } catch {}
      window.__analyzerActive = true;

      try { installPreDetectorFor?.(vid); } catch {}
      try { startPreDetection?.(vid); } catch {}

      try { cancelAnimationFrame(window.__coachPaintRaf); } catch {}
      const paint = () => {
        const last = window.lastDetectedFrame || {};
        try { drawLiveOverlay?.(last.objects || [], window.playerState); } catch {}
        window.__coachPaintRaf = requestAnimationFrame(paint);
      };
      window.__coachPaintRaf = requestAnimationFrame(paint);
    } else {
      // ðŸŽžï¸ UPLOAD: run the full analyzer
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

      // 1) Use your proven locker (same as uploads): sets the real â€œlocked hoopâ€
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

// -----------------------------------------------------------------------//
// ---- Pose believability gate (size + ROI + overlap + persistence) ---- //
// -----------------------------------------------------------------------//
function __poseBox(ls) {
  const xs = ls.map(k=>k.x), ys = ls.map(k=>k.y);
  const x1 = Math.min(...xs), y1 = Math.min(...ys);
  const x2 = Math.max(...xs), y2 = Math.max(...ys);
  return { x:x1, y:y1, w: x2-x1, h: y2-y1 };
}
function __iou(a,b){
  const ax2=a.x+a.w, ay2=a.y+a.h, bx2=b.x+b.w, by2=b.y+b.h;
  const x1=Math.max(a.x,b.x), y1=Math.max(a.y,b.y);
  const x2=Math.min(ax2,bx2), y2=Math.min(ay2,by2);
  const iw=Math.max(0,x2-x1), ih=Math.max(0,y2-y1);
  const inter=iw*ih, uni=a.w*a.h + b.w*b.h - inter;
  return uni>0 ? inter/uni : 0;
}
function __anklesY(ls) { // MediaPipe: 27=R ankle, 28=L ankle; fall back to hips if missing
  const ra = ls[27], la = ls[28], rh=ls[24], lh=ls[23];
  const ys = [ra?.y, la?.y].filter(Number.isFinite);
  if (ys.length) return ys.reduce((a,b)=>a+b,0)/ys.length;
  const ys2 = [rh?.y, lh?.y].filter(Number.isFinite);
  return ys2.length ? ys2.reduce((a,b)=>a+b,0)/ys2.length : NaN;
}
function __rimTopY() { // use locked hoop box
  try {
    const H = window.getLockedHoopBox?.();
    if (!H) return NaN;
    const h = H.h || H.height || 0;
    // H may be center-anchored; normalize
    const cy = Number.isFinite(H.cy) ? H.cy : (H.anchor==='topleft' ? (H.y + h/2) : H.y);
    return cy - h/2;
  } catch { return NaN; }
}
function __courtRoiOK(ls) {
  const ank = __anklesY(ls);
  const rim = __rimTopY();
  if (!Number.isFinite(ank) || !Number.isFinite(rim)) return false;
  // y grows downward â†’ "below rim" means ank > rim + margin
  return (ank >= rim + Number(window.POSE_BELOW_RIM_MIN || 80));
}
function isPoseBelievable(ls, objects, canvasEl) {
  if (!Array.isArray(ls) || ls.length < 33) return false;

  // Size sanity
  const W = canvasEl?.width  || (window.__VIEW?.vw) || 1280;
  const H = canvasEl?.height || (window.__VIEW?.vh) || 720;
  const b = __poseBox(ls);
  const minH    = Number(window.POSE_MIN_H)           || 110;
  const minArea = Number(window.POSE_MIN_AREA_FRAC)   || 0.006;
  if (b.h < minH) return false;
  if ((b.w * b.h) < (minArea * W * H)) return false;

  // ROI: must be below the rim (reject balcony/railing ghosts)
  if (!__courtRoiOK(ls)) return false;

  // Overlap with detected player/person
  const needBox = (window.POSE_REQUIRE_PLAYER_BOX !== false);
  const players = (objects || [])
    .filter(o => (o.label === 'player' || o.label === 'person') && Array.isArray(o.box) && o.box.length === 4)
    .map(o => ({ x:o.box[0], y:o.box[1], w:o.box[2]-o.box[0], h:o.box[3]-o.box[1] }));
  if (!players.length && needBox) return false;
  if (players.length) {
    const iouMin = Number(window.POSE_MIN_IOU_PLAYER) || 0.18;
    let ok = false;
    for (const pb of players) if (__iou(b, pb) >= iouMin) { ok = true; break; }
    if (!ok) return false;
  }
  return true;
}
// Small persistence gate to avoid 1-frame ghosts
function poseBeliefLatched(isOK) {
  const need = Number(window.POSE_STREAK_NEED) || 2;
  window.__poseBeliefStreak = isOK ? ((window.__poseBeliefStreak||0) + 1) : 0;
  return window.__poseBeliefStreak >= need;
}






// --- Overlay CSS + pixel buffer lock ---
// make the overlay sit over the video, scale with it via CSS,
// but keep the canvas drawing buffer equal to the video *intrinsic* size
// ensureOverlayCss now lives in fix_overlay_display.js

// Debug: click tracer for the overlay â€” logs CSS px + VIDEO px, pe/z, scale/dpr.
// Safe to call multiple times; call removeOverlayTracer() to unbind.

// â”€â”€â”€ Readiness gate for scoring / analysis â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
window.__readyForScoring  = false;  // becomes true after stable warm frames
window.__detectorsWarmed  = false;  // flipped by your prewarm or first success
let __warmFrames          = 0;
let __coolFrames          = 0;

// knobs
const WARM_NEED  = 8;   // ~0.25s @ 30fps
const COOL_NEED  = 4;   // require a few misses before dropping ready

export function resetReadiness(reason = '') {
  __warmFrames = 0;
  __coolFrames = 0;
  window.__readyForScoring = false;
  // if (reason) console.log('[ready] reset:', reason);
}

/**
 * Call once per analysis tick AFTER lastDetectedFrame is updated.
 *  - require WARM_NEED consecutive good frames to become ready
 *  - require COOL_NEED consecutive bad frames to drop ready
 */
export function tickReadiness(objects, poses) {
  // --- Stable signals only ---
  const haveHoop = !!window.getLockedHoopBox?.();                         // rim is locked
  const havePose = Array.isArray(poses) ? poses.length > 0
                                         : !!window.playerState?.keypoints?.length;

  // DO NOT require ball here (ball is flaky at release/under rim)
  const good = haveHoop && havePose;

  // Shot-in-progress latch: don't "cool" while tracking a shot
  const inShot =
    !!window.__fbfActive ||                                  // frame-by-frame window (if enabled)
    !!(window.ballState && (
        window.ballState.releaseSignaled ||                  // we fired release
        window.ballState.state === 'TRACKING'                // trail is being built
    ));

  if (good) {
    __warmFrames++;
    __coolFrames = 0;

    if (!window.__readyForScoring && __warmFrames >= WARM_NEED) {
      window.__readyForScoring = true;
      window.__detectorsWarmed = true;
      console.log('[ready] warm frames met (', __warmFrames, ')');
    }
  } else {
    // Don't drop readiness while a shot is happening
    if (inShot) {
      __coolFrames = 0; // hold ready while the attempt is active
      return;
    }

    __coolFrames++;
    __warmFrames = 0;

    if (window.__readyForScoring && __coolFrames >= COOL_NEED) {
      window.__readyForScoring = false;
      console.log('[ready] cooled (cool frames =', __coolFrames, ')');
    }
  }
}

// Convenience hooks you can call at the right times:
window.onNewVideoLoaded   = () => resetReadiness('new video');
window.onHoopRelocked     = () => resetReadiness('hoop changed');
window.onSeekOrPause      = () => resetReadiness('seek/pause');


// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Lightweight warmâ€‘up for detector + pose (no overlay pollution)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
window.__detectorsWarmed = false;
let __prewarmToken = null;

/**
 * Warm the object detector and pose once, without touching the overlay.
 * Safe to call multiple times; it will noâ€‘op for the same video source.
 */
export async function prewarmDetectors(videoEl) {
  if (!videoEl) return;

  // guard: perâ€‘video token so we donâ€™t reâ€‘prewarm on the same source
  const token = videoEl.currentSrc || videoEl.srcObject || 'in-memory-stream';
  if (__prewarmToken === token && window.__detectorsWarmed) return;

  // make sure we have metadata & a decodable frame
  if (!Number.isFinite(videoEl.duration) || !(videoEl.videoWidth && videoEl.videoHeight)) {
    // rely on your loadedmetadata hook that already calls syncOverlayToVideo etc. :contentReference[oaicite:2]{index=2}
    await new Promise(r => requestAnimationFrame(r));
  }

  // Nudge off t=0 (MediaPipe timestamp guard) but restore afterward
  const originalT = videoEl.currentTime;
  let nudged = false;
  try {
    if (videoEl.currentTime === 0 && isFinite(videoEl.duration)) {
      videoEl.currentTime = Math.min(0.08, Math.max(0.01, videoEl.duration * 0.01));
      nudged = true;
      await new Promise(res => videoEl.addEventListener('seeked', res, { once: true }));
    }
  } catch {}

  // wait one paint so the decoder presents a real frame
  await new Promise(r => requestAnimationFrame(r));

  // tiny offscreen buffer to keep it fast
  const vw = Math.max(1, videoEl.videoWidth  || 640);
  const vh = Math.max(1, videoEl.videoHeight || 360);
  const w = Math.min(480, vw);
  const h = Math.max(1, Math.round(w * vh / vw));
  const tmp = document.createElement('canvas');
  tmp.width = w; tmp.height = h;
  try {
    const tctx = tmp.getContext('2d', { willReadFrequently: true });
    tctx.drawImage(videoEl, 0, 0, w, h);
  } catch {}

  // 1) one detector call (your sendFrameToDetect reads from a canvas) :contentReference[oaicite:3]{index=3}
  try {
    await sendFrameToDetect(tmp, -1);
  } catch {}

  // 2) one pose call on the <video> (your serialized wrapper) :contentReference[oaicite:4]{index=4}:contentReference[oaicite:5]{index=5}
  try {
    if (window.poseDetector?.detectForVideo && typeof window.safeDetectForVideo === 'function') {
      await poseDetectSerial?.(); // your app defines this to call detectForVideo safely
    }
  } catch {}

  // mark warmed and remember this source
  window.__detectorsWarmed = true;
  __prewarmToken = token;

  // restore time if we nudged
  try {
    if (nudged) {
      videoEl.currentTime = originalT;
      await new Promise(res => videoEl.addEventListener('seeked', res, { once: true }));
    }
  } catch {}

  // small settle delay
  await new Promise(r => setTimeout(r, 80));
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Tiny ~#fps pre-detect loop to warm models & seed readiness
// Stops automatically when __readyForScoring OR analyzer starts.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const __preDet = { on:false, raf:0, frame:0 };

export function startPreDetection(videoEl) {
  if (!videoEl || __preDet.on) return;
  __preDet.on = true;
  __preDet.frame = 0;

  const buf  = document.createElement('canvas');
  const bctx = buf.getContext('2d', { willReadFrequently: true });

  // Throttle pre-detect server calls to TARGET_FPS (default 10)
  const TARGET_FPS = Number(window.PD_PREFETCH_FPS ?? 10);
  const MIN_DT = Math.max(50, Math.round(1000 / Math.max(1, TARGET_FPS)));
  let __lastPD = 0;

  function syncSize() {
    const vw = videoEl.videoWidth, vh = videoEl.videoHeight;
    if (!vw || !vh) return false;
    if (buf.width !== vw || buf.height !== vh) { buf.width = vw; buf.height = vh; }
    return true;
  }

  const tick = async () => {
    if (!__preDet.on) return;

    // If the main analyzer has taken over, stop warmup
    if (window.__analyzerActive) { stopPreDetection(); return; }

    try {
      if (syncSize()) {
        bctx.drawImage(videoEl, 0, 0, buf.width, buf.height);

        // Detection path: prefer non-blocking queue if present, else await direct call
        let objects = [];
        if (typeof kickDetect === 'function') {
          // fire-and-forget; consume whatever latest results exist
          // When forced to server (no worker), kickDetect ultimately calls sendFrameToDetect â€”
          // let the cadence be limited by MIN_DT below.
          const now = performance.now();
          if (now - __lastPD >= MIN_DT) {
            __lastPD = now;
            kickDetect(buf, __preDet.frame);
          }
          if (Array.isArray(window.__lastDetObjects)) objects = window.__lastDetObjects;
        } else {
          // direct, blocking detect for warmup â†’ throttle to TARGET_FPS
          const now = performance.now();
          if (now - __lastPD >= MIN_DT) {
            __lastPD = now;
            const det = await sendFrameToDetect(buf, __preDet.frame).catch(() => ({ objects: [] }));
            objects = det?.objects || [];
          }
        }

        // Pose (serialized inside poseDetectSerial)
        const poseRes = await (async () => {
          try { return await poseDetectSerial?.(); } catch { return null; }
        })();
        const poses = poseRes?.landmarks || [];

        // Update only if pose is believable (size + overlaps a detected player/person box)
        try {
          if (Array.isArray(poses) && poses.length) {
            const fps  = Number(window.__videoFPS) || 30;
            const fidx = Math.max(0, Math.round(((videoEl?.currentTime || 0) * fps)));
            const chosen = (typeof pickPoseForActive === 'function')
              ? pickPoseForActive(poses, buf, getLockedHoopBox?.())
              : { scaled: poses[0] };
            if (chosen && Array.isArray(chosen.scaled) && isPoseBelievable(chosen.scaled, objects, buf)) {
              updatePlayerTracker?.(chosen.scaled, fidx);
              try { window.playerState._believable = true; } catch {}
            } else {
              try { window.playerState._believable = false; } catch {}
            }
          }
        } catch {}

        // Expose so overlay/debug can render something pre-ready
        window.lastDetectedFrame = { frameIndex: __preDet.frame, objects, poses };
        bufferDetectedObjects?.(objects);
        drawLiveOverlay?.(objects, window.playerState);
        updateDebugOverlay?.(poses, objects, __preDet.frame);

        // Advance readiness gate; will flip __readyForScoring when stable
        tickReadiness?.(objects, poses);

        // Stop as soon as weâ€™re ready (or analyzer has started)
        const __isLive = !!(videoEl && videoEl.srcObject); if (!__isLive && window.__readyForScoring) { stopPreDetection(); return; }
      }
    } catch (e) {
      console.warn('[predet] error', e);
      // Fail-safe: stop to avoid log spam
      stopPreDetection();
      return;
    }

    __preDet.frame++;
    // cadence close to TARGET_FPS with rAF alignment
    setTimeout(() => { __preDet.raf = requestAnimationFrame(tick); }, MIN_DT);
  };

  __preDet.raf = requestAnimationFrame(tick);
}

export function stopPreDetection() {
  __preDet.on = false;
  if (__preDet.raf) {
    try { cancelAnimationFrame(__preDet.raf); } catch {}
  }
  __preDet.raf = 0;
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€  end pre detection logic


// ---- Boot & event wires ----
document.addEventListener('DOMContentLoaded', () => {
  const videoPlayer = document.getElementById('videoPlayer');
  const videoInput  = document.getElementById('videoInput');
  const overlay     = document.getElementById('overlay');
  const frameEl     = document.querySelector('.video-frame');
  const ctx = overlay ? overlay.getContext('2d', { willReadFrequently: true }) : null;

  if (frameEl && getComputedStyle(frameEl).position === 'static') {
    frameEl.style.position = 'relative';
  }

  // mount the âš™ï¸ preferences on the frame (optional)
  try { mountPrefs?.(frameEl || document.body); } catch {}

  // one true start function (idempotent)
  window.startFrameAnalysis = async () => {
    // In release-only mode, skip analyzer entirely (sampler-only)
    try { if (window.__RELEASE_ONLY === true) { console.log('[analyze] skipped â€” releaseOnly'); return; } } catch {}
    if (!getLockedHoopBox?.()) {
      // refuse to start; surface prompt
      const prompt = document.getElementById('overlayPrompt');
      if (prompt) { prompt.textContent = 'ðŸ“ Tap the hoop to begin setup'; prompt.style.display = 'block'; }
      return;
    }
    // stop any warmup and pre-detect loops
    try { stopPreDetection?.(); } catch {}
    // analyze (your loop is already idempotent via window.__analyzerActive)
    window.analyzeVideoFrameByFrame?.(videoPlayer, overlay);
  };

  // metadata â†’ size map + warmup
  videoPlayer.addEventListener('loadedmetadata', async () => {
    try { initHUDForVideo?.(videoPlayer); } catch {}
    // reset pick state on every new source
    window.__hoopConfirmed = false;
    window.__pickingHoop   = false;

    syncOverlayToVideo();

    // ðŸ‘‡ Auto-arm pick for uploaded videos (not live camera)
    const isLive = !!videoPlayer.srcObject;
    if (!isLive) {
      try { window.USE_FBF_DURING_SHOT = true; } catch {}
      try { window.FBF_VISUAL_FPS = 10; } catch {}
      try { window.__STRICT_FRAME_LOCK = true; } catch {} // analyzer is the only clock
      try { enableHoopPickOnce(); } catch {}
      window.showPrompt?.('Tap the hoop to begin setup');
    } else {
      try { window.__STRICT_FRAME_LOCK = false; } catch {}
    }

    // (keep your prewarm + optional pre-detect)
    if (window.__RELEASE_ONLY === true) {
      try { console.log('[PD] skipped â€” releaseOnly'); } catch {}
    } else {
      try {
        await prewarmDetectors?.(videoPlayer);
        window.__detectorsWarmed = true;
      } catch {}
      try { startPreDetection?.(videoPlayer); } catch {}
    }
    try { window.resetReleaseSessionCounters?.(); } catch {}
    try { installBallMotionFallback(videoPlayer); } catch {}
  }, { once: true });

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Pose-release sampler: polls releaseGate() and emits via safeEmitRelease()
  // Keeps the HUD visual-only; canonical events come from this producer.
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  (function installPoseReleaseSampler(){
    if (window.__poseSamplerInstalled) return;
    window.__poseSamplerInstalled = true;

    function tick() {
      try {
        const hist = (window.playerState?.frameHistory || []).slice(-5);
        if (typeof window.releaseGate === 'function' && hist.length) {
          const g = window.releaseGate(hist);
          if (g?.released) {
            const f = window.playerState?.lastFrame ?? (hist.at ? hist.at(-1)?.frame : (hist[hist.length-1]?.frame)) ?? 0;
            window.safeEmitRelease?.(f, 'pose-sampler', { gate: g });
          }
        }
      } catch {}
      finally {
        window.__poseSamplerTimer = setTimeout(tick, Number(window.COACH_POSE_MS || 120));
      }
    }

    window.startPoseReleaseSampler = function startPoseReleaseSampler(){
      if (window.__poseSamplerTimer) return; // idempotent
      window.__poseSamplerTimer = setTimeout(tick, 0);
    };
    window.stopPoseReleaseSampler = function stopPoseReleaseSampler(){
      try { clearTimeout(window.__poseSamplerTimer); } catch {}
      window.__poseSamplerTimer = null;
    };

    // Auto-stop at end of attempts
    window.addEventListener('shot:summary', () => { try { window.stopPoseReleaseSampler?.(); } catch {} });
    window.addEventListener('shot:end',     () => { try { window.stopPoseReleaseSampler?.(); } catch {} });
  })();

  // Reset canonical counters/guards on new video source
  window.resetReleaseSessionCounters = function resetReleaseSessionCounters() {
    try {
      window.__SCORE_SHOT_COUNT = 0;     // HUD uses this canonical counter
      window.__HUD_SHOT_COUNT   = 0;     // legacy HUD counter (kept for safety)
      window.__SESSION_SHOT_COUNT = 0;   // track cap-enforced attempts
      window.__releaseEventSent = false; // allow first release
      window.__REL_LAST_FIRE_MS = 0;     // reset cooldown
    } catch {}
  };

  // Call once for the current source as well
  try { window.resetReleaseSessionCounters?.(); } catch {}

  // Keep overlay in sync on resize / layout
  const resync = () => (window.scheduleSyncOverlay?.() ?? syncOverlayToVideo());
  window.addEventListener('resize', resync, { passive: true });
  try { new ResizeObserver(resync).observe(frameEl); } catch {}
  try { new ResizeObserver(resync).observe(videoPlayer); } catch {}
  document.addEventListener('fullscreenchange', resync);

  // Pause â†’ stop analysis + pre-detect, reset readiness a bit
  videoPlayer.addEventListener('pause', () => {
    // If FBF owns the pause, do NOT tear down analysis
    if (window.__fbfActive === true || window.__FBF_OWNING_PAUSE === true) return;
    const live = !!videoPlayer.srcObject;
    if (live) return;
    try { window.stopPoseReleaseSampler?.(); } catch {}
    try { window.isTracking = false; } catch {}
    try { stopPreDetection?.(); } catch {}
    try { window.stopFrameAnalysis?.(); } catch {}
    try { window.onSeekOrPause?.(); } catch {}
  });

  // Auto-pause when tab hidden
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      try { videoPlayer.pause(); } catch {}
    }
  });

  // Toggle play gate: require hoop lock (and optionally the prompt function if present)
  window.togglePlay = () => {
    const hoopLocked = !!getLockedHoopBox?.();
    if (!hoopLocked) {
      const prompt = document.getElementById('overlayPrompt');
      if (prompt) { prompt.textContent = 'ðŸ“ Tap the hoop to begin setup'; prompt.style.display = 'block'; }
      videoPlayer.pause();
      return;
    }
    videoPlayer.paused ? videoPlayer.play() : videoPlayer.pause();
  };

  // Play â†’ enforce gate & start analysis
  // account for hoop selection on live video
  videoPlayer.addEventListener('play', async () => {
    // ðŸ”¹ Live camera must keep playing so you can see & pick the hoop
    const isLive = !!videoPlayer.srcObject;
    if (isLive) {
      console.log('â–¶ï¸ Live camera streaming');
      // Let pre-warm or picker flow start analysis later; do NOT pause here.
      try { window.startPoseReleaseSampler?.(); } catch {}
      return;
    }

    // ðŸ”¹ Uploaded videos keep the original gate (pause until hoop is locked)
    const hoopLocked = !!getLockedHoopBox?.();
    console.log('[gate check]', {
      hasHoop: hoopLocked,
      warmed: !!window.__detectorsWarmed,
      ready:  !!window.__readyForScoring
    });
    if (!hoopLocked) { videoPlayer.pause(); return; }

    // Preflight: pause briefly so pre-detector can get ahead and stabilize
    try {
      if (!window.__preflightReady) {
        try { videoPlayer.pause(); } catch {}
        try { window.setSessionStatus?.('Preparing analyzerâ€¦'); } catch {}
        try { installPreDetectorFor?.(videoPlayer); } catch {}
        try { startPreDetection?.(videoPlayer); } catch {}
        // Wait for PD warmup (lead frames) or up to 5s (~10 fps => ~4s lead)
        const lead = Number(window.PD_PREFETCH_LEAD ?? 40);
        const toMs = Number(window.PD_PREFETCH_TIMEOUT_MS ?? 3500);   
        try { await (waitForPDWarm?.(lead, toMs) || Promise.resolve()); } catch {}
        window.__preflightReady = true;
        try { await videoPlayer.play(); } catch {}
      }
    } catch {}

    console.log('â–¶ï¸ Video playback started');
    window.startFrameAnalysis?.();
    // NEW: begin polling the canonical gate for pose releases
    try { window.startPoseReleaseSampler?.(); } catch {}
  });

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Shot lifecycle helpers (kept; used by the unified pose-release pipeline)
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  // Report frontend release to backend (anchor for arc)
  window.__reportReleaseToServer = async function __reportReleaseToServer(detail){
    try {
      // Ensure a backend session exists; if not, create one on the fly
      try {
        if (!window.__SESSION_ID) {
          const rr = await fetch('/api/sessions/start', {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ device: navigator.userAgent })
          });
          if (rr.ok) {
            const jj = await rr.json();
            window.__SESSION_ID = jj?.id || null;
            window.__SHOT_IDX = 0;
          }
        }
      } catch {}
      const payload = {
        sessionId: (window.__SESSION_ID || null),
        shotId: (window.__SHOT_IDX || null),
        frame: Number(detail?.frame)||0,
        tMs: Number(detail?.tMs||Date.now()),
        via: detail?.via || 'frontend',
        poseSnapshot: (typeof window.extractPoseSnapshot === 'function' && window.playerState?.keypoints)
                        ? window.extractPoseSnapshot(window.playerState.keypoints, window.getLockedHoopBox?.())
                        : null,
        hoop: (typeof window.getLockedHoopBox === 'function') ? window.getLockedHoopBox() : null,
        gate: (window.__LAST_GATE || null),
      };
      await fetch('/api/release_mark', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload)}).catch(()=>{});
    } catch {}
  };

  // Report per-shot summary (ball metrics) to backend for persistence
  window.__reportSummaryToServer = async function __reportSummaryToServer(detail){
    try {
      const sid = (window.__SESSION_ID || null);
      if (!sid) return;
      const list = (window.__shotList || []);
      let idx = null;
      try { if (Number.isFinite(window.__SHOT_IDX)) idx = Number(window.__SHOT_IDX); } catch {}
      if (idx == null && Array.isArray(list) && list.length) idx = list.length - 1;
      const payload = {
        idx,
        t: Date.now(),
        made: (detail?.made ?? null),
        arcHeight: (detail?.arcHeight ?? null),
        entryAngle: (detail?.entryAngle ?? null),
        releaseAngle: (detail?.releaseAngle ?? null),
        missReason: (detail?.missReason ?? null)
      };
      // Client-side idempotence: avoid double posts for same sid|idx
      try {
        const key = `${sid}|${idx==null? 'na' : idx}`;
        window.__SUMMARY_POSTED ||= new Set();
        if (window.__SUMMARY_POSTED.has(key)) return;
        window.__SUMMARY_POSTED.add(key);
      } catch {}
      await fetch(`/api/sessions/${sid}/shot`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload)}).catch(()=>{});
    } catch {}
  };

  // Dev toggles (no listeners bound until you call them)
  window.setShotDebug   = (on=true) => { window.DOACH_SHOT_DEBUG   = !!on; console.log('[shot:debug]',   window.DOACH_SHOT_DEBUG); };
  window.setReleaseTrace= (on=true) => { window.DOACH_RELEASE_TRACE= !!on; console.log('[release:trace]', window.DOACH_RELEASE_TRACE); };
  window.__DEV_fakeBall = function __DEV_fakeBall(count = 24) {
    const n = Math.max(4, Number(count) || 24);
    const f0 = Number(window.__AN_IDX || 0);
    const t0 = performance.now();
    for (let i = 0; i < n; i++) {
      const x = 600 + i * 6;
      const y = 420 - (i * 7) + Math.floor(0.15 * i * i);
      window.updateBall?.(x, y, { frame: f0 + i, tMs: t0 + i * 33, conf: 0.9, via: 'dev' });
    }
    window.__dbgLine?.(`[dev] injected fake ball trail (${n} pts)`);
  };

  // Expectation helpers: watch for a release near a specific frame or time
  window.watchReleaseAtFrame = (frame) => {
    const target = Math.max(0, Number(frame)||0);
    const fps = Number(window.__videoFPS) || 30;
    const tolerance = Number(window.REL_WATCH_TOL || 3);
    const t0 = performance.now();
    const onRel = (e) => {
      const f = Number(e?.detail?.frame);
      console.log('[watch:release]', { expect: target, got: f, dtMs: Math.round(performance.now()-t0), within: Math.abs((f||0)-target) <= tolerance });
      window.removeEventListener('shot:release', onRel);
    };
    window.addEventListener('shot:release', onRel);
    console.log('[watch:arm] release @ frame', target, `(Â±${tolerance} fr) ~ t=${(target/fps).toFixed(2)}s`);
  };
  window.watchReleaseAtTime = (hhmmss) => {
    try {
      const fps = Number(window.__videoFPS) || 30;
      const parts = String(hhmmss||'').trim().split(':').map(Number);
      let h=0,m=0,s=0; if (parts.length===3){[h,m,s]=parts;} else if(parts.length===2){[m,s]=parts;} else { s = parts[0]||0; }
      const sec = (h*3600)+(m*60)+s; const frame = Math.round(sec*fps);
      window.watchReleaseAtFrame(frame);
    } catch(e) { console.warn('[watch] bad time', hhmmss, e); }
  };

  // Seek â†’ small readiness reset (useful for scrub/step)
  videoPlayer.addEventListener('seeked', () => {
    try { window.onSeekOrPause?.(); } catch {}
  });

  // Uploads
  videoInput?.addEventListener('change', (e) => window.handleVideoUpload?.(e));
});

// play from device cam button
document.getElementById('useCameraBtn')?.addEventListener('click', async () => {
  const ok = await startCamera();
  if (!ok) return;

  const v = document.getElementById('videoPlayer');
  if (!v?.srcObject || !v.videoWidth) { console.warn('[analyze] camera not ready'); return; }

  armOverlayForPickNow();  // sets __pickingHoop=true, makes overlay clickable & on top
  enableHoopPickOnce();    // one-tap to lock rim (center in VIDEO px)
  window.showPrompt?.('Tap the hoop to begin setup');

  // Release-only probe: start the quick sampler right away and add a dev button
  try {
    if (window.__RELEASE_ONLY === true) {
      window.startCoachSamplerQuick?.(window.COACH_POSE_MS || 120);
      // Add a tiny dev button to manually validate the pipeline
      if (!document.getElementById('devTapReleaseBtn')) {
        const btn = document.createElement('button');
        btn.id = 'devTapReleaseBtn';
        btn.textContent = 'Tap Release (dev)';
        Object.assign(btn.style, { position:'absolute', right:'12px', bottom:'12px', zIndex:9999, padding:'6px 10px' });
        btn.addEventListener('click', () => {
          const f = Number(window.playerState?.lastFrame) || 0;
          (window.__markReleasePose || window.markRelease)?.(f, { via:'manual-test', requirePose:true });
          try { (window.__REL_LOG ||= []).push({ t: Date.now(), type:'manual', detail:{ frame:f, via:'manual-test' }, latched:true }); } catch {}
        });
        (document.querySelector('.video-frame') || document.body).appendChild(btn);
        // Auto-remove after ~10 minutes
        setTimeout(() => { try { btn.remove(); } catch {} }, 10 * 60 * 1000);
      }
    }
  } catch {}
});

// Optional: re-arm latch on play only when explicitly enabled
document.getElementById('videoPlayer')?.addEventListener('play', () => {
  if (window.RESET_ON_PLAY === true) { try { window.__releaseEventSent = false; } catch {} }
});

// Keep the arc overlay crisp between shots (noop here; handled elsewhere)
try {
  window.addEventListener('shot:release', () => {
    // Disabled: app-level FBF starter removed
    return;
  });
} catch {}

// test agent for auto devel
(function loadArcContract(){
  const s = document.createElement('script');
  s.src = '/tools/arc_contract.js';
  s.async = true;
  s.onload = () => console.log('[arc] contract loaded');
  s.onerror = () => console.warn('[arc] contract not found â€” metrics will be skipped');
  document.head.appendChild(s);
})();



//--------------------------------------------------------------//
//     ----- Initialize the video player and overlay -----      //
//--------------------------------------------------------------//
window.handleVideoUpload = async function (event) {
  const file = event?.target?.files?.[0];
  if (!file) return;

  const video  = document.getElementById('videoPlayer');
  const prompt = document.getElementById('overlayPrompt');
  const overlayEl = document.getElementById('overlay');
  if (!video || !overlayEl) { console.error('[load] missing video/overlay'); return; }

  // ensure we have the overlay element in this scope
  // essential in selecting the hoop
  if (!overlayEl) {
    console.error('[load] overlay canvas not found');
    return;
  }
  // expose if other modules reference window.overlayEl
  window.overlayEl = overlayEl;

  // stop any previous analysis loop
  window.stopFrameAnalysis?.();

  // Reset session + readiness
    try { resetAll?.(); } catch {}
    try { resetPlayerTracker?.(); } catch {}
    try { resetShotStats?.(); } catch {}
    try { resetReadiness?.('new upload'); } catch {}   // from our readiness gate
  

  // Clean up old blob, if any
  try {
    if (window.__videoBlobURL) URL.revokeObjectURL(window.__videoBlobURL);
  } catch {}
  window.__videoBlobURL = URL.createObjectURL(file);

  console.log('[load] begin', { name: file.name, size: file.size });

  // Prepare player
  try { video.pause(); } catch {}
  video.removeAttribute('src');                    // avoid stale source races
  video.preload = 'metadata';
  video.src = window.__videoBlobURL;
  video.load();

  // on metadata, make sure overlay sizing/z-index is correct
  // required to select hoop
  const onMeta = () => {
    ensureOverlayCss();          // positions .video-frame relative, etc.
    installOverlayTracer?.();    // optional visual tracer
  };
  video.addEventListener('loadedmetadata', onMeta, { once: true });

  // wait up to 10s for metadata
  await Promise.race([
    new Promise(res => video.addEventListener('loadedmetadata', res, { once: true })),
    new Promise((_, rej) => setTimeout(() => rej(new Error('metadata timeout')), 10000))
  ]);

  // after metadata
  try {
    ensureOverlayCss?.();

    // âœ… init overlay WITHOUT a fake detector â€” pose attaches later
    initOverlay?.(overlayEl);

    // optional pre-detect warmup, if youâ€™ve got it
    try { startPreDetection?.(video); } catch (e) {
      console.warn('predetect start failed:', e);
    }
    // Reset canonical counters/guards for this new source
    try { window.resetReleaseSessionCounters?.(); } catch {}
  } catch (e) {
    console.warn('initOverlay failed:', e);
  }

  // Define analysis start bound to this video/overlay
    window.startFrameAnalysis = () => {
      if (!getLockedHoopBox?.()) {
        console.warn('[analyze] not starting: hoop not locked');
        return;
      }
      try { stopPreDetection?.(); } catch {}
      console.log('[analyze] starting main loopâ€¦');
      try { runAnalyzer?.(video, overlayEl); } catch { window.legacyAnalyzeVideoFrameByFrame?.(video, overlayEl); }
    };

  console.log('[load] metadata', {
    w: video.videoWidth, h: video.videoHeight, dur: video.duration,
    ready: video.readyState, src: video.currentSrc
  });

  // (re)apply CSS and tracer (harmless if called twice)
  ensureOverlayCss();
  try { installOverlayTracer?.(); } catch {}

  // required for hoop selection
  // ðŸŸ¢ arm the one-shot hoop picker and show the prompt
  if (prompt) {
    prompt.textContent = 'ðŸ“ Tap the hoop to begin setup';
    prompt.style.display = 'block';
  }
  // avoid double-binding if called again
  if (!window.__hoopPickArmed) {
    enableHoopPickOnce();
    window.__hoopPickArmed = true;
  }

  // mini controls overlay
  try { createPlaybackControls?.(video); } catch {}
};


// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Analyzer (event-driven, no time-warping of the video element)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// ========= globals =========
let __analyzing = false;
let __frameIdx  = 0;
let __detachAnalysis = null;

window.__analyzerActive = false;

// Pose timestamp broker + serialized wrapper
window.__poseTS = Math.floor(performance.now());
function nextPoseTS() {
  const base = Math.floor(performance.now());
  window.__poseTS = Math.max(window.__poseTS + 1, base);
  return window.__poseTS;
}

// ---- SUPPORT: serialized pose wrapper (keep once globally) ----
let __poseBusy = false;
let __poseLast = null;
export async function poseDetectSerial() {
  if (!window.poseDetector) return null;
  if (__poseBusy) return __poseLast; // serve last result to avoid visual freeze
  __poseBusy = true;
  try {
    const video = document.getElementById('videoPlayer');
    if (!video?.videoWidth) return null;
    const ts = window.nextPoseTS ? window.nextPoseTS() : Math.floor(performance.now());
    const res = await window.poseDetector.detectForVideo(video, ts);
    if (res && res.landmarks && res.landmarks.length >= 33) __poseLast = res;
    return res;
  } catch (e) {
    console.warn('pose detect error:', e);
    return __poseLast; // degrade to last good result
  } finally {
    __poseBusy = false;
  }
}
window.poseDetectSerial = poseDetectSerial;

// lifecycle
window.stopFrameAnalysis = function stopFrameAnalysis() {
  try { if (typeof __detachAnalysis === 'function') __detachAnalysis(); }
  finally {
    __detachAnalysis = null;
    __analyzing = false;
    window.__analyzerActive = false;
  }
};

// Use frame-by-frame during the shot window
// Enable FBF during the shot window (pose release â†’ FBF start)
window.USE_FBF_DURING_SHOT = false; // disable visible FBF by default; backend handles analysis

// startTracking: kicks analyzer for #videoPlayer + #overlay
window.startTracking = function startTracking() {
  const v = document.getElementById('videoPlayer');
  const o = document.getElementById('overlay');
  if (!v || !o) { console.warn('[analyze] missing video/overlay'); return; }
  window.analyzeVideoFrameByFrame(v, o);
};
window.stopTracking = window.stopFrameAnalysis;

// optional legacy â€œreal-timeâ€ hook (off by default)
window.useRealTimeTracking = false;
(function attachRealtimePlayHook() {
  const v = document.getElementById('videoPlayer');
  if (!v) return;
  v.addEventListener('play', () => {
    if (window.useRealTimeTracking) {
      try { window.startTracking(); } catch {}
    }
  });
})();

// Default: uploads use FBF during the shot window; live sessions disable it.
window.USE_FBF_DURING_SHOT = true;
window.FBF_VISUAL_FPS      = 10;          // visual pacing target for FBF


//---------------------------------------------------------------------------------//
//                     ----------  FBF  ----------                                 // 
// Frame-By-Frame shot window â€” deterministic, faster pacing, safe scorer ordering //
//---------------------------------------------------------------------------------//

(function installShotWindowFBF(){
  let cancelFBF = null;
  window.__fbfActive = false;

  function getVid() { return window.__videoEl || document.getElementById('videoPlayer') || document.querySelector('video'); }
  function getCan() { return document.getElementById('overlay') || document.getElementById('videoCanvas') || window.videoCanvas; }
  function getFPS() { return Number(window.__videoFPS) > 0 ? Number(window.__videoFPS) : 30; }

  // Wait until the *next* decoded frame after seeking
  function waitForNextDecodedFrame(videoEl) {
  return new Promise(resolve => {
    let done = false;
    const startT = videoEl.currentTime;

    const finish = (via='?') => {
      if (!done) {
        done = true;
        console.log('[fbf/wait]', via, 'from', startT.toFixed(3), 'â†’', videoEl.currentTime.toFixed(3));
        cleanup();
        resolve();
      }
    };

    const onSeeked = () => finish('seeked');
    videoEl.addEventListener('seeked', onSeeked, { once: true });

    let rvfcId = null;
    if (!videoEl.paused && 'requestVideoFrameCallback' in HTMLVideoElement.prototype) {
      try {
        rvfcId = videoEl.requestVideoFrameCallback(() => finish('rvfc'));
      } catch {}
    }

    const to = setTimeout(() => finish('timeout250ms'), 250);

    function cleanup() {
      try { videoEl.removeEventListener('seeked', onSeeked); } catch {}
      if (rvfcId != null) { try { videoEl.cancelVideoFrameCallback(rvfcId); } catch {} }
      clearTimeout(to);
    }
  });
}

  async function stepOnce(videoEl, canvasEl, frameIdx, buf, bctx) {
  // 0) Buffer current paused frame in VIDEO pixel space (avoid double-scaling)
  const vw = Number(videoEl.videoWidth)  || canvasEl.width  || buf.width  || 0;
  const vh = Number(videoEl.videoHeight) || canvasEl.height || buf.height || 0;
  if (vw && vh && (buf.width !== vw || buf.height !== vh)) {
    buf.width = vw; buf.height = vh;
  }
  bctx.drawImage(videoEl, 0, 0, buf.width, buf.height);
  // Keep overlayâ†’video mapping sane while paused
  try { ensureOverlayCss?.(); syncOverlayToVideo?.(); } catch {}

  // 1) DETECT + POSE (prefer ROI near hoop if available)
  async function detectWithROI(buf, frameIdx, hoopLockedGuess = null) {
    try {
      const ROI_ONLY = (window.DETECT_ROI_ONLY !== false);
      const s = (window.ballState || {});
      const roiActive = ROI_ONLY && (s.releaseFrame != null || (window.__fbf?.active) || window.__ROI_DETECT_ALWAYS === true);
      const H = hoopLockedGuess || (typeof window.getLockedHoopBox === 'function' ? window.getLockedHoopBox() : null);
      if (!roiActive || !H) return await sendFrameToDetect(buf, frameIdx).catch(() => ({ objects: [] }));
      const Hc = canonHoop(H);
      // Supersample ROI under the rim for ONNX worker
      const scale = Number(window.ROI_SUPERSAMPLE || 1.6);
      const expW = Math.max(1, Math.round((Hc?.w || 100) * scale));
      const expH = Math.max(1, Math.round((Hc?.h || 80) * scale * 1.8));
      const cx = Hc.cx, cy = Hc.cy;
      const x0 = Math.max(0, Math.round(cx - expW/2));
      const y0 = Math.max(0, Math.round(cy - expH*0.45));
      const x1 = Math.round(cx + expW/2);
      const y1 = Math.round(cy + expH*0.55);
      const x = Math.max(0, x0);
      const y = Math.max(0, y0);
      const w = Math.max(1, Math.min(buf.width  - x, x1 - x0));
      const h = Math.max(1, Math.min(buf.height - y, y1 - y0));
      const bw = buf.width, bh = buf.height; if (!bw || !bh) return await sendFrameToDetect(buf, frameIdx).catch(() => ({ objects: [] }));
      const cw = Math.min(w, Math.max(1, bw - x));
      const ch = Math.min(h, Math.max(1, bh - y));
      let roiCanvas;
      if (typeof OffscreenCanvas !== 'undefined') {
        roiCanvas = new OffscreenCanvas(cw, ch);
      } else {
        roiCanvas = document.createElement('canvas');
        roiCanvas.width = cw;
        roiCanvas.height = ch;
      }
      const rctx = roiCanvas.getContext('2d', { willReadFrequently: true });
      rctx.drawImage(buf, x, y, cw, ch, 0, 0, cw, ch);
      const det = await sendFrameToDetect(roiCanvas, frameIdx).catch(() => ({ objects: [] }));
      const objs = (det?.objects || []).map(o => Array.isArray(o.box) ? { ...o, box: [o.box[0]+x, o.box[1]+y, o.box[2]+x, o.box[3]+y] } : o);
      return { ...(det || {}), objects: objs, _source: 'roi' };
    } catch { return await sendFrameToDetect(buf, frameIdx).catch(() => ({ objects: [] })); }
  }
  const det = await detectWithROI(buf, frameIdx).catch(() => ({ objects: [] }));
  let objects = det?.objects || [];
  try { stabilizeLockedHoop?.(objects); } catch {}
  try { objects = filterObjectsToLockedHoop?.(objects) ?? objects; } catch {}
  // 2) Stabilize hoop â†’ read center â†’ attach TL (tracker expects TL)
  try { stabilizeLockedHoop?.(objects); } catch {}
  
  
  let hoopTL = null, Hc = null;
  if (hoopLocked) {
    Hc     = canonHoop(hoopLocked);
    hoopTL = { ...asTopLeft(Hc), anchor: 'topleft' };
    try { attachHoop?.(hoopTL); } catch {}
  }

  // 3) Player tracker (use your chosen pose)
  let poseMarked = false;
  try {
    if (poses?.length) {
      const keypoints = poses[0];
      updatePlayerTracker?.(keypoints, frameIdx);
      playerState.keypoints = keypoints;
      markPoseWarmStatus(true);
      poseMarked = true;
    }
  } catch {}
  if (!poseMarked) markPoseWarmStatus(false);

  // 4) Release/Proximity via shot_arc FSM (centralized)
  try {
    const last = window.ballState?.trail?.at?.(-1) || null;
    if (window.DOACH_SHOT_DEBUG) {
      const poseReady = !!(window.playerState?.keypoints?.length >= 33);
      const hasBall  = !!(last && Number.isFinite(last.x));
      console.log('[fbf:tick] arcTick', { frame: frameIdx, poseReady, hasBall });
    }
    if (hoopLocked && last) _arcTick?.({ frame: frameIdx, pose: playerState, ballPt: last, hoopBox: hoopLocked });
  } catch {}

  // 5) Publish frame to overlay/HUD consumers
  window.lastDetectedFrame = { __frameIdx: frameIdx, objects, poses };
  try { bufferDetectedObjects?.(objects); } catch {}

  // 6) Ball update (CANVAS coords) + robust fallback
  let updatedThisTick = false;

  // 6a) Seed on first FBF frame from last known
  if (frameIdx === 0) {
    const last = window.ballState?.trail?.at?.(-1);
    if (last && Number.isFinite(last.x) && Number.isFinite(last.y)) {
      try { updateBall?.({ x: last.x, y: last.y }, frameIdx); updatedThisTick = true; } catch {}
    }
  }

  // 6b) YOLO center (CANVAS â€” detector runs on buf == canvas size)
  if (!updatedThisTick) {
    try {
      const ballObj = objects.find(o => isBallLabel(o.label) && Array.isArray(o.box));
      if (ballObj && hoopLocked) {
        const [x1,y1,x2,y2] = ballObj.box;
        const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;       // already CANVAS coords
        // Ghost reject vs last trail point
        const last = window.ballState?.trail?.at?.(-1) || null;
        const maxStep = Number(window.BALL_MAX_STEP || 40) * 1.8;
        if (last) {
          const dist = Math.hypot(cx - last.x, cy - last.y);
          if (dist > maxStep) {
            const r = maxStep / (dist || 1);
            const clamped = { x: last.x + (cx - last.x) * r, y: last.y + (cy - last.y) * r };
            if (window.DOACH_SHOT_DEBUG) console.log('[fbf] clamp ghost ball', { dist, maxStep, to: clamped });
            updateBall?.(clamped, frameIdx);
            updatedThisTick = true;
          } else {
            updateBall?.({ x: cx, y: cy }, frameIdx);
            updatedThisTick = true;
          }
        } else {
          updateBall?.({ x: cx, y: cy }, frameIdx);
          updatedThisTick = true;
        }
      }
    } catch {}
  }

  // 6c) YOLO blink â†’ micro-track near last trail point
  if (!updatedThisTick) {
    const last = window.ballState?.trail?.at?.(-1);
    if (last) {
      try {
        const roi = (typeof refineBallWithROI === 'function') ? refineBallWithROI(bctx, last, 22) : null;
        if (roi) { updateBall?.({ x: roi.x, y: roi.y }, frameIdx); updatedThisTick = true; }
      } catch {}
    }
  }

  // 6d) Fill tiny frame gaps to keep the live trail smooth
  if (updatedThisTick && typeof fillRecentGapInPlace === 'function') {
    try { fillRecentGapInPlace(window.ballState); } catch {}
  }

  // 7) Arc stepping centralized
  try {
    const lastPt = window.ballState?.trail?.at?.(-1) || null;
    const ballCenter = lastPt ? { x: lastPt.x, y: lastPt.y } : null;
    if (hoopLocked && ballCenter) window.shotArc?.updateArc?.(frameIdx, ballCenter, hoopLocked);
    // Redundant prox stamping with early widened ROI (first cycle resilience)
    try {
      if (hoopLocked && ballCenter) {
        const Hc = canonHoop(hoopLocked);
        const base = proxFromHoop?.(Hc);
        if (base) {
          const bs = (window.ballState ||= {});
          let prox = base;
          if (bs.releaseFrame != null && bs.proxEnterFrame == null && (frameIdx - bs.releaseFrame) <= 30) {
            const padX = Math.max(30, (Hc.w || 100) * 0.6);
            const padY = Math.max(40, (Hc.h || 80)  * 0.8);
            prox = { x: base.x - padX, y: base.y - padY, w: base.w + padX*2, h: base.h + padY*2 };
          }
          const inside = (ballCenter.x >= prox.x && ballCenter.x <= prox.x + prox.w && ballCenter.y >= prox.y && ballCenter.y <= prox.y + prox.h);
          if (inside && bs.proxEnterFrame == null) bs.proxEnterFrame = frameIdx;
          if (!inside && bs._lastInProx && bs.proxExitFrame == null) bs.proxExitFrame = frameIdx;
          bs._lastInProx = inside;
          if (bs.proxEnterFrame == null && bs.releaseFrame != null && (frameIdx - bs.releaseFrame) > 8) bs.proxEnterFrame = bs.releaseFrame + 1;
          // Exit fallback: below rim bottom or long linger after enter
          const exitMargin = Number(window.EXIT_BELOW_MARGIN || 12);
          const rimBottom = Hc.rimTop + (Hc.h || 0);
          if (bs.proxEnterFrame != null && bs.proxExitFrame == null) {
            if (ballCenter.y > (rimBottom + exitMargin)) bs.proxExitFrame = frameIdx;
            else if ((frameIdx - bs.proxEnterFrame) > 60) bs.proxExitFrame = frameIdx;
          }
        }
      }
    } catch {}
    // Emergency release latch if not set yet (prox or slope-based)
    try {
      const bs = (window.ballState ||= {});
      if (bs.releaseFrame == null && hoopLocked && ballCenter) {
        const Hc = canonHoop(hoopLocked);
        const prox = proxFromHoop?.(Hc);
        if (prox) {
          const inside = (ballCenter.x >= prox.x && ballCenter.x <= prox.x + prox.w && ballCenter.y >= prox.y && ballCenter.y <= prox.y + prox.h);
          if (inside) { try { window.__markReleasePose?.(frameIdx, { prox, via: 'fbf-prox' }); } catch {} }
        }
        const t = Array.isArray(bs.trail) ? bs.trail : [];
        if (bs.releaseFrame == null && t.length >= 3) {
          const a = t[t.length-3], b = t[t.length-2], c = t[t.length-1];
          const up = (c.y < b.y - 1.5) && (b.y < a.y - 1.5);
          const laneX = Math.abs(c.x - Hc.cx) <= Math.max(45, Hc.w * 0.5);
          const nearRim = c.y <= (Hc.rimTop + Math.max(18, Hc.h * 0.3));
          if (up && laneX && nearRim) { try { window.__markReleasePose?.(frameIdx, { via: 'fbf-slope' }); } catch {} }
        }
      }
    } catch {}
  } catch {}

  // 8) Hard stop safeguard: if ball clearly below prox, stop FBF
  try {
    if (Hc) {
      const prox = makeProxRectFromCanon(Hc);
      const lastPt = window.ballState?.trail?.at?.(-1) || null;
      if (prox && lastPt && lastPt.y > (prox.y + prox.h + 8)) {
        console.log('[fbf] stop â€” ball below prox');
        return false; // signal caller to end FBF loop
      }
    }
  } catch {}

  // 9) Net-motion HUD (TL ROI)
  try {
    if (hoopTL) {
      const netFn = (typeof detectNetMotionFromCanvas === 'function')
                      ? detectNetMotionFromCanvas
                      : (typeof detectNetMotion === 'function' ? detectNetMotion : null);
      if (netFn) {
        window.ballState.netMoved = netFn(buf, hoopTL);
        drawNetMotionStatus?.(buf, window.ballState.netMoved);
      }
    }
  } catch {}

  // 10) HUD / overlays
  try { window.tickReadiness?.(objects, poses); } catch {}
  try { updateDebugOverlay?.(poses, objects, frameIdx); } catch {}
  try { drawLiveOverlay?.(objects, playerState);
      // Scoring + shot logging in RVFC (live) mode
      try {
        const hasTrail = (window.ballState?.trail?.length || 0) > 0;
        if (hoopLocked && (updatedThisTick || hasTrail)) {
          if (window.USE_MICROCLIP !== true) scoringTick?.(frameIdx);
          if (window.USE_MICROCLIP !== true) checkShotConditions?.(ballState, hoopLocked, frameIdx);
        }
      } catch {} } catch {}

  // 11) Scorer (only if we have a point or an existing live trail)
  const hasTrail = (window.ballState?.trail?.length || 0) > 0;
  try {
    if (hoopLocked && (updatedThisTick || hasTrail)) {
      if (window.USE_MICROCLIP !== true) scoringTick?.(frameIdx);
      if (window.USE_MICROCLIP !== true) checkShotConditions?.(ballState, hoopLocked, frameIdx);
      if (window.DOACH_VERBOSE === true) console.log('[score:fbf]', frameIdx, {
        rel:   ballState?.releaseFrame,
        enter: ballState?.proxEnterFrame,
        exit:  ballState?.proxExitFrame,
        state: ballState?.state,
        shots: (window.shotLog?.length || 0)
      });
      // <<< first-time latch for tests
      if (!window.__lastSummary && Array.isArray(window.shotLog) && window.shotLog.length > 0) {
        window.__lastSummary = window.shotLog[window.shotLog.length - 1];
        console.log('[shot] Summary logged:', window.__lastSummary);
      }
    }
  } catch (e) { console.warn('[fbf] scorer error', e); }
}

async function runShotFBF() {
  const videoEl  = getVid();
  const canvasEl = getCan();
  if (!videoEl || !canvasEl) return;
  if (window.__fbfActive)   return;

  try { stopFrameAnalysis?.(); } catch {}

  window.__fbfActive = true;
  window.__ignoreSlowWhileFBF = true;
  window.setSessionStatus?.('Analyzing shotâ€¦');
  try { videoEl.pause(); } catch {}

  try { ensureOverlayCss?.(); syncOverlayToVideo?.(); } catch {}

  const srcFps  = getFPS();
  const dt      = (1 / srcFps) + 1e-4;  // avoid â€œseeked to the same timeâ€
  const visFps  = Math.max(1, Number(window.FBF_VISUAL_FPS) || 10);
  const buf     = document.createElement('canvas');
  const bctx    = buf.getContext('2d', { willReadFrequently: true });

  let frameIdx  = 0;
  let running   = true;
  const startShots     = (window.shotLog?.length || 0);
  const minFramesPostRel = Math.max(10, Number(window.FBF_MIN_FRAMES) || 28);
  let relAtStart = null;
  const startExitFrame = (window.ballState?.proxExitFrame ?? -1);

  const stopNow = () => { running = false; };
  window.addEventListener('shot:end',     stopNow, { once:true });
  window.addEventListener('shot:summary', stopNow, { once:true });

  while (running) {
    if (videoEl.ended || videoEl.currentTime >= (videoEl.duration || Infinity)) break;

    const tStart = performance.now();

    await stepOnce(videoEl, canvasEl, frameIdx, buf, bctx);
    frameIdx++;

    // Early stop: new shot logged, scorer froze, or exit frame changed
    const relNow = window.ballState?.releaseFrame;
    if (relAtStart == null && Number.isFinite(relNow)) relAtStart = relNow;
    const sinceRel = Number.isFinite(relAtStart) ? (frameIdx - relAtStart) : 0;

    let shouldStop = false;
    if ((window.shotLog?.length || 0) > startShots) shouldStop = true;
    if (window.ballState?.state === 'FROZEN')   shouldStop = true;
    const ex = window.ballState?.proxExitFrame;
    if (Number.isFinite(ex) && ex !== startExitFrame) shouldStop = true;
    if (shouldStop && sinceRel >= minFramesPostRel) break;

    // Advance to next source frame and wait for decode/present
    const nextT = (videoEl.currentTime || 0) + dt;
    try { videoEl.currentTime = Math.min(nextT, (videoEl.duration || nextT)); } catch {}
    await waitForNextDecodedFrame(videoEl);

    // Pacing
    const minStepMs = 1000 / visFps;
    const elapsed   = performance.now() - tStart;
    if (elapsed < minStepMs) {
      await new Promise(r => setTimeout(r, Math.max(0, minStepMs - elapsed)));
    }
  }

  window.__fbfActive = false;
  window.setSessionStatus?.('SESSION IN PROGRESSâ€¦');
  try { videoEl.playbackRate = 1; videoEl.play(); } catch {}
  try { analyzeVideoFrameByFrame?.(videoEl, canvasEl); } catch {}

  window.removeEventListener('shot:end',     stopNow);
  window.removeEventListener('shot:summary', stopNow);
}


  // Start/stop hooks
  window.addEventListener('shot:release', () => {
    // Start FBF for uploads; keep live camera real-time.
    if (window.__SESSION_ACTIVE) return;
    if (window.USE_FBF_DURING_SHOT === false) return;
    // Hard stop for probe release-only mode to avoid freezing the live view
    try { if (window.__RELEASE_ONLY === true) return; } catch {}
    if (window.USE_FBF_DURING_SHOT === false) return;   // allow a global off switch
    // Do not start FBF if the ball is already below the proximity box
    try {
      const H = getLockedHoopBox?.();
      const objs = window.lastDetectedFrame?.objects || [];
      if (H && typeof canonHoop === 'function' && typeof makeProxRectFromCanon === 'function') {
        const Hc = canonHoop(H);
        const prox = makeProxRectFromCanon(Hc);
        const raw = objs.find(o => isBallLabel(o.label) && Array.isArray(o.box));
        if (prox && raw) {
          const [x1,y1,x2,y2] = raw.box; const by = (y1+y2)/2;
          const m = Number(window.FBF_STOP_BELOW_MARGIN || 8);
          if (by > (prox.y + prox.h + m)) { console.log('[fbf] skipped start â€” ball already below prox'); return; }
        }
      }
    } catch {}
    try { if (window.__RELEASE_ONLY === true) return; } catch {}
    runShotFBF();
  });

  // Reset release latch on summary so the next attempt can start FBF
  const _resetRel = () => { try { window.__releaseEventSent = false; } catch {} };
  window.addEventListener('shot:summary', _resetRel);

  window.addEventListener('shot:summary', () => {
    if (window.__cancelFBF) { try { window.__cancelFBF(); } catch {} }
    window.__fbfActive = false;
    const v = getVid(), c = getCan();
    try { if (v) { v.playbackRate = 1; v.play(); } } catch {}
    try { if (v && c) analyzeVideoFrameByFrame?.(v, c); } catch {}

  });
  // Clear per-attempt pose latch debounce on end/summary
  try {
    const _clr = () => { try { const bs = (window.ballState ||= {}); if (bs.__poseLatchAt) delete bs.__poseLatchAt; } catch {} };
    window.addEventListener('shot:end', _clr);
    window.addEventListener('shot:summary', _clr);
  } catch {}

  // Mirror a frozen trail copy for clean overlays (robust even if bs.shots is empty)
  try {
    window.addEventListener('shot:summary', () => {
      try {
        const bs = (window.ballState ||= {});
        if (!Array.isArray(bs.frozenShots)) bs.frozenShots = [];
        try {
          const arc = (window.ballArc && Array.isArray(window.ballArc.trail)) ? window.ballArc.trail : [];
          const last = bs.shots?.at?.(-1);
          const lastTrail = Array.isArray(last?.trail) ? last.trail : [];
          const src = (arc.length >= lastTrail.length) ? arc : lastTrail;
          if (src.length >= 3) bs.frozenShots.push({ trail: src.map(p => ({ x: p.x, y: p.y, frame: p.frame })) });
        } catch {
          const last = bs.shots?.at?.(-1);
          const lastTrail = Array.isArray(last?.trail) ? last.trail : [];
          if (lastTrail.length >= 3) bs.frozenShots.push({ trail: lastTrail.map(p => ({ ...p })) });
        }
        // Trim live trail to the proximity window only (helps keep visuals clean)
        try {
          const H = window.getLockedHoopBox?.();
          if (H && Array.isArray(bs.trail) && bs.trail.length) {
            const enter = bs.proxEnterFrame ?? null;
            const exit  = bs.proxExitFrame ?? null;
            const proxX = Number(window.proxX) || 200;
            const proxYAbove = Number(window.proxYAbove) || 170;
            const proxYBelow = (Number(window.proxYBelow) || 100) + 40;
            const cyTop = H.cy - (H.h || 36)/2;
            const rect = { x: H.cx - proxX, y: cyTop - proxYAbove, w: proxX*2, h: proxYAbove + proxYBelow };
            const inRect = (p) => p && p.x >= rect.x && p.x <= rect.x+rect.w && p.y >= rect.y && p.y <= rect.y+rect.h;
            const fmin = Number.isFinite(enter) ? (enter - 1) : (bs.releaseFrame ?? -Infinity);
            const fmax = Number.isFinite(exit) ? (exit + 5) : (bs.trail.at?.(-1)?.frame ?? Infinity);
            bs.trail = bs.trail.filter(p => (p.frame ?? 0) >= fmin && (p.frame ?? 0) <= fmax && inRect(p));
          }
        } catch {}
      } catch {}
    });
  } catch {}
})();

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ //
//           ----------------  RVFC ----------------               //
// ========= RVFC analyzer (no manual stepping/scrubbing) =========//
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ //

window.legacyAnalyzeVideoFrameByFrame = async function analyzeVideoFrameByFrame(videoEl, canvasEl) {
  if (videoEl && videoEl.srcObject) {
    console.warn('[legacy] live src detected; using PD/RVFC pipeline');
    return;
  }
  // Teardown any previous loop before starting
  if (typeof window.stopFrameAnalysis !== 'function') window.stopFrameAnalysis = () => {};
  window.stopFrameAnalysis();
  window.stopPreDetection?.();

  if (!videoEl || !canvasEl) { console.warn('[analyze] missing video/canvas'); return; }
  if (window.__analyzerActive) { console.log('[analyze] already running'); return; }

  window.__analyzerActive = true;
  const microClipBuffer = ensureMicroClipRingBuffer();
  try { microClipBuffer.clear(); } catch {}
  try {
    const clipWindowMs = Number(window.MICROCLIP_BUFFER_MS);
    if (Number.isFinite(clipWindowMs) && clipWindowMs > 0) microClipBuffer.setWindowMs(clipWindowMs);
  } catch {}
  try {
    const fpsHint = Number(window.__videoFPS);
    if (Number.isFinite(fpsHint) && fpsHint > 0) {
      microClipBuffer.setFps(fpsHint);
    }
  } catch {}
  try { _arcReset?.(); } catch {}

  let analyzing     = true;
  let tickBusy      = false;
  let frameIdx      = 0;
  let rvfcId        = null;
  let lastHandledT  = -1;
  // Trail inactivity watchdog (closes shots even if an end trigger is missed)
  let __trailWatch = { len: 0, lastAt: performance.now() };

  const buf  = document.createElement('canvas');
  const bctx = buf.getContext('2d', { willReadFrequently: true });

  function syncBufferSize() {
    const vw = Number(videoEl.videoWidth)  || canvasEl.width  || buf.width  || 0;
    const vh = Number(videoEl.videoHeight) || canvasEl.height || buf.height || 0;
    if (vw && vh && (buf.width !== vw || buf.height !== vh)) {
      buf.width  = vw;
      buf.height = vh;
    }
  }
  syncBufferSize();

  // Finalize any pending shot at video end
  const onEnded = () => {
    try { finalizeShotIfPending?.('[ended]'); } catch {}
    try {
      if (!window.__lastSummary && Array.isArray(window.shotLog) && window.shotLog.length > 0) {
        window.__lastSummary = window.shotLog[window.shotLog.length - 1];
        console.log('[shot] Summary logged:', window.__lastSummary);
      }
    } catch {}
    window.stopFrameAnalysis();
  };
  try { videoEl.addEventListener('ended', onEnded, { once: true }); } catch {}


  // ---- helpers ----

  // ---- RVFC tick for this video frame ----
  async function onTick(mediaTime) {
    if (!analyzing || tickBusy) return;
    if (videoEl.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;

    const t = (typeof mediaTime === 'number') ? mediaTime : videoEl.currentTime;
    if (t === lastHandledT) return;  // de-dupe identical timestamps
    lastHandledT = t;

    tickBusy = true;
    try {
      // Keep DET buffer in lockstep with overlay (CANVAS size)
      syncBufferSize();
      bctx.drawImage(videoEl, 0, 0, buf.width, buf.height);
      try { microClipBuffer.captureFromCanvas?.(buf, frameIdx, t); } catch {}

      // YOLO + pose in parallel
      const [det, poseRes] = await Promise.all([
        (async () => { try { return await sendFrameToDetect(buf, frameIdx); } catch { return { objects: [] }; } })(),
        (async () => { try { return await poseDetectSerial?.(); } catch { return null; } })()
      ]);
      let objects = det?.objects ?? [];
      const poses   = poseRes?.landmarks || [];

      // Stabilize FIRST, then read hoop + attach TL (CANVAS px)
      stabilizeLockedHoop?.(objects);
      // Ignore hoops/nets far from the locked hoop (reduces cross-court ghosts)
      try { objects = filterObjectsToLockedHoop?.(objects) ?? objects; } catch {}
      const hoopLocked = (typeof window.getLockedHoopBox === 'function' ? window.getLockedHoopBox() : null) || getLockedHoopBox?.();                  // center
      const Hc         = hoopLocked ? canonHoop(hoopLocked) : null;
      const hoopTL     = Hc ? { ...asTopLeft(Hc), anchor: 'topleft' } : null;
      if (hoopTL) attachHoop?.(hoopTL);

      // Choose/update active player + pose (fallback to first pose if picker not present)
      updateActivePlayer?.(objects, frameIdx, canvasEl.width, canvasEl.height);
      let chosen = null;
      try { if (!window.__DISABLE_POSE_PICK) chosen = pickPoseForActive?.(poses, canvasEl, hoopLocked) || null; } catch {}
      let poseMarked = false;
      if (chosen) {
        updatePlayerTracker?.(chosen.scaled, frameIdx);
        playerState.keypoints = chosen.scaled;
        playerState.box = [ chosen.box.x, chosen.box.y, chosen.box.x + chosen.box.w, chosen.box.y + chosen.box.h ];
        markPoseWarmStatus(true);
        poseMarked = true;
      } else if (Array.isArray(poses) && Array.isArray(poses[0]) && poses[0].length >= 33) {
        // Fallback: first pose in result (normalized â†’ scaled inside updatePlayerTracker)
        updatePlayerTracker?.(poses[0], frameIdx);
        markPoseWarmStatus(true);
        poseMarked = true;
      }
      if (!poseMarked) markPoseWarmStatus(false);

      // (release/exit handled after ball update below)

      // Expose current frame
      window.lastDetectedFrame = { __frameIdx: frameIdx, objects, poses };
      bufferDetectedObjects?.(objects);

      // ---- Ball choose + update (VIDEOâ†’CANVAS mapping safe, strong fallback) ----
      // 1) best YOLO ball by area (DET is on buf==canvas, so boxes are CANVAS px)
      const ballDet = (objects || [])
      .filter(o => isBallLabel(o.label) && Array.isArray(o.box))
        .map(o => ({ o, area: Math.max(1, (o.box[2]-o.box[0])*(o.box[3]-o.box[1])) }))
        .sort((a,b)=> b.area - a.area)[0];

      let ballCanvas = null;
      if (ballDet) {
        const [x1,y1,x2,y2] = ballDet.o.box;
        const cx = (x1+x2)/2, cy = (y1+y2)/2; // CANVAS
        // Ghost reject: clamp max leap vs last trail
        const last = window.ballState?.trail?.at?.(-1) || null;
        const maxStep = Number(window.BALL_MAX_STEP || 40) * 1.8;
        if (last) {
          const dist = Math.hypot(cx - last.x, cy - last.y);
          if (dist > maxStep) {
            // Instead of dropping the sample, clamp toward the last point to keep continuity
            const r = maxStep / (dist || 1);
            const clamped = { x: last.x + (cx - last.x) * r, y: last.y + (cy - last.y) * r };
            if (window.DOACH_SHOT_DEBUG) console.log('[rvfc] clamp ghost ball', { dist, maxStep, to: clamped });
            ballCanvas = clamped;
          } else {
            ballCanvas = { x: cx, y: cy };
          }
        } else {
          ballCanvas = { x: cx, y: cy };
        }
      }

      // YOLO blink fallback skipped in live RVFC to avoid DOM ROI work.

      let updatedThisTick = false;

      // Update LIVE trail (always CANVAS; do not gate on hoopLocked)
      if (ballCanvas) {
        try { updateBall?.({ x: ballCanvas.x, y: ballCanvas.y }, frameIdx); updatedThisTick = true; } catch {}
      }

      // Tiny live trail gap fill & keep KF in sync
      if (updatedThisTick && typeof fillRecentGapInPlace === 'function') {
        try { fillRecentGapInPlace(window.ballState); } catch {}
        const last = window.ballState?.trail?.at?.(-1);
        if (last) { try { kalmanPredictAsync?.({ x: last.x, y: last.y }); } catch {} }
      }

      // ---- Shot arc FSM: release + prox enter/exit (centralized)
      try {
        const ballPt = ballCanvas || (window.ballState?.trail?.at?.(-1) || null);
        if (window.DOACH_SHOT_DEBUG) {
          const poseReady = !!(window.playerState?.keypoints?.length >= 33);
          const hasBall  = !!(ballPt && Number.isFinite(ballPt.x));
          console.log('[rvfc:tick] arcTick', { frame: frameIdx, poseReady, hasBall });
        }
        if (hoopLocked && ballPt) {
          // Optional rich trace of pose-release gates
          try {
            if (window.DOACH_RELEASE_TRACE === true) {
              const kps = (playerState && Array.isArray(playerState.keypoints) && playerState.keypoints.length >= 33) ? playerState.keypoints : null;
              const wr = kps ? kps[16] : null;
              const handDist = (wr && Number.isFinite(wr.x) && Number.isFinite(wr.y)) ? Math.hypot((ballPt.x||0)-wr.x, (ballPt.y||0)-wr.y) : null;
              const HcDbg = canonHoop?.(hoopLocked);
              const laneX = HcDbg ? (Math.abs(ballPt.x - HcDbg.cx) <= Math.max(75, HcDbg.w * 0.8)) : null;
              const above  = HcDbg ? (ballPt.y <= (HcDbg.rimTop + Math.max(18, HcDbg.h * 0.3))) : null;
              const buf = (window.__DBG_WRIST_Y ||= []);
              if (wr && Number.isFinite(wr.y)) { buf.push(wr.y); if (buf.length > 6) buf.splice(0, buf.length - 6); }
              const up2 = (buf.length >= 2) ? (buf.at(-1) < buf.at(-2) - 0.8) : false;
              const now = performance.now();
              // Keep a small history for dumpReleaseState()
              try { (window.__releaseTraceHistory ||= []).push({ frame: frameIdx, handDist, laneX, above, wristUp2: up2, th: (window.REL_HAND_DIST_PX||70) }); if (window.__releaseTraceHistory.length > 90) window.__releaseTraceHistory.splice(0, window.__releaseTraceHistory.length - 90); } catch {}
              if (!window.__relDbgLast || (now - window.__relDbgLast) > 180) {
                window.__relDbgLast = now;
                console.log('[release:gates]', { frame: frameIdx, handDist: handDist?.toFixed?.(1), th: (window.REL_HAND_DIST_PX||70), laneX, above, wristUp2: up2, havePose: !!kps });
              }
            }
          } catch {}
          const st = _arcTick?.({ frame: frameIdx, pose: playerState, ballPt, hoopBox: hoopLocked }) || {};
          // Belt & suspenders: if FSM says released but markRelease didnâ€™t latch, latch it
          try {
            const s = (window.ballState ||= {});
            if (st.released && !(Number.isFinite(s.releaseFrame))) {
              if (window.__shotTrackingArmed === true && window.__hoopConfirmed === true) {
                const now = performance.now();
                const cd  = Number(window.REL_COOLDOWN_MS || (window.REL_CFG?.cooldownMs) || 1800);
                const since = now - (Number(window.__REL_LAST_FIRE_MS) || 0);
                if (since >= cd && !window.__releaseEventSent) {
                  const ok = window.safeEmitRelease?.(frameIdx, 'rvfc-backstop') === true;
                  if (ok) { try { window.__REL_LAST_FIRE_MS = now; } catch {} }
                } else {
                  if (window.DOACH_RELEASE_TRACE) console.log('[rvfc-backstop:suppress]', { frame: frameIdx });
                }
              }
            }
          } catch {}

          // Pose-only fallback using unified releaseGate (no ball point)
          try {
            const s = (window.ballState ||= {});
            const kps = (playerState && Array.isArray(playerState.keypoints) && playerState.keypoints.length >= 33) ? playerState.keypoints : null;
            if (!Number.isFinite(s.releaseFrame) && kps) {
              const hist = (window.playerState?.frameHistory || []).slice(-5);
              const gate = (typeof window.releaseGate === 'function') ? window.releaseGate(hist) : { released:false, tests:{} };
              const TH = Number((window.REL_CFG?.scoreThresh) ?? window.REL_SCORE_THRESH);
              const allScore = Number(gate?.tests?.score || 0);
              const allGreen = allScore >= TH - 1e-6;
              if (gate.released && allGreen) {
                if (window.__shotTrackingArmed === true && window.__hoopConfirmed === true) {
                  const now = performance.now();
                  const cd  = Number(window.REL_COOLDOWN_MS || (window.REL_CFG?.cooldownMs) || 1800);
                  const since = now - (Number(window.__REL_LAST_FIRE_MS) || 0);
                  if (since >= cd && !window.__releaseEventSent) {
                    const ok = window.safeEmitRelease?.(frameIdx, 'rvfc-pose-only') === true;
                    if (ok) { try { window.__REL_LAST_FIRE_MS = now; } catch {} }
                  } else {
                    if (window.DOACH_RELEASE_TRACE) console.log('[rvfc-pose-only:suppress]', { frame: frameIdx });
                  }
                }
              }
            }
          } catch {}

          // Additional near-hand fallback: if ball trends upward and is near wrist, latch release
          try {
            const s = (window.ballState ||= {});
            if (!Number.isFinite(s.releaseFrame)) {
              const trail = Array.isArray(s.trail) ? s.trail : [];
              if (trail.length >= 3 && Array.isArray(playerState?.keypoints) && playerState.keypoints.length >= 33) {
                const a = trail[trail.length - 3], b = trail[trail.length - 2], c = trail[trail.length - 1];
                const up = (c.y < b.y - 0.8) && (b.y < a.y - 0.8);
                const kp = playerState.keypoints;
                const wrR = kp[16], wrL = kp[15];
                const dR = (wrR && Number.isFinite(wrR.x) && Number.isFinite(wrR.y)) ? Math.hypot((c.x ?? Infinity) - wrR.x, (c.y ?? Infinity) - wrR.y) : Infinity;
                const dL = (wrL && Number.isFinite(wrL.x) && Number.isFinite(wrL.y)) ? Math.hypot((c.x ?? Infinity) - wrL.x, (c.y ?? Infinity) - wrL.y) : Infinity;
                const d  = Math.min(dR, dL);
                const handOK = d <= (Number(window.REL_HAND_DIST_PX) || 140);
                if (up && handOK) {
                  if (window.__shotTrackingArmed === true && window.__hoopConfirmed === true) {
                    const now = performance.now();
                    const cd  = Number(window.REL_COOLDOWN_MS || (window.REL_CFG?.cooldownMs) || 1800);
                    const since = now - (Number(window.__REL_LAST_FIRE_MS) || 0);
                    if (since >= cd && !window.__releaseEventSent) {
                      const ok = window.safeEmitRelease?.(frameIdx, 'rvfc-near-hand') === true;
                      if (ok) { try { window.__REL_LAST_FIRE_MS = now; } catch {} }
                    } else {
                      if (window.DOACH_RELEASE_TRACE) console.log('[rvfc-near-hand:suppress]', { frame: frameIdx });
                    }
                  }
                }
              }
            }
          } catch {}
        } else if (hoopLocked) {
          // No ball point yet â€” pose-only backstop to latch release (unified gate)
          try {
            const s = (window.ballState ||= {});
            const kps = (playerState && Array.isArray(playerState.keypoints) && playerState.keypoints.length >= 33) ? playerState.keypoints : null;
            if (!Number.isFinite(s.releaseFrame) && kps) {
              const hist = (window.playerState?.frameHistory || []).slice(-5);
              const gate = (typeof window.releaseGate === 'function') ? window.releaseGate(hist) : { released:false, tests:{} };
              const TH = Number((window.REL_CFG?.scoreThresh) ?? window.REL_SCORE_THRESH);
              const allScore = Number(gate?.tests?.score || 0);
              const allGreen = allScore >= TH - 1e-6;
              if (gate.released && allGreen && window.__shotTrackingArmed === true && window.__hoopConfirmed === true) {
                const now = performance.now();
                const cd  = Number(window.REL_COOLDOWN_MS || (window.REL_CFG?.cooldownMs) || 1800);
                const since = now - (Number(window.__REL_LAST_FIRE_MS) || 0);
                if (since >= cd && !window.__releaseEventSent) {
                  const ok = window.safeEmitRelease?.(frameIdx, 'rvfc-pose-only-noball') === true;
                  if (ok) { try { window.__REL_LAST_FIRE_MS = now; } catch {} }
                } else {
                  if (window.DOACH_RELEASE_TRACE) console.log('[rvfc-pose-only-noball:suppress]', { frame: frameIdx });
                }
              }
            }
          } catch {}
        }
      } catch {}


      // ---- Arc stepping centralized ----
      try {
        const lastPt = window.ballState?.trail?.at?.(-1) || null;
        const arcPt  = ballCanvas || lastPt || null;
        if (hoopLocked && arcPt) window.shotArc?.updateArc?.(frameIdx, arcPt, hoopLocked);
      } catch {}

      // Optional net motion for HUD
      try {
        if (hoopTL) {
          ballState.netMoved = (typeof detectNetMotionFromCanvas === 'function'
                                 ? detectNetMotionFromCanvas
                                 : (typeof detectNetMotion === 'function' ? detectNetMotion : null))?.(buf, hoopTL);
          drawNetMotionStatus?.(buf, ballState.netMoved);
        }
      } catch {}

      // Overlays + readiness
      tickReadiness?.(objects, poses);
      updateDebugOverlay?.(poses, objects, frameIdx);
      drawLiveOverlay?.(objects, playerState);
      // Scoring + shot logging in RVFC (live) mode â€” always tick when hoop is locked
      try {
        if (hoopLocked) {
          if (window.USE_MICROCLIP !== true) scoringTick?.(frameIdx);
          if (window.USE_MICROCLIP !== true) checkShotConditions?.(ballState, hoopLocked, frameIdx);
        }
      } catch {}

      // In RVFC mode, avoid scorer/finalization; FBF handles the shot window.
      // FBF starts on 'shot:release' via event listener below.

      frameIdx++;

      // Notify others per frame
      try {
        window.dispatchEvent(new CustomEvent('analyzer:frame-done', {
          detail: { __frameIdx: frameIdx, t }
        }));
      } catch {}
    } catch (err) {
      console.error('[analyze] tick error:', err);
    } finally {
      tickBusy = false;
    }
  }

  // ---- FRAME PUMP (ensures ticks even if autoplay is blocked) ----
  let __framePumpTimer = null;

  /**
   * Call onTick at ~30 fps even if the video is paused, and gently
   * advance currentTime so analyzer makes progress when autoplay is blocked.
   */
  function startFramePump(onTick) {
  if (__framePumpTimer) return; // idempotent

  // Target FPS (supports 29.97 etc). Set window.__videoFPS = 30 in your app/test if you want to force it.
  const TARGET_FPS = Number(window.__videoFPS) > 0 ? Number(window.__videoFPS) : 30;
  try { microClipBuffer.setFps?.(TARGET_FPS); } catch {}
  const STEP_S     = 1 / TARGET_FPS;                         // seconds per frame (e.g., 1/30)
  const INTERVALMS = Math.max(8, Math.round(1000 / TARGET_FPS)); // ~33ms at 30fps

  __framePumpTimer = setInterval(() => {
    try {
      // Always drive a tick, even if paused
      const t = videoEl.currentTime || 0;
      onTick(t);

      // If paused (autoplay blocked), advance exactly one frame (scaled by playbackRate)
      if (videoEl.paused || videoEl.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        const rate = Number.isFinite(videoEl.playbackRate) && videoEl.playbackRate > 0 ? videoEl.playbackRate : 1;
        const dur  = Number.isFinite(videoEl.duration) ? videoEl.duration : Infinity;
        const next = Math.min(t + STEP_S * rate, (dur || 0) - 0.001);
        if (next > t) videoEl.currentTime = next;
      }
    } catch (_) { /* non-fatal */ }
  }, INTERVALMS);
}

// Bootstrap PD when the primary video has metadata
try {
  window.addEventListener('DOMContentLoaded', () => {
    const v = document.getElementById('videoPlayer');
    if (!v) return;
    const onMeta = () => { try { installPreDetectorFor(v); } catch {} };
    v.addEventListener('loadedmetadata', onMeta, { once: true });
    // Also rebind on source change
    v.addEventListener('canplay', () => { try { installPreDetectorFor(v); } catch {} });
  });
} catch {}

function stopFramePump() {
  if (__framePumpTimer) {
    try { clearInterval(__framePumpTimer); } catch {}
    __framePumpTimer = null;
  }
}

  function startRVFC() {
    // Always keep the pump on as a safety net (works whether paused or not)
    if (window.__BG_ONLY === true) startFramePump(onTick);
    if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) {
      console.error('[analyze] RVFC not supported. Using timeupdate + pump.');
      const onTimeUpdate = () => onTick(videoEl.currentTime);
      videoEl.addEventListener('timeupdate', onTimeUpdate);
      window.stopFrameAnalysis = () => {
        analyzing = false;
        stopFramePump();
        videoEl.removeEventListener('timeupdate', onTimeUpdate);
        window.__analyzerActive = false;
      };
      onTick(videoEl.currentTime);
      return;
    }

    const onVideoFrame = (_now, metadata) => {
      if (!analyzing) return;
      onTick(metadata?.mediaTime ?? videoEl.currentTime);
      try { rvfcId = videoEl.requestVideoFrameCallback(onVideoFrame); } catch {}
    };
    rvfcId = videoEl.requestVideoFrameCallback(onVideoFrame);

    window.stopFrameAnalysis = () => {
      analyzing = false;
      stopFramePump();
      if (rvfcId != null) {
        try { videoEl.cancelVideoFrameCallback(rvfcId); } catch {}
        rvfcId = null;
      }
      window.__analyzerActive = false;
    };

    onTick(videoEl.currentTime); // paint immediately
  }

  // Keep overlay buffer sized when the viewport changes
  window.addEventListener('resize', syncBufferSize);
  const detachResize = () => window.removeEventListener('resize', syncBufferSize);

  const prevStop = window.stopFrameAnalysis;
  window.stopFrameAnalysis = function unifiedStop() {
    try { prevStop?.(); } catch {}
    analyzing = false;
    stopFramePump();                // ensure pump turns off
    detachResize();
    try { microClipBuffer.clear(); } catch {}
    window.__analyzerActive = false;
  };

  startRVFC();
};

// Compatibility: expose the analyzer under the historical global name
try {
  if (!window.__analyzerModuleLoaded && typeof window.legacyAnalyzeVideoFrameByFrame === 'function') {
    window.analyzeVideoFrameByFrame = window.legacyAnalyzeVideoFrameByFrame;
  }
} catch {}




// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ //
//              ------------ helpers ----------------              //
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ //

// Build the proximity rect from a center-safe hoop box + UI prefs
function makeProxRectFromCanon(Hc) {
  if (!Hc) return null;
  const proxX      = Number(window.proxX)      || 200;
  const proxYAbove = Number(window.proxYAbove) || 170;
  const proxYBelow = Number(window.proxYBelow) || 100;

  // rimTop: honor if present; else derive from anchor
  const rimTop =
    (Hc.rimTop != null) ? Hc.rimTop :
    (Hc.anchor === 'topleft' && Number.isFinite(Hc.y)) ? Hc.y :
    (Number.isFinite(Hc.cy) && Number.isFinite(Hc.h)) ? (Hc.cy - Hc.h / 2) :
    (Hc.y ?? 0); // last resort

  return {
    x: (Hc.cx ?? Hc.x) - proxX,
    y: rimTop - proxYAbove,
    w: proxX * 2,
    h: proxYAbove + proxYBelow
  };
}

// --- ROI micro-tracker: nudge ball near last point when YOLO misses ---
function refineBallWithROI(ctx, lastPt, win = 18) {
  if (!lastPt || !ctx) return null;
  const x = Math.round(lastPt.x), y = Math.round(lastPt.y);
  const w = ctx.canvas.width, h = ctx.canvas.height;

  const half = Math.max(6, Math.min(win, 40));
  const x1 = Math.max(0, x - half), y1 = Math.max(0, y - half);
  const ww = Math.min(half*2+1, w - x1), hh = Math.min(half*2+1, h - y1);
  if (ww < 3 || hh < 3) return null;

  let best = { score: -1, xx: x, yy: y };
  try {
    const img = ctx.getImageData(x1, y1, ww, hh).data;
    for (let j = 1; j < hh - 1; j++) {
      for (let i = 1; i < ww - 1; i++) {
        const idx = (j * ww + i) * 4;
        const gx = Math.abs(img[idx + 4]      - img[idx - 4]);
        const gy = Math.abs(img[idx + ww*4]   - img[idx - ww*4]);
        const g  = gx + gy;
        if (g > best.score) best = { score: g, xx: x1 + i, yy: y1 + j };
      }
    }
  } catch {}
  return best.score < 1 ? null : { x: best.xx, y: best.yy };
}

// --- Fill a tiny temporal gap between the last two points (â‰¤3 frames) ---
function fillRecentGapInPlace(state) {
  const tr = state?.trail; if (!Array.isArray(tr) || tr.length < 2) return;
  const a = tr[tr.length - 2], b = tr[tr.length - 1];
  const fa = a.frame ?? 0, fb = b.frame ?? (fa + 1);
  const gap = fb - fa;
  if (gap <= 1 || gap > 4) return; // only small holes

  const inserts = [];
  for (let s = 1; s < gap; s++) {
    const t = s / gap;
    inserts.push({
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      frame: fa + s
    });
  }
  // splice in just before 'b'
  tr.splice(tr.length - 1, 0, ...inserts);
}



// 1) only allow play/analyze when the hoop is locked.
//    If not, show the prompt once and refuse.
window.requireHoopOrPrompt = function requireHoopOrPrompt() {
  const locked = !!(typeof getLockedHoopBox === 'function' && getLockedHoopBox());
  if (locked) return true;
  const prompt = document.getElementById('overlayPrompt');
  if (prompt) {
    prompt.textContent = 'ðŸ“ Tap the hoop to begin setup';
    prompt.style.display = 'block';
  }
  return false;
};

// 2) Strong reset for the session (shots + pose + readiness + loops)
window.resetShots = function resetShots() {
  try { window.stopFrameAnalysis?.(); } catch {}
  try { stopPreDetection?.(); } catch {}

  try { resetAll?.(); } catch {}
  try { resetPlayerTracker?.(); } catch {}
  try { resetShotStats?.(); } catch {}

  try { resetReadiness?.('manual reset'); } catch {}
  window.__hoopAutoLocked = false;
  try { window.__REL_LAST_FRAME = null; } catch {}
  disarmRelease('reset');
  scheduleArmWhenReady(400);
};

// 3) Oneâ€‘frame step when paused (nice for slow scrubbing)
  window.stepFrame = function stepFrame(dt = 1 / 30) {
  const v = document.getElementById('videoPlayer');
  if (!v) return;
  v.pause();
  const nextT = Math.min(v.duration || Infinity, (v.currentTime || 0) + dt);
  v.currentTime = nextT;
  // kick analyzer once to render this frame without starting the loop
  try { window.dispatchEvent(new Event('analyzer:step')); } catch {}
};

// 4) Minimal overlay helpers (only define if not already present)
if (typeof window.clientToVideoXY !== 'function') {
  window.clientToVideoXY = function clientToVideoXY(clientX, clientY) {
    const ov = document.getElementById('overlay');
    const V = window.__VIEW;
    if (!ov || !V?.scale) return { x: 0, y: 0 };
    const r = ov.getBoundingClientRect();
    const cssX = clientX - r.left;
    const cssY = clientY - r.top;
    const x = Math.max(0, Math.min(V.vw || 0, Math.round(cssX / V.scale)));
    const y = Math.max(0, Math.min(V.vh || 0, Math.round(cssY / V.scale)));
    return { x, y };
  };

  // Quick state dump for debugging release timing
  window.dumpReleaseState = function dumpReleaseState() {
    const bs = (window.ballState || {});
    const hist = (window.__releaseTraceHistory || []).slice(-10);
    console.log('[release:state]', {
      releaseFrame: bs.releaseFrame,
      proxEnter: bs.proxEnterFrame,
      proxExit: bs.proxExitFrame,
      postExitFrames: bs._postExitFrames,
      state: bs.state,
      traceTail: hist
    });
  };

  // Start a lightweight coach pose sampler (live camera only).
  // Useful for automation/probe when hoop was attached programmatically (bypassing picker flow).
  window.startCoachSamplerQuick = function startCoachSamplerQuick(intervalMs) {
    try { clearInterval(window.__coachPoseInterval); } catch {}
    const v = document.getElementById('videoPlayer');
    if (!v || !v.srcObject) return false;
    // Make sure pose detector is available
    try { if (!window.poseDetector) { /* await safe */ const p = initPoseDetector?.(); if (p && typeof p.then==='function') { p.then(()=>{}).catch(()=>{}); } } } catch {}
    let POSE_MS = Math.max(60, Number(intervalMs || window.COACH_POSE_MS || 120));
    try { if (window.__coachSamplerActive) { console.log('[sampler] coach quick restart', { ms: POSE_MS }); } } catch {}
    window.__coachPoseInterval = setInterval(async () => {
      try {
        if (window.__coachPoseBusy) return;
        window.__coachPoseBusy = true;
        const vlive = document.getElementById('videoPlayer');
        if (!vlive || !vlive.srcObject || !vlive.videoWidth) return;
        let scaled = null;
        const t0 = performance.now();
        const res = await (window.poseDetectSerial?.() || Promise.resolve(null));
        try {
          const raw = res?.landmarks;
          const cand = Array.isArray(raw?.[0]) ? raw[0] : raw;
          if (Array.isArray(cand) && cand.length >= 33 && !cand.some(k => !k || !Number.isFinite(k.x) || !Number.isFinite(k.y))) {
            const looksNorm = cand.every(k=>k && k.x <= 1.01 && k.y <= 1.01);
            const sx = looksNorm ? (vlive.videoWidth||1)  : 1;
            const sy = looksNorm ? (vlive.videoHeight||1) : 1;
            scaled = cand.map(k=>({ ...k, x: k.x * sx, y: k.y * sy }));
          }
        } catch {}
        if (!scaled) {
          try {
            const age = performance.now() - (window.__lastPoseUpdateMs || 0);
            const holdMs = Number(window.__POSE_HOLD_MS || 800);
            if (window.__lastPoseKP && age <= holdMs) scaled = window.__lastPoseKP;
          } catch {}
        }
        if (!scaled || scaled.length < 33) {
          // If we are consistently missing pose, try backing off the interval slightly
          try {
            const dt = performance.now() - t0;
            if (dt > (POSE_MS * 0.9) && POSE_MS < 150) {
              try { clearInterval(window.__coachPoseInterval); } catch {}
              POSE_MS = Math.min(200, Math.max(POSE_MS + 20, Math.round(dt + 20)));
              window.__coachPoseInterval = setInterval(async () => { /* this function body will re-evaluate on next tick */ }, POSE_MS);
              console.log('[sampler] backoff', { ms: POSE_MS, lastDt: Math.round(dt) });
            }
          } catch {}
          return;
        }
        const fps  = Number(window.__videoFPS) || 30;
        let fidx = 0;
        if (window.__RELEASE_ONLY === true) {
          // In release-only mode, ignore analyzer-derived index
          if (Number.isFinite(window.playerState?.lastFrame) && window.playerState.lastFrame >= 0) fidx = window.playerState.lastFrame + 1;
          else fidx = Math.max(0, Math.round((vlive?.currentTime || 0) * fps));
        } else {
          if (Number.isFinite(window.__AN_IDX)) fidx = Number(window.__AN_IDX) + 1;
          else if (Number.isFinite(window.playerState?.lastFrame) && window.playerState.lastFrame >= 0) fidx = window.playerState.lastFrame + 1;
          else fidx = Math.max(0, Math.round((vlive?.currentTime || 0) * fps));
        }
        updatePlayerTracker?.(scaled, fidx);
        // Count a frame for automation harnesses
        try { window.dispatchEvent(new CustomEvent('analyzer:frame-done', { detail: { __frameIdx: fidx } })); } catch {}

        // Mini-scoring window (releaseOnly): after pose latch, keep scorer ticking for a short window
        try {
          const until = Number(window.__TEMP_SCORE_UNTIL || 0);
          if (until && performance.now() < until) {
            const H = window.getLockedHoopBox?.();
            if (H) {
              if (window.USE_MICROCLIP !== true) scoringTick?.(fidx);
              if (window.USE_MICROCLIP !== true) checkShotConditions?.(ballState, H, fidx);
            }
          }
        } catch {}

        // Pose-only latch via pure gate, with streak and reviewable logs
        const H  = window.getLockedHoopBox?.();
        const bs = (window.ballState ||= {});
        const havePose = Array.isArray(window.playerState?.keypoints) && window.playerState.keypoints.length >= 33;
        if (!Number.isFinite(bs.releaseFrame) && havePose) {
          const hist = (window.playerState.frameHistory || []).slice(-5);
          const gate = releaseGate(hist);
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
            window.__LAST_GATE = rec; // expose for overlay debug HUD and HUD score
            if (window.DOACH_RELEASE_TRACE === true) {
              console.log('[gate]', { frame: fidx, ...gate.tests, passed: gate.passed, latched });
            }
            // Visual HUD pulse when score crosses threshold (optional; disabled by default)
            if (window.HUD_LOCAL_PULSE === true) {
              try {
                const sc = Number(gate?.tests?.score || 0);
                const th = Number((window.REL_CFG?.hudScoreTrip) ?? window.REL_HUD_SCORE_TRIP ?? (window.REL_CFG?.scoreThresh) ?? window.REL_SCORE_THRESH ?? 1.0);
                const lastF = Number(window.__SCORE_LAST_FRAME || -1);
                if (window.__shotTrackingArmed === true && sc >= th - 1e-6 && fidx !== lastF) {
                  window.__SCORE_LAST_FRAME = fidx;
                  window.__SCORE_SHOT_COUNT = (window.__SCORE_SHOT_COUNT || 0) + 1;
                  window.__SCORE_FLASH_UNTIL = performance.now() + Math.max(400, Number(window.SCORE_FLASH_MS || 1200));
                  try { window.dispatchEvent(new CustomEvent('hud:score-trip', { detail: { frame: fidx, score: sc } })); } catch {}
                  if (window.DOACH_RELEASE_TRACE === true) console.log('[score:pulse]', { frame: fidx, score: sc, th });
                }
              } catch {}
            }
          } catch {}

          // Prefer unified releaseGate decision; if gate says released and we are armed, allow latch
          if (latched) {
            try { if (window.__shotTrackingArmed !== true) latched = false; } catch {}
            try { if (!H) latched = false; } catch {}
          }
          if (latched) {
            try { window.__GATE_LATCH_FRAME = fidx; } catch {}
            // Global cooldown to avoid double-trigger while follow-through holds
            const now = performance.now();
            const cd  = Number(window.REL_COOLDOWN_MS || (window.REL_CFG?.cooldownMs) || 1800);
            const since = now - (Number(window.__REL_LAST_FIRE_MS) || 0);
            const shouldFire = since >= cd;
            if (H) {
              const prox = (typeof window.proxFromHoop === 'function' && typeof window.canonHoop === 'function')
                            ? window.proxFromHoop(window.canonHoop(H)) : null;
              if (shouldFire && (!window.__releaseEventSent)) {
                const ok = window.safeEmitRelease?.(fidx, 'pose-heuristic', { prox }) === true;
                if (ok) { try { window.__REL_LAST_FIRE_MS = now; } catch {} }
              } else {
                // Optional: allow a one-time cooldown override when lastVia wasn't pose/hud and we are fully all-green
                if (window.ALLOW_COOLDOWN_OVERRIDE === true) {
                  const lastVia = String(window.__REL_LAST_VIA || '');
                  if ((!shouldFire || window.__releaseEventSent) && allGreen && !/(pose|hud)/i.test(lastVia) && !window.__releaseEventSent) {
                    const ok = window.safeEmitRelease?.(fidx, 'pose-heuristic', { prox }) === true;
                    if (ok) { try { window.__REL_LAST_FIRE_MS = now; } catch {} }
                  } else {
                    try { if (window.DOACH_RELEASE_TRACE) console.log('[gate:suppress]', { frame: fidx, reason:'cooldown', remaining: Math.ceil(cd - since) }); } catch {}
                  }
                } else {
                  try { if (window.DOACH_RELEASE_TRACE) console.log('[gate:suppress]', { frame: fidx, reason:'cooldown', remaining: Math.ceil(cd - since) }); } catch {}
                }
              }
            } else {
              // Do not latch releases without a locked hoop
              // This avoids spurious early latches when the user hasn't tapped the hoop yet
              /* no-op when H is not set */
            }
          }
        }
      } catch {}
      finally { window.__coachPoseBusy = false; }
    }, POSE_MS);
    // Kick one immediate sample
    (async () => { try { window.__coachPoseBusy = false; } catch {}; try { /* next tick */ } catch {} })();
    try { window.__coachSamplerActive = true; console.log('[sampler] coach quick started', { ms: POSE_MS }); } catch {}
    return true;
  };
}
if (typeof window.setOverlayInteractive !== 'function') {
  window.setOverlayInteractive = function setOverlayInteractive(on) {
    const ov = document.getElementById('overlay');
    if (!ov) return;
    window.__pickingHoop = !!on;
    ov.style.pointerEvents = on ? 'auto' : 'none';
    ov.style.cursor = on ? 'crosshair' : 'default';
  };
}

// 5) Readiness convenience hooks (tie into your gate)
window.onNewVideoLoaded = () => { try { resetReadiness?.('new video'); } catch {} };
window.onHoopRelocked   = () => { try { resetReadiness?.('hoop changed'); } catch {} };
window.onSeekOrPause    = () => { try { resetReadiness?.('seek/pause'); } catch {} };

// 6) Preâ€‘detect controls (exposed so other modules can start/stop explicitly)
window.startPreDetection = window.startPreDetection || function() {};
window.stopPreDetection  = window.stopPreDetection  || function() {};

// 7) Detect path toggle for quick diagnosis (server vs worker)
//    When true, your sendFrameToDetect should skip worker and POST to /detect_frame.
if (typeof window.__forceServerDetect === 'undefined') {
  window.__forceServerDetect = false;
}

// 8) Realâ€‘time tracking (legacy path) â€“ keep guarded and noâ€‘op unless enabled.
window.useRealTimeTracking = false;
(function attachRealtimePlayHook() {
  const v = document.getElementById('videoPlayer');
  if (!v) return;
  v.addEventListener('play', () => {
    if (window.useRealTimeTracking && typeof window.safeDetectForVideo === 'function') {
      try { window.startTracking?.(); } catch {}
    }
  });
})();



// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Active player selection: instant lock by ball proximity,
// stable keep via IoU, plus a small voting fallback.
// Also exposes a one-click manual picker.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

window.activePlayerBox = null;      // {x,y,w,h,cx,cy}
let _activeLastSeenFrame = -1;

let _voteBox = null;
let _voteCount = 0;

const VOTE_NEED   = Number.isFinite(window.ACTIVE_VOTE_NEED)   ? Number(window.ACTIVE_VOTE_NEED)   : 3;   // frames to confirm when ball isn't clearly "owned"
const KEEP_FRAMES = Number.isFinite(window.ACTIVE_KEEP_FRAMES) ? Number(window.ACTIVE_KEEP_FRAMES) : 45;  // keep lock after last IoU match
const IOU_KEEP    = Number.isFinite(window.ACTIVE_IOU_KEEP)    ? Number(window.ACTIVE_IOU_KEEP)    : 0.35;// keep following if overlap â‰¥ this
const SMOOTH      = Number.isFinite(window.ACTIVE_SMOOTH)      ? Number(window.ACTIVE_SMOOTH)      : 0.75;// EMA smoothing factor when keeping lock

function _toBox(arr4) {
  const [x1,y1,x2,y2] = arr4;
  const w = x2 - x1, h = y2 - y1;
  return { x:x1, y:y1, w, h, cx: x1 + w/2, cy: y1 + h/2 };
}
function _iou(a,b) {
  const ax2=a.x+a.w, ay2=a.y+a.h, bx2=b.x+b.w, by2=b.y+b.h;
  const x1=Math.max(a.x,b.x), y1=Math.max(a.y,b.y);
  const x2=Math.min(ax2,bx2), y2=Math.min(ay2,by2);
  const iw=Math.max(0,x2-x1), ih=Math.max(0,y2-y1);
  const inter=iw*ih, uni=a.w*a.h + b.w*b.h - inter;
  return uni>0 ? inter/uni : 0;
}
function _smooth(prev, next, a=SMOOTH) {
  if (!prev) return next;
  return {
    x: a*prev.x + (1-a)*next.x,
    y: a*prev.y + (1-a)*next.y,
    w: a*prev.w + (1-a)*next.w,
    h: a*prev.h + (1-a)*next.h,
    get cx(){ return this.x + this.w/2; },
    get cy(){ return this.y + this.h/2; },
  };
}
function _ptRectDist(px,py, r) {
  const dx = Math.max(r.x - px, 0, px - (r.x + r.w));
  const dy = Math.max(r.y - py, 0, py - (r.y + r.h));
  return Math.hypot(dx, dy);
}
function _inflate(r, kx, ky) {
  const x = r.x - r.w * kx, y = r.y - r.h * ky;
  const w = r.w * (1 + 2*kx), h = r.h * (1 + 2*ky);
  return { x, y, w, h, cx: x + w/2, cy: y + h/2 };
}

// Ball center: prefer smoothed trail; else current detection
function _ballCenter(objects) {
  const tr = window.ballState?.trail;
  if (Array.isArray(tr) && tr.length) {
    const n = Math.min(5, tr.length);
    let sx=0, sy=0; for (let i=tr.length-n; i<tr.length; i++) { sx+=tr[i].x; sy+=tr[i].y; }
    return { x: sx/n, y: sy/n };
  }
  const ball = (objects||[]).find(o => isBallLabel(o.label) && Array.isArray(o.box));
  if (ball) {
    const [x1,y1,x2,y2] = ball.box;
    return { x:(x1+x2)/2, y:(y1+y2)/2 };
  }
  return null;
}

// Derive recent ball motion vector (unit-ish, in video px) to bias ownership
function _ballMotionHint() {
  const tr = window.ballState?.trail;
  if (!Array.isArray(tr) || tr.length < 3) return null;
  const n = Math.min(5, tr.length);
  const a = tr[tr.length - n], b = tr[tr.length - 1];
  const dx = b.x - a.x, dy = b.y - a.y;
  const mag = Math.hypot(dx, dy) || 1;
  return { dx: dx / mag, dy: dy / mag };
}

/**
 * Choose / keep the active player
 * Strategy:
 *  1) Keep lock by IoU if overlap is decent (smoothed)
 *  2) Instant lock if the ball center lies within an expanded player box
 *  3) If ambiguous, bias toward the nearest player in the ball's motion direction
 *  4) Voting fallback over a few frames to avoid flicker
 */
export function updateActivePlayer(objects, frameIdx) {
  // Dynamic tuning (can be changed at runtime via window.ACTIVE_* knobs)
  const IOU_KEEP_T    = Number.isFinite(window.ACTIVE_IOU_KEEP)    ? Number(window.ACTIVE_IOU_KEEP)    : IOU_KEEP;
  const SMOOTH_T      = Number.isFinite(window.ACTIVE_SMOOTH)      ? Number(window.ACTIVE_SMOOTH)      : SMOOTH;
  const VOTE_NEED_T   = Number.isFinite(window.ACTIVE_VOTE_NEED)   ? Number(window.ACTIVE_VOTE_NEED)   : VOTE_NEED;
  const KEEP_FRAMES_T = Number.isFinite(window.ACTIVE_KEEP_FRAMES) ? Number(window.ACTIVE_KEEP_FRAMES) : KEEP_FRAMES;

  const players = (objects || [])
    .filter(o => (o.label === 'player' || o.label === 'person') && Array.isArray(o.box) && o.box.length === 4)
    .map(o => _toBox(o.box));

  if (!players.length) return;

  const motion = _ballMotionHint();
  const bc = _ballCenter(objects);

  // 1) Try to KEEP the current lock by IoU
  if (window.activePlayerBox) {
    let best = null, bestIoU = -1;
    for (const pb of players) {
      const v = _iou(window.activePlayerBox, pb);
      if (v > bestIoU) { bestIoU = v; best = pb; }
    }
    if (best && bestIoU >= IOU_KEEP_T) {
      window.activePlayerBox = _smooth(window.activePlayerBox, best, SMOOTH_T);
      _activeLastSeenFrame = frameIdx;
      return;
    }
  }

  // 2) Instant â€œpossessionâ€ owner: ball center inside an expanded box
  if (bc) {
    let owner = null, bestD = Infinity;
    const OWN_KX = Number.isFinite(window.ACTIVE_OWN_KX) ? Number(window.ACTIVE_OWN_KX) : 0.35;
    const OWN_KY = Number.isFinite(window.ACTIVE_OWN_KY) ? Number(window.ACTIVE_OWN_KY) : 0.25;
    const OWN_ALLOW = Number.isFinite(window.ACTIVE_OWN_ALLOW) ? Number(window.ACTIVE_OWN_ALLOW) : 0.45;
    for (const p of players) {
      // expand horizontally/vertically to include outstretched arms; scaleâ€‘aware
      const zone = _inflate(p, OWN_KX, OWN_KY);
      // adaptable allowance: wider on closeâ€‘ups, narrower on wide shots
      const allow = Math.max(36, Math.min(160, p.w * OWN_ALLOW));
      const d = _ptRectDist(bc.x, bc.y, zone);
      if (d <= allow && d < bestD) { owner = p; bestD = d; }
    }
    if (owner) {
      window.activePlayerBox = owner;
      _activeLastSeenFrame = frameIdx;
      _voteBox = null; _voteCount = 0;
      return;
    }
  }

  // 3) Grace period: if we had a lock recently, keep it warm a bit before switching
  if (_activeLastSeenFrame > 0 && frameIdx - _activeLastSeenFrame < KEEP_FRAMES_T) {
    // do nothing this frame; wait for clearer evidence
    return;
  }

  // 4) Ambiguous â†’ pick using motionâ€‘biased nearest, else geometric nearest
  let target = null;
  if (bc) {
    // base: nearest by Euclidean
    players.sort((a, b) =>
      ((a.cx - bc.x) ** 2 + (a.cy - bc.y) ** 2) - ((b.cx - bc.x) ** 2 + (b.cy - bc.y) ** 2)
    );
    target = players[0];

    // motion bias: small nudge toward being â€œaheadâ€ in the ball direction
    if (motion) {
      let bestScore = -Infinity, bestP = target;
      for (const p of players.slice(0, Math.min(3, players.length))) {
        const vx = p.cx - bc.x, vy = p.cy - bc.y;
        const proj = (vx * motion.dx + vy * motion.dy); // dot with motion
        const near = -Math.hypot(vx, vy);               // nearer is better
        const score = proj * 0.6 + near * 0.4;
        if (score > bestScore) { bestScore = score; bestP = p; }
      }
      target = bestP;
    }
  } else {
    // no ball? choose largest box to avoid bouncing between spectators
    target = players.slice().sort((a, b) => (b.w * b.h) - (a.w * a.h))[0];
  }

  // 5) Voting fallback (stabilize across a few frames)
  if (_voteBox && _iou(_voteBox, target) > 0.5) {
    _voteBox = _smooth(_voteBox, target, 0.5);
    _voteCount++;
  } else {
    _voteBox = target; _voteCount = 1;
  }
  if (_voteCount >= VOTE_NEED_T) {
    window.activePlayerBox = _voteBox;
    _activeLastSeenFrame = frameIdx;
    _voteBox = null; _voteCount = 0;
  }
}

/**
 * Oneâ€‘click manual shooter pick (arm once â†’ click a player box).
 * Auto-disarms after 6s as a backstop.
 */
export function enablePlayerPickOnce(objects) {
  const ov = document.getElementById('overlay');
  if (!ov) return;
  const boxes = (objects || [])
    .filter(o => (o.label === 'player' || o.label === 'person') && Array.isArray(o.box) && o.box.length === 4)
    .map(o => _toBox(o.box));

  function onClick(e) {
    const r = ov.getBoundingClientRect();
    const x = (e.clientX - r.left) * (ov.width / r.width);
    const y = (e.clientY - r.top)  * (ov.height / r.height);
    const hit = boxes.find(b => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
    if (hit) {
      window.activePlayerBox = hit;
      _activeLastSeenFrame = Number.isFinite(window.__frameIdx) ? window.__frameIdx : 0;
      console.log('ðŸ–±ï¸ Active player set by click:', {
        x: Math.round(hit.x), y: Math.round(hit.y), w: Math.round(hit.w), h: Math.round(hit.h)
      });
    }
    ov.style.pointerEvents = 'none';
    ov.removeEventListener('click', onClick);
  }

  ov.style.pointerEvents = 'auto';
  ov.style.cursor = 'crosshair';
  ov.addEventListener('click', onClick, { once: true });

  setTimeout(() => {
    ov.style.pointerEvents = 'none';
    ov.removeEventListener('click', onClick);
  }, 6000);
}

// cleanup, from all poses, return the one that best matches activePlayerBox (or fallback)
export function pickPoseForActive(poses, canvasEl, hoopBox) {
  if (!Array.isArray(poses) || poses.length === 0 || !canvasEl) return null;

  // --- target space is VIDEO pixels (1:1 with overlay) ---
  const V = window.__VIEW || {};
  const W = V.vw || canvasEl.width;
  const H = V.vh || canvasEl.height;

  // helpers
  const boxFrom = (ls) => {
    const xs = ls.map(k => k.x), ys = ls.map(k => k.y);
    const x1 = Math.min(...xs), y1 = Math.min(...ys);
    const x2 = Math.max(...xs), y2 = Math.max(...ys);
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1, cx: (x1 + x2)/2, cy: (y1 + y2)/2 };
  };
  const iou = (a,b) => {
    const ax2=a.x+a.w, ay2=a.y+a.h, bx2=b.x+b.w, by2=b.y+b.h;
    const x1=Math.max(a.x,b.x), y1=Math.max(a.y,b.y);
    const x2=Math.min(ax2,bx2), y2=Math.min(ay2,by2);
    const iw=Math.max(0,x2-x1), ih=Math.max(0,y2-y1);
    const inter=iw*ih, uni=a.w*a.h + b.w*b.h - inter;
    return uni>0 ? inter/uni : 0;
  };
  const visScore = (ls) => {
    // average of (visibility || score || 1), capped to [0,1]
    let s = 0, n = 0;
    for (const k of ls) {
      const v = (k?.visibility ?? k?.score ?? 1);
      if (Number.isFinite(v)) { s += Math.max(0, Math.min(1, v)); n++; }
    }
    return n ? s / n : 0.5;
  };

  // map each pose to VIDEO pixels if normalized
  const viewItems = poses.map(ls => {
    const looksNormalized = ls.every(k => k && k.x <= 1.01 && k.y <= 1.01);
    const sx = looksNormalized ? W : 1;
    const sy = looksNormalized ? H : 1;
    const scaled = ls.map(k => ({ ...k, x: k.x * sx, y: k.y * sy }));
    const box = boxFrom(scaled);
    return { scaled, box, vscore: visScore(scaled) };
  });

  // 1) Prefer overlap with the active player if present
  const AP = window.activePlayerBox || null;
  if (AP) {
    // score = IoU * 1.0 + center-proximity bonus + tiny visibility weight
    const best = viewItems
      .map(it => {
        const i = iou(AP, it.box);
        const dcx = (it.box.cx - AP.cx), dcy = (it.box.cy - AP.cy);
        const d2 = Math.max(1, dcx*dcx + dcy*dcy);
        const prox = 1 / (1 + Math.sqrt(d2)); // 0..1-ish
        const score = i * 1.0 + prox * 0.3 + it.vscore * 0.05;
        return { it, score };
      })
      .sort((a,b) => b.score - a.score)[0];
    if (best) return best.it;
  }

  // 2) Else use hoop fallback: prefer poses in a vertical lane under/near the rim
  if (hoopBox && Number.isFinite(hoopBox.x) && Number.isFinite(hoopBox.y)) {
    const laneHalf = Math.max(80, (hoopBox.w || 80) * 0.8);
    const laneX1 = hoopBox.x - laneHalf, laneX2 = hoopBox.x + laneHalf;
    const best = viewItems
      .map(it => {
        const insideLane = (it.box.cx >= laneX1 && it.box.cx <= laneX2) ? 1 : 0;
        const dY = Math.abs(it.box.cy - hoopBox.y);
        const dyScore = 1 / (1 + dY); // closer vertically to rim line
        const dx = Math.abs(it.box.cx - hoopBox.x);
        const dxScore = 1 / (1 + dx);
        const score = insideLane * 0.6 + dxScore * 0.25 + dyScore * 0.1 + it.vscore * 0.05;
        return { it, score };
      })
      .sort((a,b)=> b.score - a.score)[0];
    if (best) return best.it;
  }

  // 3) Last resort: largest box (most pixels) with visibility tieâ€‘break
  return viewItems
    .map(it => ({ it, area: it.box.w * it.box.h, v: it.vscore }))
    .sort((a,b) => (b.area - a.area) || (b.v - a.v))[0].it;
}


// End Active Player â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€


// Tiny memory for prediction between YOLO hits
const __ballMem = { x:null, y:null, vx:0, vy:0, area:null, has:false };

// Reset memory each time a shot finishes to avoid drift across shots
window.addEventListener?.('shot:summary', () => {
  __ballMem.x = __ballMem.y = null;
  __ballMem.vx = __ballMem.vy = 0;
  __ballMem.area = null;
  __ballMem.has = false;
});

function centerize(b) {
  if (Number.isFinite(b.x) && Number.isFinite(b.y)) {
    const area = b.area ?? (
      Array.isArray(b.box) && b.box.length === 4 ? Math.max(1, (b.box[2]-b.box[0])*(b.box[3]-b.box[1])) : null
    );
    return { ...b, x: b.x, y: b.y, area };
  }
  if (Array.isArray(b.box) && b.box.length === 4) {
    const [x1, y1, x2, y2] = b.box;
    const x = (x1 + x2) / 2, y = (y1 + y2) / 2;
    const area = Math.max(1, (x2 - x1) * (y2 - y1));
    return { ...b, x, y, area };
  }
  return null;
}

function pickBallCandidate(objects, hoopBox) {
  // 1) Filter to ball-like labels and normalize to centers
  const balls = (objects || []).filter(o => isBallLabel(o.label));
  if (!balls.length) return null;

  const withCenters = balls.map(centerize).filter(Boolean);
  if (!withCenters.length) return null;

  // 2) Context
  const lastTrail = window.ballState?.trail?.at?.(-1) || null;
  const tracking  = !!lastTrail; // we're already tracking a live trail
  const hx = hoopBox ? (hoopBox.cx ?? (hoopBox.x + (hoopBox.w || 0) / 2)) : null;
  const hy = hoopBox ? (hoopBox.cy ?? (hoopBox.y + (hoopBox.h || 0) / 2)) : null;

  // 3) Prediction from memory (latest seen)
  const hasPred = __ballMem.has && Number.isFinite(__ballMem.x) && Number.isFinite(__ballMem.y);
  const px = hasPred ? (__ballMem.x + __ballMem.vx) : null;
  const py = hasPred ? (__ballMem.y + __ballMem.vy) : null;

  // 4) Fast path: if we have a live trail, first try "nearest to last trail"
  //    (stabilizes IDs under dense scenes)
  if (lastTrail) {
    withCenters.sort((a, b) =>
      ((a.x - lastTrail.x) ** 2 + (a.y - lastTrail.y) ** 2) -
      ((b.x - lastTrail.x) ** 2 + (b.y - lastTrail.y) ** 2)
    );
    const nearest = withCenters[0];
    if (nearest) {
      // Update memory (EMA) for smoother velocity
      if (__ballMem.has) {
        const dx = nearest.x - __ballMem.x, dy = nearest.y - __ballMem.y;
        __ballMem.vx = 0.6 * __ballMem.vx + 0.4 * dx;
        __ballMem.vy = 0.6 * __ballMem.vy + 0.4 * dy;
      }
      __ballMem.x = nearest.x; __ballMem.y = nearest.y;
      __ballMem.area = nearest.area ?? __ballMem.area;
      __ballMem.has = true;
      return nearest;
    }
  }

  // 5) Scored selection: prediction, proximity, hoop distance, size stability, velocity alignment, confidence
  let best = null, bestScore = -Infinity;

  for (const c of withCenters) {
    const conf = Number(c.conf ?? c.score ?? 0); // tolerate different detector fields

    // Prediction distance (smaller is better)
    let predScore = 0;
    if (hasPred) {
      const dp = Math.hypot(c.x - px, c.y - py);
      // dynamic tolerance scales with recent speed
      const speed = Math.hypot(__ballMem.vx || 0, __ballMem.vy || 0);
      const tol   = Math.min(200, Math.max(60, 24 + 0.7 * speed)); // px
      predScore   = (tol - Math.min(tol * 2, dp)) / tol; // ~1..-1
    }

    // Proximity zone bonus (most important while arming a shot)
    const inProx = (typeof isBallInProximityZone === 'function') && isBallInProximityZone(c);
    const proxBonus = inProx ? 1 : 0;

    // Hoop distance heuristic (helps before weâ€™re tracking)
    let hoopScore = 0;
    if (hx != null && hy != null) {
      const dh = Math.hypot(c.x - hx, c.y - hy);
      hoopScore = 1 / (1 + dh / 180);
    }

    // Size stability vs memory (avoid jumps when multiple balls)
    let sizeScore = 0;
    if (__ballMem.area && c.area) {
      const ratio = c.area / __ballMem.area;
      const dev = Math.abs(Math.log2(Math.max(1e-3, ratio)));  // 0 â†’ same; 1 â†’ 2x area change
      sizeScore = Math.max(-1, 0.5 - dev); // sameâ‰ˆ0.5, big mismatch negative
    }

    // Velocity alignment: prefer motion consistent with last direction
    let velScore = 0;
    if (__ballMem.has) {
      const ux = (c.x - __ballMem.x), uy = (c.y - __ballMem.y);
      const sp = Math.hypot(__ballMem.vx, __ballMem.vy) || 1;
      const dot = (__ballMem.vx * ux + __ballMem.vy * uy) / (sp * (Math.hypot(ux, uy) || 1));
      velScore = isFinite(dot) ? dot : 0; // -1..+1
    }

    // Weights: tracking phase leans on prediction; arming phase leans on proximity/hoop/conf
    const wPred = tracking ? 0.70 : 0.35;
    const wProx = tracking ? 0.40 : 0.80;
    const wHoop = tracking ? 0.15 : 0.30;
    const wSize = 0.20;
    const wVel  = tracking ? 0.30 : 0.10;
    const wConf = 0.20;

    const score =
      (hasPred ? predScore * wPred : 0) +
      (proxBonus * wProx) +
      (hoopScore * wHoop) +
      (sizeScore * wSize) +
      (velScore  * wVel)  +
      (conf      * wConf);

    if (score > bestScore) { bestScore = score; best = c; }
  }

  // 6) Fallbacks if tied/weak: proximity â†’ hoop closeness â†’ confidence
  if (!best) {
    const inProx = withCenters.filter(p => isBallInProximityZone?.(p));
    if (inProx.length) {
      inProx.sort((a,b) => (b.conf ?? 0) - (a.conf ?? 0));
      best = inProx[0];
    } else if (hx != null && hy != null) {
      withCenters.sort((a,b) =>
        ((a.x - hx) ** 2 + (a.y - hy) ** 2) - ((b.x - hx) ** 2 + (b.y - hy) ** 2)
      );
      best = withCenters[0];
    } else {
      withCenters.sort((a,b) => (b.conf ?? 0) - (a.conf ?? 0));
      best = withCenters[0];
    }
  }

  // 7) Update memory for the next frame (EMA on velocity)
  if (best) {
    if (__ballMem.has) {
      const dx = best.x - __ballMem.x, dy = best.y - __ballMem.y;
      __ballMem.vx = 0.6 * __ballMem.vx + 0.4 * dx;
      __ballMem.vy = 0.6 * __ballMem.vy + 0.4 * dy;
    }
    __ballMem.x = best.x; __ballMem.y = best.y;
    __ballMem.area = best.area ?? __ballMem.area;
    __ballMem.has = true;
  }

  return best || null;
}


// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Pose init on data-ready (safe element lookup)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
(function poseInitOnce(){
  function armOnce() {
    const v = document.getElementById('videoPlayer');
    if (!v) return;
    v.addEventListener('loadeddata', async () => {
      try {
        if (!window.poseDetector) {
          await initPoseDetector(); // loads MediaPipe + model once
        }
        if (typeof window.safeDetectForVideo === 'function') {
          console.log('âœ… Pose detector ready â€” awaiting hoop selectionâ€¦');
        } else {
          console.warn('âš ï¸ Pose detector wrapper (safeDetectForVideo) not found.');
        }
      } catch (err) {
        console.error('âŒ Failed to initialize PoseLandmarker:', err);
      }
    }, { once: true });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', armOnce, { once: true });
  } else {
    armOnce();
  }
})();



// Switch to live camera.
// - stops any previous MediaStream tracks
// - resets session + readiness
// - waits for metadata, then syncs overlay + prewarms + optional pre-detect
// now calls to startCamera... 
  window.useCamera = async () => {
    const ok = await startCamera();
    if (!ok) return;

  const v = document.getElementById('videoPlayer');
  if (!v?.srcObject || !v.videoWidth) { console.warn('[analyze] camera not ready'); return; }

  // Arm picker nowâ€”the overlay is already clickable because startCamera set __pickingHoop=true
  try { enableHoopPickOnce(); } catch {}
  // Foreground coach plane (live): force 1x and mount HUD/status
  try {
    window.__SESSION_ACTIVE = true;
    window.USE_FBF_DURING_SHOT = false;
    window.DISABLE_SLOWMO = true;
    window.SLOW_RATE = 1;
    try { v.defaultPlaybackRate = 1; v.playbackRate = 1; } catch {}
    const fn = (localStorage.getItem('firstname') || 'player');
    window.showCenterPrompt?.('Hi ' + fn + ', tap the hoop to begin');
    window.__sessionStart = window.__sessionStart || Date.now();
    window.setOverlayMode?.('coach');
    // Live: make BG sampler the sole pose owner; analyzer will skip pose
    try { window.__FORCE_POSE_BG = true; window.__DISABLE_POSE_PICK = true; } catch {}
    window.mountSessionHUD?.();
    window.setSessionStatus?.('SESSION IN PROGRESS');
    window.startBgSampler?.();
  } catch {}
  }

// Prefer the unified reset we defined earlier; keep a thin alias here if needed
window.resetShots = window.resetShots || function () {
  try { window.stopFrameAnalysis?.(); } catch {}
  try { stopPreDetection?.(); } catch {}

  try { resetAll?.(); } catch {}
  try { resetPlayerTracker?.(); } catch {}
  try { resetShotStats?.(); } catch {}

  try { resetReadiness?.('manual reset'); } catch {}
  window.__hoopAutoLocked = false;
  disarmRelease('reset');
  scheduleArmWhenReady(400);

  // optional UI cleanups if present
  const table = document.querySelector('#shotTable tbody');
  if (table) table.innerHTML = '';
  const details = document.getElementById('shotDetails');
  if (details) details.textContent = 'No shot data loaded.';
};


// -------------------------- Background Sampler (~10 fps, ROI) --------------------------- //
(function installBgSampler(){
  if (window.__bgSamplerInstalled) return; window.__bgSamplerInstalled = true;

  function getVideo(){ return document.getElementById('videoPlayer') || document.querySelector('video'); }

  async function detectWithROI_BG(buf, frameIdx){
    try {
      const H = (typeof window.getLockedHoopBox === 'function') ? window.getLockedHoopBox() : null;
      if (!H) return await sendFrameToDetect(buf, frameIdx).catch(() => ({ objects: [] }));
      const Hc = canonHoop(H);
      const scale = Number(window.ROI_SUPERSAMPLE || 1.6);
      const expW = Math.max(1, Math.round((Hc?.w || 100) * scale));
      const expH = Math.max(1, Math.round((Hc?.h || 80) * scale * 1.8));
      const cx = Hc.cx, cy = Hc.cy;
      const x0 = Math.max(0, Math.round(cx - expW/2));
      const y0 = Math.max(0, Math.round(cy - expH*0.45));
      const x1 = Math.round(cx + expW/2);
      const y1 = Math.round(cy + expH*0.55);
      const x = Math.max(0, x0), y = Math.max(0, y0);
      const w = Math.max(1, Math.min(buf.width  - x, x1 - x0));
      const h = Math.max(1, Math.min(buf.height - y, y1 - y0));
      let roiCanvas;
      if (typeof OffscreenCanvas !== 'undefined') {
        roiCanvas = new OffscreenCanvas(w, h);
      } else {
        roiCanvas = document.createElement('canvas');
        roiCanvas.width = w;
        roiCanvas.height = h;
      }
      const rctx = roiCanvas.getContext('2d', { willReadFrequently: true });
      rctx.drawImage(buf, x, y, w, h, 0, 0, w, h);
      const det = await sendFrameToDetect(roiCanvas, frameIdx).catch(() => ({ objects: [] }));
      const objs = (det?.objects || []).map(o => Array.isArray(o.box) ? { ...o, box: [o.box[0]+x, o.box[1]+y, o.box[2]+x, o.box[3]+y] } : o);
      return { ...(det||{}), objects: objs };
    } catch { return await sendFrameToDetect(buf, frameIdx).catch(() => ({ objects: [] })); }
  }

  window.startBgSampler = function startBgSampler(opts={}){
    if (window.__BG_LOOP_ON) return true;
    window.__BG_LOOP_ON = true; window.__bgReleased = false;
    const FPS = Number(opts.fps || window.__BG_FPS || 10);
    const IV  = Math.max(60, Math.round(1000 / FPS));
    let frame = 0; let timer = null;

    async function tick(){
      if (!window.__BG_LOOP_ON) return;
      try {
        const v = getVideo(); if (!v?.videoWidth) { return schedule(); }
        const buf = document.createElement('canvas'); buf.width = v.videoWidth; buf.height = v.videoHeight;
        const bctx = buf.getContext('2d', { willReadFrequently: true }); bctx.drawImage(v, 0, 0, buf.width, buf.height);
        const fps  = Number(window.__videoFPS) || 30;
        const fidx = Math.max(0, Math.round((v?.currentTime || 0) * fps));

        const det = await detectWithROI_BG(buf, frame).catch(() => ({ objects: [] }));
        let objects = det?.objects || [];
        try { stabilizeLockedHoop?.(objects); } catch {}

        const ball = (objects||[])
          .filter(o => isBallLabel(o.label) && Array.isArray(o.box))
          .map(o => ({ o, area: Math.max(1, (o.box[2]-o.box[0])*(o.box[3]-o.box[1])) }))
          .sort((a,b)=> b.area - a.area)[0];
        if (ball) { const [x1,y1,x2,y2] = ball.o.box; const cx=(x1+x2)/2, cy=(y1+y2)/2; try { updateBall?.({ x: cx, y: cy }, fidx); } catch {} }

        let poses = [];
        try {
          const now = performance.now();
          const staleMs = now - (window.__lastAnalyzerDrawAt || 0);
          // Sample pose in BG when analyzer is stale or not running
          if (window.__SESSION_ACTIVE || window.__FORCE_POSE_BG || staleMs > 220 || !window.__analyzerActive) {
            const poseRes = await (async()=>{ try { return await poseDetectSerial?.(); } catch { return null; } })();
            const raw = poseRes?.landmarks || [];
            if (Array.isArray(raw) && raw.length >= 33) {
              const vW = v.videoWidth  || 1;
              const vH = v.videoHeight || 1;
              const looksNorm = raw.every(k => k && k.x <= 1.01 && k.y <= 1.01);
              poses = looksNorm ? raw.map(k => ({ ...k, x: k.x * vW, y: k.y * vH })) : raw;
            } else {
              poses = [];
            }
          }
        } catch {}

        // Keep playerState fresh so the pose skeleton updates even when the main
        // analyzer hasnâ€™t started yet or RVFC stalls on some devices.
        try {
          if (Array.isArray(poses) && poses.length >= 33) {
          // choose a target pose + gate for believability before writing
          const v = document.getElementById('videoPlayer');
          const off = document.createElement('canvas'); off.width = v.videoWidth||640; off.height = v.videoHeight||360;
          const chosen = (typeof pickPoseForActive === 'function')
            ? pickPoseForActive([poses], off, getLockedHoopBox?.())
            : { scaled: poses };
          if (chosen && Array.isArray(chosen.scaled) && isPoseBelievable(chosen.scaled, objects, off)) {
            try { updatePlayerTracker?.(chosen.scaled, fidx); window.playerState._believable = true; }
            catch { updatePlayerTracker?.(chosen.scaled, frame); window.playerState._believable = true; }
          } else {
            try { window.playerState._believable = false; } catch {}
          }
        }
        } catch {}

        const hoop = (typeof window.getLockedHoopBox === 'function') ? window.getLockedHoopBox() : null;
        const lastPt = window.ballState?.trail?.at?.(-1) || null;
        try {
          if (hoop && lastPt) {
            const st = _arcTick?.({ frame: fidx, pose: playerState, ballPt: lastPt, hoopBox: hoop }) || {};
            if (st.released && !window.__bgReleased) {
              if (window.POSE_FIRST_ONLY === true) { /* skip bg-fsm latch in pose-first mode */ }
              else {
              window.__bgReleased = true;
              // Latch release if not already
              try {
                const s = (window.ballState ||= {});
                if (!Number.isFinite(s.releaseFrame)) {
                  window.safeEmitRelease?.(fidx, 'bg-fsm');
                }
              } catch {}
              window.dispatchEvent(new CustomEvent('bg:shot:release', { detail: { frame: fidx, tMs: performance.now() } }));
              }
            }
          }
        } catch {}

        try {
          const hasTrail = (window.ballState?.trail?.length || 0) > 0;
          if (window.USE_MICROCLIP !== true && hoop && hasTrail) { scoringTick?.(fidx); checkShotConditions?.(window.ballState, hoop, fidx); }
        } catch {}

        // Fallback draw in live sessions if analyzer is stale or not active
        try {
          const now = performance.now();
          const staleMs = now - (window.__lastAnalyzerDrawAt || 0);
          const live = !!(v && v.srcObject);
          if (live && (staleMs > 350 || !window.__analyzerActive)) {
            try { ensureOverlayCss?.(); syncOverlayToVideo?.(); } catch {}
            const first = (Array.isArray(poses) && Array.isArray(poses[0]) && poses[0].length >= 33) ? poses[0] : null;
            if (!first) {
              markPoseWarmStatus(false);
              // keep last keypoints if current is empty to avoid blinking
            } else {
              try {
                const fps = Number(window.__videoFPS) || 30;
                const fidx = Math.max(0, Math.round((v?.currentTime || 0) * fps));
                updatePlayerTracker?.(first, fidx);
              } catch { updatePlayerTracker?.(first, frame); }
              markPoseWarmStatus(true);
            }
            drawLiveOverlay?.(objects, window.playerState);
          }
        } catch {}

        // Publish lightweight frame so overlays/HUD have current data
        try {
          window.lastDetectedFrame = { __frameIdx: fidx, objects, poses };
        } catch {}

        // Draw overlay in live sessions when the main analyzer isnâ€™t active yet
        try {
          if (!window.__analyzerActive) drawLiveOverlay?.(objects, window.playerState);
        } catch {}

      } finally { frame++; schedule(); }
    }

    function schedule(){ timer = setTimeout(tick, IV); }
    window.__BG_STOP = () => { try { clearTimeout(timer); } catch {} window.__BG_LOOP_ON = false; window.__bgReleased = false; };
    schedule();
    return true;
  };

  window.stopBgSampler = function stopBgSampler(){ try { window.__BG_STOP?.(); } catch {} delete window.__BG_STOP; };

  try {
    if (!window.__bgSummaryBridge) {
      window.__bgSummaryBridge = true;
      // Reset the one-shot release latch after each attempt so next one can fire
      try {
        window.addEventListener('shot:end',     () => { try { window.__bgReleased = false; } catch {} }, { passive: true });
        window.addEventListener('shot:summary', () => { try { window.__bgReleased = false; } catch {} }, { passive: true });
      } catch {}
      window.addEventListener('shot:summary', (e) => {
        if (!window.__BG_LOOP_ON) return;
        try { window.dispatchEvent(new CustomEvent('bg:shot:summary', { detail: e?.detail || null })); } catch {}
      });
    }
  } catch {}
})();
// --- Rock-solid slow-mo controller (release â†’ slow, summary â†’ 1x) ---
// Slow-mo shim removed for live coach plane; playback remains 1x.

// ---------- Live analyzer keepalive + overlay safety ----------
(function installLiveKeepalive(){
  try {
    if (!window.__liveKeepaliveInstalled) {
      window.__liveKeepaliveInstalled = true;
      window.__lastAnalyzerDrawAt = 0;
      window.addEventListener('analyzer:frame-done', () => { try { window.__lastAnalyzerDrawAt = performance.now(); } catch {} });

      // If analyzer stops for any reason during live camera, restart it.
      setInterval(() => {
        try {
          const v = document.getElementById('videoPlayer');
          if (!v) return;
          const live = !!v.srcObject;
          if (!live || !window.__SESSION_ACTIVE) return;
          if (!window.__analyzerActive) {
            if (typeof window.startFrameAnalysis === 'function') window.startFrameAnalysis();
          }
        } catch {}
      }, 900);

      // Lightweight coach repaint loop during live sessions (always on while __SESSION_ACTIVE)
      (function coachPaintLoop(){
        try {
          const v = document.getElementById('videoPlayer');
          if (v && window.__SESSION_ACTIVE) {
            const last = window.lastDetectedFrame || { objects: [] };
            ensureOverlayCss?.();
            syncOverlayToVideo?.();
            drawLiveOverlay?.((last.objects || []), window.playerState);
          }
        } catch {}
        window.__coachPaintRaf = requestAnimationFrame(coachPaintLoop);
      })();

      // Stop the repaint loop when session deactivates
      window.addEventListener('shot:summary', () => {
        try { if (!window.__SESSION_ACTIVE) cancelAnimationFrame(window.__coachPaintRaf); } catch {}
      });
      window.addEventListener('hud:end-session', () => { try { cancelAnimationFrame(window.__coachPaintRaf); } catch {} });
    }
  } catch {}
})();
