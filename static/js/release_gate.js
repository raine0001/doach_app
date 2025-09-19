// release_gate.js — Single source of truth for release posture math and knobs

// Public: init once to set defaults and probe mode based on URL
export function initReleaseConfig() {
  try {
    const qs = new URLSearchParams(location.search || '');
    if (qs.has('releaseOnly')) {
      const v = String(qs.get('releaseOnly')).trim();
      window.__RELEASE_ONLY = v === '' || v === '1' || v.toLowerCase() === 'true';
    }
  } catch {}
  const IN_PROBE = (window.__RELEASE_ONLY === true);
  const cfg = Object.assign({
    yTol:            IN_PROBE ? 10  : 14,   // px (wrist above elbow)
    shYTol:          IN_PROBE ? 8   : 10,   // px (wrist above shoulder)
    elbowExtMin:     IN_PROBE ? 130 : 145,  // deg (counts in posture)
    elbowStrictMin:  IN_PROBE ? 120 : 135,  // deg (strict latch rule)
    dxMax:           IN_PROBE ? 105 : 60,   // px (vertical-ish)
    dyMin:           IN_PROBE ? 12  : 18,   // px (vertical-ish)
    extMargin:       10,                    // px (extension margin)
    upDy:            IN_PROBE ? 4   : 6,    // px (uptrend per sample)
    // Using 0.26 per-component weights yields ~1.04 when all four are satisfied
    scoreThresh:      .99,                 // require all-four by default
    hudScoreTrip:    0.78,                 // HUD pulse/log threshold (diagnostic/UI only)
    streakNeed:      IN_PROBE ? 1   : 2,
    cooldownMs:      1100,
  }, (window.REL_CFG || {}));
  // Leave HUD trip independent; callers may set equal at runtime via setReleaseKnobs

  // persist on window for consumers that read globals
  window.REL_CFG = cfg;
  window.REL_Y_TOL = cfg.yTol;
  window.REL_SH_Y_TOL = cfg.shYTol;
  window.REL_ELBOW_EXT_MIN = cfg.elbowExtMin;
  window.REL_ELBOW_STRICT_MIN = cfg.elbowStrictMin;
  window.REL_DX_MAX = cfg.dxMax;
  window.REL_DY_MIN = cfg.dyMin;
  window.REL_EXT_MARGIN = cfg.extMargin;
  window.REL_UP_DY = cfg.upDy;
  window.REL_SCORE_THRESH = cfg.scoreThresh;
  try { window.REL_HUD_SCORE_TRIP = cfg.hudScoreTrip; } catch {}
  window.HEUR_STREAK_NEED = cfg.streakNeed;
  window.REL_COOLDOWN_MS  = cfg.cooldownMs;
  window.scoreThresh = cfg.scoreThresh; // legacy alias
  // Pose-first + defer FE summary defaults for live reliability
  try {
    if (typeof window.POSE_FIRST_ONLY === 'undefined') window.POSE_FIRST_ONLY = true;
    if (typeof window.DEFER_FE_SUMMARY === 'undefined') window.DEFER_FE_SUMMARY = true;
    if (typeof window.USE_FBF_DURING_SHOT === 'undefined') window.USE_FBF_DURING_SHOT = false;
  } catch {}
  
  // Prefer low-latency pose in probe
  try { if (IN_PROBE && !window.POSE_MODEL) window.POSE_MODEL = 'lite'; } catch {}
}

try { initReleaseConfig?.(); } catch {}
try { window.SESSION_MANAGER_OWNS_ENDING = true; } catch {}
try { window.DEFER_FE_SUMMARY = false; } catch {}


export function getReleaseKnobs(){ return { ...(window.REL_CFG || {}) }; }
export function setReleaseKnobs(patch){
  const cur = window.REL_CFG || {};
  const next = { ...cur, ...(patch||{}) };
  window.REL_CFG = next;
  // mirror to globals for legacy readers
  window.REL_Y_TOL = next.yTol;
  window.REL_SH_Y_TOL = next.shYTol;
  window.REL_ELBOW_EXT_MIN = next.elbowExtMin;
  window.REL_ELBOW_STRICT_MIN = next.elbowStrictMin;
  window.REL_DX_MAX = next.dxMax;
  window.REL_DY_MIN = next.dyMin;
  window.REL_EXT_MARGIN = next.extMargin;
  window.REL_UP_DY = next.upDy;
  window.REL_SCORE_THRESH = next.scoreThresh;
  window.HEUR_STREAK_NEED = next.streakNeed;
  window.REL_COOLDOWN_MS  = next.cooldownMs;
  return next;
}

// Pure evaluator: returns { released, passed, tests, reason }
export function releaseGate(lastFrames) {
  // Pose warmup: require a few stable frames before allowing any release
  try {
    const hist = Array.isArray(lastFrames) ? lastFrames.slice(-8) : [];
    // If caller passed too few frames, fall back to playerState history
    const frames = (hist.length >= 3) ? hist : ((window.playerState?.frameHistory || []).slice(-8));
    let okCount = 0;
    if (Array.isArray(frames) && frames.length) {
      for (const f of frames) {
        const kps = f?.keypoints || [];
        if (Array.isArray(kps) && kps.length >= 33) okCount++;
      }
    }
    // Warmup deemed OK if ≥5 of the last 8 frames have 33 keypoints
    const warmOK = okCount >= 5;
    if (warmOK) { try { window.__POSE_WARMUP_OK = true; } catch {} }
    const armed = (window.__shotTrackingArmed === true);
    // Gate: do not allow any release until warmup is satisfied AND session is armed
    if (!(warmOK && armed)) return { released:false, passed:0, tests:{}, reason: (armed ? 'pose-warmup' : 'not-armed') };
  } catch {}
  function evalSide(side, hist) {
    const right = (side === 'R');
    const S = right ? 12 : 11; // SHOULDER (R=12, L=11)
    const E = right ? 14 : 13; // ELBOW    (R=14, L=13)
    const W = right ? 16 : 15; // WRIST    (R=16, L=15)
    let cur = hist.at(-1)?.keypoints || [];
    let sh = cur[S], el = cur[E], wr = cur[W];
    // Fallback to current playerState keypoints when history frame is sparse
    if (!sh || !el || !wr) {
      try {
        const kps = (window.playerState && Array.isArray(window.playerState.keypoints) && window.playerState.keypoints.length >= 33)
          ? window.playerState.keypoints : null;
        if (kps) { cur = kps; sh = cur[S]; el = cur[E]; wr = cur[W]; }
      } catch {}
    }
    if (!sh || !el || !wr) return { released:false, passed:0, tests:{side}, reason:'missing-joints' };
    const c = window.REL_CFG || {};
    const yTol = Number(c.yTol ?? window.REL_Y_TOL ?? 12);
    const ySh  = Number(c.shYTol ?? window.REL_SH_Y_TOL ?? 8);
    const wristAboveElbow    = Number.isFinite(wr.y) && Number.isFinite(el.y) ? (wr.y < (el.y - yTol)) : false;
    const wristAboveShoulder = Number.isFinite(wr.y) && Number.isFinite(sh.y) ? (wr.y < (sh.y - ySh)) : false;
    const elbowAtOrAboveShoulder = Number.isFinite(el.y) && Number.isFinite(sh.y) ? (el.y <= (sh.y + Math.max(0, ySh - 2))) : false;
    let elbowAngleDeg = 0, elbowExtended = false;
    try {
      const v1x = sh.x - el.x, v1y = sh.y - el.y;
      const v2x = wr.x - el.x, v2y = wr.y - el.y;
      const dot = (v1x*v2x + v1y*v2y);
      const den = (Math.hypot(v1x,v1y)*Math.hypot(v2x,v2y) + 1e-6);
      const a = Math.acos(Math.max(-1, Math.min(1, dot/den))) * 180 / Math.PI;
      // Elbow angle at the joint (0..180). 180° = fully straight.
      elbowAngleDeg = a;
      const th = Number(c.elbowExtMin ?? window.REL_ELBOW_EXT_MIN ?? 155);
      elbowExtended = elbowAngleDeg >= th;
    } catch {}
    const dx = Math.abs((wr.x ?? 0) - (sh.x ?? 0));
    const dy = Math.abs((sh.y ?? 0) - (wr.y ?? 0));
    const nearlyVertical = (dx < Number(c.dxMax ?? window.REL_DX_MAX ?? 90)) && (dy > Number(c.dyMin ?? window.REL_DY_MIN ?? 18));
    const dSE = Math.hypot((el.x ?? 0) - (sh.x ?? 0), (el.y ?? 0) - (sh.y ?? 0));
    const dSW = Math.hypot((wr.x ?? 0) - (sh.x ?? 0), (wr.y ?? 0) - (sh.y ?? 0));
    const armExtended = dSW > (dSE + Number(c.extMargin ?? window.REL_EXT_MARGIN ?? 10));
    const alignOK = nearlyVertical || armExtended;
    // Uptrend
    let wristUpTrend = false;
    try {
      const h = Array.isArray(hist) ? hist.slice(-3) : [];
      if (h.length >= 2) {
        const wy1 = h[h.length-2]?.keypoints?.[W]?.y;
        const wy2 = h[h.length-1]?.keypoints?.[W]?.y;
        if (Number.isFinite(wy1) && Number.isFinite(wy2)) wristUpTrend = (wy2 < (wy1 - Number(c.upDy ?? window.REL_UP_DY ?? 6)));
        if (!wristUpTrend && h.length >= 3) {
          const wy0 = h[h.length-3]?.keypoints?.[W]?.y;
          if (Number.isFinite(wy0) && Number.isFinite(wy1)) {
            const d = Number(c.upDy ?? window.REL_UP_DY ?? 6);
            wristUpTrend = (wy2 < (wy1 - d)) && (wy1 < (wy0 - d));
          }
        }
      }
    } catch {}
    // Score — choose the 4th component: uptrend (opt-in) or shoulder-above (default)
    let score = 0;
    try {
      const useUp = (window.REL_SCORE_USE_UPTREND === true); // default false → use shoulder for stability
      const norm = (x, d) => { const n = Number(x); return (Number.isFinite(n) && n >= 0) ? n : d; };
      const cfgW = (window.REL_CFG && window.REL_CFG.weights) || {};
      // Align weights with HUD-local math (0.26 each by default)
      const wA = norm((cfgW.wrist ?? window.REL_W_WRIST ?? window.REL_W_A), 0.26);
      const wB = norm((cfgW.elbow ?? window.REL_W_ELBOW ?? window.REL_W_B), 0.26);
      const wC = norm((cfgW.align ?? window.REL_W_ALIGN ?? window.REL_W_C), 0.26);
      const wDsrc = useUp
        ? (cfgW.uptrend ?? window.REL_W_UPTREND ?? window.REL_W_D)
        : (cfgW.shoulder ?? window.REL_W_SHOULDER ?? window.REL_W_D);
      const wD = norm(wDsrc, 0.26);
      if (wristAboveElbow) score += wA;                    // A: wrist > elbow
      if (elbowExtended)   score += wB;                    // B: elbow straight
      if (alignOK)         score += wC;                    // C: vertical-ish/extended
      if (useUp ? wristUpTrend : wristAboveShoulder) score += wD; // D: default shoulder above (stable)
      if (!Number.isFinite(score)) score = 0; // guard against NaN from bad weights
    } catch { score = 0; }
    // All-four parity with HUD: sum of weights when all booleans are true
    const tot = (() => {
      try {
        const useUp = (window.REL_SCORE_USE_UPTREND === true);
        const cfgW = (window.REL_CFG && window.REL_CFG.weights) || {};
        const norm = (x, d) => { const n = Number(x); return (Number.isFinite(n) && n >= 0) ? n : d; };
        const wA = norm((cfgW.wrist ?? window.REL_W_WRIST ?? window.REL_W_A), 0.26);
        const wB = norm((cfgW.elbow ?? window.REL_W_ELBOW ?? window.REL_W_B), 0.26);
        const wC = norm((cfgW.align ?? window.REL_W_ALIGN ?? window.REL_W_C), 0.26);
        const wDsrc = useUp
          ? (cfgW.uptrend ?? window.REL_W_UPTREND ?? window.REL_W_D)
          : (cfgW.shoulder ?? window.REL_W_SHOULDER ?? window.REL_W_D);
        const wD = norm(wDsrc, 0.26);
        return wA + wB + wC + wD;
      } catch { return 1.04; }
    })();
    const posturePassed = [wristAboveShoulder, elbowExtended, alignOK].filter(Boolean).length;
    // Single source of truth: require "all four" by default (score within epsilon of sum of weights)
    const allFour = score >= (tot - 1e-6);
    const scoreOK = allFour || (score >= Number(c.scoreThresh));
    const strictOK  = (elbowAngleDeg >= Number(c.elbowStrictMin)) && wristAboveShoulder;
    const inProbe   = (window.__RELEASE_ONLY === true);
    // In normal mode, require all-four; in probe, allow strict or all-four
    const okNow     = inProbe ? (allFour || strictOK) : allFour;
    const tests = { side, wristAboveElbow, wristAboveShoulder, elbowAtOrAboveShoulder, elbowExtended, alignOK, wristUpTrend, elbowAngleDeg: Math.round(elbowAngleDeg), dx: Math.round(dx), dy: Math.round(dy), dSW: Math.round(dSW), dSE: Math.round(dSE), score: Number(score.toFixed?.(3) || score), tot: Number(tot.toFixed?.(3) || tot), strictOK };
    const reason = okNow ? (allFour ? 'all-four' : 'strict') : 'not-enough';
    return { released: okNow, passed: posturePassed, tests, reason };
  }
  try {
    const useUp = (window.REL_SCORE_USE_UPTREND === true);
    const needLen = useUp ? 2 : 1; // if not using uptrend, one frame is enough
    const hist = Array.isArray(lastFrames) ? lastFrames.slice(-5) : [];
    if (hist.length < needLen) return { released:false, passed:0, tests:{}, reason:'insufficient-history' };
    const r = evalSide('R', hist);
    const l = evalSide('L', hist);
    let best = r;
    if (l.released && !r.released) best = l;
    else if (l.passed > r.passed) best = l;
    else if ((l.tests?.score || 0) > (r.tests?.score || 0)) best = l;
    return best;
  } catch (e) {
    return { released:false, passed:0, tests:{}, reason:'error' };
  }
}

// Optional console helpers
export function printPoseGate() {
  try {
    const hist = (window.playerState?.frameHistory || []).slice(-5);
    const g = releaseGate(hist);
    const f = hist.at(-1)?.frame ?? null;
    console.log('[pose:gate]', { frame: f, ...g.tests, passed: g.passed, reason: g.reason, released: g.released });
    return g;
  } catch (e) { console.warn('printPoseGate failed', e); return null; }
}
export function printLastRelease() {
  try {
    const fps = Number(window.__videoFPS) || 30;
    const f = Number.isFinite(window.ballState?.releaseFrame) ? window.ballState.releaseFrame : (window.__GATE_LATCH_FRAME ?? null);
    if (Number.isFinite(f)) {
      const t = (f / fps).toFixed(3);
      console.log('[release:last]', { frame: f, time_s: Number(t) });
      return { frame: f, time_s: Number(t) };
    }
    console.log('[release:last] none');
    return null;
  } catch (e) { console.warn('printLastRelease failed', e); return null; }
}

// Expose simple knobs for runtime tweaking from console
try {
  if (!window.getReleaseKnobs) window.getReleaseKnobs = getReleaseKnobs;
  if (!window.setReleaseKnobs) window.setReleaseKnobs = setReleaseKnobs;
  if (!window.printPoseGate)   window.printPoseGate   = printPoseGate;
  if (!window.printLastRelease)window.printLastRelease= printLastRelease;
  // Make evaluator + init available to non-ESM callers
  if (typeof window.releaseGate !== 'function') window.releaseGate = releaseGate;
  if (typeof window.initReleaseConfig !== 'function') window.initReleaseConfig = initReleaseConfig;
} catch {}

try {
  initReleaseConfig();
} catch {}
try {
  const base = getReleaseKnobs();
  const trip = Number(base.scoreThresh);
  if (Number.isFinite(trip)) setReleaseKnobs({ hudScoreTrip: trip });  // e.g., both ~1.0
} catch {}

