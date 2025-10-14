const FACE_LOCK_THRESH = 0.38;
const SAMPLE_INTERVAL_MS = 280;
const LOCK_TIMEOUT_MS = 3200;
const ROI_EXPAND = 1.5;
const ENROLL_TARGET = 8;
const ENROLL_MIN = 4;
const MIN_FACE_SIZE = 96;

const noop = () => {};
const clamp = (val, min, max) => Math.min(Math.max(val, min), max);
const now = () => {
  try { return performance.now(); } catch { return Date.now(); }
};

function toBoxArray(box) {
  if (!box) return null;
  if (Array.isArray(box)) {
    if (box.length === 4) return [box[0], box[1], box[2], box[3]];
    return null;
  }
  if (typeof box === 'object') {
    const x = Number(box.x ?? box.left ?? 0);
    const y = Number(box.y ?? box.top ?? 0);
    const w = Number(box.width ?? box.w ?? 0) || Number(box.right ?? 0) - x;
    const h = Number(box.height ?? box.h ?? 0) || Number(box.bottom ?? 0) - y;
    return [x, y, x + w, y + h];
  }
  return null;
}

function boxWidth(box) {
  return Math.max(0, box[2] - box[0]);
}

function boxHeight(box) {
  return Math.max(0, box[3] - box[1]);
}

function boxArea(box) {
  return Math.max(0, boxWidth(box) * boxHeight(box));
}

function iou(a, b) {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  const w = Math.max(0, x2 - x1);
  const h = Math.max(0, y2 - y1);
  const inter = w * h;
  if (!inter) return 0;
  const ua = boxArea(a) + boxArea(b) - inter;
  return ua ? inter / ua : 0;
}

function expandBox(box, factor, width, height) {
  const cx = (box[0] + box[2]) / 2;
  const cy = (box[1] + box[3]) / 2;
  const w = boxWidth(box);
  const h = boxHeight(box);
  const nw = w * factor;
  const nh = h * factor;
  const x1 = clamp(cx - nw / 2, 0, width);
  const y1 = clamp(cy - nh / 2, 0, height);
  const x2 = clamp(cx + nw / 2, 0, width);
  const y2 = clamp(cy + nh / 2, 0, height);
  return [x1, y1, x2, y2];
}

function cosineSim(a, b) {
  if (!a || !b) return 0;
  const n = Math.min(a.length, b.length);
  if (!n) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const va = a[i];
    const vb = b[i];
    dot += va * vb;
    na += va * va;
    nb += vb * vb;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb) || 1;
  return dot / denom;
}

function toFloat32(arr) {
  if (!arr) return null;
  if (arr instanceof Float32Array) return arr;
  if (!Array.isArray(arr) && !(arr.buffer instanceof ArrayBuffer)) return null;
  try {
    return new Float32Array(arr);
  } catch {
    try {
      return Float32Array.from(arr);
    } catch {
      return null;
    }
  }
}

function fetchJSON(url, opts = {}) {
  return fetch(url, {
    credentials: 'include',
    ...opts
  }).then(async (r) => {
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body?.error || `HTTP ${r.status}`);
    return body;
  });
}

class FaceLockManager {
  constructor() {
    this.status = null;
    this.embedding = null;
    this.embeddingDims = 512;
    this.consent = false;
    this.worker = null;
    this.workerReady = false;
    this.workerSupported = false;
    this._workerPromise = null;
    this._msgSeq = 0;
    this._pending = new Map();
    this._canvas = null;
    this._runtimeInterval = 0;
    this._runtimeBusy = false;
    this._lastRuntimeSample = 0;
    this._lastMatch = 0;
    this.lock = null;
    this.videoBounds = { width: 0, height: 0 };
    this.userId = null;
    this._initPromise = null;
    this._hooksInstalled = false;
    this._visible = true;
    this._lastSample = null;
    this._lastWarnAt = 0;
    if (typeof window !== 'undefined') {
      window.addEventListener('prefs:changed', (evt) => {
        try { this._onPrefsChanged(evt?.detail?.prefs || null); } catch { }
      });
    }
  }

  async init(options = {}) {
    if (this._initPromise) return this._initPromise;
    this._initPromise = (async () => {
      this._installHooks();
      try {
        if (this.userId && this.prefEnabled()) {
          await this.refreshStatus({ includeEmbedding: true, silent: true });
        }
      } catch (err) {
        if (!options.silent) console.warn('[face-lock] status init failed', err);
      }
      return true;
    })();
    return this._initPromise;
  }

  _installHooks() {
    if (this._hooksInstalled) return;
    this._hooksInstalled = true;
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        this._visible = document.visibilityState !== 'hidden';
        if (!this._visible) this._pauseRuntime();
        else this._resumeRuntime();
      });
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('hud:end-session', () => this.releaseLock('session_end'));
      window.addEventListener('hud:start-session', () => this._resumeRuntime());
    }
  }

  setUser(user) {
    this.userId = user?.user_id ?? null;
    if (this.userId) {
      this.init({ silent: true }).catch(noop);
      if (this.prefEnabled()) {
        this.refreshStatus({ includeEmbedding: true, silent: true }).catch(noop);
      }
    } else {
      this.clearLocalState();
    }
  }

  clearLocalState() {
    this.status = null;
    this.embedding = null;
    this.consent = false;
    this.stopRuntime();
    this.releaseLock('logout');
    this._lastSample = null;
    this._lastWarnAt = 0;
  }

  async refreshStatus({ includeEmbedding = false, silent = false } = {}) {
    if (!this.prefEnabled()) {
      this.consent = false;
      return this.status;
    }
    try {
      const qs = includeEmbedding ? '?include=embedding' : '';
      const res = await fetchJSON(`/api/face/status${qs}`, { method: 'GET' });
      const status = res?.status || null;
      this.status = status;
      this.consent = !!status?.consent;
      if (includeEmbedding && Array.isArray(status?.embedding) && status.embedding.length) {
        this.embedding = toFloat32(status.embedding);
        this.embeddingDims = this.embedding?.length || this.embeddingDims;
      }
      if (!includeEmbedding && this.embedding && status?.embedding_dims) {
        this.embeddingDims = status.embedding_dims;
      }
      if (!this.embedding) this.stopRuntime();
      else this._resumeRuntime();
      return status;
    } catch (err) {
      const msg = String(err?.message || '');
      if (msg.includes('401') || msg.includes('not authenticated')) {
        this.status = null;
        this.consent = false;
        this.embedding = null;
        this.stopRuntime();
        this.releaseLock('unauthorized');
        if (!silent) console.warn('[face-lock] not signed in yet, skipping status');
        return null;
      }
      if (!silent) console.warn('[face-lock] refreshStatus failed', err);
      throw err;
    }
  }

  async ensureWorker() {
    if (this.workerReady && this.worker) return true;
    if (this._workerPromise) return this._workerPromise;
    if (typeof Worker === 'undefined') return false;
    this.worker = new Worker('/static/js/face_lock.worker.js', { name: 'face-lock' });
    this.worker.onmessage = (event) => this._handleWorkerMessage(event);
    this.worker.onerror = (err) => {
      console.warn('[face-lock] worker error', err);
    };
    this._workerPromise = new Promise((resolve) => {
      this._workerReadyResolver = resolve;
    });
    try { this.worker.postMessage({ type: 'init' }); } catch { /* noop */ }
    return this._workerPromise;
  }

  _handleWorkerMessage(event) {
    const data = event.data || {};
    if (data.type === 'ready') {
      this.workerReady = true;
      this.workerSupported = !!data.supported;
      this._workerReadyResolver?.(this.workerSupported);
      return;
    }
    const entry = this._pending.get(data.id);
    if (!entry) return;
    this._pending.delete(data.id);
    clearTimeout(entry.tid);
    if (data.type === 'detect-result') {
      entry.resolve(data);
    } else if (data.type === 'detect-error') {
      entry.reject(new Error(data.error || 'detect-error'));
    } else {
      entry.resolve(data);
    }
  }

  _postToWorker(msg, transfer = []) {
    if (!this.worker || !this.workerReady) throw new Error('worker not ready');
    const id = ++this._msgSeq;
    return new Promise((resolve, reject) => {
      const tid = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error('face worker timeout'));
      }, msg.timeout || 2000);
      this._pending.set(id, { resolve, reject, tid });
      try {
        this.worker.postMessage({ ...msg, id }, transfer);
      } catch (err) {
        clearTimeout(tid);
        this._pending.delete(id);
        reject(err);
      }
    });
  }

  _getVideoElement() {
    const video = document.getElementById('videoPlayer') || document.querySelector('video');
    if (!video || !video.videoWidth || !video.videoHeight) return null;
    return video;
  }

  async _grabBitmap(video) {
    if (!video || !video.videoWidth || !video.videoHeight) return null;
    if (!this._canvas) this._canvas = document.createElement('canvas');
    const canvas = this._canvas;
    if (canvas.width !== video.videoWidth) canvas.width = video.videoWidth;
    if (canvas.height !== video.videoHeight) canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    this.videoBounds = { width: canvas.width, height: canvas.height };
    if (window.createImageBitmap) {
      try {
        return await createImageBitmap(canvas);
      } catch (err) {
        console.warn('[face-lock] createImageBitmap failed', err);
      }
    }
    if (canvas.transferToImageBitmap) {
      try {
        return canvas.transferToImageBitmap();
      } catch { }
    }
    return null;
  }

  async captureEnrollmentSamples(options = {}) {
    await this.ensureWorker();
    if (!this.workerSupported) throw new Error('face detector unavailable on this device');
    const video = this._getVideoElement();
    if (!video) throw new Error('camera not ready');
    const target = options.samples || ENROLL_TARGET;
    const maxMs = options.maxDurationMs || 1600;
    const start = now();
    const results = [];
    while (results.length < target && now() - start < maxMs) {
      const bitmap = await this._grabBitmap(video);
      if (!bitmap) break;
      let res;
      try {
        res = await this._postToWorker({
          type: 'detect',
          bitmap,
          embeddingDims: options.dims || this.embeddingDims,
          returnCrop: true,
          maxFaces: 1,
          minFace: options.minFace || MIN_FACE_SIZE
        }, bitmap ? [bitmap] : []);
      } catch (err) {
        if (bitmap?.close) bitmap.close();
        throw err;
      }
      const faces = Array.isArray(res.faces) ? res.faces : [];
      if (faces.length) {
        const face = faces[0];
        if (face && face.crop && boxWidth(face.bbox) >= MIN_FACE_SIZE) {
          results.push(face);
        }
      }
      await new Promise((r) => setTimeout(r, options.interval || 140));
    }
    if (results.length < Math.max(ENROLL_MIN, Math.round(target * 0.6))) {
      throw new Error(`need ${Math.max(ENROLL_MIN, Math.round(target * 0.6))}+ clear face samples`);
    }
    return results;
  }

  async enroll({ strategy = 'server', reason = 'login', dims = 512 } = {}) {
    await this.ensureWorker();
    const samples = await this.captureEnrollmentSamples({ dims });
    const crops = samples.map((s) => s.crop).filter(Boolean);
    const embeddings = samples.map((s) => toFloat32(s.embedding)).filter(Boolean);
    if (!crops.length) throw new Error('no usable face crops');
    let response;
    if (strategy === 'server') {
      response = await fetchJSON('/api/face/enroll_server', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          crops,
          dims,
          metadata: { reason, samples: crops.length },
          return_embedding: true
        })
      });
      if (Array.isArray(response?.embedding) && response.embedding.length) {
        this.embedding = toFloat32(response.embedding);
        this.embeddingDims = this.embedding.length;
      }
    } else {
      const stack = embeddings.map((vec) => Array.from(vec));
      const sum = new Float32Array(dims);
      for (const vec of stack) {
        for (let i = 0; i < dims; i++) {
          sum[i] += vec[i] ?? 0;
        }
      }
      for (let i = 0; i < dims; i++) sum[i] /= stack.length;
      const norm = Math.sqrt(sum.reduce((acc, v) => acc + v * v, 0)) || 1;
      for (let i = 0; i < dims; i++) sum[i] /= norm;
      response = await fetchJSON('/api/face/enroll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          embedding: Array.from(sum),
          dims,
          strategy: 'client',
          metadata: { reason, samples: stack.length },
          return_embedding: true
        })
      });
      if (Array.isArray(response?.embedding) && response.embedding.length) {
        this.embedding = toFloat32(response.embedding);
        this.embeddingDims = this.embedding.length;
      } else {
        this.embedding = sum;
        this.embeddingDims = sum.length;
      }
    }
    const status = response?.status || {};
    this.status = status;
    this.consent = true;
    if (!this.embedding && Array.isArray(status?.embedding)) {
      this.embedding = toFloat32(status.embedding);
      this.embeddingDims = this.embedding?.length || this.embeddingDims;
    }
    this._resumeRuntime();
    this._emit('face:enrolled', {
      userId: this.userId,
      embedding: this.embedding,
      dims: this.embeddingDims,
      samples: crops.length,
      strategy
    });
    return { status, samples: crops.length };
  }

  async setConsent(consent) {
    if (!this.prefEnabled() && consent) consent = false;
    await fetchJSON('/api/face/consent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ consent })
    });
    await this.refreshStatus({ includeEmbedding: consent, silent: true }).catch(noop);
    if (!consent) {
      this.stopRuntime();
      this.releaseLock('consent_revoked');
    } else {
      this._resumeRuntime();
    }
  }

  async clearEnrollment() {
    await fetchJSON('/api/face/enroll', { method: 'DELETE' });
    await this.refreshStatus({ includeEmbedding: false, silent: true }).catch(noop);
    this.embedding = null;
    this.consent = false;
    this.stopRuntime();
    this.releaseLock('cleared');
  }

  startRuntime() {
    if (!this.prefEnabled()) {
      this.stopRuntime();
      return;
    }
    this._resumeRuntime();
  }

  stopRuntime() {
    if (this._runtimeInterval) {
      clearInterval(this._runtimeInterval);
      this._runtimeInterval = 0;
    }
    this._runtimeBusy = false;
  }

  _pauseRuntime() {
    this.stopRuntime();
  }

  _resumeRuntime() {
    if (!this.prefEnabled()) {
      this.stopRuntime();
      return;
    }
    if (!this.consent || !this.embedding) {
      this.stopRuntime();
      return;
    }
    if (!this.workerReady) {
      this.ensureWorker().then((supported) => {
        if (supported) this._resumeRuntime();
      }).catch(noop);
      return;
    }
    if (!this.workerSupported) {
      this.stopRuntime();
      return;
    }
    if (this._runtimeInterval) return;
    this._runtimeInterval = setInterval(() => {
      if (!this._visible) return;
      this._sampleRuntime().catch(noop);
    }, SAMPLE_INTERVAL_MS);
  }

  async _sampleRuntime() {
    if (!this.prefEnabled()) return;
    if (this._runtimeBusy) return;
    const video = this._getVideoElement();
    if (!video) return;
    if (!this.embedding || !this.workerSupported) return;
    if (!(window.__SESSION_ACTIVE || video.srcObject || video.currentTime > 0)) return;
    const ts = now();
    if (ts - this._lastRuntimeSample < SAMPLE_INTERVAL_MS - 20) return;
    this._runtimeBusy = true;
    this._lastRuntimeSample = ts;
    try {
      const bitmap = await this._grabBitmap(video);
      if (!bitmap) return;
      const res = await this._postToWorker({
        type: 'detect',
        bitmap,
        embeddingDims: this.embeddingDims,
        returnCrop: false,
        maxFaces: 1,
        minFace: MIN_FACE_SIZE
      }, bitmap ? [bitmap] : []);
      const faces = Array.isArray(res.faces) ? res.faces : [];
      if (!faces.length) {
        if (this.lock && ts - this._lastMatch > LOCK_TIMEOUT_MS) {
          this.releaseLock('timeout');
        }
        if (this._lastSample && (ts - (this._lastSample.ts || 0) > LOCK_TIMEOUT_MS)) {
          this._lastSample = null;
        }
        return;
      }
      const face = faces[0];
      if (face) {
        this._lastSample = {
          bbox: face.bbox,
          width: res.width || this.videoBounds.width,
          height: res.height || this.videoBounds.height,
          dims: face.dims,
          probability: face.probability,
          score: face.score ?? face.probability ?? 0,
          ts
        };
      }
      if (!face?.embedding || !face?.bbox) return;
      const candidate = toFloat32(face.embedding);
      const score = cosineSim(candidate, this.embedding);
      const dimsMatch = candidate?.length === this.embedding?.length;
      if (!dimsMatch) return;
      if (score >= FACE_LOCK_THRESH) {
        this._lastMatch = ts;
        this._updateLock(face.bbox, score, {
          width: res.width || this.videoBounds.width,
          height: res.height || this.videoBounds.height
        });
      } else if (this.lock && ts - this._lastMatch > LOCK_TIMEOUT_MS) {
        this.releaseLock('low_score');
      }
    } catch (err) {
      console.warn('[face-lock] runtime sample failed', err);
    } finally {
      this._runtimeBusy = false;
    }
  }

  _updateLock(bboxArr, score, bounds) {
    const boundsW = bounds.width || this.videoBounds.width || 0;
    const boundsH = bounds.height || this.videoBounds.height || 0;
    const bbox = bboxArr.map((v, idx) => {
      return idx % 2 === 0 ? clamp(v, 0, boundsW) : clamp(v, 0, boundsH);
    });
    const roi = expandBox(bbox, ROI_EXPAND, boundsW, boundsH);
    const poseTrack = this._estimatePoseTrack(bbox);
    this.lock = {
      bbox,
      roi,
      score,
      trackId: poseTrack?.id ?? 'pose',
      matchedAt: now(),
      bounds: { width: boundsW, height: boundsH }
    };
    this._lastWarnAt = 0;
    try {
      window.__playerLock = {
        trackId: this.lock.trackId,
        bbox,
        roi,
        score,
        t0: Date.now()
      };
    } catch { }
    this._emit('face:locked', {
      userId: this.userId,
      trackId: this.lock.trackId,
      bbox,
      score,
      roi
    });
  }

  _estimatePoseTrack(faceBox) {
    const ps = window.playerState;
    const kp = ps?.keypoints;
    if (!Array.isArray(kp) || kp.length < 3) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const point of kp) {
      if (!point) continue;
      const x = Number(point.x);
      const y = Number(point.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
    const poseBox = [minX, minY, maxX, maxY];
    const overlap = iou(poseBox, faceBox);
    return { id: overlap > 0 ? 'pose' : null, overlap };
  }

  releaseLock(reason = 'manual') {
    if (!this.lock) return;
    this.lock = null;
    this._lastMatch = 0;
    try { window.__playerLock = null; } catch { }
    this._emit('face:lost', { reason });
  }

  filterDetections(objects) {
    if (!Array.isArray(objects) || !objects.length || !this.lock?.roi) return objects;
    const roi = this.lock.roi;
    const filtered = [];
    for (const obj of objects) {
      if (!obj) continue;
      const label = String(obj.label || obj.class || obj.type || '').toLowerCase();
      const isPlayer = /\b(player|person)\b/.test(label);
      const box = toBoxArray(obj.bbox ?? obj.box ?? obj.rect);
      if (isPlayer && box) {
        const overlap = iou(box, roi);
        if (overlap <= 0.05) continue;
        this.lock.bbox = box;
        this.lock.roi = expandBox(box, ROI_EXPAND, this.lock.bounds?.width || this.videoBounds.width, this.lock.bounds?.height || this.videoBounds.height);
      }
      filtered.push(obj);
    }
    return filtered;
  }

  hasEmbedding() {
    return !!(this.embedding && this.embedding.length);
  }

  isSupported() {
    return this.workerSupported;
  }

  requiresLock() {
    if (!this.prefEnabled()) return false;
    return !!(this.consent && this.embedding && this.workerSupported !== false);
  }

  lockSatisfied() {
    if (!this.requiresLock()) return true;
    const active = this.lock && (now() - (this._lastMatch || 0) <= LOCK_TIMEOUT_MS);
    return !!active;
  }

  notifyLockNeeded(reason = 'lock_required') {
    if (!this.prefEnabled()) return;
    const ts = Date.now();
    if (ts - this._lastWarnAt < 4000) return;
    this._lastWarnAt = ts;
    const name = (() => {
      try { return window.__USER_NAME || localStorage.getItem('firstname') || 'Player'; } catch { return window.__USER_NAME || 'Player'; }
    })();
    const hint = this._hintFromSample(this._lastSample);
    let message;
    if (hint) {
      message = `${name}, consider moving the camera ${hint} for a better pose lock.`;
    } else if (this._lastSample) {
      message = `${name}, I still need a clearer face lock. Hold steady for a second.`;
    } else {
      message = `${name}, step into frame so I can lock on to you.`;
    }
    try { (window.doachSpeak || window.coachSpeak)?.(message); } catch { }
    try { window.showPrompt?.(message, 4500); } catch { }
    this._emit('face:lock-needed', { reason, message });
  }

  _hintFromSample(sample) {
    if (!sample || !sample.bbox || !sample.width || !sample.height) return null;
    const [x1, y1, x2, y2] = sample.bbox;
    const width = sample.width;
    const height = sample.height;
    if (!(width > 0 && height > 0)) return null;
    const cx = (x1 + x2) / 2;
    const cy = (y1 + y2) / 2;
    const relX = (cx / width) - 0.5;
    const relY = (cy / height) - 0.5;
    const faceW = (x2 - x1) / width;
    let horiz = null;
    if (relX < -0.18) horiz = 'right';
    else if (relX > 0.18) horiz = 'left';
    let vertical = null;
    if (relY < -0.22) vertical = 'down';
    else if (relY > 0.22) vertical = 'up';
    let depth = null;
    if (faceW < 0.11) depth = 'in';
    else if (faceW > 0.32) depth = 'out';
    const parts = [];
    if (horiz) parts.push(horiz);
    if (vertical) parts.push(vertical);
    if (depth) parts.push(depth === 'in' ? 'closer' : 'back a little');
    if (!parts.length) return null;
    return parts.join(' and ');
  }

  _emit(name, detail) {
    try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch { }
  }

  prefEnabled() {
    try { return window.PREF_FACE_LOCK !== false; } catch { return true; }
  }

  _onPrefsChanged(prefs) {
    const enabled = this.prefEnabled();
    if (!enabled) {
      this.stopRuntime();
      this.releaseLock('pref_disabled');
    } else if (prefs && Object.prototype.hasOwnProperty.call(prefs, 'faceLock')) {
      if (this.embedding && this.consent) this._resumeRuntime();
    }
  }
}

export const faceLock = new FaceLockManager();
export default faceLock;

if (typeof window !== 'undefined') {
  window.FaceLock = faceLock;
  window.faceLockManager = faceLock;
  window.faceLockFilterDetections = (objects) => faceLock.filterDetections(objects);
  window.addEventListener('DOMContentLoaded', () => {
    faceLock.init({ silent: true }).catch(noop);
  });
}
