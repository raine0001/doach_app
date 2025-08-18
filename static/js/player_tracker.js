//player_tracker.js

import { syncTimestampWithVideo } from './video_utils.js';
import { poseDetectSerial } from './app.js';

// Tracker for player pose + motion per frame (MediaPipe compatible)
// !! MediaPipe PoseLandmarker outputs normalized coordinates (0.0 to 1.0 range), not actual pixel values !!

const isVisible = (kp) => {
  if (kp?.visibility !== undefined) return kp.visibility > 0.5;
  if (kp?.score !== undefined) return kp.score > 0.5;
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

export function resetPlayerTracker() {
  playerState.keypoints = [];
  playerState.frameHistory = [];
  playerState.wristHistory = [];
  playerState.elbowHistory = [];
  playerState.jumpDetected = false;
  playerState.lastFrame = -1;
}

export function updatePlayerTracker(landmarks, __frameIdx) {
  if (!landmarks || landmarks.length < 33) return;

  const video = document.getElementById("videoPlayer");
  const width = video?.videoWidth || 1920;
  const height = video?.videoHeight || 1080;

  const scaledKeypoints = landmarks.map(kp => ({
    ...kp,
    x: kp.x * width,
    y: kp.y * height
  }));

  playerState.keypoints = scaledKeypoints;
  playerState.lastFrame = __frameIdx;
  playerState.frameHistory.push({ frame: __frameIdx, keypoints: scaledKeypoints });

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

// load MediaPipe landmarker Pose model
export async function initPoseDetector() {
  const vision = await window.FilesetResolver.forVisionTasks(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm'
  );

  const poseDetector = await window.PoseLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: '/static/models/pose_landmarker_lite.task',
      delegate: 'GPU'
    },
    runningMode: 'VIDEO',
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5
  });

  window.poseDetector = poseDetector;
  console.log("✅ PoseLandmarker loaded with runningMode=VIDEO");

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
  debugBox.innerText = '🟡 Waiting...';
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

  const isVisible = kp => kp && typeof kp.x === 'number' && typeof kp.y === 'number' && (kp.visibility ?? kp.score ?? 1) > 0.5;

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

export function drawWristTrail(ctx) {
  const trail = playerState.wristHistory;
  if (!ctx || !trail || trail.length < 2) return;

  ctx.lineWidth = 2;

  for (let i = 1; i < trail.length; i++) {
    const prev = trail[i - 1];
    const curr = trail[i];
    const alpha = 0.3 + 0.7 * (i / trail.length); // fading effect

    ctx.strokeStyle = `rgba(255, 165, 0, ${alpha})`;
    ctx.beginPath();
    ctx.moveTo(prev.x, prev.y);
    ctx.lineTo(curr.x, curr.y);
    ctx.stroke();
  }

  // Draw final dot
  const last = trail.at(-1);
  ctx.beginPath();
  ctx.fillStyle = 'orange';
  ctx.arc(last.x, last.y, 4, 0, 2 * Math.PI);
  ctx.fill();
}

// ✅ Optional — Access derived virtual points
export function getVirtualLandmarks(landmarks) {
  if (!landmarks || landmarks.length < 33) return {};

  const getMidpoint = (a, b) => ({
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
    visibility: Math.min(a.visibility, b.visibility)
  });

  const bodyCenter = getMidpoint(
    landmarks[LANDMARKS.LEFT_HIP],
    landmarks[LANDMARKS.RIGHT_HIP]
  );

  const forehead = getMidpoint(
    landmarks[LANDMARKS.LEFT_EYE],
    landmarks[LANDMARKS.RIGHT_EYE]
  );

  const leftHand = getMidpoint(
    landmarks[LANDMARKS.LEFT_WRIST],
    landmarks[LANDMARKS.LEFT_INDEX]
  );

  const rightHand = getMidpoint(
    landmarks[LANDMARKS.RIGHT_WRIST],
    landmarks[LANDMARKS.RIGHT_INDEX]
  );

  return {
    [VIRTUAL_POINTS.BODY_CENTER]: bodyCenter,
    [VIRTUAL_POINTS.FOREHEAD]: forehead,
    [VIRTUAL_POINTS.LEFT_HAND]: leftHand,
    [VIRTUAL_POINTS.RIGHT_HAND]: rightHand
  };
}


// determine if ball release point is likely
export function isPoseReleaseLikely(poseHistory) {
  if (!poseHistory || poseHistory.length < 3) return false;

  const recent = poseHistory.slice(-3);
  const getY = (kp, idx) => kp?.keypoints?.[idx]?.y ?? null;

  // For each frame:
  const trend = recent.map((pose, i) => {
    const shoulderY = getY(pose, 6); // Right shoulder
    const elbowY = getY(pose, 8);    // Right elbow
    const wristY = getY(pose, 10);   // Right wrist

    if (shoulderY && elbowY && wristY) {
      const elbowToWrist = wristY - elbowY;
      const shoulderToElbow = elbowY - shoulderY;
      return { elbowToWrist, shoulderToElbow, wristY };
    }
    return null;
  }).filter(Boolean);

  if (trend.length < 2) return false;

  // Look for:
  // - wristY decreasing
  // - elbowToWrist shrinking
  // - shoulderToElbow increasing (arm extends)
  const wristMovingUp = trend[1].wristY < trend[0].wristY - 10;
  const elbowStraightening = trend[1].elbowToWrist < trend[0].elbowToWrist - 5;
  const armExtending = trend[1].shoulderToElbow > trend[0].shoulderToElbow + 5;

  return wristMovingUp && elbowStraightening && armExtending &&
       trend[2].wristY < trend[1].wristY - 10;
}


// determine pose release for shot tracking
export function isPoseInReleasePosition(pose) {
  const k = pose?.keypoints;
  if (!k || k.length < 33) return false;

  const shoulder = k[LANDMARKS.RIGHT_SHOULDER];
  const elbow = k[LANDMARKS.RIGHT_ELBOW];
  const wrist = k[LANDMARKS.RIGHT_WRIST];

  if (!isVisible(shoulder) || !isVisible(elbow) || !isVisible(wrist)) return false;

  const wristAboveElbow = wrist.y < elbow.y - 20;
  const elbowAboveShoulder = elbow.y < shoulder.y + 30;
  const armNearlyVertical = Math.abs(wrist.x - shoulder.x) < 60;

  return wristAboveElbow && elbowAboveShoulder && armNearlyVertical;
}


