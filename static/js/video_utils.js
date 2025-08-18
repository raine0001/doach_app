// video_utils.js — Video Scaling, Canvas Sync, and Shot Analysis

import { drawLiveOverlay } from './fix_overlay_display.js';
import {getLockedHoopBox, drawHoopMarker, stabilizeLockedHoop, isUserLocked, autoDetectHoop} from './hoop_tracker.js';
import { updateBall, ballState, attachHoop, markRelease } from './ball_tracker.js';
import {playerState} from './player_tracker.js';


// ✅ Fixed canvas resolution (for internal logic)
export const CANVAS_WIDTH = 1920;
export const CANVAS_HEIGHT = 1080;

// ✅ Define global timestamp manager + sync util in video_utils.js
let lastValidTimestamp = performance.now();

export function syncTimestampWithVideo(video) {
  if (!video) return;
  lastValidTimestamp = Math.max(lastValidTimestamp, video.currentTime * 1000 + 1);
  // console.log("🕓 Synced timestamp to", Math.round(lastValidTimestamp));
}


/**
 * Return scaling ratios from native video size to display dimensions
 */
export function getVideoToCanvasScale(videoEl) {
  const displayWidth = videoEl.clientWidth;
  const displayHeight = videoEl.clientHeight;
  const scaleX = displayWidth / videoEl.videoWidth;
  const scaleY = displayHeight / videoEl.videoHeight;
  return { scaleX, scaleY };
}

/**
 * Get ratio between display and rendered canvas sizes
 */
export function getRenderedScale(videoEl, canvasEl) {
  const scaleX = canvasEl.clientWidth / videoEl.clientWidth;
  const scaleY = canvasEl.clientHeight / videoEl.clientHeight;
  return { scaleX, scaleY };
}

/**
 * Apply scale to object detection box: [x1, y1, x2, y2]
 */
export function applyBoxScale(box, scaleX, scaleY) {
  const [x1, y1, x2, y2] = box;
  return [x1 * scaleX, y1 * scaleY, x2 * scaleX, y2 * scaleY];
}

/**
 * Lock video to fixed canvas size for 1:1 overlay rendering
 */
export function constrainVideoToCanvas(videoEl) {
  videoEl.width = CANVAS_WIDTH;
  videoEl.height = CANVAS_HEIGHT;
  videoEl.style.width = `${CANVAS_WIDTH}px`;
  videoEl.style.height = `${CANVAS_HEIGHT}px`;
  videoEl.style.objectFit = 'fill';
  videoEl.style.position = 'absolute';
  videoEl.style.top = '0';
  videoEl.style.left = '0';
}

/**
 * Extract a frame from video for frame-by-frame analysis
 */
export function captureFrame(videoEl) {
  const canvas = Object.assign(document.createElement('canvas'), {
    width: CANVAS_WIDTH,
    height: CANVAS_HEIGHT
  });
  const ctx = canvas.getContext('2d');
  ctx.drawImage(videoEl, 0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  return canvas;
}

// 🔁 Main slow-mo overlay + shot analysis loop (used by playShotSlowMo)
let lastRimCrossFrameId = -1;
let pendingFreezeFrame = null;
let lastShotFrameId = -1;
let ballTrackingStarted = false;


export function animateOverlayLoop(frame) {
  if (window.__videoAnalyzing) return;
  if (!frame) return;

  const ctx = window.getOverlayContext?.();
  const overlay = document.getElementById('overlay');
  const promptBar = document.getElementById('promptBar');
  const idx = (frame.__frameIdx ?? frame.frameIndex ?? 0);

  // latest detections for debug/UI
  window.lastDetectedFrame = frame;
  const objects = frame.objects || [];

  // Keep the hoop steady and draw marker
  stabilizeLockedHoop(objects);
  const lockedHoopBox = getLockedHoopBox();
  if (lockedHoopBox) attachHoop(lockedHoopBox);
  if (lockedHoopBox && ctx) drawHoopMarker(ctx);

  // One‑time auto‑lock if user hasn’t set it
  if (!lockedHoopBox && !isUserLocked() && !window.__hoopAutoLocked) {
    const sawHoop = objects.some(o => o.label === 'hoop');
    if (sawHoop) {
      autoDetectHoop(objects, overlay);
      window.__hoopAutoLocked = true;
      console.log('✅ Auto-locked hoop once.');
    }
  }

  // Prompt to set hoop if still missing
  if (!getLockedHoopBox() && promptBar) {
    promptBar.innerText = '⛔ Please click to set the hoop.';
  }

  // Draw overlay (player box, trails, frozen shots, etc.)
  drawLiveOverlay(objects, playerState);

  // Ball tracking + proximity-driven shot flow
  const ball = objects.find(o => o.label === 'basketball');
  if (ball && lockedHoopBox) {
    updateBall(ball, idx);

    // (optional) net motion flag if you have a processing canvas available
    const sourceCanvas =
      document.getElementById('processingCanvas') ||
      document.getElementById('videoCanvas') ||
      null;
    if (sourceCanvas) {
      ballState.netMoved = detectNetMotion(sourceCanvas, lockedHoopBox);
      drawNetMotionStatus(sourceCanvas, ballState.netMoved);
    }

    // 💡 Single source of truth for shot start/end + scoring
    checkShotConditions(ballState, lockedHoopBox, idx);
  } else if (!ball) {
    console.warn(`⚠️ No ball found in frame ${idx}`);
  }

  console.log(`🧠 Frame ${idx} — Objects: ${objects.length}, Pose: ${playerState.keypoints?.length ?? 0}`);

}





