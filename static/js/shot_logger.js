// shot_logger.js — consolidated, weighted scoring always used

import {
  score,
  showShotSummaryOverlay as canvasOverlay,
  estimateReleaseAngle,
  detectNetMotionFromCanvas,
  resetNetMotion
} from './shot_utils.js';

import { markRelease, freezeShot } from './ball_tracker.js';
import { getLockedHoopBox } from './hoop_tracker.js';

// lazy accessor breaks the TDZ on cyclic imports
function BS() {
  return (window.ballState || (window.ballState = {}));
}
function ensureBallLatches() {
  const s = BS();
  if (typeof s._lastInProx === 'undefined') s._lastInProx = false;
  if (typeof s._lastY     === 'undefined') s._lastY     = 0;
  if (typeof s.releaseSignaled === 'undefined') s.releaseSignaled = false;
  if (typeof s.summarySignaled  === 'undefined') s.summarySignaled  = false;
  return s;
}

const updateCoachNotes = (...args) => window.updateCoachNotes?.(...args);

// ===== State =====
export const shotLog = [];
window.shotLog = shotLog;
let lastShotFrameId = -1;
let __lastScoredCount = 0; // how many frozen shots we've already scored
window.__shotFinalizeLock = false;
let __releaseEventSent = false;


if (window.updateCoachNotes && window.summarizePoseIssues) {
  updateCoachNotes(shotLog.at(-1));
}

try { window.drawShotStatsTable?.(); } catch {}
try { window.updateBottomStats?.(); } catch {}

// ===== Constants =====
const PROX_X = 200, 
PROX_Y_ABOVE = 170, 
PROX_Y_BELOW = 100,
FBF_RATE = 3.0;   // ## fps (3 works good, 0.7 for super slow)

const WEIGHTED_THRESH = 0.65;

// weighted = onnx flicker
// hybrid = adds region, a bit looser than weighted
window.SHOT_SCORER_MODE ??= 'weighted';   // 'weighted' | 'hybrid'


// ===== Scorer preferences =====
window.SHOT_SCORER_MODE ??= (localStorage.getItem('doach_scorer_mode') || 'weighted');
window.WEIGHTED_THRESH  ??= Number(localStorage.getItem('doach_weighted_thresh')) || WEIGHTED_THRESH;

export function getScorerMode() {
  return String(window.SHOT_SCORER_MODE || 'weighted').toLowerCase();
}
export function setScorerMode(mode = 'weighted') {
  const m = String(mode).toLowerCase();
  window.SHOT_SCORER_MODE = m;
  localStorage.setItem('doach_scorer_mode', m);
  console.log('[scorer] mode =', m);
}
window.setScorerMode = setScorerMode; // also available from console

export function setWeightedThresh(v) {
  const n = Math.max(0.5, Math.min(0.95, Number(v) || 0.75));
  window.WEIGHTED_THRESH = n;
  localStorage.setItem('doach_weighted_thresh', String(n));
  console.log('[scorer] threshold =', n);
}
window.setWeightedThresh = setWeightedThresh;


// ===== Helpers =====

// use UI prox values
function currentProx() {
  const p = window.PREF_PROX || {};
  return {
    X:       Number.isFinite(p.x) ? p.x : PROX_X,
    Y_ABOVE: Number.isFinite(p.yAbove) ? p.yAbove : PROX_Y_ABOVE,
    Y_BELOW: Number.isFinite(p.yBelow) ? p.yBelow : PROX_Y_BELOW
  };
}


// ---------- shot cycle event conditions ----------  //
let __awaitingBallReset = false;

// --- normalize hoop regardless of anchor ---
function normLockedHoop(hoop) {
  if (!hoop) return null;
  const w = hoop.w ?? hoop.width ?? 0;
  const h = hoop.h ?? hoop.height ?? 0;
  if (Number.isFinite(hoop.cx) && Number.isFinite(hoop.cy)) {
    const cx = hoop.cx, cy = hoop.cy, x1 = cx - w/2, y1 = cy - h/2;
    return { cx, cy, w, h, x1, y1, x2: x1+w, y2: y1+h, rimTop: y1 };
  }
  const x1 = hoop.x ?? 0, y1 = hoop.y ?? 0, cx = x1 + w/2, cy = y1 + h/2;
  return { cx, cy, w, h, x1, y1, x2: x1+w, y2: y1+h, rimTop: y1 };
}

// Use UI prefs if present
function proxBox(H) {
  const PROX_X       = Number(window.proxX)      || 200;
  const PROX_Y_ABOVE = Number(window.proxYAbove) || 170;
  const PROX_Y_BELOW = Number(window.proxYBelow) || 100;
  return { x1: H.cx - PROX_X, x2: H.cx + PROX_X, yTop: H.rimTop - PROX_Y_ABOVE, yBot: H.rimTop + PROX_Y_BELOW };
}
function inProx(pt, PB) {
  return pt.x >= PB.x1 && pt.x <= PB.x2 && pt.y >= PB.yTop && pt.y <= PB.yBot;
}

// Latches for exit-direction logic
if (typeof BS._lastInProx === 'undefined') BS._lastInProx = false;
if (typeof BS._lastY     === 'undefined') BS._lastY     = 0;

let __shotInProgress = false;
let __awaitingReset  = false;

export function checkShotConditions(ballStateRef, hoopBox, frameIndex) {
  const H = normLockedHoop(hoopBox);
  const last = ballStateRef?.trail?.at?.(-1);
  if (!H || !last) return false;

  // CHANGED: use the same normalized hoop to build prox box
  const PROX = _proxBoxFromHoop(H);
  const nowInProx =
    (last.x >= PROX.x1 && last.x <= PROX.x2 && last.y >= PROX.yTop && last.y <= PROX.yBot);

  const s = ensureBallLatches();

  // Arm on enter OR if pose already fired release
  if ((!__shotInProgress && nowInProx && !__awaitingReset) || s.releaseSignaled) {
    __shotInProgress = true;
    if (!s.releaseSignaled) {
      try { markRelease?.(frameIndex); } catch {}
      s.releaseSignaled = true;
      try { window.dispatchEvent(new Event('shot:release')); } catch {}
    }
  }

  // CHANGED: “belt & suspenders” finalization
  const leftProx = s._lastInProx && !nowInProx;
  const exitedBottomDownward = leftProx && (last.y >= PROX.yBot - 2) && (last.y >= s._lastY);
  const exitedBottomByLatch  = (ballStateRef.proxExitFrame != null) && (last.y >= PROX.yBot - 2);
  const exitedBottom = exitedBottomDownward || exitedBottomByLatch;

  if (__shotInProgress && exitedBottom) {
    __shotInProgress = false;
    __awaitingReset  = true;

    if (ballStateRef.state !== 'FROZEN') { try { freezeShot?.(null); } catch {} }

    
    // --- improved logging: prefer frozen trail; else tail of live trail ---
    let shotRecord = null;
    const frozen = ballStateRef.shots?.at?.(-1);
    const trailForLog =
      (frozen?.trail?.length >= 3) ? frozen.trail :
      (ballStateRef?.trail?.length >= 3 ? ballStateRef.trail.slice(-28) : null);

    if (trailForLog) {
      try {
        // use frameIndex from the exit frame; detectAndLogShot de-dupes internally
        shotRecord = detectAndLogShot?.(trailForLog, frameIndex, hoopBox) || null;
      } catch {}
    }
    // last resort: reuse the last record if we just wrote it
    if (!shotRecord && window.shotLog?.length) shotRecord = window.shotLog.at(-1);


    if (!s.summarySignaled) {
      s.summarySignaled = true;
      try { window.dispatchEvent(new CustomEvent('shot:summary', { detail: shotRecord || null })); } catch {}
    }

    // update latches
    s._lastInProx = nowInProx;
    s._lastY      = last.y;
    return true;
  }

  // Allow next attempt once ball rises above rim
  if (__awaitingReset && last.y < (H.rimTop - 40)) {
    __awaitingReset     = false;
    s.releaseSignaled   = false;
    s.summarySignaled   = false;
  }

  s._lastInProx = nowInProx;
  s._lastY      = last.y;
  return false;
}

// Compute a normalized proximity box from a (center or topleft) hoop box
function _proxBoxFromHoop(hoop) {
  const H = normLockedHoop(hoop);
  if (!H) return null;
  const PROX_X       = Number(window.proxX)      || 200;
  const PROX_Y_ABOVE = Number(window.proxYAbove) || 170;
  const PROX_Y_BELOW = Number(window.proxYBelow) || 100;
  return { H, x1: H.cx - PROX_X, x2: H.cx + PROX_X, yTop: H.rimTop - PROX_Y_ABOVE, yBot: H.rimTop + PROX_Y_BELOW };
}

/** Robust proximity test with small hysteresis while tracking */
export function isBallInProximityZone(ballPt, hoopBox = null, opts = {}) {
  if (!ballPt) return false;
  const rawHoop = hoopBox || getLockedHoopBox?.();
  const PB = _proxBoxFromHoop(rawHoop);
  if (!PB) return false;

  const s = BS();
  const mode = opts.mode || 'stay';   // 'enter' (tighter) | 'stay' (looser)
  const pad  = Number(opts.hysteresisPx) ??
               ((s.state === 'TRACKING' || s.releaseSignaled) ? (Number(window.proxHys) || 6) : 0);

  const x1 = PB.x1 - (mode === 'stay' ? pad : 0);
  const x2 = PB.x2 + (mode === 'stay' ? pad : 0);
  const yT = PB.yTop - (mode === 'stay' ? pad : 0);
  const yB = PB.yBot + (mode === 'stay' ? pad : 0);

  return (ballPt.x >= x1 && ballPt.x <= x2 && ballPt.y >= yT && ballPt.y <= yB);
}


// ===== Scoring =====
function getMissReason(trail, hoopBox) {
  if (!trail || trail.length < 3 || !hoopBox) return 'Unclassified miss';

  // normalize hoop to center
  const H = normHoop(hoopBox);
  const rimY = H.cy;

  // 0) arc height check
  const apexY = Math.min(...trail.map(p => p.y));
  if (apexY >= rimY - 8) return 'Did not rise above rim';

  // 1) first rim crossing (from above -> below), interpolate xAt
  let cross = null;
  for (let i = 1; i < trail.length; i++) {
    const p0 = trail[i - 1], p1 = trail[i];
    if (p0.y <= rimY && p1.y > rimY) {
      const t = (rimY - p0.y) / (p1.y - p0.y);
      cross = { idx: i, xAt: p0.x + (p1.x - p0.x) * t };
      break;
    }
  }
  if (!cross) {
    // never made it back down through rim line
    return (trail.at(-1).y < rimY) ? 'Fell short of rim' : 'No rim crossing';
  }

  // 2) lateral at rim line (tube preferred, net band fallback)
  const tubeHalf = Math.max(12, Math.round(H.w * 0.18));
  const netHalf  = Math.max(26, Math.round(H.w * 0.33));
  if (cross.xAt < H.cx - netHalf) return 'Rim cross wide left';
  if (cross.xAt > H.cx + netHalf) return 'Rim cross wide right';

  // 3) descent through net region for a few frames after crossing
  const netYTop = rimY;
  const netYBot = H.cy + Math.max(48, Math.round(H.h * 1.2));
  const netX1   = H.cx - netHalf, netX2 = H.cx + netHalf;

  let run = 0;
  for (let i = Math.max(1, cross.idx); i < trail.length; i++) {
    const p0 = trail[i - 1], p1 = trail[i];
    const inside = (p1.x >= netX1 && p1.x <= netX2 && p1.y >= netYTop && p1.y <= netYBot);
    const descendingOrFlat = (p1.y - p0.y) >= -1.5; // allow tiny up-ticks
    if (inside && descendingOrFlat) { run++; if (run >= 3) break; }
    else run = 0;
  }
  if (run < 3) return 'Did not descend through net region';

  // 4) catch-all lateral end state
  const last = trail.at(-1);
  if (last.x < H.cx - H.w || last.x > H.cx + H.w) return 'Missed left/right';

  return 'Unclassified miss';
}

//-----------------------------------------------------------------//
//                   Detect and log a shot summary                 //
//-----------------------------------------------------------------//
export function detectAndLogShot(trail, __frameIdx, hoopBox) {
  if (!trail || trail.length < 3 || !hoopBox) return;
  // de-dupe by frame + time + trail hash
  if (__frameIdx === lastShotFrameId) return shotLog.at(-1) ?? null;
  if (!shouldLogShot(trail, __frameIdx)) return shotLog.at(-1) ?? null;
  lastShotFrameId = __frameIdx;

  const mode   = String(window.SHOT_SCORER_MODE || 'weighted').toLowerCase();
  const first  = trail[0];
  const lastPt = trail.at(-1);

  // arc metrics (top-left hoop box → height from rim top)
  const apexY        = Math.min(...trail.map(p => p.y));
  const arcHeight    = Math.max(0, Math.round(hoopBox.y - apexY));
  const releaseAngle = estimateReleaseAngle(trail);

  // net motion (guarded)
  let netMoved = null;
  try {
    const canvas = window.videoCanvas || window.__videoCanvas || null;
    if (canvas && typeof detectNetMotionFromCanvas === 'function') {
      netMoved = detectNetMotionFromCanvas(canvas, hoopBox);
    }
  } catch {}

  // region + weighted
  let region = {};
  try { region = score(trail, hoopBox, netMoved) || {}; } catch { region = {}; }
  const regionMade    = !!region.made;
  const entryAngle    = Number.isFinite(region.entryAngle) ? region.entryAngle : 0;
  const weightedScore = computeWeightedShotScore(trail);
  const weightMade    = weightedScore >= (window.WEIGHTED_THRESH ?? 0.75);

  const made   = (mode === 'hybrid') ? (regionMade || weightMade) : weightMade;
  const reason = made ? null : (region.reason || getMissReason(trail, hoopBox));

  // reflect decision back on last frozen shot (for coloring)
  const lastFrozen = BS().shots?.at?.(-1);
  if (lastFrozen) {
    lastFrozen.made     = made;
    lastFrozen.score    = weightedScore;
    lastFrozen.netMoved = !!netMoved;
  }

  // optional pose snapshot for coach
  const poseSnapshot = (window.capturePoseSnapshot?.(window.playerState, hoopBox)) || null;

  // build + log record
  const shotRecord = {
    frameStart: first.frame,
    frameEnd:   lastPt.frame,
    trail,
    made,
    entryAngle,
    releaseAngle,
    arcHeight,
    missReason: reason,
    netMoved: !!netMoved,
    weightedScore,
    scorerMode: mode,
    regionMade,
    weightMade,
    poseSnapshot
  };
  const rec = logShot(shotRecord);
  rec.__hash = trailHash(trail);   // stash for potential future de-dupe

  // UI updates
  try { drawShotStatsTable?.(); updateBottomStats?.(); } catch {}

  // on-canvas summary overlay
  if (typeof canvasOverlay === 'function') {
    canvasOverlay({ made, arcHeight, entryAngle, releaseAngle }, hoopBox);
  }

  // banner
  const madeShots  = shotLog.filter(s => s.made).length;
  const totalShots = shotLog.length || 1;
  const accuracy   = Math.round((madeShots / totalShots) * 100);
  window.showShotBanner?.({ made, arcHeight, entryAngle, releaseAngle, accuracy, madeShots, totalShots });

  // ✅ Coach / TTS exactly once per logged record
  window.__lastAnnouncedShotId = window.__lastAnnouncedShotId || 0;
  if (rec && window.__lastAnnouncedShotId !== rec.id) {
    window.__lastAnnouncedShotId = rec.id;
    try { window.doachOnShot?.(rec); } catch (e) { console.warn('[doach] feedback failed:', e); }
  }

  // DO NOT dispatch 'shot:summary' here (centralized in checkShotConditions)
  return rec;
}



// helper already used elsewhere in shot_logger.js
function normHoop(hoop) {
  const w = Math.max(1, hoop.w ?? hoop.width ?? 0);
  const h = Math.max(1, hoop.h ?? hoop.height ?? 0);
  if (hoop.cx != null && hoop.cy != null) return { cx: hoop.cx, cy: hoop.cy, w, h };
  const isTL = hoop.anchor === 'topleft' || hoop.leftTop || hoop.isLeftTop || hoop.topLeft;
  if (isTL) return { cx: (hoop.x ?? 0) + w/2, cy: (hoop.y ?? 0) + h/2, w, h };
  return { cx: hoop.x ?? 0, cy: hoop.y ?? 0, w, h };
}



// ---------------------------------------------------------------- //
//                        Start Shot Magic!                         //
// ---------------------------------------------------------------- //

// ---------------- Weighted Scorer (clean, top-left convention) ----------------

// Tunables (kept modest; tweak as needed - goal to tie to Doach model for optimization)
const WEIGHTS = {
  hoop: 0.15,
  net: 0.20,
  tubeHit: 0.30,
  netMoved: 0.4,
  trailCenter: 0.25,
};

const TUNABLES = {
  TAIL: 28,
  ELLIPSE_X: 0.45,
  ELLIPSE_Y: 0.45,
  NET_PAD: 10,
  LINE_XTOL_MULT: 1.1,
  NETLINE_POS: 0.92,
  DEPTH_POS: 1.22,
  TUBE_WIDTH_RATIO: 0.55,
  TUBE_MIN_CONSEC: 3,
  TUBE_ALLOW_GAPS: 2,
  SMALL_UP_TOL: 1.5,
  TRAIL_RADIUS: 15,
  CENTER_LANE_MIN: 18,
};


// Accept TLWH, {x,y,w,h}, or {x1,y1,x2,y2,cx,cy}; add rimY fallback.
function normHoopFlexible(H) {
  if (!H) return null;
  const x1 = H.x1 != null ? H.x1 : (H.x != null ? H.x : (H.cx != null && H.w != null ? H.cx - H.w/2 : null));
  const y1 = H.y1 != null ? H.y1 : (H.y != null ? H.y : (H.cy != null && H.h != null ? H.cy - H.h/2 : null));
  const w  = H.w  != null ? H.w  : (H.x2 != null && x1 != null ? (H.x2 - x1) : null);
  const h  = H.h  != null ? H.h  : (H.y2 != null && y1 != null ? (H.y2 - y1) : null);
  if (x1 == null || y1 == null || w == null || h == null) return null;

  const x2 = x1 + w, y2 = y1 + h;
  const cx = H.cx != null ? H.cx : (x1 + w/2);
  const cy = H.cy != null ? H.cy : (y1 + h/2);

  // If we don’t have a precise rim line from detection, use a stable band near the top of the net.
  const rimY = (H.rimY != null) ? H.rimY : (y1 + h * 0.45);

  return { x1, y1, x2, y2, w, h, cx, cy, rimY };
}

function netBoxFromHoop(H) {
  const width  = Math.max(60, H.w * 1.25);
  const height = Math.max(40, H.h * 0.9);
  const nx1 = H.cx - width / 2;
  const ny1 = H.y1 + H.h * 0.55;
  return [nx1, ny1, nx1 + width, ny1 + height];
}

function firstRimCrossIndex(trail, H) {
  const xTol = Math.max(55, H.w * TUNABLES.LINE_XTOL_MULT);
  for (let i = 1; i < trail.length; i++) {
    const a = trail[i-1], b = trail[i];
    if (Math.abs(a.x - H.cx) > xTol && Math.abs(b.x - H.cx) > xTol) continue;
    if (a.y <= H.rimY && b.y > H.rimY && (b.y - a.y) > 0) return i;
  }
  return -1;
}

function getRecentNetRegionSafe(H) {
  const n = (typeof getRecentNetRegion === 'function') ? getRecentNetRegion() : null;
  if (Array.isArray(n) && n.length === 4) return n;
  return netBoxFromHoop(H);
}

function tubeRunAfterCross(trail, H) {
  const start = firstRimCrossIndex(trail, H);
  if (start < 0) return 0;
  const seg = trail.slice(start);
  const tubeHalf = Math.max(12, H.w * TUNABLES.TUBE_WIDTH_RATIO);
  const yDeep = H.y1 + H.h * TUNABLES.DEPTH_POS;
  let run = 0, gaps = 0, best = 0;
  for (let i = 1; i < seg.length; i++) {
    const p0 = seg[i-1], p1 = seg[i];
    const inside = Math.abs(p1.x - H.cx) <= tubeHalf && p1.y >= H.rimY && p1.y <= yDeep;
    const dy = p1.y - p0.y;
    const descendingOrFlat = dy > -TUNABLES.SMALL_UP_TOL;
    if (inside && descendingOrFlat) { run++; gaps = 0; }
    else if (run > 0 && gaps < TUNABLES.TUBE_ALLOW_GAPS) { gaps++; }
    else { best = Math.max(best, run); run = 0; gaps = 0; }
  }
  return Math.max(best, run);
}

function crossedNetLine(trail, H) {
  if (!trail || trail.length < 2) return false;
  const yLine = H.y1 + H.h * TUNABLES.NETLINE_POS;
  const xTol  = Math.max(55, H.w * TUNABLES.LINE_XTOL_MULT);
  for (let i = 1; i < trail.length; i++) {
    const a = trail[i-1], b = trail[i];
    if (Math.abs(a.x - H.cx) > xTol && Math.abs(b.x - H.cx) > xTol) continue;
    const dy = b.y - a.y;
    const crosses = (a.y <= yLine && b.y > yLine && dy > 0);
    if (!crosses) continue;
    const t   = (yLine - a.y) / dy;
    const xAt = a.x + (b.x - a.x) * t;
    if (Math.abs(xAt - H.cx) <= xTol) return true;
  }
  return false;
}

function thickTrailCenterHit(pts, H) {
  if (!pts?.length) return false;
  const r = TUNABLES.TRAIL_RADIUS;
  const x1 = H.x1 - r, y1 = H.y1 - r, x2 = H.x2 + r, y2 = H.y2 + r;
  const rectHit = pts.some(p => p.x >= x1 && p.x <= x2 && p.y >= y1 && p.y <= y2);

  // vertical stripe under rim: a little wider + deeper to tolerate occlusion
  const laneHalf = Math.max(TUNABLES.CENTER_LANE_MIN, H.w * 0.32, r); // was 0.28
  const yTop = H.rimY;
  const yBot = H.y1 + H.h * TUNABLES.DEPTH_POS;

  let stripeHit = false;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i-1], b = pts[i];
    const xOverlap = Math.max(a.x, b.x) >= (H.cx - laneHalf) && Math.min(a.x, b.x) <= (H.cx + laneHalf);
    const yOverlap = Math.max(a.y, b.y) >= yTop && Math.min(a.y, b.y) <= yBot;
    const descendingOrFlat = (b.y - a.y) > -TUNABLES.SMALL_UP_TOL;
    if (xOverlap && yOverlap && descendingOrFlat) { stripeHit = true; break; }
  }
  return rectHit || stripeHit;
}

// Simple densifier: fill tiny gaps so tube/cross checks survive short occlusion
function densifyTrail(trail) {
  if (!Array.isArray(trail) || trail.length < 2) return trail || [];
  const out = [trail[0]];
  for (let i = 1; i < trail.length; i++) {
    const a = trail[i-1], b = trail[i];
    const gap = Math.max(0, (b.frame ?? i) - (a.frame ?? (i-1)));
    if (gap > 1 && gap <= 4) {
      const steps = gap;
      for (let k=1; k<steps; k++) {
        const t = k/steps;
        out.push({ x: a.x + (b.x - a.x)*t, y: a.y + (b.y - a.y)*t, frame: (a.frame ?? 0)+k });
      }
    }
    out.push(b);
  }
  return out;
}

export function computeWeightedShotScore(trail) {
  const locked = getLockedHoopBox?.();
  const H = normHoopFlexible(locked);
  if (!H || !trail || trail.length < 2) return 0;

  const [nx1, ny1, nx2, ny2] = getRecentNetRegionSafe(H);

  // Use only the last N points, but densify to survive brief occlusion
  const tailRaw = trail.slice(-TUNABLES.TAIL);
  const tail    = densifyTrail(tailRaw);            // ← NEW

  // 0) apex must clear rim a little
  const apexY = Math.min(...tail.map(p => p.y));
  const apexAboveRim = apexY < (H.rimY - 6);        // ← NEW gating

  // 1) hoop ellipse proximity
  const rx = (H.w/2) * (1 + TUNABLES.ELLIPSE_X);
  const ry = (H.h/2) * (1 + TUNABLES.ELLIPSE_Y);
  const inHoop = tail.some(p => {
    const dx = (p.x - H.cx)/rx, dy = (p.y - H.cy)/ry;
    return dx*dx + dy*dy <= 1;
  });

  // 2) center tube run after rim cross
  const tubeRun = tubeRunAfterCross(tail, H);
  const tubeOK  = tubeRun >= Math.max(3, TUNABLES.TUBE_MIN_CONSEC); // ← stricter

  // 3) net line crossing near center
  const crossed = crossedNetLine(tail, H);

  // 4) net region presence
  const pad = TUNABLES.NET_PAD;
  const inNet = tail.some(p => p.x >= (nx1-pad) && p.x <= (nx2+pad) && p.y >= (ny1-pad) && p.y <= (ny2+pad));

  // 5) thick center stripe (make it a bit narrower again)
  const thickCenter = thickTrailCenterHit(tail, { H, w: H.w * 0.92 }); // ← slightly narrower

  // accumulate
  let s = 0;
  if (inHoop)             s += WEIGHTS.hoop;
  if (inNet)              s += WEIGHTS.net;
  if (tubeOK)             s += WEIGHTS.tubeHit;
  if (crossed)            s += 0.3;                  // .3 is good
  if (BS().netMoved)       s += WEIGHTS.netMoved;
  if (thickCenter)        s += WEIGHTS.trailCenter;

  const centerPass = tubeOK || thickCenter;
  const strongThrough = crossed && centerPass;

  // hard gates:
  if (!apexAboveRim)   s = Math.min(s, 0.55);        // low arc shouldn’t score high
  if (strongThrough)   s = Math.max(s, 0.80);        // strong signal → high floor
  if (!centerPass)     s = Math.min(s, 0.60);        // without tube/center, cap it
  if (!crossed)        s = Math.min(s, 0.60);        // must cross net line to exceed 0.6

  return s;
}

export function scoringTick(__frameIdx) {
  const hoopBox = getLockedHoopBox?.();
  if (!hoopBox) return;
  const s = BS();

  // fire release once when tracking begins
  if (s?.state === 'TRACKING' && s?.releaseFrame != null && !__releaseEventSent) {
    __releaseEventSent = true;
    try { window.dispatchEvent(new CustomEvent('shot:release', { detail: { frame: s.releaseFrame } })); } catch {}
  }

  // score newly frozen shot
  if (s?.state === 'FROZEN' && Array.isArray(s.shots) && s.shots.length > __lastScoredCount) {
    const last = s.shots.at(-1);
    if (last?.trail?.length >= 3) {
      try {
        const canvas = window.videoCanvas || window.__videoCanvas || null;
        if (canvas && typeof detectNetMotionFromCanvas === 'function') {
          s.netMoved = !!detectNetMotionFromCanvas(canvas, hoopBox);
        }
      } catch {}

      const sc = computeWeightedShotScore(last.trail);
      last.score = sc; last.made = sc >= (window.WEIGHTED_THRESH ?? 0.65); last.netMoved = !!s.netMoved;

      // logging happens at finalize time in checkShotConditions
      __lastScoredCount = s.shots.length;
    }
  }

  // re-arm release for next attempt when idle
  if (s?.state === 'IDLE' || s?.state === 'READY' || s?.state === 'WAITING') {
    __releaseEventSent = false;
  }
}

// ---------------------------------------------------------------- //
//                        End Shot Magic!                           //
// ---------------------------------------------------------------- //

// ===== UI Helpers =====
export function logShot(data) {
  const rec = { id: shotLog.length + 1, timestamp: Date.now(), ...(data || {}) };
  shotLog.push(rec);
  return rec;
}
export function resetShotLog() { shotLog.length = 0; }

export function drawShotStatsTable() {
  const tbody = document.querySelector("#shotTable tbody");
  if (!tbody || shotLog.length === 0) return;

  tbody.innerHTML = `
    <tr>
      <th>#</th>
      <th>Made</th>
      <th>Arc</th>
      <th>Entry</th>
      <th>Release</th>
      <th>Reason</th>
      <th>Coach</th>
    </tr>`;

  shotLog.forEach((shot, i) => {
    const row = document.createElement('tr');
    const esc = s => String(s||'').replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
    row.innerHTML = `
      <td>${i + 1}</td>
      <td>${shot.made ? '✅' : '❌'}</td>
      <td>${shot.arcHeight}px</td>
      <td>${shot.entryAngle}°</td>
      <td>${shot.releaseAngle}°</td>
      <td>${shot.made ? '' : (shot.missReason ?? '-')}</td>
      <td class="coach" title="${esc(shot.doach)}">${esc(shot.doach)}</td>`;
    tbody.appendChild(row);
  });

  const last = shotLog.at(-1);
  const madeCount = shotLog.filter(s => s.made).length;
  const accuracy = Math.round((madeCount / shotLog.length) * 100);

  document.getElementById('shotDetails').innerHTML = `
    Arc Height: ${last.arcHeight}px<br>
    Entry Angle: ${last.entryAngle}°<br>
    Release Angle: ${last.releaseAngle}°<br>
    Total Shots: ${shotLog.length}<br>
    Accuracy: ${accuracy}%<br>
    ${last.made ? '' : `<span style="color:orange;">Reason: ${last.missReason}</span>`}
  `;
}


// Update lower HUD with real-time shot counts + append summary to shot table
export function updateBottomStats() {
  // Guard: if shotLog isn't defined yet, do nothing
  if (typeof shotLog === 'undefined' || !Array.isArray(shotLog)) return;

  const total = shotLog.length;
  const madeCount = shotLog.reduce((n, s) => n + (s?.made ? 1 : 0), 0);
  const accuracy = total > 0 ? Math.round((madeCount / total) * 100) : 0;

  const shotsEl = document.getElementById('shotsTaken');
  const makesEl = document.getElementById('makes');
  const accEl   = document.getElementById('accuracy');

  if (shotsEl) shotsEl.textContent = String(total);
  if (makesEl) makesEl.textContent = String(madeCount);
  if (accEl)   accEl.textContent   = `${accuracy}%`;

  // 📌 Append latest shot summary to the bottom of the shot table
  const tbody = document.querySelector("#shotTable tbody");
  const lastShot = shotLog.at(-1);

  if (tbody && lastShot) {
    const summaryRow = document.createElement('tr');
    summaryRow.style.background = '#222'; // darker background for summary
    summaryRow.innerHTML = `
      <td colspan="6" style="text-align:center; font-weight:bold; color:${lastShot.made ? 'lime' : 'red'}">
        ${lastShot.made ? '✅ Made' : '❌ Miss'} — Current Accuracy: ${accuracy}%
      </td>
    `;
    tbody.appendChild(summaryRow);
  }
}

window.updateBottomStats = updateBottomStats;
window.drawShotStatsTable = drawShotStatsTable;

// ===== Supporting Functions =====

window.drawNetMotionStatus = drawNetMotionStatus;

// Buffers used objects seen during trail window
const objectWindow = {
  netBoxes: [],
  hoopBoxes: [],
  frameLimit: 10
};

// Visual debug: hoop proximity zone (uses the same constants as logic)
export function drawHoopProximityDebug(ctx) {
  try {
    const hoop = getLockedHoopBox();
    if (!ctx || !hoop) return;

    const H = normHoop(hoop);

    // Same sizing as your original (constant margins), but center-safe
    const P = currentProx();
    const x = H.cx - P.X;
    const y = H.cy - P.Y_ABOVE;
    const width  = P.X * 2;
    const height = P.Y_ABOVE + P.Y_BELOW;

    ctx.save();
    const prevDash = ctx.getLineDash ? ctx.getLineDash() : [];
    ctx.strokeStyle = 'rgba(0,255,255,0.7)';
    ctx.lineWidth = 5;
    if (ctx.setLineDash) ctx.setLineDash([6, 4]);
    ctx.strokeRect(x, y, width, height);
    if (ctx.setLineDash) ctx.setLineDash(prevDash);

    // label
    ctx.fillStyle = 'cyan';
    ctx.font = 'bold 14px sans-serif';
    ctx.fillText('🎯 Hoop Proximity Zone', x + 5, y - 8);

    // tiny center marker (helps sanity-check coords)
    ctx.beginPath();
    ctx.arc(H.cx, H.cy, 3, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  } catch (e) {
    console.warn('drawHoopProximityDebug failed:', e);
  }
}


const NET_BOX_HEIGHT = 35;
const NET_BOX_WIDTH = 60;
const TUBE_WIDTH = 20;
const TUBE_HEIGHT = 100;

//set area in net for ball travel verification
export function drawShotTubeDebug(ctx) {
  const hoop = getLockedHoopBox();
  if (!hoop || !ctx) return;

  const x = hoop.x - TUBE_WIDTH / 2;
  const y = hoop.y;

  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,0,0.6)';
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 4]);
  ctx.strokeRect(x, y, TUBE_WIDTH, TUBE_HEIGHT);
  ctx.fillStyle = 'yellow';
  ctx.font = '12px sans-serif';
  ctx.fillText('📏 Shot Tube', x + 4, y - 6);
  ctx.restore();
}

export const shotState = { inProgress: false, entryFrame: -1 };

// upon video load buffer detected net/hoop objects analysis
export function bufferDetectedObjects(objects) {
  const nets = objects.filter(o => o.label === 'net' && o.box?.length === 4);
  const hoops = objects.filter(o => o.label === 'hoop' && o.box?.length === 4);

  objectWindow.netBoxes.push(...nets);
  objectWindow.hoopBoxes.push(...hoops);

  if (objectWindow.netBoxes.length > objectWindow.frameLimit)
    objectWindow.netBoxes = objectWindow.netBoxes.slice(-objectWindow.frameLimit);

  if (objectWindow.hoopBoxes.length > objectWindow.frameLimit)
    objectWindow.hoopBoxes = objectWindow.hoopBoxes.slice(-objectWindow.frameLimit);
}

let lastNetPatch = null;
let netPrimed = false;
export function isNetPrimed() { return netPrimed; }

// did the net move?
export function detectNetMotion(canvas, hoopBox) {
  if (!canvas || !hoopBox) return false;
  const ctx = canvas.getContext('2d');

  // clamp region to canvas, use integers
  let x = Math.floor(hoopBox.x);
  let y = Math.floor(hoopBox.y + hoopBox.h);
  let w = Math.floor(hoopBox.w);
  let h = Math.floor(hoopBox.h * 0.6);

  // clamp to bounds
  x = Math.max(0, Math.min(x, canvas.width  - 1));
  y = Math.max(0, Math.min(y, canvas.height - 1));
  w = Math.max(1, Math.min(w, canvas.width  - x));
  h = Math.max(1, Math.min(h, canvas.height - y));

  // if region is tiny, reset baseline and bail
  if (w < 2 || h < 2) { lastNetPatch = null; return false; }

  let imageData;
  try {
    imageData = ctx.getImageData(x, y, w, h);
  } catch (e) {
    // getImageData will throw if the box is out of bounds
    lastNetPatch = null;
    return false;
  }

  const cur = imageData.data; // Uint8ClampedArray length = w*h*4

  // (re)initialize baseline whenever size changes
  if (!lastNetPatch || lastNetPatch.length !== cur.length) {
    lastNetPatch = new Uint8ClampedArray(cur);
    return false; // don't report motion on the first sample
  }

  // diff
  let changed = 0;
  for (let i = 0; i < cur.length; i += 4) {
    const diff = Math.abs(cur[i] - lastNetPatch[i]) +
                 Math.abs(cur[i+1] - lastNetPatch[i+1]) +
                 Math.abs(cur[i+2] - lastNetPatch[i+2]);
    if (diff > 30) changed++;
  }

  // update baseline AFTER diff
  lastNetPatch.set(cur);

  const percentMoved = changed / (cur.length / 4);
  return percentMoved > 0.08;
}

// 🧪 Draw netMoved debug overlay during scoring check
export function drawNetMotionStatus(canvas, netMoved) {
  const ctx = canvas?.getContext('2d');
  if (!ctx) return;
  ctx.save();
  ctx.font = 'bold 16px sans-serif';
  ctx.fillStyle = netMoved ? 'lime' : 'gray';
  ctx.fillText(netMoved ? '✅ Net Moved' : '🕸️ No Net Motion', 20, 60);
  ctx.restore();
}

window.drawNetMotionStatus = drawNetMotionStatus;

// 🔁 Reset button
export function resetShotStats() {
  resetShotLog();

  const tbody = document.querySelector("#shotTable tbody");
  if (tbody) tbody.innerHTML = "";

  const details = document.getElementById("shotDetails");
  if (details) details.innerHTML = "No shot data loaded.";

  if (window.madeShotSound) window.madeShotSound.pause();
  if (window.missedShotSound) window.missedShotSound.pause();
}

// prevent duplicate shots in the same trail window
// add to shot logging trigger
let lastLoggedFrame = -1;
let shotGapThreshold = 15; // frames between shots (adjust as needed)

export function shouldLogNewShot(currentFrame, trail) {
  if (lastLoggedFrame === -1 || currentFrame - lastLoggedFrame >= shotGapThreshold) {
    lastLoggedFrame = currentFrame;
    return true;
  }
  console.warn(`⏹ Duplicate shot blocked — currentFrame=${currentFrame}, lastLogged=${lastLoggedFrame}`);
  return false;
}

export function trailHash(trail) {
  if (!trail || trail.length < 2) return '';
  const head = trail.at(0);
  const tail = trail.at(-1);
  return `${Math.round(head.x)},${Math.round(head.y)}-${Math.round(tail.x)},${Math.round(tail.y)}`;
}

// prevent duplicate shot logging
let lastTrailHash = null;  
const SHOT_GAP_MS = 1500;  //1.5 sec 
const SHOT_GAP_FRAMES = 10;  // and-or 10 frames
let lastShotEndTime = 0;

export function shouldLogShot(trail, __frameIdx) {
  const hash = trailHash(trail);
  const now = Date.now();
  const isNew = __frameIdx - lastLoggedFrame > SHOT_GAP_FRAMES && now - lastShotEndTime > SHOT_GAP_MS;

  if (!isNew || hash === lastTrailHash) {
    console.warn(`⏹ Duplicate shot blocked — frame=${__frameIdx}, hash=${hash}`);
    return false;
  }
  lastLoggedFrame = __frameIdx;
  lastShotEndTime = now;
  lastTrailHash = hash;
  return true;
}

export function getRecentNetRegion() {
  const latest = objectWindow?.netBoxes?.at?.(-1);
  return latest?.box || null;
}

export function getRecentHoopRegion() {
  const latest = objectWindow?.hoopBoxes?.at?.(-1);
  return latest?.box || null;
}
function isPointInTube(p, hoop) {
  const x1 = hoop.x - TUBE_WIDTH / 3;
  const x2 = hoop.x + TUBE_WIDTH / 3;
  const y1 = hoop.y;
  const y2 = hoop.y + TUBE_HEIGHT;
  return p.x >= x1 && p.x <= x2 && p.y >= y1 && p.y <= y2;
}

function countTubeHits(trail, hoop) {
  return trail.filter(p => isPointInTube(p, hoop)).length;
}
