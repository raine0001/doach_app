// static/arc_mm/arc_mm_offline.js
// Detectorless FBF: motion-based ball tracking, one-time rim lock, ROI draw, make/miss, composite export.

(function OfflineArcMM(){
  const ui = {
    list: document.getElementById('shotList'),
    video: document.getElementById('mmVideo'),
    overlay: document.getElementById('overlay'),
    exportCan: document.getElementById('exportCanvas'),
    processAllBtn: document.getElementById('processAll')
  };
  const FPS = Number(window.__videoFPS || 30);

  // state
  let rAF = 0, rVFC = 0, running = false;
  let prevBuf, diffBuf, pctx, dctx;
  let lastTime = -1;
  let trail = []; // {x,y}
  let hoop = null; // {x,y,w,h,cx,cy}
  let net = null, tub = null;
  let made = null, decided = false;
  let startTS = 0;

  // utils
  const waitFor = (el, evt) => new Promise(res => el.addEventListener(evt, res, { once:true }));
  async function waitMeta(v){ if (v.readyState>=1 && v.videoWidth && v.videoHeight) return; await waitFor(v,'loadedmetadata'); }
  function syncSizes() {
    const vw = ui.video.videoWidth || 0, vh = ui.video.videoHeight || 0;
    if (!vw || !vh) return false;
    [ui.overlay, ui.exportCan].forEach(c => { c.width = vw; c.height = vh; });
    // setup prev/diff buffers
    prevBuf = document.createElement('canvas'); prevBuf.width = vw; prevBuf.height = vh;
    diffBuf = document.createElement('canvas'); diffBuf.width = vw; diffBuf.height = vh;
    pctx = prevBuf.getContext('2d', { willReadFrequently: true });
    dctx = diffBuf.getContext('2d', { willReadFrequently: true });
    return true;
  }

  // HUD
  function drawHUD(ctx){
    const pad=8, fs=Math.max(14, Math.floor(ctx.canvas.height*0.03));
    const s1 = made === true ? 'Result: MAKE' : made === false ? 'Result: MISS' : 'Result: —';
    // basic arc stats
    let apex = '—', entry = '—', release = '—';
    if (trail.length > 2) {
      // crude angles
      const v0 = trail[1], v1 = trail[Math.min(6, trail.length-1)];
      const relA = Math.atan2(v1.y - v0.y, v1.x - v0.x) * 180/Math.PI;
      release = `${Math.round(relA)}°`;
      const ap = trail.reduce((a,p,i)=> p.y < a.y ? {...p,i} : a, {...trail[0],i:0});
      apex = `${Math.round(Math.max(0, (hoop? hoop.y - ap.y : 0)))}px`;
      if (hoop && trail.length > 6) {
        const last = trail[trail.length-1];
        const entA = Math.atan2(last.y - hoop.y, last.x - hoop.cx) * 180/Math.PI;
        entry = `${Math.round(entA)}°`;
      }
    }
    const s2 = `Release ${release}  •  Entry ${entry}  •  Apex ${apex}`;

    ctx.save();
    ctx.font = `${fs}px system-ui, sans-serif`;
    ctx.fillStyle='rgba(0,0,0,0.55)';
    const w1 = ctx.measureText(s1).width, w2 = ctx.measureText(s2).width;
    const boxW = Math.max(w1,w2)+pad*2, boxH = fs*2+pad*3;
    ctx.fillRect(pad,pad,boxW,boxH);
    ctx.fillStyle='#fff';
    ctx.fillText(s1, pad*2, pad*2+fs*0.9);
    ctx.fillText(s2, pad*2, pad*2+fs*2);
    ctx.restore();
  }

  // draw overlay
  function paintOverlay(){
    const ctx = ui.overlay.getContext('2d');
    const W = ui.overlay.width, H = ui.overlay.height;
    ctx.clearRect(0,0,W,H);

    if (!hoop) {
      ctx.save();
      ctx.font='16px system-ui,sans-serif';
      ctx.fillStyle='rgba(0,0,0,0.6)';
      ctx.fillRect(10,10,360,26);
      ctx.fillStyle='#fff';
      ctx.fillText('Hold SHIFT and drag to lock the rim', 16, 30);
      ctx.restore();
    }

    // trail
    if (trail.length > 1) {
      ctx.save(); ctx.lineWidth=3; ctx.strokeStyle='orange';
      ctx.beginPath();
      ctx.moveTo(trail[0].x, trail[0].y);
      for (let i=1;i<trail.length;i++) ctx.lineTo(trail[i].x, trail[i].y);
      ctx.stroke(); ctx.restore();
    }

    // hoop ROI
    if (hoop) {
      ctx.save();
      ctx.strokeStyle='#25f'; ctx.lineWidth=2;
      ctx.strokeRect(hoop.x, hoop.y, hoop.w, hoop.h);
      ctx.fillStyle='rgba(0,0,0,0.6)'; ctx.font='12px system-ui,sans-serif';
      ctx.fillText('RIM ROI', hoop.x+2, hoop.y+12);

      // net + tub estimates
      const n = net || { x:hoop.x, y: hoop.y+hoop.h*0.6, w: hoop.w, h: hoop.h*0.9 };
      const t = tub || { x: hoop.x - hoop.w*0.3, y: hoop.y + hoop.h*0.2, w: hoop.w*1.6, h: hoop.h*0.8 };
      ctx.strokeStyle='#0f9'; ctx.strokeRect(n.x,n.y,n.w,n.h); ctx.fillText('NET ROI', n.x+2, n.y+12);
      ctx.strokeStyle='#f0f'; ctx.strokeRect(t.x,t.y,t.w,t.h); ctx.fillText('TUB ROI', t.x+2, t.y+12);
      ctx.restore();
    }
  }

  // composite & record
  function drawComposite(){
    const w = ui.exportCan.width, h = ui.exportCan.height;
    if (!w||!h) return;
    const ctx = ui.exportCan.getContext('2d');
    ctx.clearRect(0,0,w,h);
    ctx.drawImage(ui.video, 0,0,w,h);
    ctx.drawImage(ui.overlay, 0,0,w,h);
    drawHUD(ctx);
  }
  function startRecorder(){
    const fps = Number(window.__videoFPS)||30;
    const stream = ui.exportCan.captureStream(fps);
    const mime = (MediaRecorder.isTypeSupported('video/webm;codecs=vp8') ? 'video/webm;codecs=vp8' : 'video/webm');
    const rec = new MediaRecorder(stream, { mimeType:mime, videoBitsPerSecond: 4_000_000 });
    const chunks = [];
    rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    const done = new Promise(resolve => rec.onstop = () => resolve(new Blob(chunks, { type:mime })));
    rec.start(100);
    return { rec, done };
  }

  // manual rim lock: Shift+drag
  function enableManualHoopPickOnce(){
    const c = ui.overlay; const rect=()=>c.getBoundingClientRect(); let start=null;
    const preview=(x,y,w,h)=>{ paintOverlay(); const k=c.getContext('2d'); k.save(); k.strokeStyle='#25f'; k.lineWidth=2; k.strokeRect(x,y,w,h); k.restore(); };
    function onDown(e){ if(!e.shiftKey) return; e.preventDefault(); const r=rect(); start={x:e.clientX-r.left,y:e.clientY-r.top}; c.addEventListener('mousemove',onMove); c.addEventListener('mouseup',onUp,{once:true}); c.style.cursor='crosshair'; }
    function onMove(e){ if(!start) return; const r=rect(); const x2=e.clientX-r.left,y2=e.clientY-r.top; const x=Math.min(start.x,x2), y=Math.min(start.y,y2); const w=Math.abs(x2-start.x), h=Math.abs(y2-start.y); preview(x,y,w,h); }
    function onUp(e){ const r=rect(); const x2=e.clientX-r.left,y2=e.clientY-r.top; const x=Math.min(start.x,x2), y=Math.min(start.y,y2); const w=Math.abs(x2-start.x), h=Math.abs(y2-start.y);
      start=null; c.removeEventListener('mousemove',onMove); c.style.cursor='default';
      if (w>8 && h>8) { hoop={ x, y, w, h, cx:x+w/2, cy:y+h/2 }; }
      paintOverlay();
    }
    if (!window.__OFF_PICK) { c.addEventListener('mousedown',onDown); window.__OFF_PICK = true; }
  }

  // motion centroid inside ROI
  function motionCentroid(roi=null){
    const W = ui.overlay.width, H = ui.overlay.height;
    if (!W||!H) return null;
    // draw current video frame to diff buffer
    dctx.drawImage(ui.video, 0,0,W,H);
    const img  = dctx.getImageData(0,0,W,H);
    const prev = pctx.getImageData(0,0,W,H);
    const data = img.data, pdata = prev.data;

    const rx = roi?.x|0, ry = roi?.y|0, rw = Math.min(W, (roi?.w|0) || W), rh = Math.min(H, (roi?.h|0) || H);
    let sumX=0, sumY=0, count=0;

    // simple diff with stride
    const THR = 26, STR = 2;
    for (let y=ry; y<ry+rh; y+=STR){
      let idx = (y*W + rx) * 4;
      for (let x=rx; x<rx+rw; x+=STR, idx+=4*STR){
        const dr = Math.abs(data[idx]-pdata[idx]);
        const dg = Math.abs(data[idx+1]-pdata[idx+1]);
        const db = Math.abs(data[idx+2]-pdata[idx+2]);
        if ((dr+dg+db) > THR*2){ sumX += x; sumY += y; count++; }
      }
    }
    // keep current as previous
    pctx.putImageData(img, 0, 0);
    if (count < 90) return null;
    return { x: sumX/count, y: sumY/count };
  }

  // decide make/miss
  function decideMM(){
    if (!hoop || decided || trail.length < 6) return;
    // tub check: inside tub for last frames and then motion drops
    const t = tub || { x: hoop.x - hoop.w*0.3, y: hoop.y + hoop.h*0.2, w: hoop.w*1.6, h: hoop.h*0.8 };
    const last = trail.slice(-6);
    const inside = last.filter(p => p.x>=t.x && p.x<=t.x+t.w && p.y>=t.y && p.y<=t.y+t.h).length >= 4;
    if (inside) { made = true; decided = true; return; }
    // if last points stay above rim or leave tub region sideways: miss
    const lastPt = trail[trail.length-1];
    if (lastPt.y < hoop.y || last.length >= 10) {
      made = false; decided = true;
    }
  }

  // stepping: requestVideoFrameCallback or timeupdate fallback
  function startFBF(onFrame){
    running = true; lastTime = -1;
    const step = (_now, meta) => {
      if (!running) return;
      // draw + composite each frame
      onFrame();
      drawComposite();
      rVFC = ui.video.requestVideoFrameCallback(step);
    };
    try {
      rVFC = ui.video.requestVideoFrameCallback(step);
    } catch {
      // fallback: timeupdate pumps
      const f = () => { if (!running) return; onFrame(); drawComposite(); };
      ui.video.addEventListener('timeupdate', f);
    }
  }
  function stopFBF(){
    running = false;
    try { ui.video.cancelVideoFrameCallback(rVFC); } catch {}
    rVFC = 0;
  }

  async function processClip({ id, url }){
    // reset
    stopFBF();
    trail = []; hoop = null; net = null; tub = null; made = null; decided = false; startTS = performance.now();

    ui.video.srcObject = null;
    ui.video.removeAttribute('src');
    ui.video.src = url; ui.video.preload='auto';
    await waitMeta(ui.video);
    if (!syncSizes()) return;
    enableManualHoopPickOnce();
    paintOverlay(); drawComposite();
    ui.video.pause();

    // recorder
    const { rec, done } = startRecorder();

    // per-frame
    const frame = () => {
      // define ROI: focus around hoop if set; else full frame
      let roi = null;
      if (hoop) {
        roi = { x: Math.max(0, hoop.x - hoop.w*0.8),
                y: Math.max(0, hoop.y - hoop.h*0.8),
                w: Math.min(ui.overlay.width,  hoop.w*2.6),
                h: Math.min(ui.overlay.height, hoop.h*2.2) };
      }

      // update motion centroid
      const mc = motionCentroid(roi);
      if (mc) {
        // simple smoothing
        const last = trail[trail.length-1];
        const alpha = last ? 0.65 : 1.0;
        const sx = last ? alpha*last.x + (1-alpha)*mc.x : mc.x;
        const sy = last ? alpha*last.y + (1-alpha)*mc.y : mc.y;
        trail.push({ x:sx, y:sy });
        if (trail.length > 300) trail.shift();
      }

      // if user hasn’t set hoop, don’t decide yet
      if (hoop) decideMM();

      paintOverlay();
    };

    // start stepping
    startFBF(frame);

    // play silently at 1x; we’re recording exportCan anyway
    try { await ui.video.play(); } catch {}
    // guard stop: end after video ends or 3.2s
    const stopAt = Math.min((ui.video.duration || 3.3), 3.25);
    const guard = setInterval(() => {
      if ((ui.video.currentTime || 0) >= stopAt) {
        clearInterval(guard);
        finalize();
      }
    }, 50);

    async function finalize(){
      stopFBF();
      try { rec.requestData?.(); rec.stop(); } catch {}
      const blob = await done;

      // attach inline preview
      const row = document.querySelector(`[data-shot="${id}"]`);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `shot_${id}_overlay.webm`;
      a.textContent = 'Download';
      const v = document.createElement('video');
      v.src = a.href; v.controls = true; v.muted = true; v.style.maxWidth='420px'; v.style.display='block';
      row?.appendChild(document.createTextNode(' · '));
      row?.appendChild(a);
      row?.appendChild(document.createElement('br'));
      row?.appendChild(v);

      // status
      const st = row?.querySelector('.status');
      if (st) st.textContent = `✓ ${made===true?'MAKE':made===false?'MISS':'—'}`;
    }
  }

  function boot(){
    const shots = window.__DEMO_SHOTS || [];
    ui.list.innerHTML = shots.map(s => `
      <div class="shot" data-shot="${s.id}">
        <button class="go" data-id="${s.id}">Process</button>
        <span class="status">waiting…</span>
        <span class="name">${(s.url||'').split('/').pop()}</span>
      </div>
    `).join('');
    ui.list.onclick = async (e) => {
      const b = e.target.closest('button.go'); if (!b) return;
      b.disabled = true;
      const id = b.dataset.id;
      const shot = shots.find(x => String(x.id) === String(id));
      await processClip(shot);
    };
    ui.processAllBtn.onclick = async () => {
      for (const b of [...ui.list.querySelectorAll('button.go')]) {
        b.click();
        await new Promise(r=>setTimeout(r, 250));
      }
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once:true });
  } else boot();
})();
