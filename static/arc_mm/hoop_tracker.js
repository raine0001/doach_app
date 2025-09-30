// hoop_tracker.js — cleaned and stable, ONNX-dropout tolerant (8/20)

export let stats = { hoopDropouts: 0, syntheticHoops: 0 };

// Internal state (VIDEO‑pixel space)
let selectedHoop = null;
let lockedHoopBox = null;      // {x,y,w,h} — center form (mirrored to window.__lockedHoopBox)
let manualHoopLocked = false;
let anchorLockActive = false;

let recentHoopMidpoints = [];
const FRAME_BUFFER   = 6;      // window for simple smoothing
const ACCEPT_DIST_PX = 150;    // accept candidates near current lock
const MAX_STEP_PX    = 48;     // cap per-frame movement on update
const KEEP_FRAMES    = 45;     // hold stale lock this many frames if hoop vanishes

// Proximity band defaults (mirror shot_logger.js). Runtime prefs from UI can override.
const PROX_X = 200, PROX_Y_ABOVE = 170, PROX_Y_BELOW = 100;

// Read proximity params from runtime globals (UI prefs) with sane fallbacks
function _proxParams() {
  const p = (window.PREF_PROX || {});
  const px  = Number(isFinite(window.proxX)       ? window.proxX       : (isFinite(p.x)      ? p.x      : PROX_X));
  const pya = Number(isFinite(window.proxYAbove)  ? window.proxYAbove  : (isFinite(p.yAbove) ? p.yAbove : PROX_Y_ABOVE));
  const pyb = Number(isFinite(window.proxYBelow)  ? window.proxYBelow  : (isFinite(p.yBelow) ? p.yBelow : PROX_Y_BELOW));
  return { px, pya, pyb };
}

// default rim size when we can't infer
const DEFAULT_RIM_W = 88;
const DEFAULT_RIM_H = 36;

// side guard to avoid hopping to the other hoop
let courtMidX = null;
let lockSide  = null;          // 'L' | 'R'
let lastHoopSeenFrame = -1;

window.isUserLocked = isUserLocked;

/*
 * Single‑source‑of‑truth writer for the current lock (VIDEO px).
 * Always mirror to window.__lockedHoopBox so other modules can consume it.
 */
function _writeLock(cx, cy, w = DEFAULT_RIM_W, h = DEFAULT_RIM_H) {
  const sane = _sanitizeHoopCenter(cx, cy, w, h);
  lockedHoopBox = { x: sane.x, y: sane.y, w: sane.w, h: sane.h };
  try { window.__lockedHoopBox = { cx: sane.x, cy: sane.y, w: sane.w, h: sane.h }; } catch {}
  return lockedHoopBox;
}

// Shared sanitizer: convert canvas/backing-store px → VIDEO px when needed and clamp
function _sanitizeHoopCenter(cx, cy, w, h) {
  try {
    const V = window.__VIEW || null; // { vw, vh, sx, sy }
    if (V && Number.isFinite(V.vw) && Number.isFinite(V.vh) && Number.isFinite(V.sx) && Number.isFinite(V.sy)) {
      const looksCanvas = (cx > V.vw * 1.05) || (cy > V.vh * 1.05) || (w > V.vw * 0.75) || (h > V.vh * 0.75);
      if (looksCanvas) { cx /= (V.sx||1); cy /= (V.sy||1); w /= (V.sx||1); h /= (V.sy||1); }
      cx = Math.min(Math.max(0, cx), V.vw||cx);
      cy = Math.min(Math.max(0, cy), V.vh||cy);
    }
  } catch {}
  return { x: cx, y: cy, w: Math.max(1,w), h: Math.max(1,h) };
}

/* ──────────────────────────────────────────────
 *  Canonical hoop geometry (moved from shot_utils)
 * ────────────────────────────────────────────── */
export function canonHoop(raw = {}) {
  // 1) derive center and size from various shapes
  let w = Math.max(1, raw.w ?? raw.width ?? ((raw.x2 ?? 0) - (raw.x1 ?? 0)));
  let h = Math.max(1, raw.h ?? raw.height ?? ((raw.y2 ?? 0) - (raw.y1 ?? 0)));
  let cx, cy;
  if (raw.cx != null && raw.cy != null) {
    cx = raw.cx; cy = raw.cy;
  } else if (raw.x1 != null && raw.y1 != null && raw.x2 != null && raw.y2 != null) {
    cx = raw.x1 + w/2; cy = raw.y1 + h/2;
  } else if (raw.anchor === 'topleft' || raw.leftTop || raw.topLeft || raw.isLeftTop) {
    cx = (raw.x ?? 0) + w/2; cy = (raw.y ?? 0) + h/2;
  } else if (raw.x != null && raw.y != null) {
    cx = raw.x; cy = raw.y;
  } else { cx = 0; cy = 0; }

  // 2) If values appear to be in CANVAS/backing-store pixels, convert to VIDEO px
  try {
    const V = window.__VIEW || null; // { vw, vh, sx, sy }
    if (V && Number.isFinite(V.vw) && Number.isFinite(V.vh) && Number.isFinite(V.sx) && Number.isFinite(V.sy)) {
      const looksCanvas = (cx > V.vw * 1.05) || (cy > V.vh * 1.05) || (w > V.vw * 0.75) || (h > V.vh * 0.75);
      if (looksCanvas) {
        const fx = V.sx || 1, fy = V.sy || 1;
        cx = cx / fx; cy = cy / fy; w = w / fx; h = h / fy;
      }
    }
  } catch {}

  const x1 = cx - w/2, y1 = cy - h/2;
  return { cx, cy, w, h, x1, y1, x2: x1 + w, y2: y1 + h, rimY: y1 };
}

/**
 * Filter detector objects to only keep 'hoop' and 'net' near the locked hoop.
 * Keeps all other labels intact.
 */
export function filterObjectsToLockedHoop(objects = []) {
  const H = getLockedHoopBox?.();
  if (!H || !Array.isArray(objects) || !objects.length) return objects;

  // Build a permissive region around the locked hoop
  const proxX      = Number(window.proxX)      || 200;
  const proxYAbove = Number(window.proxYAbove) || 170;
  const proxYBelow = Number(window.proxYBelow) || 100;
  const cx = H.cx ?? (H.x + (H.w || 0)/2);
  const cy = H.cy ?? (H.y + (H.h || 0)/2);
  const rimTop = (H.rimTop != null) ? H.rimTop : (cy - (H.h || 36)/2);
  const box = { x1: cx - proxX, x2: cx + proxX, y1: rimTop - proxYAbove*1.5, y2: rimTop + proxYBelow*2.0 };

  return objects.filter(o => {
    if (!o || !Array.isArray(o.box)) return true;
    if (o.label !== 'hoop' && o.label !== 'net') return true; // keep others
    const [x1,y1,x2,y2] = o.box;
    const ox = (x1 + x2) / 2, oy = (y1 + y2) / 2;
    return (ox >= box.x1 && ox <= box.x2 && oy >= box.y1 && oy <= box.y2);
  });
}

export function asTopLeft(H) { return { x: H.x1, y: H.y1, w: H.w, h: H.h }; }

/* ──────────────────────────────────────────────
 *  CLICK → CHOOSE HOOP, favoring nearest 'hoop'
 * ────────────────────────────────────────────── */
export function handleHoopSelection(e, overlay, lastFrame, promptBar) {
  const V = window.__VIEW;
  if (!V) return;

  // CSS coords inside overlay
  const r = overlay.getBoundingClientRect();
  const cssX = e.clientX - r.left;
  const cssY = e.clientY - r.top;

  // convert to VIDEO pixel coords
  const clickX = cssX / V.scale;
  const clickY = cssY / V.scale;

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
    // Only snap to detected hoop if reasonably near the user's tap; else use the tap
    const MAX_SNAP_DIST = Math.max(120, (V.vw || overlay.width) * 0.08);
    if (best && bestD <= MAX_SNAP_DIST) {
      pick = { x: best.cx, y: best.cy, rw: best.rw, rh: best.rh };
    }
  }
  try { console.log('[pick]', { click:{x:clickX,y:clickY}, snap: pick, viaDetect: (pick.x!==clickX||pick.y!==clickY) }); } catch {}

  lockHoopToSelected(pick.x, pick.y);
  // grow toward observed size
  lockedHoopBox.w = Math.max(lockedHoopBox.w, pick.rw || DEFAULT_RIM_W);
  lockedHoopBox.h = Math.max(lockedHoopBox.h, pick.rh || DEFAULT_RIM_H);
  _writeLock(lockedHoopBox.x, lockedHoopBox.y, lockedHoopBox.w, lockedHoopBox.h);

  // side guard baseline in video space
  courtMidX = (V.vw || overlay.width) / 2;
  lockSide  = pick.x < courtMidX ? 'L' : 'R';

  if (promptBar) { promptBar.textContent = ''; promptBar.style.display = 'none'; }
  const overlayPrompt = document.getElementById('overlayPrompt');
  if (overlayPrompt) overlayPrompt.style.display = 'none';

  if (typeof window.drawLiveOverlay === 'function') {
    try { window.drawLiveOverlay(lastFrame?.objects || [], window.playerState); } catch {}
    try {
      if (window.DOACH_OVERLAY_TRACE) {
        console.log('[hoop:locked]', {
          tap: { x: pick.x|0, y: pick.y|0 },
          box: { x: lockedHoopBox?.x|0, y: lockedHoopBox?.y|0, w: lockedHoopBox?.w|0, h: lockedHoopBox?.h|0 },
          view: window.__VIEW
        });
      }
    } catch {}
  }
  safelyReassignHoop(overlay, lastFrame); try { window.dispatchEvent(new CustomEvent('hoop:locked', { detail: { cx: lockedHoopBox?.x, cy: lockedHoopBox?.y } })); } catch {}
}


/* ──────────────────────────────────────────────
 *  LOCK + ACCESSORS
 * ────────────────────────────────────────────── */
export function lockHoopToSelected(x, y) {
  anchorLockActive = true;
  manualHoopLocked = true;
  selectedHoop     = { x, y };
  recentHoopMidpoints = [{ x, y }];
  lockedHoopBox = _writeLock(x, y, DEFAULT_RIM_W, DEFAULT_RIM_H);
  window.lockedHoopBox  = lockedHoopBox;
  try { window.__hoopLockFreezeUntil = performance.now() + 1800; } catch {}
  window.__hoopAutoLocked = true;
  try { window.__hoopLockFlashUntil = performance.now() + 1500; } catch {}
  lastHoopSeenFrame = (window.lastDetectedFrame && window.lastDetectedFrame.__frameIdx) || 0;
  console.log('🎯 Locked hoop to:', Math.round(x), Math.round(y));
}

export function getLockedHoopBox() {
  try {
    const extBox = window.__lockedHoopBox; // external canonical center
    if (extBox && Number.isFinite(extBox.cx) && Number.isFinite(extBox.cy)) {
      const ww = Math.max(1, extBox.w || extBox.width || ((extBox.x2 ?? 0) - (extBox.x1 ?? 0)) || DEFAULT_RIM_W);
      const hh = Math.max(1, extBox.h || extBox.height || ((extBox.y2 ?? 0) - (extBox.y1 ?? 0)) || DEFAULT_RIM_H);
      return _sanitizeHoopCenter(extBox.cx, extBox.cy, ww, hh);
    }
  } catch {}

  if (lockedHoopBox && Number.isFinite(lockedHoopBox.x) && Number.isFinite(lockedHoopBox.y)) {
    return _sanitizeHoopCenter(lockedHoopBox.x, lockedHoopBox.y, lockedHoopBox.w || DEFAULT_RIM_W, lockedHoopBox.h || DEFAULT_RIM_H);
  }
  return null;
}
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
  let hoop = getLockedHoopBox();
  if ((!hoop || !Number.isFinite(hoop.x)) && typeof window !== 'undefined') {
    try {
      const ext = window.__lockedHoopBox;
      if (ext && Number.isFinite(ext.cx) && Number.isFinite(ext.cy)) {
        const w = Math.max(1, ext.w || ext.width || 88);
        const h = Math.max(1, ext.h || ext.height || 36);
        hoop = { x: ext.cx, y: ext.cy, w, h };
      }
    } catch {}
  }
  if (!hoop || !ctx) return;

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
  // Adopt external lock if present (tests or shim)
  try {
    if (!lockedHoopBox) {
      const ext = window.__lockedHoopBox;
      if (ext && Number.isFinite(ext.cx) && Number.isFinite(ext.cy)) {
        _writeLock(ext.cx, ext.cy, ext.w || DEFAULT_RIM_W, ext.h || DEFAULT_RIM_H);
        anchorLockActive = true;
      }
    }
  } catch {}

  if (!lockedHoopBox) return;

  const frameIdx = (window.lastDetectedFrame && window.lastDetectedFrame.__frameIdx) || 0;

  // Live sessions: normally hold manual lock stable; optionally allow re-lock on drift
  try {
    const allowRelock = (window.RELOCK_HOOP_ON_DRIFT === true);
    if (window.__SESSION_ACTIVE && !allowRelock) {
      _ensureHoopPresent(objects);
      lastHoopSeenFrame = frameIdx;
      return;
    }
  } catch {}

  // Freeze mapping for a short window immediately after manual lock to avoid
  // detector jitter pulling the rim far below/above the user-selected center.
  try {
    const until = Number(window.__hoopLockFreezeUntil || 0);
    if (until && performance.now() < until) {
      _ensureHoopPresent(objects);
      lastHoopSeenFrame = frameIdx;
      return;
    }
  } catch {}

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

  // 4) Choose nearest to current lock; allow hard recenter if way off
  const cur = lockedHoopBox;
  let best = null, bestD = Infinity;
  for (const o of hoops) {
    const [x1,y1,x2,y2] = o.box;
    const cx = (x1+x2)/2, cy = (y1+y2)/2;
    const d  = Math.hypot(cx - cur.x, cy - cur.y);
    if (d < bestD) { bestD = d; best = { x: cx, y: cy, w: x2-x1, h: y2-y1 }; }
  }
  if (!best) return;
  const HARD_RECENTER_DIST = 300;
  if (bestD > ACCEPT_DIST_PX && bestD <= HARD_RECENTER_DIST) return;
  if (bestD > HARD_RECENTER_DIST) {
    lockedHoopBox.x = Math.round(best.x);
    lockedHoopBox.y = Math.round(best.y);
    if (best.w && best.h) { lockedHoopBox.w = Math.round(best.w); lockedHoopBox.h = Math.round(best.h); }
    _ensureHoopPresent(objects);
    lastHoopSeenFrame = frameIdx;
    _writeLock(lockedHoopBox.x, lockedHoopBox.y, lockedHoopBox.w, lockedHoopBox.h);
    return;
  }

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
  try { if (lockedHoopBox) window.__lockedHoopBox = { cx: lockedHoopBox.x, cy: lockedHoopBox.y, w: lockedHoopBox.w, h: lockedHoopBox.h }; } catch {}
}

/* ──────────────────────────────────────────────
 *  Helpers
 * ────────────────────────────────────────────── */
// --- Auto-resolve hoop when multiple are detected -------------------------

/**
 * Score a candidate hoop using ball trail, pose, and geometry.
 * @param {Object} cand   {box:[x1,y1,x2,y2], cx, cy, area}
 * @param {Object} ctx    {trail, releasePt, videoW, videoH, pose}
 * @returns {number} 0..1 score
 */
function scoreHoopCandidate(cand, ctx) {
  const { trail, releasePt, videoW, videoH, pose } = ctx;
  const { cx, cy, area } = cand;

  // 1) Trajectory fit (distance from rim to early motion ray)
  let trajScore = 0.5;
  if (trail && trail.length >= 3) {
    const a = trail[0], b = trail[Math.min(5, trail.length - 1)];
    const vx = b.x - a.x, vy = b.y - a.y;
    const num = Math.abs(vy * cx - vx * cy + (b.x * a.y - b.y * a.x));
    const den = Math.hypot(vx, vy) + 1e-6;
    const d = num / den;                    // px distance rim↔ray
    const sigma = Math.max(16, 0.02 * Math.max(videoW, videoH));
    trajScore = Math.exp(-(d * d) / (2 * sigma * sigma)); // 1 when close
  }

  // 2) Direction check (ball horizontal direction should match rim side)
  let dirScore = 0.6;
  if (releasePt && trail && trail[1]) {
    const dx0 = trail[1].x - trail[0].x;
    const sameSide = (dx0 >= 0 && cx >= releasePt.x) || (dx0 <= 0 && cx <= releasePt.x);
    dirScore = sameSide ? 1.0 : 0.2;
  }

  // 3) Size / depth
  const sizeScore = Math.min(1, Math.sqrt(area) / Math.max(80, 0.04 * videoW * videoH));

  // 4) Pose facing (use shoulders if present)
  let poseScore = 0.6;
  try {
    const kp = pose || [];
    const ls = kp[11], rs = kp[12], nose = kp[0];
    if (ls && rs && nose) {
      const faceX = nose.x - (ls.x + rs.x) / 2;
      const faceY = nose.y - (ls.y + rs.y) / 2;
      const toHoopX = cx - nose.x, toHoopY = cy - nose.y;
      const dot = faceX * toHoopX + faceY * toHoopY;
      const n1 = Math.hypot(faceX, faceY) + 1e-6;
      const n2 = Math.hypot(toHoopX, toHoopY) + 1e-6;
      const cos = dot / (n1 * n2);
      poseScore = Math.max(0, (cos + 1) / 2); // map [-1,1]→[0,1]
    }
  } catch {}

  // 5) Vertical plausibility (reject mezzanine/background outliers)
  const yNorm = cy / (videoH || 1);
  const verticalScore = (yNorm > 0.12 && yNorm < 0.65) ? 1 : 0.4;

  // Weighted sum
  const score =
    0.40 * trajScore +
    0.20 * dirScore  +
    0.20 * sizeScore +
    0.15 * poseScore +
    0.05 * verticalScore;

  return Math.max(0, Math.min(1, score));
}

/**
 * Given detection objects, choose the most likely hoop.
 * @param {Array} objects  detector objects (label, box)
 * @param {Object} opts    {trail, pose, releasePt, videoW, videoH}
 * @returns {{best:object|null, confidence:number, scores:Array}}
 */
export function autoResolveHoop(objects, opts = {}) {
  const hoops = (objects || [])
    .filter(o => o.label === 'hoop' && Array.isArray(o.box))
    .map(o => {
      const [x1, y1, x2, y2] = o.box;
      const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
      const area = Math.max(1, (x2 - x1) * (y2 - y1));
      return { ...o, cx, cy, area };
    });

  if (hoops.length === 0) return { best: null, confidence: 0, scores: [] };
  if (hoops.length === 1)  return { best: hoops[0], confidence: 1, scores: [{ idx:0, score: 1 }] };

  const scores = hoops.map((h, idx) => ({ idx, score: scoreHoopCandidate(h, opts) }));
  scores.sort((a, b) => b.score - a.score);
  const best  = hoops[scores[0].idx];
  const conf  = scores[0].score - (scores[1]?.score ?? 0);
  return { best, confidence: Math.max(0, Math.min(1, conf)), scores };
}


function _clampStep(prev, next, cap) {
  const d = next - prev;
  return Math.abs(d) <= cap ? next : prev + Math.sign(d)*cap;
}

function _ballInsideHoopBand(objects, hoop) {
  if (!hoop) return false;
  const { px, pya, pyb } = _proxParams();
  for (const o of (objects || [])) {
    if (o.label !== 'basketball' || !Array.isArray(o.box)) continue;
    const cx = (o.box[0]+o.box[2])/2, cy = (o.box[1]+o.box[3])/2;
    if (cx >= hoop.x - px && cx <= hoop.x + px &&
        cy >= hoop.y - pya && cy <= hoop.y + pyb) return true;
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
 *  Net motion detection (moved from shot_utils)
 * ────────────────────────────────────────────── */
let _netState = { luma: null, w: 0, h: 0, frames: 0 };
export function resetNetMotion() { _netState = { luma: null, w: 0, h: 0, frames: 0 }; }

export function detectNetMotionFromCanvas(canvas, hoopBox, opts = {}) {
  if (!canvas || !hoopBox) return false;
  const ctx = canvas.getContext('2d');
  const w = Math.max(8, Math.round(hoopBox.w));
  const h = Math.max(8, Math.round((hoopBox.h || 40) * (opts.heightRatio ?? 0.6)));
  const x = Math.round(hoopBox.x - w / 2);
  const y = Math.round(hoopBox.y + (hoopBox.h || 40));
  const cw = canvas.width, ch = canvas.height;
  const rx = Math.max(0, Math.min(cw - 1, x));
  const ry = Math.max(0, Math.min(ch - 1, y));
  const rw = Math.max(1, Math.min(cw - rx, w));
  const rh = Math.max(1, Math.min(ch - ry, h));
  const img = ctx.getImageData(rx, ry, rw, rh);
  const data = img.data;
  const stride = Math.max(1, opts.stride ?? 2);
  const diffThreshold = opts.diffThreshold ?? 28;
  const movementThreshold = opts.movementThreshold ?? 0.06;
  const cur = new Uint8ClampedArray(Math.ceil((rw * rh) / (stride * stride)));
  let idx = 0;
  for (let yy = 0; yy < rh; yy += stride) {
    for (let xx = 0; xx < rw; xx += stride) {
      const i = (yy * rw + xx) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      cur[idx++] = (0.299 * r + 0.587 * g + 0.114 * b) | 0; // Rec.601 luma
    }
  }
  const dimChanged = _netState.w !== rw || _netState.h !== rh || !_netState.luma || _netState.luma.length !== cur.length;
  if (dimChanged || _netState.frames < 1) {
    _netState = { luma: cur, w: rw, h: rh, frames: (_netState.frames + 1) };
    return false;
  }
  let moved = 0;
  for (let i = 0; i < cur.length; i++) if (Math.abs(cur[i] - _netState.luma[i]) > diffThreshold) moved++;
  const pct = moved / cur.length;
  _netState.luma = cur; _netState.frames++;
  return pct > movementThreshold;
}

/* ──────────────────────────────────────────────
 *  Light pose refresh after lock (unchanged)
 * ────────────────────────────────────────────── */
export function safelyReassignHoop(overlay, lastFrame) {
  const __v = document.getElementById('videoPlayer'); if (__v && __v.srcObject) { try { window.dispatchEvent(new CustomEvent('hoop:locked', { detail: { via: 'live' } })); } catch {} return; }
  const video = document.getElementById('videoPlayer');
  if (!video || video.paused) return;
  // 🔒 Live camera: do NOT pause/seek for reassignment
  if (video.srcObject) {
    // Draw once to confirm lock
    try { window.drawLiveOverlay?.(window.lastDetectedFrame?.objects || [], window.playerState); } catch {}
    // Trigger a one-shot pose read so pose is present immediately after lock
    try {
      (async () => {
        try {
          if (window.__coachPoseBusy) return;
          window.__coachPoseBusy = true;
          const ts = performance.now();
          const res = await (window.poseDetector?.detectForVideo ? window.poseDetector.detectForVideo(video, ts) : (window.poseDetectSerial?.() || Promise.resolve(null)));
          const raw = res?.landmarks;
          const cand = Array.isArray(raw?.[0]) ? raw[0] : raw;
          if (!Array.isArray(cand) || cand.length < 33) return;
          if (cand.some(k => !k || !Number.isFinite(k.x) || !Number.isFinite(k.y))) return;
          const looksNorm = cand.every(k=>k && k.x <= 1.01 && k.y <= 1.01);
          const sx = looksNorm ? (video.videoWidth||1)  : 1;
          const sy = looksNorm ? (video.videoHeight||1) : 1;
          const scaled = cand.map(k=>({ ...k, x: k.x * sx, y: k.y * sy }));
          try { updatePlayerTracker?.(scaled, (window.__frameIdx||0)); } catch {
            if (!window.playerState) window.playerState = { keypoints: [] };
            window.playerState.keypoints = scaled;
            try { window.__lastPoseKP = scaled; window.__lastPoseTS = performance.now(); window.__lastPoseUpdateMs = performance.now(); window.__lastPoseWrist = scaled[16] || null; } catch {}
          }
          try { window.__poseFlashUntil = performance.now() + 1200; } catch {}
        } catch {}
        finally { window.__coachPoseBusy = false; }
      })();
    } catch {}
    return;
  }


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
