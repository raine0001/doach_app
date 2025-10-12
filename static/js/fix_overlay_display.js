// fix_overlay_display.js GÇö UI-only, conflict-free, iOS-safe.
// Owns: overlay sizing, drawing, optional debug HUD, detection plumbing.
// Does NOT: emit releases, bump shot counts, record clips, end sessions, or post shots.

import { drawPoseSkeleton, drawWristTrail } from './player_tracker.js';
import { drawHoopProximityDebug, drawShotTubeDebug } from './shot_logger.js';
import { getLockedHoopBox, drawHoopMarker } from '/static/arc_mm/hoop_tracker.js';
import { drawBallTrails, drawBallArc } from './ball_tracker.js';
import { drawFinalShotSummary } from './shot_utils.js';

/* ---------------------- globals (read-only toggles) ---------------------- */
window.SHOW_POSE_LINES   = (window.SHOW_POSE_LINES   ?? false);
window.SHOW_RELEASE_GATE = (window.SHOW_RELEASE_GATE ?? false);

/* -------------------------- CSS & overlay wiring ------------------------- */
export function ensureOverlayCss() {
  const ov  = document.getElementById('overlay');
  const vid = document.getElementById('videoPlayer');
  if (!ov || !vid) return;

  const anchor = vid.parentElement || document.body;
  if (getComputedStyle(anchor).position === 'static') anchor.style.position = 'relative';

  ov.style.position = 'absolute';
  ov.style.left = '0';
  ov.style.top  = '0';
  ov.style.userSelect    = 'none';
  ov.style.pointerEvents = (window.__pickingHoop ? 'auto' : 'none');
  ov.style.zIndex        = '100';

  // iOS autoplay niceties
  vid.setAttribute('playsinline','');
  vid.autoplay = true;
  vid.muted    = true;
}

export function lockOverlayToVideo() { try { return syncOverlayToVideo(); } catch {} }
try {
  if (typeof window.ensureOverlayCss !== 'function') window.ensureOverlayCss = ensureOverlayCss;
  if (typeof window.lockOverlayToVideo !== 'function') window.lockOverlayToVideo = lockOverlayToVideo;
} catch {}

/* ----------------------------- Overlay modes ----------------------------- */
function paintCleanOverlayOnce() {
  try {
    const overlay = document.getElementById('overlay');
    const video   = document.getElementById('videoPlayer');
    if (!overlay || !video || !window.__VIEW) return false;
    const ctx = overlay.getContext('2d', { willReadFrequently: true });
    if (!ctx) return false;

    // clear and set VIDEO transform
    ctx.setTransform(1,0,0,1,0,0);
    ctx.clearRect(0,0,overlay.width,overlay.height);
    window.__APPLY_OVERLAY_XFORM?.(ctx);

    // pick the best available trail to render a static arc
    const bs = (window.ballState || {});
    const frozenTrail = (Array.isArray(bs.frozenShots) && bs.frozenShots.length && Array.isArray(bs.frozenShots.at(-1)?.trail)) ? bs.frozenShots.at(-1).trail : [];
    const shotTrail   = (!frozenTrail.length && Array.isArray(bs.shots) && bs.shots.length && Array.isArray(bs.shots.at(-1)?.trail)) ? bs.shots.at(-1).trail : [];
    const arcTrail    = (window.ballArc && Array.isArray(window.ballArc.trail)) ? window.ballArc.trail : [];
    const liveTrail   = Array.isArray(bs.trail) ? bs.trail : [];
    const choices = [frozenTrail, shotTrail, arcTrail, liveTrail].sort((a,b)=>(b?.length||0)-(a?.length||0));
    let base = choices[0] || [];

    if (!base.length) {
      // synthesize an arc near the hoop so "clean" has pixels
      const H = getLockedHoopBox?.(); if (!H) return false;
      const w = Math.max(60, H.w || H.width || 120);
      const h = Math.max(40, H.h || H.height || 80);
      const cx = Number.isFinite(H.cx) ? H.cx : (H.anchor==='topleft' ? (H.x + w/2) : H.x);
      const cy = Number.isFinite(H.cy) ? H.cy : (H.anchor==='topleft' ? (H.y + h/2) : H.y);
      const rimTop = cy - h/2;
      const p0 = { x: cx - w*3.0, y: rimTop + h*1.8 };
      const p1 = { x: cx - w*1.4, y: rimTop - h*1.0 };
      const p2 = { x: cx,         y: rimTop + h*0.2 };
      const N  = 40;
      const synth = [p0];
      for (let i=1;i<=N;i++){
        const t=i/N; const ax=(1-t)*p0.x + t*p1.x, ay=(1-t)*p0.y + t*p1.y; const bx=(1-t)*p1.x + t*p2.x, by=(1-t)*p1.y + t*p2.y;
        synth.push({ x:(1-t)*ax + t*bx, y:(1-t)*ay + t*by });
      }
      base = synth;
    }

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

    window.__overlayArcDrawnCount = Math.max(window.__overlayArcDrawnCount||0, dense.length);
    window.__overlayLastTrailMode  = 'arc';
    window.__overlayLastTrailInput = 'clean-once';
    window.__cleanPaintReady = true;
    return true;
  } catch { return false; }
}

export function setOverlayMode(mode = 'live') {
  try {
    window.__overlayMode = String(mode || 'live').toLowerCase();
    if (window.__overlayMode === 'clean') {
      window.__overlayCleanDrawn = false;
      const ok = paintCleanOverlayOnce();
      if (ok) { window.__overlayCleanDrawn = true; window.__overlayFreeze = true; }
      clearTimeout(window.__overlayCleanRetryTimer);
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

// Auto-toggle visuals on real release/summary (visual only; no counters)
(function wireOverlayAutoMode(){
  if (window.__overlayAutoWired) return; window.__overlayAutoWired = true;
  window.addEventListener('shot:release', () => {
    try {
      const mode = String(window.__overlayMode || 'live');
      if (window.__SESSION_ACTIVE) return;
      window.__overlayFreeze = false;
      window.__overlayCleanDrawn = false;
      if (mode !== 'debug' && mode !== 'coach') setOverlayMode('arc-only');
    } catch {}
  });
  window.addEventListener('shot:summary', () => {
    try {
      const mode = String(window.__overlayMode || 'live');
      if (window.__SESSION_ACTIVE) return;
      if (mode !== 'debug' && mode !== 'coach') {
        setOverlayMode('clean');
        const ok = paintCleanOverlayOnce();
        if (ok) { window.__overlayCleanDrawn = true; window.__overlayFreeze = true; }
      }
    } catch {}
  });
})();

/* --------------------------- Tracer (optional) --------------------------- */
export function installOverlayTracer() {
  const ov = document.getElementById('overlay');
  if (!ov || ov.__tracerInstalled) return;
  ov.__tracerInstalled = true;

  const clientToVideoXY = (clientX, clientY) => {
    const V = window.__VIEW;
    if (!ov || !V?.scale) return { x: 0, y: 0 };
    const r = ov.getBoundingClientRect();
    const cssX = clientX - r.left;
    const cssY = clientY - r.top;
    const x = Math.max(0, Math.min(V.vw || 0, Math.round(cssX / V.scale)));
    const y = Math.max(0, Math.min(V.vh || 0, Math.round(cssY / V.scale)));
    return { x, y };
  };

  const onOverlayPD = (e) => {
    const cs = getComputedStyle(ov);
    const V  = window.__VIEW || {};
    const r  = ov.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
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
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    const videoXY = inside ? clientToVideoXY(e.clientX, e.clientY) : null;
    console.log('[doc:pointerdown]', { target: e.target?.tagName ?? '(unknown)', insideOverlay: inside, video: videoXY });
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

  console.log('=ƒº¬ overlay tracer installed');
}

export function removeOverlayTracer() {
  const ov = document.getElementById('overlay');
  if (ov?.__tracerCleanup) {
    ov.__tracerCleanup();
    console.log('=ƒº+ overlay tracer removed');
  }
}

/* -------------------------- Debug arc health log ------------------------- */
function __computeArcHealth(trail) {
  if (!Array.isArray(trail) || trail.length < 2) return { points: (trail?.length||0), continuity: 0, maxJump: 0 };
  const t = trail;
  const f0 = t[0].frame ?? 0, fN = t[t.length-1].frame ?? (t.length-1);
  const span = Math.max(1, (fN - f0 + 1));
  const covered = new Set(); for (const p of t) covered.add(p.frame ?? 0);
  let maxJump = 0; for (let i=1;i<t.length;i++){ const dx=(t[i].x - t[i-1].x)||0, dy=(t[i].y - t[i-1].y)||0; const d=Math.hypot(dx,dy); if (d>maxJump) maxJump=d; }
  return { points: t.length, continuity: covered.size / span, maxJump };
}

(function wireArcHealthOnce(){
  if (window.__arcHealthBound) return; window.__arcHealthBound = true;
  window.addEventListener('shot:summary', () => {
    try {
      const bs = (window.ballState||{});
      const trail = (bs.shots?.at?.(-1)?.trail) || (window.ballArc?.trail) || [];
      const H = __computeArcHealth(trail);
      const rel = bs.releaseFrame, enter = bs.proxEnterFrame, exit = bs.proxExitFrame;
      console.log('[arc-health]', { points: H.points, continuity: +H.continuity.toFixed(3), maxJump: +H.maxJump.toFixed(2), frames: { rel, enter, exit } });
    } catch (e) { console.warn('[arc-health] failed:', e); }
  });
  window.printArcHealth = function(){
    try {
      const bs=(window.ballState||{});
      const trail=(bs.shots?.at?.(-1)?.trail)||(window.ballArc?.trail)||[];
      const H=__computeArcHealth(trail);
      console.log('[arc-health:now]', H);
      return H;
    } catch(e){ console.warn(e); return null; }
  };
})();

/* -------------------------- Live overlay drawing ------------------------- */
export function initOverlay(canvas, detector = null) {
  if (!canvas) { console.warn('GÜán+Å initOverlay: no canvas'); return; }
  const video = document.getElementById('videoPlayer');

  window.__overlayMode = window.__overlayMode || 'live';
  window.__pickingHoop = !!window.__pickingHoop;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  canvas.style.position = 'absolute';
  if (video?.videoWidth && video?.videoHeight) {
    canvas.width  = video.videoWidth;
    canvas.height = video.videoHeight;
  } else {
    console.warn('GÜán+Å initOverlay: video metadata not ready; will resize later in drawLiveOverlay');
  }

  window.drawLiveOverlay   = drawLiveOverlay;
  window.getOverlayContext = () => ctx;
}

export function setOverlayClickable(on) {
  const overlay = document.getElementById('overlay');
  if (!overlay) return;
  overlay.style.pointerEvents = (window.__pickingHoop ? 'auto' : 'none');
  overlay.style.touchAction   = (window.__pickingHoop ? 'none' : '');
  overlay.style.cursor        = on ? 'crosshair' : 'default';
}
window.setOverlayClickable = setOverlayClickable;

function drawPoseMathHUD(ctx, playerState, vw, vh, sx, sy) {
  try {
    const wantLines = (window.SHOW_POSE_LINES === true);
    const explicit  = (typeof window.SHOW_RELEASE_GATE === 'boolean') ? window.SHOW_RELEASE_GATE : null;
    const wantHud   = (explicit === false) ? false
                    : (explicit === true)  ? true
                    : ((window.SHOW_POSE_MATH === true) || (window.DOACH_RELEASE_TRACE === true));
    if (!wantLines && !wantHud) return;

    // Resolve keypoints (current or last good)
    let kps = (playerState && Array.isArray(playerState.keypoints) && playerState.keypoints.length) ? playerState.keypoints : null;
    if (!kps) {
      const lastTS = Number(window.__lastPoseTS || 0);
      const holdMs = Number.isFinite(window.POSE_HOLD_MS) ? Number(window.POSE_HOLD_MS) : (window.__SESSION_ACTIVE ? 12000 : 2000);
      if (window.__lastPoseKP && (!lastTS || (performance.now() - lastTS) < holdMs)) kps = window.__lastPoseKP;
    }
    if (!Array.isArray(kps) || kps.length < 33) return;

    const side = (window.__LAST_GATE?.detail?.tests?.side === 'L') ? 'L' : 'R';
    const S = (side === 'L') ? 11 : 12, E = (side === 'L') ? 13 : 14, W = (side === 'L') ? 15 : 16;
    const sh = kps[S], el = kps[E], wr = kps[W];

    const yTol = Number(window.REL_Y_TOL || 12);
    const ySh  = Number(window.REL_SH_Y_TOL || 8);

    const wristAboveElbow    = (wr && el) ? (wr.y < (el.y - yTol)) : false;
    const wristAboveShoulder = (wr && sh) ? (wr.y < (sh.y - ySh)) : false;

    // elbow angle
    let elbowAngleDeg = 0, elbowExtended = false;
    if (sh && el && wr) {
      const v1x = sh.x - el.x, v1y = sh.y - el.y;
      const v2x = wr.x - el.x, v2y = wr.y - el.y;
      const dot = (v1x*v2x + v1y*v2y);
      const den = (Math.hypot(v1x,v1y)*Math.hypot(v2x,v2y) + 1e-6);
      elbowAngleDeg = Math.acos(Math.max(-1, Math.min(1, dot/den))) * 180 / Math.PI;
      const extMin = Number.isFinite(window.REL_ELBOW_EXT_MIN) ? window.REL_ELBOW_EXT_MIN : (Number(window.REL_CFG?.elbowExtMin) || 145);
      elbowExtended = Number.isFinite(elbowAngleDeg) && (elbowAngleDeg >= extMin);
    }

    const dx = Math.abs((wr?.x ?? 0) - (sh?.x ?? 0));
    const dy = Math.abs((sh?.y ?? 0) - (wr?.y ?? 0));
    const nearlyVertical = (dx < Number(window.REL_DX_MAX || 90)) && (dy > Number(window.REL_DY_MIN || 18));

    // draw minimal joints and optional lines
    const hair = 1 / Math.min(sx, sy);
    ctx.save();
    ctx.lineWidth = Math.max(2 * hair, 1.5);
    if (sh && el) { ctx.strokeStyle = '#00C8FF'; ctx.beginPath(); ctx.moveTo(sh.x, sh.y); ctx.lineTo(el.x, el.y); ctx.stroke(); }
    if (el && wr) { ctx.strokeStyle = '#FFA500'; ctx.beginPath(); ctx.moveTo(el.x, el.y); ctx.lineTo(wr.x, wr.y); ctx.stroke(); }

    if (wantLines && Number.isFinite(el?.y)) {
      ctx.strokeStyle = wristAboveElbow ? 'rgba(0,200,0,0.9)' : 'rgba(255,0,0,0.9)';
      const yLineEl = (el.y - yTol);
      ctx.beginPath(); ctx.moveTo(0, yLineEl); ctx.lineTo(vw, yLineEl); ctx.stroke();
    }
    if (wantLines && Number.isFinite(sh?.y)) {
      ctx.strokeStyle = 'rgba(0,150,255,0.9)';
      const yLineSh = (sh.y - ySh);
      ctx.beginPath(); ctx.moveTo(0, yLineSh); ctx.lineTo(vw, yLineSh); ctx.stroke();
    }

    const r = Math.max(4 * hair, 3);
    const dot = (p, color) => { if (!p) return; ctx.beginPath(); ctx.fillStyle = color; ctx.arc(p.x, p.y, r, 0, Math.PI*2); ctx.fill(); };
    dot(sh, '#00C8FF'); dot(el, elbowExtended ? '#00FF88' : '#FF0066'); dot(wr, wristAboveElbow ? '#00FF88' : '#FF0066');
    ctx.restore();

    if (!wantHud) return;

    // compact HUD with a few checks
    ctx.save();
    const x0 = vw - Math.max(260, 220) * hair;
    const y0 = 10 / hair;
    ctx.font = `${Math.max(11*hair, 10)}px system-ui`;
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(x0 - 6*hair, y0 - 4*hair, 260*hair, 100*hair);
    const line = (txt, ok) => {
      ctx.fillStyle = ok===true ? '#7CFC00' : ok===false ? '#FF6347' : '#FFFFFF';
      ctx.fillText(txt, x0, (drawPoseMathHUD._i++ * 14*hair) + y0);
    };
    drawPoseMathHUD._i = 0;
    ctx.fillStyle = '#FFFFFF'; ctx.fillText('Release Gate', x0, (drawPoseMathHUD._i++ * 14*hair) + y0);
    line(`side: ${side==='L'?'Left':'Right'}`, true);
    line(`wrist>elbow: ${wristAboveElbow?'G£ô':'G£ù'}`, wristAboveElbow);
    line(`wrist>shoulder: ${wristAboveShoulder?'G£ô':'G£ù'}`, wristAboveShoulder);
    line(`elbowGëÑstrict: ${Math.round(elbowAngleDeg)}-¦`, elbowExtended);
    ctx.restore();
  } catch {}
}

function drawDetectionBoxes(ctx, objects, hair = 1) {
  if (!ctx || !Array.isArray(objects) || !objects.length) return;
  const colors = {
    basketball: '#ffb347',
    hoop: '#3cc3ff',
    net: '#c678ff',
    backboard: '#7dd3ff',
    player: '#6bff8a'
  };
  const lineW = Math.max(2.2 * hair, 2);
  const fontSize = Math.max(11 * hair, 10);
  ctx.save();
  ctx.lineWidth = lineW;
  ctx.font = `${fontSize}px system-ui, -apple-system, sans-serif`;
  ctx.textBaseline = 'top';

  for (const obj of objects) {
    if (!obj || !Array.isArray(obj.box) || obj.box.length !== 4) continue;
    const [x1, y1, x2, y2] = obj.box.map(Number);
    if (![x1, y1, x2, y2].every(Number.isFinite)) continue;
    const w = x2 - x1;
    const h = y2 - y1;
    if (!(w > 1 && h > 1)) continue;

    const label = String(obj.label || '').toLowerCase();
    const color = colors[label] || '#ffd966';
    ctx.strokeStyle = color;
    ctx.strokeRect(x1, y1, w, h);

    const conf = Number(obj.confidence ?? obj.score ?? NaN);
    const tag = label ? label[0].toUpperCase() + label.slice(1) : 'Object';
    const text = Number.isFinite(conf) ? `${tag} ${(conf * 100).toFixed(0)}%` : tag;
    const pad = 4 * hair;
    const metrics = ctx.measureText(text);
    const boxW = metrics.width + pad * 2;
    const boxH = fontSize + pad * 2;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(x1, y1 - boxH, boxW, boxH);
    ctx.fillStyle = '#fff';
    ctx.fillText(text, x1 + pad, y1 - boxH + pad);
  }

  ctx.restore();
}

export function drawLiveOverlay(objects = [], playerState) {
  const video   = document.getElementById('videoPlayer');
  const overlay = document.getElementById('overlay');
  if (!overlay || !video) return;

  const ctx = overlay.getContext('2d', { willReadFrequently: true });
  if (!ctx) return;

  // Ensure mapping (VIEW)
  let V = window.__VIEW || null;
  if (!V || !V.vw || !V.vh || !V.sx || !V.sy) { try { syncOverlayToVideo?.(); } catch {} V = window.__VIEW || null; }
  if (!V || !V.vw || !V.vh) {
    const vw = Math.max(1, video.videoWidth || overlay.width || 0);
    const vh = Math.max(1, video.videoHeight || overlay.height || 0);
    if (vw && vh) {
      if (overlay.width !== vw)  overlay.width  = vw;
      if (overlay.height !== vh) overlay.height = vh;
      const sx = 1, sy = 1;
      window.__VIEW = { vw, vh, renderW: vw, renderH: vh, offL:0, offT:0, scale:1, dpr:1, sx, sy };
      window.__APPLY_OVERLAY_XFORM = (c) => c.setTransform(sx, 0, 0, sy, 0, 0);
    }
  }
  const { vw, vh, sx, sy } = window.__VIEW || {};
  if (!vw || !vh || !sx || !sy) return;

  // Mode resolution
  let mode = String(window.__overlayMode || 'live').toLowerCase();
  if (window.__SESSION_ACTIVE && mode !== 'debug') mode = 'coach';
  if (mode === 'clean' && window.__overlayFreeze === true) {
    if (!window.__overlayCleanDrawn) { if (paintCleanOverlayOnce()) window.__overlayCleanDrawn = true; }
    return;
  }
  if (mode === 'clean') {
    if (window.__overlayCleanDrawn === true) return;
    if (paintCleanOverlayOnce()) { window.__overlayCleanDrawn = true; return; }
  }

  // clear and move to VIDEO coords
  ctx.setTransform(1,0,0,1,0,0);
  ctx.clearRect(0,0,overlay.width,overlay.height);
  window.__APPLY_OVERLAY_XFORM?.(ctx);

  const hair = 1 / Math.min(sx, sy);

  // optional watermark ping
  window.__overlayPaintCount = (window.__overlayPaintCount||0) + 1;

  // Pose math HUD (debug)
  drawPoseMathHUD(ctx, playerState, vw, vh, sx, sy);
  try { drawDetectionBoxes(ctx, objects, hair); } catch {}

  if (mode === 'coach') {
    ctx.setTransform(1,0,0,1,0,0);
    ctx.clearRect(0,0,overlay.width,overlay.height);
    window.__APPLY_OVERLAY_XFORM?.(ctx);
    try { drawHoopMarker?.(ctx, { always:true }); } catch {}
    try {
      // minimal pose dots or skeleton
      let kps = (playerState && Array.isArray(playerState.keypoints) && playerState.keypoints.length) ? playerState.keypoints : null;
      if (!kps) {
        const lastTS = Number(window.__lastPoseTS || 0);
        const holdMs = Number.isFinite(window.POSE_HOLD_MS) ? Number(window.POSE_HOLD_MS) : (window.__SESSION_ACTIVE ? 12000 : 2000);
        if (window.__lastPoseKP && (!lastTS || (performance.now() - lastTS) < holdMs)) kps = window.__lastPoseKP;
      }
      if (Array.isArray(kps) && kps.length >= 33) {
        drawPoseSkeleton?.(ctx, kps);
        drawWristTrail?.(ctx);
      }
    } catch {}
    // Background scoring hooks (visual only)
    try {
      const H = getLockedHoopBox?.();
      const hasTrail = (window.ballState?.trail?.length || 0) > 0;
      if (H && (hasTrail || (window.lastDetectedFrame?.objects?.length || 0) > 0)) {
        const fidx = Number(window.__AN_IDX || 0);
        window.scoringTick?.(fidx);
        window.checkShotConditions?.(window.ballState, H, fidx);
      }
    } catch {}
    try { drawDetectionBoxes(ctx, objects, hair); } catch {}
    return;
  }

  if (mode === 'arc-only') {
    // show rim briefly on lock, draw arc, show summary
    try { drawHoopMarker?.(ctx); } catch {}
    try { drawBallArc?.(ctx, { trimTop: (window.ARC_TRIM_TOP !== false), strictArc: true }); } catch {}
    try { drawFinalShotSummary?.(ctx); } catch {}
    return;
  }

  // Full overlay: pose + debug + arcs/trails
  try { drawHoopProximityDebug?.(ctx); } catch {}
  try { drawShotTubeDebug?.(ctx); } catch {}
  try { drawBallArc?.(ctx); } catch {}
  try { if ((window.PREF_SHOW?.trails) !== false) drawBallTrails?.(ctx); } catch {}
  try { drawDetectionBoxes(ctx, objects, hair); } catch {}

  // Final labels
  try { drawFinalShotSummary?.(ctx); } catch {}
}

/* ----------------------------- Detector plumbing ----------------------------- */
let isDetectingFrame = false;
const reusableYOLOCanvas = document.createElement('canvas');
const reusableYOLOCtx    = reusableYOLOCanvas.getContext('2d');
window.__detStartTimes    = window.__detStartTimes    || new Map();
window.__detLatencyHistory= window.__detLatencyHistory|| [];

export async function sendFrameToDetectServer(_canvas, frameIndex) {
  if (isDetectingFrame) return { objects: [] };
  isDetectingFrame = true;
  try {
    const video = document.getElementById('videoPlayer');
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return { objects: [] };

    reusableYOLOCanvas.width = vw;
    reusableYOLOCanvas.height = vh;
    reusableYOLOCtx.clearRect(0, 0, vw, vh);
    reusableYOLOCtx.drawImage(video, 0, 0, vw, vh);

    const dataURL = reusableYOLOCanvas.toDataURL('image/jpeg', 0.5);
    const res = await fetch('/detect_frame', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ frame: dataURL, width: vw, height: vh })
    });
    if (!res.ok) return { objects: [] };
    return await res.json();
  } catch (e) {
    console.warn('[detect:server] failed:', e);
    return { objects: [] };
  } finally { isDetectingFrame = false; }
}

if (typeof window.__forceServerDetect === 'undefined') window.__forceServerDetect = false;
if (typeof window.__LOCAL_DETECTOR   === 'undefined') window.__LOCAL_DETECTOR   = true;

(function bootDetectorWorkerOnce(){
  if (window.__detBootstrapped) return; window.__detBootstrapped = true;

  try {
    const forcedLocal = window.__FORCE_LOCAL_DETECTOR__ === true;
    if (!forcedLocal && (window.__forceServerDetect || window.__LOCAL_DETECTOR === false)) {
      console.log('[LocalDetector] disabled; using server detector.');
      window.__detWorker = null; window.__detReady = false; window.__detPending = new Map();
      return;
    }
    if (forcedLocal) { window.__forceServerDetect = false; window.__LOCAL_DETECTOR = true; }
  } catch {}

  const workerPath = (window.DETECTOR_WORKER_PATH && String(window.DETECTOR_WORKER_PATH)) || '/static/js/detector.worker.js';
  const modelUrl   = (window.DETECTOR_MODEL_URL && String(window.DETECTOR_MODEL_URL)) || '/static/models/best.onnx';
  const fbUrl      = (window.DETECTOR_FALLBACK_MODEL_URL && String(window.DETECTOR_FALLBACK_MODEL_URL)) || '/static/models/backup_best.onnx';
  const labels     = Array.isArray(window.DETECTOR_LABELS) && window.DETECTOR_LABELS.length ? window.DETECTOR_LABELS : ['basketball','hoop','net','backboard','player'];

  try {
    window.__detWorker = new Worker(workerPath, { name: 'detector' });
  } catch (e) { window.__detWorker = null; }
  window.__detReady   = false;
  window.__detPending = new Map();
  if (!window.__detWorker) return;

  const emitDetections = (dets, frameIndex, tMs, via='detector') => {
    const items = Array.isArray(dets) ? dets : [];
    // broadcast to app
    try { window.__DETECT_SOURCE = via; } catch {}
    try { window.dispatchEvent(new CustomEvent('objects:frame', { detail: { dets:items, frame:frameIndex, tMs, via } })); } catch {}

    // light stats
    const hist = window.__detLatencyHistory || (window.__detLatencyHistory = []);
    if (Number.isFinite(tMs) && window.__detStartTimes?.has(frameIndex)) {
      const dt = Math.max(0, tMs - window.__detStartTimes.get(frameIndex));
      window.__detStartTimes.delete(frameIndex);
      hist.push(dt); if (hist.length > 200) hist.shift();
    }

    // report ball point (best)
    try {
      const scoreOf = (d) => Number(d?.score ?? d?.confidence ?? 0);
      const labelOf = (d) => d?.label ?? d?.class ?? d?.type ?? null;
      const isBall  = (lab) => /\b(ball|basketball|sports_ball)\b/i.test(String(lab||''));
      let chosen = null, roi=null;
      for (const d of items) {
        const lab = labelOf(d);
        if (!isBall(lab)) continue;
        const sc  = scoreOf(d); if (!Number.isFinite(sc) || sc < Number(window.BALL_MIN_SCORE ?? 0.3)) continue;
        const box = d?.bbox ?? d?.box ?? d?.rect;
        let cx=null, cy=null;
        if (Array.isArray(box) && box.length===4) {
          const [x1,y1,x2,y2] = box.map(Number); if ([x1,y1,x2,y2].every(Number.isFinite)) { cx=(x1+x2)/2; cy=(y1+y2)/2; roi={x:Math.min(x1,x2),y:Math.min(y1,y2),w:Math.abs(x2-x1),h:Math.abs(y2-y1)}; }
        } else if (box) {
          const bx=Number(box.x ?? box.left ?? NaN), by=Number(box.y ?? box.top ?? NaN);
          const bw=Number(box.w ?? box.width ?? ((box.right ?? NaN)-(box.x ?? box.left ?? 0)));
          const bh=Number(box.h ?? box.height?? ((box.bottom?? NaN)-(box.y ?? box.top  ?? 0)));
          if ([bx,by,bw,bh].every(Number.isFinite)) { cx=bx+bw/2; cy=by+bh/2; roi={x:bx,y:by,w:bw,h:bh}; }
        }
        if (Number.isFinite(cx) && Number.isFinite(cy)) { chosen = { x:cx, y:cy, conf:sc }; break; }
      }
      if (chosen) {
        window.dispatchEvent(new CustomEvent('ball:point', { detail: { ...chosen, frame: frameIndex, tMs, via, roi } }));
      }
    } catch {}
  };

  window.__detWorker.onmessage = (e) => {
    const m = e.data || {};
    if (m.type === 'detector:ep') { try { window.__DETECT_EP = m.ep; } catch {}; return; }
    if (m.type === 'ready') { window.__detReady = true; return; }
    if (m.type === 'result') {
      const entry = window.__detPending.get(m.frameIndex);
      if (entry) { window.__detPending.delete(m.frameIndex); if (entry.tid) clearTimeout(entry.tid); entry.resolve({ ...m, _source:'worker' }); }
      if (Array.isArray(m.objects)) {
        window.__detCache = { objects:m.objects, frameIndex:m.frameIndex, _source:'worker-late' };
        const tMs = performance.now();
        emitDetections(m.objects, m.frameIndex, tMs, 'local');
      }
      return;
    }
    if (m.type === 'debug') { console.log(m.msg); return; }
    if (m.type === 'error') console.warn('[detector.worker] Error:', m.error);
  };

  try {
    window.__detWorker.postMessage({
      type: 'init',
      modelUrl: modelUrl,
      fbUrl:    fbUrl,
      labels:   labels
    });
  } catch {}
})();

export async function sendFrameToDetect(canvas, frameIndex) {
  // sample every frame by default
  if (isDetectingFrame) return { objects: window.__detCache?.objects || [], frameIndex, _source: 'cache-busy' };

  isDetectingFrame = true;
  try {
    const vid = document.getElementById('videoPlayer');
    const OW = vid?.videoWidth  || canvas?.width  || 0;
    const OH = vid?.videoHeight || canvas?.height || 0;
    if (!(OW>0 && OH>0)) return { objects: window.__detCache?.objects || [], frameIndex, _source: 'size-not-ready' };

    if (Number.isFinite(frameIndex)) window.__detStartTimes?.set(frameIndex, performance.now());

    // prefer local worker if ready
    if (!window.__forceServerDetect && window.__detWorker && window.__detReady) {
      const bmp = await (async () => {
        const tmp = document.createElement('canvas'); tmp.width = OW; tmp.height = OH;
        const tctx = tmp.getContext('2d'); const src = vid || canvas;
        tctx.drawImage(src, 0, 0, OW, OH);
        return await createImageBitmap(tmp);
      })();
      const result = new Promise((resolve) => {
        const entry = { resolve, tid: setTimeout(() => {
          if (window.__detPending.has(frameIndex)) {
            window.__detPending.delete(frameIndex);
            resolve({ objects: window.__detCache?.objects || [], frameIndex, _source: 'worker-timeout' });
          }
        }, 1500) };
        window.__detPending.set(frameIndex, entry);
      });
      window.__detWorker.postMessage({ type:'detect', frameIndex, bitmap:bmp, ow:OW, oh:OH }, [bmp]);
      return await result;
    }

    // server fallback
    return await sendFrameToDetectServer(canvas, frameIndex);
  } catch (e) {
    console.warn('[detect] exception:', e);
    try { window.__detStartTimes?.delete(frameIndex); } catch {}
    return { objects: window.__detCache?.objects || [], frameIndex, _source: 'exception-cache' };
  } finally {
    isDetectingFrame = false;
  }
}

/* ------------------------- Overlay utilities ------------------------- */
let __syncBusy = false, __syncRaf = 0;

export function scheduleSyncOverlay() {
  if (__syncRaf) return;
  __syncRaf = requestAnimationFrame(() => { __syncRaf = 0; syncOverlayToVideo(); });
}
if (typeof window !== 'undefined') window.scheduleSyncOverlay = scheduleSyncOverlay;

export function syncOverlayToVideo() {
  const frame   = document.querySelector('.video-frame') || document.getElementById('videoFrame') || document.body;
  const video   = document.getElementById('videoPlayer');
  const overlay = document.getElementById('overlay');
  if (!frame || !video || !overlay) return;

  if (__syncBusy) return; __syncBusy = true;
  try {
    if (getComputedStyle(frame).position === 'static') frame.style.position = 'relative';

    const fr = frame.getBoundingClientRect();
    const FW = Math.max(1, Math.round(fr.width));
    const FH = Math.max(1, Math.round(fr.height));

    const vw = video.videoWidth  || 0;
    const vh = video.videoHeight || 0;

    let renderW = FW, renderH = FH, offL = 0, offT = 0, scale = 1;
    if (vw && vh) {
      scale   = Math.min(FW / vw, FH / vh);
      renderW = Math.round(vw * scale);
      renderH = Math.round(vh * scale);
      offL    = Math.round((FW - renderW) / 2);
      offT    = Math.round((FH - renderH) / 2);
    }

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

    const dpr = window.devicePixelRatio || 1;
    const backW = Math.max(1, Math.round(renderW * dpr));
    const backH = Math.max(1, Math.round(renderH * dpr));
    if (overlay.width  !== backW) overlay.width  = backW;
    if (overlay.height !== backH) overlay.height = backH;

    const sx = (renderW * dpr) / Math.max(1, vw);
    const sy = (renderH * dpr) / Math.max(1, vh);
    window.__APPLY_OVERLAY_XFORM = (ctx) => ctx.setTransform(sx, 0, 0, sy, 0, 0);

    overlay.style.userSelect    = 'none';
    overlay.style.pointerEvents = (window.__pickingHoop ? 'auto' : 'none');
    overlay.style.touchAction   = (window.__pickingHoop ? 'none' : '');
    video.style.pointerEvents   = window.__pickingHoop ? 'none' : '';

    window.__VIEW = { vw, vh, renderW, renderH, offL, offT, scale, dpr, sx, sy };

    const prompt = document.getElementById('overlayPrompt');
    if (prompt) {
      prompt.style.position = 'absolute';
      if (prompt.dataset.center === '1') {
        prompt.style.left = (offL + renderW/2) + 'px';
        prompt.style.top  = (offT + renderH/2) + 'px';
      } else {
        prompt.style.left = (offL + 12) + 'px';
        prompt.style.top  = (offT + 12) + 'px';
      }
      prompt.style.zIndex = '200';
    }
  } finally { __syncBusy = false; }
}

export function pointerToVideoXY(e) {
  const ov = document.getElementById('overlay'); if (!ov) return null;
  const r = ov.getBoundingClientRect();
  const pt = ('touches' in e && e.touches?.length) ? e.touches[0] : e;
  const cssX = pt.clientX - r.left;
  const cssY = pt.clientY - r.top;
  const scaleX = r.width  / (ov.width  || 1);
  const scaleY = r.height / (ov.height || 1);
  const x = Math.max(0, Math.min(ov.width  || 0, Math.round(cssX / (scaleX || 1))));
  const y = Math.max(0, Math.min(ov.height || 0, Math.round(cssY / (scaleY || 1))));
  return { x, y };
}

export function armHoopPick(onPick) {
  const ov = document.getElementById('overlay');
  const video = document.getElementById('videoPlayer');
  if (!ov || !video) return;

  if (!video.videoWidth || !video.videoHeight) { console.warn('[pick] video metadata not ready'); return; }

  window.__pickingHoop = true;
  syncOverlayToVideo();
  ov.style.touchAction = 'none';
  video.style.pointerEvents = 'none';

  const once = (ev) => {
    const p = pointerToVideoXY(ev);
    window.__pickingHoop = false;
    ov.style.pointerEvents = 'none';
    video.style.pointerEvents = '';
    ov.removeEventListener('pointerdown', once);
    if (p && typeof onPick === 'function') onPick(p);
  };
  ov.addEventListener('pointerdown', once, { passive: true });
  console.log('[pick] armed, tap the hoop');
}

export function clientToVideoXY(clientX, clientY) {
  const overlay = document.getElementById('overlay');
  const V = window.__VIEW;
  if (!overlay || !V?.scale) return { x: 0, y: 0 };
  const r = overlay.getBoundingClientRect();
  const cssX = clientX - r.left;
  const cssY = clientY - r.top;
  const x = Math.max(0, Math.min(V.vw || 0, Math.round(cssX / V.scale)));
  const y = Math.max(0, Math.min(V.vh || 0, Math.round(cssY / V.scale)));
  return { x, y };
}

export function setOverlayInteractive(on) {
  const ov = document.getElementById('overlay');
  if (!ov) return;
  window.__pickingHoop = !!on;
  ov.style.pointerEvents = on ? 'auto' : 'none';
  ov.style.cursor = on ? 'crosshair' : 'default';
}

/* ----------------------------- Compact debug HUD ----------------------------- */
function ensureDebugHudBox() {
  let box = window.__debugBox || document.getElementById('doachDebugHud');
  if (!box) {
    box = document.createElement('div');
    box.id = 'doachDebugHud';
    (document.querySelector('.video-frame') || document.body).appendChild(box);
    window.__debugBox = box;
  }
  Object.assign(box.style, {
    position:'absolute', left:'12px', bottom:'12px',
    zIndex:'250', pointerEvents:'none', userSelect:'none',
    padding:'8px 10px', borderRadius:'10px',
    background:'rgba(0,0,0,0.45)', color:'#fff',
    font:'12px system-ui,-apple-system,Segoe UI,Roboto,sans-serif', lineHeight:'1.35',
    boxShadow:'0 6px 14px rgba(0,0,0,0.25)'
  });
  return box;
}

(function installHudDotCss(){
  if (document.getElementById('hudDotCss')) return;
  const st = document.createElement('style');
  st.id = 'hudDotCss';
  st.textContent = '@keyframes hudBlink{from{opacity:1}to{opacity:.35}}';
  document.head.appendChild(st);
})();

export function updateDebugOverlay(poses, _objects, _frameIdx = null) {
  const debugBox = ensureDebugHudBox(); if (!debugBox) return;
  const hasPose    = !!(poses?.length) ||
                     !!(window.playerState && Array.isArray(window.playerState.keypoints) && window.playerState.keypoints.length >= 33);
  const hoopLocked = !!getLockedHoopBox?.();
  const inSession  = !!window.__SESSION_ACTIVE;
  const dot = (ok, blink=false) =>
    `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;margin-left:6px;background:${ok?'#24d05a':'#ff4d4f'};box-shadow:0 0 8px ${ok?'#24d05a':'#ff4d4f'};${blink&&ok?'animation:hudBlink 1s infinite alternate;':''}"></span>`;
  debugBox.innerHTML = `
    <div style="white-space:nowrap">Hoop selected ${dot(hoopLocked)}</div>
    <div style="white-space:nowrap">Pose detected ${dot(hasPose)}</div>
    <div style="white-space:nowrap">Session in play ${dot(inSession,true)}</div>
  `;
}

export function armOverlayForPickNow() {
  const ov  = document.getElementById('overlay');
  const vid = document.getElementById('videoPlayer');
  if (!ov || !vid) return;
  window.__pickingHoop = true;
  ov.style.setProperty('pointer-events','auto','important');
  ov.style.setProperty('touch-action','none','important');
  ov.style.setProperty('z-index','1000','important');
  vid.style.setProperty('pointer-events','none','important');
  window.scheduleSyncOverlay?.();
}

window.addEventListener('hoop:locked', () => {
  try {
    requestAnimationFrame(() => syncOverlayToVideo());
    window.__poseFlashUntil = performance.now() + 3500;
  } catch {}
});
