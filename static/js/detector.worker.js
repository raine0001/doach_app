/* static/js/detector.worker.js  — classic worker (UMD ORT)
 * Runs ONNX (wasm) and returns {label, confidence, box} in VIDEO pixels.
 * Expected model(s): /static/models/best.onnx (and optional fb model).
 * IMPORTANT: create this worker as CLASSIC in app.js:
 *   const detWorker = new Worker('/static/js/detector.worker.js');
 */

// ──────────────────────────────────────────────────────────────
// ORT boot (UMD) — classic worker only; guard from double-import
// ──────────────────────────────────────────────────────────────
if (!self.__ORT_BOOTSTRAPPED__) {
  if (!self.ort) {
    importScripts('/static/vendor/onnxruntime-web/1.20.0/ort.min.js');
  }
  self.__ORT_BOOTSTRAPPED__ = true;
}
const ORT = self.ort;
let provider = 'wasm';

// WASM runtime config
ORT.env.wasm.wasmPaths  = '/static/vendor/onnxruntime-web/1.20.0/';
ORT.env.wasm.numThreads = 1;       // safest across browsers
ORT.env.wasm.simd       = true;

// ──────────────────────────────────────────────────────────────
// Config & labels
// ──────────────────────────────────────────────────────────────
const DETECTOR_CFG_URL = '/static/config/detector.json';
let MODEL_URL  = '/static/models/best.onnx';
let MODEL_SIZE = 640;

// **4-class fallback**; main thread may override via init.labels
let LABELS = ['basketball', 'hoop', 'net','backboard', 'player'];
let FB_LABELS = null;  // optional for fallback model

// Normalization aliases
const NORMALIZE = {
  rim: 'hoop', ring: 'hoop', basket: 'hoop',
  ball: 'basketball', 'sports ball': 'basketball',
  person: 'player', player: 'player',
  backboard: 'backboard',
  net: 'net'
};

// Per-class score thresholds (tweak at runtime if needed)
const THRESH = {
  basketball: 0.26,
  hoop:       0.68,
  net:        0.25, 
  player:     0.45,
  backboard:  0.65
};

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────
async function loadDetectorConfig() {
  try {
    const res = await fetch(DETECTOR_CFG_URL, { cache: 'no-store' });
    if (!res.ok) return;
    const cfg = await res.json();
    if (cfg.model_url) MODEL_URL = cfg.model_url;
    if (cfg.imgsz)     MODEL_SIZE = cfg.imgsz;
  } catch {}
}

function letterboxBitmap(bmp, dw, dh) {
  const oc = new OffscreenCanvas(dw, dh);
  const octx = oc.getContext('2d');
  octx.fillStyle = '#727272';
  octx.fillRect(0, 0, dw, dh);

  const iw = bmp.width, ih = bmp.height;
  const r = Math.min(dw / iw, dh / ih);
  const nw = Math.round(iw * r), nh = Math.round(ih * r);
  const dx = Math.floor((dw - nw) / 2), dy = Math.floor((dh - nh) / 2);
  octx.drawImage(bmp, 0, 0, iw, ih, dx, dy, nw, nh);
  return { oc, dx, dy, r, iw, ih };
}

function hwcToCHWFloat(imgData, dw, dh) {
  const { data } = imgData;
  const out = new Float32Array(3 * dw * dh);
  let p = 0, c0 = 0, c1 = dw * dh, c2 = 2 * dw * dh;
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      out[c0++] = data[p] / 255;
      out[c1++] = data[p + 1] / 255;
      out[c2++] = data[p + 2] / 255;
      p += 4;
    }
  }
  return out;
}

function iou(a, b) {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  const w = Math.max(0, x2 - x1), h = Math.max(0, y2 - y1);
  const inter = w * h;
  const ua = (a[2]-a[0])*(a[3]-a[1]) + (b[2]-b[0])*(b[3]-b[1]) - inter;
  return ua ? inter / ua : 0;
}

function nms(boxes, scores, labels, thr = 0.45) {
  const order = scores.map((s,i)=>[s,i]).sort((a,b)=>b[0]-a[0]).map(x=>x[1]);
  const keep = [];
  for (const i of order) {
    let ok = true;
    for (const k of keep) {
      if (labels[i] === labels[k] && iou(boxes[i], boxes[k]) > thr) { ok = false; break; }
    }
    if (ok) keep.push(i);
  }
  return keep;
}

// Postprocess → VIDEO pixels; accepts override labels to prevent drift
function postprocessYolo(output, dw, dh, dx, dy, r, iw, ih, ow, oh, scoreThr=0.25, labelsOverride=null) {
  const key = Object.keys(output)[0];
  const t = output[key];
  const data = t.data, dims = t.dims;

  let rows, cols, trans = false;
  if (dims.length === 3) {
    if (dims[1] < dims[2]) { rows = dims[2]; cols = dims[1]; trans = true; } // [1,C,N]
    else { rows = dims[1]; cols = dims[2]; }                                  // [1,N,C]
  } else if (dims.length === 2) { rows = dims[0]; cols = dims[1]; }
  else { rows = data.length / 84; cols = 84; }

  const LAB = labelsOverride || LABELS;
  const boxes = [], scores = [], clsIdx = [], alts = [];

  const toOrig = (cx, cy, w, h) => {
    const x1m = cx - w/2, y1m = cy - h/2, x2m = cx + w/2, y2m = cy + h/2;
    const lx1 = x1m - dx, ly1 = y1m - dy, lx2 = x2m - dx, ly2 = y2m - dy;
    const bx1 = lx1 / r,  by1 = ly1 / r,  bx2 = lx2 / r,  by2 = ly2 / r;
    const sx = ow / iw,   sy = oh / ih;
    return [
      Math.round(Math.max(0, Math.min(ow, bx1 * sx))),
      Math.round(Math.max(0, Math.min(oh, by1 * sy))),
      Math.round(Math.max(0, Math.min(ow, bx2 * sx))),
      Math.round(Math.max(0, Math.min(oh, by2 * sy)))
    ];
  };

  for (let i = 0; i < rows; i++) {
    const at = c => trans ? data[c * rows + i] : data[i * cols + c];
    const cx = at(0), cy = at(1), w = at(2), h = at(3);

    let best = -1, bestScore = 0, alt = -1, altScore = 0;
    for (let c = 4; c < cols; c++) {
      const s = at(c);
      if (s > bestScore) { alt = best; altScore = bestScore; best = c - 4; bestScore = s; }
      else if (s > altScore) { alt = c - 4; altScore = s; }
    }
    if (bestScore < scoreThr) continue;

    const b = toOrig(cx, cy, w, h);
    boxes.push(b);
    scores.push(bestScore);
    clsIdx.push(best);
    alts.push({ i: boxes.length - 1, alt, altScore });
  }

  const keep = nms(boxes, scores, clsIdx, 0.45);

  const out = [];
  for (const i of keep) {
    let raw  = LAB[clsIdx[i]] || `class_${clsIdx[i]}`;
    let name = NORMALIZE[raw] || raw;
    const thr = THRESH[name] ?? 0.25;
    if (scores[i] < thr) continue;
    out.push({ label: name, confidence: +scores[i].toFixed(3), box: boxes[i] });
  }

  // near-equal alt promotion for hoop/ball
  const MARGIN_HOOP = 0.10, MARGIN_BALL = 0.08;
  for (const a of alts) {
    const rawAlt  = LAB[a.alt] || `class_${a.alt}`;
    const altName = NORMALIZE[rawAlt] || rawAlt;
    const j = a.i;
    if ((altName === 'hoop'       && a.altScore >= Math.max(0, scores[j] - MARGIN_HOOP)) ||
        (altName === 'basketball' && a.altScore >= Math.max(0, scores[j] - MARGIN_BALL))) {
      out.push({ label: altName, confidence: +a.altScore.toFixed(3), box: boxes[j] });
    }
  }
  return out;
}

// derive a thin rim band from net if hoop is missing (backboard optional legacy)
function synthHoopFrom(src) {
  const [x1, y1, x2, y2] = src.box;
  const w  = Math.max(1, x2 - x1);
  const cx = (x1 + x2) / 2;
  const rimW = Math.max(40, Math.round(w * 0.55));
  const xL = Math.round(cx - rimW / 2);
  const xR = Math.round(cx + rimW / 2);
  const yR = Math.round(y1);
  return { label: 'hoop', confidence: 0.51, synthetic: true, box: [xL, yR - 4, xR, yR + 4] };
}

async function runSession(sess, inName, w, h, labels, bitmap, ow, oh) {
  const { oc, dx, dy, r, iw, ih } = letterboxBitmap(bitmap, w, h);
  const ctx = oc.getContext('2d', { willReadFrequently: true });
  const imgData = ctx.getImageData(0, 0, w, h);
  const chw = hwcToCHWFloat(imgData, w, h);
  const tensor = new ORT.Tensor('float32', chw, [1, 3, h, w]);
  const out = await sess.run({ [inName]: tensor });
  return postprocessYolo(out, w, h, dx, dy, r, iw, ih, ow, oh, 0.05, labels);
}

// ──────────────────────────────────────────────────────────────
let session, inputName, inputShape;
let sessionFB = null, inputNameFB = null, inputShapeFB = null;
let MODEL_W = 640, MODEL_H = 640;
let MODEL_W_FB = 640, MODEL_H_FB = 640;

// Init / Detect
// ──────────────────────────────────────────────────────────────
self.onmessage = async (e) => {
  const msg = e.data || {};

  if (msg.type === 'init') {
    try {
      // pick up detector.json here (classic worker safe)
      await loadDetectorConfig();

      if (Array.isArray(msg.labels) && msg.labels.length) {
        LABELS = msg.labels.slice();  // primary model label order
      }
      FB_LABELS = (Array.isArray(msg.fbLabels) && msg.fbLabels.length)
        ? msg.fbLabels.slice()
        : null;

      // primary session
      session = await ORT.InferenceSession.create(msg.modelUrl || MODEL_URL, {
        executionProviders: [provider],
        graphOptimizationLevel: 'all'
      });
      inputName  = session.inputNames[0];
      const meta = session.inputMetadata?.[inputName];
      inputShape = meta?.dimensions || [1,3,MODEL_SIZE,MODEL_SIZE];
      MODEL_H = inputShape[2] || MODEL_SIZE;
      MODEL_W = inputShape[3] || MODEL_SIZE;

      // optional fallback
      if (msg.fbUrl) {
        sessionFB = await ORT.InferenceSession.create(msg.fbUrl, {
          executionProviders: [provider],
          graphOptimizationLevel: 'all'
        });
        inputNameFB  = sessionFB.inputNames[0];
        const metaFB = sessionFB.inputMetadata?.[inputNameFB];
        inputShapeFB = metaFB?.dimensions || [1,3,MODEL_SIZE,MODEL_SIZE];
        MODEL_H_FB = inputShapeFB[2] || MODEL_SIZE;
        MODEL_W_FB = inputShapeFB[3] || MODEL_SIZE;
      }

      try { self.postMessage({ type: 'debug', msg: '[det] LABELS=' + JSON.stringify(LABELS) }); } catch {}
      self.postMessage({ type: 'ready', provider });
    } catch (err) {
      self.postMessage({ type: 'error', error: String(err) });
    }
    return;
  }

  if (msg.type === 'detect') {
    try {
      if (!session) throw new Error('Detector not initialized');
      const bmp = msg.bitmap, ow = msg.ow, oh = msg.oh;

      // Stage 1: primary model
      let dets = await runSession(session, inputName, MODEL_W, MODEL_H, LABELS, bmp, ow, oh);

      // Optional synth hoop
      if (!dets.some(d => d.label === 'hoop')) {
        const net = dets.find(d => d.label === 'net');
        if (net?.box?.length === 4) dets.push(synthHoopFrom(net));
      }

      // Stage 2: fallback (hoop-only assist)
      if (!dets.some(d => d.label === 'hoop') && sessionFB) {
        const cand = await runSession(sessionFB, inputNameFB, MODEL_W_FB, MODEL_H_FB, (FB_LABELS || LABELS), bmp, ow, oh);
        const hoops = cand.filter(d => d.label === 'hoop' || d.label === 'rim');
        if (hoops.length) {
          hoops.sort((a,b) => b.confidence - a.confidence);
          const h = hoops[0];
          h.label = 'hoop'; h.synthetic = h.synthetic || true;
          dets.push(h);
        }
      }

      self.postMessage({ type: 'result', frameIndex: msg.frameIndex, objects: dets });
    } catch (err) {
      self.postMessage({ type: 'error', error: String(err) });
    } finally {
      if (msg.bitmap?.close) { try { msg.bitmap.close(); } catch {} }
    }
    return;
  }
};
