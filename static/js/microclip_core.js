const DETECTOR_MODEL_URL = '/static/models/best.onnx';
const DETECTOR_FALLBACK_URL = '/static/models/backup_best.onnx';
const DETECTOR_LABELS = ['basketball', 'hoop', 'net', 'backboard', 'player'];

function isBallLabel(label) {
  try {
    if (typeof window.isBallLabel === 'function') return !!window.isBallLabel(label);
  } catch {}
  return String(label).toLowerCase() === 'basketball';
}

let detectorWorker = null;
let detectorReady = false;
let detectorReadyPromise = null;
let resolveDetectorReady = null;
let rejectDetectorReady = null;
const detectorPending = new Map();
let detectorSeq = 0;

const DEFAULT_OPTIONS = {
  maxTrailPoints: 260,
  maxStepPx: 64,
  gapFillMax: 4,
  progressStride: 6,
  refineWindow: 18,
  earlyStopFrames: 20,
  lingerLimit: 60
};

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

function normalizeHoop(raw) {
  if (!raw) return null;
  const w = Number(raw.w ?? raw.width ?? 0);
  const h = Number(raw.h ?? raw.height ?? 0);
  let x = Number(raw.x ?? raw.x1 ?? (raw.cx != null ? raw.cx - w / 2 : 0));
  let y = Number(raw.y ?? raw.y1 ?? (raw.cy != null ? raw.cy - h / 2 : 0));
  const cx = Number(raw.cx ?? (x + w / 2));
  const cy = Number(raw.cy ?? (y + h / 2));
  const rimTop = Number(raw.rimTop ?? y);
  return { x, y, w, h, cx, cy, rimTop };
}

function createShotState({ releaseFrame, hoop, options = {} }) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  return {
    releaseFrame: Number.isFinite(releaseFrame) ? releaseFrame : null,
    proxEnterFrame: null,
    proxExitFrame: null,
    trail: [],
    arcTrail: [],
    trailSamples: [],
    lastBall: null,
    lastFrame: null,
    proxInsideStreak: 0,
    proxOutsideStreak: 0,
    hoop,
    options: opts
  };
}

function updateBallState(state, point, frameIdx) {
  if (!point) return;
  if (state.releaseFrame == null) state.releaseFrame = frameIdx;
  const opts = state.options;
  let px = point.x;
  let py = point.y;
  const last = state.trail.at(-1);
  if (last) {
    const gap = frameIdx - last.frame;
    if (gap > 1 && gap <= opts.gapFillMax) {
      for (let g = 1; g < gap; g++) {
        const t = g / gap;
        state.trail.push({
          x: last.x + (px - last.x) * t,
          y: last.y + (py - last.y) * t,
          frame: last.frame + g,
          tMs: last.tMs
        });
      }
    }
    const dx = px - last.x;
    const dy = py - last.y;
    const dist = Math.hypot(dx, dy);
    if (dist > opts.maxStepPx) {
      const r = opts.maxStepPx / (dist || 1);
      px = last.x + dx * r;
      py = last.y + dy * r;
    }
  }

  const tMs = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  state.trail.push({ x: px, y: py, frame: frameIdx, tMs });
  if (state.trail.length > opts.maxTrailPoints) state.trail.shift();
  state.lastBall = { x: px, y: py };
  state.lastFrame = frameIdx;
}

function computeProxRect(hoop) {
  if (!hoop) return null;
  const proxX = Number(self.proxX) || 200;
  const proxYAbove = Number(self.proxYAbove) || 170;
  const proxYBelow = Number(self.proxYBelow) || 100;
  return {
    x: hoop.cx - proxX,
    y: hoop.rimTop - proxYAbove,
    w: proxX * 2,
    h: proxYAbove + proxYBelow
  };
}

function updateProx(state, frameIdx, ball, hoop) {
  if (!ball || !hoop) return;
  const prox = computeProxRect(hoop);
  if (!prox) return;
  const inside = ball.x >= prox.x && ball.x <= prox.x + prox.w && ball.y >= prox.y && ball.y <= prox.y + prox.h;
  if (inside) {
    state.proxInsideStreak += 1;
    state.proxOutsideStreak = 0;
    if (state.proxEnterFrame == null && state.proxInsideStreak >= 2) state.proxEnterFrame = frameIdx;
  } else {
    state.proxOutsideStreak += 1;
    state.proxInsideStreak = 0;
    if (state.proxExitFrame == null && state.proxOutsideStreak >= 2 && state.proxEnterFrame != null) {
      state.proxExitFrame = frameIdx;
    }
  }
}

function updateArc(state, ball, frameIdx) {
  if (!ball) return;
  const releaseFrame = Number.isFinite(state.releaseFrame) ? state.releaseFrame : state.trail[0]?.frame;
  if (releaseFrame != null && frameIdx >= releaseFrame) {
    const lastArc = state.arcTrail.at(-1);
    if (lastArc && frameIdx - lastArc.frame > 1) {
      const gap = frameIdx - lastArc.frame;
      for (let g = 1; g < gap; g++) {
        const t = g / gap;
        state.arcTrail.push({
          x: lastArc.x + (ball.x - lastArc.x) * t,
          y: lastArc.y + (ball.y - lastArc.y) * t,
          frame: lastArc.frame + g
        });
      }
    }
    state.arcTrail.push({ x: ball.x, y: ball.y, frame: frameIdx });
  }
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

function pickBallCenter(objects, lastBall, allowLoose = false, maxStep = 60) {
  const balls = (objects || [])
    .filter(o => o && isBallLabel(o.label) && Array.isArray(o.box))
    .map(o => {
      const [x1, y1, x2, y2] = o.box;
      return { cx: (x1 + x2) / 2, cy: (y1 + y2) / 2, area: Math.max(1, (x2 - x1) * (y2 - y1)) };
    })
    .sort((a, b) => b.area - a.area);
  if (!balls.length) return null;

  if (lastBall) {
    let best = null;
    let bestScore = Infinity;
    for (const cand of balls) {
      const dist = Math.hypot(cand.cx - lastBall.x, cand.cy - lastBall.y);
      if (!allowLoose && dist > maxStep * 1.6) continue;
      if (dist < bestScore) {
        bestScore = dist;
        best = cand;
      }
    }
    if (best) return { x: Math.round(best.cx), y: Math.round(best.cy) };
  }

  const first = balls[0];
  return first ? { x: Math.round(first.cx), y: Math.round(first.cy) } : null;
}

function computeAngles(trail, count = 6) {
  if (!Array.isArray(trail) || trail.length < 2) return null;
  const vectors = [];
  for (let i = 1; i < trail.length && vectors.length < count; i++) {
    const a = trail[i - 1];
    const b = trail[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 1.2) continue;
    const angle = Math.atan2(-dy, dx) * (180 / Math.PI);
    vectors.push(angle);
  }
  if (!vectors.length) return null;
  const sum = vectors.reduce((acc, v) => acc + v, 0);
  return +(sum / vectors.length).toFixed(2);
}

function computeEntryAngle(trail, count = 6) {
  if (!Array.isArray(trail) || trail.length < 2) return null;
  const vectors = [];
  for (let i = trail.length - 1; i > 0 && vectors.length < count; i--) {
    const a = trail[i - 1];
    const b = trail[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 1.2) continue;
    const angle = Math.atan2(-dy, dx) * (180 / Math.PI);
    vectors.push(angle);
  }
  if (!vectors.length) return null;
  const sum = vectors.reduce((acc, v) => acc + v, 0);
  return +(sum / vectors.length).toFixed(2);
}

function computeMade(state, hoop) {
  if (!hoop) return null;
  if (state.proxEnterFrame == null) return null;
  const trail = state.trail;
  if (!trail.length) return null;
  const last = trail[trail.length - 1];
  const rimBottom = hoop.rimTop + hoop.h;
  const insideX = last.x >= hoop.x && last.x <= hoop.x + hoop.w;
  if (state.proxExitFrame != null && insideX && last.y > rimBottom + 40) return true;
  if (state.proxExitFrame == null && last.y < hoop.rimTop + 20) return null;
  if (last.y > rimBottom + 10) return false;
  return null;
}

function sampleTrail(trail) {
  if (!Array.isArray(trail) || !trail.length) return [];
  const stride = 5;
  const out = [];
  for (let i = 0; i < trail.length; i += stride) {
    const p = trail[i];
    out.push({ x: Math.round(p.x), y: Math.round(p.y), frame: p.frame });
  }
  const last = trail.at(-1);
  if (last) out.push({ x: Math.round(last.x), y: Math.round(last.y), frame: last.frame });
  const seen = new Set();
  return out.filter((p) => {
    const key = `${p.frame}:${p.x}:${p.y}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function computeArcHeight(state, hoop) {
  if (!hoop) return null;
  const trail = state.arcTrail.length ? state.arcTrail : state.trail;
  if (!trail.length) return null;
  const apex = trail.reduce((acc, p) => (p.y < acc.y ? p : acc), trail[0]);
  return Math.round((hoop.rimTop ?? hoop.y) - apex.y);
}

function finalizeSummary(state, meta) {
  const { hoop, framesProcessed, cancelled, earlyStop } = meta;
  const trail = state.trail.slice();
  if (!trail.length) {
    return buildSummary({ status: cancelled ? 'cancelled' : 'incomplete', framesUsed: framesProcessed });
  }

  const arcHeight = computeArcHeight(state, hoop);
  const releaseAngle = computeAngles(trail);
  const entryAngle = computeEntryAngle(trail);
  const made = computeMade(state, hoop);
  const frameStart = trail[0]?.frame ?? null;
  const frameEnd = trail.at(-1)?.frame ?? null;

  let status = cancelled ? 'cancelled' : 'ok';
  if (!trail.length) status = 'incomplete';
  if (earlyStop && status === 'ok') status = 'ok-early-stop';

  return buildSummary({
    made,
    arcHeight,
    releaseAngle,
    entryAngle,
    trailSample: sampleTrail(trail),
    proxEnter: state.proxEnterFrame,
    proxExit: state.proxExitFrame,
    framesUsed: framesProcessed,
    status,
    releaseFrame: state.releaseFrame,
    frameStart,
    frameEnd
  });
}

function buildSummary({
  made = null,
  arcHeight = null,
  releaseAngle = null,
  entryAngle = null,
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

async function detectWithROI(ctx, canvas, hoop, frameIdx) {
  const width = canvas.width;
  const height = canvas.height;

  const fullDetect = async () => {
    const bmp = await createImageBitmap(canvas);
    const result = await detectBitmap(bmp, width, height, { offsetX: 0, offsetY: 0, frameIdx });
    return result.objects;
  };

  const prox = normalizeHoop(hoop);
  if (!prox) return await fullDetect();

  const roi = computeROIFromHoop(prox, width, height);
  if (!roi) return await fullDetect();

  if (typeof OffscreenCanvas === 'undefined') {
    return await fullDetect();
  }
  const roiCanvas = new OffscreenCanvas(roi.w, roi.h);
  const roiCtx = roiCanvas.getContext('2d');
  roiCtx.drawImage(canvas, roi.x, roi.y, roi.w, roi.h, 0, 0, roi.w, roi.h);
  const roiBitmap = await createImageBitmap(roiCanvas);
  const detection = await detectBitmap(roiBitmap, roi.w, roi.h, {
    offsetX: roi.x,
    offsetY: roi.y,
    scaleX: 1,
    scaleY: 1,
    frameIdx
  });
  const objects = detection.objects || [];
  const hasBall = objects.some(o => isBallLabel(o?.label));
  if (hasBall) return objects;
  return await fullDetect();
}

function computeROIFromHoop(hoop, width, height) {
  const scale = Number(self.ROI_SUPERSAMPLE || 1.6);
  const w = Math.min(width, Math.round(Math.max(hoop.w, 80) * scale));
  const h = Math.min(height, Math.round(Math.max(hoop.h, 80) * scale * 1.8));
  let x = Math.max(0, Math.round(hoop.cx - w / 2));
  let y = Math.max(0, Math.round(hoop.cy - h * 0.45));
  if (x + w > width) x = Math.max(0, width - w);
  if (y + h > height) y = Math.max(0, height - h);
  return { x, y, w, h };
}

function updateTrailSamples(state, frameIdx) {
  const trail = state.trail;
  if (!trail.length) return;
  const last = trail.at(-1);
  if (!last) return;
  state.trailSamples.push({ x: Math.round(last.x), y: Math.round(last.y), frame: frameIdx });
  if (state.trailSamples.length > state.options.maxTrailPoints) state.trailSamples.shift();
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

  if (typeof OffscreenCanvas === 'undefined') {
    throw new Error('OffscreenCanvas unavailable in microclip worker');
  }
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const hoop = normalizeHoop(job?.hoop || job?.meta?.hoop || null);
  const releaseFrame = Number.isFinite(job?.releaseFrame) ? job.releaseFrame : Number(job?.meta?.releaseFrame) || null;
  const state = createShotState({ releaseFrame, hoop });

  let processed = 0;
  let earlyStop = false;
  let lastDetections = [];
  let lastFrameIdx = Number.isFinite(first.frameIdx) ? first.frameIdx : 0;

  for (let i = 0; i < total; i++) {
    if (job.cancelled) break;
    const frame = frames[i];
    const frameIdx = Number.isFinite(frame.frameIdx) ? frame.frameIdx : lastFrameIdx + 1;
    lastFrameIdx = frameIdx;

    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(frame.bitmap, 0, 0, width, height);

    let detections = lastDetections;
    const stride = Math.max(1, Number(job.detectStride) || state.options.progressStride);
    if (!detections.length || (i % stride) === 0) {
      try {
        detections = await detectWithROI(ctx, canvas, hoop, frameIdx);
        if (detections.length) lastDetections = detections;
      } catch {
        detections = [];
      }
    }

    let ballPoint = pickBallCenter(detections, state.lastBall, false, state.options.maxStepPx);
    if (!ballPoint && state.lastBall) {
      const refined = refineBallWithROI(ctx, state.lastBall, state.options.refineWindow);
      if (refined) ballPoint = refined;
    }
    if (!ballPoint && detections.length) {
      ballPoint = pickBallCenter(detections, state.lastBall, true, state.options.maxStepPx * 2);
    }
    if (!ballPoint && state.lastBall) ballPoint = { x: state.lastBall.x, y: state.lastBall.y };

    if (ballPoint) {
      updateBallState(state, ballPoint, frameIdx);
      updateProx(state, frameIdx, ballPoint, hoop);
      updateArc(state, ballPoint, frameIdx);
    }

    processed++;
    if (typeof postProgress === 'function') {
      if (processed === 1 || processed === total || (processed % state.options.progressStride) === 0) {
        postProgress({
          stage: 'processing',
          frameIndex: frameIdx,
          framesProcessed: processed,
          framesTotal: total,
          proxEnter: state.proxEnterFrame,
          proxExit: state.proxExitFrame,
          trailLength: state.trail.length
        });
      }
    }

    if (frame.bitmap && typeof frame.bitmap.close === 'function') {
      try { frame.bitmap.close(); } catch {}
    }

    updateTrailSamples(state, frameIdx);

    const exitFrame = state.proxExitFrame;
    if (Number.isFinite(exitFrame) && frameIdx - exitFrame >= state.options.earlyStopFrames) {
      earlyStop = true;
      break;
    }
    const enterFrame = state.proxEnterFrame;
    if (Number.isFinite(enterFrame) && frameIdx - enterFrame >= state.options.lingerLimit) {
      earlyStop = true;
      break;
    }
  }

  const summary = finalizeSummary(state, {
    hoop,
    framesProcessed: processed,
    cancelled: job.cancelled,
    earlyStop
  });

  return { summary };
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

export function serializeError(error) {
  if (!error) return { name: 'Error', message: 'Unknown worker error', stack: null };
  return {
    name: error.name || 'Error',
    message: error.message || String(error),
    stack: error.stack || null
  };
}
