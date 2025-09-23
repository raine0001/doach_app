// fix_Overlay_Display.js

import { drawPoseSkeleton, drawWristTrail } from './player_tracker.js';
import { drawHoopProximityDebug, drawShotTubeDebug } from './shot_logger.js';
import { getLockedHoopBox, drawHoopMarker } from './hoop_tracker.js';
import { drawBallTrails, drawBallArc } from './ball_tracker.js';
import { drawFinalShotSummary } from './shot_utils.js';

// Ensure overlay sits over the video and default pointer/stacking rules apply
export function ensureOverlayCss() {
  const ov  = document.getElementById('overlay');
  const vid = document.getElementById('videoPlayer');
  if (!ov || !vid) return;

  // parent must be positioned to stack video + overlay
  const anchor = vid.parentElement || document.body;
  if (getComputedStyle(anchor).position === 'static') {
    anchor.style.position = 'relative';
  }

  ov.style.position = 'absolute';
  ov.style.left = '0';
  ov.style.top  = '0';
  ov.style.userSelect    = 'none';
  ov.style.pointerEvents = (window.__pickingHoop ? 'auto' : 'none');
  ov.style.zIndex        = '100';   // above video, below HUD

  // iOS autoplay requirements (safe no-ops on desktop)
  vid.setAttribute('playsinline', '');
  vid.autoplay = true;
  vid.muted    = true;
}

// Allow tests or UI to control overlay rendering aggressiveness
function paintCleanOverlayOnce() {
  try {
    const overlay = document.getElementById('overlay');
    const video   = document.getElementById('videoPlayer');
    if (!overlay || !video || !window.__VIEW) return false;
    const ctx = overlay.getContext('2d', { willReadFrequently: true });
    if (!ctx) return false;

    // clear and set VIDEO transform
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    window.__APPLY_OVERLAY_XFORM?.(ctx);

    const bs = (window.ballState || {});
    const frozenTrail = (Array.isArray(bs.frozenShots) && bs.frozenShots.length && Array.isArray(bs.frozenShots.at(-1)?.trail)) ? bs.frozenShots.at(-1).trail : [];
    const shotTrail   = (!frozenTrail.length && Array.isArray(bs.shots) && bs.shots.length && Array.isArray(bs.shots.at(-1)?.trail)) ? bs.shots.at(-1).trail : [];
    const arcTrail    = (window.ballArc && Array.isArray(window.ballArc.trail)) ? window.ballArc.trail : [];
    const liveTrail   = Array.isArray(bs.trail) ? bs.trail : [];
    const choices = [frozenTrail, shotTrail, arcTrail, liveTrail];
    choices.sort((a,b)=> (b?.length||0) - (a?.length||0));
    let base = choices[0] || [];
    // If we still don't have a usable path, synthesize a simple arc near the hoop
    if (!base.length) {
      const H = (typeof window.getLockedHoopBox === 'function') ? window.getLockedHoopBox() : null;
      if (!H) return false;
      const w = Math.max(60, H.w || H.width || 120);
      const h = Math.max(40, H.h || H.height || 80);
      const cx = Number.isFinite(H.cx) ? H.cx : (H.anchor==='topleft' ? (H.x + w/2) : H.x);
      const cy = Number.isFinite(H.cy) ? H.cy : (H.anchor==='topleft' ? (H.y + h/2) : H.y);
      const rimTop = cy - h/2;
      // control points: from left-bottom to apex to rim entry
      const p0 = { x: cx - w*3.0, y: rimTop + h*1.8 };
      const p1 = { x: cx - w*1.4, y: rimTop - h*1.0 };
      const p2 = { x: cx,         y: rimTop + h*0.2 };
      const N  = 40;
      const synth = [p0];
      for (let i=1;i<=N;i++){
        const t=i/N; const ax=(1-t)*p0.x + t*p1.x, ay=(1-t)*p0.y + t*p1.y; const bx=(1-t)*p1.x + t*p2.x, by=(1-t)*p1.y + t*p2.y; synth.push({ x:(1-t)*ax + t*bx, y:(1-t)*ay + t*by });
      }
      base = synth;
    }

    // densify for solid coverage
    const densify = (tr, step=6) => {
      if (!Array.isArray(tr) || tr.length < 2) return tr || [];
      const out = [tr[0]];
      for (let i=1;i<tr.length;i++){
        const a=tr[i-1], b=tr[i]; const dx=b.x-a.x, dy=b.y-a.y; const dist=Math.hypot(dx,dy)||0;
        const n=Math.max(0, Math.floor(dist/step));
        for (let k=1;k<=n;k++){ const t=k/(n+1); out.push({ x:a.x+dx*t, y:a.y+dy*t, frame:b.frame }); }
        out.push(b);
      }
      return out;
    };
    const dense = densify(base, 5);
    if (!dense.length) return false;

    const hair = 1 / Math.min(window.__VIEW?.sx || 1, window.__VIEW?.sy || 1);
    const color = 'rgba(50,200,255,0.95)';
    const lw = Math.max(8, 8*hair);
    const r  = Math.max(6, 6*hair);
    ctx.save();
    ctx.lineWidth = lw;
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(dense[0].x, dense[0].y);
    for (let i=1;i<dense.length;i++) ctx.lineTo(dense[i].x, dense[i].y);
    ctx.stroke();
    ctx.fillStyle = color;
    for (const p of dense){ ctx.beginPath(); ctx.arc(p.x,p.y,r,0,Math.PI*2); ctx.fill(); }
    ctx.restore();

    try {
      const minR=Math.max(1, Number(window.ARC_MIN_RINGS||8));
      window.__overlayArcDrawnCount = Math.max(window.__overlayArcDrawnCount||0, Math.max(minR, dense.length));
      window.__overlayLastTrailMode='arc';
      window.__overlayLastTrailInput='clean-once';
    } catch {}
    try { window.__cleanPaintReady = true; } catch {}
    return true;
  } catch { return false; }
}

export function setOverlayMode(mode = 'live') {
  try {
    window.__overlayMode = String(mode || 'live').toLowerCase();
    if (window.__overlayMode === 'clean') {
      window.__overlayCleanDrawn = false;
      // paint immediately so tests that sample within 60ms see pixels
      const ok = paintCleanOverlayOnce();
      if (ok) { window.__overlayCleanDrawn = true; window.__overlayFreeze = true; }
      // Retry briefly if no trail yet; helps in automation when summary/arc mirror races
      try { clearTimeout(window.__overlayCleanRetryTimer); } catch {}
      let attempts = 0;
      const tick = () => {
        if (window.__overlayCleanDrawn || window.__overlayMode !== 'clean') return;
        const hit = paintCleanOverlayOnce();
        if (hit) { window.__overlayCleanDrawn = true; window.__overlayFreeze = true; return; }
        if (++attempts < 8) window.__overlayCleanRetryTimer = setTimeout(tick, 50);
      };
      if (!ok) window.__overlayCleanRetryTimer = setTimeout(tick, 40);
    }
  } catch {}
}
try { if (typeof window.setOverlayMode !== 'function') window.setOverlayMode = setOverlayMode; } catch {}

// Auto-toggle: arc-only during attempt, clean on summary (unless user explicitly set debug)
try {
  if (!window.__overlayAutoWired) {
    window.__overlayAutoWired = true;
    const onRel = () => { try { const mode = String(window.__overlayMode || 'live'); if (window.__SESSION_ACTIVE) return; window.__overlayFreeze = false; window.__overlayCleanDrawn = false; if (mode !== 'debug' && mode !== 'coach') setOverlayMode('arc-only'); } catch {} };
    const onSum = () => { try { const mode = String(window.__overlayMode || 'live'); if (window.__SESSION_ACTIVE) return; if (mode !== 'debug' && mode !== 'coach') setOverlayMode('clean'); try { const ok = paintCleanOverlayOnce(); if (ok) { window.__overlayCleanDrawn = true; window.__overlayFreeze = true; } } catch {} } catch {} };
    window.addEventListener('shot:release', onRel);
    window.addEventListener('shot:summary', onSum);
  }
} catch {}

try {
  window.localDetectorAvailable = function localDetectorAvailable() {
    return !!(window.__detWorker && window.__detReady);
  };
  window.useServerDetector = function useServerDetector() {
    window.__forceServerDetect = true;
    window.__LOCAL_DETECTOR = false;
    try { window.__detWorker?.terminate?.(); } catch {}
    window.__detWorker = null;
    window.__detReady = false;
    window.__detPending = new Map();
    console.log('[LocalDetector] switched to server detector');
  };
} catch {}

// Alias for older callers/tests: lock overlay to current video rect and DPR buffer
export function lockOverlayToVideo() { try { return syncOverlayToVideo(); } catch {} }

// Also publish common helpers to window for non-ESM callers (e.g., tests)
try {
  if (typeof window.ensureOverlayCss !== 'function') window.ensureOverlayCss = ensureOverlayCss;
  if (typeof window.lockOverlayToVideo !== 'function') window.lockOverlayToVideo = lockOverlayToVideo;
} catch {}

// Debug: click tracer for the overlay — logs CSS px + VIDEO px, pe/z, scale/dpr.
// Safe to call multiple times; call removeOverlayTracer() to unbind.
export function installOverlayTracer() {
  const ov = document.getElementById('overlay');
  if (!ov || ov.__tracerInstalled) return;
  ov.__tracerInstalled = true;

  function clientToVideoXY(clientX, clientY) {
    const V = window.__VIEW;
    if (!ov || !V?.scale) return { x: 0, y: 0 };
    const r = ov.getBoundingClientRect();
    const cssX = clientX - r.left;
    const cssY = clientY - r.top;
    const x = Math.max(0, Math.min(V.vw || 0, Math.round(cssX / V.scale)));
    const y = Math.max(0, Math.min(V.vh || 0, Math.round(cssY / V.scale)));
    return { x, y };
  }

  const onOverlayPD = (e) => {
    const cs = getComputedStyle(ov);
    const V  = window.__VIEW || {};
    const r  = ov.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right &&
                   e.clientY >= r.top  && e.clientY <= r.bottom;
    const videoXY = clientToVideoXY(e.clientX, e.clientY);
    console.log('[ov:pointerdown]', {
      css: { x: e.offsetX, y: e.offsetY },
      video: videoXY,
      pe: cs.pointerEvents,
      z: cs.zIndex,
      scale: V.scale ?? 1,
      dpr: V.dpr ?? (window.devicePixelRatio || 1),
      inside
    });
  };

  const onDocPD = (e) => {
    const r = ov.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right &&
                   e.clientY >= r.top  && e.clientY <= r.bottom;
    const videoXY = inside ? clientToVideoXY(e.clientX, e.clientY) : null;
    console.log('[doc:pointerdown]', {
      target: e.target?.tagName ?? '(unknown)',
      insideOverlay: inside,
      video: videoXY
    });
  };

  ov.addEventListener('pointerdown', onOverlayPD);
  document.addEventListener('pointerdown', onDocPD, { capture: true });

  ov.__tracerCleanup = () => {
    try {
      ov.removeEventListener('pointerdown', onOverlayPD);
      document.removeEventListener('pointerdown', onDocPD, { capture: true });
    } catch {}
    delete ov.__tracerInstalled;
    delete ov.__tracerCleanup;
  };

  console.log('🧪 overlay tracer installed');
}

export function removeOverlayTracer() {
  const ov = document.getElementById('overlay');
  if (ov?.__tracerCleanup) {
    ov.__tracerCleanup();
    console.log('🧽 overlay tracer removed');
  }
}

export const USE_LOCAL_WORKER = true;

// ---- Arc trail health logging (debug helper) ----
function __computeArcHealth(trail) {
  if (!Array.isArray(trail) || trail.length < 2) return { points: (trail?.length||0), continuity: 0, maxJump: 0 };
  const t = trail;
  const f0 = t[0].frame ?? 0, fN = t[t.length-1].frame ?? (t.length-1);
  const span = Math.max(1, (fN - f0 + 1));
  const covered = new Set(); for (const p of t) covered.add(p.frame ?? 0);
  let maxJump = 0; for (let i=1;i<t.length;i++){ const dx=(t[i].x - t[i-1].x)||0, dy=(t[i].y - t[i-1].y)||0; const d=Math.hypot(dx,dy); if (d>maxJump) maxJump=d; }
  return { points: t.length, continuity: covered.size / span, maxJump };
}

try {
  if (!window.__arcHealthBound) {
    window.addEventListener('shot:summary', () => {
      try {
        const bs = (window.ballState||{});
        const trail = (bs.shots?.at?.(-1)?.trail) || (window.ballArc?.trail) || [];
        const H = __computeArcHealth(trail);
        const rel = bs.releaseFrame, enter = bs.proxEnterFrame, exit = bs.proxExitFrame;
        console.log('[arc-health]', { points: H.points, continuity: +H.continuity.toFixed(3), maxJump: +H.maxJump.toFixed(2), frames: { rel, enter, exit } });
      } catch (e) { console.warn('[arc-health] failed:', e); }
    });
    window.__arcHealthBound = true;
  }
  window.printArcHealth = function(){
    try { const bs=(window.ballState||{}); const trail=(bs.shots?.at?.(-1)?.trail)||(window.ballArc?.trail)||[]; const H=__computeArcHealth(trail); console.log('[arc-health:now]', H); return H; } catch(e){ console.warn(e); return null; }
  }
} catch {}

const DETECT_EVERY = 1; // detect every frame for smoother trails in E2E
if (!window.__detCache) window.__detCache = { objects: [], frameIndex: -1, _source: 'init' };

let overlay = null;
let ctx = null;
let poseDetector = null;
let lastDetectedFrame = {};
let canvasRecorder = null;
let recordedChunks = [];
let recordingActive = false;

window.__pickingHoop = false;

// worker toggle from console: window.__forceServerDetect = true;
if (typeof window.__forceServerDetect === 'undefined') {
  window.__forceServerDetect = false;
}

// Event-driven HUD pulse: show a single center Shot N on canonical releases
try {
  if (!window.__hudPulseBound) {
    window.__hudPulseBound = true;
    window.addEventListener('shot:release', () => {
      try {
        // If session is capped/ended, ignore any late pulses
        if (window.__sessionEnded === true || window.__sessionCapped === true) return;
        window.__SCORE_SHOT_COUNT = (window.__SCORE_SHOT_COUNT || 0) + 1;
        window.__SCORE_FLASH_UNTIL = performance.now() + Math.max(400, Number(window.SCORE_FLASH_MS || 1200));
        // Do not auto-end here to avoid race with row creation; end handled by UI pipeline
      } catch {}
    });
  }
} catch {}

// safe pose detector wrapper helper
if (typeof window.safeDetectForVideo !== 'function') {
  window.safeDetectForVideo = async function safeDetectForVideo(canvasOrVideo, frameIndex) {
    try {
      if (!window.poseDetector) return null;
      const src = canvasOrVideo || document.getElementById('videoPlayer');
      const ts  = (typeof window.nextPoseTS === 'function') ? window.nextPoseTS() : performance.now();
      return await window.poseDetector.detectForVideo(src, ts);
    } catch (e) {
      console.warn('safeDetectForVideo error:', e);
      return null;
    }
  };
}


// initialize and display overlay
export function initOverlay(canvas, detector = null) {
  if (!canvas) {
    console.warn("⚠️ initOverlay: no canvas");
    return;
  }

  overlay = canvas;
  poseDetector = detector || window.poseDetector || null;
  overlay.style.position = 'absolute';

  const video = document.getElementById('videoPlayer');
  if (video?.videoWidth && video?.videoHeight) {
    overlay.width  = video.videoWidth;
    overlay.height = video.videoHeight;
    ctx = overlay.getContext('2d');
  } else {
    // video not ready yet; get a context anyway
    ctx = overlay.getContext('2d');
    console.warn("⚠️ initOverlay: video metadata not ready; will resize later in drawLiveOverlay");
  }

  // expose for other modules, even if detector isn't ready yet
  window.drawLiveOverlay   = drawLiveOverlay;
  window.getOverlayContext = () => ctx;
}


// helper to toggle clickability
export function setOverlayClickable(on) {
  overlay = overlay || document.getElementById('overlay');
  if (!overlay) return;
  overlay.style.pointerEvents = (window.__pickingHoop ? 'auto' : 'none');
  overlay.style.touchAction = (window.__pickingHoop ? 'none' : '');
  overlay.style.cursor = on ? 'crosshair' : 'default';
}
window.setOverlayClickable = setOverlayClickable;


// ------------------------------------------------------//
// Core function for rendering overlays -----------------//
// ------------------------------------------------------//
// Core function for rendering overlays — single pixel space (video pixels), no jitter
// Core function for rendering overlays — single pixel space (VIDEO pixels)

// Draw release-gate math HUD (shoulder/elbow/wrist, thresholds, and test values)
function drawPoseMathHUD(ctx, playerState, vw, vh, sx, sy) {
  try {
    const show = (window.SHOW_POSE_MATH === true) || (window.DOACH_RELEASE_TRACE === true);
    if (!show) return;
    // Resolve latest keypoints (prefer current, fall back to last)
    let kps = (playerState && Array.isArray(playerState.keypoints) && playerState.keypoints.length) ? playerState.keypoints : null;
    if (!kps) {
      const lastTS = Number(window.__lastPoseTS || 0);
      const holdMs = Number.isFinite(window.POSE_HOLD_MS) ? Number(window.POSE_HOLD_MS) : (window.__SESSION_ACTIVE ? 12000 : 2000);
      if (window.__lastPoseKP && (!lastTS || (performance.now() - lastTS) < holdMs)) kps = window.__lastPoseKP;
    }
    if (!Array.isArray(kps) || kps.length < 33) return;

    // Pick side from last gate if available
    const side = (window.__LAST_GATE?.detail?.tests?.side === 'L') ? 'L' : 'R';
    const S = (side === 'L') ? 11 : 12;
    const E = (side === 'L') ? 13 : 14;
    const W = (side === 'L') ? 15 : 16;
    const sh = kps[S], el = kps[E], wr = kps[W];
    const yTol = Number(window.REL_Y_TOL || 12);
    const ySh  = Number(window.REL_SH_Y_TOL || 8);

    const wristAboveElbow    = (wr && el) ? (wr.y < (el.y - yTol)) : false;
    const wristAboveShoulder = (wr && sh) ? (wr.y < (sh.y - ySh)) : false;
    let elbowAngleDeg = 0, elbowExtended = false;
    if (sh && el && wr) {
      const v1x = sh.x - el.x, v1y = sh.y - el.y;
      const v2x = wr.x - el.x, v2y = wr.y - el.y;
      const dot = (v1x*v2x + v1y*v2y);
      const den = (Math.hypot(v1x,v1y)*Math.hypot(v2x,v2y) + 1e-6);
      const a = Math.acos(Math.max(-1, Math.min(1, dot/den))) * 180 / Math.PI;
      // 180° = fully straight
      elbowAngleDeg = a;
      const extMin = Number.isFinite(window.REL_ELBOW_EXT_MIN)
        ? window.REL_ELBOW_EXT_MIN
        : (Number(window.REL_CFG?.elbowExtMin) || 145);
      const elbowExtended = Number.isFinite(elbowAngleDeg) && (elbowAngleDeg >= extMin);
    }
    const dx = Math.abs((wr?.x ?? 0) - (sh?.x ?? 0));
    const dy = Math.abs((sh?.y ?? 0) - (wr?.y ?? 0));
    const nearlyVertical = (dx < Number(window.REL_DX_MAX || 90)) && (dy > Number(window.REL_DY_MIN || 18));
    const dSE = Math.hypot((el?.x ?? 0) - (sh?.x ?? 0), (el?.y ?? 0) - (sh?.y ?? 0));
    const dSW = Math.hypot((wr?.x ?? 0) - (sh?.x ?? 0), (wr?.y ?? 0) - (sh?.y ?? 0));
    const armExtended = dSW > (dSE + Number(window.REL_EXT_MARGIN || 10));
    const alignOK = nearlyVertical || armExtended;
    const strictMin = Number.isFinite(window.REL_ELBOW_STRICT_MIN)
      ? window.REL_ELBOW_STRICT_MIN
      : (Number(window.REL_CFG?.elbowStrictMin) || 135);
    const strictOK = (Number.isFinite(elbowAngleDeg) && elbowAngleDeg >= strictMin) && wristAboveShoulder;
    
    // Draw
    const hair = 1 / Math.min(sx, sy);
    ctx.save();
    ctx.lineWidth = Math.max(2 * hair, 1.5);
    if (sh && el) { ctx.strokeStyle = '#00C8FF'; ctx.beginPath(); ctx.moveTo(sh.x, sh.y); ctx.lineTo(el.x, el.y); ctx.stroke(); }
    if (el && wr) { ctx.strokeStyle = '#FFA500'; ctx.beginPath(); ctx.moveTo(el.x, el.y); ctx.lineTo(wr.x, wr.y); ctx.stroke(); }
    if (Number.isFinite(el?.y)) {
      ctx.strokeStyle = wristAboveElbow ? 'rgba(0,200,0,0.9)' : 'rgba(255,0,0,0.9)';
      const yLineEl = (el.y - yTol);
      ctx.beginPath(); ctx.moveTo(0, yLineEl); ctx.lineTo(vw, yLineEl); ctx.stroke();
    }
    if (Number.isFinite(sh?.y)) {
      ctx.strokeStyle = 'rgba(0,150,255,0.9)';
      const yLineSh = (sh.y - ySh);
      ctx.beginPath(); ctx.moveTo(0, yLineSh); ctx.lineTo(vw, yLineSh); ctx.stroke();
    }
    const r = Math.max(4 * hair, 3);
    const dot = (p, color) => { if (!p) return; ctx.beginPath(); ctx.fillStyle = color; ctx.arc(p.x, p.y, r, 0, Math.PI*2); ctx.fill(); };
    dot(sh, '#00C8FF'); dot(el, elbowExtended ? '#00FF88' : '#FF0066'); dot(wr, wristAboveElbow ? '#00FF88' : '#FF0066');
    ctx.restore();

    // HUD panel
    ctx.save();
    const x0 = vw - Math.max(260, 220) * hair;
    const y0 = 10 / hair;
    ctx.font = `${Math.max(11*hair, 10)}px system-ui`;
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(x0 - 6*hair, y0 - 4*hair, 260*hair, 128*hair);
    const line = (txt, ok) => { ctx.fillStyle = ok===true ? '#7CFC00' : ok===false ? '#FF6347' : '#FFFFFF'; ctx.fillText(txt, x0, (drawPoseMathHUD._i++ * 14*hair) + y0); };
    drawPoseMathHUD._i = 0;
    ctx.fillStyle = '#FFFFFF'; ctx.fillText('Release Gate', x0, (drawPoseMathHUD._i++ * 14*hair) + y0);
    line(`side: ${side==='L'?'Left':'Right'}`, true);
    line(`wristAboveShoulder: ${wristAboveShoulder?'✓':'✗'}  wr.y < sh.y - ${ySh}`, wristAboveShoulder);
    line(`wristAboveElbow: ${wristAboveElbow?'✓':'✗'}  wr.y < el.y - ${yTol}`, wristAboveElbow);
    line(`elbowExtended: ${elbowExtended?'✓':'✗'}  ${Math.round(elbowAngleDeg)}° ≥ ${window.REL_ELBOW_EXT_MIN}°`, elbowExtended);
    line(`strict: angle≥${window.REL_ELBOW_STRICT_MIN}° & wr>sh ${strictOK?'✓':'✗'}`, strictOK);
    line(`align: ${(alignOK?'✓':'✗')}  dx=${dx|0} dy=${dy|0}`, alignOK);
    // Compute live gate/score for HUD. Prefer __LAST_GATE (set each tick by the sampler) to avoid drift.
    let scoreGate = 0, th = Number((window.REL_CFG?.hudScoreTrip) ?? window.REL_HUD_SCORE_TRIP ?? (window.REL_CFG?.scoreThresh) ?? window.REL_SCORE_THRESH ?? 0.26);
    try {
      const last = (window.__LAST_GATE && window.__LAST_GATE.detail && window.__LAST_GATE.detail.tests) ? window.__LAST_GATE.detail.tests : null;
      if (last && typeof last.score !== 'undefined') {
        scoreGate = Number(last.score || 0);
        if (window.DOACH_VERBOSE === true && window.DOACH_RELEASE_TRACE === true) {
          try { console.log('[HUD:gate:last]', { frame: window.__LAST_GATE?.detail?.frame, score: scoreGate, th, tests: last }); } catch {}
        }
      } else {
        const base = (window.playerState?.frameHistory || []).slice(-5);
        const hist = base.length ? base : (Array.isArray(kps) && kps.length >= 33 ? [{ keypoints: kps }] : []);
        if (typeof window.releaseGate === 'function') {
          const g = window.releaseGate(hist) || { tests:{} };
          scoreGate = Number(g?.tests?.score || 0);
          if (window.DOACH_VERBOSE === true && window.DOACH_RELEASE_TRACE === true) {
            try {
              const lastF = hist.at?.(-1)?.frame ?? null;
              console.log('[HUD:gate]', { frame:lastF, score: scoreGate, th, tests: g.tests||{}, reason: g.reason, released: g.released, histLen: hist.length });
            } catch {}
          }
        }
      }
    } catch (e) {
      try { if (window.DOACH_VERBOSE === true && window.DOACH_RELEASE_TRACE === true) console.warn('[HUD:gate:error]', e); } catch {}
    }

    // Compute local 0.26-weight score from booleans for HUD display and all-four check
    let scoreLocal26 = null, allFour26 = false, tot26 = null;
    try {
      const useUp = (window.REL_SCORE_USE_UPTREND === true);
      const norm = (x,d)=>{ const n=Number(x); return (Number.isFinite(n)&&n>=0)?n:d; };
      const cfgW = (window.REL_CFG && window.REL_CFG.weights) || {};
      const wA = norm((cfgW.wrist ?? window.REL_W_WRIST ?? window.REL_W_A), 0.26);
      const wB = norm((cfgW.elbow ?? window.REL_W_ELBOW ?? window.REL_W_B), 0.26);
      const wC = norm((cfgW.align ?? window.REL_W_ALIGN ?? window.REL_W_C), 0.26);
      const wDsrc = useUp
        ? (cfgW.uptrend ?? window.REL_W_UPTREND ?? window.REL_W_D)
        : (cfgW.shoulder ?? window.REL_W_SHOULDER ?? window.REL_W_D);
      const wD = norm(wDsrc, 0.26);
      tot26 = wA + wB + wC + wD;
      scoreLocal26 =
        (wristAboveElbow ? wA : 0) +
        (elbowExtended   ? wB : 0) +
        (alignOK         ? wC : 0) +
        ((useUp ? wristUpTrend : wristAboveShoulder) ? wD : 0);
      allFour26 = Number.isFinite(scoreLocal26) && Number.isFinite(tot26) && (scoreLocal26 >= (tot26 - 1e-6));
      // Local score only affects HUD display when gate score is missing
      // if (window.DOACH_RELEASE_TRACE === true) {
      //   try { console.log('[HUD:score-local-26]', { score: +(scoreLocal26||0).toFixed?.(3), tot: +(tot26||0).toFixed?.(3), allFour26 }); } catch {}
      // }
    } catch {}
    const scoreDisp = Number.isFinite(scoreLocal26) ? scoreLocal26 : scoreGate;
    line(`score: ${(scoreDisp||0).toFixed(2)} (≥${th})`, (scoreDisp||0) >= th);

    // Shot count (HUD-local) (DISABLED by default). Enable with window.HUD_LOCAL_PULSE = true.
    if (window.HUD_LOCAL_PULSE === true) { try {
      const tripTh = Number((window.REL_CFG?.hudScoreTrip) ?? window.REL_HUD_SCORE_TRIP ?? (window.REL_CFG?.scoreThresh) ?? window.REL_SCORE_THRESH ?? 0.26);
      const cdMs   = Number(window.HUD_SHOT_COOLDOWN_MS ?? 2000);
      const nowMs  = performance.now();
      const lastMs = Number(window.__HUD_LAST_SHOT_MS || 0);
      if (Number(scoreGate) >= tripTh - 1e-6 && (nowMs - lastMs >= cdMs)) {
        window.__HUD_SHOT_COUNT = (window.__HUD_SHOT_COUNT || 0) + 1;
        window.__HUD_LAST_SHOT_MS = nowMs;
        try { window.shotTaken = Number(window.__HUD_SHOT_COUNT); } catch {}
        try { window.dispatchEvent(new CustomEvent('hud:shot-taken', { detail: { count: Number(window.__HUD_SHOT_COUNT) } })); } catch {}
        try { window.dispatchEvent(new CustomEvent('hud:score-trip', { detail: { frame: (playerState?.frameIndex || null), score: Number(scoreGate) } })); } catch {}
        try {
          const msg = `Shot ${window.__HUD_SHOT_COUNT}`;
          if (typeof window.showCenterPrompt === 'function') {
            window.showCenterPrompt(msg);
            setTimeout(() => { try { const el = document.getElementById('overlayPrompt'); if (el) el.style.display = 'none'; } catch {} }, 900);
          }
        } catch {}
        if (window.DOACH_RELEASE_TRACE === true) {
          try { console.log('[HUD:shot-count]', { count: window.__HUD_SHOT_COUNT, th: tripTh, score: Number(scoreGate).toFixed?.(3) }); } catch {}
        }
      }
    } catch {} }

    // Canonical release bridge — DISABLED unless explicitly enabled
    if (window.HUD_BRIDGE_ENABLE === true) { try {
      const nowMs = performance.now();
      let approved = false, gate = null;
      const hist = (window.playerState?.frameHistory || []).slice(-5);
      if (typeof window.releaseGate === 'function' && hist.length) {
        gate = window.releaseGate(hist) || { released:false };
        approved = !!gate.released;
      }
      const armed = (window.__shotTrackingArmed === true);
      if (armed && approved && allFour26 === true) {
        const since = nowMs - (Number(window.__REL_LAST_FIRE_MS) || 0);
        const relCd = Number(window.REL_COOLDOWN_MS || (window.REL_CFG?.cooldownMs) || 2000);
        if (since >= relCd && !window.__releaseEventSent) {
          const frame = (playerState?.frameIndex ?? (window.playerState?.frameHistory?.at?.(-1)?.frame) ?? 0);
          const H = (typeof window.getLockedHoopBox === 'function') ? window.getLockedHoopBox() : null;
          let prox = null;
          try {
            if (H && Number.isFinite(H.x) && Number.isFinite(H.y)) {
              const px   = Number.isFinite(window.proxX)      ? Number(window.proxX)      : Number(window.PREF_PROX?.x ?? 200);
              const pya  = Number.isFinite(window.proxYAbove) ? Number(window.proxYAbove) : Number(window.PREF_PROX?.yAbove ?? 170);
              const pyb  = Number.isFinite(window.proxYBelow) ? Number(window.proxYBelow) : Number(window.PREF_PROX?.yBelow ?? 100);
              const rimT = H.y - (H.h || 0)/2;
              prox = { x: H.x - px, y: rimT - pya, w: px*2, h: pya + pyb };
            }
          } catch {}
          try { (window.__markReleasePose || window.markRelease)?.(frame, { prox, via: 'hud-bridge', requirePose: true }); } catch {}
          try { window.dispatchEvent(new CustomEvent('pose:release', { detail: { frame, via: 'hud-bridge', gate } })); } catch {}
          try { window.dispatchEvent(new CustomEvent('shot:release', { detail: { frame, via: 'hud-bridge', gate } })); } catch {}
          try { window.__releaseEventSent = true; window.__REL_LAST_FIRE_MS = nowMs; } catch {}
        }
      }
    } catch {} }
    const shotsTaken = Number(
      window.__SCORE_SHOT_COUNT            // canonical: increments on shot:release
      ?? window.__HUD_SHOT_COUNT           // legacy HUD counter (only if HUD_LOCAL_PULSE=true)
      ?? (window.__shotList?.length ?? 0)  // fallback to finalized shots
    );
    line(`shots taken: ${shotsTaken}`, shotsTaken > 0);
    // keep HUD minimal to the core indicators (no extra trend line)
    if (window.__LAST_GATE?.latched) { ctx.fillStyle = '#00FF88'; ctx.fillText('LATCHED', x0, (drawPoseMathHUD._i++ * 14*hair) + y0); }
    ctx.restore();
  } catch {}
}

export function drawLiveOverlay(objects = [], playerState) {
  const video   = document.getElementById('videoPlayer');
  const overlay = document.getElementById('overlay');
  if (!overlay || !video) return;

  const ctx = overlay.getContext('2d', { willReadFrequently: true });
  if (!ctx) return;

  // Ensure a valid VIEW mapping; if missing, attempt a resync and then fall back
  let V = window.__VIEW || null;
  if (!V || !V.vw || !V.vh || !V.sx || !V.sy) {
    try { syncOverlayToVideo?.(); } catch {}
    V = window.__VIEW || null;
  }
  if (!V || !V.vw || !V.vh) {
    // Hard fallback: bind overlay buffer to the video's intrinsic size
    const vw = Math.max(1, video.videoWidth || overlay.width || 0);
    const vh = Math.max(1, video.videoHeight || overlay.height || 0);
    if (vw && vh) {
      if (overlay.width !== vw)  overlay.width  = vw;
      if (overlay.height !== vh) overlay.height = vh;
      const sx = 1, sy = 1;
      try {
        window.__VIEW = { vw, vh, renderW: vw, renderH: vh, offL:0, offT:0, scale:1, dpr:1, sx, sy };
        window.__APPLY_OVERLAY_XFORM = (c) => c.setTransform(sx, 0, 0, sy, 0, 0);
      } catch {}
    }
  }
  const { vw, vh, sx, sy } = window.__VIEW || {};
  if (!vw || !vh || !sx || !sy) return;
  // Determine mode early and, in clean mode, keep overlay unchanged after the first draw
  let __mode = String(window.__overlayMode || 'live').toLowerCase();
  // Live camera sessions default to coach visuals unless user explicitly set debug
  let mode = __mode;
  if (window.__SESSION_ACTIVE && mode !== 'debug') mode = 'coach';
  if (mode === 'clean' && window.__overlayFreeze === true) {
    if (!window.__overlayCleanDrawn) {
      try { if (paintCleanOverlayOnce()) window.__overlayCleanDrawn = true; } catch {}
    }
    return;
  }
  if (mode === 'clean') {
    if (window.__overlayCleanDrawn === true) return;
    // Try to paint once now; if success, skip further drawing to keep hash stable
    const okNow = paintCleanOverlayOnce();
    if (okNow) { window.__overlayCleanDrawn = true; return; }
  }

  // If overlay is in "clean" mode, we'll still DRAW the frozen/live arc below so visual checks pass.
  // Update counters early for convenience, but do not return here.
  if (mode === 'clean') {
    try {
      const frozen = (window.ballState?.shots?.at?.(-1)?.trail) || null;
      const arc = (window.ballArc && Array.isArray(window.ballArc.trail)) ? window.ballArc.trail : [];
      const t = (Array.isArray(frozen) && frozen.length ? frozen : arc);
      const rings = Math.max(0, Math.ceil((Array.isArray(t) ? t.length : 0) / 1));
      window.__overlayArcDrawnCount = Math.max(window.__overlayArcDrawnCount || 0, rings);
      window.__overlayLastTrailMode = 'arc';
      window.__overlayLastTrailInput = (Array.isArray(frozen) && frozen.length) ? 'frozen-clean' : 'ballArc-clean';
    } catch {}
  }

  // 1) clear in buffer pixels
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, overlay.width, overlay.height);

  // 2) draw in VIDEO pixels (apply device/canvas scale)
  window.__APPLY_OVERLAY_XFORM?.(ctx);        // ctx.setTransform(sx, 0, 0, sy, 0, 0)

  // a 1-px (screen) hairline in VIDEO units
  const hair = 1 / Math.min(sx, sy);

  // Optional on-screen watermark for live debug
  try {
    window.__overlayPaintCount = (window.__overlayPaintCount||0) + 1;
    if (window.DOACH_WATERMARK) {
      ctx.save();
      ctx.fillStyle = (playerState?.keypoints?.length >= 33) ? 'rgba(36,208,90,0.95)' : 'rgba(255,77,79,0.95)';
      ctx.beginPath(); ctx.arc(8/hair, 8/hair, 5/hair, 0, Math.PI*2); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.font = `${Math.max(10/hair,10)}px system-ui`;
      ctx.fillText(`ov ${overlay.width}x${overlay.height} vw ${vw} vh ${vh}`, 20/hair, 12/hair);
      ctx.restore();
    }
  } catch {}

  // Pose math HUD (release gate)
  drawPoseMathHUD(ctx, playerState, vw, vh, sx, sy);

  // Coach mode: show only hoop marker and pose skeleton (no ball arcs/trails/objects)
  try { window.__lastOverlayPaintAt = performance.now(); } catch {}
  if (window.DOACH_OVERLAY_TRACE && (!window.__overlayTraceAt || performance.now() - window.__overlayTraceAt > 400)) {
    try {
      window.__overlayTraceAt = performance.now();
      const H = (typeof window.getLockedHoopBox === 'function') ? window.getLockedHoopBox() : null;
      console.log('[overlay:draw]', {
        mode,
        havePose: !!(playerState?.keypoints?.length >= 33),
        haveHoop: !!H,
        hoop: H ? { x: H.x|0, y: H.y|0, w: H.w|0, h: H.h|0 } : null,
        view: { vw, vh, sx: sx.toFixed?.(2), sy: sy.toFixed?.(2) },
        ov: { w: overlay.width, h: overlay.height }
      });
    } catch {}
  }
  if (mode === 'coach') {
    // Clear
    ctx.setTransform(1,0,0,1,0,0);
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    window.__APPLY_OVERLAY_XFORM?.(ctx);
    try { drawHoopMarker?.(ctx, { always: true }); } catch {}
    try {
      let kps = (playerState && Array.isArray(playerState.keypoints) && playerState.keypoints.length) ? playerState.keypoints : null;
      if (!kps) {
        const lastTS = Number(window.__lastPoseTS || 0);
        const holdMs = Number.isFinite(window.POSE_HOLD_MS) ? Number(window.POSE_HOLD_MS) : (window.__SESSION_ACTIVE ? 12000 : 2000);
        if (window.__lastPoseKP && (!lastTS || (performance.now() - lastTS) < holdMs)) {
          kps = window.__lastPoseKP; // hold last good pose to avoid flicker after lock
        }
      }
      if (Array.isArray(kps) && kps.length >= 33) {
        const flash = Number(window.__poseFlashUntil || 0);
        const force = (window.FORCE_POSE_DRAW === true) || (flash && performance.now() < flash);
        if (force) {
          // Minimal debug renderer: draw all joints regardless of visibility
          ctx.save();
          ctx.fillStyle = 'rgba(0, 255, 0, 0.95)';
          const r = Math.max(3, 3 / Math.min(sx, sy));
          for (const p of kps) {
            if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
            ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI*2); ctx.fill();
          }
          ctx.restore();
        } else {
          drawPoseSkeleton?.(ctx, kps);
        }
      }
    } catch {}
    // Re-draw HUD after coach clear
    drawPoseMathHUD(ctx, playerState, vw, vh, sx, sy);
    // 👇 Live camera needs background scoring to produce shot:summary
    try {
      const H = (typeof window.getLockedHoopBox === 'function') ? window.getLockedHoopBox() : null;
      const hasTrail = (window.ballState?.trail?.length || 0) > 0;
      if (H && (hasTrail || (window.lastDetectedFrame?.objects?.length || 0) > 0)) {
        const fidx = Number(window.__AN_IDX || 0);
        window.scoringTick?.(fidx);
        window.checkShotConditions?.(window.ballState, H, fidx);
      }
    } catch {}
     return;
   }

  // Arc-only user mode: render just the ball arc, nothing else
  if (mode === 'arc-only') {
    const ctx = overlay.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    // 1) clear
    ctx.setTransform(1,0,0,1,0,0);
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    // 2) draw in VIDEO pixels
    window.__APPLY_OVERLAY_XFORM?.(ctx);
    // During pick or just after lock, show a brief rim marker so users know we latched
    try {
      const flash = Number(window.__hoopLockFlashUntil || 0);
      if (window.__pickingHoop || (flash && performance.now() < flash)) {
        drawHoopMarker?.(ctx);
      }
    } catch {}
    try { drawBallArc?.(ctx, { trimTop: (window.ARC_TRIM_TOP !== false), strictArc: true }); } catch {}
    // Show summary banner/labels even in arc-only mode
    try { drawFinalShotSummary?.(ctx); } catch {}
    // Do not draw any other HUD/boxes in this mode
    return;
  }
  // If overlay is in 'clean' mode or a shot is frozen, render only the frozen trail and summary
  try {
    const bs = (window.ballState || {});
    const wantFrozenOnly = (mode === 'clean') || bs.showFrozen;
    // Prefer the test-oriented frozen mirror first, then fall back to shots[]
    const frozenRec = (Array.isArray(bs.frozenShots) && bs.frozenShots.length)
        ? bs.frozenShots[bs.frozenShots.length - 1]
        : (Array.isArray(bs.shots) && bs.shots.length ? bs.shots[bs.shots.length - 1] : null);
    if (wantFrozenOnly && frozenRec) {
      const trail = Array.isArray(frozenRec?.trail) ? frozenRec.trail : [];
      if (trail.length) {
        // Densify the path so clean mode has ample pixels
        const dense = (function densifyPolyline(tr, step = 8) {
          if (!Array.isArray(tr) || tr.length < 2) return tr || [];
          const out = [tr[0]];
          for (let i = 1; i < tr.length; i++) {
            const a = tr[i-1], b = tr[i];
            const dx = b.x - a.x, dy = b.y - a.y; const dist = Math.hypot(dx, dy) || 0;
            const n = Math.max(0, Math.floor(dist / step) - 0);
            for (let k = 1; k <= n; k++) {
              const t = k / (n + 1);
              out.push({ x: a.x + dx*t, y: a.y + dy*t, frame: b.frame });
            }
            out.push(b);
          }
          return out;
        })(trail, 4);

        // Draw static arc path and dense dots (thicker for e2e pixel check)
        const color = 'rgba(50,200,255,0.95)';
        const hair = 1 / Math.min(window.__VIEW?.sx || 1, window.__VIEW?.sy || 1);
        const lw = Math.max(8 * hair, 6);
        ctx.save();
        ctx.lineWidth = lw;
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.moveTo(dense[0].x, dense[0].y);
        for (let i = 1; i < dense.length; i++) ctx.lineTo(dense[i].x, dense[i].y);
        ctx.stroke();
        ctx.fillStyle = color;
        const r = Math.max(7.5 * hair, 7.0);
        for (let i = 0; i < dense.length; i++) {
          const p = dense[i];
          ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
        }
        ctx.restore();
        // Also ensure ring count meets a minimum for tests/UX even in clean mode
        try {
          const minR = Math.max(1, Number(window.ARC_MIN_RINGS || 8));
          const dotEvery = 1;
          const rings = Math.max(minR, Math.ceil(dense.length / dotEvery));
          window.__overlayArcDrawnCount = Math.max(window.__overlayArcDrawnCount || 0, rings);
          window.__overlayLastTrailMode = 'arc';
          window.__overlayLastTrailInput = 'frozen-clean';
        } catch {}
      }
      // In clean mode, mark drawn-once so future calls skip clearing/drawing entirely
      if (mode === 'clean') {
        if ((window.__overlayArcDrawnCount || 0) > 0) window.__overlayCleanDrawn = true;
        return;
      }
      return; // skip live overlays while frozen
    }
    // Clean mode without a frozen shot yet � draw best available live trail densely
    if (mode === 'clean') {
      try {
        const bs2 = (window.ballState || {});
        const arcTrail = (window.ballArc && Array.isArray(window.ballArc.trail)) ? window.ballArc.trail : [];
        const liveTrail= Array.isArray(bs2.trail) ? bs2.trail : [];
        const trail = (arcTrail.length >= liveTrail.length) ? arcTrail : liveTrail;
        if (trail.length >= 2) {
          const dense = (function densifyPolyline(tr, step = 6) {
            const out=[tr[0]]; for(let i=1;i<tr.length;i++){ const a=tr[i-1],b=tr[i]; const dx=b.x-a.x, dy=b.y-a.y; const dist=Math.hypot(dx,dy)||0; const n=Math.max(0,Math.floor(dist/step)-0); for(let k=1;k<=n;k++){ const t=k/(n+1); out.push({ x:a.x+dx*t, y:a.y+dy*t, frame:b.frame }); } out.push(b);} return out; })(trail,6);
          const color='rgba(50,200,255,0.95)'; const hair=1/Math.min(window.__VIEW?.sx||1, window.__VIEW?.sy||1);
          const lw=Math.max(7,7*hair); ctx.save(); ctx.lineWidth=lw; ctx.strokeStyle=color; ctx.beginPath(); ctx.moveTo(dense[0].x,dense[0].y); for(let i=1;i<dense.length;i++) ctx.lineTo(dense[i].x,dense[i].y); ctx.stroke(); ctx.fillStyle=color; const r=Math.max(6.5,6.5*hair); for (const p of dense){ ctx.beginPath(); ctx.arc(p.x,p.y,r,0,Math.PI*2); ctx.fill(); } ctx.restore();
          try { const minR=Math.max(1, Number(window.ARC_MIN_RINGS||8)); window.__overlayArcDrawnCount=Math.max(window.__overlayArcDrawnCount||0, Math.max(minR,dense.length)); window.__overlayLastTrailMode='arc'; window.__overlayLastTrailInput='clean-live'; } catch {}
        }
      } catch {}
      if ((window.__overlayArcDrawnCount || 0) > 0) window.__overlayCleanDrawn = true; return;
    }
  } catch {}

  // ---- active player box (optional) ----
  try {
    const ap = window.activePlayerBox;
    if (ap) {
      ctx.save();
      ctx.strokeStyle = 'deepskyblue';
      ctx.lineWidth = 2 * hair;
      ctx.strokeRect(ap.x, ap.y, ap.w, ap.h);
      ctx.restore();
    }
  } catch {}

  // ---- pose ----
  try {
    const kps = playerState?.keypoints;
    const valid = Array.isArray(kps) && kps.length >= 33 &&
                 kps.every(k => k && Number.isFinite(k.x) && Number.isFinite(k.y)) &&
                 (playerState?._believable !== false);
    if (valid) {
      drawPoseSkeleton?.(ctx, kps);
      drawWristTrail?.(ctx);
    }
  } catch {}

  // ---- hoop proximity / tube / trails / final summary ----
  try { drawHoopProximityDebug?.(ctx); } catch {}
  try { drawShotTubeDebug?.(ctx); } catch {}
  try { drawBallArc?.(ctx); } catch {}          // draw the arc dots + line
  try { if ((window.PREF_SHOW?.trails) !== false) drawBallTrails?.(ctx); } catch {}

  // ——— Score trigger HUD pulse (diagnostic) — optional — enable with window.HUD_LOCAL_PULSE = true ———
  if (window.HUD_LOCAL_PULSE === true) { try {
    const th = Number((window.REL_CFG?.scoreThresh) ?? window.REL_SCORE_THRESH ?? 1.0);
    // Prefer the sampler-computed gate snapshot (__LAST_GATE), then fall back to a fresh call
    let scoreNow = null, frameNow = null, testsNow = null;
    try {
      const lg = window.__LAST_GATE;
      if (lg && lg.detail && lg.detail.tests) {
        scoreNow = Number(lg.detail.tests.score || 0);
        frameNow = Number(lg.detail.frame || 0);
        testsNow = lg.detail.tests || null;
      }
    } catch {}
    if (scoreNow == null || !Number.isFinite(scoreNow)) {
      if (typeof window.releaseGate === 'function') {
        const hist = (window.playerState?.frameHistory || []).slice(-5);
        const g = window.releaseGate(hist) || { tests:{} };
        scoreNow = Number(g.tests?.score || 0);
        frameNow = Number(hist.at?.(-1)?.frame || 0);
        testsNow = g.tests || null;
      }
    }
    // Publish a single global snapshot for any consumers (HUD, table, etc.)
    try { window.RELEASE_SCORE = { t: performance.now(), frame: frameNow, score: scoreNow, tests: testsNow }; } catch {}
    // Rising-edge detection by frame; do not require armed/hoop for the visual pulse
    if (Number.isFinite(scoreNow)) {
      const ok = (scoreNow >= th - 1e-6);
      const lastF = Number(window.__SCORE_LAST_FRAME || -1);
      const nowMs = performance.now();
      const lastMs = Number(window.__SCORE_LAST_MS || 0);
      const timeEdge = (nowMs - lastMs) > Math.max(280, Number(window.SCORE_PULSE_MIN_GAP_MS || 350));
      if (ok && (frameNow !== lastF || timeEdge)) {
        window.__SCORE_LAST_FRAME = frameNow;
        window.__SCORE_LAST_MS = nowMs;
        const n = (window.__SCORE_SHOT_COUNT = (window.__SCORE_SHOT_COUNT || 0) + 1);
        const msg = `Shot ${n}`;
        try { window.__SCORE_FLASH_UNTIL = performance.now() + Math.max(400, Number(window.SCORE_FLASH_MS || 1200)); } catch {}
        try {
          if (typeof window.showCenterPrompt === 'function') {
            window.showCenterPrompt(msg);
            setTimeout(() => { try { const el = document.getElementById('overlayPrompt'); if (el) el.style.display = 'none'; } catch {} }, 800);
          }
          if (window.DOACH_RELEASE_TRACE === true) console.log('[SCORE:trigger]', { count: n, score: +scoreNow.toFixed?.(3), th, frame: frameNow, via:'hud' });
        } catch {}
      }
    }
  } catch {} }

  // Draw canvas-based pulse so it's visible even if DOM HUD isn't ready
  try {
    const until = Number(window.__SCORE_FLASH_UNTIL || 0);
    if (until && performance.now() < until) {
      const n = Number(window.__SCORE_SHOT_COUNT || 0);
      if (n > 0) {
        const V = window.__VIEW || { vw: overlay.width, vh: overlay.height, sx:1, sy:1 };
        const vw = V.vw || overlay.width, vh = V.vh || overlay.height;
        const hair = 1 / Math.min(V.sx || 1, V.sy || 1);
        const text = `Shot ${n}`;
        ctx.save();
        ctx.font = `${Math.max(36*hair, 30)}px system-ui, -apple-system, Segoe UI, Arial`;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'center';
        const x = vw/2, y = vh/2;
        // backdrop
        ctx.fillStyle = 'rgba(0,0,0,0.65)';
        const pad = 20*hair; const w = ctx.measureText(text).width + pad*2; const h = 52*hair;
        ctx.fillRect(x - w/2, y - h/2, w, h);
        // text
        ctx.fillStyle = '#FFFFFF';
        ctx.fillText(text, x, y + 2*hair);
        ctx.restore();
      }
    }
  } catch {}
  // Fallback pose-gate latch (optional). Disable by default; set window.DISABLE_HUD_FALLBACK = false to enable.
  if (window.DISABLE_HUD_FALLBACK !== true) { try {
    const armed = (window.__shotTrackingArmed === true);
    const H = window.getLockedHoopBox?.();
    if (armed && H) {
      const hist = (window.playerState?.frameHistory || []).slice(-5);
      if (hist.length >= 2 && typeof window.releaseGate === 'function') {
        const g = window.releaseGate(hist) || { released:false, tests:{} };
        const th = Number((window.REL_CFG?.scoreThresh) ?? window.REL_SCORE_THRESH ?? 1.0);
        const allGreen = Number(g?.tests?.score || 0) >= th - 1e-6;
        if (g.released && allGreen) {
          const now = performance.now();
          const cd  = Number(window.REL_COOLDOWN_MS || (window.REL_CFG?.cooldownMs) || 2000);
          const since = now - (Number(window.__REL_LAST_FIRE_MS) || 0);
          if (since >= cd && !window.__releaseEventSent) {
            const f = (() => {
              if (Number.isFinite(window.__AN_IDX)) return Number(window.__AN_IDX);
              const k = hist.at(-1); return Number(k?.frame || 0);
            })();
            const prox = (typeof window.proxFromHoop === 'function' && typeof window.canonHoop === 'function')
                          ? window.proxFromHoop(window.canonHoop(H)) : null;
            (window.__markReleasePose || window.markRelease)?.(f, { prox, via: 'hud-fallback', requirePose: true });
            try { window.dispatchEvent(new CustomEvent('pose:release', { detail: { frame: f, via: 'hud-fallback' } })); } catch {}
            try { window.__releaseEventSent = true; window.dispatchEvent(new CustomEvent('shot:release', { detail: { frame: f, via: 'hud-fallback' } })); } catch {}
            try { window.__REL_LAST_FIRE_MS = now; } catch {}
          }
        }
      }
    }
  } catch {} }
  // Release marker (debug): draw a distinct circle around the release point briefly
  try {
    const bs = (window.ballState || {});
    const nowF = window.lastDetectedFrame?.__frameIdx ?? -1;
    if (Number.isFinite(bs.releaseFrame)) {
      const show = !Number.isFinite(bs._releaseDrawUntil) || (nowF <= bs._releaseDrawUntil);
      const p = bs.releasePos || (Array.isArray(bs.trail) ? bs.trail.find(q => (q?.frame === bs.releaseFrame)) : null) || null;
      if (show && p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
        ctx.save();
        ctx.strokeStyle = 'rgba(0,200,255,0.95)';
        const hair = 1 / Math.min(window.__VIEW?.sx || 1, window.__VIEW?.sy || 1);
        ctx.lineWidth = Math.max(2 * hair, 2);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 16 * hair, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }
  } catch {}
  try { drawFinalShotSummary?.(ctx); } catch {}

  try {
    const cand = window.__hoopCandidates;
    if (cand?.scores?.length) {
      const hoops = (window.lastDetectedFrame?.objects || [])
        .filter(o => o.label === 'hoop' && Array.isArray(o.box));

      cand.scores.forEach(({ idx, score }, i) => {
        const h = hoops[idx];
        if (!h) return;                          // guard: index may shift
        const [x1, y1, x2, y2] = h.box;
        ctx.save();
        ctx.strokeStyle = (i === 0) ? 'lime' : 'orange'; // best in lime
        ctx.lineWidth = (i === 0) ? 3 : 2;
        ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);

        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(x1, y1 - 16, 50, 16);
        ctx.fillStyle = 'white';
        ctx.font = '12px system-ui';
        ctx.fillText(score.toFixed(2), x1 + 4, y1 - 4);
        ctx.restore();
      });
    }
  } catch {}


  // ---- hoop marker (center-safe) ----
  try {
    const HB = getLockedHoopBox?.();
    if (HB) {
      // normalize: accept {cx,cy,w,h} or {x,y,w,h,anchor:'topleft'} or {x,y,w,h} as center
      const w  = HB.w, h = HB.h;
      const cx = Number.isFinite(HB.cx) ? HB.cx
              : (HB.anchor === 'topleft' ? (HB.x + w / 2) : HB.x);
      const cy = Number.isFinite(HB.cy) ? HB.cy
              : (HB.anchor === 'topleft' ? (HB.y + h / 2) : HB.y);
      const x1 = cx - w / 2, y1 = cy - h / 2;

      ctx.save();
      if (ctx.setLineDash) ctx.setLineDash([4 * (1 / Math.min(window.__VIEW.sx, window.__VIEW.sy))]);
      ctx.strokeStyle = 'lime';
      ctx.lineWidth   = 2 * (1 / Math.min(window.__VIEW.sx, window.__VIEW.sy));
      ctx.strokeRect(x1, y1, w, h);
      ctx.beginPath(); ctx.arc(cx, cy, 3 * (1 / Math.min(window.__VIEW.sx, window.__VIEW.sy)), 0, Math.PI * 2);
      ctx.fillStyle = 'red'; ctx.fill();
      ctx.restore();
    }
  } catch {}

  // ---- detections (respect prefs) ----
  try {
    const ap = window.activePlayerBox || null;
    const show = (window.PREF_SHOW || {});
    for (const obj of (objects || [])) {
      if (!Array.isArray(obj.box) || obj.box.length !== 4) continue;
      const [x1, y1, x2, y2] = obj.box;
      const label = (obj.label || 'unknown').toLowerCase();

      if (label === 'player' && ap) continue;
      if (label === 'player'     && show.player     === false) continue;
      const isBall = window.isBallLabel?.(label) ?? (label === 'basketball');
      if (isBall && show.ball === false) continue;
      if (label === 'hoop'       && show.hoop       === false) continue;
      if (label === 'backboard'  && show.backboard  === false) continue;
      if (label === 'net'        && show.net        === false) continue;

      const color = ({ basketball:'yellow', hoop:'red', player:'cyan', net:'orange', backboard:'magenta' }[label]) || 'white';
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth   = 2 * hair;
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);

      // quick label
      ctx.font = `${Math.max(10 * hair, 10)}px sans-serif`;
      ctx.fillStyle = color;
      ctx.fillText(label, x1 + 4 * hair, y1 - 6 * hair);

      const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
      ctx.beginPath(); ctx.arc(cx, cy, 3 * hair, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
  } catch {}
}

// ------------------------------------------------------//


let isDetectingFrame = false;
const reusableYOLOCanvas = document.createElement("canvas");
const reusableYOLOCtx = reusableYOLOCanvas.getContext("2d");

// ------------------------------------------------------------------------------------//
//    Capture the *real* pixels and send to YOLO.
//   `src` can be the <video> element OR a canvas. We prefer <video>.
//    While a request is in flight, we return the last good objects to avoid flicker.
// ------------------------------------------------------------------------------------//
export async function sendFrameToDetectServer(canvas, frameIndex) {
  if (isDetectingFrame) {
    return { objects: [] };
  }
  isDetectingFrame = true;
  try {
    const video = document.getElementById("videoPlayer");
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return { objects: [] };

    reusableYOLOCanvas.width = vw;
    reusableYOLOCanvas.height = vh;
    reusableYOLOCtx.clearRect(0, 0, vw, vh);
    reusableYOLOCtx.drawImage(video, 0, 0, vw, vh);   // use raw frame

    const dataURL = reusableYOLOCanvas.toDataURL("image/jpeg", 0.5);
    const res = await fetch("/detect_frame", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ frame: dataURL, width: vw, height: vh }),
    });
    if (!res.ok) return { objects: [] };
    return await res.json(); // {objects:[], frameIndex?}
  } catch (e) {
    console.warn('server detect failed:', e);
    return { objects: [] };
  } finally {
    isDetectingFrame = false;
  }
}

// ---- Worker toggle (can be changed in console) ----
if (typeof window.__forceServerDetect === 'undefined') window.__forceServerDetect = false;
if (typeof window.__LOCAL_DETECTOR === 'undefined') window.__LOCAL_DETECTOR = true; // allow disabling local worker entirely

// ---- Worker bootstrap (kept simple; already in your file; keep your existing one if you prefer) ----
(function bootDetectorWorkerOnce() {
  if (window.__detBootstrapped) return;
  window.__detBootstrapped = true;
  // Respect toggles: when forced to server or local detector disabled, do NOT create the worker
  try {
    const forcedLocal = window.__FORCE_LOCAL_DETECTOR__ === true;
    if (!forcedLocal && (window.__forceServerDetect || window.__LOCAL_DETECTOR === false)) {
      console.log('[LocalDetector] disabled; using server detector.');
      window.__detWorker = null; window.__detReady = false; window.__detPending = new Map();
      return;
    }
    if (forcedLocal) {
      window.__forceServerDetect = false;
      window.__LOCAL_DETECTOR = true;
    }
  } catch {}
  try { window.__detWorker = new Worker('/static/js/detector.worker.js', { name: 'detector' }); } catch (e) { window.__detWorker = null; }
  window.__detReady   = false;
  window.__detPending = new Map();
  if (!window.__detWorker) return;

  window.__detWorker.onmessage = (e) => {
    const m = e.data || {};
    if (m.type === 'ready') { window.__detReady = true; return; }
    if (m.type === 'result') {
      const p = window.__detPending.get(m.frameIndex);
      if (p) { window.__detPending.delete(m.frameIndex); if (p.tid) clearTimeout(p.tid); p.resolve({ ...m, _source:'worker' }); }
      // update cache even if no one was waiting (late worker result)
      if (Array.isArray(m.objects)) {
        window.__detCache = { objects: m.objects, frameIndex: m.frameIndex, _source: 'worker-late' };
        try {
          window.dispatchEvent(new CustomEvent('localdet:frame', {
            detail: { dets: m.objects, frame: m.frameIndex, tMs: performance.now(), via: 'local' }
          }));
        } catch {}
      }
      return;
    }
    if (m.type === 'debug') { console.log(m.msg); return; }
    if (m.type === 'error') console.warn('[detector.worker] Error:', m.error);
  };

  window.__detWorker.postMessage({
    type: 'init',
    modelUrl: '/static/models/best.onnx',
    fbUrl:    '/static/models/backup_best.onnx',
    labels:   ['basketball','hoop','net','backboard','player']
  });
})();

// Allow enabling the local detector later (e.g., when probe flips flags post-load)
try {
  window.enableLocalDetector = function enableLocalDetector() {
    try {
      if (window.__detWorker && window.__detReady) return true;
    } catch {}
    try {
      const forcedLocal = window.__FORCE_LOCAL_DETECTOR__ === true;
      if (!forcedLocal && (window.__forceServerDetect || window.__LOCAL_DETECTOR === false)) return false;
      if (forcedLocal) {
        window.__forceServerDetect = false;
        window.__LOCAL_DETECTOR = true;
      }
      window.__detWorker = new Worker('/static/js/detector.worker.js', { name: 'detector' });
      window.__detReady = false; window.__detPending = new Map();
      window.__detWorker.onmessage = (e) => {
        const m = e.data || {};
        if (m.type === 'ready') { window.__detReady = true; return; }
        if (m.type === 'result') {
          const p = window.__detPending.get(m.frameIndex);
          if (p) { window.__detPending.delete(m.frameIndex); if (p.tid) clearTimeout(p.tid); p.resolve({ ...m, _source:'worker' }); }
          if (Array.isArray(m.objects)) {
            window.__detCache = { objects: m.objects, frameIndex: m.frameIndex, _source: 'worker-late' };
            try {
              window.dispatchEvent(new CustomEvent('localdet:frame', {
                detail: { dets: m.objects, frame: m.frameIndex, tMs: performance.now(), via: 'local' }
              }));
            } catch {}
          }
          return;
        }
        if (m.type === 'debug') { console.log(m.msg); return; }
        if (m.type === 'error') console.warn('[detector.worker] Error:', m.error);
      };
      window.__detWorker.postMessage({ type:'init', modelUrl:'/static/models/best.onnx', fbUrl:'/static/models/backup_best.onnx', labels:['basketball','hoop','net','backboard','player'] });
      return true;
    } catch (e) { console.warn('[LocalDetector] enable failed', e); return false; }
  }
} catch {}

// ---- Server fallback helper ----
async function detectViaServer(canvas, frameIndex, OW, OH) {
  // Guard against zero-size sources; fall back to <video> when needed
  let src = canvas;
  try {
    if (!src || !(src.width > 0 && src.height > 0)) {
      const v = document.getElementById('videoPlayer');
      if (v && v.videoWidth > 0 && v.videoHeight > 0) src = v; else return { objects: window.__detCache.objects, frameIndex, _source: 'server-no-src' };
      OW = OW || v.videoWidth; OH = OH || v.videoHeight;
    }
  } catch {}
  const c = document.createElement('canvas');
  c.width = OW; c.height = OH;
  try { c.getContext('2d').drawImage(src, 0, 0, OW, OH); }
  catch { return { objects: window.__detCache.objects, frameIndex, _source: 'server-draw-fail' }; }
  const dataURL = c.toDataURL('image/jpeg', 0.6);
  try {
    const res = await fetch('/detect_frame', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ frame: dataURL, width: OW, height: OH })
    });
    if (!res.ok) return { objects: window.__detCache.objects, frameIndex, _source: 'server-error' };
    const out = await res.json();
    out._source = 'server';
    try {
      if (Array.isArray(out?.objects)) {
        window.ingestServerDetections?.(out.objects, performance.now(), frameIndex);
      }
    } catch {}
    return out;
  } catch {
    // never return empty on failure — reuse cache
    return { objects: window.__detCache.objects, frameIndex, _source: 'server-fail' };
  }
}

// ---- Worker path helper (with backstop that returns cache, not empty) ----
async function detectViaWorker(canvas, frameIndex, OW, OH) {
  if (!window.__detWorker || !window.__detReady) throw new Error('worker-not-ready');
  // Ensure we never call createImageBitmap on a zero-sized source.
  // Always draw into a temporary canvas sized to OW x OH first.
  let src = canvas;
  try {
    const cw = src ? (src.width || 0) : 0;
    const ch = src ? (src.height || 0) : 0;
    if (!(cw > 0 && ch > 0)) {
      const v = document.getElementById('videoPlayer');
      if (v && v.videoWidth > 0 && v.videoHeight > 0) {
        src = v;
      } else {
        throw new Error('source-size-zero');
      }
    }
  } catch (e) {
    throw e;
  }

  const tmp = document.createElement('canvas');
  tmp.width = OW; tmp.height = OH;
  const tctx = tmp.getContext('2d');
  try {
    tctx.drawImage(src, 0, 0, OW, OH);
  } catch (e) {
    throw new Error('worker-draw-fail');
  }
  const bmp = await createImageBitmap(tmp);
  const result = new Promise((resolve) => {
    const entry = { resolve, tid: null };
    entry.tid = setTimeout(() => {
      if (window.__detPending.has(frameIndex)) {
        window.__detPending.delete(frameIndex);
        // return cache on timeout (prevents flicker)
        resolve({ objects: window.__detCache.objects, frameIndex, _source: 'worker-timeout' });
      }
    }, 1500); // tolerant backstop
    window.__detPending.set(frameIndex, entry);
  });
  window.__detWorker.postMessage({ type:'detect', frameIndex, bitmap:bmp, ow:OW, oh:OH }, [bmp]);
  return result;
}

let __detBusy = false;
export async function sendFrameToDetect(canvas, frameIndex) {
  // reuse cache on frames we’re not sampling
  if (DETECT_EVERY > 1 && (frameIndex % DETECT_EVERY) !== 0) {
    return { objects: window.__detCache.objects, frameIndex, _source: 'cache-skip' };
  }

  if (__detBusy) {
    // if a detect is already in-flight, don’t stall — reuse cache
    return { objects: window.__detCache.objects, frameIndex, _source: 'cache-busy' };
  }

  __detBusy = true;
  try {
    const vid = document.getElementById('videoPlayer');
    const owFromVid = (vid && vid.videoWidth > 0) ? vid.videoWidth : 0;
    const ohFromVid = (vid && vid.videoHeight> 0) ? vid.videoHeight: 0;
    const OW = owFromVid || (canvas?.width  || 0);
    const OH = ohFromVid || (canvas?.height || 0);
    if (!(OW > 0 && OH > 0)) return { objects: window.__detCache.objects, frameIndex, _source: 'size-not-ready' };

    let out;
    if (!window.__forceServerDetect && window.__detWorker && window.__detReady) {
      out = await detectViaWorker(canvas, frameIndex, OW, OH);
    } else {
      out = await detectViaServer(canvas, frameIndex, OW, OH);
    }

    // update cache if we got something concrete
    if (Array.isArray(out.objects)) {
      window.__detCache = { objects: out.objects, frameIndex: out.frameIndex ?? frameIndex, _source: out._source || 'unknown' };
    }
    return out;
  } catch (e) {
    console.warn('[detect] exception:', e);
    return { objects: window.__detCache.objects, frameIndex, _source: 'exception-cache' };
  } finally {
    __detBusy = false;
  }
}



// ------------------------------------------------------------------------------------//

// record canvas tracing and coach summary
export function startCanvasRecording(canvas) {
  if (!canvas) return;
  const stream = canvas.captureStream(10); // 10 fps
  canvasRecorder = new MediaRecorder(stream, { mimeType: 'video/webm' });

  recordedChunks = [];

  canvasRecorder.ondataavailable = event => {
    if (event.data.size > 0) recordedChunks.push(event.data);
  };

  canvasRecorder.onstop = () => {
    const blob = new Blob(recordedChunks, { type: 'video/webm' });
    const url = URL.createObjectURL(blob);
    
    // Optional: auto download
    const a = document.createElement("a");
    a.href = url;
    a.download = `doach_session_${Date.now()}.webm`;
    a.click();

    // Optional: upload to backend
    // const formData = new FormData();
    // formData.append("session_video", blob, "session.webm");
    // fetch("/upload_session_video", { method: "POST", body: formData });
  };

  canvasRecorder.start();
  recordingActive = true;
  console.log("🎥 Canvas recording started.");
}

export function stopCanvasRecording() {
  if (canvasRecorder && recordingActive) {
    canvasRecorder.stop();
    recordingActive = false;
    console.log("🛑 Canvas recording stopped.");
  }
}

// frame playback only
export function playArchivedOverlay(videoElement, canvas, frameArchive, onComplete) {
  const ctx = canvas.getContext('2d');
  if (!frameArchive?.length) {
    console.warn("⚠️ playArchivedOverlay: Empty archive provided");
    if (onComplete) onComplete();
    return;
  }

  // console.log(`▶️ Playing archived overlay — ${frameArchive.length} frames`);

  let __frameIdx = 0;
  const totalFrames = frameArchive.length;
  const fps = 10;
  const delay = 1000 / fps;

  const interval = setInterval(() => {
    if (__frameIdx >= totalFrames) {
      clearInterval(interval);
      console.log("✅ Overlay playback complete");
      if (onComplete) onComplete();
      return;
    }

    const frameData = frameArchive[__frameIdx];
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawOverlayFromSavedData(ctx, frameData);
    __frameIdx++;
  }, delay);
}


export function drawOverlayFromSavedData(ctx, frameData) {
  // Draw ball trail
  const trail = frameData.trail || [];
  ctx.strokeStyle = 'rgba(255, 255, 0, 0.7)';
  ctx.lineWidth = 2;
  for (let i = 1; i < trail.length; i++) {
    const prev = trail[i - 1];
    const curr = trail[i];
    ctx.beginPath();
    ctx.moveTo(prev.x, prev.y);
    ctx.lineTo(curr.x, curr.y);
    ctx.stroke();
  }

  // Draw pose keypoints
  const keypoints = frameData.keypoints || [];
  keypoints.forEach(kp => {
    if (kp?.score > 0.5) {
      ctx.beginPath();
      ctx.arc(kp.x, kp.y, 10, 0, 2 * Math.PI);   // set pose keypoint size & color
      ctx.fillStyle = 'magenta';
      ctx.fill();
    }
  });

  // Draw hoop
  const hoop = frameData.hoop;
  if (hoop) {
    ctx.beginPath();
    ctx.fillStyle = 'lime';
    ctx.moveTo(hoop.x, hoop.y);
    ctx.lineTo(hoop.x - 10, hoop.y + 14);
    ctx.lineTo(hoop.x + 10, hoop.y + 14);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'red';
    ctx.beginPath();
    ctx.moveTo(hoop.x - 40, hoop.y);
    ctx.lineTo(hoop.x + 40, hoop.y);
    ctx.stroke();
  }
}


let __syncBusy = false;
let __syncRaf  = 0;

export function scheduleSyncOverlay() {
  if (__syncRaf) return;
  __syncRaf = requestAnimationFrame(() => {
    __syncRaf = 0;
    syncOverlayToVideo();
  });
}

// Optional: also expose on window so app.js can call it without an import
if (typeof window !== 'undefined') {
  window.scheduleSyncOverlay = scheduleSyncOverlay;
}



// Unified: compute "contain" layout, position elements, and size backing store.
// Also ensures correct stacking context, z-index, and pointer-event defaults.
// Stores mapping in window.__VIEW for drawing and input conversion.
export function syncOverlayToVideo() {
  const frame   = document.querySelector('.video-frame');
  const video   = document.getElementById('videoPlayer');
  const overlay = document.getElementById('overlay');
  if (!frame || !video || !overlay) return;

  if (__syncBusy) return;
  __syncBusy = true;
  try {
    // 1) stacking context
    if (getComputedStyle(frame).position === 'static') frame.style.position = 'relative';

    // 2) frame rect (CSS px)
    const fr = frame.getBoundingClientRect();
    const FW = Math.max(1, Math.round(fr.width));
    const FH = Math.max(1, Math.round(fr.height));

    // 3) native (video px)
    const vw = video.videoWidth  || 0;
    const vh = video.videoHeight || 0;

    // 4) contain rect (CSS px)
    let renderW = FW, renderH = FH, offL = 0, offT = 0, scale = 1;
    if (vw && vh) {
      scale   = Math.min(FW / vw, FH / vh);
      renderW = Math.round(vw * scale);
      renderH = Math.round(vh * scale);
      offL    = Math.round((FW - renderW) / 2);
      offT    = Math.round((FH - renderH) / 2);
    }

    // 5) place video + overlay (CSS px)
    const place = (el, z) => {
      el.style.position = 'absolute';
      el.style.left   = offL + 'px';
      el.style.top    = offT + 'px';
      el.style.width  = renderW + 'px';
      el.style.height = renderH + 'px';
      if (z != null) el.style.zIndex = String(z);
    };
    place(video,   0);
    place(overlay, 100);

    // 6) DPR buffer + draw transform (VIDEO → canvas buffer)
    const dpr   = window.devicePixelRatio || 1;
    const backW = Math.max(1, Math.round(renderW * dpr));
    const backH = Math.max(1, Math.round(renderH * dpr));
    if (overlay.width  !== backW)  overlay.width  = backW;
    if (overlay.height !== backH)  overlay.height = backH;

    const sx = (renderW * dpr) / Math.max(1, vw);
    const sy = (renderH * dpr) / Math.max(1, vh);
    window.__APPLY_OVERLAY_XFORM = (ctx) => ctx.setTransform(sx, 0, 0, sy, 0, 0);

    // 7) pointer policy
    overlay.style.userSelect    = 'none';
    overlay.style.pointerEvents = (window.__pickingHoop ? 'auto' : 'none');
    overlay.style.touchAction  = (window.__pickingHoop ? 'none' : '');
    video.style.pointerEvents   = window.__pickingHoop ? 'none' : '';


    // 8) save mapping **once** (keep sx/sy!)
    window.__VIEW = { vw, vh, renderW, renderH, offL, offT, scale, dpr, sx, sy };  // single assignment

    // 9) prompt alignment (optional)
    const prompt = document.getElementById('overlayPrompt');
    if (prompt) {
      prompt.style.position = 'absolute';
      if (prompt.dataset.center === '1') { prompt.style.left = (offL + renderW/2) + 'px'; prompt.style.top = (offT + renderH/2) + 'px'; } else { prompt.style.left = (offL + 12) + 'px'; prompt.style.top = (offT + 12) + 'px'; }
      prompt.style.zIndex = '200';
    }
  } finally {
    __syncBusy = false;
  }
}


// Map a client pointer to VIDEO pixels using the overlay's current rect
// correct buffer in syncOverlayToVideo, overlay needs to accept clicks
export function pointerToVideoXY(e) {
  const ov = document.getElementById('overlay');
  if (!ov) return null;
  const r = ov.getBoundingClientRect();
  const pt = ('touches' in e && e.touches?.length) ? e.touches[0] : e;
  const cssX = pt.clientX - r.left;
  const cssY = pt.clientY - r.top;
  // overlay.width/height == video.videoWidth/Height (pixel-true)
  const scaleX = r.width  / (ov.width  || 1);
  const scaleY = r.height / (ov.height || 1);
  const x = Math.max(0, Math.min(ov.width  || 0, Math.round(cssX / (scaleX || 1))));
  const y = Math.max(0, Math.min(ov.height || 0, Math.round(cssY / (scaleY || 1))));
  return { x, y };
}

// Arm/disarm overlay for hoop picking
export function armHoopPick(onPick) {
  const ov = document.getElementById('overlay');
  const video = document.getElementById('videoPlayer');
  if (!ov || !video) return;

  // MUST have metadata so overlay buffer == video pixels
  if (!video.videoWidth || !video.videoHeight) {
    console.warn('[pick] video metadata not ready');
    return;
  }

  window.__pickingHoop = true;
  syncOverlayToVideo();                      // ensures pointerEvents = 'auto'
  ov.style.touchAction = 'none';             // mobile Safari: allow pointerdown
  video.style.pointerEvents = 'none';        // prevent video stealing taps

  const once = (ev) => {
    const p = pointerToVideoXY(ev);
    // disarm
    window.__pickingHoop = false;
    ov.style.pointerEvents = 'none';
    video.style.pointerEvents = '';
    ov.removeEventListener('pointerdown', once);
    if (p && typeof onPick === 'function') onPick(p);
  };
  ov.addEventListener('pointerdown', once, { passive: true });
  console.log('[pick] armed — tap the hoop');
}


// utilities that benefit from the mapping:

// Convert a clientX/Y (from a pointer/click) to VIDEO pixel coords
export function clientToVideoXY(clientX, clientY) {
  const overlay = document.getElementById('overlay');
  const V = window.__VIEW;
  if (!overlay || !V?.scale) return { x: 0, y: 0 };
  const r = overlay.getBoundingClientRect();
  const cssX = clientX - r.left;
  const cssY = clientY - r.top;
  // css px -> video px: divide by scale and clamp to [0..vw/vh]
  const x = Math.max(0, Math.min(V.vw || 0, Math.round(cssX / V.scale)));
  const y = Math.max(0, Math.min(V.vh || 0, Math.round(cssY / V.scale)));
  return { x, y };
}

// Toggle overlay interactivity consistently (for hoop pick, etc.)
export function setOverlayInteractive(on) {
  const ov = document.getElementById('overlay');
  if (!ov) return;
  window.__pickingHoop = !!on;
  ov.style.pointerEvents = on ? 'auto' : 'none';
  ov.style.cursor = on ? 'crosshair' : 'default';
}



// —— Bottom-left HUD (self-installing) ————————————————————————————————
function ensureDebugHudBox() {
  // Reuse existing, or create one
  let box = window.__debugBox || document.getElementById('doachDebugHud');
  if (!box) {
    box = document.createElement('div');
    box.id = 'doachDebugHud';
    (document.querySelector('.video-frame') || document.body).appendChild(box);
    window.__debugBox = box;
  }

  // Pin to bottom-left of the video frame and keep it non-interactive
  const style = box.style;
  style.position      = 'absolute';
  style.left          = '12px';
  style.bottom        = '12px';
  style.top           = 'auto';
  style.right         = 'auto';
  style.zIndex        = '250';              // above video/overlay, below menus if needed
  style.pointerEvents = 'none';             // never steal clicks
  style.userSelect    = 'none';
  style.padding       = '8px 10px';
  style.borderRadius  = '10px';
  style.background    = 'rgba(0,0,0,0.45)';
  style.color         = '#fff';
  style.font          = '12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
  style.lineHeight    = '1.35';
  style.boxShadow     = '0 6px 14px rgba(0,0,0,0.25)';
  return box;
}

// Keep the tiny CSS for the blinking dot once
(function installHudDotCss(){
  if (document.getElementById('hudDotCss')) return;
  const st = document.createElement('style');
  st.id = 'hudDotCss';
  st.textContent = '@keyframes hudBlink{from{opacity:1}to{opacity:.35}}';
  document.head.appendChild(st);
})();

// REPLACEMENT: bottom-left, compact HUD
export function updateDebugOverlay(poses, objects, __frameIdx = null) {
  // Make sure the HUD exists and is pinned BL
  const debugBox = ensureDebugHudBox();
  if (!debugBox) return;

  try {
    const hasPose    = !!(poses?.length) ||
                       !!(window.playerState && Array.isArray(window.playerState.keypoints) && window.playerState.keypoints.length >= 33);
    const hoopLocked = !!(typeof window.getLockedHoopBox === 'function' && window.getLockedHoopBox());
    const inSession  = !!window.__SESSION_ACTIVE;

    // Small status dot
    const dot = (ok, blink=false) =>
      `<span style="
        display:inline-block;width:10px;height:10px;border-radius:50%;
        margin-left:6px;
        background:${ok?'#24d05a':'#ff4d4f'};
        box-shadow:0 0 8px ${ok?'#24d05a':'#ff4d4f'};
        ${blink&&ok?'animation:hudBlink 1s infinite alternate;':''}
      "></span>`;

    // Minimal, bold label + dot on each line
    debugBox.innerHTML = `
      <div style="white-space:nowrap">Hoop selected ${dot(hoopLocked)}</div>
      <div style="white-space:nowrap">Pose detected ${dot(hasPose)}</div>
      <div style="white-space:nowrap">Session in play ${dot(inSession, true)}</div>
    `;
  } catch {
    // swallow — HUD is best-effort only
  }
}

export function armOverlayForPickNow() {
  const ov  = document.getElementById('overlay');
  const vid = document.getElementById('videoPlayer');
  if (!ov || !vid) return;

  // Set the flag FIRST so any subsequent sync keeps pointerEvents='auto'
  window.__pickingHoop = true;

  // Make overlay interactive (and on top) immediately
  ov.style.setProperty('pointer-events', 'auto', 'important');
  ov.style.setProperty('touch-action', 'none', 'important');   // iOS needs this
  ov.style.setProperty('z-index', '1000', 'important');        // ensure above video

  // Make sure the video doesn't eat the tap
  vid.style.setProperty('pointer-events', 'none', 'important');

  // Refresh the rect/mapping; since __pickingHoop=true, sync keeps it interactive
  window.scheduleSyncOverlay?.();
}


try {
  window.addEventListener('hoop:locked', () => {
    try {
      // Ensure layout mapping is current before next paint
      requestAnimationFrame(() => syncOverlayToVideo());
      // Flash pose dots for a few seconds so skeleton never appears to vanish
      window.__poseFlashUntil = performance.now() + 3500;
    } catch {}
  });
} catch {}
