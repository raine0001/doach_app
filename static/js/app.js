// app.js with overlay drawing integrated
import { initOverlay, drawLiveOverlay, sendFrameToDetect, syncOverlayToVideo, updateDebugOverlay } from './fix_overlay_display.js';
import { resetShotStats, checkShotConditions, detectNetMotion, drawNetMotionStatus, bufferDetectedObjects, scoringTick, isBallInProximityZone} from './shot_logger.js';
import { playerState, resetPlayerTracker, updatePlayerTracker, initPoseDetector, forceSafePose, isPoseInReleasePosition } from './player_tracker.js';
import { stabilizeLockedHoop, getLockedHoopBox, handleHoopSelection } from './hoop_tracker.js';
import { createPlaybackControls } from './video_ui.js';
import { ballState, updateBall, resetAll, attachHoop, markRelease, getShotWindowBuffers } from './ball_tracker.js';
import { asTopLeft } from './shot_utils.js';
// import { mountHamburgerMenu } from './ui_menu.js';

// mountHamburgerMenu();


const H = getLockedHoopBox?.();     // center form now
if (H) attachHoop?.(asTopLeft(H));  // TL only for ball_tracker

export const frameArchive = [];

window.madeShotSound = new Audio('/static/assets/swish.mp3');
window.missedShotSound = new Audio('/static/assets/miss_bounce.mp3');
window.lastDetectedFrame = { __frameIdx: 0, objects: [], poses: [] };

let isTracking = false;
let ctx = null;
let __videoGen = 0;
let __blobURL  = null;
let overlayEl = null;
let __detTimer = null;
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

//--------------------------------------------------------------//
//           ------  Initialize overlay elements  -----         //
//--------------------------------------------------------------//

// Pick the active hoop before session start
export function enableHoopPickOnce() {
  const ov = document.getElementById('overlay');
  const promptEl = document.getElementById('overlayPrompt') || document.getElementById('promptBar');
  if (!ov) return;
  if (window.__hoopConfirmed) return;

  window.__pickingHoop = true;
  window.__hoopPickArmed = true;
  ov.style.setProperty('pointer-events', 'auto', 'important');
  ov.style.cursor = 'crosshair';

  const onPick = (e) => {
    e.preventDefault(); e.stopPropagation();

    handleHoopSelection(e, ov, window.lastDetectedFrame, promptEl);

    // confirmation and disarm
    window.__hoopConfirmed = true;
    window.__hoopPickArmed = false;
    window.__pickingHoop = false;

    ov.style.setProperty('pointer-events', 'none', 'important');
    ov.style.cursor = 'default';
    if (promptEl) promptEl.style.display = 'none';

    // let the prompt loop/listeners know
    window.dispatchEvent?.(new CustomEvent('hoop:locked', { detail: getLockedHoopBox?.() }));

    ov.removeEventListener('pointerdown', onPick);
    ov.removeEventListener('click', onPick);
  };

  ov.addEventListener('pointerdown', onPick, { once: true });
  ov.addEventListener('click', onPick, { once: true });

}

window.enableHoopPickOnce = enableHoopPickOnce;


// Safe detection wrapper for video frames
window.safeDetectForVideo = async function(canvas) {
  try {
    if (!window.poseDetector) return null;
    return await window.poseDetector.detectForVideo(canvas, nextPoseTS());
  } catch (e) {
    console.warn('pose detect failed', e);
    return null;
  }
};

// Make sure the overlay sits above the video and can be toggled clickable
// --- Overlay CSS + click tracer (diagnostics) ---
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
  ov.style.pointerEvents = 'none';
  ov.style.userSelect = 'none';
  ov.style.zIndex = '10'; // below HUD (9999), above video
}

// Simple click tracer
function installOverlayTracer() {
  const ov = document.getElementById('overlay');
  if (!ov || ov.__tracer) return;
  ov.__tracer = true;

  ov.addEventListener('pointerdown', (e) => {
    const cs = getComputedStyle(ov);
    console.log('[ov] pointerdown',
      { x:e.offsetX, y:e.offsetY, pe: cs.pointerEvents, z: cs.zIndex });
  });

  document.addEventListener('pointerdown', (e) => {
    const r = ov.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right &&
                   e.clientY >= r.top  && e.clientY <= r.bottom;
    console.log('[doc] pointerdown', e.target?.tagName, 'inside overlay?', inside);
  }, { capture: true });
}


// ---- Boot & event wires ----
document.addEventListener('DOMContentLoaded', () => {
  const videoPlayer = document.getElementById('videoPlayer');
  const videoInput  = document.getElementById('videoInput');
  const overlay     = document.getElementById('overlay');

  // Keep overlay pixel-locked to the video
  videoPlayer.addEventListener('loadedmetadata', () => {
    syncOverlayToVideo();
  });

  // Basic player hooks
  videoPlayer.addEventListener('pause', () => { isTracking = false; });
  videoPlayer.addEventListener('error', e => console.error('Video error:', e.target.error));
  window.togglePlay = () => {
    const gate = window.requireHoopOrPrompt;
    if (typeof gate !== 'function' || !gate()) { videoPlayer.pause(); return; }
    videoPlayer.paused ? videoPlayer.play() : videoPlayer.pause();
  };


  // Kick analyzer if the hoop is already locked
  videoPlayer.addEventListener('play', () => {
    const gate = window.requireHoopOrPrompt;
    console.log('[gate check]', {
      hasFn: typeof gate === 'function',
      confirmed: window.__hoopConfirmed,
      hasBox: !!getLockedHoopBox?.()
    });

    if (typeof gate !== 'function' || !gate()) {
      videoPlayer.pause();
      return;
    }

    console.log('▶️ Video playback started');
    window.analyzeVideoFrameByFrame?.(videoPlayer, overlay);
  });


  // File picker → load flow
  videoInput?.addEventListener('change', (e) => window.handleVideoUpload?.(e));

  // ref for use elsewhere
  overlayEl = overlay;
});


let __preDet = { on:false, raf:0, frame:0 };

function startPreDetection(video) {
  if (__preDet.on) return;
  __preDet.on = true;
  __preDet.frame = 0;

  const buf  = document.createElement('canvas');
  const bctx = buf.getContext('2d');

  const tick = async () => {
    if (!__preDet.on) return;

    const vw = video.videoWidth, vh = video.videoHeight;
    if (vw && vh) {
      buf.width = vw; buf.height = vh;
      bctx.drawImage(video, 0, 0, vw, vh);
    }

    try {
      const [det, poseRes] = await Promise.all([
        sendFrameToDetect(buf, __preDet.frame).catch(() => ({objects:[]})),
        window.poseDetector ? forceSafePose(buf, video, __preDet.frame) : Promise.resolve(null)
      ]);

      const objects = det?.objects || [];
      window.lastDetectedFrame = {
        __frameIdx: __preDet.frame,   // ✅ use local counter as a stable frame id
        objects,
        poses: poseRes?.landmarks ?? []
      };

      // keep object buffers warm for hoop/net region
      bufferDetectedObjects?.(objects);

      // light overlay boxes/skeletons before analyzer starts
      drawLiveOverlay?.(objects, window.playerState);
      updateDebugOverlay?.(window.lastDetectedFrame.poses, objects, __preDet.frame);
    } catch (e) {
      console.warn('[predet] error', e);
    }

    __preDet.frame++;
    // ~10 fps to keep it light
    setTimeout(() => { __preDet.raf = requestAnimationFrame(tick); }, 100);
  };

  __preDet.raf = requestAnimationFrame(tick);
}

function stopPreDetection() {
  __preDet.on = false;
  if (__preDet.raf) cancelAnimationFrame(__preDet.raf);
  __preDet.raf = 0;
}


//--------------------------------------------------------------//
//     ----- Initialize the video player and overlay -----      //
//--------------------------------------------------------------//
window.handleVideoUpload = async function (event) {
  const file = event?.target?.files?.[0];
  if (!file) return;

  const video = document.getElementById('videoPlayer');
  const prompt = document.getElementById('overlayPrompt');
  const loader = document.getElementById('session-status');

  window.stopFrameAnalysis?.();  // ensure old RAF loop is dead

  // Soft resets
  try { resetAll?.(); } catch {}
  try { resetPlayerTracker?.(); } catch {}
  try { resetShotStats?.(); } catch {}

  // Local blob only (for now)
  const blobURL = URL.createObjectURL(file);
  console.log('[load] begin', { name: file.name, size: file.size });
  try { video.pause(); } catch {}
  video.preload = 'metadata';
  video.src = blobURL;
  video.load();

  const onMeta = () => {
    ensureOverlayCss();
    installOverlayTracer();
  };
  video.addEventListener('loadedmetadata', onMeta, { once: true });

  // Wait for metadata or a clear error
  await Promise.race([
    new Promise(res => video.addEventListener('loadedmetadata', res, { once: true })),
    new Promise((_, rej) => setTimeout(() => rej(new Error('metadata timeout')), 10000))
  ]);

  // after metadata is confirmed
  try {
    ensureOverlayCss?.();                          // stacking/sizing
    initOverlay?.(overlayEl, window.poseDetector ?? {}); // safe even if poseDetector not ready yet
    // after ensureOverlayCss(), initOverlay(...), etc. in handleVideoUpload
    try { startPreDetection(video); } catch (e) { console.warn('predetect start failed:', e); }
  } catch (e) { console.warn('initOverlay failed:', e); }

  // define with a captured canvas reference
  window.startFrameAnalysis = () => {
    if (!getLockedHoopBox?.()) {
      console.warn('[analyze] not starting: hoop not locked');
      return;
    }
    if (!overlayEl) {
      console.error('[analyze] no overlay canvas');
      return;
    }
    try { stopPreDetection(); } catch {}
    console.log('[analyze] starting main loop…');
    analyzeVideoFrameByFrame?.(video, overlayEl);
  };

  console.log('[load] metadata', {
    w: video.videoWidth, h: video.videoHeight, dur: video.duration,
    ready: video.readyState, src: video.currentSrc
  });

  // Stack/size overlay and add click tracer
  ensureOverlayCss();
  installOverlayTracer();

  // Show prompt, arm one-shot picker
  if (prompt) { prompt.textContent = '📍 Tap the hoop to begin setup'; prompt.style.display = 'block'; }
  enableHoopPickOnce();

  // Controls
  createPlaybackControls?.(video);

};

// ───────────────────────────────────────────────────────────────
// Analyzer (event-driven, no time-warping of the video element)
// ───────────────────────────────────────────────────────────────

// globals used by the analyzer
let __analyzing = false;
let __tickBusy  = false;
let __frameIdx  = 0;
let __rvfcId    = null;
let __detachAnalysis = null;

// Pose timestamp broker + serialized wrapper (ONE source of truth)
window.__poseTS = Math.floor(performance.now());
function nextPoseTS() {
  const base = Math.floor(performance.now());
  window.__poseTS = Math.max(window.__poseTS + 1, base);
  return window.__poseTS;
}
let __poseBusy = false;
export async function poseDetectSerial(bufferOrVideoEl) {
  if (!window.poseDetector || __poseBusy) return null;
  __poseBusy = true;
  try {
    return await window.poseDetector.detectForVideo(bufferOrVideoEl, nextPoseTS());
  } catch (e) {
    console.warn('pose detect error:', e);
    return null;
  } finally {
    __poseBusy = false;
  }
}

// Start or restart analysis safely
window.__analyzerActive = false;

window.stopFrameAnalysis = function stopFrameAnalysis() {
  if (typeof __detachAnalysis === 'function') __detachAnalysis();
  __detachAnalysis = null;
  __analyzing = false;
  window.__analyzerActive = false;
};

window.analyzeVideoFrameByFrame = function analyzeVideoFrameByFrame(videoEl, canvasEl) {
  if (window.__analyzerActive) return; // ✅ already running
  window.__analyzerActive = true;
  
  if (!videoEl || !canvasEl) { console.warn('[analyze] missing video/canvas'); return; }
  window.stopFrameAnalysis();
  __analyzing = true;
  __tickBusy  = false;
  __frameIdx  = 0;

  const ctx  = canvasEl.getContext('2d', { willReadFrequently: true });
  const buf  = document.createElement('canvas');
  const bctx = buf.getContext('2d', { willReadFrequently: true });

  const syncBufferSize = () => {
    if (buf.width !== canvasEl.width || buf.height !== canvasEl.height) {
      buf.width  = canvasEl.width;
      buf.height = canvasEl.height;
    }
  };
  syncBufferSize();

  let lastHandledT = -1;

  async function onTick() {
    if (!__analyzing || __tickBusy) return;
    if (videoEl.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;

    // use analyzer’s local counter as the canonical index
    const idx = __frameIdx;

    const t = videoEl.currentTime;
    if (t === lastHandledT) return; // de-dupe identical timestamps
    lastHandledT = t;

    __tickBusy = true;
    try {
      syncBufferSize();
      bctx.drawImage(videoEl, 0, 0, buf.width, buf.height);

      if (!buf.width || !buf.height) {
        console.warn('[detect] buffer is 0x0 — resizing…');
      }
      console.debug('[detect] tick', {
        bufW: buf.width, bufH: buf.height,
        t: videoEl.currentTime
      });

      // YOLO + pose in parallel; pose is serialized internally
      const [det, poseRes] = await Promise.all([
        sendFrameToDetect(buf, __frameIdx).catch(() => ({ objects: [] })),
        poseDetectSerial(buf)
      ]);

      const objects = det?.objects ?? [];
      stabilizeLockedHoop?.(objects);

      // NEW: maintain / choose the active player
      updateActivePlayer(objects, __frameIdx, canvasEl.width, canvasEl.height);

      // Pick the pose that matches the active player (or fallback heuristics)
      const hoopBox = getLockedHoopBox?.();
      updateActivePlayer(objects, __frameIdx);                      // NEW

      const poses = poseRes?.landmarks || [];
      const chosen = pickPoseForActive(poses, canvasEl, hoopBox);   // NEW
      if (chosen) {
        updatePlayerTracker?.(chosen.scaled, __frameIdx);
        playerState.keypoints = chosen.scaled;
        playerState.box = [chosen.box.x, chosen.box.y, chosen.box.x + chosen.box.w, chosen.box.y + chosen.box.h];
      }


      window.lastDetectedFrame = {
        __frameIdx: __frameIdx,
        objects,
        poses: poseRes?.landmarks ?? []
      };

      bufferDetectedObjects?.(objects);

      if (hoopBox) attachHoop?.(hoopBox);

      // pick the player active ball - proximity based
      const ball = pickBallCandidate(objects, hoopBox);
      if (ball && hoopBox) {
        // pass only the center we chose (updateBall only needs x,y + frame)
        updateBall?.({ x: ball.x, y: ball.y }, __frameIdx);

        scoringTick?.(__frameIdx);

        if (isPoseInReleasePosition?.(playerState) && ballState.state !== 'TRACKING') {
          markRelease?.(__frameIdx);

        }

        // optional HUD note on net motion
        ballState.netMoved = detectNetMotion?.(buf, hoopBox);
        drawNetMotionStatus?.(buf, ballState.netMoved);
      }


      checkShotConditions?.(ballState, hoopBox, __frameIdx);

      // if (Array.isArray(ballState.trail) &&
      //     ballState.trail.length > 20 &&
      //     !ballState.shotStarted &&
      //     !(getShotWindowBuffers?.().active)) {
      //   ballState.trail = ballState.trail.slice(-30);
      // }

      ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
      ctx.drawImage(buf, 0, 0);
      updateDebugOverlay?.(window.lastDetectedFrame.poses, objects, __frameIdx);
      drawLiveOverlay?.(objects, playerState);

      __frameIdx += 1;

      // notify frame-by-frame engine when in use
      try {
        window.dispatchEvent(new CustomEvent('analyzer:frame-done', {
          detail: { __frameIdx: __frameIdx, t }
        }));
      } catch {}
    } catch (err) {
      console.error('[analyze] tick error:', err);
    } finally {
      __tickBusy = false;
    }
  }

  // Prefer rvfc; fall back to events
  const usingRVFC = typeof videoEl.requestVideoFrameCallback === 'function';
  const fire = () => { if (__analyzing) onTick(); };

  if (usingRVFC) {
    const onVideoFrame = () => {
      if (!__analyzing) return;
      onTick();
      __rvfcId = videoEl.requestVideoFrameCallback(onVideoFrame);
    };
    __rvfcId = videoEl.requestVideoFrameCallback(onVideoFrame);
  } else {
    videoEl.addEventListener('timeupdate', fire);
  }

  videoEl.addEventListener('seeked', fire);
  videoEl.addEventListener('play',   fire);
  window.addEventListener('resize',  syncBufferSize);

  __detachAnalysis = () => {
    if (usingRVFC && __rvfcId != null) {
      try { videoEl.cancelVideoFrameCallback(__rvfcId); } catch {}
      __rvfcId = null;
    } else {
      videoEl.removeEventListener('timeupdate', fire);
    }
    videoEl.removeEventListener('seeked', fire);
    videoEl.removeEventListener('play',   fire);
    window.removeEventListener('resize',  syncBufferSize);
  };

  // kick once so boxes appear on first visible frame
  fire();
};



// ─────────────────────────────────────────────────────────────── //
//           ------------ helpers ----------------                 //
// ─────────────────────────────────────────────────────────────── //
function computePlayerBox(landmarks) {
  if (!Array.isArray(landmarks) || landmarks.length < 3) return null;
  const xs = landmarks.map(l => l.x);
  const ys = landmarks.map(l => l.y);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

  // reset shots
  window.resetShots = () => {
    resetAll();
    resetPlayerTracker();
    resetShotStats();
    window.__hoopAutoLocked = false;
  };

  window.useRealTimeTracking = false;

  videoPlayer.addEventListener('play', () => {
    if (window.useRealTimeTracking && !isTracking && typeof window.safeDetectForVideo === 'function') {
      startTracking();
    }
  });

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

// Instant owner if the ball is near/inside an expanded player box
function _immediateOwner(players, bc) {
  if (!bc) return null;
  let best = null, bestD = Infinity;

  for (const p of players) {
    // expand a bit to include outstretched arms: 0.35w horiz, 0.25h vert
    const zone = _inflate(p, 0.35, 0.25);
    const d = _ptRectDist(bc.x, bc.y, zone);

    // dynamic “possession” distance: tighter on close-ups, looser on wide shots
    const allow = Math.max(36, Math.min(160, p.w * 0.45));
    if (d <= allow && d < bestD) { best = p; bestD = d; }
  }
  return best; // null if none close enough
}

// Choose / keep the active player
export function updateActivePlayer(objects, frameIdx) {
  const players = (objects||[])
    .filter(o => (o.label === 'player' || o.label === 'person') && Array.isArray(o.box) && o.box.length===4)
    .map(o => _toBox(o.box));
  if (!players.length) return;

  // 1) Keep following if we still overlap well
  if (window.activePlayerBox) {
    let best=null, bestIoU=-1;
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

  // 2) Instant lock if the ball is clearly near / inside someone
  const bc = _ballCenter(objects);
  const owner = _immediateOwner(players, bc);
  if (owner) {
    window.activePlayerBox = owner;
    _activeLastSeenFrame = frameIdx;
    _voteBox = null; _voteCount = 0;
    // console.log('🎯 Active player (instant):', owner);
    return;
  }

  // 3) If we saw our active recently, keep it warm (no hard switch yet)
  if (_activeLastSeenFrame > 0 && frameIdx - _activeLastSeenFrame < KEEP_FRAMES) {
    return; // keep stale lock while we gather evidence
  }

  // 4) Voting fallback: nearest to ball center (or largest if no ball)
  let target = null;
  if (bc) {
    let best=players[0], bestD2=(players[0].cx-bc.x)**2 + (players[0].cy-bc.y)**2;
    for (let i=1; i<players.length; i++) {
      const d2=(players[i].cx-bc.x)**2 + (players[i].cy-bc.y)**2;
      if (d2 < bestD2) { best=players[i]; bestD2=d2; }
    }
    target = best;
  } else {
    // last resort: largest person box
    target = players.slice().sort((a,b)=> (b.w*b.h)-(a.w*a.h))[0];
  }

  // accumulate votes across frames for the same target (by IoU)
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
    // console.log('🎯 Active player (voted):', window.activePlayerBox);
  }
}

// From all poses, return the one that best matches activePlayerBox (or fallback)
export function pickPoseForActive(poses, canvasEl, hoopBox) {
  if (!poses?.length) return null;
  const W = canvasEl.width, H = canvasEl.height;

  const views = poses.map(ls => {
    const scaled = ls.map(k => ({ ...k, x:k.x*W, y:k.y*H }));
    const xs = scaled.map(k => k.x), ys = scaled.map(k => k.y);
    const x1=Math.min(...xs), y1=Math.min(...ys), x2=Math.max(...xs), y2=Math.max(...ys);
    return { scaled, box:{ x:x1, y:y1, w:x2-x1, h:y2-y1, cx:(x1+x2)/2, cy:(y1+y1)/2 } };
  });

  if (window.activePlayerBox) {
    views.sort((a,b)=>{
      const da=(a.box.cx-window.activePlayerBox.cx)**2 + (a.box.cy-window.activePlayerBox.cy)**2;
      const db=(b.box.cx-window.activePlayerBox.cx)**2 + (b.box.cy-window.activePlayerBox.cy)**2;
      return da-db;
    });
    return views[0];
  }

  if (hoopBox) {
    const cx = hoopBox.cx ?? (hoopBox.x + (hoopBox.w||0)/2);
    const cy = hoopBox.cy ?? (hoopBox.y + (hoopBox.h||0)/2);
    views.sort((a,b)=>{
      const da=(a.box.cx-cx)**2 + (a.box.cy-cy)**2;
      const db=(b.box.cx-cx)**2 + (b.box.cy-cy)**2;
      return da-db;
    });
    return views[0];
  }

  return views.slice().sort((a,b)=> (b.box.w*b.box.h)-(a.box.w*a.box.h))[0];
}

// One-click manual shooter pick (arm once → click a player box)
export function enablePlayerPickOnce(objects) {
  const ov = document.getElementById('overlay');
  if (!ov) return;
  const boxes = (objects||[])
    .filter(o => (o.label==='player'||o.label==='person') && Array.isArray(o.box) && o.box.length===4)
    .map(o => _toBox(o.box));

  function onClick(e){
    const r = ov.getBoundingClientRect();
    const x = (e.clientX - r.left) * (ov.width  / r.width);
    const y = (e.clientY - r.top ) * (ov.height / r.height);
    const hit = boxes.find(b => x>=b.x && x<=b.x+b.w && y>=b.y && y<=b.y+b.h);
    if (hit) {
      window.activePlayerBox = hit;
      _activeLastSeenFrame = Number.isFinite(window.__frameIdx) ? window.__frameIdx : 0;
      // console.log('🖱️ Active player set by click:', hit);
    }
    ov.style.pointerEvents='none';
    ov.removeEventListener('click', onClick);
  }

  ov.style.pointerEvents='auto';
  ov.style.cursor='crosshair';
  ov.addEventListener('click', onClick, { once:true });

  // backstop in case nothing is clicked
  setTimeout(()=> {
    ov.style.pointerEvents='none';
    ov.removeEventListener('click', onClick);
  }, 6000);
}


// End Active Player ────────────────────────────────────────────────────


  // Choose the correct ball when several are on screen.
  function pickBallCandidate(objects, hoopBox) {
    const balls = (objects || []).filter(o => o.label === 'basketball');
    if (!balls.length) return null;

    // Ensure every candidate has x,y center coords
    const withCenters = balls.map(b => {
      if (Number.isFinite(b.x) && Number.isFinite(b.y)) return b;
      if (Array.isArray(b.box) && b.box.length === 4) {
        const [x1, y1, x2, y2] = b.box;
        return { ...b, x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
      }
      return null;
    }).filter(Boolean);

    if (!withCenters.length) return null;

    // 1) If we already have a live trail, stick to the nearest detection
    const last = window.ballState?.trail?.at?.(-1);
    if (last) {
      withCenters.sort((a, b) =>
        ((a.x - last.x) ** 2 + (a.y - last.y) ** 2) -
        ((b.x - last.x) ** 2 + (b.y - last.y) ** 2)
      );
      return withCenters[0];
    }

    // 2) Prefer any ball inside the hoop proximity zone
    const inProx = withCenters.filter(p => isBallInProximityZone?.(p));
    if (inProx.length) {
      inProx.sort((a, b) => (b.conf ?? 0) - (a.conf ?? 0));
      return inProx[0];
    }

    // 3) Otherwise pick the one closest to the selected hoop center
    if (hoopBox) {
      const cx = hoopBox.cx ?? (hoopBox.x + (hoopBox.w || 0) / 2);
      const cy = hoopBox.cy ?? (hoopBox.y + (hoopBox.h || 0) / 2);
      withCenters.sort((a, b) =>
        ((a.x - cx) ** 2 + (a.y - cy) ** 2) -
        ((b.x - cx) ** 2 + (b.y - cy) ** 2)
      );
      return withCenters[0];
    }

    // 4) Last resort: highest confidence
    withCenters.sort((a, b) => (b.conf ?? 0) - (a.conf ?? 0));
    return withCenters[0];
  }


  // pose detection check on video loadeddata
  videoPlayer.addEventListener('loadeddata', async () => {
    try {
      if (!window.poseDetector) {
        await initPoseDetector();
      }

      if (typeof window.safeDetectForVideo === 'function') {
        console.log("✅ Pose detector ready — awaiting hoop selection...");
      } else {
        console.warn("⚠️ Pose detector not ready after init.");
      }
    } catch (err) {
      console.error("❌ Failed to initialize PoseLandmarker:", err);
    }
  });

  window.useCamera = () => {
    navigator.mediaDevices.getUserMedia({ video: true }).then(stream => {
      videoPlayer.srcObject = stream;
    });
  };

  window.resetShots = () => {
    resetAll();
    resetPlayerTracker();
    resetShotStats();
    ballTrackingStarted = false;
    pendingFreezeFrame = null;
    ballState.tracking = false;
    ballState.frozenFrameId = null;
    ballState.trail = [];
    lastShotFrameId = -1;
    window.__hoopAutoLocked = false;
    const table = document.querySelector('#shotTable tbody');
    if (table) table.innerHTML = '';
    const details = document.getElementById('shotDetails');
    if (details) details.textContent = 'No shot data loaded.';
  };

