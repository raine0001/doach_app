// static/js/detector.worker.js  (module worker)
// ONNX model in-browser (WebGPU if available, else WASM). Returns {label, confidence, box}.
// models static\models\best.onnx  & static\models\backup_best.onnx

let ort, session, inputName, inputShape;
let sessionFB = null, inputNameFB = null, inputShapeFB = null;

let MODEL_W = 640, MODEL_H = 640;
let MODEL_W_FB = 640, MODEL_H_FB = 640;

let LABELS = ['basketball','hoop','net','backboard','player'];
let FB_LABELS = null; // set from init if provided
let provider = 'wasm';

// run a given session and labels; return detections
async function runSession(sess, inName, w, h, labels, bitmap, ow, oh) {
  const { oc, dx, dy, r } = letterboxBitmap(bitmap, w, h);
  const ctx = oc.getContext('2d', { willReadFrequently: true });
  const imgData = ctx.getImageData(0, 0, w, h);
  const chw = hwcToCHWFloat(imgData, w, h);
  const tensor = new ort.Tensor('float32', chw, [1,3,h,w]);
  const out = await sess.run({ [inName]: tensor });
  return postprocessYolo(out, w, h, dx, dy, r, ow, oh, 0.25)
}


// --- name normalization & per-class thresholds (tune if needed) ---
const NORMALIZE = {
  rim: 'hoop', ring: 'hoop', basket: 'hoop',
  ball: 'basketball',
  person: 'player',
  board: 'backboard'
};
const THRESH = { 
  basketball: 0.42, 
  hoop: 0.05, 
  net: 0.10, 
  backboard: 0.25, 
  player: 0.40 
};

// Prefer WebGPU, fall back to WASM (with wasm paths set)
async function loadOrt() {
  // Force WASM for stability; we can re-enable WebGPU after things are solid
  ort = await import('https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.0/dist/ort.esm.min.js');
  provider = 'wasm';
  ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.0/dist/';
  ort.env.wasm.numThreads = 2;
  ort.env.wasm.simd = true;
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
  return { oc, dx, dy, r };
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

// Non-Maximum Suppression
function nms(boxes, scores, labels, thr=0.45) {
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

// YOLOv8-ish head: [1, C, N] or [1, N, C] → boxes/classes
function postprocessYolo(output, dw, dh, dx, dy, r, ow, oh, scoreThr=0.25) {
  const key = Object.keys(output)[0];
  const t = output[key];
  const data = t.data, dims = t.dims;

  let rows, cols, trans = false;
  if (dims.length === 3) {
    if (dims[1] < dims[2]) { rows = dims[2]; cols = dims[1]; trans = true; } // [1,C,N]
    else { rows = dims[1]; cols = dims[2]; }                                  // [1,N,C]
  } else if (dims.length === 2) { rows = dims[0]; cols = dims[1]; }
  else { rows = data.length / 84; cols = 84; }

  const boxes = [], scores = [], clsIdx = [];
  const alts  = [];

  // helper to undo letterbox to original coords
  const toOrig = (cx, cy, w, h) => {
    const x1m = cx - w/2, y1m = cy - h/2, x2m = cx + w/2, y2m = cy + h/2;
    // map model space → letterboxed canvas → original frame
    const lx1 = x1m - dx, ly1 = y1m - dy, lx2 = x2m - dx, ly2 = y2m - dy;
    const sx = 1 / r, sy = 1 / r;
    return [lx1 * sx, ly1 * sy, lx2 * sx, ly2 * sy].map((v, i) =>
      Math.max(0, Math.min(i % 2 ? oh : ow, Math.round(v)))
    );
  };

  for (let i = 0; i < rows; i++) {
    const at = c => trans ? data[c * rows + i] : data[i * cols + c];
    const cx = at(0), cy = at(1), w = at(2), h = at(3);

    // top‑2 classes
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

  // normalized labels + per‑class thresholds
  const out = [];
  for (const i of keep) {
    let raw = LABELS[clsIdx[i]] || `class_${clsIdx[i]}`;
    let name = NORMALIZE[raw] || raw;
    const thr = THRESH[name] ?? 0.25;
    if (scores[i] < thr) continue;
    out.push({ label: name, confidence: +scores[i].toFixed(3), box: boxes[i] });
  }

  // near‑equal alt promotion (once)
  const MARGIN_HOOP = 0.10, MARGIN_BALL = 0.08;
  for (const a of alts) {
    const rawAlt = LABELS[a.alt] || `class_${a.alt}`;
    const altName = NORMALIZE[rawAlt] || rawAlt;
    const j = a.i;
    if ((altName === 'hoop' && a.altScore >= Math.max(0, scores[j] - MARGIN_HOOP)) ||
        (altName === 'basketball' && a.altScore >= Math.max(0, scores[j] - MARGIN_BALL))) {
      out.push({ label: altName, confidence: +a.altScore.toFixed(3), box: boxes[j] });
    }
  }

  return out;
}


// derive a thin rim band from net/backboard if hoop is missing
function synthHoopFrom(src) {
  const [x1,y1,x2,y2] = src.box;
  const w  = Math.max(1, x2 - x1);
  const cx = (x1 + x2) / 2;
  const rimW = Math.max(40, Math.round(w * 0.55)); // ~basket dia in px relative to net width
  const xL = Math.round(cx - rimW / 2);
  const xR = Math.round(cx + rimW / 2);
  const yR = Math.round(y1);                        // rim line at top of net
  return { label: 'hoop', confidence: 0.51, synthetic: true, box: [xL, yR - 4, xR, yR + 4] };
}

// --- INIT: load primary (and optional fallback) sessions
self.onmessage = async (e) => {
  const msg = e.data || {};
  if (msg.type === 'init') {
    try {
      LABELS    = Array.isArray(msg.labels) && msg.labels.length ? msg.labels : LABELS;
      FB_LABELS = Array.isArray(msg.fbLabels) && msg.fbLabels.length ? msg.fbLabels : null;
      await loadOrt();

      // primary
      session = await ort.InferenceSession.create(msg.modelUrl, {
        executionProviders: [provider], graphOptimizationLevel: 'all'
      });
      inputName = session.inputNames[0];
      const meta = session.inputMetadata?.[inputName];
      inputShape = meta?.dimensions || [1,3,640,640];
      MODEL_H = inputShape[2] || 640;
      MODEL_W = inputShape[3] || 640;

      // fallback (optional)
      if (msg.fbUrl) {
        sessionFB = await ort.InferenceSession.create(msg.fbUrl, {
          executionProviders: [provider], graphOptimizationLevel: 'all'
        });
        inputNameFB = sessionFB.inputNames[0];
        const metaFB = sessionFB.inputMetadata?.[inputNameFB];
        inputShapeFB = metaFB?.dimensions || [1,3,640,640];
        MODEL_H_FB = inputShapeFB[2] || 640;
        MODEL_W_FB = inputShapeFB[3] || 640;
      }

      self.postMessage({ type: 'ready', provider });
    } catch (err) {
      self.postMessage({ type: 'error', error: String(err) });
    }
    return;
  }

  if (msg.type === 'detect') {
    try {
      const bmp = msg.bitmap; const ow = msg.ow; const oh = msg.oh;

      // Stage 1: primary
      let dets = await runSession(session, inputName, MODEL_W, MODEL_H, LABELS, bmp, ow, oh);

      // Optional synth from net/backboard
      if (!dets.some(d => d.label === 'hoop')) {
        const net = dets.find(d => d.label === 'net');
        const bb  = dets.find(d => d.label === 'backboard');
        const src = net || bb;
        if (src?.box?.length === 4) dets.push(synthHoopFrom(src));
      }

      // Stage 2: if still no hoop, try fallback model for hoop only
      if (!dets.some(d => d.label === 'hoop') && sessionFB) {
        const fbLabels = FB_LABELS || LABELS;  // assume same order if none provided
        const cand = await runSession(sessionFB, inputNameFB, MODEL_W_FB, MODEL_H_FB, fbLabels, bmp, ow, oh);
        // pick hoop/rim from fallback and add the best one
        const hoops = cand.filter(d => d.label === 'hoop' || d.label === 'rim');
        if (hoops.length) {
          // take the highest confidence hoop from fallback
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
      if (msg.bitmap?.close) try { msg.bitmap.close(); } catch {}
    }
  }
};
