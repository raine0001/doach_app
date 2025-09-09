// tools/overlay_clean_mode.js
;(() => {
  const W = (typeof window !== 'undefined') ? window : globalThis;
  if (W.__overlayCleanInstalled) return;
  W.__overlayCleanInstalled = true;

  // Mode gate: 'clean' | 'debug'
  W.__overlayMode = W.__overlayMode || 'clean';
  W.setOverlayMode = (m) => { W.__overlayMode = (m === 'debug') ? 'debug' : 'clean'; };
  // Freeze gate: when true, we stop redrawing on analyzer frames until next release
  W.__overlayFreeze = false;

  // ---------- small spline (Catmull-Rom) smoother ----------
  function smoothTrail(trail, tension = 0.5, step = 8) {
    if (!Array.isArray(trail) || trail.length < 3) return trail || [];
    const pts = trail.map(p => ({ x: p.x, y: p.y }));
    const out = [];
    for (let i = -1; i < pts.length - 2; i++) {
      const p0 = pts[Math.max(i, 0)];
      const p1 = pts[Math.max(i + 1, 0)];
      const p2 = pts[Math.min(i + 2, pts.length - 1)];
      const p3 = pts[Math.min(i + 3, pts.length - 1)];
      for (let t = 0; t <= step; t++) {
        const s = t / step, s2 = s*s, s3 = s2*s;
        const m0x = (p2.x - p0.x) * tension, m0y = (p2.y - p0.y) * tension;
        const m1x = (p3.x - p1.x) * tension, m1y = (p3.y - p1.y) * tension;
        const a0 =  2*s3 - 3*s2 + 1, a1 =   s3 - 2*s2 + s;
        const a2 =    s3 -   s2,     a3 = -2*s3 + 3*s2;
        out.push({
          x: a0*p1.x + a1*m0x + a2*m1x + a3*p2.x,
          y: a0*p1.y + a1*m0y + a2*m1y + a3*p2.y,
        });
      }
    }
    return out;
  }

  function getArcWindow() {
    const bs  = (W.ballState ||= {});
    const rel = bs.releaseFrame ?? null;
    const enter = bs.proxEnterFrame ?? null;
    const exit= bs.proxExitFrame ?? null;
    const src = (W.ballArc?.trail?.length ? W.ballArc.trail : bs.trail) || [];
    if (!src.length) return [];
    // Only render live arc after release; avoid pre-shot noise
    if (rel == null) return [];
    // Frame gate: prefer proximity window if available
    const fmin = Number.isFinite(enter) ? (enter - 1) : (rel - 5);
    const fmax = Number.isFinite(exit) ? (exit + 5) : (src.at(-1)?.frame ?? Infinity);
    let win = src.filter(p => (p.frame ?? 0) >= fmin && (p.frame ?? 0) <= fmax);
    // Geo gate: keep only points inside proximity rect (slightly extended below)
    const H = W.getLockedHoopBox?.();
    if (H && win.length) {
      const proxX = Number(W.proxX) || 200;
      const proxYAbove = Number(W.proxYAbove) || 170;
      const proxYBelow = (Number(W.proxYBelow) || 100) + 40;
      const cyTop = H.cy - (H.h || 36)/2;
      const rect = { x: H.cx - proxX, y: cyTop - proxYAbove, w: proxX*2, h: proxYAbove + proxYBelow };
      win = win.filter(p => p.x >= rect.x && p.x <= rect.x + rect.w && p.y >= rect.y && p.y <= rect.y + rect.h);
    }
    return win;
  }

  function drawHoop(ctx) {
    const H = W.getLockedHoopBox?.(); if (!H) return;
    const cx = H.cx ?? (H.x + (H.w ?? 0)/2);
    const cy = H.cy ?? (H.y + (H.h ?? 0)/2);
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, 18, 0, Math.PI*2);
    ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,120,0,0.95)'; ctx.stroke();
    ctx.restore();
  }

  // Resample a polyline so points are spaced ~dist px apart
  function resampleByDistance(pts, dist = 26) {
    if (!Array.isArray(pts) || pts.length < 2) return pts || [];
    const out = [pts[0]];
    let acc = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = out[out.length - 1];
      const b = pts[i];
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy);
      if (d >= dist) {
        const n = Math.max(1, Math.floor(d / dist));
        for (let k = 1; k <= n; k++) {
          const t = Math.min(1, (k * dist) / d);
          out.push({ x: a.x + dx * t, y: a.y + dy * t });
        }
      }
    }
    return out;
  }

  function polylineLength(pts) {
    let L = 0; for (let i=1;i<pts.length;i++){ const dx=pts[i].x-pts[i-1].x, dy=pts[i].y-pts[i-1].y; L += Math.hypot(dx,dy);} return L;
  }

  function drawRings(ctx, trail, { color = 'rgba(255,170,0,0.95)', radius = 15, spacing = 26, minRings = 10 } = {}) {
    if (!trail?.length) { try { W.__overlayArcDrawnCount = 0; } catch {} return; }
    const sm = smoothTrail(trail, 0.5, 6);
    // Ensure we get at least minRings if the path length allows
    const L = polylineLength(sm);
    const step = Math.max(6, Math.min(spacing, L / Math.max(1, minRings)));
    const samples = resampleByDistance(sm, step);
    try { W.__overlayLastTrailInput = trail.length; W.__overlayArcDrawnCount = samples.length; } catch {}
    ctx.save();
    ctx.lineWidth = 3; ctx.strokeStyle = color; ctx.fillStyle = 'transparent';
    for (const p of samples) { ctx.beginPath(); ctx.arc(p.x, p.y, radius, 0, Math.PI*2); ctx.stroke(); }
    ctx.restore();
  }

  // ---------- Robust hook for drawLiveOverlay (load-order independent) ----------
  (function hookDrawLiveOverlay(){
    const wrap = (orig) => function(objects, playerState) {
      const cv = document.getElementById('overlay') || document.getElementById('videoCanvas');
      const ctx = cv?.getContext?.('2d'); if (!cv || !ctx) return;
      if (W.__overlayMode === 'clean' && W.__overlayFreeze === true) return; // frozen: keep pixels
      ctx.clearRect(0, 0, cv.width, cv.height);
      if (W.__overlayMode === 'clean') {
        const bs = (W.ballState ||= {});
        const frozen = Array.isArray(bs.frozenShots) && bs.frozenShots.length ? (bs.frozenShots.at(-1)?.trail || []) : [];
        const wantFrozen = !!bs.showFrozen;
        const liveSynth = Array.isArray(bs.syntheticArc) && bs.syntheticArc.length ? bs.syntheticArc : null;
        const toDraw = (wantFrozen && frozen.length) ? frozen : (liveSynth || getArcWindow());
        try { W.__overlayLastTrailMode = wantFrozen ? 'frozen' : 'live'; } catch {}
        drawRings(ctx, toDraw, { color: 'rgba(255,170,0,0.95)', radius: 15, spacing: 26, minRings: 10 });
        drawHoop(ctx);
        return;
      }
      try { return orig?.(objects, playerState); } catch {}
    };
    if (typeof W.drawLiveOverlay === 'function') {
      W.drawLiveOverlay = wrap(W.drawLiveOverlay);
    } else {
      try {
        Object.defineProperty(W, 'drawLiveOverlay', {
          configurable: true,
          set(fn) { Object.defineProperty(W, 'drawLiveOverlay', { configurable: true, writable: true, value: wrap(fn) }); },
          get() { return undefined; }
        });
      } catch {}
    }
  })();

  // ---------- LAST-PASS CLEAN REDRAW ----------
  function redrawCleanLast() {
    if (W.__overlayMode !== 'clean') return;
    const cv  = document.getElementById('overlay') || document.getElementById('videoCanvas');
    const ctx = cv?.getContext?.('2d'); if (!cv || !ctx) return;

    // Defer to end of event queue so we truly draw last
    setTimeout(() => {
      // wipe everything other drawers painted and draw only arc+hoop
      ctx.clearRect(0, 0, cv.width, cv.height);
      const bs = (W.ballState ||= {});
      const frozen = Array.isArray(bs.frozenShots) && bs.frozenShots.length ? (bs.frozenShots.at(-1)?.trail || []) : [];
      const wantFrozen = !!bs.showFrozen;
      const liveSynth = Array.isArray(bs.syntheticArc) && bs.syntheticArc.length ? bs.syntheticArc : null;
      const toDraw = (wantFrozen && frozen.length) ? frozen : (liveSynth || getArcWindow());
      try { W.__overlayLastTrailMode = wantFrozen ? 'frozen' : 'live'; } catch {}
      drawRings(ctx, toDraw, { color: 'rgba(255,170,0,0.95)', radius: 15, spacing: 26, minRings: 10 });
      drawHoop(ctx);
    }, 0);
  }

  // Ensure toggling to 'clean' triggers an immediate redraw once (even if frozen)
  try {
    const _setMode = W.setOverlayMode;
    W.setOverlayMode = (m) => { _setMode?.(m); if ((W.__overlayMode||'clean') === 'clean') { try { redrawCleanLast(); } catch {} } };
  } catch {}

  // draw after each analyzer frame, and once more right after summary
  window.addEventListener('analyzer:frame-done', () => { if (!W.__overlayFreeze) redrawCleanLast(); });
  window.addEventListener('shot:summary', () => { W.__overlayFreeze = true; redrawCleanLast(); });
  window.addEventListener('shot:release', () => { W.__overlayFreeze = false; });

  // ---------- silence common debug drawers while in clean mode ----------
  const swallowIfClean = (name) => {
    const makeWrapper = (fn) => function(...args){ if (W.__overlayMode==='clean') return; try { return fn.apply(this,args);} catch {} };
    if (typeof W[name] === 'function') {
      W[name] = makeWrapper(W[name]);
    } else {
      try {
        Object.defineProperty(W, name, {
          configurable: true,
          set(fn){ Object.defineProperty(W, name, { configurable:true, writable:true, value: makeWrapper(fn) }); },
          get(){ return undefined; }
        });
      } catch {}
    }
  };
  [
    'updateDebugOverlay',
    'drawPoseSkeleton',
    'drawWristTrail',
    'drawNetMotionStatus',
    'drawBallTrail'      // if you have a separate debug trail
  ].forEach(swallowIfClean);

  console.log('[overlay] clean mode installed (last-pass). Use setOverlayMode("clean"|"debug").');
})();
