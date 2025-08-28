// fix_Overlay_Display.js

import { drawPoseSkeleton, drawWristTrail } from './player_tracker.js';
import { drawHoopProximityDebug, drawShotTubeDebug } from './shot_logger.js';
import { getLockedHoopBox } from './hoop_tracker.js';
import { drawBallTrails } from './ball_tracker.js';
import { drawFinalShotSummary } from './shot_utils.js';

export const USE_LOCAL_WORKER = true;
const DETECT_EVERY = 2; // run detect every 2 frames (~15 Hz if video is 30 fps)
if (!window.__detCache) window.__detCache = { objects: [], frameIndex: -1, _source: 'init' };

let overlay = null;
let ctx = null;
let poseDetector = null;
let lastDetectedFrame = {};
let canvasRecorder = null;
let recordedChunks = [];
let recordingActive = false;

window.__pickingHoop = false;

// worker toggle from console: window.__forceServerDetect = true;
if (typeof window.__forceServerDetect === 'undefined') {
  window.__forceServerDetect = false;
}

// safe pose detector wrapper helper
if (typeof window.safeDetectForVideo !== 'function') {
  window.safeDetectForVideo = async function safeDetectForVideo(canvasOrVideo, frameIndex) {
    try {
      if (!window.poseDetector) return null;
      const src = canvasOrVideo || document.getElementById('videoPlayer');
      const ts  = (typeof window.nextPoseTS === 'function') ? window.nextPoseTS() : performance.now();
      return await window.poseDetector.detectForVideo(src, ts);
    } catch (e) {
      console.warn('safeDetectForVideo error:', e);
      return null;
    }
  };
}


// initialize and display overlay
export function initOverlay(canvas, detector = null) {
  if (!canvas) {
    console.warn("⚠️ initOverlay: no canvas");
    return;
  }

  overlay = canvas;
  poseDetector = detector || window.poseDetector || null;
  overlay.style.position = 'absolute';

  const video = document.getElementById('videoPlayer');
  if (video?.videoWidth && video?.videoHeight) {
    overlay.width  = video.videoWidth;
    overlay.height = video.videoHeight;
    ctx = overlay.getContext('2d');
  } else {
    // video not ready yet; get a context anyway
    ctx = overlay.getContext('2d');
    console.warn("⚠️ initOverlay: video metadata not ready; will resize later in drawLiveOverlay");
  }

  // expose for other modules, even if detector isn't ready yet
  window.drawLiveOverlay   = drawLiveOverlay;
  window.getOverlayContext = () => ctx;
}


// helper to toggle clickability
export function setOverlayClickable(on) {
  overlay = overlay || document.getElementById('overlay');
  if (!overlay) return;
  overlay.style.pointerEvents = on ? 'auto' : 'none';
  overlay.style.cursor = on ? 'crosshair' : 'default';
}
window.setOverlayClickable = setOverlayClickable;


// ------------------------------------------------------//
// Core function for rendering overlays -----------------//
// ------------------------------------------------------//
// Core function for rendering overlays — single pixel space (video pixels), no jitter
export function drawLiveOverlay(objects = [], playerState) {
  const video   = document.getElementById('videoPlayer');
  const overlay = document.getElementById('overlay');
  if (!ctx || !overlay || !video || !window.__VIEW) return;

  const { vw, vh, renderW, renderH, scale, dpr } = window.__VIEW;
  if (!renderW || !renderH || !vw || !vh) return;

  // draw in VIDEO pixel coordinates scaled to the rendered size
  ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
  ctx.clearRect(0, 0, vw, vh);   // clear in video pixels

  // ---- active player ----
  try {
    const ap = window.activePlayerBox;
    if (ap) {
      ctx.save();
      ctx.strokeStyle = 'deepskyblue';
      ctx.lineWidth = 4 / scale;  // keep roughly constant thickness
      ctx.strokeRect(ap.x, ap.y, ap.w, ap.h);
      ctx.restore();
    }
  } catch {}

  // ---- pose ----
  const keypoints = playerState?.keypoints;
  const validPose = Array.isArray(keypoints) && keypoints.length >= 33 &&
                    keypoints.every(kp => kp && Number.isFinite(kp.x) && Number.isFinite(kp.y));
  if (validPose) {
    drawPoseSkeleton(ctx, keypoints);
    drawWristTrail(ctx);
  }

  // ---- shot visuals ----
  drawHoopProximityDebug(ctx);
  drawShotTubeDebug(ctx);
  if ((window.PREF_SHOW?.trails) !== false) drawBallTrails(ctx);
  drawFinalShotSummary(ctx);

  // ---- hoop marker ----
  const HB = getLockedHoopBox?.();
  if (HB) {
    ctx.save();
    ctx.setLineDash([4 / scale]);
    ctx.strokeStyle = 'lime';
    ctx.lineWidth   = 2 / scale;
    const x1 = HB.x - HB.w / 2;
    const y1 = HB.y - HB.h / 2;
    ctx.strokeRect(x1, y1, HB.w, HB.h);
    ctx.beginPath(); ctx.arc(HB.x, HB.y, 3 / scale, 0, Math.PI * 2);
    ctx.fillStyle = 'red'; ctx.fill();
    ctx.restore();
  }

  const ap = window.activePlayerBox || null;
  
  // ---- detections (respect visibility prefs) ----
  const show = (window.PREF_SHOW || {});
  for (const obj of (objects || [])) {
    if (!Array.isArray(obj.box) || obj.box.length !== 4) continue;
    const [x1, y1, x2, y2] = obj.box;
    const label = obj.label?.toLowerCase?.() || 'unknown';

    // Skip detection 'player' box if we already draw the active player box
    if (label === 'player' && ap) continue;

    if (label === 'player'     && show.player     === false) continue;
    if (label === 'basketball' && show.ball       === false) continue;
    if (label === 'hoop'       && show.hoop       === false) continue;
    if (label === 'backboard'  && show.backboard  === false) continue;
    if (label === 'net'        && show.net        === false) continue;

    const color = { basketball: 'yellow', hoop: 'red', player: 'cyan', net: 'orange', backboard: 'magenta' }[label] || 'white';
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2 / scale;
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);

    // simple label (kept tiny to avoid perf hits)
    ctx.font = `${Math.max(10 / scale, 10)}px sans-serif`;
    ctx.fillStyle = color;
    ctx.fillText(label, x1 + 4, y1 - 6 / scale);

    const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
    ctx.beginPath(); ctx.arc(cx, cy, 3 / scale, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
}
// ------------------------------------------------------//


let isDetectingFrame = false;
const reusableYOLOCanvas = document.createElement("canvas");
const reusableYOLOCtx = reusableYOLOCanvas.getContext("2d");

// ------------------------------------------------------------------------------------//
//    Capture the *real* pixels and send to YOLO.
//   `src` can be the <video> element OR a canvas. We prefer <video>.
//    While a request is in flight, we return the last good objects to avoid flicker.
// ------------------------------------------------------------------------------------//
export async function sendFrameToDetectServer(canvas, frameIndex) {
  if (isDetectingFrame) {
    return { objects: [] };
  }
  isDetectingFrame = true;
  try {
    const video = document.getElementById("videoPlayer");
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return { objects: [] };

    reusableYOLOCanvas.width = vw;
    reusableYOLOCanvas.height = vh;
    reusableYOLOCtx.clearRect(0, 0, vw, vh);
    reusableYOLOCtx.drawImage(video, 0, 0, vw, vh);   // use raw frame

    const dataURL = reusableYOLOCanvas.toDataURL("image/jpeg", 0.5);
    const res = await fetch("/detect_frame", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ frame: dataURL, width: vw, height: vh }),
    });
    if (!res.ok) return { objects: [] };
    return await res.json(); // {objects:[], frameIndex?}
  } catch (e) {
    console.warn('server detect failed:', e);
    return { objects: [] };
  } finally {
    isDetectingFrame = false;
  }
}

// ---- Worker toggle (can be changed in console) ----
if (typeof window.__forceServerDetect === 'undefined') window.__forceServerDetect = false;

// ---- Worker bootstrap (kept simple; already in your file; keep your existing one if you prefer) ----
(function bootDetectorWorkerOnce() {
  if (window.__detBootstrapped) return;
  window.__detBootstrapped = true;
  try { window.__detWorker = new Worker('/static/js/detector.worker.js', { name: 'detector' }); } catch (e) { window.__detWorker = null; }
  window.__detReady   = false;
  window.__detPending = new Map();
  if (!window.__detWorker) return;

  window.__detWorker.onmessage = (e) => {
    const m = e.data || {};
    if (m.type === 'ready') { window.__detReady = true; return; }
    if (m.type === 'result') {
      const p = window.__detPending.get(m.frameIndex);
      if (p) { window.__detPending.delete(m.frameIndex); if (p.tid) clearTimeout(p.tid); p.resolve({ ...m, _source:'worker' }); }
      // update cache even if no one was waiting (late worker result)
      if (Array.isArray(m.objects)) window.__detCache = { objects: m.objects, frameIndex: m.frameIndex, _source: 'worker-late' };
      return;
    }
    if (m.type === 'debug') { console.log(m.msg); return; }
    if (m.type === 'error') console.warn('[detector.worker] Error:', m.error);
  };

  window.__detWorker.postMessage({
    type: 'init',
    modelUrl: '/static/models/best.onnx',
    fbUrl:    '/static/models/backup_best.onnx',
    labels:   ['basketball','hoop','net','backboard','player']
  });
})();

// ---- Server fallback helper ----
async function detectViaServer(canvas, frameIndex, OW, OH) {
  const c = document.createElement('canvas');
  c.width = OW; c.height = OH;
  c.getContext('2d').drawImage(canvas, 0, 0, OW, OH);
  const dataURL = c.toDataURL('image/jpeg', 0.6);
  try {
    const res = await fetch('/detect_frame', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ frame: dataURL, width: OW, height: OH })
    });
    if (!res.ok) return { objects: window.__detCache.objects, frameIndex, _source: 'server-error' };
    const out = await res.json();
    out._source = 'server';
    return out;
  } catch {
    // never return empty on failure — reuse cache
    return { objects: window.__detCache.objects, frameIndex, _source: 'server-fail' };
  }
}

// ---- Worker path helper (with backstop that returns cache, not empty) ----
async function detectViaWorker(canvas, frameIndex, OW, OH) {
  if (!window.__detWorker || !window.__detReady) throw new Error('worker-not-ready');
  const bmp = await createImageBitmap(canvas);
  const result = new Promise((resolve) => {
    const entry = { resolve, tid: null };
    entry.tid = setTimeout(() => {
      if (window.__detPending.has(frameIndex)) {
        window.__detPending.delete(frameIndex);
        // return cache on timeout (prevents flicker)
        resolve({ objects: window.__detCache.objects, frameIndex, _source: 'worker-timeout' });
      }
    }, 1500); // tolerant backstop
    window.__detPending.set(frameIndex, entry);
  });
  window.__detWorker.postMessage({ type:'detect', frameIndex, bitmap:bmp, ow:OW, oh:OH }, [bmp]);
  return result;
}

let __detBusy = false;
export async function sendFrameToDetect(canvas, frameIndex) {
  // reuse cache on frames we’re not sampling
  if (DETECT_EVERY > 1 && (frameIndex % DETECT_EVERY) !== 0) {
    return { objects: window.__detCache.objects, frameIndex, _source: 'cache-skip' };
  }

  if (__detBusy) {
    // if a detect is already in-flight, don’t stall — reuse cache
    return { objects: window.__detCache.objects, frameIndex, _source: 'cache-busy' };
  }

  __detBusy = true;
  try {
    const vid = document.getElementById('videoPlayer');
    const OW = vid?.videoWidth  || canvas.width;
    const OH = vid?.videoHeight || canvas.height;

    let out;
    if (!window.__forceServerDetect && window.__detWorker && window.__detReady) {
      out = await detectViaWorker(canvas, frameIndex, OW, OH);
    } else {
      out = await detectViaServer(canvas, frameIndex, OW, OH);
    }

    // update cache if we got something concrete
    if (Array.isArray(out.objects)) {
      window.__detCache = { objects: out.objects, frameIndex: out.frameIndex ?? frameIndex, _source: out._source || 'unknown' };
    }
    return out;
  } catch (e) {
    console.warn('[detect] exception:', e);
    return { objects: window.__detCache.objects, frameIndex, _source: 'exception-cache' };
  } finally {
    __detBusy = false;
  }
}



// ------------------------------------------------------------------------------------//

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

// Unified: compute "contain" layout, position elements, and size backing store.
// Also ensures correct stacking context, z-index, and pointer-event defaults.
// Stores mapping in window.__VIEW for drawing and input conversion.
export function syncOverlayToVideo() {
  const frame   = document.querySelector('.video-frame');
  const video   = document.getElementById('videoPlayer');
  const overlay = document.getElementById('overlay');
  if (!frame || !video || !overlay) return;

  // 1) Ensure stacking context
  const fs = getComputedStyle(frame);
  if (fs.position === 'static') frame.style.position = 'relative';

  // 2) Visible frame size (CSS px)
  const fr = frame.getBoundingClientRect();
  const FW = Math.max(1, Math.round(fr.width));
  const FH = Math.max(1, Math.round(fr.height));

  // 3) Native video size (video px)
  const vw = video.videoWidth  || 0;
  const vh = video.videoHeight || 0;

  // 4) "contain" rect for video inside frame
  let renderW = FW, renderH = FH, offL = 0, offT = 0, scale = 1;
  if (vw && vh) {
    scale   = Math.min(FW / vw, FH / vh);
    renderW = Math.round(vw * scale);
    renderH = Math.round(vh * scale);
    offL    = Math.round((FW - renderW) / 2);
    offT    = Math.round((FH - renderH) / 2);
  }

  // 5) Position video & overlay identically (CSS px)
  const place = (el, z) => {
    el.style.position = 'absolute';
    el.style.left   = offL + 'px';
    el.style.top    = offT + 'px';
    el.style.width  = renderW + 'px';
    el.style.height = renderH + 'px';
    if (z != null) el.style.zIndex = String(z);
  };
  place(video,    0);
  place(overlay,  100); // ensure overlay is above video (HUD can be > 100)

  // 6) Backing store for overlay = CSS size * DPR (for crisp drawing)
  const dpr   = window.devicePixelRatio || 1;
  const backW = Math.max(1, Math.round(renderW * dpr));
  const backH = Math.max(1, Math.round(renderH * dpr));
  if (overlay.width  !== backW)  overlay.width  = backW;
  if (overlay.height !== backH)  overlay.height = backH;

  // 7) Layering + pointer policy
  overlay.style.userSelect    = 'none';
  overlay.style.pointerEvents = (window.__pickingHoop ? 'auto' : 'none');

  // If we are picking, ensure the video does not steal events
  if (window.__pickingHoop) {
    video.style.pointerEvents = 'none';
  } else {
    video.style.pointerEvents = '';
  }

  // 8) Save mapping for draw + input conversion (video-pixel space)
  window.__VIEW = { vw, vh, renderW, renderH, offL, offT, scale, dpr };

  // 9) (Optional) Keep prompt/HUD boxes aligned to the video rect
  const prompt = document.getElementById('overlayPrompt');
  if (prompt) {
    prompt.style.position = 'absolute';
    // Put prompt just above the video top-left padding a bit
    prompt.style.left = (offL + 12) + 'px';
    prompt.style.top  = (offT + 12) + 'px';
    prompt.style.zIndex = '200';
  }
}


// Small utilities that benefit from the mapping:

// Convert a clientX/Y (from a pointer/click) to VIDEO pixel coords
export function clientToVideoXY(clientX, clientY) {
  const overlay = document.getElementById('overlay');
  const V = window.__VIEW;
  if (!overlay || !V?.scale) return { x: 0, y: 0 };
  const r = overlay.getBoundingClientRect();
  const cssX = clientX - r.left;
  const cssY = clientY - r.top;
  // css px -> video px: divide by scale and clamp to [0..vw/vh]
  const x = Math.max(0, Math.min(V.vw || 0, Math.round(cssX / V.scale)));
  const y = Math.max(0, Math.min(V.vh || 0, Math.round(cssY / V.scale)));
  return { x, y };
}

// Toggle overlay interactivity consistently (for hoop pick, etc.)
export function setOverlayInteractive(on) {
  const ov = document.getElementById('overlay');
  if (!ov) return;
  window.__pickingHoop = !!on;
  ov.style.pointerEvents = on ? 'auto' : 'none';
  ov.style.cursor = on ? 'crosshair' : 'default';
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

