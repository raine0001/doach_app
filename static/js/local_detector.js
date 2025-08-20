// static/js/local_detector.js  (ES module)
// Spins up the worker, loads the model, and provides detect(canvas, frameIndex).

class LocalDetector {
  constructor(modelUrl, labels) {
    this.modelUrl = new URL(modelUrl, location.origin).href; // make absolute
    this.labels = Array.isArray(labels) && labels.length ? labels : ['basketball','hoop','player','net','backboard'];
    this.worker = null;
    this.ready = false;
    this._pending = new Map();
  }

  async init() {
    if (this.ready) return true;
    this.worker = new Worker('/static/js/detector.worker.js', { type: 'module' });

    this.worker.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === 'ready') {
        console.log(`[LocalDetector] ready (provider=${m.provider})`);
        this.ready = true;
      } else if (m.type === 'error') {
        console.warn('[LocalDetector] error:', m.error);
      } else if (m.type === 'result') {
        const pending = this._pending.get(m.frameIndex);
        if (pending) { this._pending.delete(m.frameIndex); pending.resolve(m); }
      }
    };

    this.worker.postMessage({ type: 'init', modelUrl: this.modelUrl, labels: this.labels });

    // wait until ready
    return await new Promise(resolve => {
      const poll = () => (this.ready ? resolve(true) : setTimeout(poll, 30));
      poll();
    });
  }

  async detect(canvas, frameIndex=0) {
    if (!this.ready || !canvas) return { objects: [], frameIndex };
    const bmp = await createImageBitmap(canvas);
    const ow = canvas.width, oh = canvas.height;
    const prom = new Promise(resolve => this._pending.set(frameIndex, { resolve }));
    this.worker.postMessage({ type: 'detect', frameIndex, bitmap: bmp, ow, oh }, [bmp]);
    return prom;
  }
}

// singleton
window.localDetector = {
  instance: null,
  async enable(modelUrl='/static/models/best.onnx', labels=null) {
    if (!('createImageBitmap' in window)) {
      console.warn('[LocalDetector] createImageBitmap missing; staying on server path.');
      return false;
    }
    this.instance = new LocalDetector(modelUrl, labels);
    await this.instance.init();
    return true;
  },
  get ready() { return !!(this.instance && this.instance.ready); },
  async detect(canvas, frameIndex) {
    return this.instance ? this.instance.detect(canvas, frameIndex) : { objects: [], frameIndex };
  }
};
