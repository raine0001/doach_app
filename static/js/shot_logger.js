// shot_logger.js — consolidated, weighted scoring always used

import {
  score,
  showShotSummaryOverlay as canvasOverlay,
  estimateReleaseAngle,
  detectNetMotionFromCanvas,
  arcHeightLabel,
} from './shot_utils.js';

import { markRelease, freezeShot } from './ball_tracker.js';
import { getLockedHoopBox } from './hoop_tracker.js';


// lazy accessor breaks the TDZ on cyclic imports
function BS() {
  return (window.ballState || (window.ballState = {}));
}
function ensureBallLatches() {
  const s = BS();
  if (typeof s._lastInProx      === 'undefined') s._lastInProx = false;
  if (typeof s._lastY           === 'undefined') s._lastY = 0;
  if (typeof s.releaseSignaled  === 'undefined') s.releaseSignaled = false;
  if (typeof s.summarySignaled  === 'undefined') s.summarySignaled = false;

  // NEW: count frames after leaving box before we finalize
  if (typeof s._postExitFrames  === 'undefined') s._postExitFrames = 0;
  return s;
}


function shouldDeferSummaries() {
  try { if (window.SESSION_MANAGER_OWNS_ENDING === true) return false; } catch {}
  return window.DEFER_FE_SUMMARY === true;
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

// ---- Coach / TTS de-dupe wrapper (exactly once per shot record) ----
(function wrapCoachTTSDedupe() {
  // remember which shot id we’ve already announced
  window.__lastAnnouncedShotId = window.__lastAnnouncedShotId || 0;

  // If a global coach hook exists, wrap it once so it can't repeat
  if (typeof window.doachOnShot === 'function' && !window.doachOnShot.__wrapped) {
    const orig = window.doachOnShot;
    window.doachOnShot = function(rec) {
      try {
        if (!rec) return;
        const id = rec.id ?? rec?.shotId ?? rec?.frameEnd ?? 0; // tolerate shapes
        if (id && window.__lastAnnouncedShotId === id) return;   // ✅ already spoke for this shot
        if (id) window.__lastAnnouncedShotId = id;               // latch this shot
        return orig(rec);                                        // speak once
      } catch (e) { console.warn('[coach TTS] suppressed/failed:', e); }
    };
    window.doachOnShot.__wrapped = true;
  }
})();

// Let app.js handle when to re-arm release guards; avoid double resets here



// ===== Constants =====

// How long to keep tracking after we leave the box (to gather net evidence)
const POST_EXIT_MIN_FRAMES = Number(window.POST_EXIT_MIN_FRAMES ?? 12);   // try 8–12 (higher allows longer linger at rim)
const POST_EXIT_MAX_FRAMES = Number(window.POST_EXIT_MAX_FRAMES ?? 20);   // safety cap
// Pose-only fallback: auto-finalize if trail isn’t updating after release
const AUTO_SUMMARY_GAP_FRAMES = Number(window.AUTO_SUMMARY_GAP ?? 8);     // ~0.8s @10fps
const AUTO_SUMMARY_MAX_FRAMES = Number(window.AUTO_SUMMARY_MAX ?? 90);    // ~3.0s cap

// Shot window policy
const SHOT_MAX_POST_FRAMES   = Number(window.SHOT_MAX_POST_FRAMES   ?? 45); // hard cap after release in FE
const SHOT_SAVE_PRE_FRAMES   = Number(window.SHOT_SAVE_PRE_FRAMES   ?? 10); // for clip extraction (saved metadata)
const SHOT_SAVE_POST_FRAMES  = Number(window.SHOT_SAVE_POST_FRAMES  ?? 90);
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

// ---------- Robust post-rim classifier focused on accuracy ----------

// Count every downward crossing of the rim line (helps with rattles/swirl)
function countRimCrossings(trail, H) {
  if (!Array.isArray(trail) || trail.length < 2) return 0;
  let crosses = 0;
  for (let i = 1; i < trail.length; i++) {
    const a = trail[i-1], b = trail[i];
    if (a.y <= H.rimY && b.y > H.rimY) {
      // near center in X to avoid side noise
      const xTol = Math.max(55, H.w * TUNABLES.LINE_XTOL_MULT);
      if (Math.abs(a.x - H.cx) <= xTol || Math.abs(b.x - H.cx) <= xTol) crosses++;
    }
  }
  return crosses;
}


/**
 * classifyShotOutcome — purely geometric decision (no NN)
 * Returns { made, reason, metrics } using:
 *   • rim-line crossing(s)
 *   • center-lane descent (tube)
 *   • net region presence
 *   • “rim-out” rebound
 *   • swirl/rattle tolerance (multiple crossings)
 */
function classifyShotOutcome(trail, hoopBox) {
  const H0 = normLockedHoop(hoopBox);
  const H  = normHoopFlexible(H0);
  const tailRaw = trail.slice(-Math.max(22, TUNABLES.TAIL));
  const tail    = densifyTrail(tailRaw);

  if (!H || tail.length < 3) return { made:false, reason:'Insufficient trail', metrics:{} };

  const apexY        = Math.min(...tail.map(p => p.y));
  const apexAboveRim = apexY < (H.rimY - 6);

  const laneHalf     = Math.max(TUNABLES.CENTER_LANE_MIN, H.w * 0.32);
  const netTop       = H.rimY;
  const netBottom    = H.y1 + H.h * TUNABLES.DEPTH_POS;
  const inNetNarrow  = tail.some(p => Math.abs(p.x - H.cx) <= laneHalf && p.y >= netTop && p.y <= netBottom);

  // tolerant rim-line crossing and center descent
  const xTolCross    = Math.max(65, H.w * (TUNABLES.LINE_XTOL_MULT * 1.10));
  let crosses = 0;
  for (let i = 1; i < tail.length; i++) {
    const a = tail[i-1], b = tail[i];
    if (a.y <= H.rimY && b.y > H.rimY) {
      if (Math.abs(a.x - H.cx) <= xTolCross || Math.abs(b.x - H.cx) <= xTolCross) crosses++;
    }
  }
  const tubeRun  = tubeRunAfterCross(tail, H);
  const crossed  = crossedNetLine(tail, H);
  const thickCtr = thickTrailCenterHit(tail, { H, w: H.w * 0.92 });

  // terminal below and roughly centered
  const last     = tail.at(-1);
  const terminalBelow  = last.y >= (H.rimY + Math.max(36, H.h * 0.55));
  const terminalCenter = Math.abs(last.x - H.cx) <= Math.max(18, H.w * 0.45);

  // swirl/rattle: multiple left/right flips after rim
  const flips = swirlSignChanges(tail, H);

  // rim-out (cross then pop up & wide shortly after)
  let rimOut = false;
  const xWide = Math.max(55, H.w * TUNABLES.LINE_XTOL_MULT) * 1.25;
  for (let i = 2; i < tail.length; i++) {
    const a = tail[i-2], b = tail[i-1], c = tail[i];
    if (a.y <= H.rimY && b.y > H.rimY) {
      for (let k = i; k < Math.min(i + 6, tail.length); k++) {
        const u = tail[k-1], v = tail[k];
        const up   = (v.y - u.y) < -1.5;
        const wide = Math.abs(v.x - H.cx) > xWide;
        if (up && wide) { rimOut = true; break; }
      }
      break;
    }
  }

  // ---- decisions ----
  if (!apexAboveRim) {
    return { made:false, reason:'Did not rise above rim', metrics:{crosses, tubeRun, flips, inNetNarrow, thickCtr} };
  }

  // strong makes:
  const centerPass = (tubeRun >= Math.max(2, TUNABLES.TUBE_MIN_CONSEC - 1)) || thickCtr;
  if ((crossed && centerPass) ||                              // clean cross + center descent
      (tubeRun >= Math.max(3, TUNABLES.TUBE_MIN_CONSEC)) ||   // strong tube
      (flips >= 2 && inNetNarrow) ||                          // swirl/rattle then down the lane
      (terminalBelow && terminalCenter)) {                    // ends well below rim & centered
    return { made:true, reason:null, metrics:{crosses, tubeRun, flips, inNetNarrow, crossed, thickCtr, terminalBelow, terminalCenter, apexAboveRim} };
  }

  // clear misses:
  if (rimOut || (!inNetNarrow && crosses > 0 && tubeRun === 0)) {
    return { made:false, reason: rimOut ? 'Rim out' : 'No descent through net region',
             metrics:{crosses, tubeRun, flips, inNetNarrow, crossed, thickCtr, rimOut} };
  }

  // fallback
  const made = crossed && centerPass;
  return { made, reason: made ? null : 'Unclassified miss',
           metrics:{crosses, tubeRun, flips, inNetNarrow, crossed, thickCtr} };
}


// --- normalize hoop regardless of anchor ---
// Normalize a hoop box from various shapes into a center-safe form
// Returns { cx, cy, w, h, x1, y1, x2, y2, rimTop }
function normLockedHoop(hoop) {
  if (!hoop) return null;
  const w = Math.max(1, hoop.w ?? hoop.width  ?? 0);
  const h = Math.max(1, hoop.h ?? hoop.height ?? 0);

  // 1) Explicit center provided
  if (Number.isFinite(hoop.cx) && Number.isFinite(hoop.cy)) {
    const x1 = hoop.cx - w / 2, y1 = hoop.cy - h / 2;
    return { cx: hoop.cx, cy: hoop.cy, w, h, x1, y1, x2: x1 + w, y2: y1 + h, rimTop: y1 };
  }

  // 2) Explicit top-left anchor
  const isTL = (hoop.anchor === 'topleft') || hoop.topLeft || hoop.leftTop || hoop.isLeftTop;
  if (isTL && Number.isFinite(hoop.x) && Number.isFinite(hoop.y)) {
    const x1 = hoop.x, y1 = hoop.y;
    return { cx: x1 + w / 2, cy: y1 + h / 2, w, h, x1, y1, x2: x1 + w, y2: y1 + h, rimTop: y1 };
  }

  // 3) Default: treat x,y as CENTER (this matches hoop_tracker.getLockedHoopBox)
  //    This is the crucial change to align all modules.
  if (Number.isFinite(hoop.x) && Number.isFinite(hoop.y)) {
    const cx = hoop.x, cy = hoop.y;
    const x1 = cx - w / 2, y1 = cy - h / 2;
    return { cx, cy, w, h, x1, y1, x2: x1 + w, y2: y1 + h, rimTop: y1 };
  }

  return null;
}

// Accepts TLWH, center, or mixed; returns { x1,y1,x2,y2,w,h,cx,cy, rimY }
function normHoopFlexible(H) {
  if (!H) return null;

  // Respect explicit center first
  if (Number.isFinite(H.cx) && Number.isFinite(H.cy) && Number.isFinite(H.w) && Number.isFinite(H.h)) {
    const x1 = H.cx - H.w/2, y1 = H.cy - H.h/2;
    return {
      x1, y1, x2: x1 + H.w, y2: y1 + H.h,
      w: H.w, h: H.h, cx: H.cx, cy: H.cy,
      rimY: (H.rimY != null) ? H.rimY : (y1 + H.h * 0.45)
    };
  }

  // Top-left anchored box?
  const isTL = (H.anchor === 'topleft') || H.topLeft || H.leftTop || H.isLeftTop;
  if (isTL && Number.isFinite(H.x) && Number.isFinite(H.y) && Number.isFinite(H.w) && Number.isFinite(H.h)) {
    const x1 = H.x, y1 = H.y;
    return {
      x1, y1, x2: x1 + H.w, y2: y1 + H.h,
      w: H.w, h: H.h, cx: x1 + H.w/2, cy: y1 + H.h/2,
      rimY: (H.rimY != null) ? H.rimY : (y1 + H.h * 0.45)
    };
  }

  // Default: treat x,y as CENTER if present (matches hoop_tracker locked box)
  if (Number.isFinite(H.x) && Number.isFinite(H.y) && Number.isFinite(H.w) && Number.isFinite(H.h)) {
    const cx = H.x, cy = H.y;
    const x1 = cx - H.w/2, y1 = cy - H.h/2;
    return {
      x1, y1, x2: x1 + H.w, y2: y1 + H.h,
      w: H.w, h: H.h, cx, cy,
      rimY: (H.rimY != null) ? H.rimY : (y1 + H.h * 0.45)
    };
  }

  // Try explicit TL if provided as x1,y1,x2,y2
  if (Number.isFinite(H.x1) && Number.isFinite(H.y1) &&
      Number.isFinite(H.x2) && Number.isFinite(H.y2)) {
    const w = Math.max(1, H.x2 - H.x1), h = Math.max(1, H.y2 - H.y1);
    return {
      x1: H.x1, y1: H.y1, x2: H.x2, y2: H.y2, w, h,
      cx: H.x1 + w/2, cy: H.y1 + h/2,
      rimY: (H.rimY != null) ? H.rimY : (H.y1 + h * 0.45)
    };
  }

  return null;
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
let __lingerActive     = false;
let __lingerStartFrame = -1;

export function checkShotConditions(ballStateRef, hoopBox, frameIndex) {
  // Hard arm guard: never start a shot unless user armed + hoop confirmed
  try {
    if (window.__shotTrackingArmed !== true) return false;
    if (window.__hoopConfirmed !== true) return false;
  } catch {}
  const H = normLockedHoop(hoopBox);
  const last = ballStateRef?.trail?.at?.(-1);
  if (!H || !last) return false;

  // CHANGED: use the same normalized hoop to build prox box
  const PROX = _proxBoxFromHoop(H);
  const nowInProx =
    (last.x >= PROX.x1 && last.x <= PROX.x2 && last.y >= PROX.yTop && last.y <= PROX.yBot);

  const s = ensureBallLatches();


  // Arm on *fresh* entry OR if pose already fired release (belt & suspenders)
  const freshEntry = nowInProx && !s._lastInProx && !__shotInProgress && !__awaitingReset && (window.__RESET_SEEN_BELOW !== false);
  if (freshEntry || s.releaseSignaled) {
     __shotInProgress  = true;
     __awaitingReset   = false;       // allow the new attempt to proceed
     __lingerActive     = false;
     __lingerStartFrame = -1;
     s._postExitFrames  = 0;
     if (ballStateRef?.proxExitFrame != null) ballStateRef.proxExitFrame = null;

     if (!s.releaseSignaled) {
       if (window.POSE_FIRST_ONLY === true) {
         // Pose-first mode: do not auto-mark release from proximity entry.
       } else {
         try { markRelease?.(frameIndex); } catch {}
         s.releaseSignaled = true;
         // De-dupe global release event so TTS/handlers fire once
         try {
           if (!window.__releaseEventSent) {
             window.__releaseEventSent = true;
             window.dispatchEvent(new CustomEvent('shot:release', { detail: { frame: frameIndex, via: 'shot_logger' } }));
           }
         } catch {}
        // 🔊 Start FBF strictly at release
        try { window.dispatchEvent(new CustomEvent('fbf:start', { detail: { frame: frameIndex } })); } catch {}
        startFBFAt(frameIndex);
       }
     }
   }


  // CHANGED: “belt & suspenders” finalization
    const leftProx = s._lastInProx && !nowInProx;
    // Latch prox exit frame the *first* time we leave the box
    if (leftProx && ballStateRef.proxExitFrame == null) {
      ballStateRef.proxExitFrame = frameIndex;
      // let FBF know the natural window end; finalize still controls the real stop
      if (window.__fbf?.active && window.__fbf.stopFrame < 0) {
        window.__fbf.stopFrame = frameIndex + Math.max(POST_EXIT_MIN_FRAMES, 8);
      }
    }
    const exitedBottomDownward = leftProx && (last.y >= PROX.yBot - 2) && (last.y >= s._lastY);
    const exitedBottomByLatch  = (ballStateRef.proxExitFrame != null) && (last.y >= PROX.yBot - 2);
    const exitedBottom = exitedBottomDownward || exitedBottomByLatch;

    // Backup: treat clearly "below net" as an end condition (y > rim + h + 40)
    const belowNetEnd = (last.y > (H.rimTop + H.h + 40));

    if (__shotInProgress && (exitedBottom || leftProx)) {
      // keep tracking for a short window after exit, to collect net evidence
      s._postExitFrames = (s._postExitFrames || 0) + 1;

      // finalize only when we have either enough linger OR clear net evidence
      const enoughTime   = s._postExitFrames >= POST_EXIT_MIN_FRAMES;
      const evidenceSeen = hasNetEvidence(ballStateRef.trail, hoopBox);
      const hitMax       = s._postExitFrames >= POST_EXIT_MAX_FRAMES;

      if (!(enoughTime || evidenceSeen || hitMax || belowNetEnd)) {
        s._lastInProx = nowInProx;
        s._lastY      = last.y;
        return false; // keep extending the trail
      }

      // ✅ finalize once (freeze + log + summary)
      __shotInProgress    = false;
      __awaitingReset     = true;
      s._postExitFrames   = 0;

      if (ballStateRef.state !== 'FROZEN') { try { freezeShot?.(null); } catch {} }
      // Re-arm for next attempt: clear releaseFrame once summary is computed
      try { ballStateRef.releaseFrame = null; ballStateRef.state = 'IDLE'; } catch {}

      let shotRecord = null;
      const frozen = ballStateRef.shots?.at?.(-1);
      const trailForLog =
        (frozen?.trail?.length >= 3) ? frozen.trail :
        (ballStateRef?.trail?.length >= 3 ? ballStateRef.trail.slice(-28) : null);

      if (!shouldDeferSummaries()) {
        if (trailForLog) {
          try {
            shotRecord = results?.(trailForLog, frameIndex, hoopBox, { force: true }) || null;
          } catch {}
        }
        if (!shotRecord && window.shotLog?.length) shotRecord = window.shotLog.at(-1);
      }

      try { window.dispatchEvent(new CustomEvent('shot:end', { detail: { frame: frameIndex } })); } catch {}
      try { window.dispatchEvent(new CustomEvent('fbf:stop', { detail: { frame: frameIndex } })); } catch {}
      stopFBFAt(frameIndex);


      if (!s.summarySignaled) {
        s.summarySignaled = true;
        // Attach desired clip window metadata if present
        try {
          if (shotRecord) {
            const start = Number.isFinite(ballStateRef?.saveStartFrame) ? ballStateRef.saveStartFrame : Math.max(0, (ballStateRef?.releaseFrame ?? frameIndex) - SHOT_SAVE_PRE_FRAMES);
            const end   = Math.min(
              Number.isFinite(ballStateRef?.saveEndFrameMax) ? ballStateRef.saveEndFrameMax : ((ballStateRef?.releaseFrame ?? frameIndex) + SHOT_SAVE_POST_FRAMES),
              frameIndex
            );
            shotRecord.clip = { start, end };
          }
        } catch {}
        if (!shouldDeferSummaries()) {
          try {
            if (window.SUM_TRACE === true) console.log('[SUM:emit]', { via:'exit-finalize', made: !!(shotRecord&&shotRecord.made), arc: shotRecord?.arcHeight, entry: shotRecord?.entryAngle, release: shotRecord?.releaseAngle, frame: frameIndex });
            window.dispatchEvent(new CustomEvent('shot:summary', { detail: shotRecord || null }));
          } catch {}
        }
        // Only stop analyzer for non-live uploads or test flows.
        // In live camera sessions, keep analyzer running so pose/hoop stay visible
        // and subsequent shots are detected without manual restart.
        try { if (!window.__SESSION_ACTIVE) window.stopFrameAnalysis?.(); } catch {}
        // optional: unlock after N ms even if ball didn't rise above rim
        const unlockMs = Number(window.NEXT_SHOT_UNLOCK_MS ?? 2000);
        setTimeout(() => { __awaitingReset = false; s._postExitFrames = 0; }, unlockMs);
      }


      s._lastInProx = nowInProx;
      s._lastY      = last.y;
      return true;
    }

    // Pose-only fallback: if we’ve latched release but the ball trail isn’t updating,
    // finalize after a short gap to allow HUD progression even without dense ball detections.
    if (__shotInProgress && s.releaseSignaled) {
      const lastTrail = ballStateRef?.trail?.at?.(-1) || null;
      const df = lastTrail && Number.isFinite(lastTrail.frame)
        ? (frameIndex - lastTrail.frame)
        : (AUTO_SUMMARY_GAP_FRAMES + 1);
      const sinceRelease = Number.isFinite(ballStateRef?.releaseFrame)
        ? (frameIndex - ballStateRef.releaseFrame)
        : 0;
      // Hard post-release cap – finalize by SHOT_MAX_POST_FRAMES regardless
      const hitPostCap    = Number.isFinite(ballStateRef?.releaseFrame)
        ? ((frameIndex - ballStateRef.releaseFrame) >= SHOT_MAX_POST_FRAMES)
        : false;
      if (df >= AUTO_SUMMARY_GAP_FRAMES || sinceRelease >= AUTO_SUMMARY_MAX_FRAMES || hitPostCap) {
        __shotInProgress  = false;
        __awaitingReset   = true;
        s._postExitFrames = 0;

        if (ballStateRef.state !== 'FROZEN') { try { freezeShot?.(null); } catch {} }
        // Re-arm for next attempt: clear releaseFrame when auto-finalizing
        try { ballStateRef.releaseFrame = null; ballStateRef.state = 'IDLE'; } catch {}

        let shotRecord = null;
        const frozen = ballStateRef.shots?.at?.(-1);
        const trailForLog =
          (frozen?.trail?.length >= 3) ? frozen.trail :
          (ballStateRef?.trail?.length >= 3 ? ballStateRef.trail.slice(-28) : null);
        if (!shouldDeferSummaries()) {
          if (trailForLog) { try { shotRecord = results?.(trailForLog, frameIndex, hoopBox, { force: true }) || null; } catch {} }
          if (!shotRecord && window.shotLog?.length) shotRecord = window.shotLog.at(-1);
        }

        try { window.dispatchEvent(new CustomEvent('shot:end', { detail: { frame: frameIndex, via: 'auto-gap' } })); } catch {}
        try { window.dispatchEvent(new CustomEvent('fbf:stop', { detail: { frame: frameIndex } })); } catch {}
        stopFBFAt(frameIndex);

        if (!s.summarySignaled) {
          s.summarySignaled = true;
          // Attach clip window metadata
          try {
            if (shotRecord) {
              const start = Number.isFinite(ballStateRef?.saveStartFrame) ? ballStateRef.saveStartFrame : Math.max(0, (ballStateRef?.releaseFrame ?? frameIndex) - SHOT_SAVE_PRE_FRAMES);
              const end   = Math.min(
                Number.isFinite(ballStateRef?.saveEndFrameMax) ? ballStateRef.saveEndFrameMax : ((ballStateRef?.releaseFrame ?? frameIndex) + SHOT_SAVE_POST_FRAMES),
                frameIndex
              );
              shotRecord.clip = { start, end };
            }
          } catch {}
          if (!shouldDeferSummaries()) {
            try {
              if (window.SUM_TRACE === true) console.log('[SUM:emit]', { via:'auto-gap', made: !!(shotRecord&&shotRecord.made), arc: shotRecord?.arcHeight, entry: shotRecord?.entryAngle, release: shotRecord?.releaseAngle, frame: frameIndex });
              window.dispatchEvent(new CustomEvent('shot:summary', { detail: shotRecord || null }));
            } catch {}
          }
          try { if (!window.__SESSION_ACTIVE) window.stopFrameAnalysis?.(); } catch {}
          const unlockMs = Number(window.NEXT_SHOT_UNLOCK_MS ?? 2000);
          setTimeout(() => { __awaitingReset = false; s._postExitFrames = 0; }, unlockMs);
        }

        s._lastInProx = nowInProx;
        s._lastY      = last?.y ?? s._lastY;
        return true;
      }
    }

    // When the ball rises well above rim, re-arm for the next attempt
    if (__awaitingReset && last.y < (H.rimTop - 40)) {
      __awaitingReset   = false;
      s._postExitFrames = 0;
      s.releaseSignaled = false;
      s.summarySignaled = false;
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
  const PB = _proxBoxFromHoop(rawHoop);        // { H, x1,x2,yTop,yBot }
  if (!PB) return false;

  // hysteresis
  const s = BS?.() || {};
  const mode = opts.mode || 'stay';
  const pad  = ((s.state === 'TRACKING' || s.releaseSignaled) ? (Number(window.proxHys) || 6) : 0);

  const x1 = PB.x1 - (mode === 'stay' ? pad : 0);
  const x2 = PB.x2 + (mode === 'stay' ? pad : 0);
  const yT = PB.yTop - (mode === 'stay' ? pad : 0);
  const yB = PB.yBot + (mode === 'stay' ? pad : 0);

  const inside = (ballPt.x >= x1 && ballPt.x <= x2 && ballPt.y >= yT && ballPt.y <= yB);

  if (window.DOACH_PROX_TRACE) {
    console.log('[prox:box]', {
      // hoop center & rim line used
      cx: PB.H.cx, rimY: PB.H.rimTop, w: PB.H.w, h: PB.H.h,
      // actual tested band
      x1, x2, yTop: yT, yBot: yB,
      // point tested
      p: { x: Math.round(ballPt.x), y: Math.round(ballPt.y) },
      inside
    });
  }

  return inside;
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


// --- Doach Correction API (user-initiated) ---
export function applyShotCorrection({ id = null, made, reason = 'User correction', confidence = null }) {
  if (!Array.isArray(shotLog) || !shotLog.length) return null;

  const idx = (id != null)
    ? Math.max(0, Math.min(shotLog.length - 1, (Number(id) - 1)))
    : (shotLog.length - 1);

  const rec = shotLog[idx];
  if (!rec) return null;

  const before = { ...rec };
  rec.made = !!made;
  rec.missReason = made ? null : (reason || rec.missReason || 'Unclassified miss');
  if (Number.isFinite(confidence)) rec.correctionConfidence = Math.max(0, Math.min(1, confidence));

  // keep the session table’s data source in sync (video_ui modal uses __shotList)
  try {
    const list = window.__shotList;
    if (Array.isArray(list) && list[idx]) list[idx].made = rec.made;
  } catch {}

  try { updateBottomStats?.(); drawShotStatsTable?.(); } catch {}

  // Banner (uses video_ui’s showShotBanner)
  window.showShotBanner?.({
    made: rec.made,
    arcHeight: rec.arcHeight, entryAngle: rec.entryAngle, releaseAngle: rec.releaseAngle,
    accuracy: Math.round(shotLog.filter(s => s.made).length / shotLog.length * 100),
    madeShots: shotLog.filter(s => s.made).length,
    totalShots: shotLog.length,
    note: rec.correctionConfidence != null ? `Correction • conf ${Math.round(rec.correctionConfidence*100)}%` : 'Correction applied'
  }); // :contentReference[oaicite:3]{index=3}

  // optional: HUD metrics bump
  try {
    const taken = window.__shotList?.length || shotLog.length || 0;
    const madeN = shotLog.filter(s => s.made).length;
    window.updateSessionHUD?.({ taken, made: madeN, accuracy: taken ? (madeN/taken)*100 : 0 });
  } catch {}

  try { autoTuneFromCorrection?.(before, rec); } catch {}

  try { window.dispatchEvent(new CustomEvent('shot:corrected', { detail: { id: rec.id, made: rec.made } })); } catch {}

  // Sync correction to backend session if available
  (async () => {
    try {
      const sid = (window.__SESSION_ID || null);
      if (!sid) return; // do not create a new session for a correction
      const idx0 = Math.max(0, (Number(rec.id) || 1) - 1); // zero-based index
      const payload = {
        idx: idx0,
        t: Date.now(),
        made: rec.made,
        missReason: rec.missReason || null,
        corrected: true,
        correctionConfidence: (rec.correctionConfidence != null) ? rec.correctionConfidence : null
      };
      await fetch(`/api/sessions/${sid}/shot`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload), credentials:'include' }).catch(()=>{});
    } catch {}
  })();

  return rec;
}

window.applyShotCorrection = applyShotCorrection;


// Doach interaction for shot corrections

export async function reviewShotWithAI({ id = null } = {}) {
  const rec = (id != null) ? shotLog[id - 1] : shotLog.at(-1);
  if (!rec) return null;

  // Minimal pack: recent trail + hoop box + current decision & scores
  const locked = getLockedHoopBox?.();
  const payload = {
    id: rec.id,
    made: !!rec.made,
    weightedScore: rec.weightedScore ?? null,
    trail: (rec.trail || []).map(p => ({ x: Math.round(p.x), y: Math.round(p.y), f: p.frame|0 })),
    hoop: locked ? { x: locked.x ?? (locked.cx - locked.w/2), y: locked.y ?? (locked.cy - locked.h/2),
                     w: locked.w, h: locked.h, cx: locked.cx ?? (locked.x + locked.w/2),
                     cy: locked.cy ?? (locked.y + locked.h/2) } : null,
    meta: { entryAngle: rec.entryAngle, releaseAngle: rec.releaseAngle, arcHeight: rec.arcHeight }
  };

  try {
    const res = await fetch('/doach/review_shot', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
    if (!res.ok) throw new Error('review failed');
    const out = await res.json(); // { made:boolean, confidence:number(0..1), reason?:string }
    // Apply only if model proposes a change OR user asked for “accept suggestion”
    if (typeof out.made === 'boolean') {
      applyShotCorrection({ id: rec.id, made: out.made, reason: out.reason || 'AI review', confidence: out.confidence });
    }
    return out;
  } catch (e) {
    console.warn('[doach/review] error', e);
    return null;
  }
}
window.reviewShotWithAI = reviewShotWithAI;

// autotune from correction
function bounded(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

export function autoTuneFromCorrection(recBefore, recAfter) {
  try {
    if (!recBefore || !recAfter) return;
    const prevMade = !!recBefore.made;
    const newMade  = !!recAfter.made;
    if (prevMade === newMade) return;

    const s0 = Number(recBefore.weightedScore ?? 0);
    let thr = Number(window.WEIGHTED_THRESH ?? 0.65);

    if (!prevMade && newMade) {
      // Miss → Make: we were too strict
      if (s0 > thr - 0.12) thr = bounded(thr - 0.02, 0.55, 0.90);
    } else if (prevMade && !newMade) {
      // Make → Miss: we were too lenient
      if (s0 >= thr + 0.12) thr = bounded(thr + 0.02, 0.55, 0.90);
    }
    if (thr !== window.WEIGHTED_THRESH) {
      setWeightedThresh?.(thr); // persists to localStorage
      console.log('[tune] WEIGHTED_THRESH =>', thr);
    }
  } catch {}
}
window.autoTuneFromCorrection = autoTuneFromCorrection;



//-----------------------------------------------------------------//
//                   Detect and log a shot summary                 //
//-----------------------------------------------------------------//
/**
 * summarizeShot — compute-only summary without logging/UI side effects.
 * Returns a plain record or null.
 */
export function summarizeShot(trail, __frameIdx, hoopBox, opts = {}) {
  if (!trail || trail.length < 3 || !hoopBox) return null;

  // Normalize frames to a strictly increasing series
  let t = trail;
  const badStart = !('frame' in t[0]) || !Number.isFinite(t[0].frame);
  const badEnd   = !Number.isFinite(t.at?.(-1)?.frame);
  if (badStart || badEnd) {
    const seed = Number.isFinite(BS()?.releaseFrame) ? BS().releaseFrame : (__frameIdx - t.length);
    let f = seed;
    t = t.map(p => ({ ...p, frame: Number.isFinite(p.frame) ? p.frame : (++f) }));
  } else {
    let lastF = Number.isFinite(t[0].frame) ? t[0].frame : (__frameIdx - t.length);
    t = t.map((p, i) => {
      const f  = Number.isFinite(p.frame) ? p.frame : (lastF + 1);
      const ff = (i === 0) ? f : Math.max(f, lastF + 1);
      lastF = ff; return (p.frame === ff) ? p : { ...p, frame: ff };
    });
  }

  const mode   = String(window.SHOT_SCORER_MODE || 'weighted').toLowerCase();
  const first  = t[0];
  const lastPt = t.at?.(-1);

  // center-safe hoop normalization
  const H0 = normLockedHoop(hoopBox);
  const H  = normHoopFlexible(H0);

  const apexIdx      = (() => { let j=0, y=t[0].y; for (let i=1;i<t.length;i++) if (t[i].y < y) { y=t[i].y; j=i; } return j; })();
  const apexP        = t[apexIdx];
  const apexY        = apexP.y;
  const arcHeight    = (H ? Math.max(0, Math.round(H.rimY - apexY)) : 0); // apex above rim (px)
  const relY         = t[0]?.y ?? apexY;
  const apexRiseFromRelease = Math.max(0, Math.round(relY - apexY)); // release→apex vertical rise (px)
  const arcHeightNorm       = (H && H.h) ? +(arcHeight / H.h).toFixed(3) : null;
  const apexRiseFromReleaseNorm = (H && H.h) ? +(apexRiseFromRelease / H.h).toFixed(3) : null;

  // release angle (first moving samples)
  const moves = [];
  for (let i = 1; i < Math.min(t.length, 12); i++) {
    const a = t[i-1], b = t[i];
    if (Math.hypot(b.x - a.x, b.y - a.y) > 1.5) moves.push(b);
    if (moves.length >= 6) break;
  }
  const releaseAngle = estimateReleaseAngle(moves.length ? [t[0], ...moves] : t);

  // net motion (compute-only)
  let netMoved = null;
  try {
    const canvas = window.videoCanvas || window.__videoCanvas || null;
    if (canvas && typeof detectNetMotionFromCanvas === 'function') {
      netMoved = detectNetMotionFromCanvas(canvas, hoopBox);
    }
  } catch {}

  // region + weighted (use normalized t)
  let region = {};
  try { region = score(t, hoopBox, netMoved) || {}; } catch { region = {}; }
  const regionMade  = !!region.made;
  const entryAngle  = Number.isFinite(region.entryAngle) ? region.entryAngle : 0;

  let weightedScore = 0, weightMade = false;
  try {
    weightedScore = computeWeightedShotScore(t);
    weightMade    = weightedScore >= (window.WEIGHTED_THRESH ?? 0.65);
  } catch {}

  // geometry classifier (pure rim/trail)
  let geo = { made:false, reason:null };
  try { if (typeof classifyShotOutcome === 'function') geo = classifyShotOutcome(t, hoopBox) || geo; } catch {}

  // Final decision (hybrid)
  let made   = (regionMade || weightMade);
  let reason = made ? null : (geo.reason || getMissReason(t, hoopBox));
  if (geo && geo.made === false && (geo.reason === 'Rim out' || geo.reason === 'No descent through net region')) {
    made = false; reason = geo.reason;
  } else if (!made && geo && geo.made) {
    made = true; reason = null;
  }

  // Optional arc contract metrics (pure compute; no auto-fix here)
  let arcMetrics = null, arcPass = undefined, arcReasons = undefined;
  try {
    const { computeArcMetrics, assessArcQuality } = (window.arcContract || {});
    if (typeof computeArcMetrics === 'function') {
      arcMetrics = computeArcMetrics(BS()?.trail || [], hoopBox);
      const check = typeof assessArcQuality === 'function' ? assessArcQuality(arcMetrics) : null;
      if (check) { arcPass = !!check.pass; arcReasons = Array.isArray(check.reasons) ? check.reasons : undefined; }
    }
  } catch {}

  return {
    frameStart: first.frame,
    frameEnd:   lastPt.frame,
    trail: t,
    made,
    entryAngle,
    releaseAngle,
    arcHeight,
    apexY,
    apexFrame: apexP.frame,
    apexRiseFromRelease,
    arcHeightNorm,
    apexRiseFromReleaseNorm,
    missReason: reason,
    netMoved: !!netMoved,
    weightedScore,
    scorerMode: mode,
    regionMade,
    weightMade,
    arcMetrics,
    arcPass,
    arcReasons,
  };
}
export function detectAndLogShot(trail, __frameIdx, hoopBox, opts = {}) {
  // Delegate to the canonical logging entry
  return results(trail, __frameIdx, hoopBox, opts);
}

// ---- Primary, single-purpose API: summarize and log a shot ----
// Returns the shot record pushed to `shotLog` and updates UI/coach hooks.
// Keeps compatibility by delegating to detectAndLogShot.
export function results(trail, frameIndex, hoopBox, opts = {}) {
  if (!trail || trail.length < 3 || !hoopBox) return null;

  // de-dupe by frame/time/hash — but allow a forced call (from finalize)
  if (!opts.force) {
    if (frameIndex === lastShotFrameId) return shotLog.at(-1) ?? null;
    if (!shouldLogShot(trail, frameIndex)) return shotLog.at(-1) ?? null;
    lastShotFrameId = frameIndex;
  } else {
    lastShotFrameId = frameIndex;
  }

  // 1) Compute-only summary
  const shotRecord = summarizeShot(trail, frameIndex, hoopBox, opts);
  if (!shotRecord) return null;

  // 2) Reflect on frozen shot (for coloring)
  try {
    const s = BS();
    const lastFrozen = s?.shots?.at?.(-1);
    if (lastFrozen) {
      lastFrozen.made     = !!shotRecord.made;
      lastFrozen.score    = Number(shotRecord.weightedScore || 0);
      lastFrozen.netMoved = !!shotRecord.netMoved;
    }
  } catch {}

  // 3) Log + enrich with arc contract and notify UI/coach
  const rec = logShot(shotRecord);

  try {
    const hoop = window.getLockedHoopBox?.();
    const { computeArcMetrics, assessArcQuality, proposeAutoFix, applyFixes } = (window.arcContract || {});
    if (typeof computeArcMetrics === 'function') {
      const m = computeArcMetrics(BS()?.trail || [], hoop);
      const check = typeof assessArcQuality === 'function' ? assessArcQuality(m) : { pass: true, reasons: [] };
      rec.arcMetrics = m;
      rec.arcPass    = !!check?.pass;
      rec.arcReasons = Array.isArray(check?.reasons) ? check.reasons : [];
      if (!rec.arcPass) {
        const fixes = typeof proposeAutoFix === 'function' ? proposeAutoFix(m) : null;
        if (fixes) try { applyFixes?.(fixes); } catch {}
      }
    }
    try { window.__lastSummary = rec; } catch {}
  } catch {}

  console.log('[shot]', {
    id: rec?.id, made: shotRecord.made, reason: shotRecord.missReason,
    regionMade: shotRecord.regionMade, weightMade: shotRecord.weightMade,
    weightedScore: shotRecord.weightedScore,
    frameStart: shotRecord.frameStart, frameEnd: shotRecord.frameEnd
  });

  try { drawShotStatsTable?.(); updateBottomStats?.(); } catch {}

  if (typeof canvasOverlay === 'function') {
    canvasOverlay({
      made: shotRecord.made,
      arcHeight: shotRecord.arcHeight,
      entryAngle: shotRecord.entryAngle,
      releaseAngle: shotRecord.releaseAngle
    }, hoopBox);
  }

  const madeShots  = shotLog.filter(s => s.made).length;
  const totalShots = shotLog.length || 1;
  const accuracy   = Math.round((madeShots / totalShots) * 100);
  window.showShotBanner?.({
    made: shotRecord.made,
    arcHeight: shotRecord.arcHeight,
    entryAngle: shotRecord.entryAngle,
    releaseAngle: shotRecord.releaseAngle,
    accuracy, madeShots, totalShots
  });

  window.__lastAnnouncedShotId = window.__lastAnnouncedShotId || 0;
  if (rec && window.__lastAnnouncedShotId !== rec.id) {
    window.__lastAnnouncedShotId = rec.id;
    try { window.doachOnShot?.(rec); } catch (e) { console.warn('[doach] feedback failed:', e); }
  }

  return rec;
}
export default results;


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


function netBoxFromHoop(H) {
  const width  = Math.max(60, H.w * 1.25);
  const height = Math.max(40, H.h * 0.9);
  const nx1 = H.cx - width / 2;
  const ny1 = H.y1 + H.h * 0.55;
  return [nx1, ny1, nx1 + width, ny1 + height];
}

function firstRimCrossIndex(trail, H) {
  const baseTol = Math.max(55, H.w * TUNABLES.LINE_XTOL_MULT);
  const xTol = (window.__TEST_MODE ? baseTol * 1.35 : baseTol);
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
  const tubeHalf = Math.max(12, H.w * (window.__TEST_MODE ? (TUNABLES.TUBE_WIDTH_RATIO * 1.4) : TUNABLES.TUBE_WIDTH_RATIO));
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
  const baseTol  = Math.max(55, H.w * TUNABLES.LINE_XTOL_MULT);
  const xTol = window.__TEST_MODE ? baseTol * 1.35 : baseTol;
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

// Count left/right flips around rim center while in post-rim zone (swirl/rattle)
function swirlSignChanges(trail, H) {
  let flips = 0, lastSign = null;
  const yTop = H.rimY;
  const yBot = H.y1 + H.h * TUNABLES.DEPTH_POS; // same depth you use elsewhere
  for (const p of trail) {
    if (p.y < yTop || p.y > yBot) continue;     // only between rim and deep net
    const s = Math.sign((p.x - H.cx) || 0);
    if (s === 0) continue;
    if (lastSign === null) lastSign = s;
    else if (s !== lastSign) { flips++; lastSign = s; }
  }
  return flips;
}

export function computeWeightedShotScore(trail) {
  const locked = getLockedHoopBox?.();
  const H = normHoopFlexible(locked);
  if (!H || !trail || trail.length < 2) return 0;

  const [nx1, ny1, nx2, ny2] = getRecentNetRegionSafe(H);

  // Use only the last N points, but densify to survive brief occlusion
  const tailRaw = trail.slice(-TUNABLES.TAIL);
  const tail    = densifyTrail(tailRaw);

  // 0) apex must clear rim a little
  const apexY        = Math.min(...tail.map(p => p.y));
  const apexAboveRim = apexY < (H.rimY - 6);

  // 1) hoop ellipse proximity
  const rx = (H.w/2) * (1 + TUNABLES.ELLIPSE_X);
  const ry = (H.h/2) * (1 + TUNABLES.ELLIPSE_Y);
  const inHoop = tail.some(p => {
    const dx = (p.x - H.cx)/rx, dy = (p.y - H.cy)/ry;
    return dx*dx + dy*dy <= 1;
  });

  // 2) center tube run after rim cross
  const tubeRun = tubeRunAfterCross(tail, H);
  const tubeOK  = tubeRun >= Math.max((window.__TEST_MODE ? 2 : 3), TUNABLES.TUBE_MIN_CONSEC);

  // 3) net line crossing near center
  const crossed = crossedNetLine(tail, H);

  // 4) net region presence
  const pad   = TUNABLES.NET_PAD;
  const inNet = tail.some(p => p.x >= (nx1 - pad) && p.x <= (nx2 + pad) &&
                               p.y >= (ny1 - pad) && p.y <= (ny2 + pad));

  // 5) thick center stripe (narrow)
  const thickCenter = thickTrailCenterHit(tail, { H, w: H.w * 0.92 });

  // ---- NEW: swirl + terminal finish checks ----
  const flips = swirlSignChanges(tail, H);                                  // left/right rattles
  const last  = tail.at(-1);
  const terminalBelow  = last.y >= (H.rimY + Math.max(36, H.h * 0.55));     // well below rim
  const terminalCenter = Math.abs(last.x - H.cx) <= Math.max(18, H.w * 0.45);

  // accumulate
  let s = 0;
  if (inHoop)       s += WEIGHTS.hoop;
  if (inNet)        s += WEIGHTS.net;
  if (tubeOK)       s += WEIGHTS.tubeHit;
  if (crossed)      s += 0.3;
  if (BS().netMoved) s += WEIGHTS.netMoved;
  if (thickCenter)  s += WEIGHTS.trailCenter;

  const centerPass   = tubeOK || thickCenter;
  const strongThrough= crossed && centerPass;

  // ---- gentle “made” floors for finish patterns ----
  // swirl & in net lane → trust make
  if (flips >= 2 && inNet) s = Math.max(s, 0.82);
  // ends clearly below rim & centered → trust make
  if (terminalBelow && terminalCenter) s = Math.max(s, 0.80);

  // hard gates (keep your existing behavior)
  if (!apexAboveRim) s = Math.min(s, 0.55);
  if (strongThrough) s = Math.max(s, 0.80);
  if (!centerPass)   s = Math.min(s, 0.60);
  if (!crossed)      s = Math.min(s, 0.60);

  return s;
}


// Use recent tail to look for "net evidence" (rim-line cross OR tube run)
function hasNetEvidence(trail, hoopBox) {
  const H = normHoopFlexible(normLockedHoop(hoopBox));
  if (!H || !Array.isArray(trail) || trail.length < 3) return false;

  const tailRaw = trail.slice(-Math.max(18, TUNABLES.TAIL)); // give it a little history
  const tail    = densifyTrail(tailRaw);

  const crossed = crossedNetLine(tail, H);
  const run     = tubeRunAfterCross(tail, H);
  const need    = window.__TEST_MODE ? Math.max(1, TUNABLES.TUBE_MIN_CONSEC - 2) : Math.max(2, TUNABLES.TUBE_MIN_CONSEC - 1);
  return crossed || (run >= need);
}


export function scoringTick(__frameIdx) {
  // If FBF is not active and we’re not in TRACKING or FROZEN finalize pass, do nothing
  if (!window.__fbf?.active) {
    const s = BS();
    const allowed = (s?.state === 'TRACKING') || (s?.state === 'FROZEN' && __frameIdx <= (window.__fbf?.stopFrame ?? __frameIdx));
    if (!allowed) return;
  }
  const hoopBox = getLockedHoopBox?.();
  if (!hoopBox) return;
  const s = BS();

  // fire release once when tracking begins (explicitly enabled only when POSE_FIRST_ONLY === false)
  if (s?.state === 'TRACKING' && s?.releaseFrame != null && !__releaseEventSent) {
    if (window.POSE_FIRST_ONLY === false) {
      __releaseEventSent = true;
      try { window.dispatchEvent(new CustomEvent('shot:release', { detail: { frame: s.releaseFrame, via: 'shot_logger:mirror' } })); } catch {}
    }
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
// FBF window state (read-only for other modules)
window.__fbf = { active: false, startFrame: -1, stopFrame: -1 };

function startFBFAt(frame, stopFrameGuess = -1) {
  window.__fbf.active     = true;
  window.__fbf.startFrame = frame;
  window.__fbf.stopFrame  = stopFrameGuess; // can be filled on prox exit
}

function stopFBFAt(frame) {
  window.__fbf.active     = false;
  window.__fbf.stopFrame  = frame;
}


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
      <th>Apex Rise</th>
      <th>Entry</th>
      <th>Release</th>
      <th>Reason</th>
      <th>Coach</th>
    </tr>`;

  shotLog.forEach((shot, i) => {
    const row = document.createElement('tr');
    const esc = s => String(s||'').replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
    const arcLabel = arcHeightLabel(shot);
    row.innerHTML = `
      <td>${i + 1}</td>
      <td>${shot.made ? '✅' : '❌'}</td>
      <td>${arcLabel}</td>
      <td>${shot.apexRiseFromRelease!=null?Math.round(shot.apexRiseFromRelease):'–'}px${shot.apexRiseFromReleaseNorm!=null?` (${shot.apexRiseFromReleaseNorm}×h)`:''}</td>
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
    Arc: ${arcHeightLabel(last)}<br>
    Apex Rise: ${last.apexRiseFromRelease!=null?last.apexRiseFromRelease:'–'}px${last.apexRiseFromReleaseNorm!=null?` (${last.apexRiseFromReleaseNorm}×h)`:''}<br>
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
  window.__lastAnnouncedShotId = 0;

  const tbody = document.querySelector("#shotTable tbody");
  if (tbody) tbody.innerHTML = "";

  const details = document.getElementById("shotDetails");
  if (details) details.innerHTML = "No shot data loaded.";

  if (window.madeShotSound) window.madeShotSound.pause();
  if (window.missedShotSound) window.missedShotSound.pause();
}

// prevent duplicate shots in the same trail window
// add to shot logging trigger
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

// prevent duplicate shot logging (low-latency, hash-first)
let lastTrailHash   = null;
let lastLoggedFrame = -1;
let lastShotEndTime = 0;

// tunables; you can tweak live from the console
const SHOT_GAP_MS     = Number(window.SHOT_GAP_MS     ?? 350); // was 1500
const SHOT_GAP_FRAMES = Number(window.SHOT_GAP_FRAMES ?? 4);   // was 10

export function shouldLogShot(trail, __frameIdx) {
  const hash = trailHash(trail);
  const now  = Date.now();

  // same trail → duplicate
  if (hash && hash === lastTrailHash) return false;

  // guard true double-fires within the exact same frame window
  if (__frameIdx <= lastLoggedFrame && (now - lastShotEndTime) < 120) return false;

  lastTrailHash   = hash;
  lastLoggedFrame = __frameIdx;
  lastShotEndTime = now;
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


