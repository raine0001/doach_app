// shot_arc.js — Canonical release/exit timing from pose + ball + hoop
// Focus: define robust shot release and exit points with small delays to improve trail quality.

import { stepFBFArc, fillArcGaps } from '/static/js/ball_tracker.js';

// Tunables (overridable via window.*)
const CFG = {
  REL_POSE_STREAK:      () => Number(window.REL_POSE_STREAK ?? 2),
  REL_HAND_DIST_PX:     () => Number(window.REL_HAND_DIST_PX ?? 70),
  REL_UPWARD_MIN_FRAMES:() => Number(window.REL_UPWARD_MIN_FRAMES ?? 1),
  RELEASE_DELAY_FRAMES: () => Number(window.RELEASE_DELAY_FRAMES ?? 1),

  PROX_X:               () => Number(window.proxX       ?? 200),
  PROX_Y_ABOVE:         () => Number(window.proxYAbove  ?? 170),
  PROX_Y_BELOW:         () => Number(window.proxYBelow  ?? 100),

  EXIT_LINGER_FRAMES:   () => Number(window.EXIT_LINGER_FRAMES ?? 8),
  EXIT_BELOW_MARGIN:    () => Number(window.EXIT_BELOW_MARGIN  ?? 12),
};


// --- Post-release filters ---
const POST = {
  MAX_DEV_PX:     () => Number(window.BALL_MAX_DEV_PX ?? 70),   // max distance from predicted
  MAX_TURN_DEG:   () => Number(window.BALL_MAX_TURN_DEG ?? 60), // max heading change
};

const _flt = { last2: [] }; // keep last two accepted post-release points

function headingDeg(a,b){
  if (!a || !b) return null;
  return Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
}
function angleDiffDeg(a,b){
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 180;
  let d = Math.abs(a - b) % 360;
  if (d > 180) d = 360 - d;
  return d;
}
function predictNext(p1, p2){
  if (!p1 || !p2) return null;
  return { x: p2.x + (p2.x - p1.x), y: p2.y + (p2.y - p1.y) };
}
function filterPostReleaseBall(pt){
  if (window.isBallExcluded && window.isBallExcluded(ballPt.x, ballPt.y)) return false;

  try {
    const last = _flt.last2.at(-1);
    const prev = _flt.last2.at(-2);
    if (!last || !prev) { _flt.last2.push(pt); return pt; }

    // heading gate
    const hPrev = headingDeg(prev, last);
    const hNew  = headingDeg(last, pt);
    if (angleDiffDeg(hPrev, hNew) > POST.MAX_TURN_DEG()) return null;

    // distance-from-prediction gate
    const pred = predictNext(prev, last);
    const dev = Math.hypot(pt.x - pred.x, pt.y - pred.y);
    if (dev > POST.MAX_DEV_PX()) return null;

    _flt.last2.push(pt);
    if (_flt.last2.length > 2) _flt.last2.shift();
    return pt;
  } catch { return pt; }
}

// --- Pre-release filters ---

const PRE = {
   MIN_CONF: () => Number(window.BALL_MIN_CONF_PRE ?? 0.38),
   MAX_STEP: () => Number(window.BALL_MAX_STEP_PRE ?? 65),
   REQUIRE_UPTREND: () => Number(window.PRE_MIN_UPTREND ?? 2) // frames of y decreasing
 };

const _state = {
  // Release guards
  relPoseStreak: 0,
  relDelay: 0,
  relLatched: false,
  lastWristYs: [],   // ring buffer of recent wrist y

  // Proximity tracking
  inProxPrev: false,
  postExitFrames: 0,
  preArc: [],            // pre-release buffer [{x,y,frame}]
  preArcLast: null,      // last accepted pre point
  preArcUpStreak: 0,     // monotonic up streak
  preFlushed: false
};

function resetShotFSM() {
  _flt.last2.length = 0;
  _state.relPoseStreak = 0;
  _state.relDelay      = 0;
  _state.relLatched    = false;
  _state.lastWristYs.length = 0;
  _state.inProxPrev    = false;
  _state.postExitFrames= 0;
  _state.preArc.length = 0;
  _state.preArcLast = null;
  _state.preArcUpStreak = 0;
  _state.preFlushed = false;
}

// Basic pre-release filter to kill false balls
 function acceptPreBall(ballPt, H){
 if (window.isOrangeish && !window.isOrangeish(ballPt.x, ballPt.y)) return false;
 if (window.isBallExcluded && window.isBallExcluded(ballPt.x, ballPt.y)) return false;

   if (!ballPt || !Number.isFinite(ballPt.x) || !Number.isFinite(ballPt.y)) return false;
   // confidence gate if provided
   const lbl = String(ballPt.label || '');
   if (lbl && lbl.toLowerCase() !== 'basketball') return false;
   const c = Number(ballPt.confidence ?? ballPt.score ?? -1);
   if (Number.isFinite(c) && c < PRE.MIN_CONF()) return false;
   // monotonic upward (y decreasing) streak
   if (_state.preArcLast) {
     if (ballPt.y < _state.preArcLast.y - 0.8) _state.preArcUpStreak++; else _state.preArcUpStreak = 0;
    if (_state.preArcUpStreak < PRE.REQUIRE_UPTREND()) return false;
     const step = Math.hypot(ballPt.x - _state.preArcLast.x, ballPt.y - _state.preArcLast.y);
    if (step > PRE.MAX_STEP()) return false;
    // new: heading consistency while buffering
    try {
      const p2 = _state.preArcLast, p1 = _state.preArc.at?.(-2);
      if (p1) {
        const hPrev = headingDeg(p1, p2);
        const hNew  = headingDeg(p2, ballPt);
        if (angleDiffDeg(hPrev, hNew) > 70) return false;
      }
    } catch {}
   }
   // corridor: don’t accept points behind the hoop or far outside lane
   if (H) {
     const laneX = Math.abs(ballPt.x - H.cx) <= Math.max(110, H.w * 1.1); // looser
     const above = ballPt.y <= (H.rimTop + Math.max(28, H.h * 0.45));     // taller band
     if (!(laneX || above)) return false;
   }
   return true;
 }

 function collectPreArc(frame, ballPt, hoopBox){
   const H = normHoop(hoopBox);
   if (!acceptPreBall(ballPt, H)) return;
   _state.preArc.push({ x: ballPt.x, y: ballPt.y, frame });
   _state.preArcLast = { x: ballPt.x, y: ballPt.y };
   if (_state.preArc.length > 30) _state.preArc.splice(0, _state.preArc.length - 30);
 }

 function flushPreArc(hoopBox){
   if (_state.preFlushed || !_state.preArc.length) return;
   const H = normHoop(hoopBox), prox = proxFromHoop(H);
   for (const p of _state.preArc) { try { stepFBFArc?.(p, prox, p.frame); } catch {} }
   _state.preFlushed = true;
 }

// quick HSV-ish gate: keep orange-ish blobs
window.isOrangeish = (x,y)=> {
  const v = document.getElementById('videoPlayer');
  if (!v) return true;
  const c = (window.__ballTap ||= (()=>{const t=document.createElement('canvas'); t.width=t.height=16; return t;})());
  const ct = c.getContext('2d', { willReadFrequently: true });
  ct.drawImage(v, x-4, y-4, 8, 8, 0, 0, 8, 8);
  const d = ct.getImageData(0,0,8,8).data;
  let r=0,g=0,b=0,n=0;
  for (let i=0;i<d.length;i+=4){ r+=d[i]; g+=d[i+1]; b+=d[i+2]; n++; }
  r/=n; g/=n; b/=n;
  // crude orange: R high, G mid, B low
  return (r>120 && g>70 && b<90 && r>g+20 && r>b+40);
};



// Normalize a hoop box to center-based with rim top
function normHoop(hoop) {
  if (!hoop) return null;
  const w = Math.max(1, hoop.w ?? hoop.width ?? ((hoop.x2 ?? 0)-(hoop.x1 ?? 0)));
  const h = Math.max(1, hoop.h ?? hoop.height ?? ((hoop.y2 ?? 0)-(hoop.y1 ?? 0)));
  let cx, cy;
  if (Number.isFinite(hoop.cx) && Number.isFinite(hoop.cy)) {
    cx = hoop.cx; cy = hoop.cy;
  } else if ((hoop.anchor === 'topleft' || hoop.topLeft || hoop.leftTop || hoop.isLeftTop) &&
             Number.isFinite(hoop.x) && Number.isFinite(hoop.y)) {
    cx = hoop.x + w/2; cy = hoop.y + h/2;
  } else if (Number.isFinite(hoop.x1) && Number.isFinite(hoop.y1) &&
             Number.isFinite(hoop.x2) && Number.isFinite(hoop.y2)) {
    cx = hoop.x1 + w/2; cy = hoop.y1 + h/2;
  } else if (Number.isFinite(hoop.x) && Number.isFinite(hoop.y)) {
    cx = hoop.x; cy = hoop.y;
  } else {
    return null;
  }
  return { cx, cy, w, h, rimTop: cy - h/2 };
}

function proxFromHoop(H) {
  if (!H) return null;
  const x = H.cx - CFG.PROX_X();
  const y = H.rimTop - CFG.PROX_Y_ABOVE();
  const w = CFG.PROX_X() * 2;
  const h = CFG.PROX_Y_ABOVE() + CFG.PROX_Y_BELOW();
  return { x, y, w, h };
}

function wristPoint(pose) {
  try { return pose?.keypoints?.[16] || null; } catch { return null; }
}
function shoulderPoint(pose) {
  try { return pose?.keypoints?.[12] || null; } catch { return null; }
}

function ballNearHand(pose, ballPt) {
  if (!pose || !ballPt) return false;
  const wr = wristPoint(pose);
  if (!wr || !Number.isFinite(wr.x) || !Number.isFinite(wr.y)) return false;
  const d = Math.hypot((ballPt.x ?? Infinity) - wr.x, (ballPt.y ?? Infinity) - wr.y);
  return d <= CFG.REL_HAND_DIST_PX();
}

function wristTrendingUp(pose) {
  const wr = wristPoint(pose);
  if (!wr || !Number.isFinite(wr.y)) return false;
  const buf = _state.lastWristYs;
  buf.push(wr.y);
  if (buf.length > 4) buf.splice(0, buf.length - 4);
  const n = buf.length;
  if (n < 3) return false;
  let up = 0;
  for (let i = 1; i < n; i++) if (buf[i] < buf[i-1] - 0.8) up++;
  return up >= CFG.REL_UPWARD_MIN_FRAMES();
}

function insideProx(pt, prox) {
  return pt && prox && pt.x >= prox.x && pt.x <= prox.x + prox.w && pt.y >= prox.y && pt.y <= prox.y + prox.h;
}

// ---- Release timing ------------------------------------------------------
function updateRelease(frame, pose, ballPt, hoopBox) {
  const H = normHoop(hoopBox);
  const bs = (window.ballState ||= {});
  if (bs.releaseFrame != null) { _state.relLatched = true; return false; }

  const poseOK = (typeof window.isPoseInReleasePosition === 'function')
    ? !!window.isPoseInReleasePosition({ keypoints: pose?.keypoints || pose || (window.playerState?.keypoints) })
    : false;
  const likely = (() => {
    try {
      const hist = (window.playerState?.frameHistory || []).slice(-3);
      return !!window.isPoseReleaseLikely?.(hist);
    } catch { return false; }
  })();
  if (poseOK) _state.relPoseStreak++; else _state.relPoseStreak = 0;

  const upward = wristTrendingUp({ keypoints: pose?.keypoints || (window.playerState?.keypoints) });
  const nearH  = ballNearHand({ keypoints: pose?.keypoints || (window.playerState?.keypoints) }, ballPt);
  const inLane = (() => {
    try {
      if (!H || !ballPt) return false;
      const laneX = Math.abs(ballPt.x - H.cx) <= Math.max(75, H.w * 0.8);
      const above = ballPt.y <= (H.rimTop + Math.max(18, H.h * 0.3));
      return laneX && above;
    } catch { return false; }
  })();

  const gate = (_state.relPoseStreak >= CFG.REL_POSE_STREAK() && upward && nearH && inLane) || likely;
  if (gate) {
    if (window.DOACH_SHOT_DEBUG) {
      console.log('[shot_arc] gate OK', {
        frame, streak: _state.relPoseStreak, upward, nearH, inLane,
        delay: _state.relDelay, wantDelay: CFG.RELEASE_DELAY_FRAMES()
      });
    }
    _state.relDelay++;
    if (_state.relDelay >= CFG.RELEASE_DELAY_FRAMES()) {
      // Canonical latch via central helper
      try { if (typeof window.safeEmitRelease === 'function') window.safeEmitRelease(frame, 'shot_arc'); } catch {}
      if (window.DOACH_SHOT_DEBUG) {
        console.log('[shot_arc] RELEASE LATCHED', { frame, via: 'shot_arc' });
      }
      _state.relLatched = true;
      return true;
    }
  } else {
    _state.relDelay = 0;
    // Fallback: latch on proximity enter when pose is unavailable/weak
    try {
      const prox = proxFromHoop(H);
      const inProx = insideProx(ballPt, prox);
      const enter = (window.ballState?.proxEnterFrame ?? null);
      if (!poseOK && inProx && Number.isFinite(enter) && (frame - enter) <= 2) {
        try { if (typeof window.safeEmitRelease === 'function') window.safeEmitRelease(frame, 'prox-fallback'); } catch {}
        if (window.DOACH_SHOT_DEBUG) console.log('[shot_arc] RELEASE LATCHED (prox-fallback)', { frame });
        _state.relLatched = true;
        return true;
      }
    } catch {}

    // Fallback 2: slope-based latch � if ball has been trending upward for the last ~3
    // frames inside the lane near rim height, assume release even without pose.
    try {
      const t = Array.isArray(window.ballState?.trail) ? window.ballState.trail : [];
      if (t.length >= 3 && H) {
        const a = t[t.length - 3], b = t[t.length - 2], c = t[t.length - 1];
        const up = (c.y < b.y - 1.5) && (b.y < a.y - 1.5);
        const laneX = Math.abs(c.x - H.cx) <= Math.max(45, H.w * 0.5);
        const nearRimBand = c.y <= (H.rimTop + Math.max(36, H.h * 0.6));
        if (!poseOK && up && laneX && nearRimBand) {
          try { if (typeof window.safeEmitRelease === 'function') window.safeEmitRelease(frame, 'slope-fallback'); } catch {}
          if (window.DOACH_SHOT_DEBUG) console.log('[shot_arc] RELEASE LATCHED (slope-fallback)', { frame });
          _state.relLatched = true;
          return true;
        }
      }
    } catch {}
  }
  return false;
}

// ---- Exit timing ---------------------------------------------------------
function updateExit(frame, ballPt, hoopBox) {
  const bs = (window.ballState ||= {});
  const H  = normHoop(hoopBox);
  const prox = proxFromHoop(H);
  if (!H || !prox || !ballPt) return { exited:false, below:false, linger:0 };

  const inProx = insideProx(ballPt, prox);

  // stamp enter the first time we see inside
  if (inProx && !bs._lastInProx) {
    if (bs.proxEnterFrame == null) bs.proxEnterFrame = frame;
  }

  // leaving prox
  if (bs._lastInProx && !inProx) {
    if (bs.proxExitFrame == null) bs.proxExitFrame = frame;
    _state.postExitFrames = 0;
  }

  bs._lastInProx = inProx;

  let below = false;
  if (!inProx && Number.isFinite(bs.proxExitFrame)) {
    _state.postExitFrames++;
    const rimBottom = H.rimTop + H.h;
    below = ballPt.y > (rimBottom + CFG.EXIT_BELOW_MARGIN());
  } else {
    _state.postExitFrames = 0;
  }

  // Keep a mirror counter on ballState for other modules
  bs._postExitFrames = _state.postExitFrames;

  return {
    exited: !inProx && Number.isFinite(bs.proxExitFrame),
    below,
    linger: _state.postExitFrames,
  };
}

// Convenience: single tick updater to call from analyzer
function updateShotArcTick({ frame, pose = null, ballPt = null, hoopBox = null } = {}) {
  // Stamp prox first
   const ex  = updateExit(frame, ballPt, hoopBox);
   const rel = updateRelease(frame, pose, ballPt, hoopBox);
  try {
    const bs = (window.ballState ||= {});
    if (!Number.isFinite(bs.releaseFrame)) {
      // collect pre-release points with strict filter
      if (ballPt) collectPreArc(frame, ballPt, hoopBox);
    } else {
      // on/after latch, ensure buffered points are committed once
      flushPreArc(hoopBox);
    }
  } catch {}
   return { released: rel, ...ex };
}

// ---- Arc stepping (centralized) -------------------------------------------
function updateArc(frame, ballPt, hoopBox) {
  const H = normHoop(hoopBox);
  const prox = proxFromHoop(H);
  if (!ballPt || !prox) return false;

  // After latch, also ensure buffered trail is merged
  try {
    const bs = (window.ballState ||= {});
    if (!Number.isFinite(bs.releaseFrame)) return false;
    flushPreArc(hoopBox);
  } catch {}

  // sanity-check motion to kill wild points
  const clean = filterPostReleaseBall(ballPt);
  if (!clean) return false;

  
  const lastArc = window.ballArc?.trail?.at?.(-1) || null;
  if (!lastArc || lastArc.frame !== frame) {
    try { stepFBFArc?.(clean, prox, frame); } catch {}
  }
  try { fillArcGaps?.(); } catch {}
  
  return true;
}

function refineBallTrajectory() {
  const arc = window.ballArc;
  if (!arc || !Array.isArray(arc.trail)) return;
  arc.refinedTrail = arc.trail.map((p) => (p && typeof p === 'object') ? { ...p } : p);
  arc.refinedTrailSource = 'raw';
  arc.refinedMetrics = { ok: true, count: arc.refinedTrail.length };
  arc.releasePoint = null;
  arc.apexPoint = null;
  arc.rimCrossingPoint = null;
  delete arc.refinedKeyTrail;
}

// (Historical helper APIs removed to keep arc drawing tied to raw detections)

// ---- TESTING: Simple test function ----
function testTrajectoryRefinement() {
  console.log('[TEST] Testing trajectory refinement...');
  
  // Create mock raw trail data (simulating noisy ball positions)
  const mockRawTrail = [
    { x: 100, y: 200, frame: 0 },
    { x: 105, y: 195, frame: 1 },
    { x: 110, y: 190, frame: 2 },
    { x: 115, y: 185, frame: 3 },
    { x: 120, y: 180, frame: 4 },
    { x: 125, y: 175, frame: 5 },
    { x: 130, y: 170, frame: 6 },
    { x: 135, y: 165, frame: 7 },
    { x: 140, y: 160, frame: 8 },
    { x: 145, y: 155, frame: 9 },
    { x: 150, y: 150, frame: 10 }, // apex
    { x: 155, y: 155, frame: 11 },
    { x: 160, y: 160, frame: 12 },
    { x: 165, y: 165, frame: 13 },
    { x: 170, y: 170, frame: 14 },
    { x: 175, y: 175, frame: 15 },
    { x: 180, y: 180, frame: 16 },
    { x: 185, y: 185, frame: 17 },
    { x: 190, y: 190, frame: 18 },
    { x: 195, y: 195, frame: 19 },
    { x: 200, y: 200, frame: 20 }
  ];
  
  // Set up mock ballArc
  window.ballArc = { trail: mockRawTrail };
  
  // Test refinement
  refineBallTrajectory();
  
  // Check results
  const arc = window.ballArc;
  console.log('[TEST] Results:', {
    originalPoints: arc.trail.length,
    refinedPoints: arc.refinedTrail?.length || 0,
    releasePoint: arc.releasePoint,
    apexPoint: arc.apexPoint,
    rimCrossingPoint: arc.rimCrossingPoint
  });
  
  return arc;
}




// Attach helpers for optional non-ESM callers (safe no-ops if not used)
try {
  const api = {
    resetShotFSM, updateRelease, updateExit, updateShotArcTick, updateArc, proxFromHoop,
    refineBallTrajectory, testTrajectoryRefinement
  };
  const target = (window.shotArc && typeof window.shotArc === 'object') ? window.shotArc : {};
  Object.assign(target, api);
  window.shotArc = target;
  window.shotArcModule = api;
  if (!window.__shotArcLoadedOnce) {
    window.__shotArcLoadedOnce = true;
    try { console.log('[shot_arc] loaded'); } catch {}
  }
} catch {}


