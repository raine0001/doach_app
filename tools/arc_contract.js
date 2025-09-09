// tools/arc_contract.js
;(() => {
  const W = (typeof window !== 'undefined') ? window : globalThis;
  if (W.arcContract) return; // idempotent

  function computeArcMetrics(trail, hoop) {
    const out = {
      points: 0,
      continuity: 0,
      maxJump: 0,
      avgStep: 0,
      apexIndex: -1,
      monotonicUpViol: 0,
      monotonicDownViol: 0,
      r2: 0,
      proxFrames: 0,
      proxMaxRun: 0,
      minDistToHoop: null,
    };
    if (!Array.isArray(trail) || trail.length < 2) return out;
    out.points = trail.length;

    // continuity
    const frames = trail.map((p, i) => Number.isFinite(p.frame) ? p.frame : i);
    const f0 = Math.min(...frames), fN = Math.max(...frames);
    const span = Math.max(1, fN - f0 + 1);
    const covered = new Set(frames).size;
    out.continuity = covered / span;

    // steps & jumps
    let sumStep = 0, maxJ = 0;
    for (let i = 1; i < trail.length; i++) {
      const dx = (trail[i].x ?? 0) - (trail[i-1].x ?? 0);
      const dy = (trail[i].y ?? 0) - (trail[i-1].y ?? 0);
      const d  = Math.hypot(dx, dy);
      sumStep += d;
      if (d > maxJ) maxJ = d;
    }
    out.avgStep = sumStep / Math.max(1, trail.length - 1);
    out.maxJump = maxJ;

    // apex (min Y on canvas; lower y = higher)
    let minY = +Infinity, idx = 0;
    for (let i = 0; i < trail.length; i++) {
      const y = trail[i].y ?? +Infinity;
      if (y < minY) { minY = y; idx = i; }
    }
    out.apexIndex = idx;

    // monotonic checks with small tolerance
    const tol = 2; // px
    for (let i = 1; i <= idx; i++) {
      const dy = (trail[i].y ?? 0) - (trail[i-1].y ?? 0);
      if (dy > tol) out.monotonicUpViol++; // should be going up (y decreasing)
    }
    for (let i = idx+1; i < trail.length; i++) {
      const dy = (trail[i].y ?? 0) - (trail[i-1].y ?? 0);
      if (dy < -tol) out.monotonicDownViol++; // should be going down (y increasing)
    }

    // parabola fit y = ax^2 + bx + c → R^2
    const n = trail.length;
    let sx=0, sx2=0, sx3=0, sx4=0, sy=0, sxy=0, sx2y=0;
    let ybar = 0;
    for (const p of trail) ybar += (p.y ?? 0);
    ybar /= n;
    let ssTot = 0;
    for (const p of trail) {
      const x = (p.x ?? 0), y = (p.y ?? 0);
      const x2 = x*x;
      sx   += x;
      sx2  += x2;
      sx3  += x2*x;
      sx4  += x2*x2;
      sy   += y;
      sxy  += x*y;
      sx2y += x2*y;
      ssTot += (y - ybar)*(y - ybar);
    }
    // Solve normal equations for [a,b,c]
    const A = [
      [ sx4, sx3, sx2 ],
      [ sx3, sx2, sx  ],
      [ sx2, sx,  n   ],
    ];
    const B = [ sx2y, sxy, sy ];
    function det3(m){
      return m[0][0]*(m[1][1]*m[2][2]-m[1][2]*m[2][1])
           - m[0][1]*(m[1][0]*m[2][2]-m[1][2]*m[2][0])
           + m[0][2]*(m[1][0]*m[2][1]-m[1][1]*m[2][0]);
    }
    function solve3(A,B){
      const D  = det3(A);
      if (Math.abs(D) < 1e-9) return [0,0,0];
      const A1 = [[B[0],A[0][1],A[0][2]],[B[1],A[1][1],A[1][2]],[B[2],A[2][1],A[2][2]]];
      const A2 = [[A[0][0],B[0],A[0][2]],[A[1][0],B[1],A[1][2]],[A[2][0],B[2],A[2][2]]];
      const A3 = [[A[0][0],A[0][1],B[0]],[A[1][0],A[1][1],B[1]],[A[2][0],A[2][1],B[2]]];
      const a = det3(A1)/D, b = det3(A2)/D, c = det3(A3)/D;
      return [a,b,c];
    }
    const [a,b,c] = solve3(A,B);
    let ssRes = 0;
    for (const p of trail) {
      const x = (p.x ?? 0), y = (p.y ?? 0);
      const yhat = a*x*x + b*x + c;
      ssRes += (y - yhat)*(y - yhat);
    }
    out.r2 = ssTot > 1e-6 ? (1 - ssRes/ssTot) : 0;

    // hoop proximity (if provided)
    if (hoop) {
      const Hc = canonHoop(hoop);
      const prox = makeProxRectFromCanon(Hc);
      if (prox) {
        let run = 0, maxRun=0, inside=0, minD=null;
        for (const p of trail) {
          const inRect = p.x >= prox.x && p.x <= prox.x+prox.w && p.y >= prox.y && p.y <= prox.y+prox.h;
          if (inRect) { inside++; run++; if (run>maxRun) maxRun = run; }
          else run=0;
          const d = Math.hypot((p.x - Hc.cx), (p.y - Hc.cy));
          if (minD==null || d<minD) minD = d;
        }
        out.proxFrames = inside;
        out.proxMaxRun = maxRun;
        out.minDistToHoop = minD;
      }
    }
    return out;
  }

  // Accept/reject against desired look
  function assessArcQuality(m, thr = {}) {
    const T = Object.assign({
      minPoints: 12,
      minContinuity: 0.92,
      maxJump: 40,
      maxUpViol: 2,
      maxDnViol: 2,
      minR2: 0.90,
      minProxRun: 3,
      maxMinDist: 60, // px to hoop center
    }, thr || {});
    const reasons = [];
    if (m.points < T.minPoints) reasons.push(`points<${T.minPoints}`);
    if (m.continuity < T.minContinuity) reasons.push(`continuity<${T.minContinuity}`);
    if (m.maxJump > T.maxJump) reasons.push(`maxJump>${T.maxJump}`);
    if (m.apexIndex <= 0 || m.apexIndex >= m.points-1) reasons.push(`badApex`);
    if (m.monotonicUpViol > T.maxUpViol) reasons.push(`upViol>${T.maxUpViol}`);
    if (m.monotonicDownViol > T.maxDnViol) reasons.push(`downViol>${T.maxDnViol}`);
    if (m.r2 < T.minR2) reasons.push(`r2<${T.minR2}`);
    if (Number.isFinite(m.proxMaxRun) && m.proxMaxRun < T.minProxRun) reasons.push(`proxRun<${T.minProxRun}`);
    if (Number.isFinite(m.minDistToHoop) && m.minDistToHoop > T.maxMinDist) reasons.push(`minDist>${T.maxMinDist}`);
    return { pass: reasons.length === 0, reasons };
  }

  // Map failures → safe knob tweaks the runtime/test can apply immediately
  function proposeAutoFix(m) {
    const fixes = [];
    if (m.continuity < 0.92 || m.points < 12) {
      fixes.push({ key: 'pumpHz', val: 25 });              // increase trail pump
      fixes.push({ key: 'roi',    val: 28 });              // bigger refine ROI if you use one
    }
    if (m.maxJump > 40) {
      fixes.push({ key: 'maxStep', val: 35 });             // clamp per-frame step
      fixes.push({ key: 'interp',  val: true });           // enable gap interpolation
    }
    if (m.r2 < 0.9) {
      fixes.push({ key: 'splineWindow', val: 5 });         // stronger render smoothing
    }
    if ((m.proxMaxRun ?? 0) < 3) {
      fixes.push({ key: 'proxX', val: '+40' });
      fixes.push({ key: 'proxYAbove', val: '+20' });
      fixes.push({ key: 'proxYBelow', val: '+20' });
      fixes.push({ key: 'hold', val: 6 });                 // post-exit hold
      fixes.push({ key: 'below', val: 8 });                // below-rim margin
    }
    if ((m.minDistToHoop ?? 999) > 60) {
      fixes.push({ key: 'aimTube', val: true });           // tighten tube aim if you gate it
    }
    return fixes;
  }

  // Apply fixes to both styles of knobs we’ve been using
  function applyFixes(fixes) {
    const W = window;
    if (!Array.isArray(fixes) || !fixes.length) return;
    W.__EA = W.__EA || {};
    const up = (k, v) => {
      if (typeof v === 'string' && v.startsWith('+')) {
        const add = Number(v.slice(1)) || 0;
        W.__EA[k] = (W.__EA[k] || 0) + add;
      } else {
        W.__EA[k] = v;
      }
      // mirror to legacy globals many modules read
      if (k === 'proxX')        W.proxX = W.__EA.proxX;
      if (k === 'proxYAbove')   W.proxYAbove = W.__EA.proxYAbove;
      if (k === 'proxYBelow')   W.proxYBelow = W.__EA.proxYBelow;
      if (k === 'hold')         W.POST_EXIT_HOLD = W.__EA.hold;
      if (k === 'below')        W.FINALIZE_BELOW_MARGIN = W.__EA.below;
      if (k === 'maxStep')      W.MAX_STEP = W.__EA.maxStep;
    };
    for (const f of fixes) up(f.key, f.val);
    try { W.dispatchEvent?.(new CustomEvent('autofix:applied', { detail: { fixes, EA: { ...W.__EA } } })); } catch {}
  }

  // Helpers (same as your app’s canon/prox)
  function canonHoop(H) {
    const cx = H.cx ?? (H.x + (H.w ?? 0)/2);
    const cy = H.cy ?? (H.y + (H.h ?? 0)/2);
    const h  = H.h ?? (H.r ?? 18) * 2;
    return { cx, cy, h, rimTop: cy - h/2 };
  }
  function makeProxRectFromCanon(H) {
    if (!H) return null;
    const proxX      = Number(W.proxX)      || 200;
    const proxYAbove = Number(W.proxYAbove) || 170;
    const proxYBelow = Number(W.proxYBelow) || 100;
    const rimTop = (H.rimTop != null) ? H.rimTop : (Number.isFinite(H.cy) && Number.isFinite(H.h)) ? (H.cy - H.h/2) : (H.y ?? 0);
    return { x: (H.cx ?? H.x) - proxX, y: rimTop - proxYAbove, w: proxX*2, h: proxYAbove + proxYBelow };
  }

  W.arcContract = { computeArcMetrics, assessArcQuality, proposeAutoFix, applyFixes };
})();
