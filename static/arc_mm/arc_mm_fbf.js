// static/arc_mm/arc_mm_fbf.js
// Minimal page entry for your existing stack.
// NO detector hooks. NO polyfills. Just FBF -> overlay -> export.

import { analyzeVideoFrameByFrame } from '/static/js/analyzer.js';
import { handleHoopSelection }      from '/static/js/hoop_tracker.js';
import '/static/arc_mm/shot_arc.js';   // arc module shim (side effect only)

const FPS = Number(window.__videoFPS || 30);

const ui = {
  list: document.getElementById('shotList'),
  video: document.getElementById('videoPlayer'),
  overlay: document.getElementById('overlay'),
  exportCan: document.getElementById('exportCanvas'),
  processAllBtn: document.getElementById('processAll')
};

function syncSizes(){
  const vw = ui.video.videoWidth||0, vh = ui.video.videoHeight||0;
  if (!vw || !vh) return false;
  [ui.overlay, ui.exportCan].forEach(c => { c.width = vw; c.height = vh; });
  return true;
}

function drawHUD(ctx){
  const s = window.__lastSummary || {};
  const line1 = `Result: ${s.result ? String(s.result).toUpperCase()
                 : (s.made===true?'MAKE':s.made===false?'MISS':'—')}`;
  const deg = n => typeof n==='number' ? `${Math.round(n)}°` : '—';
  const num = n => (typeof n==='number' && isFinite(n)) ? Math.round(n) : '—';
  const line2 = `Release ${deg(s.releaseAngle)}  •  Entry ${deg(s.entryAngle)}  •  Apex ${num(s.apexHeight)}`;
  const pad=8, fs=Math.max(14, Math.floor(ctx.canvas.height*0.03));
  ctx.save(); ctx.font=`${fs}px system-ui, sans-serif`; ctx.fillStyle='rgba(0,0,0,0.55)';
  const w1=ctx.measureText(line1).width, w2=ctx.measureText(line2).width;
  const boxW=Math.max(w1,w2)+pad*2, boxH=fs*2+pad*3;
  ctx.fillRect(pad,pad,boxW,boxH);
  ctx.fillStyle='#fff';
  ctx.fillText(line1, pad*2, pad*2+fs*0.9);
  ctx.fillText(line2, pad*2, pad*2+fs*2);
  ctx.restore();
}

function compositeFrame(){
  const w=ui.exportCan.width,h=ui.exportCan.height; if(!w||!h) return;
  const ctx=ui.exportCan.getContext('2d');
  ctx.clearRect(0,0,w,h);
  ctx.drawImage(ui.video,0,0,w,h);
  ctx.drawImage(ui.overlay,0,0,w,h);
  drawHUD(ctx);
}

// One–time rim picker (your real handler)
function enableHoopPickOnce(){
  const ov = ui.overlay;
  if (!ov || window.__pickingHoop) return;
  window.__pickingHoop = true;
  ov.style.cursor = 'crosshair';

  const pickOnce = (e) => {
    // non-passive so preventDefault is legal if your handler needs it
    try { handleHoopSelection(e, ov, window.lastDetectedFrame || {objects:[]}, null); } catch {}
    ov.style.cursor = 'default';
    ov.removeEventListener('pointerdown', pickOnce);
    ov.removeEventListener('click',        pickOnce);
    window.__pickingHoop = false;
  };

  ov.addEventListener('pointerdown', pickOnce, { passive:false });
  ov.addEventListener('click',        pickOnce, { passive:false });
}

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

async function processClip({ id, url }){
  // clean previous runs
  try { window.stopFrameAnalysis?.(); } catch {}
  try { window.resetAll?.(); } catch {}
  try { window.shotArc?.resetShotFSM?.(); } catch {}

  // media
  ui.video.srcObject = null;
  ui.video.removeAttribute('src');
  ui.video.src = url; ui.video.preload='auto';
  await new Promise(res => ui.video.addEventListener('loadedmetadata', res, { once:true }));
  if (!syncSizes()) return;

  // record & composite each analyzer frame
  const { rec, done } = startRecorder();
  const onFrame = () => compositeFrame();
  window.addEventListener('analyzer:frame-done', onFrame);

  const finishNow = async () => {
    try { window.removeEventListener('analyzer:frame-done', onFrame); } catch {}
    try { rec.requestData?.(); rec.stop(); } catch {}
    const blob = await done;

    const row = document.querySelector(`[data-shot="${id}"]`);
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `shot_${id}_overlay.webm`; a.textContent = 'Download';
    const v = document.createElement('video'); v.src = a.href; v.controls = true; v.muted = true;
    v.style.maxWidth='420px'; v.style.display='block';
    row?.appendChild(document.createTextNode(' · '));
    row?.appendChild(a);
    row?.appendChild(document.createElement('br'));
    row?.appendChild(v);

    const st = row?.querySelector('.status');
    const sum = window.__lastSummary || null;
    const made = sum ? (sum.made===true || sum.result==='make') ? 'MAKE'
                     : (sum.made===false || sum.result==='miss') ? 'MISS' : '—'
                     : '—';
    if (st) st.textContent = `✓ ${made}`;
  };

  window.addEventListener('shot:summary', finishNow, { once:true });
  window.addEventListener('shot:end',     finishNow, { once:true });

  // rim pick
  enableHoopPickOnce();

  // kick your real FBF analyzer
  analyzeVideoFrameByFrame(ui.video, ui.overlay);
}

function boot(){
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
