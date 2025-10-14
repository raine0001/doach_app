// face_lock.worker.js — lightweight face sampling + embedding helper
const DEFAULT_EMBED_DIMS = 512;
let detector = null;
let detectorSupported = typeof FaceDetector !== 'undefined';

async function ensureDetector() {
  if (!detectorSupported) return null;
  if (detector) return detector;
  try {
    detector = new FaceDetector({ fastMode: true, maxDetectedFaces: 2 });
    detectorSupported = true;
  } catch (err) {
    detectorSupported = false;
    detector = null;
  }
  return detector;
}

function clamp(val, min, max) {
  return Math.min(Math.max(val, min), max);
}

function normalizeBox(box, width, height) {
  if (!box) return null;
  const x = clamp(Number(box.x ?? box.left ?? 0), 0, width - 1);
  const y = clamp(Number(box.y ?? box.top ?? 0), 0, height - 1);
  const w = clamp(Number(box.width ?? box.w ?? box.right ?? 0), 1, width);
  const h = clamp(Number(box.height ?? box.h ?? box.bottom ?? 0), 1, height);
  const nx = clamp(x, 0, width - 1);
  const ny = clamp(y, 0, height - 1);
  const nw = clamp(w, 1, width - nx);
  const nh = clamp(h, 1, height - ny);
  return { x: nx, y: ny, width: nw, height: nh };
}

function boxToArray(box) {
  return [box.x, box.y, box.x + box.width, box.y + box.height];
}

function grayscaleFromCanvas(canvas, width, height) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, width, height);
  const src = img.data;
  const gray = new Float32Array(width * height);
  for (let i = 0, j = 0; i < src.length; i += 4, j += 1) {
    gray[j] = (0.2126 * src[i] + 0.7152 * src[i + 1] + 0.0722 * src[i + 2]) / 255;
  }
  return gray;
}

function computeQuality(gray, width, height) {
  if (!gray || gray.length === 0) {
    return { width, height, brightness: null, contrast: null, sharpness: null };
  }
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < gray.length; i++) {
    const v = gray[i];
    sum += v;
    sumSq += v * v;
  }
  const mean = sum / gray.length;
  const variance = clamp(sumSq / gray.length - mean * mean, 0, 1);
  let sharpness = 0;
  const w = width, h = height;
  if (w > 2 && h > 2) {
    for (let y = 1; y < h - 1; y++) {
      const row = y * w;
      for (let x = 1; x < w - 1; x++) {
        const idx = row + x;
        const lap = 4 * gray[idx] - gray[idx - 1] - gray[idx + 1] - gray[idx - w] - gray[idx + w];
        sharpness += lap * lap;
      }
    }
    sharpness /= (w - 2) * (h - 2);
  }
  return {
    width,
    height,
    brightness: Number(mean.toFixed(4)),
    contrast: Number(Math.sqrt(variance).toFixed(4)),
    sharpness: Number(sharpness.toFixed(4))
  };
}

function embedFromCanvas(canvas, dims) {
  const targetDims = clamp(Number(dims) || DEFAULT_EMBED_DIMS, 64, 1024);
  const side = 32;
  const embedCanvas = new OffscreenCanvas(side, side);
  const ctx = embedCanvas.getContext('2d');
  ctx.drawImage(canvas, 0, 0, embedCanvas.width, embedCanvas.height);
  const gray = grayscaleFromCanvas(embedCanvas, embedCanvas.width, embedCanvas.height);
  if (gray.length === 0) {
    return new Float32Array(targetDims);
  }
  const base = new Float32Array(gray.length);
  let sum = 0;
  for (let i = 0; i < gray.length; i++) {
    sum += gray[i];
  }
  const mean = sum / gray.length;
  let norm = 0;
  for (let i = 0; i < gray.length; i++) {
    const v = gray[i] - mean;
    base[i] = v;
    norm += v * v;
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < base.length; i++) {
    base[i] /= norm;
  }
  if (base.length === targetDims) {
    return base;
  }
  const out = new Float32Array(targetDims);
  const step = (base.length - 1) / Math.max(targetDims - 1, 1);
  for (let i = 0; i < targetDims; i++) {
    const idx = i * step;
    const idxFloor = Math.floor(idx);
    const idxCeil = Math.min(base.length - 1, idxFloor + 1);
    const t = idx - idxFloor;
    out[i] = base[idxFloor] * (1 - t) + base[idxCeil] * t;
  }
  return out;
}

async function canvasToDataURL(canvas) {
  try {
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('blob->dataURL failed'));
      reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(blob);
    });
  } catch (err) {
    return null;
  }
}

async function handleDetectMessage(msg) {
  const bitmap = msg.bitmap;
  const width = bitmap?.width || msg.width || 0;
  const height = bitmap?.height || msg.height || 0;
  if (!(width && height && bitmap)) {
    if (bitmap?.close) bitmap.close();
    return { faces: [], supported: detectorSupported, width, height };
  }
  const detectorInstance = await ensureDetector();
  const offscreen = new OffscreenCanvas(width, height);
  const ctx = offscreen.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, width, height);
  const minFace = clamp(Number(msg.minFace) || 96, 48, Math.max(width, height));
  const result = [];
  if (detectorInstance) {
    try {
      const detections = await detectorInstance.detect(offscreen);
      detections.sort((a, b) => {
        const ba = (a.boundingBox?.width || 0) * (a.boundingBox?.height || 0);
        const bb = (b.boundingBox?.width || 0) * (b.boundingBox?.height || 0);
        return bb - ba;
      });
      for (const det of detections) {
        const nbox = normalizeBox(det.boundingBox, width, height);
        if (!nbox) continue;
        if (Math.min(nbox.width, nbox.height) < minFace) continue;
        const cropCanvas = new OffscreenCanvas(Math.max(1, Math.round(nbox.width)), Math.max(1, Math.round(nbox.height)));
        const cropCtx = cropCanvas.getContext('2d');
        cropCtx.drawImage(offscreen, nbox.x, nbox.y, nbox.width, nbox.height, 0, 0, cropCanvas.width, cropCanvas.height);
        const quality = computeQuality(grayscaleFromCanvas(cropCanvas, cropCanvas.width, cropCanvas.height), cropCanvas.width, cropCanvas.height);
        const embedding = embedFromCanvas(cropCanvas, msg.embeddingDims || DEFAULT_EMBED_DIMS);
        const entry = {
          bbox: boxToArray(nbox),
          embedding: Array.from(embedding),
          dims: embedding.length,
          quality,
          probability: Number(det?.probability ?? det?.confidence ?? det?.score ?? 0),
          width,
          height
        };
        if (msg.returnCrop) {
          entry.crop = await canvasToDataURL(cropCanvas);
        }
        result.push(entry);
        if (result.length >= (msg.maxFaces || 1)) break;
      }
    } catch (err) {
      return { faces: [], supported: detectorSupported, width, height, error: String(err) };
    }
  }
  if (bitmap?.close) bitmap.close();
  return { faces: result, supported: detectorInstance != null, width, height };
}

self.onmessage = async (event) => {
  const msg = event.data || {};
  if (msg.type === 'init') {
    await ensureDetector();
    self.postMessage({ type: 'ready', supported: detectorSupported });
    return;
  }
  if (msg.type === 'detect') {
    const id = msg.id ?? null;
    try {
      const payload = await handleDetectMessage(msg);
      self.postMessage({ type: 'detect-result', id, ...payload });
    } catch (err) {
      self.postMessage({ type: 'detect-error', id, error: String(err), supported: detectorSupported });
    }
    return;
  }
  if (msg.type === 'shutdown') {
    try { detector = null; } catch (_) { /* noop */ }
    close();
  }
};
