// ✅ hoop_tracker.js — Clean and Unified
import { canonHoop } from './shot_utils.js';

let _locked = null;
let selectedHoop = null;
let lockedHoopBox = null;
let manualHoopLocked = false;
let anchorLockActive = false;
let recentHoopMidpoints = [];
const FRAME_BUFFER = 6;

window.isUserLocked = isUserLocked;

export function handleHoopSelection(e, overlay, lastFrame, promptBar) {
  const rect = overlay.getBoundingClientRect();
  const scaleX = overlay.width / rect.width;
  const scaleY = overlay.height / rect.height;
  const x = (e.clientX - rect.left) * scaleX;
  const y = (e.clientY - rect.top) * scaleY;

  const candidates = lastFrame?.objects?.filter(o => o.label === 'hoop') || [];
  if (candidates.length) {
    selectedHoop = candidates.reduce((closest, obj) => {
      const [x1, y1, x2, y2] = obj.box;
      const cx = (x1 + x2) / 2;
      const cy = (y1 + y2) / 2;
      const dist = Math.hypot(cx - x, cy - y);
      return dist < closest.dist ? { x: cx, y: cy, dist } : closest;
    }, { x, y, dist: Infinity });
  } else {
    selectedHoop = { x, y };
  }

  lockHoopToSelected(selectedHoop.x, selectedHoop.y);

  if (promptBar) {
    promptBar.innerText = '';
    promptBar.style.display = 'none';
  }
  const overlayPrompt = document.getElementById('overlayPrompt');
  if (overlayPrompt) overlayPrompt.style.display = 'none';

  if (typeof window.drawLiveOverlay === 'function') {
    window.drawLiveOverlay(lastFrame?.objects || [], window.playerState);
  }

  safelyReassignHoop(overlay, lastFrame);
}

export function lockHoopToSelected(x, y) {
  anchorLockActive = true;
  recentHoopMidpoints = [{ x, y }];
  lockedHoopBox = { x, y, w: 80, h: 40 };
  manualHoopLocked = true;
  window.lockedHoopBox = lockedHoopBox;
  window.__hoopAutoLocked = true;
  console.log("🎯 Locked hoop to:", x, y);
}

export function stabilizeLockedHoop(objects) {
  if (!anchorLockActive || !lockedHoopBox) return;

  const candidates = objects.filter(o => o.label === 'hoop' && o.box?.length === 4);
  if (!candidates.length) return;

  const closest = candidates.map(o => {
    const [x1, y1, x2, y2] = o.box;
    const cx = (x1 + x2) / 2;
    const cy = (y1 + y2) / 2;
    const dist = Math.hypot(cx - lockedHoopBox.x, cy - lockedHoopBox.y);
    return { x: cx, y: cy, dist };
  }).sort((a, b) => a.dist - b.dist)[0];

  if (closest.dist < 150) {
    recentHoopMidpoints.push({ x: closest.x, y: closest.y });
    if (recentHoopMidpoints.length > FRAME_BUFFER)
      recentHoopMidpoints = recentHoopMidpoints.slice(-FRAME_BUFFER);

    const avgX = recentHoopMidpoints.reduce((sum, p) => sum + p.x, 0) / recentHoopMidpoints.length;
    const avgY = recentHoopMidpoints.reduce((sum, p) => sum + p.y, 0) / recentHoopMidpoints.length;

    lockedHoopBox.x = avgX;
    lockedHoopBox.y = avgY;
    // console.log("📍 Smoothed hoop lock →", Math.round(avgX), Math.round(avgY));
  }
}


export function setLockedHoop(raw) {
  _locked = canonHoop(raw);        // store center form
}

export function getLockedHoopBox() {
  return lockedHoopBox;
}

export function isUserLocked() {
  return manualHoopLocked;
}

export function getHoopRegionBox(padding = 40) {
  const hoop = getLockedHoopBox();
  if (!hoop) return null;
  return {
    x1: hoop.x - padding,
    x2: hoop.x + padding,
    y1: hoop.y - padding,
    y2: hoop.y + padding
  };
}

export function getHoopCenter() {
  const hoop = getLockedHoopBox();
  return hoop ? { x: hoop.x, y: hoop.y } : null;
}

export function drawHoopMarker(ctx) {
  const hoop = getLockedHoopBox();
  if (!hoop || !ctx) return;

  ctx.save();
  ctx.beginPath();
  ctx.fillStyle = 'lime';
  ctx.moveTo(hoop.x, hoop.y);
  ctx.lineTo(hoop.x - 10, hoop.y + 14);
  ctx.lineTo(hoop.x + 10, hoop.y + 14);
  ctx.closePath();
  ctx.fill();
  ctx.font = 'bold 12px sans-serif';
  ctx.fillText('🎯 Rim Center', hoop.x + 12, hoop.y);
  ctx.strokeStyle = 'red';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(hoop.x - 40, hoop.y);
  ctx.lineTo(hoop.x + 40, hoop.y);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,0,0,0.3)';
  ctx.strokeRect(hoop.x - hoop.w / 2, hoop.y - hoop.h / 2, hoop.w, hoop.h);
  ctx.restore();
}

export function safelyReassignHoop(overlay, lastFrame) {
  const video = document.getElementById("videoPlayer");
  if (!video || video.paused) return;

  video.pause();
  setTimeout(() => {
    const __frameIdx = Math.floor(video.currentTime * 30);
    const ctx = overlay.getContext('2d');
    ctx.drawImage(video, 0, 0, overlay.width, overlay.height);

    if (window.safeDetectForVideo && window.poseDetector) {
      window.safeDetectForVideo(overlay, __frameIdx).then((result) => {
        if (result?.landmarks?.length) {
          window.lastDetectedFrame.poses = result.landmarks;
          if (typeof window.drawLiveOverlay === 'function') {
            window.drawLiveOverlay(window.lastDetectedFrame.objects || [], window.playerState);
          }
        }
        video.play();
      });
    } else {
      console.warn("⚠️ safeDetectForVideo not ready");
      video.play();
    }
  }, 100);
}

// autoDetectHoop for fallback compatibility
export function autoDetectHoop(objects, overlay, force = false) {
  if (!force && isUserLocked()) return;

  const candidates = objects?.filter(o => o.label === 'hoop') || [];
  if (!candidates.length) return;

  const best = candidates.reduce((closest, obj) => {
    const [x1, y1, x2, y2] = obj.box;
    const cx = (x1 + x2) / 2;
    const cy = (y1 + y2) / 2;
    const dist = Math.hypot(cx - overlay.width / 2, cy - overlay.height / 2);
    return dist < closest.dist ? { x: cx, y: cy, dist } : closest;
  }, { x: 0, y: 0, dist: Infinity });

  lockHoopToSelected(best.x, best.y);
  console.log("🎯 Auto-selected hoop center:", best.x, best.y);
}
