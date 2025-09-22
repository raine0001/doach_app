import { resetAll, setBallActive, updateBall } from './ball_tracker.js';
import { updateArc as shotArcUpdateArc, proxFromHoop, resetShotFSM as resetShotFSM } from './shot_arc.js';
import { scoringTick, checkShotConditions, summarizeShot } from './shot_logger.js';
import { canonHoop } from './hoop_tracker.js';

const DETECTOR_MODEL_URL = '/static/models/best.onnx';
const DETECTOR_FALLBACK_URL = '/static/models/backup_best.onnx';
const DETECTOR_LABELS = ['basketball', 'hoop', 'net', 'backboard', 'player'];

if (typeof self.CustomEvent !== 'function') {
  self.CustomEvent = class CustomEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail;
      this.bubbles = !!init.bubbles;
      this.cancelable = !!init.cancelable;
      this.timeStamp = Date.now();
    }
    preventDefault() { this.defaultPrevented = true; }
  };
}

const __nativeDispatchEvent = typeof self.dispatchEvent === 'function' ? self.dispatchEvent.bind(self) : null;
if (__nativeDispatchEvent) {
  self.dispatchEvent = function microclipDispatchEvent(event) {
    try {
      return __nativeDispatchEvent(event);
    } catch (_) {
      return false;
    }
  };
}

let detectorWorker = null;
let detectorReady = false;
let detectorReadyPromise = null;
let resolveDetectorReady = null;
let rejectDetectorReady = null;
const detectorPending = new Map();
let detectorSeq = 0;

function ensureDetectorWorker() {
  if (detectorReady) return Promise.resolve();
  if (detectorReadyPromise) return detectorReadyPromise;

  detectorReadyPromise = new Promise((resolve, reject) => {
    resolveDetectorReady = resolve;
    rejectDetectorReady = reject;
    try {
      detectorWorker = new Worker('/static/js/detector.worker.js', { name: 'microclip-detector' });
      detectorWorker.addEventListener('message', onDetectorMessage);
      detectorWorker.addEventListener('error', (err) => {
        if (!detectorReady) rejectDetectorReady?.(err);
      });
    } catch (err) {
      reject(err);
      return;
    }
    detectorWorker.postMessage({
      type: 'init',
      modelUrl: DETECTOR_MODEL_URL,
      fbUrl: DETECTOR_FALLBACK_URL,
      labels: DETECTOR_LABELS
    });
  });

  return detectorReadyPromise;
}

function onDetectorMessage(event) {
  const data = event?.data || {};
  if (data.type === 'ready') {
    detectorReady = true;
    resolveDetectorReady?.();
    return;
  }
  if (data.type === 'error') {
    if (!detectorReady) {
      rejectDetectorReady?.(new Error(data.error || 'detector-init-error'));
    } else {
      for (const [id, entry] of detectorPending.entries()) {
        detectorPending.delete(id);
        entry.reject(new Error(data.error || 'detector-error'));
      }
    }
    return;
  }
  if (data.type === 'result') {
    const entry = detectorPending.get(data.frameIndex);
    if (!entry) return;
    detectorPending.delete(data.frameIndex);
    try {
      const adjusted = adjustDetectorObjects(data.objects || [], entry.meta);
      entry.resolve({ objects: adjusted, source: data._source || 'detector' });
    } catch (err) {
      entry.reject(err);
    }
  }
}

function detectBitmap(bitmap, width, height, meta) {
  return ensureDetectorWorker().then(() => new Promise((resolve, reject) => {
    const reqId = detectorSeq++;
    const timeout = setTimeout(() => {
      if (detectorPending.has(reqId)) {
        detectorPending.delete(reqId);
        reject(new Error('detector-timeout'));
      }
    }, 2000);
    detectorPending.set(reqId, {
      resolve: (result) => { clearTimeout(timeout); resolve(result); },
      reject: (err) => { clearTimeout(timeout); reject(err); },
      meta
    });
    detectorWorker.postMessage({ type: 'detect', frameIndex: reqId, bitmap, ow: width, oh: height }, [bitmap]);
  }));
}

function adjustDetectorObjects(objs, meta = {}) {
  const offsetX = Number(meta.offsetX) || 0;
  const offsetY = Number(meta.offsetY) || 0;
  const scaleX = Number(meta.scaleX) || 1;
  const scaleY = Number(meta.scaleY) || 1;
  return (objs || []).map((obj) => {
    if (Array.isArray(obj.box)) {
      const [x1, y1, x2, y2] = obj.box;
      return {
        ...obj,
        box: [
          x1 * scaleX + offsetX,
          y1 * scaleY + offsetY,
          x2 * scaleX + offsetX,
          y2 * scaleY + offsetY
        ]
      };
    }
    return obj;
  });
}

export function normalizeFrames(input) {
  if (!Array.isArray(input)) return [];
  const normalized = [];
  for (let i = 0; i < input.length; i++) {
    const item = input[i];
    if (!item) continue;
    if (item instanceof ImageBitmap) {
      normalized.push({ bitmap: item, frameIdx: i, ts: null, meta: null });
    } else if (item.bitmap instanceof ImageBitmap) {
      const idx = Number.isFinite(item.frameIdx) ? item.frameIdx : i;
      normalized.push({
        bitmap: item.bitmap,
        frameIdx: idx,
        ts: Number.isFinite(item.ts) ? item.ts : null,
        meta: item
      });
    }
  }
  return normalized;
}

export function disposeFrameCollection(frames) {
  if (!Array.isArray(frames)) return;
  for (const entry of frames) {
    const bmp = entry instanceof ImageBitmap ? entry : entry?.bitmap;
    if (bmp && typeof bmp.close === 'function') {
      try { bmp.close(); } catch {}
    }
  }
}

export async function runMicroclipJob(job, { postProgress } = {}) {
  const frames = Array.isArray(job?.frames) ? job.frames : [];
  const total = frames.length;
  if (!total) {
    return { summary: buildSummary({ status: job?.cancelled ? 'cancelled' : 'empty', framesUsed: 0 }) };
  }

  const first = frames[0];
  const width = Number(first.bitmap?.width || first.width);
  const height = Number(first.bitmap?.height || first.height);
  if (!(width > 0 && height > 0)) {
    return { summary: buildSummary({ status: 'invalid', framesUsed: 0 }) };
  }

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  prepareShotEnvironment(job, { width, height });

  const detectStride = Math.max(1, Number(job.detectStride) || 6);
  const hoop = canonHoop(job?.hoop || (job?.meta?.hoop) || {});
  const hoopAccessor = () => hoop;
  self.getLockedHoopBox = hoopAccessor;

  let processed = 0;
  let lastBall = null;
  let lastDetections = [];
  let lastFrameIdx = Number.isFinite(first.frameIdx) ? first.frameIdx : 0;
  let earlyStop = false;
  const trailSamples = [];

  for (let i = 0; i < total; i++) {
    if (job.cancelled) break;
    const frame = frames[i];
    const frameIdx = Number.isFinite(frame.frameIdx)
      ? frame.frameIdx
      : (lastFrameIdx + 1);
    lastFrameIdx = frameIdx;

    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(frame.bitmap, 0, 0, width, height);

    let detections = lastDetections;
    if (!detections.length || (i % detectStride) === 0) {
      detections = await detectWithROI(ctx, canvas, hoop, frameIdx).catch(() => []);
      if (detections.length) {
        lastDetections = detections;
      }
    }

    let ballPoint = pickBallCenter(detections, lastBall, hoop);
    if (!ballPoint && lastBall) {
      const refined = refineBallWithROI(ctx, lastBall, 18);
      if (refined) ballPoint = refined;
    }
    if (!ballPoint && detections.length) {
      ballPoint = pickBallCenter(detections, null, hoop, true);
    }
    if (!ballPoint && lastBall) {
      ballPoint = { x: lastBall.x, y: lastBall.y };
    }

    if (ballPoint) {
      updateBall(ballPoint, frameIdx);
      updateProxStampsWorker(frameIdx, ballPoint, hoop);
      shotArcUpdateArc(frameIdx, ballPoint, hoop);
      lastBall = ballPoint;
    }

    scoringTick(frameIdx);
    checkShotConditions(self.ballState, hoop, frameIdx);

    processed++;
    if (typeof postProgress === 'function' && (processed === total || processed === 1 || (processed % 6) === 0)) {
      postProgress({
        stage: 'processing',
        frameIndex: processed,
        framesTotal: total,
        proxEnter: self.ballState?.proxEnterFrame ?? null,
        proxExit: self.ballState?.proxExitFrame ?? null
      });
    }

    const trail = self.ballState?.trail;
    if (Array.isArray(trail) && trail.length && (i === total - 1 || (processed % 5) === 0)) {
      const pt = trail.at(-1);
      if (pt) trailSamples.push({ x: Math.round(pt.x), y: Math.round(pt.y), frame: pt.frame });
    }

    frame.bitmap?.close?.();

    const exitFrame = self.ballState?.proxExitFrame;
    if (Number.isFinite(exitFrame) && (frameIdx - exitFrame) >= 20) {
      earlyStop = true;
      break;
    }
    const enterFrame = self.ballState?.proxEnterFrame;
    if (Number.isFinite(enterFrame) && (frameIdx - enterFrame) >= 60) {
      earlyStop = true;
      break;
    }
  }

  const summary = finalizeSummary({
    hoop,
    frameIdx: lastFrameIdx,
    framesProcessed: processed,
    trailSamples,
    cancelled: job.cancelled,
    earlyStop
  });

  setBallActive(false);
  return { summary };
}

function prepareShotEnvironment(job, dims) {
  resetShotFSM();
  resetAll();
  setBallActive(true);
  self.ballState.releaseFrame = Number.isFinite(job?.releaseFrame)
    ? job.releaseFrame
    : Number.isFinite(job?.meta?.releaseFrame)
      ? job.meta.releaseFrame
      : 0;
  self.ballState.state = 'TRACKING';
  self.ballState.trail = [];
  self.ballState.shots = [];
  self.__shotTrackingArmed = true;
  self.__hoopConfirmed = true;
  self.__RESET_SEEN_BELOW = true;
  self.POSE_FIRST_ONLY = false;
  self.__fbf = { active: true, startFrame: self.ballState.releaseFrame || 0, stopFrame: -1 };
  self.__SESSION_ACTIVE = true;
  self.__shotList = Array.isArray(self.__shotList) ? self.__shotList : [];
  if (!Array.isArray(self.shotLog)) self.shotLog = [];
  return dims;
}

async function detectWithROI(ctx, canvas, hoop, frameIdx) {
  const width = canvas.width;
  const height = canvas.height;
  const roi = computeROI(hoop, width, height);

  const runFull = async () => {
    const fullBitmap = await createImageBitmap(canvas);
    const result = await detectBitmap(fullBitmap, width, height, { offsetX: 0, offsetY: 0, frameIdx });
    return result.objects;
  };

  if (!roi) {
    return await runFull();
  }

  const roiCanvas = new OffscreenCanvas(roi.w, roi.h);
  const roiCtx = roiCanvas.getContext('2d');
  roiCtx.drawImage(canvas, roi.x, roi.y, roi.w, roi.h, 0, 0, roi.w, roi.h);
  const roiBitmap = await createImageBitmap(roiCanvas);
  const detection = await detectBitmap(roiBitmap, roi.w, roi.h, { offsetX: roi.x, offsetY: roi.y, frameIdx });
  const objects = detection.objects || [];
  const hasBall = objects.some(o => o?.label === 'basketball');
  if (!hasBall) {
    return await runFull();
  }
  return objects;
}

function computeROI(hoop, width, height) {
  if (!hoop || !Number.isFinite(hoop.cx) || !Number.isFinite(hoop.cy)) return null;
  const scale = Number(self.ROI_SUPERSAMPLE || 1.6);
  const hoopWidth = Math.max(hoop.w || 100, 60);
  const hoopHeight = Math.max(hoop.h || 80, 40);
  const roiW = Math.min(width, Math.round(hoopWidth * scale));
  const roiH = Math.min(height, Math.round(hoopHeight * scale * 1.8));
  const cx = hoop.cx;
  const cy = hoop.cy;
  let x = Math.max(0, Math.round(cx - roiW / 2));
  let y = Math.max(0, Math.round(cy - roiH * 0.45));
  if (x + roiW > width) x = Math.max(0, width - roiW);
  if (y + roiH > height) y = Math.max(0, height - roiH);
  return { x, y, w: roiW, h: roiH };
}

function pickBallCenter(objects, lastPoint, hoop, allowLoose = false) {
  const balls = (objects || [])
    .filter(o => o && o.label === 'basketball' && Array.isArray(o.box))
    .map(o => {
      const [x1, y1, x2, y2] = o.box;
      return { cx: (x1 + x2) / 2, cy: (y1 + y2) / 2, area: (x2 - x1) * (y2 - y1), box: o.box, raw: o };
    });
  if (!balls.length) return null;

  balls.sort((a, b) => b.area - a.area);
  const maxStep = Math.max(48, Number(self.BALL_MAX_STEP || 60));
  if (lastPoint) {
    let best = null;
    let bestScore = Infinity;
    for (const cand of balls) {
      const dist = Math.hypot(cand.cx - lastPoint.x, cand.cy - lastPoint.y);
      if (!allowLoose && dist > maxStep * 1.5) continue;
      if (dist < bestScore) {
        bestScore = dist;
        best = cand;
      }
    }
    if (best) return { x: Math.round(best.cx), y: Math.round(best.cy) };
  }

  const cand = balls[0];
  return cand ? { x: Math.round(cand.cx), y: Math.round(cand.cy) } : null;
}

function refineBallWithROI(ctx, lastPt, win = 18) {
  if (!lastPt || !ctx) return null;
  const x = Math.round(lastPt.x);
  const y = Math.round(lastPt.y);
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const half = Math.max(6, Math.min(win, 40));
  const x1 = Math.max(0, x - half);
  const y1 = Math.max(0, y - half);
  const ww = Math.min(half * 2 + 1, w - x1);
  const hh = Math.min(half * 2 + 1, h - y1);
  if (ww < 4 || hh < 4) return null;

  let bestScore = -1;
  let bestPoint = null;
  try {
    const img = ctx.getImageData(x1, y1, ww, hh).data;
    for (let j = 1; j < hh - 1; j++) {
      for (let i = 1; i < ww - 1; i++) {
        const idx = (j * ww + i) * 4;
        const gx = Math.abs(img[idx + 4] - img[idx - 4]);
        const gy = Math.abs(img[idx + ww * 4] - img[idx - ww * 4]);
        const score = gx + gy;
        if (score > bestScore) {
          bestScore = score;
          bestPoint = { x: x1 + i, y: y1 + j };
        }
      }
    }
  } catch {}
  return bestScore > 2 ? bestPoint : null;
}

function updateProxStampsWorker(frameIdx, ballCenter, hoopLocked) {
  if (!ballCenter || !hoopLocked) return;
  const base = proxFromHoop(hoopLocked);
  if (!base) return;
  const pad = Math.max(6, Math.round((hoopLocked.w || 80) * 0.08));
  const prox = { x: base.x - pad, y: base.y - pad, w: base.w + pad * 2, h: base.h + pad * 2 };
  const inside = ballCenter.x >= prox.x && ballCenter.x <= prox.x + prox.w && ballCenter.y >= prox.y && ballCenter.y <= prox.y + prox.h;
  const bs = self.ballState;
  if (!bs) return;
  bs._proxInsideStreak = inside ? (bs._proxInsideStreak || 0) + 1 : 0;
  bs._proxOutsideStreak = !inside ? (bs._proxOutsideStreak || 0) + 1 : 0;
  if (inside && bs.proxEnterFrame == null && bs._proxInsideStreak >= 2) {
    bs.proxEnterFrame = frameIdx;
  }
  if (!inside && bs.proxExitFrame == null && bs._proxOutsideStreak >= 2) {
    bs.proxExitFrame = frameIdx;
  }
  bs._lastInProx = inside;
}

function finalizeSummary({ hoop, frameIdx, framesProcessed, trailSamples, cancelled, earlyStop }) {
  const bs = self.ballState || {};
  const shots = Array.isArray(bs.shots) ? bs.shots : [];
  const frozen = shots.at?.(-1);
  const trail = (frozen?.trail?.length >= 3) ? frozen.trail : (Array.isArray(bs.trail) ? bs.trail : []);
  let summary = null;
  if (trail.length >= 3 && hoop) {
    summary = summarizeShot(trail, frameIdx, hoop, { force: true });
  }

  const payload = buildSummary({
    ...summary,
    made: summary?.made ?? null,
    arcHeight: summary?.arcHeight ?? null,
    entryAngle: summary?.entryAngle ?? null,
    releaseAngle: summary?.releaseAngle ?? null,
    releaseFrame: bs.releaseFrame ?? null,
    frameStart: summary?.frameStart ?? trail.at?.(0)?.frame ?? null,
    frameEnd: summary?.frameEnd ?? frameIdx ?? null,
    proxEnter: bs.proxEnterFrame ?? null,
    proxExit: bs.proxExitFrame ?? null,
    framesUsed: framesProcessed,
    status: cancelled ? 'cancelled' : (summary ? 'ok' : 'incomplete'),
    trailSample: sampleTrail(trailSamples, trail)
  });

  if (earlyStop && payload.status === 'ok') {
    payload.status = 'ok-early-stop';
  }
  if (cancelled) payload.status = 'cancelled';

  return payload;
}

function buildSummary({
  made = null,
  arcHeight = null,
  entryAngle = null,
  releaseAngle = null,
  trailSample = [],
  proxEnter = null,
  proxExit = null,
  framesUsed = 0,
  status = 'stubbed',
  releaseFrame = null,
  frameStart = null,
  frameEnd = null
} = {}) {
  return {
    made,
    arcHeight,
    releaseAngle,
    entryAngle,
    trailSample,
    proxEnter,
    proxExit,
    framesUsed,
    status,
    releaseFrame,
    frameStart,
    frameEnd
  };
}

function sampleTrail(samples, trail) {
  if (Array.isArray(samples) && samples.length) return dedupeSamples(samples);
  if (!Array.isArray(trail) || !trail.length) return [];
  const stride = 5;
  const out = [];
  for (let i = 0; i < trail.length; i += stride) {
    const p = trail[i];
    if (p) out.push({ x: Math.round(p.x), y: Math.round(p.y), frame: p.frame });
  }
  const last = trail.at?.(-1);
  if (last) out.push({ x: Math.round(last.x), y: Math.round(last.y), frame: last.frame });
  return dedupeSamples(out);
}

function dedupeSamples(list) {
  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (!item) continue;
    const key = `${item.frame}:${Math.round(item.x)}:${Math.round(item.y)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ x: Math.round(item.x), y: Math.round(item.y), frame: item.frame });
  }
  return out;
}

export function serializeError(error) {
  if (!error) return { name: 'Error', message: 'Unknown worker error', stack: null };
  return {
    name: error.name || 'Error',
    message: error.message || String(error),
    stack: error.stack || null
  };
}
