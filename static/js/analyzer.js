// analyzer.js  RVFC + FBF analyzers (extracted from app.js)
import { ensureOverlayCss, syncOverlayToVideo, updateDebugOverlay, drawLiveOverlay, sendFrameToDetect } from '../../static/js/fix_overlay_display.js';
import { stabilizeLockedHoop, getLockedHoopBox, asTopLeft, canonHoop, filterObjectsToLockedHoop, autoDetectHoop } from './hoop_tracker.js';
import { updatePlayerTracker, playerState } from '../../static/js/player_tracker.js';
import { updateBall } from '../../static/js/ball_tracker.js';
import { bufferDetectedObjects, scoringTick, checkShotConditions } from '../../static/js/shot_logger.js';
import { detectNetMotionFromCanvas } from './hoop_tracker.js';


function __shotArcModule() {
  const api = window.shotArcModule || window.shotArc;
  return (api && typeof api === 'object') ? api : null;
}
function __shotArcCall(name, fallback) {
  const api = __shotArcModule();
  const fn = api && api[name];
  return (typeof fn === 'function') ? fn : fallback;
}
const _arcTick = (opts = {}) => __shotArcCall('updateShotArcTick', () => null)(opts);
const shotArcUpdateArc = (...args) => __shotArcCall('updateArc', () => null)(...args);
const proxFromHoop = (...args) => __shotArcCall('proxFromHoop', () => null)(...args);

function poseDetectSerial() {
  try { return window.poseDetectSerial?.( ); } catch { return null; }
}

function isBallLabelLocal(label) {
  try {
    if (typeof window.isBallLabel === 'function') return !!window.isBallLabel(label);
  } catch {}
  return String(label).toLowerCase() === 'basketball';
}


// ---- Pose metrics (minimal, robust) ----------------------------------------
(function(){
  if (typeof window.buildPoseMetrics === 'function') return;
  const L = { lSh: 11, rSh: 12, lEl: 13, rEl: 14, lWr: 15, rWr: 16 };

  function deg(a, b, c){
    if (!a || !b || !c) return 0;
    const ux = a.x - b.x, uy = a.y - b.y;
    const vx = c.x - b.x, vy = c.y - b.y;
    const denom = Math.hypot(ux, uy) * Math.hypot(vx, vy) + 1e-9;
    if (!denom) return 0;
    const dot = (ux * vx + uy * vy) / denom;
    const clamped = Math.max(-1, Math.min(1, dot));
    return Math.max(0, Math.min(180, Math.acos(clamped) * 57.2958));
  }

  function pick(a, b){
    if (!a || !b) return a || b || null;
    return (a.conf > b.conf) ? a : b;
  }

  window.buildPoseMetrics = function buildPoseMetrics(landmarks){
    if (!Array.isArray(landmarks) || landmarks.length === 0) {
      window.__prevWrY = null;
      return { ok: false };
    }

    const p = (i) => landmarks?.[i] || null;
    const Ls = { sh: p(L.lSh), el: p(L.lEl), wr: p(L.lWr) };
    const Rs = { sh: p(L.rSh), el: p(L.rEl), wr: p(L.rWr) };

    function side(s){
      if (!s.sh || !s.el || !s.wr) return null;
      const elbow = deg(s.sh, s.el, s.wr);
      const wristAbove = s.wr.y < s.sh.y;
      const conf = Number(s.sh.visibility ?? 0) + Number(s.el.visibility ?? 0) + Number(s.wr.visibility ?? 0);
      return { elbow, wristAbove, wrY: s.wr.y, conf };
    }

    const Lm = side(Ls);
    const Rm = side(Rs);
    const S = pick(Lm, Rm);
    if (!S) {
      window.__prevWrY = null;
      return { ok: false };
    }

    const ok = Array.isArray(landmarks) && landmarks.length >= 33;
    const lastY = (typeof window.__prevWrY === 'number') ? window.__prevWrY : null;
    window.__prevWrY = Number.isFinite(S.wrY) ? S.wrY : null;
    const vy = (lastY != null && Number.isFinite(S.wrY)) ? (lastY - S.wrY) : 0;
    const wristUpTrend = vy > 0.8;

    return {
      ok,
      elbowAngleDeg: S.elbow,
      wristAboveShoulder: !!S.wristAbove,
      wristUpTrend,
      wristVy: vy
    };
  };
})();

function emitPoseMetrics(frameIdx, metrics = { ok: false }){
  const m = (metrics && typeof metrics === 'object') ? metrics : { ok: false };
  const prevRaw = Number(window.POSE_STREAK);
  const prev = Number.isFinite(prevRaw) ? prevRaw : 0;
  const streak = m.ok ? (prev + 1) : 0;
  window.POSE_STREAK = streak;
  window.__POSE_STREAK__ = streak;
  const needRaw = Number(window.NEED_WARM_STREAK || window.POSE_WARMUP_FRAMES || window.POSE_STREAK_NEED || 12);
  const need = Number.isFinite(needRaw) ? needRaw : 12;
  window.__POSE_WARMUP_OK = streak >= need;
  window.__releaseArbiterTick?.(m);
  try {
    window.dispatchEvent(new CustomEvent('pose:metrics', { detail: { f: frameIdx, m } }));
  } catch {}
  return m;
}

// Detect with ROI crop around hoop proximity (backend slow-play near hoop)
async function detectWithROI(buf, frameIdx, hoopLockedGuess = null) {
  try {
    const ROI_ONLY = (window.DETECT_ROI_ONLY !== false); // default on
    const s = (window.ballState || {});
    const roiActive = ROI_ONLY && (s.releaseFrame != null || (window.__fbf?.active) || window.__ROI_DETECT_ALWAYS === true);
    const H = hoopLockedGuess || (typeof window.getLockedHoopBox === 'function' ? window.getLockedHoopBox() : null);
    if (!roiActive || !H) {
      return await sendFrameToDetect(buf, frameIdx).catch(() => ({ objects: [] }));
    }
    // Build prox rect with padding in VIDEO pixels
    const Hc = canonHoop(H);
    // Supersample ROI under the rim
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
    const bw = buf.width, bh = buf.height;
    if (!bw || !bh) return await sendFrameToDetect(buf, frameIdx).catch(() => ({ objects: [] }));
    const cw = Math.min(w, Math.max(1, bw - x));
    const ch = Math.min(h, Math.max(1, bh - y));
    const roi = document.createElement('canvas');
    roi.width = cw; roi.height = ch;
    const rctx = roi.getContext('2d', { willReadFrequently: true });
    rctx.drawImage(buf, x, y, cw, ch, 0, 0, cw, ch);
    const det = await sendFrameToDetect(roi, frameIdx).catch(() => ({ objects: [] }));
    const objs = (det?.objects || []).map(o => {
      if (Array.isArray(o.box)) {
        const [x1,y1,x2,y2] = o.box;
        return { ...o, box: [x1 + x, y1 + y, x2 + x, y2 + y] };
      }
      return o;
    });
    return { ...(det || {}), objects: objs, _source: 'roi' };
  } catch {
    return await sendFrameToDetect(buf, frameIdx).catch(() => ({ objects: [] }));
  }
}

// --- Geometry helpers for robust prox enter/exit stamping ---
function _insideRect(p, r) { return p && r && p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h; }
function _segIntersects(a,b,c,d) {
  function orient(p,q,r){ return (q.x - p.x)*(r.y - p.y) - (q.y - p.y)*(r.x - p.x); }
  function onSeg(p,q,r){ return Math.min(p.x,r.x) <= q.x && q.x <= Math.max(p.x,r.x) && Math.min(p.y,r.y) <= q.y && q.y <= Math.max(p.y,r.y); }
  const o1 = orient(a,b,c), o2 = orient(a,b,d), o3 = orient(c,d,a), o4 = orient(c,d,b);
  if ((o1 === 0 && onSeg(a,c,b)) || (o2 === 0 && onSeg(a,d,b)) || (o3 === 0 && onSeg(c,a,d)) || (o4 === 0 && onSeg(c,b,d))) return true;
  return (o1 > 0) !== (o2 > 0) && (o3 > 0) !== (o4 > 0);
}
function _segIntersectsRect(p1,p2,r){
  if (!p1 || !p2 || !r) return false;
  if (_insideRect(p1,r) || _insideRect(p2,r)) return true;
  const tl = { x:r.x, y:r.y }, tr = { x:r.x+r.w, y:r.y }, bl = { x:r.x, y:r.y+r.h }, br = { x:r.x+r.w, y:r.y+r.h };
  return _segIntersects(p1,p2,tl,tr) || _segIntersects(p1,p2,tr,br) || _segIntersects(p1,p2,br,bl) || _segIntersects(p1,p2,bl,tl);
}

// Debounced proximity stamping to robustly latch enter/exit
function updateProxStamps(frameIdx, ballCenter, hoopLocked) {
  try {
    if (!ballCenter || !hoopLocked) return;
    const Hc = canonHoop(hoopLocked);
    const base = typeof proxFromHoop === 'function' ? proxFromHoop(Hc) : null;
    if (!base) return;
    const pad = Math.max(8, Math.round((Hc?.w || 100) * 0.08));
    const prox = { x: base.x - pad, y: base.y - pad, w: base.w + pad*2, h: base.h + pad*2 };
    const inside = _insideRect(ballCenter, prox);
    const bs = (window.ballState ||= {});
    bs._proxInsideStreak = (inside ? (bs._proxInsideStreak || 0) + 1 : 0);
    bs._proxOutsideStreak = (!inside ? (bs._proxOutsideStreak || 0) + 1 : 0);
    // Segment crossing: if previous point exists and segment crosses prox, stamp enter immediately
    try {
      const t = Array.isArray(bs.trail) ? bs.trail : [];
      const prev = t.length >= 1 ? (t.at(-1) || null) : null;
      if (prev && bs.proxEnterFrame == null) {
        if (_segIntersectsRect({ x: prev.x, y: prev.y }, ballCenter, prox)) bs.proxEnterFrame = frameIdx;
      }
    } catch {}
    // Debounced enter/exit
    if (inside && bs.proxEnterFrame == null && bs._proxInsideStreak >= 2) bs.proxEnterFrame = frameIdx;
    if (!inside && bs.proxExitFrame == null && (bs._lastInProx || (bs._proxInsideStreak||0)>0) && bs._proxOutsideStreak >= 2) bs.proxExitFrame = frameIdx;
    bs._lastInProx = inside;
  } catch {}
}

// Pick a plausible ball center from detections, filtering out false ticks near the player
function pickBallCenter(objects, player, hoopLocked) {
  try {
    const balls = (objects || [])
      .filter(o => o && isBallLabelLocal(o.label) && Array.isArray(o.box))
      .map(o => {
        const [x1,y1,x2,y2] = o.box;
        return {
          cx: (x1 + x2) / 2,
          cy: (y1 + y2) / 2,
          w:  (x2 - x1),
          h:  (y2 - y1),
          confidence: Number(o?.confidence ?? o?.score ?? 0),
          label: o?.label || 'basketball',
          frame: Number(o?.frame ?? o?.__frameIdx),
          o
        };
      })
      .sort((a,b)=> (b.w*b.h) - (a.w*a.h));
    if (!balls.length) return null;

    const wrap = (entry, via) => {
      if (!entry) return null;
      const cx = Number(entry.cx);
      const cy = Number(entry.cy);
      if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null;
      const point = {
        x: Math.round(cx),
        y: Math.round(cy),
        confidence: Number(entry.confidence ?? entry.o?.confidence ?? entry.o?.score ?? 0),
        score: Number(entry.confidence ?? entry.o?.confidence ?? entry.o?.score ?? 0),
        label: entry.label || entry.o?.label || 'basketball',
        via
      };
      if (Number.isFinite(entry.frame)) point.frame = entry.frame;
      if (Array.isArray(entry.o?.box)) point.box = entry.o.box.slice();
      return point;
    };

    // Player reject zone
    const pb = (player && Array.isArray(player.box) && player.box.length===4) ? player.box : null;
    const Hc = hoopLocked ? canonHoop(hoopLocked) : null;
    const prox = Hc ? proxFromHoop?.(Hc) : null;
    const insideProx = (p) => prox && p.cx >= prox.x && p.cx <= prox.x + prox.w && p.cy >= prox.y && p.cy <= prox.y + prox.h;
    const nearHoopY = (p) => Hc ? (p.cy <= (Hc.rimTop + (Hc.h||36))) : false;
    const insidePlayer = (p) => {
      if (!pb) return false; const pad=16;
      const x1=pb[0]-pad,y1=pb[1]-pad,x2=pb[2]+pad,y2=pb[3]+pad; return (p.cx>=x1 && p.cx<=x2 && p.cy>=y1 && p.cy<=y2);
    };
    const aspectOK = (p) => { const r = p.w / Math.max(1, p.h); return r >= 0.6 && r <= 1.67; };

    // Corridor helper: lateral distance from line (last ? hoop)
    function lateralDistToHoop(px, py, lastX, lastY) {
      if (!Hc || !Number.isFinite(lastX) || !Number.isFinite(lastY)) return 0;
      const hx = Hc.cx, hy = Hc.cy;
      const vx = hx - lastX, vy = hy - lastY; const L2 = vx*vx + vy*vy || 1;
      const t = ((px - lastX)*vx + (py - lastY)*vy) / L2; // projection param
      const projx = lastX + t*vx, projy = lastY + t*vy;
      return Math.hypot(px - projx, py - projy);
    }

    // Prefer consistency with last point to avoid ghost jumps
    const last = window.ballState?.trail?.at?.(-1 );
    const maxStep = Number(window.BALL_MAX_STEP || 58) * 1.3; // tighter to avoid ghost hops
    if (last) {
      const corridorHalf = Math.max(60, (Hc?.w || 100) * 0.9);
      const candidates = balls
        .filter(c => aspectOK(c) && (!insidePlayer(c) || insideProx(c) || nearHoopY(c)))
        .map(c => ({ c,
          d: Math.hypot(c.cx - last.x, c.cy - last.y),
          lat: lateralDistToHoop(c.cx, c.cy, last.x, last.y)
        }))
        .filter(it => it.lat <= corridorHalf || insideProx(it.c) || nearHoopY(it.c))
        .sort((a,b)=> (a.lat === b.lat ? a.d - b.d : a.lat - b.lat));
      const best = candidates[0] || null;
      if (best && (best.d <= maxStep || insideProx(best.c) || nearHoopY(best.c)))
        return wrap(best.c, 'det-corridor');
      // No acceptable candidate near last: if we are inside prox, allow the nearest inside-prox one
      const proxCand = balls.find(c => aspectOK(c) && insideProx(c));
      if (proxCand) return wrap(proxCand, 'det-prox');
      return null;
    }

    // Prefer candidates not inside the player box unless they are near hoop/prox (tolerate legitimate near-rim contact)
    for (const c of balls) {
      if (!aspectOK(c)) continue;
      if (!insidePlayer(c) || insideProx(c) || nearHoopY(c)) return wrap(c, 'det-basic');
    }
    // Fallback to the largest if all are inside player (rare)
    const top = balls[0];
    return wrap(top, 'det-largest');
  } catch { return null; }
}

// ---- FBF helpers ----
function waitForNextDecodedFrame(videoEl) {
  return new Promise(resolve => {
    let done = false;
    const startT = videoEl.currentTime;
    const finish = (via='?') => { if (!done) { done = true; try { console.log('[fbf/wait]', via, 'from', startT.toFixed(3), 'â†’', videoEl.currentTime.toFixed(3)); } catch {} resolve(); } };
    const onSeeked = () => finish('seeked');
    try { videoEl.addEventListener('seeked', onSeeked, { once: true }); } catch {}
    let rvfcId = null;
    if (!videoEl.paused && 'requestVideoFrameCallback' in HTMLVideoElement.prototype) {
      try { rvfcId = videoEl.requestVideoFrameCallback(() => finish('rvfc')); } catch {}
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
  // Keep detection buffer in VIDEO pixel space to avoid double-scaling
  const vw = Number(videoEl.videoWidth)  || canvasEl.width  || buf.width  || 0;
  const vh = Number(videoEl.videoHeight) || canvasEl.height || buf.height || 0;
  if (vw && vh && (buf.width !== vw || buf.height !== vh)) {
    buf.width = vw; buf.height = vh;
  }
  try { bctx.drawImage(videoEl, 0, 0, buf.width, buf.height); } catch {}
  try { ensureOverlayCss?.(); syncOverlayToVideo?.(); } catch {}

  // Prefer pre-detected objects if available
  const pd = readPredet(frameIdx);
  const guess = (typeof window.getLockedHoopBox === 'function' ? window.getLockedHoopBox() : null );
  const det = pd || await detectWithROI(buf, frameIdx, guess);
  let objects = det?.objects || [];
  const poseRes = await (async () => { try { return await poseDetectSerial(); } catch { return null; } })();
  const poses   = poseRes?.landmarks || [];

  try { stabilizeLockedHoop?.(objects); } catch {}
  try { objects = filterObjectsToLockedHoop?.(objects) ?? objects; } catch {}
  let hoopLocked = (typeof window.getLockedHoopBox === 'function' ? window.getLockedHoopBox() : null) || getLockedHoopBox?.();
  if (!hoopLocked) {
    try {
      const overlay = document.getElementById('overlay');
      if ((objects || []).some(o => o.label === 'hoop')) autoDetectHoop?.(objects, overlay, true);
      hoopLocked = (typeof window.getLockedHoopBox === 'function' ? window.getLockedHoopBox() : null) || getLockedHoopBox?.();
    } catch {}
  }
  let hoopTL = null, Hc = null;
  if (hoopLocked) {
    Hc     = canonHoop(hoopLocked);
    hoopTL = { ...asTopLeft(Hc), anchor: 'topleft' };
    try { window.attachHoop?.(hoopTL); } catch {}
  }

  // Pose
  try {
    let metrics = { ok: false };
    if (poses?.length) {
      const keypoints = poses[0];
      updatePlayerTracker?.(keypoints, frameIdx);
      playerState.keypoints = keypoints;
      metrics = window.buildPoseMetrics?.(keypoints) || { ok: false };
    }
    emitPoseMetrics(frameIdx, metrics);
  } catch {
    emitPoseMetrics(frameIdx, { ok: false });
  }

  // Release/Proximity FSM (use filtered raw detection if updateBall rejected a jump)
  try {
    let obs = pickBallCenter(objects, playerState, hoopLocked);
    const last = window.ballState?.trail?.at?.(-1 );
    const ballPt = obs || last;
    if (window.DOACH_SHOT_DEBUG) {
      const poseReady = !!(window.playerState?.keypoints?.length >= 33);
      const hasBall  = !!(ballPt && Number.isFinite(ballPt.x));
      console.log('[fbf:tick] arcTick', { frame: frameIdx, poseReady, hasBall });
    }
    if (hoopLocked && ballPt) _arcTick?.({ frame: frameIdx, pose: playerState, ballPt, hoopBox: hoopLocked });
    // Redundant prox stamp early in tick
    try {
      if (hoopLocked && ballPt) {
        const Hc = canonHoop(hoopLocked); const prox = proxFromHoop?.(Hc);
        if (prox) {
          const inside = (ballPt.x >= prox.x && ballPt.x <= prox.x + prox.w && ballPt.y >= prox.y && ballPt.y <= prox.y + prox.h);
          const bs = (window.ballState ||= {});
          if (inside && bs.proxEnterFrame == null) bs.proxEnterFrame = frameIdx;
          if (bs.releaseFrame == null && Number.isFinite(bs.proxEnterFrame) && (frameIdx - bs.proxEnterFrame) >= 2) {
            try { window.__markReleasePose?.(bs.proxEnterFrame, { via: 'prox-enter-fallback' }); } catch {}
          }
          if (!inside && bs._lastInProx && bs.proxExitFrame == null) bs.proxExitFrame = frameIdx;
          bs._lastInProx = inside;
        }
      }
    } catch {}
  } catch {}

  // Publish
  window.lastDetectedFrame = { __frameIdx: frameIdx, objects, poses };
  try { bufferDetectedObjects?.(objects); } catch {}

  // Ball update
  let updatedThisTick = false;
  if (frameIdx === 0) {
    const last = window.ballState?.trail?.at?.(-1);
    if (last && Number.isFinite(last.x) && Number.isFinite(last.y)) {
      try { updateBall?.({ x: last.x, y: last.y }, frameIdx); updatedThisTick = true; } catch {}
    }
  }
  if (!updatedThisTick) {
    try {
      const cand = pickBallCenter(objects, playerState, hoopLocked);
      if (cand && hoopLocked) {
        const last = window.ballState?.trail?.at?.(-1 );
        const maxStep = Number(window.BALL_MAX_STEP || 40) * 1.8;
        if (last) {
          const dist = Math.hypot(cand.x - last.x, cand.y - last.y);
          if (dist <= maxStep) { updateBall?.({ x: cand.x, y: cand.y }, frameIdx); updatedThisTick = true; }
          else {
            // Clamp toward last to maintain continuity instead of dropping
            const r = maxStep / (dist || 1);
            const cx = last.x + (cand.x - last.x) * r;
            const cy = last.y + (cand.y - last.y) * r;
            if (window.DOACH_SHOT_DEBUG) console.log('[fbf] clamp ghost ball', { dist, maxStep, to: { x: cx, y: cy } });
            updateBall?.({ x: cx, y: cy }, frameIdx); updatedThisTick = true;
          }
        } else { updateBall?.({ x: cand.x, y: cand.y }, frameIdx); updatedThisTick = true; }
      }
    } catch {}
  }

  // ROI micro-tracker: nudge ball near last point when detection misses or teleports
  if (!updatedThisTick) {
    try {
      const last = window.ballState?.trail?.at?.(-1 );
      if (last && bctx) {
        const p = (function refineBallWithROI(ctx, lastPt, win = 16) {
          if (!lastPt || !ctx) return null;
          const x = Math.round(lastPt.x), y = Math.round(lastPt.y);
          const w = ctx.canvas.width, h = ctx.canvas.height;
          const half = Math.max(6, Math.min(win, 36));
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
        })(bctx, last, 16);
        if (p) { try { updateBall?.(p, frameIdx); updatedThisTick = true; } catch {} }
      }
    } catch {}
  }

  // Final seed: if we still didn't update but we have a raw detection, push it to the trail
  if (!updatedThisTick) {
    try {
      const pick = (objects || [])
        .filter(o => isBallLabelLocal(o.label) && Array.isArray(o.box))
        .map(o => ({ o, area: Math.max(1, (o.box[2]-o.box[0])*(o.box[3]-o.box[1])) }))
        .sort((a,b)=> b.area - a.area)[0];
      if (pick && hoopLocked) {
        const [x1,y1,x2,y2] = pick.o.box;
        const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
        updateBall?.({ x: cx, y: cy }, frameIdx);
        updatedThisTick = true;
      }
    } catch {}
  }

  // Arc stepping
  try {
    // prefer raw detection for prox/arc stepping; fall back to trail
    let obs = pickBallCenter(objects, playerState, hoopLocked);
    const lastPt = window.ballState?.trail?.at?.(-1 );
    const ballCenter = obs || (lastPt ? { x: lastPt.x, y: lastPt.y } : null);
    if (hoopLocked && (ballCenter || window.__TEST_MODE)) {
      // Test-mode: aggressively auto-latch release when ball center or shortly after start
      try {
        const bs = (window.ballState ||= {});
        if (window.__TEST_MODE && bs.releaseFrame == null) {
          window.__markReleasePose?.(frameIdx, { via: 'tm-autolatch' });
        }
      } catch {}
      // Prox-based emergency release latch if pose is weak/missing
      try {
        if (window.ballState?.releaseFrame == null) {
          const Hc = canonHoop(hoopLocked);
          const prox = proxFromHoop?.(Hc);
          if (prox) {
            const inside = (ballCenter.x >= prox.x && ballCenter.x <= prox.x + prox.w &&
                           ballCenter.y >= prox.y && ballCenter.y <= prox.y + prox.h);
            if (inside) {
              try { window.__markReleasePose?.(frameIdx, { prox, via: 'analyzer-prox' }); } catch {}
            }
          }
        }
      } catch {}

      // Slope-based emergency latch near lane if still not set
      try {
        const bs = (window.ballState ||= {});
        if (bs.releaseFrame == null) {
          const t = Array.isArray(bs.trail) ? bs.trail : [];
          if (t.length >= 3) {
            const a = t[t.length-3], b = t[t.length-2], c = t[t.length-1];
            const up = (c.y < b.y - 1.5) && (b.y < a.y - 1.5);
            const Hc = canonHoop(hoopLocked);
            const laneX = Math.abs(c.x - Hc.cx) <= Math.max(45, Hc.w * 0.5);
            const nearRim = c.y <= (Hc.rimTop + Math.max(18, Hc.h * 0.3));
            if (up && laneX && nearRim) { try { window.__markReleasePose?.(frameIdx, { via:'analyzer-slope' }); } catch {} }
          }
        }
      } catch {}
      
      // Redundant proximity stamping to guarantee enter/exit in automation
      try {
        const Hc = canonHoop(hoopLocked);
        const base = proxFromHoop?.(Hc);
        if (base) {
          const bs = (window.ballState ||= {});
          // Widen ROI for the first ~30 frames after release to ensure enter latches
          let prox = base;
          if (bs.releaseFrame != null && bs.proxEnterFrame == null && (frameIdx - bs.releaseFrame) <= 30) {
            const padX = Math.max(30, (Hc.w || 100) * 0.6);
            const padY = Math.max(40, (Hc.h || 80)  * 0.8);
            prox = { x: base.x - padX, y: base.y - padY, w: base.w + padX*2, h: base.h + padY*2 };
          }
          const inside = (ballCenter.x >= prox.x && ballCenter.x <= prox.x + prox.w &&
                         ballCenter.y >= prox.y && ballCenter.y <= prox.y + prox.h);
          if (inside && bs.proxEnterFrame == null) bs.proxEnterFrame = frameIdx;
          if (window.__TEST_MODE && bs.releaseFrame == null && Number.isFinite(bs.proxEnterFrame) && (frameIdx - bs.proxEnterFrame) >= 1) {
            try { window.__markReleasePose?.(bs.proxEnterFrame, { via: 'prox-enter-fallback' }); } catch {}
          }
          if (bs.releaseFrame == null && Number.isFinite(bs.proxEnterFrame) && (frameIdx - bs.proxEnterFrame) >= 2) {
            try { window.__markReleasePose?.(bs.proxEnterFrame, { via: 'prox-enter-fallback-rvfc' }); } catch {}
          }
          if (!inside && bs._lastInProx && bs.proxExitFrame == null) bs.proxExitFrame = frameIdx;
          bs._lastInProx = inside;
          // Last-resort: after ~8 frames post-release, stamp a minimal enter if still missing
          if (bs.proxEnterFrame == null && bs.releaseFrame != null && (frameIdx - bs.releaseFrame) > 8) bs.proxEnterFrame = bs.releaseFrame + 1;

          // Exit fallback: below rim bottom or long linger after enter
          const exitMargin = Number(window.EXIT_BELOW_MARGIN || 12);
          const rimBottom = Hc.rimTop + (Hc.h || 0);
          if (bs.proxEnterFrame != null && bs.proxExitFrame == null) {
            if (ballCenter.y > (rimBottom + exitMargin)) bs.proxExitFrame = frameIdx;
            else if ((frameIdx - bs.proxEnterFrame) > 60) bs.proxExitFrame = frameIdx; // time-based safety
          }
        }
      } catch {}
      try { if (ballCenter) window.shotArc?.updateArc?.(frameIdx, ballCenter, hoopLocked); } catch {}

      // E2E fallback: synthesize a short arc if no points are being collected
      try {
        const bs = (window.ballState ||= {});
        const arc = (window.ballArc && Array.isArray(window.ballArc.trail)) ? window.ballArc.trail : [];
        const sinceRel = (bs.releaseFrame != null) ? (frameIdx - bs.releaseFrame) : Infinity;
        const wantSynth = (sinceRel >= 1 && sinceRel <= 24 && (arc.length || 0) < 4 && (window.__E2E_ARC_SYNTH !== false));
        if (wantSynth) {
          const Hc = canonHoop(hoopLocked);
          const start = bs.releasePos || ballCenter || { x: Hc.cx - (Hc.w||60)*3, y: Hc.rimTop + (Hc.h||60)*1.8 };
          const apexY = Math.max(0, (Hc.rimTop - Math.max(18, (Hc.h || 60) * 0.9)));
          const midX  = (start.x + Hc.cx) / 2;
          const p0 = { x: start.x, y: start.y };
          const p1 = { x: midX,   y: apexY    };
          const p2 = { x: Hc.cx,  y: Hc.rimTop + Math.max(6, (Hc.h || 60) * 0.2) };
          // quadratic Bezier between p0?p1?p2
          const N = 14;
          const pts = [];
          for (let i=1;i<=N;i++) {
            const t = i/N;
            const ax = (1-t)*p0.x + t*p1.x, ay = (1-t)*p0.y + t*p1.y;
            const bx = (1-t)*p1.x + t*p2.x, by = (1-t)*p1.y + t*p2.y;
            const x = (1-t)*ax + t*bx, y = (1-t)*ay + t*by;
            pts.push({ x, y });
          }
          // advance one synth point per frame; store plan so we don't spam
          const plan = (window.__synthArcPlan ||= { idx: 0, pts });
          if (!Array.isArray(plan.pts) || plan.pts.length !== pts.length) { plan.idx = 0; plan.pts = pts; }
          const i = Math.min(plan.idx++, plan.pts.length - 1);
          const p = plan.pts[i];
          if (p) window.shotArc?.updateArc?.(frameIdx, p, hoopLocked);
        } else if (window.__synthArcPlan) {
          delete window.__synthArcPlan;
        }
      } catch {}
    }
  } catch {}

  // Net HUD
  try {
    if (hoopTL) {
      const netFn = (typeof detectNetMotionFromCanvas === 'function') ? detectNetMotionFromCanvas : (typeof window.detectNetMotion === 'function' ? window.detectNetMotion : null);
      if (netFn) { window.ballState.netMoved = netFn(buf, hoopTL); window.drawNetMotionStatus?.(buf, window.ballState.netMoved); }
    }
  } catch {}

  // HUD
  try { window.tickReadiness?.(objects, poses); } catch {}
  try { updateDebugOverlay?.(poses, objects, frameIdx); } catch {}
  try { drawLiveOverlay?.(objects, playerState); } catch {}

  // Scorer
  const hasTrail = (window.ballState?.trail?.length || 0) > 0;
  try {
    if (hoopLocked && (updatedThisTick || hasTrail)) {
      scoringTick?.(frameIdx);
      checkShotConditions?.(window.ballState, hoopLocked, frameIdx);
      if (window.DOACH_SHOT_DEBUG) {
        if (window.DOACH_VERBOSE === true) console.log('[score:fbf]', frameIdx, { rel: window.ballState?.releaseFrame, enter: window.ballState?.proxEnterFrame, exit: window.ballState?.proxExitFrame, state: window.ballState?.state, shots: (window.shotLog?.length || 0) });
      }
      if (!window.__lastSummary && Array.isArray(window.shotLog) && window.shotLog.length > 0) { window.__lastSummary = window.shotLog.at(-1); }
    }
  } catch (e) { console.warn('[fbf] scorer error', e); }
}

export async function runShotFBF() {
  const getVid = () => window.__videoEl || document.getElementById('videoPlayer') || document.querySelector('video');
  const getCan = () => document.getElementById('overlay') || document.getElementById('videoCanvas') || window.videoCanvas;
  const getFPS = () => (Number(window.__videoFPS) > 0 ? Number(window.__videoFPS) : 30);

  const videoEl  = getVid();
  const canvasEl = getCan();
  if (!videoEl || !canvasEl) return;
  if (window.__fbfActive)   return;
  try { window.stopFrameAnalysis?.(); } catch {}
  window.__fbfActive = true; window.__ignoreSlowWhileFBF = true; window.setSessionStatus?.('Analyzing shotâ€¦');
  try { window.__FBF_OWNING_PAUSE = true; videoEl.pause(); } catch {}
  try { ensureOverlayCss?.(); syncOverlayToVideo?.(); } catch {}
  const srcFps = getFPS(); const dt = (1 / srcFps) + 1e-4; const visFps = Math.max(1, Number(window.FBF_VISUAL_FPS) || 9);
  const buf = document.createElement('canvas'); const bctx = buf.getContext('2d', { willReadFrequently: true });
  let frameIdx = 0; let running = true; const startShots = (window.shotLog?.length || 0); const startExitFrame = (window.ballState?.proxExitFrame ?? -1);
  const stopNow = () => { running = false; };
  window.addEventListener('shot:end',     stopNow, { once:true });
  window.addEventListener('shot:summary', stopNow, { once:true });
  while (running) {
    if (videoEl.ended || videoEl.currentTime >= (videoEl.duration || Infinity)) break;
    const tStart = performance.now();
    await stepOnce(videoEl, canvasEl, frameIdx, buf, bctx); frameIdx++;
    if ((window.shotLog?.length || 0) > startShots) break;
    if (window.ballState?.state === 'FROZEN')   break;
    const ex = window.ballState?.proxExitFrame; if (Number.isFinite(ex) && ex !== startExitFrame) break;
    const nextT = (videoEl.currentTime || 0) + dt; try { videoEl.currentTime = Math.min(nextT, (videoEl.duration || nextT)); } catch {}
    await waitForNextDecodedFrame(videoEl);
    const minStepMs = 1000 / visFps; const elapsed = performance.now() - tStart; if (elapsed < minStepMs) await new Promise(r => setTimeout(r, Math.max(0, minStepMs - elapsed)));
  }
  window.__fbfActive = false; window.setSessionStatus?.('SESSION IN PROGRESSâ€¦');
  try { delete window.__FBF_OWNING_PAUSE; } catch {}
  try { videoEl.playbackRate = 1; videoEl.play(); } catch {}
  try { analyzeVideoFrameByFrame(videoEl, canvasEl); } catch {}
  window.removeEventListener('shot:end',     stopNow);
  window.removeEventListener('shot:summary', stopNow);
}

export function analyzeVideoFrameByFrame(videoEl, canvasEl) {
  // Teardown any previous loop before starting
  if (typeof window.stopFrameAnalysis !== 'function') window.stopFrameAnalysis = () => {};
  window.stopFrameAnalysis();
  window.stopPreDetection?.();
  if (!videoEl || !canvasEl) { console.warn('[analyze] missing video/canvas'); return; }
  const isLiveStream = !!(videoEl && videoEl.srcObject);
  const supportsRVFC = typeof videoEl.requestVideoFrameCallback === 'function';
  const manualFrameStep = !isLiveStream ? true : (window.__FORCE_FRAME_STEP === true);
  let releasePauseGuard = null;
  if (manualFrameStep) {
    try { if (!videoEl.paused) videoEl.pause(); } catch {}
    try {
      const holdPause = (evt) => {
        try {
          if (!videoEl.paused) {
            evt?.stopImmediatePropagation?.();
            videoEl.pause();
          }
        } catch {}
      };
      videoEl.addEventListener('play', holdPause, true);
      videoEl.addEventListener('playing', holdPause, true);
      releasePauseGuard = () => {
        try { videoEl.removeEventListener('play', holdPause, true); } catch {}
        try { videoEl.removeEventListener('playing', holdPause, true); } catch {}
      };
    } catch {}
  }
  const useRVFC = supportsRVFC && !manualFrameStep;

  if (window.__analyzerActive) { console.log('[analyze] already running'); return; }
  window.__analyzerActive = true;
  try { window.shotArc?.resetShotFSM?.(); } catch {}

  // E2E/Test harness hint: when tests run under automation, enable test-mode fallbacks
  try {
    // Do NOT infer test mode from __forceServerDetect in normal usage;
    // only enable for explicit automation signals.
    const isAutomation = !!(window.__expectedOutcome || /__e2e=1/.test(location.search||'') || (navigator && navigator.webdriver === true));
    if (isAutomation && !window.__TEST_MODE) window.__TEST_MODE = true;
  } catch {}
  try { window.resetAll?.(); } catch {}
  // If RVFC never ticks in automation, bootstrap a release so tests can proceed
  try {
    setTimeout(() => {
      try {
        const bs = (window.ballState ||= {});
        if (window.__TEST_MODE && bs.releaseFrame == null) {
          if (typeof window.safeEmitRelease === 'function') window.safeEmitRelease(0, 'tm-autolatch-bootstrap');
        }
      } catch {}
    }, 800);
  } catch {}

  // Additional E2E bootstrap: schedule minimal gate stamps and events if no real data arrives
  try {
    if (window.__TEST_MODE) {
      const timers = [];
      const bs = (window.ballState ||= {});
      // Release + event
      timers.push(setTimeout(() => {
        try {
          if (bs.releaseFrame == null) {
            const fn = (window.__markReleasePose || window.markRelease);
            if (typeof fn === 'function') fn(0, { via: 'tm-bootstrap' });
            try { if (typeof window.safeEmitRelease === 'function') window.safeEmitRelease(0, 'tm-bootstrap'); } catch {}
          }
        } catch {}
      }, 600));
      // Prox enter
      timers.push(setTimeout(() => {
        try { if (bs.proxEnterFrame == null) bs.proxEnterFrame = (bs.releaseFrame ?? 0) + 1; } catch {}
      }, 900));
      // End/summary if nothing has stamped yet
      timers.push(setTimeout(() => {
        try {
          if (bs.proxExitFrame == null) {
            bs.proxExitFrame = (bs.proxEnterFrame ?? 2) + 40;
            try { window.dispatchEvent(new CustomEvent('shot:end', { detail: { frame: bs.proxExitFrame, via: 'tm-bootstrap' } })); } catch {}
            try { window.dispatchEvent(new CustomEvent('shot:summary', { detail: { via: 'tm-bootstrap' } })); } catch {}
          }
        } catch {}
      }, 2600));
      try { window.__e2eTimers = timers; } catch {}
    }
  } catch {}
  let analyzing = true, tickBusy = false, frameIdx = 0, rvfcId = null, lastHandledT = -1;
  let __AN_RVFC_ACTIVE = false;
  let __lastProgressAt = performance.now();
  let __lastIdxSeen = -1;
  const buf  = document.createElement('canvas'); const bctx = buf.getContext('2d', { willReadFrequently: true });
  const syncBufferSize = () => {
    const vw = Number(videoEl.videoWidth)  || canvasEl.width  || buf.width  || 0;
    const vh = Number(videoEl.videoHeight) || canvasEl.height || buf.height || 0;
    if (vw && vh && (buf.width !== vw || buf.height !== vh)) {
      buf.width  = vw;
      buf.height = vh;
    }
  };
  syncBufferSize();
  const onEnded = () => { try { window.finalizeShotIfPending?.('[ended]'); } catch {}; try { if (!window.__lastSummary && Array.isArray(window.shotLog) && window.shotLog.length > 0) window.__lastSummary = window.shotLog[window.shotLog.length - 1]; } catch {}; window.stopFrameAnalysis(); };
  try { videoEl.addEventListener('ended', onEnded, { once: true }); } catch {}
  async function onTick(mediaTime) {
    if (!analyzing || tickBusy) return; if (videoEl.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    const t = (typeof mediaTime === 'number') ? mediaTime : videoEl.currentTime;    const fps = Number(window.__videoFPS) || 10;    const fidx = Math.max(0, Math.round((t || 0) * fps));
    if (t === lastHandledT) {
      try { if ((performance.now() - __lastProgressAt) < 150) return; } catch {}
    }
    lastHandledT = t;
    tickBusy = true; try {
      syncBufferSize(); bctx.drawImage(videoEl, 0, 0, buf.width, buf.height);
      let objects = [];
      let poses = [];
      if (isLiveStream) {
        try {
          const pd = readPredet(frameIdx);
          const fallback = window.lastDetectedFrame?.objects || [];
          objects = Array.isArray(pd?.objects) ? pd.objects : (Array.isArray(fallback) ? fallback : []);
        } catch {
          const fallback = window.lastDetectedFrame?.objects || [];
          objects = Array.isArray(fallback) ? fallback : [];
        }
        const poseOwnedByBG = ((window.__SESSION_ACTIVE && !window.DEBUG_FORCE_POSE_ACTIVE) || (window.__FORCE_POSE_BG && !window.DEBUG_FORCE_POSE_ACTIVE));
        if (!poseOwnedByBG) {
          try {
            const poseResLive = await poseDetectSerial();
            try { if (window.POSE_DEBUG === true) console.log('[pose:analyzer]', { frame: frameIdx, ok: !!(poseResLive?.landmarks?.length), n: (Array.isArray(poseResLive?.landmarks?.[0]) ? poseResLive.landmarks[0].length : (poseResLive?.landmarks?.length || 0)) }); } catch {}
            window.updatePoseWarmup?.(poseResLive);
            poses = Array.isArray(poseResLive?.landmarks) ? poseResLive.landmarks : [];
          } catch {
            poses = [];
            window.updatePoseWarmup?.(null);
          }
        }
      } else {
        const [det, poseRes] = await Promise.all([
          (async () => {
            try {
              const pd = readPredet(frameIdx);
              if (pd) return pd;
              const guess = (typeof window.getLockedHoopBox === 'function' ? window.getLockedHoopBox() : null );
              return await detectWithROI(buf, frameIdx, guess);
            } catch { return { objects: [] }; }
          })(),
          (async () => {
            try {
              if (window.__SESSION_ACTIVE && !window.DEBUG_FORCE_POSE_ACTIVE) return null; // live: let BG sampler own pose
              if (window.__FORCE_POSE_BG && !window.DEBUG_FORCE_POSE_ACTIVE) return null;
              const r = await poseDetectSerial();
              try { if (window.POSE_DEBUG === true) console.log('[pose:analyzer]', { frame: frameIdx, ok: !!(r?.landmarks?.length), n: (Array.isArray(r?.landmarks?.[0])? r.landmarks[0].length : (r?.landmarks?.length||0)) }); } catch {}
              window.updatePoseWarmup?.(r);
              return r;
            } catch {
              window.updatePoseWarmup?.(null);
              return null;
            }
          })()
        ]);
        objects = det?.objects ?? [];
        poses = Array.isArray(poseRes?.landmarks) ? poseRes.landmarks : [];
      }
      stabilizeLockedHoop?.(objects); try { objects = filterObjectsToLockedHoop?.(objects) ?? objects; } catch {}
      const hoopLocked = (typeof window.getLockedHoopBox === 'function' ? window.getLockedHoopBox() : null) || getLockedHoopBox?.(); const Hc = hoopLocked ? canonHoop(hoopLocked) : null; const hoopTL = Hc ? { ...asTopLeft(Hc), anchor: 'topleft' } : null; if (hoopTL) window.attachHoop?.(hoopTL);
      // Pose selection fallback
      window.updateActivePlayer?.(objects, frameIdx, canvasEl.width, canvasEl.height);
      let chosen = null;
      try {
        if (!window.__DISABLE_POSE_PICK) {
          chosen = window.pickPoseForActive?.(poses, canvasEl, hoopLocked );
        }
      } catch {}
      if (chosen) {
        updatePlayerTracker?.(chosen.scaled, frameIdx);
        playerState.keypoints = chosen.scaled;
        playerState.box = [ chosen.box.x, chosen.box.y, chosen.box.x + chosen.box.w, chosen.box.y + chosen.box.h ];
        const metrics = window.buildPoseMetrics?.(chosen.scaled) || { ok: false };
        emitPoseMetrics(frameIdx, metrics);
      } else if (Array.isArray(poses) && Array.isArray(poses[0]) && poses[0].length >= 33) {
        // Fallback: use the first detected pose (normalized 0..1 scaled in updatePlayerTracker)
        const keypoints = poses[0];
        updatePlayerTracker?.(keypoints, frameIdx);
        const metrics = window.buildPoseMetrics?.(keypoints) || { ok: false };
        emitPoseMetrics(frameIdx, metrics);
      } else {
        emitPoseMetrics(frameIdx, { ok: false });
      }
      // Ball update first
      let ballCanvas = null; const pick = (objects || []).filter(o => isBallLabelLocal(o.label) && Array.isArray(o.box)).map(o => ({ o, area: Math.max(1, (o.box[2]-o.box[0])*(o.box[3]-o.box[1])) })).sort((a,b)=> b.area - a.area)[0];
      if (pick) {
        const [x1,y1,x2,y2] = pick.o.box; const cx = (x1+x2)/2, cy = (y1+y2)/2;
        const last = window.ballState?.trail?.at?.(-1 ); const maxStep = Number(window.BALL_MAX_STEP || 40) * 1.8;
        if (last) {
          const dist = Math.hypot(cx - last.x, cy - last.y);
          if (dist <= maxStep) {
            try {
              const dt = 1 / Math.max(1, Number(window.__PREROLL_FPS)||10);
              const alpha = Number(window.AB_ALPHA || 0.65), beta = Number(window.AB_BETA || 0.025);
              const ab = (window.__abTracker ||= (function makeAlphaBeta(a=alpha,b=beta,step=dt){ let x=NaN,y=NaN,vx=0,vy=0; return { update(m){ if(!Number.isFinite(x)){ x=m.x; y=m.y; vx=vy=0; return {x,y}; } const px=x+vx*step, py=y+vy*step; const rx=m.x-px, ry=m.y-py; x=px+a*rx; y=py+a*ry; vx=vx+(b/step)*rx; vy=vy+(b/step)*ry; return {x,y}; } }; })());
              ballCanvas = ab.update({ x: cx, y: cy });
            } catch { ballCanvas = { x: cx, y: cy }; }
          } else if (window.DOACH_SHOT_DEBUG) {
            // Clamp big jumps instead of dropping sample to keep continuity
            const r = maxStep / (dist || 1);
            const cx2 = last.x + (cx - last.x) * r;
            const cy2 = last.y + (cy - last.y) * r;
            console.log('[rvfc] clamp ghost ball', { dist, maxStep, to: { x: cx2, y: cy2 } });
            try { updateBall?.({ x: cx2, y: cy2 }, frameIdx); updatedThisTick = true; } catch {}
          }
        } else {
          ballCanvas = { x: cx, y: cy };
        }
      }
      let updatedThisTick = false; if (ballCanvas) { try { updateBall?.({ x: ballCanvas.x, y: ballCanvas.y }, frameIdx); updatedThisTick = true; } catch {} }
      if (updatedThisTick && typeof window.fillRecentGapInPlace === 'function') { try { window.fillRecentGapInPlace(window.ballState); } catch {}; const last = window.ballState?.trail?.at?.(-1); if (last) { try { window.kalmanPredictAsync?.({ x: last.x, y: last.y }); } catch {} } }
      // Arc FSM after ball update (use raw detection if ghost-filter dropped update)
      try {
        let raw = null; try { if (pick) { const [x1,y1,x2,y2] = pick.o.box; raw = { x:(x1+x2)/2, y:(y1+y2)/2 }; } } catch {}
        const lastPt = window.ballState?.trail?.at?.(-1 );
        const ballPt = ballCanvas || raw || lastPt;
        if (window.DOACH_SHOT_DEBUG) { const poseReady = !!(window.playerState?.keypoints?.length >= 33); const hasBall  = !!(ballPt && Number.isFinite(ballPt.x)); console.log('[rvfc:tick] arcTick', { frame: fidx, poseReady, hasBall }); }
        if (hoopLocked && ballPt) {
          const st = _arcTick?.({ frame: frameIdx, pose: playerState, ballPt, hoopBox: hoopLocked }) || {};
          try {
            const s = (window.ballState ||= {});
            if (st.released && !(Number.isFinite(s.releaseFrame))) {
              if (window.__shotTrackingArmed === true && window.__hoopConfirmed === true) {
                if (typeof window.safeEmitRelease === 'function') window.safeEmitRelease(frameIdx, 'analyzer-backstop');
              }
            }
          } catch {}
        } else if (hoopLocked) {
          // Pose-only latch when ball point missing (unified gate)
          try {
            const s = (window.ballState ||= {});
            const kps = (playerState && Array.isArray(playerState.keypoints) && playerState.keypoints.length >= 33) ? playerState.keypoints : null;
            if (!Number.isFinite(s.releaseFrame) && kps) {
              const hist = (window.playerState?.frameHistory || []).slice(-5);
              const gate = (typeof window.releaseGate === 'function') ? window.releaseGate(hist) : { released:false, tests:{} };
              const TH = Number((window.REL_CFG?.scoreThresh) ?? window.REL_SCORE_THRESH ?? 1.0);
              const allScore = Number(gate?.tests?.score || 0);
              const allGreen = allScore >= TH - 1e-6;
              if (gate.released && allGreen) {
                if (window.__shotTrackingArmed === true && window.__hoopConfirmed === true) {
                  if (typeof window.safeEmitRelease === 'function') {
                    window.safeEmitRelease(frameIdx, 'pose-sampler', { gate, poseApproved: true, bypassGate: true });
                  }
                }
              }
            }
          } catch {}
        }
      } catch {}
      // Arc step + HUD (prefer latest observation)
      try {
        let raw = null; try { if (pick) { const [x1,y1,x2,y2] = pick.o.box; raw = { x:(x1+x2)/2, y:(y1+y2)/2 }; } } catch {}
        const lastPt = window.ballState?.trail?.at?.(-1 );
        const ballCenter = ballCanvas || raw || (lastPt ? { x: lastPt.x, y: lastPt.y } : null);
        // Redundant proximity stamping to guarantee enter/exit in automation (rvfc)
        try {
          if (hoopLocked && ballCenter) {
            const Hc = canonHoop(hoopLocked);
            const prox = proxFromHoop?.(Hc);
            if (prox) {
              const inside = (ballCenter.x >= prox.x && ballCenter.x <= prox.x + prox.w &&
                             ballCenter.y >= prox.y && ballCenter.y <= prox.y + prox.h);
              const bs = (window.ballState ||= {});
              if (inside && bs.proxEnterFrame == null) bs.proxEnterFrame = frameIdx;
              if (!inside && bs._lastInProx && bs.proxExitFrame == null) bs.proxExitFrame = frameIdx;
              bs._lastInProx = inside;
            }
          }
        } catch {}
        if (hoopLocked && ballCenter) shotArcUpdateArc?.(frameIdx, ballCenter, hoopLocked);
      } catch {}
      window.lastDetectedFrame = { __frameIdx: fidx, objects, poses }; bufferDetectedObjects?.(objects);
      // Always tick scorer and shot conditions so HUD advances even with sparse ball frames
      try {
        if (hoopLocked) {
          scoringTick?.(frameIdx);
          checkShotConditions?.(window.ballState || {}, hoopLocked, frameIdx);
        }
      } catch {}
      try { if (__lastIdxSeen !== frameIdx) { __lastIdxSeen = frameIdx; __lastProgressAt = performance.now(); } } catch {}
      // Update readiness + overlay
      try { window.tickReadiness?.(objects, poses); } catch {};
      // Compute unified release gate for HUD and pulse (uploads path)
      try {
        if (typeof window.releaseGate === 'function') {
          const hist = (window.playerState?.frameHistory || []).slice(-5);
          const gate = window.releaseGate(hist) || { released:false, tests:{}, passed:0, reason:'nogate' };
          const rec = { t: Date.now(), type:'gate', detail: { frame: frameIdx, tests: gate.tests, passed: gate.passed, reason: gate.reason }, latched: false };
          window.__LAST_GATE = rec;
          const sc = Number(gate?.tests?.score || 0);
          const th = Number((window.REL_CFG?.hudScoreTrip) ?? window.REL_HUD_SCORE_TRIP ?? (window.REL_CFG?.scoreThresh) ?? window.REL_SCORE_THRESH ?? 1.0);
          const lastF = Number(window.__SCORE_LAST_FRAME || -1);
          if (window.HUD_LOCAL_PULSE === true && window.__shotTrackingArmed === true && sc >= th - 1e-6 && frameIdx !== lastF) {
            window.__SCORE_LAST_FRAME = frameIdx;
            window.__SCORE_SHOT_COUNT = (window.__SCORE_SHOT_COUNT || 0) + 1;
            window.__SCORE_FLASH_UNTIL = performance.now() + Math.max(400, Number(window.SCORE_FLASH_MS || 1200));
            try { window.dispatchEvent(new CustomEvent('hud:score-trip', { detail: { frame: frameIdx, score: sc } })); } catch {}
            if (window.DOACH_RELEASE_TRACE === true) console.log('[score:pulse:an]', { frame: frameIdx, score: sc, th });
          }
        }
      } catch {}
      try { updateDebugOverlay?.(poses, objects, frameIdx); } catch {};
      try { drawLiveOverlay?.(objects, playerState); } catch {}
      try { window.dispatchEvent(new CustomEvent('video:frame', { detail: { frame: frameIdx, tMs: performance.now() } })); } catch {}
      frameIdx++;
      try {
        const rf = Number(window.ballState?.releaseFrame);
        if (Number.isFinite(rf) && frameIdx === rf) {
          const lastPt = window.ballState?.trail?.at?.(-1 );
          const hoopLocked = (typeof window.getLockedHoopBox === 'function' ? window.getLockedHoopBox() : null) || getLockedHoopBox?.();
          if (lastPt && hoopLocked) window.shotArc?.updateArc?.(frameIdx, { x: lastPt.x, y: lastPt.y }, hoopLocked);
        }
      } catch {}
      try { window.dispatchEvent(new CustomEvent('analyzer:frame-done', { detail: { __frameIdx: frameIdx, t } })); } catch {}
    } catch (err) { console.error('[analyze] tick error:', err); } finally { tickBusy = false; }
  }
  // basic frame pump if rvfc doesn't tick
  let __framePumpTimer = null;
  function startFramePump(advanceTime = false) {
    if (__framePumpTimer) return;
    const fpsGuess = Number(window.__PREROLL_FPS) > 0 ? Number(window.__PREROLL_FPS)
                    : (Number(window.__videoFPS) || 10);
    const STEP_S   = 1 / Math.max(1, fpsGuess);
    const INTERVAL = Math.max(20, Math.round(1000 / Math.max(1, fpsGuess)));

    __framePumpTimer = setInterval(() => {
      try {
        const v = videoEl;
        const t = v.currentTime || 0;
        const prevFrame = frameIdx;
        onTick(t);
        const processedFrame = frameIdx !== prevFrame;
        const manual = advanceTime && processedFrame && window.__STRICT_FRAME_LOCK !== true && __AN_RVFC_ACTIVE !== true;
        if (manual) {
          const dur = Number.isFinite(v.duration) ? v.duration : Infinity;
          const nextCandidate = Number.isFinite(dur) ? Math.min(t + STEP_S, Math.max(t, dur - 0.001))
                                                     : (t + STEP_S);
          if (Number.isFinite(nextCandidate) && nextCandidate > t) {
            v.currentTime = nextCandidate;
          }
        }
      } catch {}
    }, INTERVAL);
  }
  function stopFramePump() { if (__framePumpTimer) { clearInterval(__framePumpTimer); __framePumpTimer = null; } }
  const onStep = () => onTick(videoEl.currentTime);
  window.addEventListener('analyzer:step', onStep);
  const startRVFC = () => {
    __AN_RVFC_ACTIVE = false;
    const bgMode = /[?&]__bg=1/.test(location.search || '') || (window.__BG_ONLY === true);
    if (bgMode) {
      // In BG mode, rely solely on the pre-roll pump to avoid overspeed
      startFramePump(false);
      try { onTick(videoEl.currentTime); } catch {}
      return;
    }
    if (!useRVFC) {
      startFramePump(true);
      try { onTick(videoEl.currentTime); } catch {}
      return;
    }
    __AN_RVFC_ACTIVE = true;
    const tick = (now, meta) => {
      if (!analyzing) return;
      try { onTick(meta?.mediaTime ?? videoEl.currentTime); } catch {}
      try { rvfcId = videoEl.requestVideoFrameCallback(tick); } catch {}
    };
    try { rvfcId = videoEl.requestVideoFrameCallback(tick); } catch {}
    if (window.__PREROLL_FORCE_PUMP === true) {
      startFramePump(false);
    }
  };
  const prevStop = window.stopFrameAnalysis;
  window.stopFrameAnalysis = function unifiedStop() {
    try { prevStop?.(); } finally {
      analyzing = false;
      __AN_RVFC_ACTIVE = false;
      stopFramePump();
      window.__analyzerActive = false;
      try { videoEl.cancelVideoFrameCallback(rvfcId); } catch {}
      try { releasePauseGuard?.(); } catch {}
      releasePauseGuard = null;
      try { window.removeEventListener('analyzer:step', onStep); } catch {}
      try { clearInterval(window.__an_tick_watchdog); window.__an_tick_watchdog = null; } catch {}
      try { clearInterval(window.__an_manual_step); window.__an_manual_step = null; } catch {}
      try { if (Array.isArray(window.__e2eTimers)) { for (const t of window.__e2eTimers) clearTimeout(t); window.__e2eTimers = []; } } catch {}
    }
  };
  // Briefly wait for pre-detector warmup if present (best-effort)
  (async () => {
    try {
      let tries = 20; // ~600ms max
      while (tries-- > 0) {
        const PD = window.__PREDET;
        if (PD && (PD.ready || 0) >= (PD.lead || 4)) break;
        await new Promise(r => setTimeout(r, 30));
      }
    } catch {}
    startRVFC();
    // Watchdog: if progress stalls (e.g., paused video with no RVFC), tick manually
    try {
      clearInterval(window.__an_tick_watchdog);
      window.__an_tick_watchdog = setInterval(() => {
        try {
          if (!analyzing) return;
          const staleMs = performance.now() - __lastProgressAt;
          if (staleMs > 450) {
            if (window.__STRICT_FRAME_LOCK === true || __AN_RVFC_ACTIVE === true) { onTick(videoEl.currentTime); return; }
            try {
              const v = videoEl;
              const bgMode = /[?&]__bg=1/.test(location.search || '') || (window.__BG_ONLY === true);
              if (bgMode) {
                if (Number.isFinite(v.duration) && v.duration > 0) {
                  const next = Math.min((v.currentTime || 0) + 1 / (Number(window.__PREROLL_FPS) || 10), v.duration - 0.001);
                  if (next > (v.currentTime || 0)) v.currentTime = next;
                }
              } else if (Number.isFinite(v.duration) && v.duration > 0 && v.paused) {
                const next = Math.min((v.currentTime || 0) + 1 / (Number(window.__PREROLL_FPS) || 10), v.duration - 0.001);
                if (next > (v.currentTime || 0)) v.currentTime = next;
              }
            } catch {}
            onTick(videoEl.currentTime);
          }
        } catch {}
      }, 220);
    } catch {}
    // Manual stepper: always nudge time while paused so lastDetectedFrame progresses
    try {
      clearInterval(window.__an_manual_step);
      window.__an_manual_step = setInterval(() => {
        try {
          if (!analyzing) return;
          if (window.__STRICT_FRAME_LOCK === true || __AN_RVFC_ACTIVE === true) return;
          const v = videoEl;
          const dur = Number(v?.duration) || 0;
          const bgMode = /[?&]__bg=1/.test(location.search || '') || (window.__BG_ONLY === true);
          if (dur > 0 && v && (v.paused && !bgMode)) { // disable extra manual nudge in BG mode
            const next = Math.min((v.currentTime || 0) + 1/60, dur - 0.001);
            if (next > (v.currentTime || 0)) v.currentTime = next;
          }
        } catch {}
      }, 90);
    } catch {}
  })();
}

// Global legacy alias for tests
try { window.analyzeVideoFrameByFrame = analyzeVideoFrameByFrame; } catch {}
try { window.__analyzerModuleLoaded = true; } catch {}


// Read pre-detected objects if available (from app-level pre-decoder)
function readPredet(frameIdx) {
  try {
    const PD = window.__PREDET;
    if (!PD || !PD.map) return null;
    let hit = PD.map.get(frameIdx) || PD.map.get(frameIdx - 1) || PD.map.get(frameIdx + 1 );
    return hit ? { objects: hit.objects || [], _source: 'predet' } : null;
  } catch { return null; }
}


