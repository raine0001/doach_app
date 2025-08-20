// static/js/detector.worker.js  (module worker)
// attempt to use local resources
// ONNX model in-browser (WebGPU if available, else WASM). Returns {label, confidence, box}.

let ort, session, inputName, inputShape;
let MODEL_W = 640, MODEL_H = 640;
let LABELS = ['basketball', 'hoop', 'player', 'net', 'backboard']; // override via init
let provider = 'wasm';

// Prefer WebGPU, fall back to WASM (with wasm paths set)
async function loadOrt() {
  try {
    ort = await import('https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.0/dist/ort.webgpu.mjs');
    provider = 'webgpu';
  } catch (_) {
    ort = await import('https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.0/dist/ort.esm.min.js');
    provider = 'wasm';
    // make sure wasm binaries can be fetched
    ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.0/dist/';
    ort.env.wasm.numThreads = 2;
    ort.env.wasm.simd = true;
  }
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
  const data = t.data;
  const dims = t.dims;
  let rows, cols, trans = false;
  if (dims.length === 3) {
    if (dims[1] < dims[2]) { rows = dims[2]; cols = dims[1]; trans = true; } // [1,C,N]
    else { rows = dims[1]; cols = dims[2]; }                                  // [1,N,C]
  } else if (dims.length === 2) { rows = dims[0]; cols = dims[1]; }
  else { rows = data.length / 84; cols = 84; }

  const boxes = [], scores = [], clsIdx = [];
  for (let i = 0; i < rows; i++) {
    const at = c => trans ? data[c * rows + i] : data[i * cols + c];
    const cx = at(0), cy = at(1), w = at(2), h = at(3);
    let best = -1, bestScore = 0;
    for (let c = 4; c < cols; c++) {
      const s = at(c);
      if (s > bestScore) { bestScore = s; best = c - 4; }
    }
    if (bestScore < scoreThr) continue;

    const x1m = cx - w/2, y1m = cy - h/2;
    const x2m = cx + w/2, y2m = cy + h/2;

    const x1 = Math.max(0, (x1m - dx) / r);
    const y1 = Math.max(0, (y1m - dy) / r);
    const x2 = Math.min(ow, (x2m - dx) / r);
    const y2 = Math.min(oh, (y2m - dy) / r);

    boxes.push([x1, y1, x2, y2]);
    scores.push(bestScore);
    clsIdx.push(best);
  }

  const keep = nms(boxes, scores, clsIdx, 0.45);
  return keep.map(i => ({
    label: LABELS[clsIdx[i]] || `class_${clsIdx[i]}`,
    confidence: +scores[i].toFixed(3),
    box: boxes[i].map(v => Math.round(v))
  }));
}

self.onmessage = async (e) => {
  const msg = e.data || {};
  if (msg.type === 'init') {
    try {
      LABELS = Array.isArray(msg.labels) && msg.labels.length ? msg.labels : LABELS;
      await loadOrt();

      // Fully-qualified URL dont hit 127.0.0.1 by accident on prod
      const modelUrl = msg.modelUrl;  // absolute from the loader
      session = await ort.InferenceSession.create(modelUrl, { executionProviders:[provider], graphOptimizationLevel:'all' });

      inputName = session.inputNames[0];
      const meta = session.inputMetadata?.[inputName];
      inputShape = meta?.dimensions || [1,3,640,640];
      MODEL_H = inputShape[2] || 640;
      MODEL_W = inputShape[3] || 640;

      self.postMessage({ type: 'ready', provider });
    } catch (err) {
      self.postMessage({ type: 'error', error: String(err) });
    }
    return;
  }

  if (msg.type === 'detect') {
    try {
      const bmp = msg.bitmap; const ow = msg.ow; const oh = msg.oh;
      const { oc, dx, dy, r } = letterboxBitmap(bmp, MODEL_W, MODEL_H);
      const ctx = oc.getContext('2d', { willReadFrequently: true });
      const imgData = ctx.getImageData(0, 0, MODEL_W, MODEL_H);
      const chw = hwcToCHWFloat(imgData, MODEL_W, MODEL_H);
      const tensor = new ort.Tensor('float32', chw, [1,3,MODEL_H,MODEL_W]);
      const out = await session.run({ [inputName]: tensor });
      const dets = postprocessYolo(out, MODEL_W, MODEL_H, dx, dy, r, ow, oh, 0.25);
      self.postMessage({ type: 'result', frameIndex: msg.frameIndex, objects: dets });
    } catch (err) {
      self.postMessage({ type: 'error', error: String(err) });
    } finally {
      if (msg.bitmap?.close) try { msg.bitmap.close(); } catch {}
    }
  }
};
