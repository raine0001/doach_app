// microclip_worker.js
// Dedicated worker for micro-clip frame-by-frame analysis. Loads the heavy
// scoring logic lazily from microclip_core.js so we can polyfill globals before
// the module initializes.

const ctx = self;
if (typeof ctx.window === 'undefined') {
  ctx.window = ctx;
}

if (typeof ctx.CustomEvent !== 'function') {
  ctx.CustomEvent = class CustomEvent {
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

let coreModulePromise = null;
function getCoreModule() {
  if (!coreModulePromise) {
    coreModulePromise = import('./microclip_core.js');
  }
  return coreModulePromise;
}

const activeJobs = new Map();

ctx.addEventListener('message', (event) => {
  const msg = event?.data;
  if (!msg || typeof msg !== 'object') return;

  switch (msg.type) {
    case 'init':
      handleInit(msg);
      break;
    case 'process':
      handleProcess(msg).catch((err) => {
        getCoreModule()
          .then(({ serializeError }) => {
            postFromWorker('error', { id: msg.id || null, error: serializeError(err) });
          })
          .catch(() => {
            postFromWorker('error', { id: msg.id || null, error: { name: err?.name || 'Error', message: String(err), stack: err?.stack || null } });
          });
      });
      break;
    case 'cancel':
      handleCancel(msg).catch(() => {});
      break;
    default:
      getCoreModule()
        .then(({ serializeError }) => {
          postFromWorker('error', {
            id: msg.id || null,
            error: serializeError(new Error(`Unknown microclip message type: ${msg.type}`))
          });
        })
        .catch(() => {
          postFromWorker('error', {
            id: msg.id || null,
            error: { name: 'Error', message: `Unknown microclip message type: ${msg.type}` }
          });
        });
  }
});

function handleInit(msg) {
  postFromWorker('init:ok', { id: msg.id ?? null });
}

async function handleProcess(msg) {
  const { normalizeFrames, disposeFrameCollection, runMicroclipJob, serializeError } = await getCoreModule();

  const id = msg.id || `job:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`;
  const frames = normalizeFrames(msg.frames);
  const job = {
    id,
    frames,
    cancelled: false,
    meta: {
      fps: msg.fps ?? null,
      hoop: msg.hoop ?? null,
      releaseFrame: msg.releaseFrame ?? null,
      releaseTime: msg.releaseTime ?? null,
      detectStride: msg.detectStride ?? null
    }
  };
  activeJobs.set(id, job);

  postFromWorker('progress', { id, stage: 'queued', framesTotal: frames.length });

  const progressEmitter = (update) => {
    if (job.cancelled) return;
    postFromWorker('progress', { id, ...update });
  };

  try {
    const result = await runMicroclipJob(job, { postProgress: progressEmitter });
    if (job.cancelled) {
      postFromWorker('cancelled', { id });
    } else {
      postFromWorker('result', { id, ...result });
    }
  } catch (err) {
    postFromWorker('error', { id, error: serializeError(err) });
  } finally {
    disposeFrameCollection(job.frames);
    job.frames.length = 0;
    activeJobs.delete(id);
  }
}

async function handleCancel(msg) {
  const { disposeFrameCollection } = await getCoreModule();
  const id = msg.id;
  if (!id || !activeJobs.has(id)) return;
  const job = activeJobs.get(id);
  job.cancelled = true;
  disposeFrameCollection(job.frames);
  job.frames.length = 0;
  activeJobs.delete(id);
  postFromWorker('cancelled', { id });
}

function postFromWorker(type, payload) {
  ctx.postMessage({ type, ...payload });
}
