// static/arc_mm/arc_mm_fbf.js
// Use the existing stack. Minimal named imports, side-effects for the rest.

// add/keep these named imports:
import { handleHoopSelection, getLockedHoopBox } from '/static/js/hoop_tracker.js';
import { asTopLeft }                              from '/static/js/shot_utils.js';
import { updateBall, ballState, resetAll }                  from '/static/js/ball_tracker.js';
import { bufferDetectedObjects, scoringTick, checkShotConditions } from '/static/js/shot_logger.js';

// keep the existing ones:
import { analyzeVideoFrameByFrame }               from '/static/js/analyzer.js';
import '/static/js/local_detector.js';
import '/static/arc_mm/shot_arc.js';


const FPS = Number(window.__videoFPS || 30);


const ui = {
  list: document.getElementById('shotList'),
  video: document.getElementById('videoPlayer'),
  overlay: document.getElementById('overlay'),
  exportCan: document.getElementById('exportCanvas'),
  processAllBtn: document.getElementById('processAll')
};

// ---- Detector bridge (only used if app didn't wire one) ----
function normalizeDetArray(arr){
  return arr.map(o => {
    const label = (o.label ?? o.class ?? o.cls ?? o.name ?? '').toString().toLowerCase();
    const conf  = o.conf ?? o.score ?? o.prob ?? null;
    const bb    = o.box || o.bbox;
    if (Array.isArray(bb) && bb.length === 4) {
      const [x1,y1,x2,y2] = bb; return { label, box:[x1,y1,x2,y2], conf };
    }
    if ([o.x,o.y,o.w,o.h].every(n=>Number.isFinite(n))) {
      return { label, x:o.x, y:o.y, w:o.w, h:o.h, conf };
    }
    if (Array.isArray(o.xyxy) && o.xyxy.length === 4) {
      const [x1,y1,x2,y2] = o.xyxy; return { label, box:[x1,y1,x2,y2], conf };
    }
    return null;
  }).filter(Boolean);
}

function ensureDetectorBridge(){
  // If the app exposed an init, use it and bail.
  if (typeof window.initLocalDetector === 'function') {
    try {
      window.initLocalDetector({
        model_url: window.DETECTOR_MODEL_URL || '/static/models/best.onnx',
        conf: 0.15, imgsz: 640
      });
      console.log('[fbf] initLocalDetector sent');
    } catch (e) { console.warn('[fbf] initLocalDetector failed', e); }
    return;
  }

  // If we already made one, keep it.
  if (!(window.__detectorWorker instanceof Worker)) {
    const url = window.DETECTOR_WORKER_PATH || '/static/js/detector.worker.js';
    const w   = new Worker(url);
    window.__detectorWorker = w;

    // Normalize any result payload into lastDetectedFrame
    w.addEventListener('message', (ev) => {
      const d = ev?.data || {};
      if (d.type === 'ready' || d.type === 'detector:ready' || d.type === 'detector:ep') {
        window.__DET_INIT_DONE = true;
      }
      const raw = Array.isArray(d.objects) ? d.objects
               : Array.isArray(d.detections) ? d.detections
               : Array.isArray(d.dets) ? d.dets
               : Array.isArray(d.boxes) ? d.boxes
               : (d.data && (d.data.objects||d.data.detections||d.data.dets||d.data.boxes)) || null;
      if (Array.isArray(raw)) {
        const objs = normalizeDetArray(raw);
        if (objs.length) window.lastDetectedFrame = { __frameIdx:(window.fidx|0), objects: objs, poses: [] };
      }
    });

    // Kick model load (twice to kill races)
    const model = window.DETECTOR_MODEL_URL || '/static/models/best.onnx';
    try { w.postMessage({ type:'init', modelUrl:model, conf:0.15, imgsz:640 }); } catch {}
    setTimeout(()=>{ try{ w.postMessage({ type:'init', modelUrl:model, conf:0.15, imgsz:640 }); }catch{} }, 250);
  }

  // If analyzer calls sendFrameToDetect but app didn't define it, polyfill
  if (typeof window.sendFrameToDetect !== 'function') {
    window.sendFrameToDetect = async function(source, fidx){
      try {
        const W = ui.overlay.width, H = ui.overlay.height;
        if (!W || !H) return;
        // draw source frame to a buffer
        let off;
        try { off = new OffscreenCanvas(W, H); }
        catch { off = document.createElement('canvas'); off.width = W; off.height = H; }
        const ctx = off.getContext('2d', { willReadFrequently:true });
        // 'source' may be a canvas or the video; draw either
        ctx.drawImage(source, 0, 0, W, H);

        // prefer ImageBitmap transfer
        if (off.convertToBlob && self.createImageBitmap) {
          const blob = await off.convertToBlob({ type:'image/jpeg', quality:0.85 });
          const bmp  = await createImageBitmap(blob);
          window.__detectorWorker.postMessage({ type:'detect', bitmap:bmp, width:W, height:H }, [bmp]);
        } else {
          const img = ctx.getImageData(0, 0, W, H);
          window.__detectorWorker.postMessage({ type:'detect', imageData:img, width:W, height:H }, [img.data.buffer]);
        }
      } catch {}
    };
    console.log('[fbf] sendFrameToDetect polyfilled');
  }
}


function pickBallFromObjects(objs, last, hoop) {
  const balls = (objs||[]).map(o => {
    const L = (o.label || o.class || o.cls || '').toString().toLowerCase();
    if (!L.includes('ball')) return null;
    const bb = o.box || o.bbox;
    let x,y,area=0;
    if (Array.isArray(bb) && bb.length===4) { const [x1,y1,x2,y2]=bb; x=(x1+x2)/2; y=(y1+y2)/2; area=Math.abs((x2-x1)*(y2-y1)); }
    else if ([o.x,o.y,o.w,o.h].every(n=>Number.isFinite(n))) { x=o.x+o.w/2; y=o.y+o.h/2; area=o.w*o.h; }
    else return null;
    return { x,y, area };
  }).filter(Boolean);
  if (!balls.length) return null;

  if (last) {
    balls.sort((a,b)=> ((a.x-last.x)**2+(a.y-last.y)**2) - ((b.x-last.x)**2+(b.y-last.y)**2));
    return balls[0];
  }
  if (hoop) {
    const cx=hoop.x+hoop.w/2, cy=hoop.y+hoop.h/2;
    balls.sort((a,b)=> ((a.x-cx)**2+(a.y-cy)**2) - ((b.x-cx)**2+(b.y-cy)**2));
    return balls[0];
  }
  balls.sort((a,b)=> b.area-a.area);
  return balls[0];
}

const onAnalyzerFrame = () => {
  const objs = (window.lastDetectedFrame?.objects || []);

  // keep logger warm
  try { bufferDetectedObjects(objs); } catch {}

  // update hoop in ball_tracker from current lock
  try {
    const hb = getLockedHoopBox?.();
    if (hb) {
      const tl = asTopLeft(hb) || hb;
      ballState.hoop = { ...tl, cx: tl.x + tl.w/2, cy: tl.y + tl.h/2, anchor:'topleft' };
    }
  } catch {}

  // choose the ball and update trail
  try {
    const last = ballState?.trail?.at?.(-1);
    const picked = pickBallFromObjects(objs, last, ballState?.hoop);
    if (picked) updateBall({ x:picked.x, y:picked.y }, (window.fidx|0));
  } catch {}

  // scoring tick + conditions
  try {
    scoringTick(window.fidx|0);
    const hb = getLockedHoopBox?.();
    if (hb) checkShotConditions(ballState, hb, (window.fidx|0));
  } catch {}

  compositeFrame();

  // heartbeat every ~10 frames
  if (((window.__detBeat=(window.__detBeat||0)+1)%10)===0) {
    console.log('[fbf] objs:', objs.length);
  }
};



function syncSizes(){
  const vw = ui.video.videoWidth||0, vh = ui.video.videoHeight||0;
  if (!vw || !vh) return false;
  [ui.overlay, ui.exportCan].forEach(c => { c.width = vw; c.height = vh; });
  return true;
}

function drawHUD(ctx){
  const s = window.__lastSummary || {};
  const line1 = `Result: ${s.result ? String(s.result).toUpperCase() : (s.made===true?'MAKE':s.made===false?'MISS':'—')}`;
  const deg = n => typeof n==='number' ? `${Math.round(n)}°` : '—';
  const num = n => (typeof n==='number' && isFinite(n)) ? Math.round(n) : '—';
  const line2 = `Release ${deg(s.releaseAngle)}  •  Entry ${deg(s.entryAngle)}  •  Apex ${num(s.apexHeight)}`;
  const pad=8, fs=Math.max(14, Math.floor(ctx.canvas.height*0.03));
  ctx.save(); ctx.font=`${fs}px system-ui, sans-serif`; ctx.fillStyle='rgba(0,0,0,0.55)';
  const w1=ctx.measureText(line1).width, w2=ctx.measureText(line2).width; const boxW=Math.max(w1,w2)+pad*2, boxH=fs*2+pad*3;
  ctx.fillRect(pad,pad,boxW,boxH); ctx.fillStyle='#fff';
  ctx.fillText(line1,pad*2,pad*2+fs*0.9); ctx.fillText(line2,pad*2,pad*2+fs*2); ctx.restore();
}

function compositeFrame(){
  const w=ui.exportCan.width,h=ui.exportCan.height; if(!w||!h) return;
  const ctx=ui.exportCan.getContext('2d');
  ctx.clearRect(0,0,w,h);
  ctx.drawImage(ui.video,0,0,w,h);
  ctx.drawImage(ui.overlay,0,0,w,h);
  drawHUD(ctx);
}

// One–time hoop picker (uses your existing handler)
function enableHoopPickOnce(){
  const ov = ui.overlay;
  if (!ov || window.__pickingHoop) return;
  window.__pickingHoop = true;
  ov.style.cursor = 'crosshair';
  const pickOnce = (e) => {
    e.preventDefault(); e.stopPropagation();
    try { handleHoopSelection(e, ov, window.lastDetectedFrame || {objects:[]}, null); } catch {}
    ov.style.cursor = 'default';
    ov.removeEventListener('pointerdown', pickOnce);
    ov.removeEventListener('click',        pickOnce);
    window.__pickingHoop = false;
  };
ov.addEventListener('pointerdown', pickOnce, { passive:false });
ov.addEventListener('click',        pickOnce, { passive:false });

}

// Recorder
function startRecorder(){
  const stream = ui.exportCan.captureStream(FPS);
  const mime = (MediaRecorder.isTypeSupported('video/webm;codecs=vp8') ? 'video/webm;codecs=vp8' : 'video/webm');
  const rec = new MediaRecorder(stream, { mimeType:mime, videoBitsPerSecond: 4_000_000 });
  const chunks = [];
  rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  const done = new Promise(resolve => rec.onstop = () => resolve(new Blob(chunks, { type:mime })));
  rec.start(100);
  return { rec, done };
}

// Minimal detector init: use the original path the legacy worker expects
function ensureDetectorInit() {
  // Prefer the app’s provided init — this is how it worked before.
  if (typeof window.initLocalDetector === 'function') {
    try {
      window.initLocalDetector({
        model_url: window.DETECTOR_MODEL_URL || '/static/models/best.onnx', // <- original location
        conf: 0.15,
        imgsz: 640
      });
      console.log('[fbf] detector init sent');
    } catch (e) {
      console.warn('[fbf] initLocalDetector failed', e);
    }
    return;
  }
  // Backstop: if bootstrap exposed a worker, nudge it
  try {
    const w = window.__detectorWorker;
    if (w && w.postMessage) {
      w.postMessage({
        type: 'init',
        modelUrl: window.DETECTOR_MODEL_URL || '/static/models/best.onnx',
        conf: 0.15,
        imgsz: 640
      });
      console.log('[fbf] worker init posted');
    }
  } catch {}
}

async function processClip({ id, url }){
  // reset between clips
  try { window.stopFrameAnalysis?.(); } catch {}
  try { window.resetAll?.(); } catch {}
  try { window.shotArc?.resetShotFSM?.(); } catch {}

  ui.video.srcObject = null;
  ui.video.removeAttribute('src');
  ui.video.src = url; ui.video.preload='auto';
  await new Promise(res => ui.video.addEventListener('loadedmetadata', res, { once:true }));
  if (!syncSizes()) return;

  // per-frame composite after analyzer draws overlay
  const onAnalyzerFrame = () => {
  // 1) read detections the worker wrote (your stack already sets this)
  const objs = (window.lastDetectedFrame?.objects || []);

  // 2) make sure the logger’s buffers stay warm
  try { bufferDetectedObjects(objs); } catch {}

  // 3) ensure ball_tracker knows the current hoop (from your lock)
  try {
    const hb = getLockedHoopBox?.();
    if (hb) {
      const tl = asTopLeft(hb) || hb;
      // ball_tracker expects TL + cx/cy; keep it in the same shape as old app.js
      ballState.hoop = { ...tl, cx: tl.x + tl.w/2, cy: tl.y + tl.h/2, anchor:'topleft' };
    }
  } catch {}

  // 4) choose a ball from detections and update the trail
  try {
    const last = ballState?.trail?.at?.(-1);
    const picked = pickBallFromObjects(objs, last, ballState?.hoop);
    if (picked) updateBall({ x:picked.x, y:picked.y }, (window.fidx|0));
  } catch {}

  // 5) scoring tick + shot conditions like before
  try {
    scoringTick(window.fidx|0);
    const hb = getLockedHoopBox?.();
    if (hb) checkShotConditions(ballState, hb, (window.fidx|0));
  } catch {}

  // 6) composite export frame
  compositeFrame();

  // tiny heartbeat so you can see life without log spam
  if (((window.__detBeat = (window.__detBeat||0)+1) % 10) === 0) {
    console.log('[fbf] objs:', objs.length);
  }
};

window.addEventListener('analyzer:frame-done', () => { window.fidx = (window.fidx|0)+1; });




  // recorder & finishers
  const { rec, done } = startRecorder();
  const finishNow = async () => {
    try { window.removeEventListener('analyzer:frame-done', onAnalyzerFrame); } catch {}
    try { rec.requestData?.(); rec.stop(); } catch {}
    const blob = await done;
    const row = document.querySelector(`[data-shot="${id}"]`);
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `shot_${id}_overlay.webm`; a.textContent = 'Download';
    const v = document.createElement('video'); v.src = a.href; v.controls = true; v.muted = true; v.style.maxWidth='420px'; v.style.display='block';
    row?.appendChild(document.createTextNode(' · ')); row?.appendChild(a); row?.appendChild(document.createElement('br')); row?.appendChild(v);

    const st = row?.querySelector('.status');
    const sum = window.__lastSummary || null;
    const made = sum ? (sum.made===true || sum.result==='make') ? 'MAKE'
                     : (sum.made===false || sum.result==='miss') ? 'MISS' : '—'
                     : '—';
    if (st) st.textContent = `✓ ${made}`;
  };
  window.addEventListener('shot:summary', finishNow, { once:true });
  window.addEventListener('shot:end',     finishNow, { once:true });

  // one-time rim lock
  enableHoopPickOnce();

  // detector init (fire-and-forget)
  ensureDetectorInit();
  ensureDetectorBridge(); // creates worker + polyfills sendFrameToDetect if missing


  // Kick your existing FBF analyzer
  analyzeVideoFrameByFrame(ui.video, ui.overlay);
}

function boot(){
  // render list
  const shots = window.__DEMO_SHOTS || [];
  ui.list.innerHTML = shots.map(s => `
    <div class="shot" data-shot="${s.id}">
      <button class="go" data-id="${s.id}">Process</button>
      <span class="status">waiting…</span>
      <span class="name">${s.name}</span>
    </div>
  `).join('');
  ui.list.addEventListener('click', async (e) => {
    const b = e.target.closest('button.go'); if (!b) return;
    b.disabled = true;
    const id = b.dataset.id;
    const shot = shots.find(x => String(x.id) === String(id));
    await processClip(shot);
  });
  ui.processAllBtn.onclick = async () => {
    for (const b of [...ui.list.querySelectorAll('.shot button.go')]) {
      b.click();
      await new Promise(r=>setTimeout(r, 250));
    }
  };
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once:true });
} else boot();
