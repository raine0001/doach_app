// static/js/arc_mm.js
// FBF analysis -> overlay composite -> recorded clip (VP8) with inline preview
// NOTE: If analyzer.js/hoop_tracker.js live under /static/arc_mm/,
// change the imports to '/static/arc_mm/analyzer.js' and '/static/arc_mm/hoop_tracker.js'

import { analyzeVideoFrameByFrame, runShotFBF } from './analyzer.js';
import { getLockedHoopBox, autoDetectHoop } from './hoop_tracker.js';

(function ArcMM() {
  const ui = {
    list: document.getElementById('shotList'),
    video: document.getElementById('mmVideo'),
    overlay: document.getElementById('overlay'),
    exportCan: document.getElementById('exportCanvas'),
    processAllBtn: document.getElementById('processAll')
  };
  try { ui.video.crossOrigin = 'anonymous'; } catch {}

  // ---------- small utils ----------
  const waitFor = (el, evt) => new Promise(res => el.addEventListener(evt, res, { once: true }));
  async function waitForVideoMeta(v){ if (v.readyState >= 1 && v.videoWidth && v.videoHeight) return; await waitFor(v,'loadedmetadata'); }
  function syncSizes(){ const vw=ui.video.videoWidth||0, vh=ui.video.videoHeight||0; if(!vw||!vh) return; [ui.overlay,ui.exportCan].forEach(c=>{c.width=vw;c.height=vh;}); }

  // ---------- session hoop reuse ----------
  function getSessionIdFromShots(){
    const s=(window.__DEMO_SHOTS||[])[0]?.url||''; const m=s.match(/\/sessions\/([^/]+)\/clips\//); return m?m[1]:null;
  }
  async function loadSessionHoopBox(){
    const sid=getSessionIdFromShots(); if(!sid) return null;
    for (const base of ['/static/arc_mm','/static']) {
      try { const r=await fetch(`${base}/sessions/${sid}/session.json`); if(r.ok){ const j=await r.json(); const b=j?.hoop||j?.hoopBox||j?.rim; if(b && [b.x,b.y,b.w,b.h].every(Number.isFinite)) return b; } } catch {}
    }
    try{ const raw=localStorage.getItem(`arcmm.hoop.${sid}`); if(raw) return JSON.parse(raw);}catch{}
    return null;
  }
  function saveSessionHoopBox(px){ const sid=getSessionIdFromShots(); if(!sid) return; try{ localStorage.setItem(`arcmm.hoop.${sid}`, JSON.stringify(px)); }catch{} }

  // ---------- summary HUD ----------
  function drawHudOnExport(ctx){
    const s=window.__lastSummary||{};
    const line1=`Result: ${s.result?String(s.result).toUpperCase():(s.made===true?'MAKE':s.made===false?'MISS':'—')}`;
    const deg=n=>typeof n==='number'?`${Math.round(n)}°`:'—';
    const num=n=>(typeof n==='number'&&isFinite(n))?Math.round(n):'—';
    const line2=`Release ${deg(s.releaseAngle)}  •  Entry ${deg(s.entryAngle)}  •  Apex ${num(s.apexHeight)}`;
    const pad=8, fs=Math.max(14, Math.floor(ctx.canvas.height*0.03));
    ctx.save(); ctx.font=`${fs}px system-ui, sans-serif`; ctx.fillStyle='rgba(0,0,0,0.55)';
    const w1=ctx.measureText(line1).width, w2=ctx.measureText(line2).width; const boxW=Math.max(w1,w2)+pad*2, boxH=fs*2+pad*3;
    ctx.fillRect(pad,pad,boxW,boxH); ctx.fillStyle='#fff'; ctx.fillText(line1,pad*2,pad*2+fs*0.9); ctx.fillText(line2,pad*2,pad*2+fs*2); ctx.restore();
  }

  // ---------- overlay draw config ----------
  const CFG = { drawDetBoxes:true, drawBallTrail:true, drawHoopROI:true, drawProx:true, maskLegacyHudLeds:true };

  function toPixels(box,w,h){ if(!box) return null; const norm=(box.x<=1 && box.y<=1 && box.w<=1 && box.h<=1); return norm?{x:box.x*w,y:box.y*h,w:box.w*w,h:box.h*h}:box; }
  function strokeRect(ctx,b,color='cyan',lw=2){ ctx.save(); ctx.lineWidth=lw; ctx.strokeStyle=color; ctx.strokeRect(b.x,b.y,b.w,b.h); ctx.restore(); }
  function drawTrail(ctx,pts,color='orange'){ if(!pts?.length) return; const W=ctx.canvas.width,H=ctx.canvas.height; ctx.save(); ctx.lineWidth=3; ctx.strokeStyle=color; ctx.beginPath();
    const f=pts[0]; const fx=f.x<=1?f.x*W:f.x, fy=f.y<=1?f.y*H:f.y; ctx.moveTo(fx,fy);
    for(let i=1;i<pts.length;i++){ const p=pts[i]; const x=p.x<=1?p.x*W:p.x, y=p.y<=1?p.y*H:p.y; ctx.lineTo(x,y); } ctx.stroke(); ctx.restore(); }
  function fillLabel(ctx,txt,x,y){ ctx.save(); ctx.font='12px system-ui,sans-serif'; const m=ctx.measureText(txt),pad=4; ctx.fillStyle='rgba(0,0,0,0.6)'; ctx.fillRect(x,y-12,m.width+pad*2,16); ctx.fillStyle='#fff'; ctx.fillText(txt,x+pad,y); ctx.restore(); }

  // manual hoop lock pref
  const __origGetLocked = getLockedHoopBox;
  window.__ARCMM_MANUAL_HOOP = null;
  function setManualHoopBoxPx(px){ window.__ARCMM_MANUAL_HOOP = px; }
  function getHoopBoxPref(){ return window.__ARCMM_MANUAL_HOOP || __origGetLocked?.(); }

  const estimateNetBox = rim => rim ? { x: rim.x, y: rim.y+rim.h*0.6, w: rim.w, h: rim.h*0.9 } : null;
  const estimateTubBox = rim => rim ? { x: rim.x - rim.w*0.3, y: rim.y + rim.h*0.2, w: rim.w*1.6, h: rim.h*0.8 } : null;

  function paintFBFOverlay(){
    const ctx=ui.overlay.getContext('2d'); const W=ui.overlay.width,H=ui.overlay.height;
    ctx.clearRect(0,0,W,H);
    if (CFG.maskLegacyHudLeds){ ctx.save(); ctx.fillStyle='rgba(0,0,0,0.75)'; ctx.fillRect(8,H-110,280,110); ctx.restore(); }

    if (CFG.drawBallTrail){ const arc=window.ballArc||{}; const trail=arc.refinedTrail||arc.trail||[]; drawTrail(ctx, trail, 'orange'); }

    let rim=null,net=null,tub=null;
    if (CFG.drawHoopROI){
      try { const hb=getHoopBoxPref(); if(hb){ const px=toPixels(hb,W,H); rim=px; net=(window.getHoopNetBox?.(px))||estimateNetBox(px); tub=(window.getHoopTubBox?.(px))||estimateTubBox(px);} } catch {}
      if (rim){ strokeRect(ctx,rim,'#25f'); fillLabel(ctx,'RIM ROI',rim.x+2,rim.y+12); }
      if (net){ strokeRect(ctx,net,'#0f9'); fillLabel(ctx,'NET ROI',net.x+2,net.y+12); }
      if (tub){ strokeRect(ctx,tub,'#f0f'); fillLabel(ctx,'TUB ROI',tub.x+2,tub.y+12); }
    }

    if (CFG.drawProx && rim){ const prox={ x: rim.x - rim.w*0.6, y: rim.y - rim.h*0.6, w: rim.w*2.2, h: rim.h*2.0 }; strokeRect(ctx,prox,'#888',1); fillLabel(ctx,'PROX',prox.x+2,prox.y+12); }

    if (CFG.drawDetBoxes){
      const lf=window.lastDetectedFrame||{}; const objs=lf.objects||lf.dets||[];
      for (const o of objs){
        const L=(o.label||o.class||'').toString().toLowerCase();
        if (!L.includes('ball') && !L.includes('basketball')) continue;
        const bb=toPixels(o.box||o.bbox||o,W,H); if (!bb) continue;
        strokeRect(ctx,bb,'#ff3',2); fillLabel(ctx,'BALL',bb.x+2,bb.y+12);
      }
    }
  }

  function compositeFrame(){
    const w=ui.exportCan.width,h=ui.exportCan.height; if(!w||!h) return;
    const ctx=ui.exportCan.getContext('2d');
    ctx.clearRect(0,0,w,h); ctx.drawImage(ui.video,0,0,w,h); ctx.drawImage(ui.overlay,0,0,w,h); drawHudOnExport(ctx);
  }

  // manual rim lock: Shift+drag on overlay (and persist)
  function enableManualHoopPickOnce(){
    const c=ui.overlay; const rect=()=>c.getBoundingClientRect(); let start=null;
    const preview=(x,y,w,h)=>{ paintFBFOverlay(); const k=c.getContext('2d'); k.save(); k.strokeStyle='#25f'; k.lineWidth=2; k.strokeRect(x,y,w,h); k.restore(); };
    function onDown(e){ if(!e.shiftKey) return; e.preventDefault(); const r=rect(); start={x:e.clientX-r.left,y:e.clientY-r.top}; c.addEventListener('mousemove',onMove); c.addEventListener('mouseup',onUp,{once:true}); c.style.cursor='crosshair'; }
    function onMove(e){ if(!start) return; const r=rect(); const x2=e.clientX-r.left,y2=e.clientY-r.top; const x=Math.min(start.x,x2), y=Math.min(start.y,y2); const w=Math.abs(x2-start.x), h=Math.abs(y2-start.y); preview(x,y,w,h); }
    function onUp(e){ const r=rect(); const x2=e.clientX-r.left,y2=e.clientY-r.top; const x=Math.min(start.x,x2), y=Math.min(start.y,y2); const w=Math.abs(x2-start.x), h=Math.abs(y2-start.y); start=null; c.removeEventListener('mousemove',onMove); c.style.cursor='default';
      if (w>8 && h>8){ setManualHoopBoxPx({x,y,w,h}); saveSessionHoopBox({x,y,w,h}); try{ (window.attachHoop||window.attachHoopBox)?.( (window.asTopLeft?.({x,y,w,h})) || {x,y,w,h} ); }catch{} } paintFBFOverlay(); }
    if(!window.__ARCMM_PICK_WIRED){ c.addEventListener('mousedown',onDown); window.__ARCMM_PICK_WIRED=true; }
  }

  function pickMime(){ const prefs=['video/webm;codecs=vp8','video/webm']; return prefs.find(m=>window.MediaRecorder?.isTypeSupported?.(m))||''; }
  function startRecorder(){ const fps=Number(window.__videoFPS)||30; const stream=ui.exportCan.captureStream(fps); const mime=pickMime(); const rec=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:4_000_000}); const chunks=[];
    rec.ondataavailable=e=>{ if(e.data&&e.data.size) chunks.push(e.data); }; const done=new Promise(resolve=>{ rec.onstop=()=>resolve(new Blob(chunks,{type:mime||'video/webm'})); }); rec.start(100); return {rec,done}; }

  function setRowStatus(id,text){ const el=document.querySelector(`[data-shot="${id}"] .status`); if(el) el.textContent=text; }
  function attachPreview(row,blob,id){ try{ const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download=`shot_${id}_overlay.webm`; a.textContent='Download'; const v=document.createElement('video'); v.src=url; v.controls=true; v.muted=true; v.style.maxWidth='420px'; v.style.display='block'; row.appendChild(document.createTextNode(' · ')); row.appendChild(a); row.appendChild(document.createElement('br')); row.appendChild(v);}catch{} }

  // -------------- core --------------
  async function processClip({ id, url }) {
    try{ window.stopFrameAnalysis?.(); }catch{} try{ window.resetAll?.(); }catch{} try{ window.shotArc?.resetShotFSM?.(); }catch{}
    setRowStatus(id,'prepping…');

    ui.video.srcObject=null; ui.video.removeAttribute('src'); ui.video.src=url;
    await waitForVideoMeta(ui.video); syncSizes(); enableManualHoopPickOnce(); paintFBFOverlay(); compositeFrame(); ui.video.pause();

    // preload rim from session or LS
    try { const saved=await loadSessionHoopBox(); if(saved){ setManualHoopBoxPx(saved); try{ (window.attachHoop||window.attachHoopBox)?.( (window.asTopLeft?.(saved)) || saved ); }catch{} } } catch {}

    // one-shot autodetect attempt before frames start
    if (!getHoopBoxPref()) {
      try { const lf=window.lastDetectedFrame||{objects:[]}; autoDetectHoop(lf.objects||[], ui.overlay, true); } catch {}
    }

    // auto-lock when detections appear
    const tryAutoLock = () => {
      if (getHoopBoxPref()) return;
      const lf=window.lastDetectedFrame||{}; const objs=lf.objects||lf.dets||[]; if(!objs.length) return;
      const hoopish=objs.some(o=>{ const L=(o.label||o.class||'').toString().toLowerCase(); return L.includes('hoop')||L.includes('rim')||L.includes('backboard')||L.includes('net'); });
      if (hoopish) { try { autoDetectHoop(objs, ui.overlay, true); } catch {} }
    };
    window.addEventListener('analyzer:frame-done', tryAutoLock);

    // global frame index for older analyzer builds
    window.fidx = 0;
    const __bumpFidx = () => { window.fidx = (window.fidx | 0) + 1; };
    window.addEventListener('analyzer:frame-done', __bumpFidx);

    const { rec, done } = startRecorder();

    // feed legacy scoring each frame + paint
    const onAnalyzerFrame = () => {
      const objs = (window.lastDetectedFrame?.objects || []);
      const hb = getHoopBoxPref();
      if (hb) { try { (window.attachHoop||window.attachHoopBox)?.( (window.asTopLeft?.(hb)) || hb ); } catch {} }
      try { window.bufferDetectedObjects?.(objs); } catch {}

      try {
        // pick a ball and tick
        const rim = hb ? { cx: hb.x + hb.w/2, cy: hb.y + hb.h/2 } : null;
        const balls = objs.filter(o => (o.label||'').toLowerCase().includes('ball'));
        let b = null;
        const last = window.ballState?.trail?.at?.(-1);
        if (last && balls.length){
          balls.sort((a,bx)=>{ const ax=(a.x ?? ((a.box?.[0]+a.box?.[2])/2)) - last.x; const ay=(a.y ?? ((a.box?.[1]+a.box?.[3])/2)) - last.y;
                               const cx=(bx.x ?? ((bx.box?.[0]+bx.box?.[2])/2)) - last.x; const cy=(bx.y ?? ((bx.box?.[1]+bx.box?.[3])/2)) - last.y;
                               return (ax*ax+ay*ay)-(cx*cx+cy*cy); });
          b = balls[0];
        } else if (rim && balls.length){
          balls.sort((a,bx)=>{ const ax=(a.x ?? ((a.box?.[0]+a.box?.[2])/2)) - rim.cx; const ay=(a.y ?? ((a.box?.[1]+a.box?.[3])/2)) - rim.cy;
                               const cx=(bx.x ?? ((bx.box?.[0]+bx.box?.[2])/2)) - rim.cx; const cy=(bx.y ?? ((bx.box?.[1]+bx.box?.[3])/2)) - rim.cy;
                               return (ax*ax+ay*ay)-(cx*cx+cy*cy); });
          b = balls[0];
        }
        if (b) {
          const x = b.x ?? ((b.box?.[0]+b.box?.[2])/2);
          const y = b.y ?? ((b.box?.[1]+b.box?.[3])/2);
          if (x!=null && y!=null) window.updateBall?.({x,y}, (window.fidx|0));
        }
        window.scoringTick?.(window.fidx|0);
        if (hb) window.checkShotConditions?.(window.ballState, hb, (window.fidx|0));
      } catch {}

      paintFBFOverlay();
      compositeFrame();
    };
    window.addEventListener('analyzer:frame-done', onAnalyzerFrame);

    // keep a pump alive so recorder never starves
    const fps = Number(window.__videoFPS)||30;
    const pump = setInterval(()=>{ paintFBFOverlay(); compositeFrame(); }, Math.max(16, Math.floor(1000/fps)));

    const result = { made:null, summary:null, arc:null, blob:null };
    let finished=false; const startedAt=performance.now();

    async function finishNow(why){
      if (finished) return; finished=true;
      clearInterval(pump);
      window.removeEventListener('analyzer:frame-done', onAnalyzerFrame);
      window.removeEventListener('analyzer:frame-done', __bumpFidx);
      window.removeEventListener('analyzer:frame-done', tryAutoLock);

      const minMs=300, waitMs=Math.max(0, minMs - (performance.now()-startedAt));
      if (waitMs) await new Promise(r=>setTimeout(r,waitMs));

      compositeFrame(); try{rec.requestData?.();}catch{} try{rec.stop();}catch{} result.blob=await done;

      try { result.summary=window.__lastSummary || (window.shotLog?.at?.(-1)) || null;
            result.made = result.summary ? (result.summary.made===true || result.summary.result==='make') ? true
                                         : (result.summary.made===false || result.summary.result==='miss') ? false : null : null;
      } catch {}
      try { const arc=window.ballArc||{}; result.arc={ refinedTrail:arc.refinedTrail||arc.trail||[], releasePoint:arc.releasePoint||null, apexPoint:arc.apexPoint||null, rimCrossingPoint:arc.rimCrossingPoint||null }; } catch {}

      const row=document.querySelector(`[data-shot="${id}"]`);
      setRowStatus(id, `✓ ${result.made===true?'MAKE':result.made===false?'MISS':'—'}`); attachPreview(row,result.blob,id);
      try{ window.dispatchEvent(new CustomEvent('arcmm:done',{detail:{shotId:id,result}})); }catch{}
    }

    window.addEventListener('shot:summary', ()=>finishNow('summary'), {once:true});
    window.addEventListener('shot:end', ()=>finishNow('end'), {once:true});

    try { analyzeVideoFrameByFrame(ui.video, ui.overlay); await runShotFBF(); }
    catch (e) { console.warn('[arc_mm] analyzer error', e); await finishNow('error'); }
  }

  async function boot(){
    const shots=window.__DEMO_SHOTS||[];
    ui.list.innerHTML=shots.map(s=>`
      <div class="shot" data-shot="${s.id}">
        <button class="go" data-id="${s.id}">Process</button>
        <span class="status">waiting…</span>
        <span class="name">${(s.url||'').split('/').pop()}</span>
      </div>`).join('');
    ui.list.addEventListener('click', async e=>{ const b=e.target.closest('button.go'); if(!b) return; b.disabled=true; const id=b.dataset.id; const shot=shots.find(x=>String(x.id)===String(id)); await processClip(shot); });
    if (ui.processAllBtn){ ui.processAllBtn.onclick=async ()=>{ for (const b of [...ui.list.querySelectorAll('button.go')]){ b.click(); await new Promise(r=>setTimeout(r,200)); } }; }
  }

  if (document.readyState==='loading') document.addEventListener('DOMContentLoaded', boot, {once:true}); else boot();
})();
