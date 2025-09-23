// shot_arc.js — Canonical release/exit timing from pose + ball + hoop
// Focus: define robust shot release and exit points with small delays to improve trail quality.

import { stepFBFArc, fillArcGaps } from './ball_tracker.js';

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

const _state = {
  // Release guards
  relPoseStreak: 0,
  relDelay: 0,
  relLatched: false,
  lastWristYs: [],   // ring buffer of recent wrist y

  // Proximity tracking
  inProxPrev: false,
  postExitFrames: 0,
};

function resetShotFSM() {
  _state.relPoseStreak = 0;
  _state.relDelay      = 0;
  _state.relLatched    = false;
  _state.lastWristYs.length = 0;
  _state.inProxPrev    = false;
  _state.postExitFrames= 0;
}

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
  // Ensure proximity/enter stamping occurs before release uses it
  const ex  = updateExit(frame, ballPt, hoopBox);
  const rel = updateRelease(frame, pose, ballPt, hoopBox);
  return { released: rel, ...ex };
}

// ---- Arc stepping (centralized) -------------------------------------------
function updateArc(frame, ballPt, hoopBox) {
  const H = normHoop(hoopBox);
  const prox = proxFromHoop(H);
  if (!ballPt || !prox) return false;
  // Only collect arc after release to avoid pre-shot noise drawing across the court
  try { const bs = (window.ballState ||= {}); if (!Number.isFinite(bs.releaseFrame)) return false; } catch {}
  const lastArc = window.ballArc?.trail?.at?.(-1) || null;
  if (!lastArc || lastArc.frame !== frame) {
    try { stepFBFArc?.(ballPt, prox, frame); } catch {}
  }
  try { fillArcGaps?.(); } catch {}
  
  // NEW: Refine trajectory after collecting points
  try { refineBallTrajectory(); } catch {}
  
  return true;
}

// ---- NEW: Ball trajectory refinement functions ----
function refineBallTrajectory() {
  const arc = window.ballArc;
  if (!arc || !Array.isArray(arc.trail) || arc.trail.length < 3) return;
  
  // Apply smoothing and generate clean arc
  const smoothedTrail = smoothTrajectory(arc.trail);
  const cleanArc = generateCleanArc(smoothedTrail);
  
  // Store refined arc
  arc.refinedTrail = cleanArc.trail;
  arc.releasePoint = cleanArc.releasePoint;
  arc.apexPoint = cleanArc.apexPoint;
  arc.rimCrossingPoint = cleanArc.rimCrossingPoint;

  try {
    const refined = Array.isArray(cleanArc.trail) ? cleanArc.trail : [];
    const rawTrail = Array.isArray(arc.trail) ? arc.trail : [];
    const frames = refined
      .map((p) => Number(p?.frame))
      .filter((f) => Number.isFinite(f));
    const minFrame = frames.length ? Math.min(...frames) : null;
    const maxFrame = frames.length ? Math.max(...frames) : null;
    const span = frames.length && Number.isFinite(minFrame) && Number.isFinite(maxFrame)
      ? Math.max(1, (maxFrame - minFrame + 1))
      : 0;
    const continuity = span > 0 ? (new Set(frames)).size / span : 0;
    const pairs = Math.min(rawTrail.length, refined.length);
    let sumSq = 0;
    let count = 0;
    for (let i = 0; i < pairs; i++) {
      const a = rawTrail[i];
      const b = refined[i];
      const ax = Number(a?.x);
      const ay = Number(a?.y);
      const bx = Number(b?.x);
      const by = Number(b?.y);
      if ([ax, ay, bx, by].every(Number.isFinite)) {
        const dx = ax - bx;
        const dy = ay - by;
        sumSq += dx * dx + dy * dy;
        count++;
      }
    }
    const rms = count > 0 ? Math.sqrt(sumSq / count) : 0;
    const peakY = refined.reduce((min, p) => {
      const y = Number(p?.y);
      return Number.isFinite(y) ? Math.min(min, y) : min;
    }, Number.POSITIVE_INFINITY);
    const packet = {
      points: refined.length,
      continuity: Number(continuity.toFixed(3)),
      rms: Number(rms.toFixed(3)),
      peakY: Number.isFinite(peakY) ? peakY : null,
      tStart: Number.isFinite(minFrame) ? minFrame : null,
      tEnd: Number.isFinite(maxFrame) ? maxFrame : null
    };
    window.dispatchEvent(new CustomEvent('arc:fit', { detail: packet }));
  } catch {}

  if (window.DOACH_SHOT_DEBUG) {
    console.log('[trajectory] refined', {
      originalPoints: arc.trail.length,
      refinedPoints: cleanArc.trail.length,
      release: cleanArc.releasePoint,
      apex: cleanArc.apexPoint
    });
  }
}


function smoothTrajectory(rawTrail) {
  if (!Array.isArray(rawTrail) || rawTrail.length < 3) return rawTrail;
  
  // Simple moving average smoothing
  const smoothed = [];
  const windowSize = Math.min(3, Math.floor(rawTrail.length / 3));
  
  for (let i = 0; i < rawTrail.length; i++) {
    const start = Math.max(0, i - windowSize);
    const end = Math.min(rawTrail.length - 1, i + windowSize);
    
    let sumX = 0, sumY = 0, count = 0;
    for (let j = start; j <= end; j++) {
      sumX += rawTrail[j].x;
      sumY += rawTrail[j].y;
      count++;
    }
    
    smoothed.push({
      x: sumX / count,
      y: sumY / count,
      frame: rawTrail[i].frame
    });
  }
  
  return smoothed;
}

function generateCleanArc(smoothedTrail) {
  if (!Array.isArray(smoothedTrail) || smoothedTrail.length < 3) {
    return { trail: smoothedTrail, releasePoint: null, apexPoint: null, rimCrossingPoint: null };
  }
  
  // Find release point (first point after release)
  const releasePoint = smoothedTrail[0];
  
  // Find apex (highest point - lowest Y value)
  let apexIdx = 0;
  let minY = smoothedTrail[0].y;
  for (let i = 1; i < smoothedTrail.length; i++) {
    if (smoothedTrail[i].y < minY) {
      minY = smoothedTrail[i].y;
      apexIdx = i;
    }
  }
  const apexPoint = smoothedTrail[apexIdx];
  
  // Find rim crossing point (where ball crosses rim level)
  const hoop = window.getLockedHoopBox?.();
  let rimCrossingPoint = null;
  if (hoop) {
    const rimY = hoop.cy; // Use hoop center Y as rim level
    for (let i = 1; i < smoothedTrail.length; i++) {
      const prev = smoothedTrail[i-1];
      const curr = smoothedTrail[i];
      if (prev.y <= rimY && curr.y > rimY) {
        // Interpolate exact crossing point
        const t = (rimY - prev.y) / (curr.y - prev.y);
        rimCrossingPoint = {
          x: prev.x + (curr.x - prev.x) * t,
          y: rimY,
          frame: prev.frame + (curr.frame - prev.frame) * t
        };
        break;
      }
    }
  }
  
  // Generate clean arc with key points
  const cleanTrail = [];
  
  // Add release point
  cleanTrail.push(releasePoint);
  
  // Add intermediate points (simplified)
  const step = Math.max(1, Math.floor(smoothedTrail.length / 8));
  for (let i = step; i < smoothedTrail.length - step; i += step) {
    cleanTrail.push(smoothedTrail[i]);
  }
  
  // Add apex point if not already included
  if (apexIdx > 0 && apexIdx < smoothedTrail.length - 1) {
    const apexIncluded = cleanTrail.some(p => 
      Math.abs(p.x - apexPoint.x) < 5 && Math.abs(p.y - apexPoint.y) < 5
    );
    if (!apexIncluded) {
      cleanTrail.push(apexPoint);
    }
  }
  
  // Add rim crossing point if found
  if (rimCrossingPoint) {
    cleanTrail.push(rimCrossingPoint);
  }
  
  // Add final point
  cleanTrail.push(smoothedTrail[smoothedTrail.length - 1]);
  
  // Sort by frame to maintain chronological order
  cleanTrail.sort((a, b) => (a.frame || 0) - (b.frame || 0));
  
  return {
    trail: cleanTrail,
    releasePoint,
    apexPoint,
    rimCrossingPoint
  };
}

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


