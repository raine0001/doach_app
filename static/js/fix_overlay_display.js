// fix_Overlay_Display.js

import { drawPoseSkeleton, drawWristTrail } from './player_tracker.js';
import { drawHoopProximityDebug, drawShotTubeDebug } from './shot_logger.js';
import { getLockedHoopBox } from './hoop_tracker.js';
import { drawBallTrails } from './ball_tracker.js';
import { drawFinalShotSummary } from './shot_utils.js';

let overlay = null;
let ctx = null;
let poseDetector = null;
let lastDetectedFrame = {};
let canvasRecorder = null;
let recordedChunks = [];
let recordingActive = false;

window.__pickingHoop = false;


// initialize and display overlay
export function initOverlay(canvas, detector) {
  if (!canvas || !detector) { console.warn("initOverlay: missing"); return; }
  overlay = canvas;

  // make sure overlay never blocks the UI unless we say so
  overlay.style.position = 'absolute';
  overlay.style.left = '0';
  overlay.style.top = '0';
  overlay.style.zIndex = '5';          // HUD is higher (e.g., 999)
  overlay.style.pointerEvents = 'none'; // ✨ default: doesn't capture input
  overlay.style.userSelect = 'none';
  
  poseDetector = detector;

  const video = document.getElementById('videoPlayer');
  if (video?.videoWidth && video?.videoHeight) {
    overlay.width  = video.videoWidth;
    overlay.height = video.videoHeight;
    ctx = overlay.getContext('2d');
  } else {
    console.warn("⚠️ initOverlay: videoPlayer not ready or missing metadata.");
  }

  // make sure the overlay never intercepts input
  overlay.style.pointerEvents = 'none';
  overlay.style.userSelect    = 'none';
  overlay.style.zIndex        = '5';
  overlay.style.position = 'absolute';
  
  // Make overlay/HUD un-blockable
  overlay.style.left = '0';
  overlay.style.top = '0';
  overlay.style.pointerEvents = 'none';
  overlay.style.userSelect = 'none';
  overlay.style.zIndex = '5'; // HUD stays above at 999

  window.drawLiveOverlay    = drawLiveOverlay;
  window.getOverlayContext  = () => ctx;
}

// helper to toggle clickability
export function setOverlayClickable(on) {
  overlay = overlay || document.getElementById('overlay');
  if (!overlay) return;
  overlay.style.pointerEvents = on ? 'auto' : 'none';
  overlay.style.cursor = on ? 'crosshair' : 'default';
}
window.setOverlayClickable = setOverlayClickable;


/** Toggle interactivity when you want taps on the overlay (e.g., hoop select). */
export function setOverlayInteractive(on) {
  const ov = document.getElementById('overlay');
  if (!ov) return;
  window.__pickingHoop = !!on;
  // use !important so nothing else clobbers it
  ov.style.setProperty('pointer-events', on ? 'auto' : 'none', 'important');
  ov.style.cursor = on ? 'crosshair' : 'default';
  console.log(`[overlay] interactive = ${on}`);
}


// Core function for rendering overlays
export function drawLiveOverlay(objects = [], playerState) {
  const video = document.getElementById('videoPlayer');
  if (!ctx || !overlay || !video) {
    // console.warn("⚠️ drawLiveOverlay: Missing canvas or video context.");
    return;
  }

  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return;

  if (overlay.width !== vw || overlay.height !== vh) {
    overlay.width = vw;
    overlay.height = vh;
    console.log(`📐 Resized overlay canvas to ${vw}×${vh}`);
  }

  ctx.clearRect(0, 0, overlay.width, overlay.height);

  // Highlight the auto-selected shooter so we can see the lock
  try {
    const ap = window.activePlayerBox;
    if (ap) {
      ctx.save();
      ctx.strokeStyle = 'deepskyblue';
      ctx.lineWidth = 4;
      ctx.strokeRect(ap.x, ap.y, ap.w, ap.h);
      ctx.restore();
    }
  } catch {}


  // draw current video frame under overlays (optional)
  try { ctx.drawImage(video, 0, 0, overlay.width, overlay.height); } catch {}

  // Pose skeleton + wrist trail
  const keypoints = playerState?.keypoints;
  const validPose = Array.isArray(keypoints)
    && keypoints.length >= 33
    && keypoints.every(kp => kp && Number.isFinite(kp.x) && Number.isFinite(kp.y));

  if (validPose) {
    drawPoseSkeleton(ctx, keypoints);
    drawWristTrail(ctx);
  }

  // Shot visuals
  drawHoopProximityDebug(ctx);
  drawShotTubeDebug(ctx);
  drawBallTrails(ctx);
  drawFinalShotSummary(ctx);

  // Visual fallback around hoop (only if locked)
  const hoop = getLockedHoopBox?.();
  if (hoop) {
    ctx.save();
    ctx.setLineDash([4]);
    ctx.strokeStyle = 'lime';
    ctx.lineWidth = 2;
    ctx.strokeRect(hoop.x - 40, hoop.y - 20, 80, 40);
    ctx.restore();
  }

  // Draw with TL, compute with center
  const H = getLockedHoopBox?.(); // center
  if (H) {
    ctx.save();
    ctx.setLineDash([4]);
    ctx.strokeStyle = 'lime';
    ctx.lineWidth = 2;
    ctx.strokeRect(H.x1, H.y1, H.w, H.h); // TL for canvas draw
    ctx.beginPath();                       // debug: center dot
    ctx.arc(H.cx, H.cy, 3, 0, 2*Math.PI);
    ctx.fillStyle = 'red';
    ctx.fill();
    ctx.restore();
  }


  // Object detections
  for (const obj of objects) {
    if (!Array.isArray(obj.box) || obj.box.length !== 4) continue;
    const [x1, y1, x2, y2] = obj.box;
    const label = obj.label?.toLowerCase?.() || 'unknown';
    const color = { basketball: 'yellow', hoop: 'red', player: 'cyan', net: 'orange', backboard: 'magenta' }[label] || 'white';

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);

    ctx.font = '14px sans-serif';
    ctx.fillStyle = 'black';
    ctx.fillRect(x1, y1 - 18, ctx.measureText(label).width + 10, 18);
    ctx.fillStyle = color;
    ctx.fillText(label, x1 + 4, y1 - 6);

    const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
    ctx.beginPath(); ctx.arc(cx, cy, 3, 0, 2 * Math.PI); ctx.fill();
    ctx.restore();
  }

  // Status frame border (draw once, with desired style)
  ctx.save();
  ctx.strokeStyle = 'lime';
  ctx.lineWidth = 1;
  ctx.strokeRect(0, 0, overlay.width, overlay.height);
  ctx.restore();
}


let isDetectingFrame = false;
const reusableYOLOCanvas = document.createElement("canvas");
const reusableYOLOCtx = reusableYOLOCanvas.getContext("2d");

/**
 * Capture the *real* pixels and send to YOLO.
 * - `src` can be the <video> element OR a canvas. We prefer <video>.
 * - While a request is in flight, we return the last good objects to avoid flicker.
 */
export async function sendFrameToDetect(src, frameIndex, opts = {}) {
  // If a detection is already running, keep showing the last stable result
  if (isDetectingFrame) {
    const last = (window.lastDetectedFrame && Array.isArray(window.lastDetectedFrame.objects))
      ? window.lastDetectedFrame.objects
      : [];
    // Don’t clear boxes while busy
    return { objects: last };
  }

  isDetectingFrame = true;
  try {
    const video = document.getElementById("videoPlayer");

    // Prefer capturing straight from <video> (most reliable)
    let useSrc = null;
    let sw = 0, sh = 0, srcType = 'none';

    if (video && video.videoWidth && video.videoHeight) {
      useSrc = video;
      sw = video.videoWidth;
      sh = video.videoHeight;
      srcType = 'video';
    } else if (src && src.width && src.height) {
      useSrc = src;               // fallback: an offscreen/source canvas
      sw = src.width;
      sh = src.height;
      srcType = 'canvas';
    }

    if (!sw || !sh || sw < 32 || sh < 32) {
      console.warn("⚠️ sendFrameToDetect: no valid capture size", { sw, sh, srcType, frameIndex });
      return { objects: [] };
    }

    // Prepare capture surface at *exact* source size
    reusableYOLOCanvas.width = sw;
    reusableYOLOCanvas.height = sh;
    reusableYOLOCtx.setTransform(1, 0, 0, 1, 0, 0);
    reusableYOLOCtx.clearRect(0, 0, sw, sh);

    // Draw the source frame
    reusableYOLOCtx.drawImage(useSrc, 0, 0, sw, sh);

    // Encode and send to your backend
    const quality = typeof opts.jpegQuality === 'number' ? opts.jpegQuality : 0.85;
    const dataURL = reusableYOLOCanvas.toDataURL("image/jpeg", quality);

    const res = await fetch("/detect_frame", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ frame: dataURL, width: sw, height: sh }),
    });

    if (!res.ok) {
      console.error(`❌ Detection error (frame ${frameIndex}):`, res.status, await res.text().catch(()=>""));
      return { objects: [] };
    }

    const data = await res.json().catch(() => ({}));
    // Be tolerant to shape changes: {objects:[...]} or {detections:[...]}
    const objects = Array.isArray(data.objects)
      ? data.objects
      : (Array.isArray(data.detections) ? data.detections : []);

    return { objects };
  } catch (err) {
    console.error(`❌ Detection failure (frame ${frameIndex}):`, err);
    return { objects: [] };
  } finally {
    isDetectingFrame = false;
  }
}


// record canvas tracing and coach summary
export function startCanvasRecording(canvas) {
  if (!canvas) return;
  const stream = canvas.captureStream(30); // 30 fps
  canvasRecorder = new MediaRecorder(stream, { mimeType: 'video/webm' });

  recordedChunks = [];

  canvasRecorder.ondataavailable = event => {
    if (event.data.size > 0) recordedChunks.push(event.data);
  };

  canvasRecorder.onstop = () => {
    const blob = new Blob(recordedChunks, { type: 'video/webm' });
    const url = URL.createObjectURL(blob);

    // Optional: auto download
    const a = document.createElement("a");
    a.href = url;
    a.download = `doach_session_${Date.now()}.webm`;
    a.click();

    // Optional: upload to backend
    // const formData = new FormData();
    // formData.append("session_video", blob, "session.webm");
    // fetch("/upload_session_video", { method: "POST", body: formData });
  };

  canvasRecorder.start();
  recordingActive = true;
  console.log("🎥 Canvas recording started.");
}

export function stopCanvasRecording() {
  if (canvasRecorder && recordingActive) {
    canvasRecorder.stop();
    recordingActive = false;
    console.log("🛑 Canvas recording stopped.");
  }
}

// frame playback only
export function playArchivedOverlay(videoElement, canvas, frameArchive, onComplete) {
  const ctx = canvas.getContext('2d');
  if (!frameArchive?.length) {
    console.warn("⚠️ playArchivedOverlay: Empty archive provided");
    if (onComplete) onComplete();
    return;
  }

  // console.log(`▶️ Playing archived overlay — ${frameArchive.length} frames`);

  let __frameIdx = 0;
  const totalFrames = frameArchive.length;
  const fps = 30;
  const delay = 1000 / fps;

  const interval = setInterval(() => {
    if (__frameIdx >= totalFrames) {
      clearInterval(interval);
      console.log("✅ Overlay playback complete");
      if (onComplete) onComplete();
      return;
    }

    const frameData = frameArchive[__frameIdx];
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawOverlayFromSavedData(ctx, frameData);
    __frameIdx++;
  }, delay);
}


export function drawOverlayFromSavedData(ctx, frameData) {
  // Draw ball trail
  const trail = frameData.trail || [];
  ctx.strokeStyle = 'rgba(255, 255, 0, 0.7)';
  ctx.lineWidth = 2;
  for (let i = 1; i < trail.length; i++) {
    const prev = trail[i - 1];
    const curr = trail[i];
    ctx.beginPath();
    ctx.moveTo(prev.x, prev.y);
    ctx.lineTo(curr.x, curr.y);
    ctx.stroke();
  }

  // Draw pose keypoints
  const keypoints = frameData.keypoints || [];
  keypoints.forEach(kp => {
    if (kp?.score > 0.5) {
      ctx.beginPath();
      ctx.arc(kp.x, kp.y, 10, 0, 2 * Math.PI);   // set pose keypoint size & color
      ctx.fillStyle = 'magenta';
      ctx.fill();
    }
  });

  // Draw hoop
  const hoop = frameData.hoop;
  if (hoop) {
    ctx.beginPath();
    ctx.fillStyle = 'lime';
    ctx.moveTo(hoop.x, hoop.y);
    ctx.lineTo(hoop.x - 10, hoop.y + 14);
    ctx.lineTo(hoop.x + 10, hoop.y + 14);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'red';
    ctx.beginPath();
    ctx.moveTo(hoop.x - 40, hoop.y);
    ctx.lineTo(hoop.x + 40, hoop.y);
    ctx.stroke();
  }
}

// 🔄 Sync video and canvas resolution
export function syncOverlayToVideo() {
  const video   = document.getElementById("videoPlayer");
  const overlay = document.getElementById("overlay");
  if (!video || !overlay) return;

  const vw = video.videoWidth  || video.clientWidth  || 0;
  const vh = video.videoHeight || video.clientHeight || 0;

  overlay.width = vw;  overlay.height = vh;
  video.width   = vw;  video.height   = vh;

  overlay.style.position = 'absolute';
  overlay.style.left = '0';
  overlay.style.top  = '0';
  overlay.style.zIndex = '10'; // make sure it's above the video, below HUD

  // 👇 only force 'none' when NOT picking
  if (!window.__pickingHoop) {
    overlay.style.setProperty('pointer-events', 'none', 'important');
    overlay.style.cursor = 'default';
  }
  console.log("✅ Canvas & video locked:", vw, vh);
}


// ✅ Call this each frame
export function updateDebugOverlay(poses, objects, __frameIdx = null) {
  const debugBox = window.__debugBox;
  if (!debugBox) return;

  const poseStatus = poses?.length ? '🟢 Pose Detected' : '🔴 No Pose';
  const ballFound = objects?.some(o => o.label === 'basketball');
  const ballStatus = ballFound ? '🏀 Ball Found' : '⭕ Ball Missing';

  const frameLine = __frameIdx !== null ? `<br>🧠 Frame: ${__frameIdx}` : '';
  debugBox.innerHTML = `${poseStatus}<br>${ballStatus}${frameLine}`;
}

