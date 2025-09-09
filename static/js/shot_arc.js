// shot_arc.js â€” Canonical release/exit timing from pose + ball + hoop
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

export function resetShotFSM() {
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

export function proxFromHoop(H) {
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
export function updateRelease(frame, pose, ballPt, hoopBox) {
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
      // Canonical latch
      try {
        if (typeof window.__markReleasePose === 'function') window.__markReleasePose(frame, { prox: proxFromHoop(H) });
        else if (typeof window.markRelease === 'function') window.markRelease(frame, { prox: proxFromHoop(H) });
      try { const snap = window.capturePoseSnapshot?.(window.playerState, window.getLockedHoopBox?.()); window.dispatchEvent(new CustomEvent('pose:release', { detail: { frame, tMs: performance.now(), poseSnapshot: snap } })); } catch {}
      } catch {}
      // Also dispatch event for listeners
      try { window.dispatchEvent(new CustomEvent('shot:release', { detail: { frame, via: 'shot_arc' } })); } catch {}
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
        if (typeof window.__markReleasePose === 'function') window.__markReleasePose(frame, { prox });
        else if (typeof window.markRelease === 'function') window.markRelease(frame, { prox });
        try { const snap = window.capturePoseSnapshot?.(window.playerState, window.getLockedHoopBox?.()); window.dispatchEvent(new CustomEvent('pose:release', { detail: { frame, tMs: performance.now(), poseSnapshot: snap } })); } catch {}
        try { window.dispatchEvent(new CustomEvent('shot:release', { detail: { frame, via: 'prox-fallback' } })); } catch {}
        if (window.DOACH_SHOT_DEBUG) console.log('[shot_arc] RELEASE LATCHED (prox-fallback)', { frame });
        _state.relLatched = true;
        return true;
      }
    } catch {}

    // Fallback 2: slope-based latch — if ball has been trending upward for the last ~3
    // frames inside the lane near rim height, assume release even without pose.
    try {
      const t = Array.isArray(window.ballState?.trail) ? window.ballState.trail : [];
      if (t.length >= 3 && H) {
        const a = t[t.length - 3], b = t[t.length - 2], c = t[t.length - 1];
        const up = (c.y < b.y - 1.5) && (b.y < a.y - 1.5);
        const laneX = Math.abs(c.x - H.cx) <= Math.max(45, H.w * 0.5);
        const nearRimBand = c.y <= (H.rimTop + Math.max(36, H.h * 0.6));
        if (!poseOK && up && laneX && nearRimBand) {
          const prox = proxFromHoop(H);
          if (typeof window.__markReleasePose === 'function') window.__markReleasePose(frame, { prox });
          else if (typeof window.markRelease === 'function') window.markRelease(frame, { prox });
        try { const snap = window.capturePoseSnapshot?.(window.playerState, window.getLockedHoopBox?.()); window.dispatchEvent(new CustomEvent('pose:release', { detail: { frame, tMs: performance.now(), poseSnapshot: snap } })); } catch {}
          try { window.dispatchEvent(new CustomEvent('shot:release', { detail: { frame, via: 'slope-fallback' } })); } catch {}
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
export function updateExit(frame, ballPt, hoopBox) {
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
export function updateShotArcTick({ frame, pose = null, ballPt = null, hoopBox = null } = {}) {
  // Ensure proximity/enter stamping occurs before release uses it
  const ex  = updateExit(frame, ballPt, hoopBox);
  const rel = updateRelease(frame, pose, ballPt, hoopBox);
  return { released: rel, ...ex };
}

// ---- Arc stepping (centralized) -------------------------------------------
export function updateArc(frame, ballPt, hoopBox) {
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
  return true;
}

// Attach helpers for optional non-ESM callers (safe no-ops if not used)
try {
  window.shotArc = window.shotArc || { resetShotFSM, updateRelease, updateExit, updateShotArcTick, updateArc, proxFromHoop };
  if (!window.__shotArcLoadedOnce) { window.__shotArcLoadedOnce = true; try { console.log('[shot_arc] loaded'); } catch {} }
} catch {}
