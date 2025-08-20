// hoop_tracker.js — cleaned and stable, ONNX-dropout tolerant (8/20)

export let stats = { hoopDropouts: 0, syntheticHoops: 0 };

let selectedHoop = null;
let lockedHoopBox = null;      // {x,y,w,h} — center form
let manualHoopLocked = false;
let anchorLockActive = false;

let recentHoopMidpoints = [];
const FRAME_BUFFER   = 6;      // window for simple smoothing
const ACCEPT_DIST_PX = 150;    // accept candidates near current lock
const MAX_STEP_PX    = 48;     // cap per-frame movement on update
const KEEP_FRAMES    = 45;     // hold stale lock this many frames if hoop vanishes

// proximity band (should mirror shot_logger.js)
const PROX_X = 200, PROX_Y_ABOVE = 170, PROX_Y_BELOW = 100;

// default rim size when we can't infer
const DEFAULT_RIM_W = 88;
const DEFAULT_RIM_H = 36;

// side guard to avoid hopping to the other hoop
let courtMidX = null;
let lockSide  = null;          // 'L' | 'R'
let lastHoopSeenFrame = -1;

window.isUserLocked = isUserLocked;

/* ──────────────────────────────────────────────
 *  CLICK → CHOOSE HOOP, favoring nearest 'hoop'
 * ────────────────────────────────────────────── */
export function handleHoopSelection(e, overlay, lastFrame, promptBar) {
  const rect = overlay.getBoundingClientRect();
  const sx = overlay.width / rect.width;
  const sy = overlay.height / rect.height;
  const clickX = (e.clientX - rect.left) * sx;
  const clickY = (e.clientY - rect.top)  * sy;

  const objs = lastFrame?.objects || [];
  const hoops = objs.filter(o => o.label === 'hoop' && Array.isArray(o.box));

  let pick = { x: clickX, y: clickY, rw: DEFAULT_RIM_W, rh: DEFAULT_RIM_H };
  if (hoops.length) {
    let best = null, bestD = Infinity;
    for (const o of hoops) {
      const [x1,y1,x2,y2] = o.box;
      const cx = (x1+x2)/2, cy = (y1+y2)/2;
      const d  = Math.hypot(cx - clickX, cy - clickY);
      if (d < bestD) { bestD = d; best = { cx, cy, rw: x2-x1, rh: y2-y1 }; }
    }
    if (best) pick = { x: best.cx, y: best.cy, rw: best.rw, rh: best.rh };
  }

  lockHoopToSelected(pick.x, pick.y);
  // seed size if known
  lockedHoopBox.w = Math.max(lockedHoopBox.w, pick.rw || DEFAULT_RIM_W);
  lockedHoopBox.h = Math.max(lockedHoopBox.h, pick.rh || DEFAULT_RIM_H);

  // baseline side guard
  courtMidX = overlay.width / 2;
  lockSide  = pick.x < courtMidX ? 'L' : 'R';

  if (promptBar) { promptBar.textContent = ''; promptBar.style.display = 'none'; }
  const overlayPrompt = document.getElementById('overlayPrompt');
  if (overlayPrompt) overlayPrompt.style.display = 'none';

  if (typeof window.drawLiveOverlay === 'function') {
    window.drawLiveOverlay(lastFrame?.objects || [], window.playerState);
  }

  safelyReassignHoop(overlay, lastFrame);
}

/* ──────────────────────────────────────────────
 *  LOCK + ACCESSORS
 * ────────────────────────────────────────────── */
export function lockHoopToSelected(x, y) {
  anchorLockActive = true;
  manualHoopLocked = true;
  selectedHoop     = { x, y };
  recentHoopMidpoints = [{ x, y }];
  lockedHoopBox = { x, y, w: DEFAULT_RIM_W, h: DEFAULT_RIM_H };
  window.lockedHoopBox  = lockedHoopBox;
  window.__hoopAutoLocked = true;
  lastHoopSeenFrame = (window.lastDetectedFrame && window.lastDetectedFrame.__frameIdx) || 0;
  console.log('🎯 Locked hoop to:', Math.round(x), Math.round(y));
}

export function getLockedHoopBox() { return lockedHoopBox; }
export function isUserLocked()     { return manualHoopLocked; }

export function getHoopRegionBox(padding = 40) {
  const h = lockedHoopBox; if (!h) return null;
  return { x1: h.x - padding, x2: h.x + padding, y1: h.y - padding, y2: h.y + padding };
}
export function getHoopCenter() {
  const h = lockedHoopBox; return h ? { x: h.x, y: h.y } : null;
}

/* ──────────────────────────────────────────────
 *  DRAW MARKER (unchanged visuals)
 * ────────────────────────────────────────────── */
export function drawHoopMarker(ctx) {
  const hoop = getLockedHoopBox(); if (!hoop || !ctx) return;

  ctx.save();
  ctx.beginPath();
  ctx.fillStyle = 'lime';
  ctx.moveTo(hoop.x, hoop.y);
  ctx.lineTo(hoop.x - 10, hoop.y + 14);
  ctx.lineTo(hoop.x + 10, hoop.y + 14);
  ctx.closePath();
  ctx.fill();
  ctx.font = 'bold 12px sans-serif';
  ctx.fillText('🎯 Rim Center', hoop.x + 12, hoop.y);
  ctx.strokeStyle = 'red';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(hoop.x - 40, hoop.y);
  ctx.lineTo(hoop.x + 40, hoop.y);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,0,0,0.3)';
  ctx.strokeRect(hoop.x - hoop.w/2, hoop.y - hoop.h/2, hoop.w, hoop.h);
  ctx.restore();
}

/* ──────────────────────────────────────────────
 *  STABILIZER — call once per tick BEFORE drawing
 *  - freezes while ball is in rim band
 *  - tolerates hoop dropouts (adds synthetic hoop)
 *  - simple smoothing buffer to avoid jitter
 * ────────────────────────────────────────────── */
export function stabilizeLockedHoop(objects = []) {
  if (!anchorLockActive || !lockedHoopBox) return;

  const frameIdx = (window.lastDetectedFrame && window.lastDetectedFrame.__frameIdx) || 0;

  // 1) Freeze during ball–rim interaction (common ONNX flicker moment)
  if (_ballInsideHoopBand(objects, lockedHoopBox)) {
    _ensureHoopPresent(objects);           // keep a hoop object for overlays/logic
    lastHoopSeenFrame = Math.max(lastHoopSeenFrame, frameIdx);
    return;
  }

  // 2) Candidate hoops this frame
  let hoops = objects.filter(o => o.label === 'hoop' && Array.isArray(o.box));

  // Side guard: ignore candidates on the opposite side
  if (hoops.length && courtMidX != null && lockSide) {
    const M = 80;
    hoops = hoops.filter(o => {
      const [x1,y1,x2,y2] = o.box;
      const cx = (x1+x2)/2;
      return lockSide === 'L' ? (cx <= courtMidX + M) : (cx >= courtMidX - M);
    });
  }

  // 3) If no hoop reported, keep the stale lock and synthesize one for clients
  if (!hoops.length) {
    if (frameIdx - lastHoopSeenFrame <= KEEP_FRAMES) {
      _ensureHoopPresent(objects);
      return;
    }
    // still no hoop beyond KEEP_FRAMES: just keep current lock & synth for continuity
    _ensureHoopPresent(objects);
    return;
  }

  // 4) Choose nearest to current lock; only accept small moves
  const cur = lockedHoopBox;
  let best = null, bestD = Infinity;
  for (const o of hoops) {
    const [x1,y1,x2,y2] = o.box;
    const cx = (x1+x2)/2, cy = (y1+y2)/2;
    const d  = Math.hypot(cx - cur.x, cy - cur.y);
    if (d < bestD) { bestD = d; best = { x: cx, y: cy, w: x2-x1, h: y2-y1 }; }
  }
  if (!best || bestD > ACCEPT_DIST_PX) return;

  // 5) Smooth by moving average + step clamp
  recentHoopMidpoints.push({ x: best.x, y: best.y });
  if (recentHoopMidpoints.length > FRAME_BUFFER)
    recentHoopMidpoints = recentHoopMidpoints.slice(-FRAME_BUFFER);

  const avgX = recentHoopMidpoints.reduce((s,p)=>s+p.x,0)/recentHoopMidpoints.length;
  const avgY = recentHoopMidpoints.reduce((s,p)=>s+p.y,0)/recentHoopMidpoints.length;

  lockedHoopBox.x = _clampStep(cur.x, avgX, MAX_STEP_PX);
  lockedHoopBox.y = _clampStep(cur.y, avgY, MAX_STEP_PX);
  if (best.w && best.h) {
    // gently grow toward observed size (don’t shrink aggressively)
    lockedHoopBox.w = Math.max(lockedHoopBox.w, Math.round(best.w));
    lockedHoopBox.h = Math.max(lockedHoopBox.h, Math.round(best.h));
  }

  // make sure clients still see a hoop object this frame
  _ensureHoopPresent(objects);
  lastHoopSeenFrame = frameIdx;
}

/* ──────────────────────────────────────────────
 *  Helpers
 * ────────────────────────────────────────────── */
function _clampStep(prev, next, cap) {
  const d = next - prev;
  return Math.abs(d) <= cap ? next : prev + Math.sign(d)*cap;
}

function _ballInsideHoopBand(objects, hoop) {
  if (!hoop) return false;
  for (const o of (objects || [])) {
    if (o.label !== 'basketball' || !Array.isArray(o.box)) continue;
    const cx = (o.box[0]+o.box[2])/2, cy = (o.box[1]+o.box[3])/2;
    if (cx >= hoop.x - PROX_X && cx <= hoop.x + PROX_X &&
        cy >= hoop.y - PROX_Y_ABOVE && cy <= hoop.y + PROX_Y_BELOW) return true;
  }
  return false;
}

/* Ensure there is a 'hoop' object in the list this frame.
 * Prefer deriving from a real net/backboard; else from the lockedHoopBox. */
function _ensureHoopPresent(objects) {
  stats.syntheticHoops++;
  if (!Array.isArray(objects)) return;
  if (objects.some(o => o.label === 'hoop')) return;

  // 1) Derive from net if present (rim ≈ top of net bbox)
  const net = objects.find(o => o.label === 'net' && Array.isArray(o.box));
  if (net) {
    const [x1,y1,x2,y2] = net.box;
    const w  = Math.max(1, x2 - x1);
    const cx = (x1 + x2) / 2;
    const rimW = Math.max(DEFAULT_RIM_W, Math.round(w * 0.55));
    const yR = y1;
    objects.push({
      label: 'hoop', confidence: 0.51, synthetic: true,
      box: [Math.round(cx - rimW/2), yR - 4, Math.round(cx + rimW/2), yR + 4]
    });
    return;
  }

  // 2) Else derive from backboard (just below bottom)
  const bb = objects.find(o => o.label === 'backboard' && Array.isArray(o.box));
  if (bb) {
    const [x1,y1,x2,y2] = bb.box;
    const w  = Math.max(1, x2 - x1);
    const cx = (x1 + x2) / 2;
    const rimW = Math.max(DEFAULT_RIM_W, Math.round(w * 0.45));
    const yR = y2 - 10;
    objects.push({
      label: 'hoop', confidence: 0.5, synthetic: true,
      box: [Math.round(cx - rimW/2), yR - 4, Math.round(cx + rimW/2), yR + 4]
    });
    return;
  }

  // 3) Else fall back to the locked center (keep UI consistent)
  if (lockedHoopBox) {
    const x1 = Math.round(lockedHoopBox.x - lockedHoopBox.w/2);
    const y1 = Math.round(lockedHoopBox.y - lockedHoopBox.h/2);
    const x2 = x1 + lockedHoopBox.w;
    const y2 = y1 + lockedHoopBox.h;
    objects.push({ label: 'hoop', confidence: 0.49, synthetic: true, box: [x1,y1,x2,y2] });
  }
}

/* ──────────────────────────────────────────────
 *  Light pose refresh after lock (unchanged)
 * ────────────────────────────────────────────── */
export function safelyReassignHoop(overlay, lastFrame) {
  const video = document.getElementById('videoPlayer');
  if (!video || video.paused) return;

  video.pause();
  setTimeout(() => {
    const frameIndex = Math.floor(video.currentTime * 30);
    const ctx = overlay.getContext('2d');
    ctx.drawImage(video, 0, 0, overlay.width, overlay.height);

    if (window.safeDetectForVideo && window.poseDetector) {
      window.safeDetectForVideo(overlay, frameIndex).then((result) => {
        if (result?.landmarks?.length) {
          window.lastDetectedFrame.poses = result.landmarks;
          if (typeof window.drawLiveOverlay === 'function') {
            window.drawLiveOverlay(window.lastDetectedFrame.objects || [], window.playerState);
          }
        }
        video.play();
      });
    } else {
      console.warn('⚠️ safeDetectForVideo not ready');
      video.play();
    }
  }, 100);
}

/* ──────────────────────────────────────────────
 *  Optional auto-lock when you want it
 * ────────────────────────────────────────────── */
export function autoDetectHoop(objects, overlay, force = false) {
  if (!force && isUserLocked()) return;
  const candidates = (objects || []).filter(o => o.label === 'hoop' && Array.isArray(o.box));
  if (!candidates.length) return;

  const best = candidates.reduce((closest, obj) => {
    const [x1, y1, x2, y2] = obj.box;
    const cx = (x1 + x2) / 2;
    const cy = (y1 + y2) / 2;
    const dist = Math.hypot(cx - overlay.width / 2, cy - overlay.height / 2);
    return dist < closest.dist ? { x: cx, y: cy, dist } : closest;
  }, { x: 0, y: 0, dist: Infinity });

  lockHoopToSelected(best.x, best.y);
  console.log('🎯 Auto-selected hoop center:', Math.round(best.x), Math.round(best.y));
}
