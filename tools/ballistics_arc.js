// tools/ballistics_arc.js — short-burst ballistic arc synthesis
;(function installBallisticsArc(){
  const W = (typeof window !== 'undefined') ? window : globalThis;
  if (W.__ballisticsArcInstalled) return; W.__ballisticsArcInstalled = true;

  const CFG = Object.assign({
    fps:             30,     // override by window.__videoFPS
    postReleaseN:    6,      // short burst after release
    proxBurstN:      6,      // short burst inside proximity
    proxExtendBelow: 48,     // extend prox below rim to catch 2–3 descent frames
    gMin:            1200,   // tuned for 720p/1080p typical gym framing
    gMax:            4200,
    dtRender:        1/120,   // denser curve (smoother rings)
    rimHitXWindow:   28,
    stopAfterSec:    2.6,
    blendHeadTrueN:  4       // blend first few synthetic samples with true track for a perfect join
  }, (W.DOACH_ARC_CFG || {}));
  const fps = () => (Number(W.__videoFPS) > 0 ? Number(W.__videoFPS) : CFG.fps);

  function captureBurst(N, untilFn, timeoutMs=500){
    const t0 = performance.now();
    return new Promise((resolve,reject)=>{
      const iv = setInterval(()=>{
        const bs = (W.ballState ||= {});
        const tr = bs.trail || [];
        const last = tr.at?.(-1);
        if (untilFn && !untilFn(last)) {
          if (performance.now()-t0 > timeoutMs) { clearInterval(iv); reject(new Error('burst condition timeout')); }
          return;
        }
        if (tr.length >= N) { clearInterval(iv); resolve(tr.slice(-N)); }
        else if (performance.now()-t0 > timeoutMs) { clearInterval(iv); reject(new Error('burst len timeout')); }
      }, 12);
    });
  }

  function paramsFromBurst(points, f){
    const P0 = points[0]; const y0 = P0.y;
    let S_t=0,S_t2=0,S_t3=0,S_t4=0,S_tx=0,S_ty=0,S_t2y=0;
    for(const p of points){
      const k=(p.frame??0)-(P0.frame??0); const t=k*(1/f); const t2=t*t;
      S_t+=t; S_t2+=t2; S_t3+=t2*t; S_t4+=t2*t2;
      S_tx+=t*(p.x-P0.x); S_ty+=t*(p.y-y0); S_t2y+=t2*(p.y-y0);
    }
    const v0x = (S_tx)/(S_t2||1e-6);
    const A11=S_t2, A12=0.5*S_t3, A21=0.5*S_t3, A22=0.25*S_t4; const B1=S_ty, B2=0.5*S_t2y; const det=A11*A22-A12*A21 || 1e-6;
    const v0y=( B1*A22 - A12*B2)/det; const g=( A11*B2 - B1*A21)/det;
    return { v0x, v0y, g };
  }

  function refineY(P0, burst, keep, f){
    if (!burst?.length) return keep;
    const dt = 1/f;
    let S_t=0,S_t2=0,S_t3=0,S_t4=0,S_ty=0,S_t2y=0;
    for(const p of burst){ const k=(p.frame??0)-(P0.frame??0); const t=k*dt, y=p.y-P0.y; const t2=t*t; S_t+=t; S_t2+=t2; S_t3+=t2*t; S_t4+=t2*t2; S_ty+=t*y; S_t2y+=t2*y; }
    const A11=S_t2, A12=0.5*S_t3, A21=0.5*S_t3, A22=0.25*S_t4; const B1=S_ty, B2=0.5*S_t2y; const det=A11*A22-A12*A21; if (Math.abs(det)<1e-9) return keep;
    const v0y=( B1*A22 - A12*B2)/det; const g=( A11*B2 - B1*A21)/det;
    return { v0x: keep.v0x, v0y, g };
  }

  function synthesizeArc(P0, ball, hoop, f, dt=CFG.dtRender){
    const pts=[]; if(!P0||!hoop) return pts;
    const cx = hoop.cx ?? (hoop.x + (hoop.w||0)/2);
    const cy = hoop.cy ?? (hoop.y + (hoop.h||0)/2);
    const rimBottom = cy + (hoop.h||36)/2; const rimX=cx; const dirX = Math.sign(ball.v0x || (cx-P0.x));
    let t=0,k=0; const maxT=CFG.stopAfterSec;
    while(t<=maxT && k<600){ const x=P0.x + ball.v0x*t; const y=P0.y + ball.v0y*t + 0.5*ball.g*t*t; pts.push({x,y,frame:(P0.frame??0)+Math.round(t*f)});
      const crossed = (dirX>=0) ? (x >= rimX - CFG.rimHitXWindow) : (x <= rimX + CFG.rimHitXWindow);
      if (crossed || y>rimBottom+12) break; t+=dt; k++; }
    return pts;
  }

  async function compute(){
    const f=fps(); const bs=(W.ballState ||= {}); const rel=bs.releaseFrame ?? (bs.trail?.at?.(-1)?.frame ?? null); if(rel==null) return null;
    const burstA = await captureBurst(CFG.postReleaseN, last => ((last?.frame??-1) >= rel+1)).catch(()=>null); if(!burstA||burstA.length<3) return null;
    const P0 = burstA[0]; let params = paramsFromBurst(burstA.slice(0, Math.max(3, Math.min(burstA.length, 6))), f);
    params.g = Math.min(CFG.gMax, Math.max(CFG.gMin, params.g || 1800));
    const hoop = W.getLockedHoopBox?.(); if(hoop){
      const proxX=Number(W.proxX)||200, proxYAbove=Number(W.proxYAbove)||170, proxYBelow=(Number(W.proxYBelow)||100)+Number(CFG.proxExtendBelow||0); const cyTop=hoop.cy-(hoop.h||36)/2;
      const prox={x:hoop.cx-proxX,y:cyTop-proxYAbove,w:proxX*2,h:proxYAbove+proxYBelow}; const inProx=p=>!!p&&p.x>=prox.x&&p.x<=prox.x+prox.w&&p.y>=prox.y&&p.y<=prox.y+prox.h;
      const burstB = await captureBurst(CFG.proxBurstN, p=>inProx(p), 900).catch(()=>null); if(burstB&&burstB.length>=3){ params = refineY(P0, burstB, params, f); params.g=Math.min(CFG.gMax, Math.max(CFG.gMin, params.g||params.g)); }
    }
    let arcPts = synthesizeArc(P0, params, hoop, f);
    // Blend: use first few true trail points from release, then synthetic continuation
    try {
      const tr = Array.isArray(bs.trail) ? bs.trail : [];
      const headTrue = tr.filter(p => (p.frame??0) >= (P0.frame??0) && (p.frame??0) <= (P0.frame??0)+CFG.blendHeadTrueN);
      if (headTrue.length) {
        const lastF = headTrue.at(-1).frame ?? (P0.frame ?? 0);
        const rest = arcPts.filter(p => (p.frame??0) > lastF);
        arcPts = [...headTrue, ...rest];
      }
    } catch {}
    return { arcPts, P0, params, hoop };
  }

  window.addEventListener('shot:release', async ()=>{
    try{ const res=await compute(); if(!res) return; (W.ballState ||= {}).syntheticArc = res.arcPts; }catch{}
  });
  window.addEventListener('shot:summary', ()=>{
    try{ const bs=(W.ballState ||= {}); const arc=bs.syntheticArc; if(Array.isArray(arc)&&arc.length){ (bs.frozenShots ||= []).push({ trail: arc.slice(), summary: W.__lastSummary }); } }catch{}
  });
  window.addEventListener('shot:release', ()=>{ try{ const bs=(W.ballState ||= {}); bs.syntheticArc=null; }catch{} });

  console.log('[ballistics] short-burst ballistic arc ready');
})();
