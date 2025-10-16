//player_tracker.js

// Avoid circular import; use window.poseDetectSerial if present
async function poseDetectSerial(buffer) {
  try { return await (window.poseDetectSerial?.(buffer) || null); } catch (e) { return null; }
}

// Tracker for player pose + motion per frame (MediaPipe compatible)
// !! MediaPipe PoseLandmarker outputs normalized coordinates (0.0 to 1.0 range), not actual pixel values !!

const isVisible = (kp) => {
  if (kp?.visibility !== undefined) return kp.visibility >= 0.1;
  if (kp?.score !== undefined) return kp.score >= 0.1;
  return true;  // Assume visible if neither field is present
};

export const playerState = {
  keypoints: [],        // latest MediaPipe landmarks
  frameHistory: [],     // rolling buffer of recent landmarks
  wristHistory: [],     // for release detection
  elbowHistory: [],     // used for release detection refinement
  jumpDetected: false,
  lastFrame: -1
};

// MediaPipe POSE_LANDMARKS reference
export const LANDMARKS = {
  NOSE: 0,
  LEFT_EYE_INNER: 1,
  LEFT_EYE: 2,
  LEFT_EYE_OUTER: 3,
  RIGHT_EYE_INNER: 4,
  RIGHT_EYE: 5,
  RIGHT_EYE_OUTER: 6,
  LEFT_EAR: 7,
  RIGHT_EAR: 8,
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_THUMB: 21,
  RIGHT_THUMB: 22,
  LEFT_INDEX: 19,
  RIGHT_INDEX: 20,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
  LEFT_KNEE: 25,
  RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,
  RIGHT_ANKLE: 28,
  LEFT_HEEL: 29,
  RIGHT_HEEL: 30,
  LEFT_FOOT_INDEX: 31,
  RIGHT_FOOT_INDEX: 32
};

// Virtual points you can compute later
export const VIRTUAL_POINTS = {
  BODY_CENTER: 'bodyCenter',
  FOREHEAD: 'forehead',
  LEFT_HAND: 'leftHand',
  RIGHT_HAND: 'rightHand'
};

const VIS_CORE_POINTS = [LANDMARKS.NOSE, LANDMARKS.LEFT_SHOULDER, LANDMARKS.RIGHT_SHOULDER, LANDMARKS.LEFT_HIP, LANDMARKS.RIGHT_HIP, LANDMARKS.LEFT_KNEE, LANDMARKS.RIGHT_KNEE, LANDMARKS.LEFT_ANKLE, LANDMARKS.RIGHT_ANKLE];
const VIS_HAND_POINTS = [LANDMARKS.LEFT_WRIST, LANDMARKS.RIGHT_WRIST];
function fallbackPoseVisibilityScore(keypoints) {
  if (!Array.isArray(keypoints)) {
    return { score: 0, avg: 0, visible: 0, total: 0, min: 0, max: 0, coreVisible: 0, handVisible: 0, shoulderVisible: 0, anyStrong: false };
  }
  let total = 0;
  let visible = 0;
  let coreVisible = 0;
  let handVisible = 0;
  let shoulderVisible = 0;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  let anyStrong = false;
  const thresh = 0.2;
  for (let idx = 0; idx < keypoints.length; idx += 1) {
    const kp = keypoints[idx];
    if (!kp) continue;
    const visRaw = kp.visibility ?? kp.score ?? kp.presence;
    const vis = Number.isFinite(visRaw) ? visRaw : Number(window.BINDING_VIS_DEFAULT ?? 0.6);
    if (!Number.isFinite(vis)) continue;
    total += 1;
    sum += vis;
    if (vis >= thresh) visible += 1;
    if (vis < min) min = vis;
    if (vis > max) max = vis;
    if (VIS_CORE_POINTS.includes(idx) && vis >= thresh) coreVisible += 1;
    if (VIS_HAND_POINTS.includes(idx) && vis >= (thresh - 0.05)) handVisible += 1;
    if ((idx === LANDMARKS.LEFT_SHOULDER || idx === LANDMARKS.RIGHT_SHOULDER) && vis >= thresh) shoulderVisible += 1;
    if (vis >= 0.05 && (VIS_CORE_POINTS.includes(idx) || VIS_HAND_POINTS.includes(idx))) anyStrong = true;
  }
  if (!Number.isFinite(min)) min = 0;
  if (!Number.isFinite(max)) max = 0;
  const avg = total ? (sum / total) : 0;
  const score = total ? (visible / total) : 0;
  return { score, avg, visible, total, min, max, coreVisible, handVisible, shoulderVisible, anyStrong };
}
function getPoseVisibilityScore(keypoints) {
  if (typeof window.computePoseVisibilityScore === 'function') {
    try { return window.computePoseVisibilityScore(keypoints); } catch (e) { /* ignore */ }
  }
  return fallbackPoseVisibilityScore(keypoints);
}

export function resetPlayerTracker() {
  playerState.keypoints = [];
  playerState.frameHistory = [];
  playerState.wristHistory = [];
  playerState.elbowHistory = [];
  playerState.jumpDetected = false;
  playerState.lastFrame = -1;
  playerState.visibility = null;
  playerState.poseVisible = false;
}

export function updatePlayerTracker(landmarks, __frameIdx) {
  if (!landmarks || landmarks.length < 33) return;

  const video = document.getElementById("videoPlayer");
  const width = video?.videoWidth || 1920;
  const height = video?.videoHeight || 1080;

  // Accept either normalized (0..1) or already scaled (VIDEO px) landmarks.
  // If values look normalized, scale by video size; otherwise pass through.
  const looksNormalized = Array.isArray(landmarks) && landmarks.every(kp => kp && kp.x <= 1.01 && kp.y <= 1.01);
  const sx = looksNormalized ? width  : 1;
  const sy = looksNormalized ? height : 1;

  const scaledKeypoints = landmarks.map(kp => ({
    ...kp,
    x: kp.x * sx,
    y: kp.y * sy
  }));

  // Derive a sane frame index if caller passed 0/undefined
  let frameNum = Number.isFinite(__frameIdx)
    ? __frameIdx
    : Math.round(((video?.currentTime || 0) * (window.__videoFPS || 30)));
  // Prevent oscillating/regressing frame indices across samplers
  if (Number.isFinite(playerState.lastFrame) && frameNum < playerState.lastFrame) {
    // In release-only probe, drop regressing updates from other producers entirely
    if (window.__RELEASE_ONLY === true) {
      try { if (window.POSE_DEBUG === true) console.log('[pose:skip-regress]', { was: __frameIdx, last: playerState.lastFrame }); } catch (e) {}
      return;
    }
    const df = playerState.lastFrame - frameNum;
    frameNum = playerState.lastFrame + 1; // monotonic forward
    try { if (window.DOACH_VERBOSE === true && window.POSE_DEBUG === true) console.log('[pose:clamp-regress]', { was: __frameIdx, clampTo: frameNum, delta: df }); } catch (e) {}
  }

  const visibility = getPoseVisibilityScore(scaledKeypoints);
  playerState.visibility = visibility;
  let rectRaw = null;
  {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let count = 0;
    for (const kp of scaledKeypoints) {
      if (!kp) continue;
      const x = Number(kp.x);
      const y = Number(kp.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      count += 1;
    }
    if (count >= 2 && Number.isFinite(minX) && Number.isFinite(minY) && Number.isFinite(maxX) && Number.isFinite(maxY)) {
      rectRaw = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
      if (rectRaw.w <= 0 || rectRaw.h <= 0) {
        rectRaw = null;
      } else {
        rectRaw.area = rectRaw.w * rectRaw.h;
        rectRaw.tiny = rectRaw.w < 22 || rectRaw.h < 36 || rectRaw.area < 1600;
        rectRaw.small = rectRaw.w < 32 || rectRaw.h < 48 || rectRaw.area < 2600;
      }
    }
  }
  const visCoreMin = Number(window.BINDING_CORE_VISIBLE_MIN ?? 2);
  const visAvgMin = Number(window.BINDING_VIS_AVG_MIN ?? 0.22);
  const visScoreMin = Number(window.BINDING_VIS_SCORE_MIN ?? 0.25);
  const poseVisible = !!(visibility && visibility.coreVisible >= visCoreMin && visibility.avg >= visAvgMin && visibility.score >= visScoreMin);
  playerState.poseVisible = poseVisible;
  try { window.__POSE_VISIBLE = poseVisible; } catch (e) {}

  playerState.keypoints = scaledKeypoints;
  playerState.lastFrame = frameNum;
  if (poseVisible) {
    try { window.__lastPoseKP = scaledKeypoints; window.__lastPoseTS = performance.now(); } catch (e) {}
  }
  try { window.__lastPoseUpdateMs = performance.now(); window.__lastPoseWrist = scaledKeypoints[16] || null; } catch (e) {}
  const historyTs = Date.now();
  try { playerState.lastRectRaw = rectRaw; } catch (e) {}
  playerState.frameHistory.push({ frame: frameNum, keypoints: scaledKeypoints, visibility, rectRaw, ts: historyTs, tMs: historyTs, timestamp: historyTs });
  
  // Pose debug logging
  if (window.DOACH_VERBOSE === true && window.POSE_DEBUG === true) {
    const w = scaledKeypoints[16];
    console.log('[pose:update]', { frame: __frameIdx, n: scaledKeypoints.length, wrist: w ? { x: Math.round(w.x), y: Math.round(w.y), v: (w.visibility??w.score??1) } : null, norm: looksNormalized });
  }
  window.__POSE_UPDATES = (window.__POSE_UPDATES||0) + 1;
  if (playerState.frameHistory.length > 90)
    playerState.frameHistory = playerState.frameHistory.slice(-90);

  const rightWrist = scaledKeypoints[LANDMARKS.RIGHT_WRIST];
  if (rightWrist && rightWrist.visibility > 0.5) {
    playerState.wristHistory.push({
      x: rightWrist.x,
      y: rightWrist.y,
      frame: __frameIdx
    });

    if (playerState.wristHistory.length > 30)
      playerState.wristHistory = playerState.wristHistory.slice(-30);

    if (playerState.wristHistory.length >= 4) {
      const delta = rightWrist.y - playerState.wristHistory.at(-4).y;
      if (delta < -0.05) playerState.jumpDetected = true;
    }
  }

  const rightElbow = scaledKeypoints[LANDMARKS.RIGHT_ELBOW];
  if (rightElbow?.visibility > 0.5) {
    playerState.elbowHistory.push({
      x: rightElbow.x,
      y: rightElbow.y,
      frame: __frameIdx
    });

    if (playerState.elbowHistory.length > 30)
      playerState.elbowHistory = playerState.elbowHistory.slice(-30);
  }

  const shoulder = scaledKeypoints[LANDMARKS.RIGHT_SHOULDER];
  const wrist = scaledKeypoints[LANDMARKS.RIGHT_WRIST];
  if (shoulder && wrist && shoulder.visibility > 0.5 && wrist.visibility > 0.5) {
    const angle = computeArmAngle(shoulder, wrist);
    // console.log("🧠 Shoulder-to-wrist angle:", angle.toFixed(1));
  }


  if (playerState.frameHistory.length > 60)
    playerState.frameHistory = playerState.frameHistory.slice(-60);

  window.playerState = playerState;
}

// used to estimate shooting motion
export function computeArmAngle(shoulder, wrist) {
  return Math.atan2(wrist.y - shoulder.y, wrist.x - shoulder.x) * (180 / Math.PI);
}

// Wrist trail debug renderer
export function drawWristTrail(ctx) {
  const trail = playerState.wristHistory;
  if (!ctx || !trail || trail.length < 2) return;
  ctx.lineWidth = 2;
  for (let i = 1; i < trail.length; i++) {
    const prev = trail[i - 1];
    const curr = trail[i];
    const alpha = 0.3 + 0.7 * (i / trail.length);
    ctx.strokeStyle = `rgba(255,165,0,${alpha})`;
    ctx.beginPath(); ctx.moveTo(prev.x, prev.y); ctx.lineTo(curr.x, curr.y); ctx.stroke();
  }
  const last = trail.at(-1);
  if (last) { ctx.beginPath(); ctx.fillStyle = 'orange'; ctx.arc(last.x, last.y, 4, 0, Math.PI * 2); ctx.fill(); }
}

export function getVirtualLandmarks(landmarks) {
  if (!landmarks || landmarks.length < 33) return {};
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, visibility: Math.min(a.visibility ?? 1, b.visibility ?? 1) });
  const bodyCenter = mid(landmarks[LANDMARKS.LEFT_HIP], landmarks[LANDMARKS.RIGHT_HIP]);
  const forehead   = mid(landmarks[LANDMARKS.LEFT_EYE], landmarks[LANDMARKS.RIGHT_EYE]);
  const leftHand   = mid(landmarks[LANDMARKS.LEFT_WRIST], landmarks[LANDMARKS.LEFT_INDEX]);
  const rightHand  = mid(landmarks[LANDMARKS.RIGHT_WRIST], landmarks[LANDMARKS.RIGHT_INDEX]);
  return { bodyCenter, forehead, leftHand, rightHand };
}

export function isPoseReleaseLikely(poseHistory) {
  if (!poseHistory || poseHistory.length < 3) return false;
  const r = poseHistory.slice(-3);
  const S = LANDMARKS.RIGHT_SHOULDER, E = LANDMARKS.RIGHT_ELBOW, W = LANDMARKS.RIGHT_WRIST;
  const t = r.map(p => {
    const k = p?.keypoints; if (!k || k.length < 33) return null;
    const shoulder = k[S], elbow = k[E], wrist = k[W]; if (!shoulder || !elbow || !wrist) return null;
    return { wristY: wrist.y, elbowToWrist: wrist.y - elbow.y, shoulderToElbow: elbow.y - shoulder.y };
  }).filter(Boolean);
  if (t.length < 2) return false;
  // Relaxed thresholds (pose-only mode): allow smaller upward deltas
  const wristUp1 = t[1].wristY < t[0].wristY - 6;
  const wristUp2 = (t[2]?.wristY ?? Infinity) < (t[1]?.wristY ?? Infinity) - 6;
  const elbowStraightening = t[1].elbowToWrist < t[0].elbowToWrist - 3;
  const armExtending       = t[1].shoulderToElbow > t[0].shoulderToElbow + 3;
  return (wristUp1 && (wristUp2 || elbowStraightening)) || (wristUp2 && armExtending);
}

export function isPoseInReleasePosition(pose) {
  const k = pose?.keypoints || pose; if (!Array.isArray(k) || k.length < 33) return false;
  const sh = k[LANDMARKS.RIGHT_SHOULDER];
  const el = k[LANDMARKS.RIGHT_ELBOW];
  const wr = k[LANDMARKS.RIGHT_WRIST];
  if (!isVisible(sh) || !isVisible(el) || !isVisible(wr)) return false;

  // Basic vertical stack: wrist above elbow, elbow near/above shoulder
  const wristAboveElbow    = wr.y < (el.y - 12);
  const elbowNearShoulder  = el.y < (sh.y + 40); // allow a bit looser than before

  // Verticality by shoulder→wrist angle (|dx| small or steep angle)
  const dx = Math.abs(wr.x - sh.x);
  const dy = Math.abs(sh.y - wr.y);
  const nearlyVertical = dx < 90 && dy > 18;

  // Forward extension: wrist further from shoulder than elbow (arm extended)
  const dSE = Math.hypot((el.x - sh.x), (el.y - sh.y));
  const dSW = Math.hypot((wr.x - sh.x), (wr.y - sh.y));
  const armExtended = dSW > (dSE + 10);

  // Accept if any two of the three are true
  const tests = [wristAboveElbow, elbowNearShoulder, nearlyVertical || armExtended];
  const passed = tests.filter(Boolean).length;
  return passed >= 2;
}

try {
  window.isPoseReleaseLikely = window.isPoseReleaseLikely || isPoseReleaseLikely;
  window.isPoseInReleasePosition = window.isPoseInReleasePosition || isPoseInReleasePosition;
  window.drawWristTrail = window.drawWristTrail || drawWristTrail;
} catch (e) {}

// used when selected hoop is reselected
export async function forceSafePose(buffer, _videoElement, __frameIdx) {
  return await poseDetectSerial(buffer);
}

// capture pose snapshot
export function extractPoseSnapshot(keypoints, hoopBox) {
  const k = keypoints;
  if (!k || k.length < 33) return null;

  const [wrist, elbow, shoulder] = [k[16], k[14], k[12]];
  const [la, ra] = [k[27], k[28]];
  const [lk, rk] = [k[25], k[26]];
  const [lh, rh] = [k[23], k[24]];

  const isVisible = (...joints) => joints.every(j => j?.visibility > 0.5);
  if (!isVisible(wrist, elbow, shoulder, la, ra, lk, rk, lh, rh)) return null;

  const stance = Math.abs(ra.x - la.x);
  const flex = Math.abs(((lk.y + rk.y) / 2) - ((lh.y + rh.y) / 2));
  const lean = Math.atan2(((lh.y + rh.y)/2) - shoulder.y, ((lh.x + rh.x)/2) - shoulder.x) * 180 / Math.PI;

  return {
    wristY: wrist.y,
    elbowY: elbow.y,
    shoulderY: shoulder.y,
    elbowToWrist: wrist.y - elbow.y,
    shoulderToWristAngle: Math.round(Math.atan2(wrist.y - shoulder.y, wrist.x - shoulder.x) * 180 / Math.PI),
    stanceWidth: Math.round(stance),
    kneeFlex: Math.round(flex),
    torsoLeanAngle: Math.round(lean),
    wristToHoop: hoopBox ? Math.round(Math.hypot(wrist.x - hoopBox.x, wrist.y - hoopBox.y)) : null
  };
}

// Expose snapshot helper for modules that avoid direct imports (breaks cycles)
try { window.extractPoseSnapshot = window.extractPoseSnapshot || extractPoseSnapshot; } catch (e) {}

function calculateBasicShotMetrics(shot = null) {
  try {
    if (shot && typeof shot === 'object') {
      return {
        arcHeight: shot.arcHeight ?? null,
        entryAngle: shot.entryAngle ?? null,
        releaseAngle: shot.releaseAngle ?? null,
        releaseFrame: shot.releaseFrame ?? null
      };
    }
  } catch (e) {}
  return { arcHeight: null, entryAngle: null, releaseAngle: null, releaseFrame: null };
}

function sendShotToBackend(shot = null) {
  try {
    console.log('[SHOT-BACKEND] stub send', shot);
  } catch (e) {}
  return Promise.resolve(false);
}

// Expose helpers globally
window.calculateBasicShotMetrics = calculateBasicShotMetrics;
window.sendShotToBackend = sendShotToBackend;

/* ------------------------------------------------------------------
 * Shot start (release) � canonical in player_tracker
 * Marks the start of a shot attempt based on pose/corridor gating.
 * Keeps state on window.ballState and resets the live arc buffer.
 * ------------------------------------------------------------------ */
export function markRelease(frameIndex, opts = {}) {
  try { window.__readyForScoring = true; } catch (e) {}

  const fromSafe = opts?.__fromSafe === true;

  if (!fromSafe) {
    try {
      if (typeof window.safeEmitRelease === 'function') {
        const via = opts?.via || 'legacy';
        return window.safeEmitRelease(frameIndex, via, opts) === true;
      }
    } catch (e) {}
    const hist = (window.playerState?.frameHistory || []).slice(-5);
    const gate = (typeof window.releaseGate === 'function')
      ? (window.releaseGate(hist) || { released:false })
      : { released:false };
    if (!gate.released) return false;
  }

  const bs = (window.ballState ||= {});
  if (bs.state === 'TRACKING' && Number.isFinite(bs.releaseFrame)) return true;

  const lastFrame = Number.isFinite(frameIndex)
    ? frameIndex
    : (bs.trail?.at?.(-1)?.frame ?? (playerState.lastFrame ?? 0));

  try {
    const via = String(opts?.via || '').toLowerCase();
    const requirePose = (opts?.requirePose === true) || via.startsWith('pose');
    if (requirePose) {
      const kps = (playerState && Array.isArray(playerState.keypoints) && playerState.keypoints.length >= 33) ? playerState.keypoints : null;
      if (!kps) {
        if (window.DOACH_SHOT_DEBUG) console.warn('[player_tracker] markRelease skipped - requirePose but no keypoints', { via, frame: lastFrame });
        return false;
      }
    }
  } catch (e) {}

  if (window.DOACH_SHOT_DEBUG) {
    console.log('[player_tracker] markRelease', { frame: lastFrame, via: opts?.via || 'unknown', fromSafe });
  }

  bs.releaseFrame   = lastFrame;
  bs.proxExitFrame  = null;
  bs.state          = 'TRACKING';

  try {
    const preF  = Number(window.SHOT_SAVE_PRE_FRAMES ?? 10);
    const postF = Number(window.SHOT_SAVE_POST_FRAMES ?? 90);
    bs.saveStartFrame  = Math.max(0, lastFrame - preF);
    bs.saveEndFrameMax = lastFrame + postF;
  } catch (e) {}

  try {
    const lastPt = (window.ballState?.trail?.at?.(-1) || null);
    if (lastPt && Number.isFinite(lastPt.x) && Number.isFinite(lastPt.y)) {
      bs.releasePos = { x: lastPt.x, y: lastPt.y };
      bs._releaseDrawUntil = lastFrame + 8;
      try { window.__overlayArcDrawnCount = 0; } catch (e) {}
    }
  } catch (e) {}

  try {
    const H = (typeof window.getLockedHoopBox === 'function') ? window.getLockedHoopBox() : null;
    if (H && bs.releasePos && bs.proxEnterFrame == null) {
      const w = Math.max(1, H.w ?? H.width ?? 0);
      const h = Math.max(1, H.h ?? H.height ?? 0);
      const cx = Number.isFinite(H.cx) ? H.cx : (H.anchor==='topleft' ? (H.x + w/2) : H.x);
      const cy = Number.isFinite(H.cy) ? H.cy : (H.anchor==='topleft' ? (H.y + h/2) : H.y);
      const rimTop = cy - h/2;
      const px = Number(window.proxX) || 200;
      const pyA = Number(window.proxYAbove) || 170;
      const pyB = Number(window.proxYBelow) || 100;
      const rect = { x: cx - px, y: rimTop - pyA, w: px*2, h: pyA + pyB };
      const p = bs.releasePos;
      const inside = p.x >= rect.x && p.x <= rect.x+rect.w && p.y >= rect.y && p.y <= rect.y+rect.h;
      if (inside) bs.proxEnterFrame = lastFrame;
      bs._lastInProx = inside;
    }
  } catch (e) {}

  try {
    if (window.__TEST_MODE) {
      const bs2 = (window.ballState ||= {});
      if (bs2.proxEnterFrame == null) bs2.proxEnterFrame = bs.releaseFrame + 1;
      bs2._lastInProx = true;
    }
  } catch (e) {}

  const arc = (window.ballArc ||= { trail: [], prox: null });
  const src = Array.isArray(window.ballState?.trail) ? window.ballState.trail : [];
  arc.trail = src.filter(p => (p.frame ?? -1) <= lastFrame).slice(-8).map(p => ({ x: p.x, y: p.y, frame: p.frame }));
  if (opts?.prox) arc.prox = opts.prox;

  try {
    if (playerState?.keypoints?.length) {
      bs.releasePose = extractPoseSnapshot(playerState.keypoints, window.getLockedHoopBox?.());
    }
  } catch (e) {}

  return true;
}
// load MediaPipe landmarker Pose model
export async function initPoseDetector() {
  try { if (window.poseDetector) return window.poseDetector; } catch (e) {}
  const vision = await window.FilesetResolver.forVisionTasks(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm'
  );

  let poseDetector;
  try {
    const useCPU = (typeof navigator !== 'undefined' && (navigator.webdriver === true)) || (window.__TEST_MODE === true) || /[?&]probe=release/.test(location.search||'');
    const loConf = (window.__TEST_MODE === true) || /[?&]probe=release/.test(location.search||'') || (typeof navigator !== 'undefined' && navigator.webdriver === true);
    const modelKind = String(window.POSE_MODEL || 'lite').toLowerCase();
    const modelFile = modelKind === 'full' ? '/static/models/pose_landmarker_full.task'
                    : modelKind === 'heavy' ? '/static/models/pose_landmarker_heavy.task'
                    : '/static/models/pose_landmarker_lite.task';
    poseDetector = await window.PoseLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: modelFile,
        delegate: useCPU ? 'CPU' : 'GPU'
      },
      runningMode: 'VIDEO',
      numPoses: Number.isFinite(window.POSE_NUM_POSES) ? Number(window.POSE_NUM_POSES) : 1,
      minPoseDetectionConfidence: Number.isFinite(window.POSE_MIN_DET) ? Number(window.POSE_MIN_DET) : (loConf ? 0.35 : 0.5),
      minPosePresenceConfidence: Number.isFinite(window.POSE_MIN_PRES) ? Number(window.POSE_MIN_PRES) : (loConf ? 0.35 : 0.5),
      minTrackingConfidence: Number.isFinite(window.POSE_MIN_TRACK) ? Number(window.POSE_MIN_TRACK) : (loConf ? 0.35 : 0.5)
    });
    try { window.__POSE_DELEGATE = useCPU ? 'CPU' : 'GPU'; window.__POSE_MODEL = modelKind || 'lite'; } catch (e) {}
  } catch (e) {
    console.warn('[pose] local model missing; falling back to CDN task', e);
    const useCPU = (typeof navigator !== 'undefined' && (navigator.webdriver === true)) || (window.__TEST_MODE === true) || /[?&]probe=release/.test(location.search||'');
    const loConf = (window.__TEST_MODE === true) || /[?&]probe=release/.test(location.search||'') || (typeof navigator !== 'undefined' && navigator.webdriver === true);
    poseDetector = await window.PoseLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: 'https://storage.googleapis.com/mediapipe-assets/pose_landmarker_lite.task',
        delegate: useCPU ? 'CPU' : 'GPU'
      },
      runningMode: 'VIDEO',
      numPoses: Number.isFinite(window.POSE_NUM_POSES) ? Number(window.POSE_NUM_POSES) : 1,
      minPoseDetectionConfidence: Number.isFinite(window.POSE_MIN_DET) ? Number(window.POSE_MIN_DET) : (loConf ? 0.35 : 0.5),
      minPosePresenceConfidence: Number.isFinite(window.POSE_MIN_PRES) ? Number(window.POSE_MIN_PRES) : (loConf ? 0.35 : 0.5),
      minTrackingConfidence: Number.isFinite(window.POSE_MIN_TRACK) ? Number(window.POSE_MIN_TRACK) : (loConf ? 0.35 : 0.5)
    });
    try { window.__POSE_DELEGATE = useCPU ? 'CPU' : 'GPU'; window.__POSE_MODEL = 'lite-cdn'; } catch (e) {}
  }

  window.poseDetector = poseDetector;
  console.log("✅ PoseLandmarker loaded with runningMode=VIDEO, delegate=", (typeof navigator !== 'undefined' && (navigator.webdriver === true)) || (window.__TEST_MODE === true) || /[?&]probe=release/.test(location.search||'') ? 'CPU' : 'GPU');

  // 🔔 Setup debug indicators
  const debugBox = document.createElement('div');
  debugBox.style.position = 'absolute';
  debugBox.style.top = '12px';
  debugBox.style.right = '12px';
  debugBox.style.background = '#222';
  debugBox.style.color = 'white';
  debugBox.style.padding = '8px 12px';
  debugBox.style.borderRadius = '8px';
  debugBox.style.fontSize = '0.85rem';
  debugBox.style.zIndex = '999';
  debugBox.innerText = 'Session Recording...';
  document.body.appendChild(debugBox);
  window.__debugBox = debugBox;
}


// ✅ Draw keypoints and connections
export function drawPoseSkeleton(ctx, keypoints) {
  if (!ctx || !Array.isArray(keypoints) || keypoints.length < 33) {
    console.warn("❌ Invalid pose keypoints");
    return;
  }

  ctx.lineWidth = 2;

  const isVisible = kp => kp && typeof kp.x === 'number' && typeof kp.y === 'number' && (kp.visibility ?? kp.score ?? 1) >= 0.1;

  const connect = (a, b, color = 'magenta') => {
    if (!isVisible(keypoints[a]) || !isVisible(keypoints[b])) return;
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.moveTo(keypoints[a].x, keypoints[a].y);
    ctx.lineTo(keypoints[b].x, keypoints[b].y);
    ctx.stroke();
  };

  const drawDot = (i, color) => {
    const kp = keypoints[i];
    if (!isVisible(kp)) return;
    ctx.beginPath();
    ctx.arc(kp.x, kp.y, 4, 0, 2 * Math.PI);
    ctx.fillStyle = color;
    ctx.fill();
  };

  // Color-coded parts
  const core = 'magenta';
  const left = 'cyan';
  const right = 'orange';

  // Joints
  drawDot(11, left);  // L shoulder
  drawDot(12, right); // R shoulder
  drawDot(13, left);  // L elbow
  drawDot(14, right); // R elbow
  drawDot(15, left);  // L wrist
  drawDot(16, right); // R wrist
  drawDot(23, left);  // L hip
  drawDot(24, right); // R hip
  drawDot(25, left);  // L knee
  drawDot(26, right); // R knee
  drawDot(27, left);  // L ankle
  drawDot(28, right); // R ankle
  drawDot(29, left);  // L heel
  drawDot(30, right); // R heel
  drawDot(31, left);  // L foot index
  drawDot(32, right); // R foot index
  drawDot(19, left);  // L index
  drawDot(20, right); // R index
  drawDot(21, left);  // L thumb
  drawDot(22, right); // R thumb
  drawDot(7, left);   // L ear
  drawDot(8, right);  // R ear


  // Connections — core
  connect(11, 12, core);
  connect(11, 23, left);
  connect(12, 24, right);
  connect(23, 24, core);

  // Arms
  connect(11, 13, left);
  connect(13, 15, left);
  connect(12, 14, right);
  connect(14, 16, right);

  // Legs
  connect(23, 25, left);
  connect(25, 27, left);
  connect(24, 26, right);
  connect(26, 28, right);
}







