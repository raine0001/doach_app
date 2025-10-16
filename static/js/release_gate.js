// release_gate.js — consolidated release posture, kinematic scoring, and diagnostics

const DEFAULT_FEATURE_WEIGHTS = {
  wristRadial: 0.24,
  elbowRate:   0.22,
  armAlign:    0.20,
  palmFlip:    0.17,
  handOpen:    0.17,
};

function mirrorGlobals(cfg) {
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
  window.HEUR_STREAK_NEED = cfg.streakNeed;
  window.REL_COOLDOWN_MS = cfg.cooldownMs;
  try { window.REL_HUD_SCORE_TRIP = cfg.hudScoreTrip; } catch {}
  try { window.scoreThresh = cfg.scoreThresh; } catch {}
}

export function initReleaseConfig() {
  try {
    const qs = new URLSearchParams(location.search || '');
    if (qs.has('releaseOnly')) {
      const v = String(qs.get('releaseOnly')).trim();
      window.__RELEASE_ONLY = v === '' || v === '1' || v.toLowerCase() === 'true';
    }
  } catch {}

  const IN_PROBE = (window.__RELEASE_ONLY === true);
  const current = window.REL_CFG || {};
  const defaults = {
    yTol:            IN_PROBE ? 10  : 14,
    shYTol:          IN_PROBE ? 8   : 10,
    elbowExtMin:     IN_PROBE ? 130 : 145,
    elbowStrictMin:  IN_PROBE ? 120 : 135,
    dxMax:           IN_PROBE ? 105 : 60,
    dyMin:           IN_PROBE ? 12  : 18,
    extMargin:       10,
    upDy:            IN_PROBE ? 4   : 6,
    scoreThresh:     0.99,
    hudScoreTrip:    0.78,
    streakNeed:      IN_PROBE ? 1   : 2,
    cooldownMs:      1100,
    wristRadialMin:  0.22,
    elbowRateMin:    140,
    armAlignMax:     18,
    palmFlipMin:     25,
    handOpenMin:     12,
    plumeSigmaMin:   0.75,
    wristJerkMin:    0.18,
    followthroughDropMin: 0.35,
    secondaryNeed:   2,
    featureWeights:  DEFAULT_FEATURE_WEIGHTS,
  };

  const merged = {
    ...defaults,
    ...current,
    featureWeights: {
      ...DEFAULT_FEATURE_WEIGHTS,
      ...(current.featureWeights || {}),
    },
  };

  mirrorGlobals(merged);

  try {
    if (typeof window.POSE_FIRST_ONLY === 'undefined') window.POSE_FIRST_ONLY = true;
    if (typeof window.DEFER_FE_SUMMARY === 'undefined') window.DEFER_FE_SUMMARY = true;
    if (typeof window.USE_FBF_DURING_SHOT === 'undefined') window.USE_FBF_DURING_SHOT = false;
  } catch {}

  return merged;
}

export function getReleaseKnobs() {
  return { ...(window.REL_CFG || initReleaseConfig()) };
}

export function setReleaseKnobs(patch) {
  const cur = window.REL_CFG || initReleaseConfig();
  const next = {
    ...cur,
    ...(patch || {}),
    featureWeights: {
      ...cur.featureWeights,
      ...(patch?.featureWeights || {}),
    },
  };
  mirrorGlobals(next);
  return next;
}

function getPoint(frame, idx) {
  if (!frame || !Array.isArray(frame.keypoints)) return null;
  const pt = frame.keypoints[idx];
  if (!pt) return null;
  const { x, y, visibility } = pt;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y, visibility: Number(visibility ?? 0) };
}

function angleDeg(a, b, c) {
  if (!a || !b || !c) return 0;
  const v1x = a.x - b.x;
  const v1y = a.y - b.y;
  const v2x = c.x - b.x;
  const v2y = c.y - b.y;
  const denom = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y) + 1e-9;
  const dot = (v1x * v2x + v1y * v2y) / denom;
  const clamped = Math.max(-1, Math.min(1, dot));
  return Math.max(0, Math.min(180, Math.acos(clamped) * 180 / Math.PI));
}

function getRimCenter() {
  try {
    const hoop = (typeof window.getLockedHoopBox === 'function')
      ? window.getLockedHoopBox()
      : (window.__lockedHoopBox || null);
    if (!hoop) return null;
    const cx = Number.isFinite(hoop.cx) ? hoop.cx
      : (Number.isFinite(hoop.x) && Number.isFinite(hoop.w)) ? hoop.x + hoop.w / 2 : null;
    const cy = Number.isFinite(hoop.cy) ? hoop.cy
      : (Number.isFinite(hoop.y) && Number.isFinite(hoop.h)) ? hoop.y + hoop.h / 2 : null;
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null;
    return { x: cx, y: cy };
  } catch {
    return null;
  }
}

function normalizeWeights(weights = {}) {
  return {
    wristRadial: Number.isFinite(weights.wristRadial) ? weights.wristRadial : DEFAULT_FEATURE_WEIGHTS.wristRadial,
    elbowRate:   Number.isFinite(weights.elbowRate)   ? weights.elbowRate   : DEFAULT_FEATURE_WEIGHTS.elbowRate,
    armAlign:    Number.isFinite(weights.armAlign)    ? weights.armAlign    : DEFAULT_FEATURE_WEIGHTS.armAlign,
    palmFlip:    Number.isFinite(weights.palmFlip)    ? weights.palmFlip    : DEFAULT_FEATURE_WEIGHTS.palmFlip,
    handOpen:    Number.isFinite(weights.handOpen)    ? weights.handOpen    : DEFAULT_FEATURE_WEIGHTS.handOpen,
  };
}

function evaluateSide(frames, side, cfg, rim) {
  const map = side === 'L'
    ? { sh: 11, el: 13, wr: 15, thumb: 19, index: 18, pinky: 17 }
    : { sh: 12, el: 14, wr: 16, thumb: 22, index: 21, pinky: 20 };

  const fps = Number(window.__videoFPS) || 30;
  const yTol = Number(cfg.yTol ?? 12);
  const ySh  = Number(cfg.shYTol ?? 8);
  const elbowMin = Number(cfg.elbowExtMin ?? 145);
  const elbowStrictMin = Number(cfg.elbowStrictMin ?? 135);
  const dxMax = Number(cfg.dxMax ?? 60);
  const dyMin = Number(cfg.dyMin ?? 18);
  const extMargin = Number(cfg.extMargin ?? 10);
  const upDy = Number(cfg.upDy ?? 6);
  const weights = normalizeWeights(cfg.featureWeights);
  const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);

  const temporal = frames.map((frame, idx) => {
    const sh = getPoint(frame, map.sh);
    const el = getPoint(frame, map.el);
    const wr = getPoint(frame, map.wr);
    const thumb = getPoint(frame, map.thumb);
    const index = getPoint(frame, map.index);
    const pinky = getPoint(frame, map.pinky);
    return {
      frame,
      sh, el, wr, thumb, index, pinky,
      elbowAngle: angleDeg(sh, el, wr),
      frameNum: Number(frame?.frame ?? frame?.f ?? idx),
      timeSec: Number.isFinite(frame?.tMs) ? Number(frame.tMs) / 1000
               : Number.isFinite(frame?.ts) ? Number(frame.ts)
               : Number(frame?.time ?? idx / fps),
    };
  });
  const last = temporal.at(-1);
  if (!last?.sh || !last?.el || !last?.wr) {
    return { released:false, score:0, tests:{ side }, reason:'missing-joints', features:{} };
  }

  const wristAboveElbow = Number.isFinite(last.wr.y) && Number.isFinite(last.el.y) ? (last.wr.y < (last.el.y - yTol)) : false;
  const wristAboveShoulder = Number.isFinite(last.wr.y) && Number.isFinite(last.sh.y) ? (last.wr.y < (last.sh.y - ySh)) : false;
  const elbowAtOrAboveShoulder = Number.isFinite(last.el.y) && Number.isFinite(last.sh.y) ? (last.el.y <= (last.sh.y + Math.max(0, ySh - 2))) : false;
  const dx = Math.abs((last.wr.x ?? 0) - (last.sh.x ?? 0));
  const dy = Math.abs((last.sh.y ?? 0) - (last.wr.y ?? 0));
  const nearlyVertical = (dx < dxMax) && (dy > dyMin);
  const dSE = Math.hypot((last.el.x ?? 0) - (last.sh.x ?? 0), (last.el.y ?? 0) - (last.sh.y ?? 0));
  const dSW = Math.hypot((last.wr.x ?? 0) - (last.sh.x ?? 0), (last.wr.y ?? 0) - (last.sh.y ?? 0));
  const armExtended = dSW > (dSE + extMargin);
  const alignOK = nearlyVertical || armExtended;
  const elbowExtended = last.elbowAngle >= elbowMin;

  let wristUpTrend = false;
  try {
    const sample = temporal.slice(-3);
    if (sample.length >= 2) {
      const wy1 = sample.at(-2)?.wr?.y;
      const wy2 = sample.at(-1)?.wr?.y;
      if (Number.isFinite(wy1) && Number.isFinite(wy2)) {
        wristUpTrend = wy2 < (wy1 - upDy);
      }
      if (!wristUpTrend && sample.length >= 3) {
        const wy0 = sample.at(-3)?.wr?.y;
        if (Number.isFinite(wy0) && Number.isFinite(wy1)) {
          wristUpTrend = (wy2 < (wy1 - upDy)) && (wy1 < (wy0 - upDy));
        }
      }
    }
  } catch {}

  const velocities = [];
  const elbowRates = [];
  const palmAngles = [];
  const palmSpreads = [];
  for (let i = 1; i < temporal.length; i += 1) {
    const prev = temporal[i - 1];
    const curr = temporal[i];
    if (!prev.wr || !curr.wr) continue;
    const dt = Math.max(0.001, Math.abs((curr.timeSec ?? (curr.frameNum / fps)) - (prev.timeSec ?? (prev.frameNum / fps))));
    const vx = (curr.wr.x - prev.wr.x) / dt;
    const vy = (curr.wr.y - prev.wr.y) / dt;
    const speed = Math.hypot(vx, vy);
    let radial = speed;
    if (rim) {
      const dirx = rim.x - curr.wr.x;
      const diry = rim.y - curr.wr.y;
      const mag = Math.hypot(dirx, diry) || 1;
      radial = (-(vx * dirx + vy * diry)) / mag;
    }
    velocities.push({ vx, vy, speed, radial, dt });
    if (Number.isFinite(prev.elbowAngle) && Number.isFinite(curr.elbowAngle)) {
      elbowRates.push(Math.abs(curr.elbowAngle - prev.elbowAngle) / dt);
    }
    if (curr.index && curr.pinky) {
      palmSpreads.push(Math.hypot(curr.index.x - curr.pinky.x, curr.index.y - curr.pinky.y));
    }
    if (curr.index && curr.thumb && curr.wr) {
      const icx = curr.index.x - curr.wr.x;
      const icy = curr.index.y - curr.wr.y;
      palmAngles.push(Math.atan2(icy, icx) * 180 / Math.PI);
    }
  }

  const wristRadialPeak = velocities.reduce((max, v) => Math.max(max, v.radial || 0), 0);
  const wristSpeedPeak = velocities.reduce((max, v) => Math.max(max, v.speed || 0), 0);
  const elbowRatePeak = elbowRates.reduce((max, v) => Math.max(max, v || 0), 0);

  const alignAngles = temporal
    .filter(f => f.el && f.wr && rim)
    .map(f => {
      const fx = f.wr.x - f.el.x;
      const fy = f.wr.y - f.el.y;
      const rx = rim.x - f.wr.x;
      const ry = rim.y - f.wr.y;
      const denom = Math.hypot(fx, fy) * Math.hypot(rx, ry) + 1e-9;
      const dot = (fx * rx + fy * ry) / denom;
      const clamped = Math.max(-1, Math.min(1, dot));
      return Math.acos(clamped) * 180 / Math.PI;
    });
  const armAlignMin = alignAngles.length ? Math.min(...alignAngles) : 180;

  let palmFlipPeak = 0;
  if (palmAngles.length >= 2) {
    for (let i = 1; i < palmAngles.length; i += 1) {
      palmFlipPeak = Math.max(palmFlipPeak, Math.abs(palmAngles[i] - palmAngles[i - 1]));
    }
  }
  let handOpenDelta = 0;
  if (palmSpreads.length >= 2) {
    const minSpread = Math.min(...palmSpreads);
    const maxSpread = Math.max(...palmSpreads);
    handOpenDelta = Math.max(0, maxSpread - minSpread);
  }

  const flow = (typeof window.opticalFlowPlume === 'function')
    ? window.opticalFlowPlume({ history: frames, side })
    : { sigma: 0, forward: 0, samples: 0, ok: false };

  const jerkValues = [];
  for (let i = 2; i < velocities.length; i += 1) {
    const v0 = velocities[i - 2];
    const v1 = velocities[i - 1];
    const v2 = velocities[i];
    const dt1 = Math.max(0.001, v1.dt);
    const dt2 = Math.max(0.001, v2.dt);
    const ax = (v1.vx - v0.vx) / dt1;
    const ay = (v1.vy - v0.vy) / dt1;
    const bx = (v2.vx - v1.vx) / dt2;
    const by = (v2.vy - v1.vy) / dt2;
    const jx = (bx - ax) / Math.max(0.001, (dt1 + dt2) / 2);
    const jy = (by - ay) / Math.max(0.001, (dt1 + dt2) / 2);
    jerkValues.push(Math.hypot(jx, jy));
  }
  const wristJerkPeak = jerkValues.reduce((max, v) => Math.max(max, v || 0), 0);
  const speeds = velocities.map(v => v.speed || 0);
  const peakSpeed = speeds.reduce((max, v) => Math.max(max, v), 0);
  const lastSpeed = speeds.length ? speeds[speeds.length - 1] : 0;
  const followthroughDrop = peakSpeed > 0 ? Math.max(0, (peakSpeed - lastSpeed) / peakSpeed) : 0;

  const primaryFlags = {
    WRIST_RADIAL_OK: wristRadialPeak >= Number(cfg.wristRadialMin ?? 0.22),
    ELBOW_RATE_OK:   elbowRatePeak >= Number(cfg.elbowRateMin ?? 140),
    ARM_ALIGN_OK:    armAlignMin <= Number(cfg.armAlignMax ?? 18),
    PALM_FLIP_OK:    palmFlipPeak >= Number(cfg.palmFlipMin ?? 25),
    HAND_OPEN_OK:    handOpenDelta >= Number(cfg.handOpenMin ?? 12),
  };
  const secondaryFlags = {
    FLOW_PLUME_OK: flow?.sigma >= Number(cfg.plumeSigmaMin ?? 0.75),
    WRIST_JERK_OK: wristJerkPeak >= Number(cfg.wristJerkMin ?? 0.18),
    FOLLOWTHROUGH_DECEL_OK: followthroughDrop >= Number(cfg.followthroughDropMin ?? 0.35),
  };

  const score = [
    primaryFlags.WRIST_RADIAL_OK ? weights.wristRadial : 0,
    primaryFlags.ELBOW_RATE_OK   ? weights.elbowRate   : 0,
    primaryFlags.ARM_ALIGN_OK    ? weights.armAlign    : 0,
    primaryFlags.PALM_FLIP_OK    ? weights.palmFlip    : 0,
    primaryFlags.HAND_OPEN_OK    ? weights.handOpen    : 0,
  ].reduce((a, b) => a + b, 0);

  const basePosturePassed = [
    wristAboveShoulder,
    elbowExtended,
    alignOK,
    wristAboveElbow,
  ].filter(Boolean).length;
  const scoreOk = score >= Number(cfg.scoreThresh ?? totalWeight);
  const secondaryPassCount = Object.values(secondaryFlags).filter(Boolean).length;
  const secondaryNeed = Math.max(1, Number(cfg.secondaryNeed ?? 2));
  const strictOK = last.elbowAngle >= elbowStrictMin && wristAboveShoulder;

  const primaryFailReason = [
    { ok: primaryFlags.WRIST_RADIAL_OK, reason: 'LOW_WRIST_RADIAL_SPEED' },
    { ok: primaryFlags.ELBOW_RATE_OK, reason: 'ELBOW_RATE_TOO_LOW' },
    { ok: primaryFlags.ARM_ALIGN_OK, reason: 'ARM_NOT_ALIGNED' },
    { ok: primaryFlags.PALM_FLIP_OK, reason: 'PALM_FLIP_TOO_LOW' },
    { ok: primaryFlags.HAND_OPEN_OK, reason: 'NO_HAND_OPENING' },
  ].find(entry => !entry.ok)?.reason;

  const secondaryFailReason = [
    { ok: secondaryFlags.FLOW_PLUME_OK, reason: 'NO_FLOW_PLUME' },
    { ok: secondaryFlags.WRIST_JERK_OK, reason: 'WRIST_JERK_TOO_LOW' },
    { ok: secondaryFlags.FOLLOWTHROUGH_DECEL_OK, reason: 'NO_FOLLOWTHROUGH_DECEL' },
  ].find(entry => !entry.ok)?.reason;

  const features = {
    wristRadialPeak,
    wristSpeedPeak,
    elbowRatePeak,
    armAlignMin,
    palmFlipPeak,
    handOpenDelta,
    flowSigma: flow?.sigma ?? 0,
    flowForward: flow?.forward ?? 0,
    wristJerkPeak,
    followthroughDrop,
    secondaryPassCount,
  };

  const tests = {
    side,
    wristAboveElbow,
    wristAboveShoulder,
    elbowAtOrAboveShoulder,
    elbowExtended,
    alignOK,
    wristUpTrend,
    elbowAngleDeg: Math.round(last.elbowAngle),
    dx: Math.round(dx),
    dy: Math.round(dy),
    dSW: Math.round(dSW),
    dSE: Math.round(dSE),
    score: Number(score.toFixed(3)),
    tot: Number(totalWeight.toFixed(3)),
    strictOK,
    passed: basePosturePassed,
    WRIST_RADIAL_OK: primaryFlags.WRIST_RADIAL_OK,
    ELBOW_RATE_OK: primaryFlags.ELBOW_RATE_OK,
    ARM_ALIGN_OK: primaryFlags.ARM_ALIGN_OK,
    PALM_FLIP_OK: primaryFlags.PALM_FLIP_OK,
    HAND_OPEN_OK: primaryFlags.HAND_OPEN_OK,
    FLOW_PLUME_OK: secondaryFlags.FLOW_PLUME_OK,
    WRIST_JERK_OK: secondaryFlags.WRIST_JERK_OK,
    FOLLOWTHROUGH_DECEL_OK: secondaryFlags.FOLLOWTHROUGH_DECEL_OK,
    secondaryPassed: secondaryPassCount,
    secondaryNeed,
  };

  const released = scoreOk && secondaryPassCount >= secondaryNeed && basePosturePassed >= 3;
  let reason = released ? 'all-good'
    : primaryFailReason || (secondaryPassCount < secondaryNeed ? secondaryFailReason : 'not-enough');
  if (!reason) reason = 'not-enough';

  return {
    released,
    score,
    strictOK,
    tests,
    reason,
    features,
  };
}

export function releaseGate(lastFrames) {
  const cfg = window.REL_CFG || initReleaseConfig();
  const frames = Array.isArray(lastFrames) ? lastFrames.slice(-6) : [];
  const fallbacks = (window.playerState?.frameHistory || []).slice(-6);
  const hist = frames.length ? frames : fallbacks;
  if (hist.length < 2) return { released:false, passed:0, tests:{}, reason:'insufficient-history' };

  const rim = getRimCenter();
  const right = evaluateSide(hist, 'R', cfg, rim);
  const left = evaluateSide(hist, 'L', cfg, rim);

  const candidate = (() => {
    if (right.released && left.released) return right.score >= left.score ? right : left;
    if (right.released) return right;
    if (left.released) return left;
    return right.score >= left.score ? right : left;
  })();

  try {
    const payload = {
      ts: Date.now(),
      frame: hist?.at?.(-1)?.frame ?? null,
      best: candidate,
      right,
      left,
      poseStreak: Number(window.__poseGateStreak || 0),
      armed: window.__shotTrackingArmed === true,
      hoopLocked: window.__hoopConfirmed === true,
    };
    window.__releaseGateLast = payload;

    const scoreVal = Number(candidate?.score ?? candidate?.tests?.score ?? 0);
    const detail = {
      frame: Number.isFinite(payload.frame) ? payload.frame : null,
      side: candidate?.tests?.side ?? null,
      score: Number.isFinite(scoreVal) ? Number(scoreVal.toFixed(3)) : null,
      strictOK: !!candidate?.strictOK,
      tests: {
        dx: candidate?.tests?.dx ?? null,
        dy: candidate?.tests?.dy ?? null,
        dSE: candidate?.tests?.dSE ?? null,
        dSW: candidate?.tests?.dSW ?? null,
        elbowAngleDeg: candidate?.tests?.elbowAngleDeg ?? null,
        elbowExtended: candidate?.tests?.elbowExtended ?? null,
        wristUpTrend: candidate?.tests?.wristUpTrend ?? null,
        alignOK: candidate?.tests?.alignOK ?? null,
        secondaryPassed: candidate?.tests?.secondaryPassed ?? null,
      },
      poseStreak: Number(window.__POSE_STREAK__ || 0),
      reason: candidate?.released ? 'released' : (candidate?.reason || 'blocked'),
    };
    try {
      window.dispatchEvent(new CustomEvent('gate:candidate', { detail }));
    } catch {}
    if (candidate?.released && typeof window.__logObserverEvent === 'function') {
      window.__logObserverEvent('gate:released', payload);
    }
  } catch {}

  return {
    released: candidate.released,
    passed: candidate.tests?.passed ?? 0,
    tests: candidate.tests,
    reason: candidate.reason,
    score: candidate.score,
    features: candidate.features,
  };
}

export function printPoseGate() {
  try {
    const hist = (window.playerState?.frameHistory || []).slice(-5);
    const g = releaseGate(hist);
    const f = hist.at(-1)?.frame ?? null;
    console.log('[pose:gate]', {
      frame: f,
      side: g.tests?.side ?? null,
      score: g.tests?.score ?? null,
      passed: g.tests?.passed ?? null,
      secondaryPassed: g.tests?.secondaryPassed ?? null,
      reason: g.reason,
      released: g.released,
    });
    return g;
  } catch (e) {
    console.warn('printPoseGate failed', e);
    return null;
  }
}

export function printLastRelease() {
  try {
    const fps = Number(window.__videoFPS) || 30;
    const frame = Number.isFinite(window.ballState?.releaseFrame)
      ? window.ballState.releaseFrame
      : (window.__GATE_LATCH_FRAME ?? null);
    if (Number.isFinite(frame)) {
      const t = (frame / fps).toFixed(3);
      console.log('[release:last]', { frame, time_s: Number(t) });
      return { frame, time_s: Number(t) };
    }
    console.log('[release:last] none');
    return null;
  } catch (e) {
    console.warn('printLastRelease failed', e);
    return null;
  }
}

try {
  if (!window.getReleaseKnobs) window.getReleaseKnobs = getReleaseKnobs;
  if (!window.setReleaseKnobs) window.setReleaseKnobs = setReleaseKnobs;
  if (!window.printPoseGate)   window.printPoseGate   = printPoseGate;
  if (!window.printLastRelease)window.printLastRelease= printLastRelease;
  if (typeof window.releaseGate !== 'function') window.releaseGate = releaseGate;
  if (typeof window.initReleaseConfig !== 'function') window.initReleaseConfig = initReleaseConfig;
} catch {}

try {
  initReleaseConfig();
} catch {}
try {
  const base = getReleaseKnobs();
  const trip = Number(base.scoreThresh);
  if (Number.isFinite(trip)) setReleaseKnobs({ hudScoreTrip: trip });
} catch {}

