// app.js with overlay drawing integrated
import { initOverlay, drawLiveOverlay, sendFrameToDetect, syncOverlayToVideo, updateDebugOverlay } from './fix_overlay_display.js';
import { resetShotStats, checkShotConditions, detectNetMotion, drawNetMotionStatus, bufferDetectedObjects, scoringTick, isBallInProximityZone, detectAndLogShot} from './shot_logger.js';
import { playerState, resetPlayerTracker, updatePlayerTracker, initPoseDetector, isPoseInReleasePosition } from './player_tracker.js';
import { stabilizeLockedHoop, getLockedHoopBox, handleHoopSelection } from './hoop_tracker.js';
import { createPlaybackControls } from './video_ui.js';
import { ballState, updateBall, resetAll, attachHoop, markRelease } from './ball_tracker.js';
import { asTopLeft } from './shot_utils.js';
import { mountPrefs } from './ui_prefs.js';


const H = getLockedHoopBox?.();     // center form now
if (H) attachHoop?.(asTopLeft(H));  // for ball_tracker

window.USE_FBF_DURING_SHOT = false;  // ensure only slow-mo is used

export const frameArchive = [];

window.madeShotSound = new Audio('/static/assets/swish.mp3');
window.missedShotSound = new Audio('/static/assets/miss_bounce.mp3');
window.lastDetectedFrame = { __frameIdx: 0, objects: [], poses: [] };

let isTracking = false;
let __stopAnalyze = null;

window.stopFrameAnalysis = () => { try { __stopAnalyze?.(); } finally { __stopAnalyze = null; } };
window.__analyzerActive = false;

// Pointer-events helper (off by default)
let _overlayEl = null;
export function setOverlayInteractive(on) {
  _overlayEl = _overlayEl || document.getElementById('overlay');
  if (!_overlayEl) return;
  _overlayEl.style.pointerEvents = on ? 'auto' : 'none';
}

// --- Non-blocking detection queue (latest-wins) ---
let __detBusy = false;
let __detLatest = null;
let __lastDetObjects = []; // consumed by analyzer loop

async function kickDetect(frameCanvas, frameIdx) {
  // store the most recent frame; drop older ones
  __detLatest = { canvas: frameCanvas, idx: frameIdx };
  if (__detBusy) return;

  __detBusy = true;
  try {
    while (__detLatest) {
      const job = __detLatest;
      __detLatest = null;
      try {
        const det = await sendFrameToDetect(job.canvas, job.idx);
        __lastDetObjects = det?.objects || [];
      } catch (e) {
        console.warn('[detect] frame inference failed:', e);
      }
    }
  } finally {
    __detBusy = false;
  }
}

//--------------------------------------------------------------//
//           ------  Initialize overlay elements  -----         //
//--------------------------------------------------------------//

// One-time hoop picker (tap once to lock the rim)
export function enableHoopPickOnce() {
  const ov  = document.getElementById('overlay');
  const vid = document.getElementById('videoPlayer');
  const promptEl =
    document.getElementById('overlayPrompt') ||
    document.getElementById('promptBar');

  if (!ov) return;
  if (window.__hoopConfirmed) return; // already picked this session

  // Ensure mapped sizing before reading rects
  try { syncOverlayToVideo?.(); } catch {}

  // Make only the canvas interactive
  window.__pickingHoop      = true;
  ov.style.pointerEvents    = 'auto';
  ov.style.cursor           = 'crosshair';
  ov.style.zIndex           = '100';
  if (vid) vid.style.pointerEvents = 'none';

  // Single handler (pointerdown works best on iOS)
  const pickOnce = (e) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      // Delegate actual lock + snap to hoop (if a hoop det exists) to hoop_tracker
      handleHoopSelection(e, ov, window.lastDetectedFrame, promptEl);

      // Flip flags
      window.__hoopConfirmed = true;
      window.__pickingHoop   = false;

      // Hide prompt
      if (promptEl) promptEl.style.display = 'none';

      // Restore pointer policies
      ov.style.cursor        = 'default';
      ov.style.pointerEvents = 'none';
      if (vid) vid.style.pointerEvents = '';

      // Immediate visual confirmation (draw once before starting analysis)
      try {
        const objs = window.lastDetectedFrame?.objects || [];
        window.drawLiveOverlay?.(objs, window.playerState);
      } catch {}

      // Start analysis on next paint (keeps the selection paint visible)
      requestAnimationFrame(() => window.startFrameAnalysis?.());
    } finally {
      ov.removeEventListener('pointerdown', pickOnce);
      ov.removeEventListener('click',       pickOnce);
    }
  };

  ov.addEventListener('pointerdown', pickOnce, { passive: false, once: true });
  ov.addEventListener('click',       pickOnce, { passive: true  });
}


// Optional: allow user to re-pick or cancel mid-pick
window.repickHoop = () => {
  window.__hoopConfirmed = false;
  window.__pickingHoop = false;
  enableHoopPickOnce();
};

window.cancelHoopPick = () => {
  window.__pickingHoop = false;
  const ov = document.getElementById('overlay');
  if (!ov) return;
  ov.style.cursor = 'default';
  // brute-force unbind in case handlers changed
  const clone = ov.cloneNode(true);
  ov.parentNode.replaceChild(clone, ov);
};


// Make sure the overlay sits above the video and can be toggled clickable
// --- Overlay CSS + click tracer (diagnostics) ---
// aligns with syncOverlayToVideo
function ensureOverlayCss() {
  const ov = document.getElementById('overlay');
  const vid = document.getElementById('videoPlayer');
  if (!ov || !vid) return;

  // Make the video’s parent a stacking context
  const anchor = vid.parentElement || document.body;
  if (getComputedStyle(anchor).position === 'static') {
    anchor.style.position = 'relative';
  }

  // Hard position/size overlay over the video
  ov.style.position = 'absolute';
  ov.style.left = '0';
  ov.style.top = '0';
  ov.style.width = vid.clientWidth + 'px';
  ov.style.height = vid.clientHeight + 'px';

  // keep drawing at native pixels
  if (vid.videoWidth && vid.videoHeight) {
    ov.width  = vid.videoWidth;
    ov.height = vid.videoHeight;
  }

  // Default: overlay does NOT eat clicks (we’ll enable only during pick)
  ov.style.userSelect = 'none';
  ov.style.zIndex = '10'; // below HUD (9999), above video
}


// Debug: click tracer for the overlay — logs CSS px + VIDEO px, pe/z, scale/dpr.
// Safe to call multiple times; call removeOverlayTracer() to unbind.
export function installOverlayTracer() {
  const ov = document.getElementById('overlay');
  if (!ov || ov.__tracerInstalled) return;
  ov.__tracerInstalled = true;

  // Helper: convert client → video px via window.__VIEW (from syncOverlayToVideo)
  function clientToVideoXY(clientX, clientY) {
    const V = window.__VIEW;
    if (!ov || !V?.scale) return { x: 0, y: 0 };
    const r = ov.getBoundingClientRect();
    const cssX = clientX - r.left;
    const cssY = clientY - r.top;
    // clamp to [0..vw/vh]
    const x = Math.max(0, Math.min(V.vw || 0, Math.round(cssX / V.scale)));
    const y = Math.max(0, Math.min(V.vh || 0, Math.round(cssY / V.scale)));
    return { x, y };
  }

  const onOverlayPD = (e) => {
    const cs = getComputedStyle(ov);
    const V  = window.__VIEW || {};
    const r  = ov.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right &&
                   e.clientY >= r.top  && e.clientY <= r.bottom;

    const videoXY = clientToVideoXY(e.clientX, e.clientY);
    // offsetX/offsetY are CSS-space; report both
    console.log('[ov:pointerdown]', {
      css: { x: e.offsetX, y: e.offsetY },
      video: videoXY,
      pe: cs.pointerEvents,
      z: cs.zIndex,
      scale: V.scale ?? 1,
      dpr: V.dpr ?? (window.devicePixelRatio || 1),
      inside
    });
  };

  const onDocPD = (e) => {
    // Quick “did we hit overlay bounds?” check
    const r = ov.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right &&
                   e.clientY >= r.top  && e.clientY <= r.bottom;

    // Only compute video coords if inside (noise reduction)
    const videoXY = inside ? clientToVideoXY(e.clientX, e.clientY) : null;

    console.log('[doc:pointerdown]', {
      target: e.target?.tagName ?? '(unknown)',
      insideOverlay: inside,
      video: videoXY
    });
  };

  ov.addEventListener('pointerdown', onOverlayPD);
  document.addEventListener('pointerdown', onDocPD, { capture: true });

  // Save cleanup so we can unbind later
  ov.__tracerCleanup = () => {
    try {
      ov.removeEventListener('pointerdown', onOverlayPD);
      document.removeEventListener('pointerdown', onDocPD, { capture: true });
    } catch {}
    delete ov.__tracerInstalled;
    delete ov.__tracerCleanup;
  };

  console.log('🧪 overlay tracer installed');
}

export function removeOverlayTracer() {
  const ov = document.getElementById('overlay');
  if (ov?.__tracerCleanup) {
    ov.__tracerCleanup();
    console.log('🧽 overlay tracer removed');
  }
}

// ─── Readiness gate for scoring / analysis ───────────────────────────────
window.__readyForScoring  = false;  // becomes true after stable warm frames
window.__detectorsWarmed  = false;  // flipped by your prewarm or first success
let __warmFrames          = 0;
let __coolFrames          = 0;

// knobs
const WARM_NEED  = 8;   // ~0.25s @ 30fps
const COOL_NEED  = 4;   // require a few misses before dropping ready

export function resetReadiness(reason = '') {
  __warmFrames = 0;
  __coolFrames = 0;
  window.__readyForScoring = false;
  // if (reason) console.log('[ready] reset:', reason);
}

/**
 * Call once per analysis tick AFTER lastDetectedFrame is updated.
 *  - require WARM_NEED consecutive good frames to become ready
 *  - require COOL_NEED consecutive bad frames to drop ready
 */
export function tickReadiness(objects, poses) {
  // --- Stable signals only ---
  const haveHoop = !!window.getLockedHoopBox?.();                         // rim is locked
  const havePose = Array.isArray(poses) ? poses.length > 0
                                         : !!window.playerState?.keypoints?.length;

  // DO NOT require ball here (ball is flaky at release/under rim)
  const good = haveHoop && havePose;

  // Shot-in-progress latch: don't "cool" while tracking a shot
  const inShot =
    !!window.__fbfActive ||                                  // frame-by-frame window (if enabled)
    !!(window.ballState && (
        window.ballState.releaseSignaled ||                  // we fired release
        window.ballState.state === 'TRACKING'                // trail is being built
    ));

  if (good) {
    __warmFrames++;
    __coolFrames = 0;

    if (!window.__readyForScoring && __warmFrames >= WARM_NEED) {
      window.__readyForScoring = true;
      window.__detectorsWarmed = true;
      console.log('[ready] ✅ armed (warm frames =', __warmFrames, ')');
    }
  } else {
    // Don't drop readiness while a shot is happening
    if (inShot) {
      __coolFrames = 0; // hold ready while the attempt is active
      return;
    }

    __coolFrames++;
    __warmFrames = 0;

    if (window.__readyForScoring && __coolFrames >= COOL_NEED) {
      window.__readyForScoring = false;
      console.log('[ready] ⛔ cooled (cool frames =', __coolFrames, ')');
    }
  }
}


// Convenience hooks you can call at the right times:
window.onNewVideoLoaded   = () => resetReadiness('new video');
window.onHoopRelocked     = () => resetReadiness('hoop changed');
window.onSeekOrPause      = () => resetReadiness('seek/pause');


// ───────────────────────────────────────────────────────────────
// Lightweight warm‑up for detector + pose (no overlay pollution)
// ───────────────────────────────────────────────────────────────
window.__detectorsWarmed = false;
let __prewarmToken = null;

/**
 * Warm the object detector and pose once, without touching the overlay.
 * Safe to call multiple times; it will no‑op for the same video source.
 */
export async function prewarmDetectors(videoEl) {
  if (!videoEl) return;

  // guard: per‑video token so we don’t re‑prewarm on the same source
  const token = videoEl.currentSrc || videoEl.srcObject || 'in-memory-stream';
  if (__prewarmToken === token && window.__detectorsWarmed) return;

  // make sure we have metadata & a decodable frame
  if (!Number.isFinite(videoEl.duration) || !(videoEl.videoWidth && videoEl.videoHeight)) {
    // rely on your loadedmetadata hook that already calls syncOverlayToVideo etc. :contentReference[oaicite:2]{index=2}
    await new Promise(r => requestAnimationFrame(r));
  }

  // Nudge off t=0 (MediaPipe timestamp guard) but restore afterward
  const originalT = videoEl.currentTime;
  let nudged = false;
  try {
    if (videoEl.currentTime === 0 && isFinite(videoEl.duration)) {
      videoEl.currentTime = Math.min(0.08, Math.max(0.01, videoEl.duration * 0.01));
      nudged = true;
      await new Promise(res => videoEl.addEventListener('seeked', res, { once: true }));
    }
  } catch {}

  // wait one paint so the decoder presents a real frame
  await new Promise(r => requestAnimationFrame(r));

  // tiny offscreen buffer to keep it fast
  const vw = Math.max(1, videoEl.videoWidth  || 640);
  const vh = Math.max(1, videoEl.videoHeight || 360);
  const w = Math.min(480, vw);
  const h = Math.max(1, Math.round(w * vh / vw));
  const tmp = document.createElement('canvas');
  tmp.width = w; tmp.height = h;
  try {
    const tctx = tmp.getContext('2d', { willReadFrequently: true });
    tctx.drawImage(videoEl, 0, 0, w, h);
  } catch {}

  // 1) one detector call (your sendFrameToDetect reads from a canvas) :contentReference[oaicite:3]{index=3}
  try {
    await sendFrameToDetect(tmp, -1);
  } catch {}

  // 2) one pose call on the <video> (your serialized wrapper) :contentReference[oaicite:4]{index=4}:contentReference[oaicite:5]{index=5}
  try {
    if (window.poseDetector?.detectForVideo && typeof window.safeDetectForVideo === 'function') {
      await poseDetectSerial?.(); // your app defines this to call detectForVideo safely
    }
  } catch {}

  // mark warmed and remember this source
  window.__detectorsWarmed = true;
  __prewarmToken = token;

  // restore time if we nudged
  try {
    if (nudged) {
      videoEl.currentTime = originalT;
      await new Promise(res => videoEl.addEventListener('seeked', res, { once: true }));
    }
  } catch {}

  // small settle delay
  await new Promise(r => setTimeout(r, 80));
}

// ───────────────────────────────────────────────────────────────
// Tiny ~#fps pre-detect loop to warm models & seed readiness
// Stops automatically when __readyForScoring OR analyzer starts.
// ───────────────────────────────────────────────────────────────
const __preDet = { on:false, raf:0, frame:0 };

export function startPreDetection(videoEl) {
  if (!videoEl || __preDet.on) return;
  __preDet.on = true;
  __preDet.frame = 0;

  const buf  = document.createElement('canvas');
  const bctx = buf.getContext('2d', { willReadFrequently: true });

  function syncSize() {
    const vw = videoEl.videoWidth, vh = videoEl.videoHeight;
    if (!vw || !vh) return false;
    if (buf.width !== vw || buf.height !== vh) { buf.width = vw; buf.height = vh; }
    return true;
  }

  const tick = async () => {
    if (!__preDet.on) return;

    // If the main analyzer has taken over, stop warmup
    if (window.__analyzerActive) { stopPreDetection(); return; }

    try {
      if (syncSize()) {
        bctx.drawImage(videoEl, 0, 0, buf.width, buf.height);

        // Detection path: prefer non-blocking queue if present, else await direct call
        let objects = [];
        if (typeof kickDetect === 'function') {
          // fire-and-forget; consume whatever latest results exist
          kickDetect(buf, __preDet.frame);
          if (Array.isArray(window.__lastDetObjects)) objects = window.__lastDetObjects;
        } else {
          // direct, blocking detect for warmup is OK at ~10fps
          const det = await sendFrameToDetect(buf, __preDet.frame).catch(() => ({ objects: [] }));
          objects = det?.objects || [];
        }

        // Pose (serialized inside poseDetectSerial)
        const poseRes = await (async () => {
          try { return await poseDetectSerial?.(); } catch { return null; }
        })();
        const poses = poseRes?.landmarks || [];

        // Expose so overlay/debug can render something pre-ready
        window.lastDetectedFrame = { frameIndex: __preDet.frame, objects, poses };
        bufferDetectedObjects?.(objects);
        drawLiveOverlay?.(objects, window.playerState);
        updateDebugOverlay?.(poses, objects, __preDet.frame);

        // Advance readiness gate; will flip __readyForScoring when stable
        tickReadiness?.(objects, poses);

        // Stop as soon as we’re ready (or analyzer has started)
        if (window.__readyForScoring) { stopPreDetection(); return; }
      }
    } catch (e) {
      console.warn('[predet] error', e);
      // Fail-safe: stop to avoid log spam
      stopPreDetection();
      return;
    }

    __preDet.frame++;
    // ~10fps cadence with rAF alignment
    setTimeout(() => { __preDet.raf = requestAnimationFrame(tick); }, 100);
  };

  __preDet.raf = requestAnimationFrame(tick);
}

export function stopPreDetection() {
  __preDet.on = false;
  if (__preDet.raf) {
    try { cancelAnimationFrame(__preDet.raf); } catch {}
  }
  __preDet.raf = 0;
}

// ──────────────────────────  end pre detection logic


// ---- Boot & event wires ----
document.addEventListener('DOMContentLoaded', () => {
  const videoPlayer = document.getElementById('videoPlayer');
  const videoInput  = document.getElementById('videoInput');
  const overlay     = document.getElementById('overlay');
  const frameEl     = document.querySelector('.video-frame');
  const ctx = overlay ? overlay.getContext('2d', { willReadFrequently: true }) : null;


  if (frameEl && getComputedStyle(frameEl).position === 'static') {
    frameEl.style.position = 'relative';
  }

  // mount the ⚙️ preferences on the frame (optional)
  try { mountPrefs?.(frameEl || document.body); } catch {}

  // one true start function (idempotent)
  window.startFrameAnalysis = async () => {
    if (!getLockedHoopBox?.()) {
      // refuse to start; surface prompt
      const prompt = document.getElementById('overlayPrompt');
      if (prompt) { prompt.textContent = '📍 Tap the hoop to begin setup'; prompt.style.display = 'block'; }
      return;
    }
    // stop any warmup and pre-detect loops
    try { stopPreDetection?.(); } catch {}
    // analyze (your loop is already idempotent via window.__analyzerActive)
    window.analyzeVideoFrameByFrame?.(videoPlayer, overlay);
  };

  // metadata → size map + warmup
  videoPlayer.addEventListener('loadedmetadata', async () => {
    syncOverlayToVideo();

    // warm once per source
    try {
      await prewarmDetectors?.(videoPlayer);
      window.__detectorsWarmed = true;
    } catch {}

    // optional: keep a light 10fps pre-detect running until ready
    try { startPreDetection?.(videoPlayer); } catch {}
  }, { once: true });

  // Keep overlay in sync on resize / layout
  const resync = () => syncOverlayToVideo();
  window.addEventListener('resize', resync, { passive: true });
  try { new ResizeObserver(resync).observe(frameEl); } catch {}
  try { new ResizeObserver(resync).observe(videoPlayer); } catch {}
  document.addEventListener('fullscreenchange', resync);

  // Pause → stop analysis + pre-detect, reset readiness a bit
  videoPlayer.addEventListener('pause', () => {
    isTracking = false;
    try { stopPreDetection?.(); } catch {}
    try { window.stopFrameAnalysis?.(); } catch {}
    try { window.onSeekOrPause?.(); } catch {}
  });

  // Auto-pause when tab hidden
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      try { videoPlayer.pause(); } catch {}
    }
  });

  // Toggle play gate: require hoop lock (and optionally the prompt function if present)
  window.togglePlay = () => {
    const hoopLocked = !!getLockedHoopBox?.();
    if (!hoopLocked) {
      const prompt = document.getElementById('overlayPrompt');
      if (prompt) { prompt.textContent = '📍 Tap the hoop to begin setup'; prompt.style.display = 'block'; }
      videoPlayer.pause();
      return;
    }
    videoPlayer.paused ? videoPlayer.play() : videoPlayer.pause();
  };

  // Play → enforce gate & start analysis
  videoPlayer.addEventListener('play', () => {
    const hoopLocked = !!getLockedHoopBox?.();
    console.log('[gate check]', {
      hasHoop: hoopLocked,
      warmed: !!window.__detectorsWarmed,
      ready: !!window.__readyForScoring
    });
    if (!hoopLocked) { videoPlayer.pause(); return; }
    console.log('▶️ Video playback started');
    window.startFrameAnalysis?.();
  });

  // Seek → small readiness reset (useful for scrub/step)
  videoPlayer.addEventListener('seeked', () => {
    try { window.onSeekOrPause?.(); } catch {}
  });

  // Uploads
  videoInput?.addEventListener('change', (e) => window.handleVideoUpload?.(e));
});


//--------------------------------------------------------------//
//     ----- Initialize the video player and overlay -----      //
//--------------------------------------------------------------//
window.handleVideoUpload = async function (event) {
  const file = event?.target?.files?.[0];
  if (!file) return;

  const video  = document.getElementById('videoPlayer');
  const prompt = document.getElementById('overlayPrompt');
  const overlayEl = document.getElementById('overlay');
  if (!video || !overlayEl) { console.error('[load] missing video/overlay'); return; }

  // ensure we have the overlay element in this scope
  // essential in selecting the hoop
  if (!overlayEl) {
    console.error('[load] overlay canvas not found');
    return;
  }
  // expose if other modules reference window.overlayEl
  window.overlayEl = overlayEl;

  // stop any previous analysis loop
  window.stopFrameAnalysis?.();

  // Reset session + readiness
    try { resetAll?.(); } catch {}
    try { resetPlayerTracker?.(); } catch {}
    try { resetShotStats?.(); } catch {}
    try { resetReadiness?.('new upload'); } catch {}   // from our readiness gate
  

  // Clean up old blob, if any
  try {
    if (window.__videoBlobURL) URL.revokeObjectURL(window.__videoBlobURL);
  } catch {}
  window.__videoBlobURL = URL.createObjectURL(file);

  console.log('[load] begin', { name: file.name, size: file.size });

  // Prepare player
  try { video.pause(); } catch {}
  video.removeAttribute('src');                    // avoid stale source races
  video.preload = 'metadata';
  video.src = window.__videoBlobURL;
  video.load();

  // on metadata, make sure overlay sizing/z-index is correct
  // required to select hoop
  const onMeta = () => {
    ensureOverlayCss();          // positions .video-frame relative, etc.
    installOverlayTracer?.();    // optional visual tracer
  };
  video.addEventListener('loadedmetadata', onMeta, { once: true });

  // wait up to 10s for metadata
  await Promise.race([
    new Promise(res => video.addEventListener('loadedmetadata', res, { once: true })),
    new Promise((_, rej) => setTimeout(() => rej(new Error('metadata timeout')), 10000))
  ]);

  // after metadata
  try {
    ensureOverlayCss?.();

    // ✅ init overlay WITHOUT a fake detector — pose attaches later
    initOverlay?.(overlayEl);

    // optional pre-detect warmup, if you’ve got it
    try { startPreDetection?.(video); } catch (e) {
      console.warn('predetect start failed:', e);
    }
  } catch (e) {
    console.warn('initOverlay failed:', e);
  }

  // Define analysis start bound to this video/overlay
    window.startFrameAnalysis = () => {
      if (!getLockedHoopBox?.()) {
        console.warn('[analyze] not starting: hoop not locked');
        return;
      }
      try { stopPreDetection?.(); } catch {}
      console.log('[analyze] starting main loop…');
      window.analyzeVideoFrameByFrame?.(video, overlayEl);
    };

  console.log('[load] metadata', {
    w: video.videoWidth, h: video.videoHeight, dur: video.duration,
    ready: video.readyState, src: video.currentSrc
  });

  // (re)apply CSS and tracer (harmless if called twice)
  ensureOverlayCss();
  try { installOverlayTracer?.(); } catch {}

  // required for hoop selection
  // 🟢 arm the one-shot hoop picker and show the prompt
  if (prompt) {
    prompt.textContent = '📍 Tap the hoop to begin setup';
    prompt.style.display = 'block';
  }
  // avoid double-binding if called again
  if (!window.__hoopPickArmed) {
    enableHoopPickOnce();
    window.__hoopPickArmed = true;
  }

  // mini controls overlay
  try { createPlaybackControls?.(video); } catch {}
};


// ───────────────────────────────────────────────────────────────
// Analyzer (event-driven, no time-warping of the video element)
// ───────────────────────────────────────────────────────────────

// ========= globals =========
let __analyzing = false;
let __frameIdx  = 0;
let __detachAnalysis = null;

window.__analyzerActive = false;

// Pose timestamp broker + serialized wrapper
window.__poseTS = Math.floor(performance.now());
function nextPoseTS() {
  const base = Math.floor(performance.now());
  window.__poseTS = Math.max(window.__poseTS + 1, base);
  return window.__poseTS;
}

// ---- SUPPORT: serialized pose wrapper (keep once globally) ----
let __poseBusy = false;
export async function poseDetectSerial() {
  if (!window.poseDetector || __poseBusy) return null;
  __poseBusy = true;
  try {
    const video = document.getElementById('videoPlayer');
    if (!video?.videoWidth) return null;
    const ts = window.nextPoseTS ? window.nextPoseTS() : Math.floor(performance.now());
    return await window.poseDetector.detectForVideo(video, ts);
  } catch (e) {
    console.warn('pose detect error:', e);
    return null;
  } finally {
    __poseBusy = false;
  }
}
window.poseDetectSerial = poseDetectSerial;

// lifecycle
window.stopFrameAnalysis = function stopFrameAnalysis() {
  try { if (typeof __detachAnalysis === 'function') __detachAnalysis(); }
  finally {
    __detachAnalysis = null;
    __analyzing = false;
    window.__analyzerActive = false;
  }
};

// startTracking: kicks analyzer for #videoPlayer + #overlay
window.startTracking = function startTracking() {
  const v = document.getElementById('videoPlayer');
  const o = document.getElementById('overlay');
  if (!v || !o) { console.warn('[analyze] missing video/overlay'); return; }
  window.analyzeVideoFrameByFrame(v, o);
};
window.stopTracking = window.stopFrameAnalysis;

// optional legacy “real-time” hook (off by default)
window.useRealTimeTracking = false;
(function attachRealtimePlayHook() {
  const v = document.getElementById('videoPlayer');
  if (!v) return;
  v.addEventListener('play', () => {
    if (window.useRealTimeTracking) {
      try { window.startTracking(); } catch {}
    }
  });
})();

// -------- Shot-window Frame-By-Frame analyzer (release → below-net) --------
// Guarantees one detection per source frame.
// Pauses at release, processes current frame, steps currentTime by 1/fps,
// waits for the *next* decoded frame (seeked or RVFC), repeats.
// Exits immediately on 'shot:summary', restarts RVFC analyzer.
window.USE_FBF_DURING_SHOT = true;        // keep true for dense arc
window.FBF_VISUAL_FPS      = 5;           // visual pacing, analysis is still per-frame

(function installShotWindowFBF(){
  let cancelFBF = null;
  window.__fbfActive = false;

  function getVid() { return window.__videoEl || document.getElementById('videoPlayer') || document.querySelector('video'); }
  function getCan() { return document.getElementById('overlay') || document.getElementById('videoCanvas') || window.videoCanvas; }
  function getFPS() { return Number(window.__videoFPS) > 0 ? Number(window.__videoFPS) : 30; }

  // Wait for the next decoded/presented frame AFTER we set currentTime.
  // If paused (our FBF mode), 'seeked' is the reliable signal.
  function waitForNextDecodedFrame(videoEl) {
    return new Promise(resolve => {
      let done = false;
      const finish = () => { if (!done) { done = true; cleanup(); resolve(); } };

      // Always listen for 'seeked' (we step by seeking).
      const onSeeked = () => finish();
      videoEl.addEventListener('seeked', onSeeked, { once: true });

      // If playing (shouldn't be during FBF), an RVFC can also indicate present.
      let rvfcId = null;
      if (!videoEl.paused && 'requestVideoFrameCallback' in HTMLVideoElement.prototype) {
        try { rvfcId = videoEl.requestVideoFrameCallback(() => finish()); } catch {}
      }

      // Hard fallback (just in case)
      const to = setTimeout(() => finish(), 250);

      function cleanup() {
        videoEl.removeEventListener('seeked', onSeeked);
        if (rvfcId != null) { try { videoEl.cancelVideoFrameCallback(rvfcId); } catch {} }
        clearTimeout(to);
      }
    });
  }

  async function stepOnce(videoEl, canvasEl, frameIdx, buf, bctx) {
    if (buf.width !== canvasEl.width || buf.height !== canvasEl.height) { buf.width = canvasEl.width; buf.height = canvasEl.height; }
    bctx.drawImage(videoEl, 0, 0, buf.width, buf.height);

    // Detect THIS frame
    const det = await sendFrameToDetect(buf, frameIdx).catch(() => ({ objects: [] }));
    const objects = det?.objects || [];

    // Pose (serialized)
    const poseRes = await (async () => { try { return await poseDetectSerial?.(); } catch { return null; } })();
    const poses   = poseRes?.landmarks || [];

    // Hoop + player
    const hoopBox = getLockedHoopBox?.();
    stabilizeLockedHoop?.(objects);
    updateActivePlayer?.(objects, frameIdx, canvasEl.width, canvasEl.height);
    const chosen = pickPoseForActive?.(poses, canvasEl, hoopBox);
    if (chosen) {
      updatePlayerTracker?.(chosen.scaled, frameIdx);
      playerState.keypoints = chosen.scaled;
      playerState.box = [ chosen.box.x, chosen.box.y, chosen.box.x + chosen.box.w, chosen.box.y + chosen.box.h ];
    }

    // Ball + scoring
    const ball = pickBallCandidate?.(objects, hoopBox);
    if (ball && hoopBox) {
      updateBall?.({ x: ball.x, y: ball.y }, __frameIdx);

      // RELEASE FIRST → ensures downstream can react the same frame
      if (isPoseInReleasePosition?.(playerState) && ballState.state !== 'TRACKING') {
        try { markRelease?.(__frameIdx); } catch {}
      }

      // Now tick the scorer (this can emit 'shot:release' if tracking just started)
      scoringTick?.(__frameIdx);

      // optional HUD note on net motion
      ballState.netMoved = detectNetMotion?.(buf, hoopBox);
      drawNetMotionStatus?.(buf, ballState.netMoved);
    }


    // Expose + overlays + readiness
    window.lastDetectedFrame = { __frameIdx: frameIdx, objects, poses };
    bufferDetectedObjects?.(objects);
    if (hoopBox) attachHoop?.(asTopLeft?.(hoopBox) ?? hoopBox);
    tickReadiness?.(objects, poses);
    updateDebugOverlay?.(poses, objects, frameIdx);
    drawLiveOverlay?.(objects, playerState);

    // Score/finalize (armed or we’re in FBF)
    const armed = window.__readyForScoring || window.__fbfActive;
    if (armed && hoopBox) {
      scoringTick?.(frameIdx);
      checkShotConditions?.(ballState, hoopBox, frameIdx);
    }
  }

  async function runShotFBF() {
    const videoEl  = getVid();
    const canvasEl = getCan();
    if (!videoEl || !canvasEl) return;
    if (window.__fbfActive)   return;

    window.__fbfActive = true;
    window.stopFrameAnalysis?.();       // stop RVFC
    try { videoEl.pause(); } catch {}   // we step via seeking

    const srcFps = getFPS();
    const dt     = 1 / srcFps;          // one source frame per loop
    const visFps = Math.max(1, Number(window.FBF_VISUAL_FPS) || 3); // visual pacing
    const buf    = document.createElement('canvas');
    const bctx   = buf.getContext('2d', { willReadFrequently: true });

    let frameIdx = 0, running = true;
    cancelFBF = () => { running = false; };

    window.setSessionStatus?.('Analyzing shot…');

    while (running) {
      if (videoEl.ended || videoEl.currentTime >= (videoEl.duration || Infinity)) break;

      const tStart = performance.now();

      // Process the CURRENT decoded frame
      await stepOnce(videoEl, canvasEl, frameIdx, buf, bctx);
      frameIdx++;

      // Step to the NEXT source frame…
      const nextT = (videoEl.currentTime || 0) + dt;
      try { videoEl.currentTime = Math.min(nextT, (videoEl.duration || nextT)); } catch {}

      // …and wait for that frame to decode/present
      await waitForNextDecodedFrame(videoEl);

      // Optional: visible pacing (slow-mo feel)
      const minStepMs = 1000 / visFps;
      const elapsed   = performance.now() - tStart;
      if (elapsed < minStepMs) {
        await new Promise(r => setTimeout(r, minStepMs - elapsed));
      }
    }
  }

  // Start FBF at release
  window.addEventListener('shot:release', () => {
    if (!window.USE_FBF_DURING_SHOT) return;
    runShotFBF();
  });

  // Stop FBF and resume RVFC at summary
   window.addEventListener('shot:summary', (e) => {
   // If no record was attached, ensure we log one now.
   if (!e?.detail) {
     try {
       const frozen = ballState?.shots?.at?.(-1);
       const trail  = (frozen?.trail?.length >= 3)
         ? frozen.trail
         : (ballState?.trail?.slice?.(-28) || null);
       const hoop   = getLockedHoopBox?.();
       if (trail && trail.length >= 3 && hoop) {
         detectAndLogShot(trail, ballState?.f ?? 0, hoop);
       }
     } catch {}
   }
    if (cancelFBF) { try { cancelFBF(); } catch {} cancelFBF = null; }
    window.__fbfActive = false;

    const videoEl  = getVid();
    const canvasEl = getCan();
    if (videoEl && canvasEl) {
      window.analyzeVideoFrameByFrame?.(videoEl, canvasEl);
      try { videoEl.playbackRate = 1; videoEl.play(); } catch {}
    }
    window.setSessionStatus?.('SESSION IN PROGRESS…');
  });
})();


// ========= RVFC analyzer (no manual stepping/scrubbing) =========
window.analyzeVideoFrameByFrame = function analyzeVideoFrameByFrame(videoEl, canvasEl) {
  // Teardown any previous loop before starting
  if (typeof window.stopFrameAnalysis !== 'function') window.stopFrameAnalysis = () => {};
  window.stopFrameAnalysis();
  window.stopPreDetection?.();

  if (!videoEl || !canvasEl) { console.warn('[analyze] missing video/canvas'); return; }
  if (window.__analyzerActive) { console.log('[analyze] already running'); return; }

  window.__analyzerActive = true;

  let analyzing     = true;
  let tickBusy      = false;
  let frameIdx      = 0;
  let rvfcId        = null;
  let lastHandledT  = -1;

  const buf  = document.createElement('canvas');
  const bctx = buf.getContext('2d', { willReadFrequently: true });

  function syncBufferSize() {
    if (buf.width !== canvasEl.width || buf.height !== canvasEl.height) {
      buf.width  = canvasEl.width;
      buf.height = canvasEl.height;
    }
  }
  syncBufferSize();

  async function onTick(mediaTime) {
    if (!analyzing || tickBusy) return;
    if (videoEl.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;

    const t = (typeof mediaTime === 'number') ? mediaTime : videoEl.currentTime;
    if (t === lastHandledT) return;  // de-dupe identical timestamps
    lastHandledT = t;

    tickBusy = true;
    try {
      syncBufferSize();
      bctx.drawImage(videoEl, 0, 0, buf.width, buf.height);

      // YOLO + pose in parallel; pose serialized internally
      const [det, poseRes] = await Promise.all([
        (async () => { try { return await sendFrameToDetect(buf, frameIdx); } catch { return { objects: [] }; } })(),
        (async () => { try { return await poseDetectSerial?.(); } catch { return null; } })()
      ]);

      const objects = det?.objects ?? [];
      const hoopBox = getLockedHoopBox?.();

      // Stabilize hoop before hoop-dependent logic
      stabilizeLockedHoop?.(objects);

      // Choose/update active player + pose
      updateActivePlayer?.(objects, frameIdx, canvasEl.width, canvasEl.height);
      const poses = poseRes?.landmarks || [];
      const chosen = pickPoseForActive?.(poses, canvasEl, hoopBox);
      if (chosen) {
        updatePlayerTracker?.(chosen.scaled, frameIdx);
        playerState.keypoints = chosen.scaled;
        playerState.box = [
          chosen.box.x,
          chosen.box.y,
          chosen.box.x + chosen.box.w,
          chosen.box.y + chosen.box.h
        ];
      }

      // ---- Release detection (emit once) ----
      if (isPoseInReleasePosition?.(playerState) && ballState?.state !== 'TRACKING') {
        try { markRelease?.(frameIdx); } catch {}
        if (ballState && !ballState.releaseSignaled) {
          ballState.releaseSignaled = true;
          try { window.dispatchEvent(new Event('shot:release')); } catch {}
        }
      }

      // Expose current frame
      window.lastDetectedFrame = { __frameIdx: frameIdx, objects, poses };
      bufferDetectedObjects?.(objects);
      if (hoopBox) attachHoop?.(asTopLeft?.(hoopBox) ?? hoopBox);

      // ---- Ball choose + update (with ROI fallback + gap fill) ----
      let ball = pickBallCandidate?.(objects, hoopBox);
      let updatedThisTick = false;

      if (ball && hoopBox) {
        updateBall?.({ x: ball.x, y: ball.y }, frameIdx);
        updatedThisTick = true;
      } else if (ballState?.trail?.length) {
        // YOLO blinked; nudge near last point (preferably inside proximity)
        const lastPt = ballState.trail.at(-1);
        const useROI = typeof isBallInProximityZone === 'function'
          ? isBallInProximityZone(lastPt)
          : true; // fallback: allow everywhere
        if (useROI) {
          const nudged = refineBallWithROI(bctx, lastPt, 20);
          if (nudged) {
            updateBall?.({ x: nudged.x, y: nudged.y }, frameIdx);
            updatedThisTick = true;
          }
        }
      }

      // Optional net motion hint for weighted scorer
      try {
        if (hoopBox) {
          ballState.netMoved = detectNetMotion?.(buf, hoopBox);
          drawNetMotionStatus?.(buf, ballState.netMoved);
        }
      } catch {}

      // Overlays + readiness
      tickReadiness?.(objects, poses);
      updateDebugOverlay?.(poses, objects, frameIdx);
      drawLiveOverlay?.(objects, playerState);

      // Fill tiny time holes between the last two points (keeps trail smooth)
      if (updatedThisTick) fillRecentGapInPlace(ballState);

      // Score/finalize only when armed
      if (window.__readyForScoring && hoopBox) {
        scoringTick?.(frameIdx);
        checkShotConditions?.(ballState, hoopBox, frameIdx);
      }

      frameIdx++;

      // Notify others per frame
      try {
        window.dispatchEvent(new CustomEvent('analyzer:frame-done', {
          detail: { __frameIdx: frameIdx, t }
        }));
      } catch {}
    } catch (err) {
      console.error('[analyze] tick error:', err);
    } finally {
      tickBusy = false;
    }
  }

  function startRVFC() {
    if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) {
      console.error('[analyze] RVFC not supported. Analyzer will be inert without manual stepping.');
      const onTimeUpdate = () => onTick(videoEl.currentTime);
      videoEl.addEventListener('timeupdate', onTimeUpdate);
      window.stopFrameAnalysis = () => {
        analyzing = false;
        videoEl.removeEventListener('timeupdate', onTimeUpdate);
        window.__analyzerActive = false;
      };
      onTick(videoEl.currentTime);
      return;
    }

    const onVideoFrame = (_now, metadata) => {
      if (!analyzing) return;
      onTick(metadata?.mediaTime ?? videoEl.currentTime);
      rvfcId = videoEl.requestVideoFrameCallback(onVideoFrame);
    };
    rvfcId = videoEl.requestVideoFrameCallback(onVideoFrame);

    window.stopFrameAnalysis = () => {
      analyzing = false;
      if (rvfcId != null) {
        try { videoEl.cancelVideoFrameCallback(rvfcId); } catch {}
        rvfcId = null;
      }
      window.__analyzerActive = false;
    };

    onTick(videoEl.currentTime); // paint immediately
  }

  // Keep overlay buffer sized when the viewport changes
  window.addEventListener('resize', syncBufferSize);
  const detachResize = () => window.removeEventListener('resize', syncBufferSize);

  const prevStop = window.stopFrameAnalysis;
  window.stopFrameAnalysis = function unifiedStop() {
    try { prevStop?.(); } catch {}
    analyzing = false;
    detachResize();
    window.__analyzerActive = false;
  };

  startRVFC();
};


// ─────────────────────────────────────────────────────────────── //
//              ------------ helpers ----------------              //
// ─────────────────────────────────────────────────────────────── //

// --- ROI micro-tracker: nudge ball near last point when YOLO misses ---
function refineBallWithROI(ctx, lastPt, win = 18) {
  if (!lastPt || !ctx) return null;
  const x = Math.round(lastPt.x), y = Math.round(lastPt.y);
  const w = ctx.canvas.width, h = ctx.canvas.height;

  const half = Math.max(6, Math.min(win, 40));
  const x1 = Math.max(0, x - half), y1 = Math.max(0, y - half);
  const ww = Math.min(half*2+1, w - x1), hh = Math.min(half*2+1, h - y1);
  if (ww < 3 || hh < 3) return null;

  let best = { score: -1, xx: x, yy: y };
  try {
    const img = ctx.getImageData(x1, y1, ww, hh).data;
    for (let j = 1; j < hh - 1; j++) {
      for (let i = 1; i < ww - 1; i++) {
        const idx = (j * ww + i) * 4;
        const gx = Math.abs(img[idx + 4]      - img[idx - 4]);
        const gy = Math.abs(img[idx + ww*4]   - img[idx - ww*4]);
        const g  = gx + gy;
        if (g > best.score) best = { score: g, xx: x1 + i, yy: y1 + j };
      }
    }
  } catch {}
  return best.score < 1 ? null : { x: best.xx, y: best.yy };
}

// --- Fill a tiny temporal gap between the last two points (≤3 frames) ---
function fillRecentGapInPlace(state) {
  const tr = state?.trail; if (!Array.isArray(tr) || tr.length < 2) return;
  const a = tr[tr.length - 2], b = tr[tr.length - 1];
  const fa = a.frame ?? 0, fb = b.frame ?? (fa + 1);
  const gap = fb - fa;
  if (gap <= 1 || gap > 4) return; // only small holes

  const inserts = [];
  for (let s = 1; s < gap; s++) {
    const t = s / gap;
    inserts.push({
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      frame: fa + s
    });
  }
  // splice in just before 'b'
  tr.splice(tr.length - 1, 0, ...inserts);
}



// 1) only allow play/analyze when the hoop is locked.
//    If not, show the prompt once and refuse.
window.requireHoopOrPrompt = function requireHoopOrPrompt() {
  const locked = !!(typeof getLockedHoopBox === 'function' && getLockedHoopBox());
  if (locked) return true;
  const prompt = document.getElementById('overlayPrompt');
  if (prompt) {
    prompt.textContent = '📍 Tap the hoop to begin setup';
    prompt.style.display = 'block';
  }
  return false;
};

// 2) Strong reset for the session (shots + pose + readiness + loops)
window.resetShots = function resetShots() {
  try { window.stopFrameAnalysis?.(); } catch {}
  try { stopPreDetection?.(); } catch {}

  try { resetAll?.(); } catch {}
  try { resetPlayerTracker?.(); } catch {}
  try { resetShotStats?.(); } catch {}

  try { resetReadiness?.('manual reset'); } catch {}
  window.__hoopAutoLocked = false;
};

// 3) One‑frame step when paused (nice for slow scrubbing)
window.stepFrame = function stepFrame(dt = 1 / 30) {
  const v = document.getElementById('videoPlayer');
  if (!v) return;
  v.pause();
  const nextT = Math.min(v.duration || Infinity, (v.currentTime || 0) + dt);
  v.currentTime = nextT;
  // kick analyzer once to render this frame without starting the loop
  try { window.dispatchEvent(new Event('analyzer:step')); } catch {}
};

// 4) Minimal overlay helpers (only define if not already present)
if (typeof window.clientToVideoXY !== 'function') {
  window.clientToVideoXY = function clientToVideoXY(clientX, clientY) {
    const ov = document.getElementById('overlay');
    const V = window.__VIEW;
    if (!ov || !V?.scale) return { x: 0, y: 0 };
    const r = ov.getBoundingClientRect();
    const cssX = clientX - r.left;
    const cssY = clientY - r.top;
    const x = Math.max(0, Math.min(V.vw || 0, Math.round(cssX / V.scale)));
    const y = Math.max(0, Math.min(V.vh || 0, Math.round(cssY / V.scale)));
    return { x, y };
  };
}
if (typeof window.setOverlayInteractive !== 'function') {
  window.setOverlayInteractive = function setOverlayInteractive(on) {
    const ov = document.getElementById('overlay');
    if (!ov) return;
    window.__pickingHoop = !!on;
    ov.style.pointerEvents = on ? 'auto' : 'none';
    ov.style.cursor = on ? 'crosshair' : 'default';
  };
}

// 5) Readiness convenience hooks (tie into your gate)
window.onNewVideoLoaded = () => { try { resetReadiness?.('new video'); } catch {} };
window.onHoopRelocked   = () => { try { resetReadiness?.('hoop changed'); } catch {} };
window.onSeekOrPause    = () => { try { resetReadiness?.('seek/pause'); } catch {} };

// 6) Pre‑detect controls (exposed so other modules can start/stop explicitly)
window.startPreDetection = window.startPreDetection || function() {};
window.stopPreDetection  = window.stopPreDetection  || function() {};

// 7) Detect path toggle for quick diagnosis (server vs worker)
//    When true, your sendFrameToDetect should skip worker and POST to /detect_frame.
if (typeof window.__forceServerDetect === 'undefined') {
  window.__forceServerDetect = false;
}

// 8) Real‑time tracking (legacy path) – keep guarded and no‑op unless enabled.
window.useRealTimeTracking = false;
(function attachRealtimePlayHook() {
  const v = document.getElementById('videoPlayer');
  if (!v) return;
  v.addEventListener('play', () => {
    if (window.useRealTimeTracking && typeof window.safeDetectForVideo === 'function') {
      try { window.startTracking?.(); } catch {}
    }
  });
})();



// ───────────────────────────────────────────────────────────────
// Active player selection: instant lock by ball proximity,
// stable keep via IoU, plus a small voting fallback.
// Also exposes a one-click manual picker.
// ───────────────────────────────────────────────────────────────

window.activePlayerBox = null;      // {x,y,w,h,cx,cy}
let _activeLastSeenFrame = -1;

let _voteBox = null;
let _voteCount = 0;

const VOTE_NEED = 3;                // frames to confirm when ball isn't clearly "owned"
const KEEP_FRAMES = 45;             // keep lock this many frames after we last matched by IoU
const IOU_KEEP = 0.35;              // keep following if overlap ≥ this
const SMOOTH = 0.75;                // smoothing when we keep a lock

function _toBox(arr4) {
  const [x1,y1,x2,y2] = arr4;
  const w = x2 - x1, h = y2 - y1;
  return { x:x1, y:y1, w, h, cx: x1 + w/2, cy: y1 + h/2 };
}
function _iou(a,b) {
  const ax2=a.x+a.w, ay2=a.y+a.h, bx2=b.x+b.w, by2=b.y+b.h;
  const x1=Math.max(a.x,b.x), y1=Math.max(a.y,b.y);
  const x2=Math.min(ax2,bx2), y2=Math.min(ay2,by2);
  const iw=Math.max(0,x2-x1), ih=Math.max(0,y2-y1);
  const inter=iw*ih, uni=a.w*a.h + b.w*b.h - inter;
  return uni>0 ? inter/uni : 0;
}
function _smooth(prev, next, a=SMOOTH) {
  if (!prev) return next;
  return {
    x: a*prev.x + (1-a)*next.x,
    y: a*prev.y + (1-a)*next.y,
    w: a*prev.w + (1-a)*next.w,
    h: a*prev.h + (1-a)*next.h,
    get cx(){ return this.x + this.w/2; },
    get cy(){ return this.y + this.h/2; },
  };
}
function _ptRectDist(px,py, r) {
  const dx = Math.max(r.x - px, 0, px - (r.x + r.w));
  const dy = Math.max(r.y - py, 0, py - (r.y + r.h));
  return Math.hypot(dx, dy);
}
function _inflate(r, kx, ky) {
  const x = r.x - r.w * kx, y = r.y - r.h * ky;
  const w = r.w * (1 + 2*kx), h = r.h * (1 + 2*ky);
  return { x, y, w, h, cx: x + w/2, cy: y + h/2 };
}

// Ball center: prefer smoothed trail; else current detection
function _ballCenter(objects) {
  const tr = window.ballState?.trail;
  if (Array.isArray(tr) && tr.length) {
    const n = Math.min(5, tr.length);
    let sx=0, sy=0; for (let i=tr.length-n; i<tr.length; i++) { sx+=tr[i].x; sy+=tr[i].y; }
    return { x: sx/n, y: sy/n };
  }
  const ball = (objects||[]).find(o => o.label === 'basketball' && Array.isArray(o.box));
  if (ball) {
    const [x1,y1,x2,y2] = ball.box;
    return { x:(x1+x2)/2, y:(y1+y2)/2 };
  }
  return null;
}

// Derive recent ball motion vector (unit-ish, in video px) to bias ownership
function _ballMotionHint() {
  const tr = window.ballState?.trail;
  if (!Array.isArray(tr) || tr.length < 3) return null;
  const n = Math.min(5, tr.length);
  const a = tr[tr.length - n], b = tr[tr.length - 1];
  const dx = b.x - a.x, dy = b.y - a.y;
  const mag = Math.hypot(dx, dy) || 1;
  return { dx: dx / mag, dy: dy / mag };
}

/**
 * Choose / keep the active player
 * Strategy:
 *  1) Keep lock by IoU if overlap is decent (smoothed)
 *  2) Instant lock if the ball center lies within an expanded player box
 *  3) If ambiguous, bias toward the nearest player in the ball's motion direction
 *  4) Voting fallback over a few frames to avoid flicker
 */
export function updateActivePlayer(objects, frameIdx) {
  const players = (objects || [])
    .filter(o => (o.label === 'player' || o.label === 'person') && Array.isArray(o.box) && o.box.length === 4)
    .map(o => _toBox(o.box));

  if (!players.length) return;

  const motion = _ballMotionHint();
  const bc = _ballCenter(objects);

  // 1) Try to KEEP the current lock by IoU
  if (window.activePlayerBox) {
    let best = null, bestIoU = -1;
    for (const pb of players) {
      const v = _iou(window.activePlayerBox, pb);
      if (v > bestIoU) { bestIoU = v; best = pb; }
    }
    if (best && bestIoU >= IOU_KEEP) {
      window.activePlayerBox = _smooth(window.activePlayerBox, best, SMOOTH);
      _activeLastSeenFrame = frameIdx;
      return;
    }
  }

  // 2) Instant “possession” owner: ball center inside an expanded box
  if (bc) {
    let owner = null, bestD = Infinity;
    for (const p of players) {
      // expand horizontally/vertically to include outstretched arms; scale‑aware
      const zone = _inflate(p, 0.35, 0.25);
      // adaptable allowance: wider on close‑ups, narrower on wide shots
      const allow = Math.max(36, Math.min(160, p.w * 0.45));
      const d = _ptRectDist(bc.x, bc.y, zone);
      if (d <= allow && d < bestD) { owner = p; bestD = d; }
    }
    if (owner) {
      window.activePlayerBox = owner;
      _activeLastSeenFrame = frameIdx;
      _voteBox = null; _voteCount = 0;
      return;
    }
  }

  // 3) Grace period: if we had a lock recently, keep it warm a bit before switching
  if (_activeLastSeenFrame > 0 && frameIdx - _activeLastSeenFrame < KEEP_FRAMES) {
    // do nothing this frame; wait for clearer evidence
    return;
  }

  // 4) Ambiguous → pick using motion‑biased nearest, else geometric nearest
  let target = null;
  if (bc) {
    // base: nearest by Euclidean
    players.sort((a, b) =>
      ((a.cx - bc.x) ** 2 + (a.cy - bc.y) ** 2) - ((b.cx - bc.x) ** 2 + (b.cy - bc.y) ** 2)
    );
    target = players[0];

    // motion bias: small nudge toward being “ahead” in the ball direction
    if (motion) {
      let bestScore = -Infinity, bestP = target;
      for (const p of players.slice(0, Math.min(3, players.length))) {
        const vx = p.cx - bc.x, vy = p.cy - bc.y;
        const proj = (vx * motion.dx + vy * motion.dy); // dot with motion
        const near = -Math.hypot(vx, vy);               // nearer is better
        const score = proj * 0.6 + near * 0.4;
        if (score > bestScore) { bestScore = score; bestP = p; }
      }
      target = bestP;
    }
  } else {
    // no ball? choose largest box to avoid bouncing between spectators
    target = players.slice().sort((a, b) => (b.w * b.h) - (a.w * a.h))[0];
  }

  // 5) Voting fallback (stabilize across a few frames)
  if (_voteBox && _iou(_voteBox, target) > 0.5) {
    _voteBox = _smooth(_voteBox, target, 0.5);
    _voteCount++;
  } else {
    _voteBox = target; _voteCount = 1;
  }
  if (_voteCount >= VOTE_NEED) {
    window.activePlayerBox = _voteBox;
    _activeLastSeenFrame = frameIdx;
    _voteBox = null; _voteCount = 0;
  }
}

/**
 * One‑click manual shooter pick (arm once → click a player box).
 * Auto-disarms after 6s as a backstop.
 */
export function enablePlayerPickOnce(objects) {
  const ov = document.getElementById('overlay');
  if (!ov) return;
  const boxes = (objects || [])
    .filter(o => (o.label === 'player' || o.label === 'person') && Array.isArray(o.box) && o.box.length === 4)
    .map(o => _toBox(o.box));

  function onClick(e) {
    const r = ov.getBoundingClientRect();
    const x = (e.clientX - r.left) * (ov.width / r.width);
    const y = (e.clientY - r.top)  * (ov.height / r.height);
    const hit = boxes.find(b => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
    if (hit) {
      window.activePlayerBox = hit;
      _activeLastSeenFrame = Number.isFinite(window.__frameIdx) ? window.__frameIdx : 0;
      console.log('🖱️ Active player set by click:', {
        x: Math.round(hit.x), y: Math.round(hit.y), w: Math.round(hit.w), h: Math.round(hit.h)
      });
    }
    ov.style.pointerEvents = 'none';
    ov.removeEventListener('click', onClick);
  }

  ov.style.pointerEvents = 'auto';
  ov.style.cursor = 'crosshair';
  ov.addEventListener('click', onClick, { once: true });

  setTimeout(() => {
    ov.style.pointerEvents = 'none';
    ov.removeEventListener('click', onClick);
  }, 6000);
}




// cleanup, from all poses, return the one that best matches activePlayerBox (or fallback)
export function pickPoseForActive(poses, canvasEl, hoopBox) {
  if (!Array.isArray(poses) || poses.length === 0 || !canvasEl) return null;

  // --- target space is VIDEO pixels (1:1 with overlay) ---
  const V = window.__VIEW || {};
  const W = V.vw || canvasEl.width;
  const H = V.vh || canvasEl.height;

  // helpers
  const boxFrom = (ls) => {
    const xs = ls.map(k => k.x), ys = ls.map(k => k.y);
    const x1 = Math.min(...xs), y1 = Math.min(...ys);
    const x2 = Math.max(...xs), y2 = Math.max(...ys);
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1, cx: (x1 + x2)/2, cy: (y1 + y2)/2 };
  };
  const iou = (a,b) => {
    const ax2=a.x+a.w, ay2=a.y+a.h, bx2=b.x+b.w, by2=b.y+b.h;
    const x1=Math.max(a.x,b.x), y1=Math.max(a.y,b.y);
    const x2=Math.min(ax2,bx2), y2=Math.min(ay2,by2);
    const iw=Math.max(0,x2-x1), ih=Math.max(0,y2-y1);
    const inter=iw*ih, uni=a.w*a.h + b.w*b.h - inter;
    return uni>0 ? inter/uni : 0;
  };
  const visScore = (ls) => {
    // average of (visibility || score || 1), capped to [0,1]
    let s = 0, n = 0;
    for (const k of ls) {
      const v = (k?.visibility ?? k?.score ?? 1);
      if (Number.isFinite(v)) { s += Math.max(0, Math.min(1, v)); n++; }
    }
    return n ? s / n : 0.5;
  };

  // map each pose to VIDEO pixels if normalized
  const viewItems = poses.map(ls => {
    const looksNormalized = ls.every(k => k && k.x <= 1.01 && k.y <= 1.01);
    const sx = looksNormalized ? W : 1;
    const sy = looksNormalized ? H : 1;
    const scaled = ls.map(k => ({ ...k, x: k.x * sx, y: k.y * sy }));
    const box = boxFrom(scaled);
    return { scaled, box, vscore: visScore(scaled) };
  });

  // 1) Prefer overlap with the active player if present
  const AP = window.activePlayerBox || null;
  if (AP) {
    // score = IoU * 1.0 + center-proximity bonus + tiny visibility weight
    const best = viewItems
      .map(it => {
        const i = iou(AP, it.box);
        const dcx = (it.box.cx - AP.cx), dcy = (it.box.cy - AP.cy);
        const d2 = Math.max(1, dcx*dcx + dcy*dcy);
        const prox = 1 / (1 + Math.sqrt(d2)); // 0..1-ish
        const score = i * 1.0 + prox * 0.3 + it.vscore * 0.05;
        return { it, score };
      })
      .sort((a,b) => b.score - a.score)[0];
    if (best) return best.it;
  }

  // 2) Else use hoop fallback: prefer poses in a vertical lane under/near the rim
  if (hoopBox && Number.isFinite(hoopBox.x) && Number.isFinite(hoopBox.y)) {
    const laneHalf = Math.max(80, (hoopBox.w || 80) * 0.8);
    const laneX1 = hoopBox.x - laneHalf, laneX2 = hoopBox.x + laneHalf;
    const best = viewItems
      .map(it => {
        const insideLane = (it.box.cx >= laneX1 && it.box.cx <= laneX2) ? 1 : 0;
        const dY = Math.abs(it.box.cy - hoopBox.y);
        const dyScore = 1 / (1 + dY); // closer vertically to rim line
        const dx = Math.abs(it.box.cx - hoopBox.x);
        const dxScore = 1 / (1 + dx);
        const score = insideLane * 0.6 + dxScore * 0.25 + dyScore * 0.1 + it.vscore * 0.05;
        return { it, score };
      })
      .sort((a,b)=> b.score - a.score)[0];
    if (best) return best.it;
  }

  // 3) Last resort: largest box (most pixels) with visibility tie‑break
  return viewItems
    .map(it => ({ it, area: it.box.w * it.box.h, v: it.vscore }))
    .sort((a,b) => (b.area - a.area) || (b.v - a.v))[0].it;
}


// End Active Player ────────────────────────────────────────────────────


// Choose the correct ball when several are on screen.
// Relies on a tiny memory to track velocity between frames.
const BALL_LABELS = new Set(['basketball', 'ball', 'sports ball']);

// Tiny memory for prediction between YOLO hits
const __ballMem = { x:null, y:null, vx:0, vy:0, area:null, has:false };

// Reset memory each time a shot finishes to avoid drift across shots
window.addEventListener?.('shot:summary', () => {
  __ballMem.x = __ballMem.y = null;
  __ballMem.vx = __ballMem.vy = 0;
  __ballMem.area = null;
  __ballMem.has = false;
});

function centerize(b) {
  if (Number.isFinite(b.x) && Number.isFinite(b.y)) {
    const area = b.area ?? (
      Array.isArray(b.box) && b.box.length === 4 ? Math.max(1, (b.box[2]-b.box[0])*(b.box[3]-b.box[1])) : null
    );
    return { ...b, x: b.x, y: b.y, area };
  }
  if (Array.isArray(b.box) && b.box.length === 4) {
    const [x1, y1, x2, y2] = b.box;
    const x = (x1 + x2) / 2, y = (y1 + y2) / 2;
    const area = Math.max(1, (x2 - x1) * (y2 - y1));
    return { ...b, x, y, area };
  }
  return null;
}

function pickBallCandidate(objects, hoopBox) {
  // 1) Filter to ball-like labels and normalize to centers
  const balls = (objects || []).filter(o => BALL_LABELS.has(o.label || 'basketball'));
  if (!balls.length) return null;

  const withCenters = balls.map(centerize).filter(Boolean);
  if (!withCenters.length) return null;

  // 2) Context
  const lastTrail = window.ballState?.trail?.at?.(-1) || null;
  const tracking  = !!lastTrail; // we're already tracking a live trail
  const hx = hoopBox ? (hoopBox.cx ?? (hoopBox.x + (hoopBox.w || 0) / 2)) : null;
  const hy = hoopBox ? (hoopBox.cy ?? (hoopBox.y + (hoopBox.h || 0) / 2)) : null;

  // 3) Prediction from memory (latest seen)
  const hasPred = __ballMem.has && Number.isFinite(__ballMem.x) && Number.isFinite(__ballMem.y);
  const px = hasPred ? (__ballMem.x + __ballMem.vx) : null;
  const py = hasPred ? (__ballMem.y + __ballMem.vy) : null;

  // 4) Fast path: if we have a live trail, first try "nearest to last trail"
  //    (stabilizes IDs under dense scenes)
  if (lastTrail) {
    withCenters.sort((a, b) =>
      ((a.x - lastTrail.x) ** 2 + (a.y - lastTrail.y) ** 2) -
      ((b.x - lastTrail.x) ** 2 + (b.y - lastTrail.y) ** 2)
    );
    const nearest = withCenters[0];
    if (nearest) {
      // Update memory (EMA) for smoother velocity
      if (__ballMem.has) {
        const dx = nearest.x - __ballMem.x, dy = nearest.y - __ballMem.y;
        __ballMem.vx = 0.6 * __ballMem.vx + 0.4 * dx;
        __ballMem.vy = 0.6 * __ballMem.vy + 0.4 * dy;
      }
      __ballMem.x = nearest.x; __ballMem.y = nearest.y;
      __ballMem.area = nearest.area ?? __ballMem.area;
      __ballMem.has = true;
      return nearest;
    }
  }

  // 5) Scored selection: prediction, proximity, hoop distance, size stability, velocity alignment, confidence
  let best = null, bestScore = -Infinity;

  for (const c of withCenters) {
    const conf = Number(c.conf ?? c.score ?? 0); // tolerate different detector fields

    // Prediction distance (smaller is better)
    let predScore = 0;
    if (hasPred) {
      const dp = Math.hypot(c.x - px, c.y - py);
      // dynamic tolerance scales with recent speed
      const speed = Math.hypot(__ballMem.vx || 0, __ballMem.vy || 0);
      const tol   = Math.min(200, Math.max(60, 24 + 0.7 * speed)); // px
      predScore   = (tol - Math.min(tol * 2, dp)) / tol; // ~1..-1
    }

    // Proximity zone bonus (most important while arming a shot)
    const inProx = (typeof isBallInProximityZone === 'function') && isBallInProximityZone(c);
    const proxBonus = inProx ? 1 : 0;

    // Hoop distance heuristic (helps before we’re tracking)
    let hoopScore = 0;
    if (hx != null && hy != null) {
      const dh = Math.hypot(c.x - hx, c.y - hy);
      hoopScore = 1 / (1 + dh / 180);
    }

    // Size stability vs memory (avoid jumps when multiple balls)
    let sizeScore = 0;
    if (__ballMem.area && c.area) {
      const ratio = c.area / __ballMem.area;
      const dev = Math.abs(Math.log2(Math.max(1e-3, ratio)));  // 0 → same; 1 → 2x area change
      sizeScore = Math.max(-1, 0.5 - dev); // same≈0.5, big mismatch negative
    }

    // Velocity alignment: prefer motion consistent with last direction
    let velScore = 0;
    if (__ballMem.has) {
      const ux = (c.x - __ballMem.x), uy = (c.y - __ballMem.y);
      const sp = Math.hypot(__ballMem.vx, __ballMem.vy) || 1;
      const dot = (__ballMem.vx * ux + __ballMem.vy * uy) / (sp * (Math.hypot(ux, uy) || 1));
      velScore = isFinite(dot) ? dot : 0; // -1..+1
    }

    // Weights: tracking phase leans on prediction; arming phase leans on proximity/hoop/conf
    const wPred = tracking ? 0.70 : 0.35;
    const wProx = tracking ? 0.40 : 0.80;
    const wHoop = tracking ? 0.15 : 0.30;
    const wSize = 0.20;
    const wVel  = tracking ? 0.30 : 0.10;
    const wConf = 0.20;

    const score =
      (hasPred ? predScore * wPred : 0) +
      (proxBonus * wProx) +
      (hoopScore * wHoop) +
      (sizeScore * wSize) +
      (velScore  * wVel)  +
      (conf      * wConf);

    if (score > bestScore) { bestScore = score; best = c; }
  }

  // 6) Fallbacks if tied/weak: proximity → hoop closeness → confidence
  if (!best) {
    const inProx = withCenters.filter(p => isBallInProximityZone?.(p));
    if (inProx.length) {
      inProx.sort((a,b) => (b.conf ?? 0) - (a.conf ?? 0));
      best = inProx[0];
    } else if (hx != null && hy != null) {
      withCenters.sort((a,b) =>
        ((a.x - hx) ** 2 + (a.y - hy) ** 2) - ((b.x - hx) ** 2 + (b.y - hy) ** 2)
      );
      best = withCenters[0];
    } else {
      withCenters.sort((a,b) => (b.conf ?? 0) - (a.conf ?? 0));
      best = withCenters[0];
    }
  }

  // 7) Update memory for the next frame (EMA on velocity)
  if (best) {
    if (__ballMem.has) {
      const dx = best.x - __ballMem.x, dy = best.y - __ballMem.y;
      __ballMem.vx = 0.6 * __ballMem.vx + 0.4 * dx;
      __ballMem.vy = 0.6 * __ballMem.vy + 0.4 * dy;
    }
    __ballMem.x = best.x; __ballMem.y = best.y;
    __ballMem.area = best.area ?? __ballMem.area;
    __ballMem.has = true;
  }

  return best || null;
}


// ───────────────────────────────────────────────────────────────
// Pose init on data-ready (safe element lookup)
// ───────────────────────────────────────────────────────────────
(function poseInitOnce(){
  function armOnce() {
    const v = document.getElementById('videoPlayer');
    if (!v) return;
    v.addEventListener('loadeddata', async () => {
      try {
        if (!window.poseDetector) {
          await initPoseDetector(); // loads MediaPipe + model once
        }
        if (typeof window.safeDetectForVideo === 'function') {
          console.log('✅ Pose detector ready — awaiting hoop selection…');
        } else {
          console.warn('⚠️ Pose detector wrapper (safeDetectForVideo) not found.');
        }
      } catch (err) {
        console.error('❌ Failed to initialize PoseLandmarker:', err);
      }
    }, { once: true });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', armOnce, { once: true });
  } else {
    armOnce();
  }
})();



// Switch to live camera.
// - stops any previous MediaStream tracks
// - resets session + readiness
// - waits for metadata, then syncs overlay + prewarms + optional pre-detect

window.useCamera = async () => {
  const v = document.getElementById('videoPlayer');
  if (!v) return;

  // stop any existing stream tracks
  try {
    const old = v.srcObject;
    if (old && typeof old.getTracks === 'function') {
      old.getTracks().forEach(t => { try { t.stop(); } catch {} });
    }
  } catch {}

  // strong reset: stop analysis/pre-detect and clear session
  try { window.resetShots?.(); } catch {}
  try { window.onNewVideoLoaded?.(); } catch {}

  // request camera
  let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' }, audio: false
    });
  } catch (err) {
    console.error("🚫 getUserMedia error:", err);
    return;
  }

  // bind stream and wait for metadata
  v.srcObject = stream;
  try { v.play().catch(()=>{}); } catch {}
  await new Promise(res => v.addEventListener('loadedmetadata', res, { once: true }));

  // map overlay, prewarm, and spin light pre-detect until ready
  try { syncOverlayToVideo?.(); } catch {}
  try {
    await prewarmDetectors?.(v);
    window.__detectorsWarmed = true;
  } catch {}
  try { startPreDetection?.(v); } catch {}
};

// Prefer the unified reset we defined earlier; keep a thin alias here if needed
window.resetShots = window.resetShots || function () {
  try { window.stopFrameAnalysis?.(); } catch {}
  try { stopPreDetection?.(); } catch {}

  try { resetAll?.(); } catch {}
  try { resetPlayerTracker?.(); } catch {}
  try { resetShotStats?.(); } catch {}

  try { resetReadiness?.('manual reset'); } catch {}
  window.__hoopAutoLocked = false;

  // optional UI cleanups if present
  const table = document.querySelector('#shotTable tbody');
  if (table) table.innerHTML = '';
  const details = document.getElementById('shotDetails');
  if (details) details.textContent = 'No shot data loaded.';
};

// --- Rock-solid slow-mo controller (release → slow, summary → 1x) ---
(function installShotSlowmo(){
  if (window.__shotSlowmoInstalled) return; window.__shotSlowmoInstalled = true;

  window.SLOW_RATE = Number.isFinite(window.SLOW_RATE) ? window.SLOW_RATE : 0.35;
  const MAX_HOLD_MS = 4000; // safety cap

  const getV = () => document.getElementById('videoPlayer') || document.querySelector('video');
  let desired = 1, holdTo = 0;

  function setRate(r) { const v = getV(); if (!v) return; if (v.playbackRate !== r) { try { v.playbackRate = r; } catch {} } desired = r; }
  function enter()   { holdTo = performance.now() + MAX_HOLD_MS; setRate(Number(window.SLOW_RATE)||0.35); }
  function exit(why) { holdTo = 0; setRate(1); }

  // Enforce target + cap
  (function tick(){
    const v = getV();
    if (v && v.playbackRate !== desired) setRate(desired);
    if (desired < 0.99 && holdTo && performance.now() > holdTo) exit('cap');
    requestAnimationFrame(tick);
  })();

  // Wire the two canonical events
  window.addEventListener('shot:release', enter);
  window.addEventListener('shot:summary', () => exit('summary'));

  // User actions/media events always cancel slow-mo
  function hygiene(){ const v=getV(); if (!v) return;
    v.addEventListener('play',    ()=>exit('play'));
    v.addEventListener('pause',   ()=>exit('pause'));
    v.addEventListener('seeking', ()=>exit('seeking'));
    v.addEventListener('ended',   ()=>exit('ended'));
    v.addEventListener('loadedmetadata', ()=>exit('loaded'), { once:true });
  }
  if (getV()) hygiene(); else document.addEventListener('DOMContentLoaded', hygiene, { once:true });
})();

