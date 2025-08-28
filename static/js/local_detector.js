// static/js/local_detector.js  (ES module)
// Spins up the worker, loads the model, and provides detect(canvas, frameIndex).

class LocalDetector {
  constructor(modelUrl, labels, fallbackUrl=null, fbLabels=null) {
    this.modelUrl   = new URL(modelUrl, location.origin).href;
    this.fallbackUrl= fallbackUrl ? new URL(fallbackUrl, location.origin).href : null;
    this.labels     = labels || ['basketball','hoop','net','backboard','player'];
    this.fbLabels   = fbLabels || null; // if backup labels differ
    this.worker = null; this.ready = false; this._pending = new Map();
  }
  async init() {
    if (this.ready) return true;
    this.worker = new Worker('/static/js/detector.worker.js', { type: 'module' });
    this.worker.onmessage = (e) => {
      const msg = e.data || {};
      if (msg.type === 'ready') {
        this.ready = true;
        // optional: console.log(`[LocalDetector] provider=${msg.provider}`);
        return;
      }
      if (msg.type === 'result') {
        const key = msg.frameIndex;
        const pending = this._pending.get(key);
        if (pending) {
          this._pending.delete(key);
          // normalize objects
          const objects = Array.isArray(msg.objects) ? msg.objects : [];
          pending.resolve({ objects, frameIndex: key });
        }
        return;
      }
      if (msg.type === 'error') {
        console.warn('[LocalDetector worker error]', msg.error);
      }
    };
  }

  async detect(src, frameIndex=0) {
    if (!this.ready || !src) return { objects: [], frameIndex };
    const bmp = await createImageBitmap(src);
    const ow = src.videoWidth || src.width || 0;
    const oh = src.videoHeight || src.height || 0;

    // resolve even if the worker doesn’t reply (timeout safety)
    let timer;
    const prom = new Promise(resolve => {
      this._pending.set(frameIndex, { resolve });
      timer = setTimeout(() => {
        if (this._pending.has(frameIndex)) {
          this._pending.delete(frameIndex);
          resolve({ objects: [], frameIndex });  // fail-safe
        }
      }, 300); // ~1 frame @30fps
    });

    this.worker.postMessage({ type: 'detect', frameIndex, bitmap: bmp, ow, oh }, [bmp]);
    const out = await prom;
    clearTimeout(timer);
    return out;
  }
  
}

// singleton
window.localDetector = {
  instance: null,
  async enable(mainUrl='/static/models/backup_best.onnx', labels=null,
               fallbackUrl='/static/models/backup_best.onnx', fbLabels=null) {
    if (!('createImageBitmap' in window)) { console.warn('[LocalDetector] bitmap missing'); return false; }
    this.instance = new LocalDetector(mainUrl, labels, fallbackUrl, fbLabels);
    await this.instance.init();
    return true;
  },

  get ready() { return !!(this.instance && this.instance.ready); },
  async detect(canvas, frameIndex) {
    return this.instance ? this.instance.detect(canvas, frameIndex) : { objects: [], frameIndex };
  }
};
