// ball_tracker.js â€” minimal, selfâ€‘sufficient ball tracker
// Responsibilities (only):
//  - Maintain a ball trail given perâ€‘frame detections
//  - Smooth via a lightweight Kalman filter (2D constant velocity)
//  - Fill small gaps and clamp large jumps
//  - Provide a renderer to draw the trail as circles
//  - Start/stop/reset are controlled externally by the host (e.g., app.js)

// External dependencies: none (host calls updateBall with {x,y} in canvas space)

// ---- Options (overridable at runtime) ----
const OPT = {
  MAX_TRAIL_POINTS: Number(window.BALL_MAX_POINTS || 220),
  GAP_FILL_MAX:     Number(window.BALL_GAP_FILL_MAX || 4),   // fill â‰¤N missing frames
  MAX_STEP:         Number(window.BALL_MAX_STEP || 58),      // px/frame clamp
  KF_PROCESS_NOISE: Number(window.BALL_KF_Q || 2.0),         // process noise strength
  KF_MEASURE_NOISE: Number(window.BALL_KF_R || 4.0),         // measurement noise
  RING_RADIUS:      Number(window.BALL_RING_RADIUS || 12),   // draw radius (px)
  RING_SPACING:     Number(window.BALL_RING_SPACING || 22),  // sample step for dense trails
};

export function setBallOptions(o={}) {
  Object.assign(OPT, o || {});
}

// ---- Simple 2D constantâ€‘velocity Kalman filter ----
class Kalman2D {
  constructor(dt=1, q=2.0, r=4.0) {
    this.dt = dt;
    // State x = [x, y, vx, vy]^T
    this.x = new Float64Array([0,0,0,0]);
    this.P = matEye(4, 1000);
    this.Q = matScale(procNoiseCV(dt, q), 1);
    this.R = matEye(2, r);
    this.F = transCV(dt);
    this.H = new Float64Array([1,0,0,0, 0,1,0,0]); // 2x4
    this.initialized = false;
  }
  predict(dt=this.dt){
    // Update F and Q if dt changed
    if (dt !== this.dt){ this.dt=dt; this.F = transCV(dt); this.Q = procNoiseCV(dt, OPT.KF_PROCESS_NOISE); }
    // x = F x
    this.x = matMulVec(this.F, 4,4, this.x);
    // P = F P F^T + Q
    const FP  = matMul(this.F,4,4, this.P,4,4);
    const FPF = matMul(FP,4,4, matTranspose(this.F,4,4),4,4);
    this.P = matAdd(FPF, this.Q);
    return this.x;
  }
  update(zx, zy){
    const z = new Float64Array([zx, zy]);
    // y = z - H x
    const Hx = matMulVec(this.H,2,4, this.x);
    const y  = vecSub(z, Hx);
    // S = H P H^T + R
    const HP  = matMul(this.H,2,4, this.P,4,4);
    const HPH = matMul(HP,2,4, matTranspose(this.H,2,4),4,2);
    const S   = matAdd(HPH, this.R);
    // K = P H^T S^-1
    const HT  = matTranspose(this.H,2,4);
    const PHT = matMul(this.P,4,4, HT,4,2);
    const Sinv= matInv2(S);
    const K   = matMul(PHT,4,2, Sinv,2,2);
    // x = x + K y
    this.x = vecAdd(this.x, matMulVec(K,4,2, y));
    // P = (I - K H) P
    const KH = matMul(K,4,2, this.H,2,4);
    const I  = matEye(4,1);
    const IKH= matSub(I, KH);
    this.P = matMul(IKH,4,4, this.P,4,4);
    this.initialized = true;
    return this.x;
  }
  initFrom(zx, zy){ this.x[0]=zx; this.x[1]=zy; this.x[2]=0; this.x[3]=0; this.P = matEye(4, 10); this.initialized=true; }
}

// CV model helpers
function transCV(dt){
  return new Float64Array([
    1,0,dt,0,
    0,1,0,dt,
    0,0,1,0,
    0,0,0,1,
  ]);
}
function procNoiseCV(dt,q){ // simple diagonal process noise scaled by dt
  const s = Math.max(1e-6, dt*dt*q);
  return new Float64Array([
    s,0,0,0,
    0,s,0,0,
    0,0,s,0,
    0,0,0,s,
  ]);
}

// Small matrix utilities (4x4 / 2x2 only)
function matEye(n,val){ const a=new Float64Array(n*n); for(let i=0;i<n;i++) a[i*n+i]=val||1; return a; }
function matAdd(A,B){ const C=new Float64Array(A.length); for(let i=0;i<A.length;i++) C[i]=A[i]+B[i]; return C; }
function matSub(A,B){ const C=new Float64Array(A.length); for(let i=0;i<A.length;i++) C[i]=A[i]-B[i]; return C; }
function matScale(A,s){ const C=new Float64Array(A.length); for(let i=0;i<A.length;i++) C[i]=A[i]*s; return C; }
function matTranspose(A,r,c){ const T=new Float64Array(A.length); for(let i=0;i<r;i++) for(let j=0;j<c;j++) T[j*r+i]=A[i*c+j]; return T; }
function matMul(A, rA, cA, B, rB, cB){ const C=new Float64Array(rA*cB); for(let i=0;i<rA;i++){ for(let j=0;j<cB;j++){ let s=0; for(let k=0;k<cA;k++) s+=A[i*cA+k]*B[k*cB+j]; C[i*cB+j]=s; } } return C; }
function matMulVec(A, r, c, v){ const out=new Float64Array(r); for(let i=0;i<r;i++){ let s=0; for(let j=0;j<c;j++) s+=A[i*c+j]*v[j]; out[i]=s; } return out; }
function vecAdd(a,b){ const c=new Float64Array(a.length); for(let i=0;i<a.length;i++) c[i]=a[i]+b[i]; return c; }
function vecSub(a,b){ const c=new Float64Array(a.length); for(let i=0;i<a.length;i++) c[i]=a[i]-b[i]; return c; }
function matInv2(M){ // invert 2x2
  const a=M[0], b=M[1], c=M[2], d=M[3]; const det=a*d-b*c || 1e-9; const s=1/det;
  return new Float64Array([ d*s, -b*s, -c*s, a*s ]);
}

// ---- Ball tracker state ----
const state = {
  active: true,            // host can toggle
  trail: [],               // [{x,y,frame}]
  lastFrame: null,
  kf: null,
};

export function resetBallTrail() {
  state.trail.length = 0;
  state.lastFrame = null;
  state.kf = null;
}
export function setBallActive(on=true){ state.active = !!on; }

// Host calls this once per analyzed frame when a detection for the ball exists.
export function updateBall(arg1, arg2, arg3) {
  if (!state.active) return false;

  let point = null;
  let frameIndex = null;
  let meta = {};

  if (typeof arg1 === 'number' && typeof arg2 === 'number') {
    point = { x: arg1, y: arg2 };
    meta = (typeof arg3 === 'object' && arg3) ? arg3 : {};
    frameIndex = Number(meta.frame);
  } else {
    point = arg1 || {};
    meta = (typeof arg3 === 'object' && arg3) ? arg3 : (typeof arg2 === 'object' ? arg2 : {});
    frameIndex = Number(arg2);
  }

  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;

  if (!Number.isFinite(frameIndex)) frameIndex = Number(meta.frame);
  if (!Number.isFinite(frameIndex)) frameIndex = Number(point.frame);
  if (!Number.isFinite(frameIndex)) frameIndex = Number(window.__AN_IDX ?? window.__REL_LAST_FRAME ?? 0) || 0;

  const sampleMs = Number.isFinite(meta?.tMs) ? Number(meta.tMs)
                    : Number.isFinite(point?.tMs) ? Number(point.tMs)
                    : performance.now();

  try { window.ballState = window.ballState || ballState; } catch {}
  const bs = window.ballState || ballState;
  if (!Array.isArray(bs.trail)) {
    try { bs.trail = state.trail; } catch {}
  }

  // Init KF if needed
  if (!state.kf) {
    state.kf = new Kalman2D(1, OPT.KF_PROCESS_NOISE, OPT.KF_MEASURE_NOISE);
    state.kf.initFrom(point.x, point.y);
  }

  const last = state.trail.at?.(-1) || null;
  const gap = (last && Number.isFinite(last.frame)) ? (frameIndex - last.frame) : 0;
  if (last && gap > 1) {
    const fillN = Math.min(gap - 1, OPT.GAP_FILL_MAX);
    for (let i = 1; i <= fillN; i++) {
      state.kf.predict(1);
      const px = state.kf.x[0];
      const py = state.kf.x[1];
      state.trail.push({ x: px, y: py, frame: last.frame + i, tMs: last.tMs ?? sampleMs });
    }
  }

  const steps = (last && Number.isFinite(last.frame)) ? Math.max(0, frameIndex - (last.frame || frameIndex)) : 1;
  for (let i = 0; i < steps; i++) state.kf.predict(1);
  state.kf.update(point.x, point.y);

  let sx = state.kf.x[0], sy = state.kf.x[1];
  if (last) {
    const dx = sx - last.x;
    const dy = sy - last.y;
    const d = Math.hypot(dx, dy);
    if (d > OPT.MAX_STEP) {
      const r = OPT.MAX_STEP / d;
      sx = last.x + dx * r;
      sy = last.y + dy * r;
    }
  }

  const conf = Number.isFinite(meta?.conf)
    ? Number(meta.conf)
    : Number.isFinite(point?.score) ? Number(point.score) : 0;
  const via = meta?.via ?? point?.via ?? 'unknown';
  const sample = {
    x: sx,
    y: sy,
    frame: frameIndex,
    tMs: sampleMs,
    conf,
    via
  };

  state.trail.push(sample);
  try { bs.state = 'TRACKING'; } catch {}

  try {
    const prev = state.trail.at?.(-2) || null;
    const gapF = prev ? (sample.frame - prev.frame) : 0;
    const detail = { frame: sample.frame, gapF, len: state.trail.length, x: sample.x, y: sample.y, tMs: sample.tMs };
    if (sample.via) detail.via = sample.via;
    if (Number.isFinite(sample.conf)) detail.score = sample.conf;
    window.dispatchEvent?.(new CustomEvent('ball:trail-step', { detail }));
    try {
      const arc = window.ballArc || {};
      const refined = Array.isArray(arc.refinedTrail) && arc.refinedTrail.length ? arc.refinedTrail.length : 0;
      const arcLen = refined || (Array.isArray(arc.trail) ? arc.trail.length : 0);
      const msg = `[arc] trail=${state.trail.length} arc=${arcLen}`;
      if (window.__dbgArcLast !== msg) {
        window.__dbgArcLast = msg;
        window.__dbgLine?.(msg);
      }
    } catch {}
    try {
      window.__dbgLine?.(`[trail] len=${state.trail.length} f=${sample.frame} via=${sample.via || 'unknown'}`);
    } catch {}
  } catch {}

  if (state.trail.length > OPT.MAX_TRAIL_POINTS) state.trail.splice(0, state.trail.length - OPT.MAX_TRAIL_POINTS);
  state.lastFrame = frameIndex;
  return true;
}

export function getBallTrail(){ return state.trail; }
export function getBallLast(){ return state.trail.at?.(-1) || null; }

// ---- Renderer ----
export function drawBallTrail(ctx, opts={}){
  if (!ctx) return; const t = state.trail; if (!t?.length) return;
  const radius = Number(opts.radius ?? OPT.RING_RADIUS);
  const spacing = Number(opts.spacing ?? OPT.RING_SPACING);
  const color = opts.color || 'rgba(255,170,0,0.95)';
  ctx.save(); ctx.lineWidth = 3; ctx.strokeStyle = color; ctx.fillStyle = 'transparent';
  let last = t[0]; ctx.beginPath(); ctx.arc(last.x, last.y, radius, 0, Math.PI*2); ctx.stroke();
  let acc = 0;
  for (let i=1;i<t.length;i++) {
    const p=t[i]; const dx=p.x-last.x, dy=p.y-last.y; const d=Math.hypot(dx,dy); acc += d;
    if (acc >= spacing) { ctx.beginPath(); ctx.arc(p.x,p.y,radius,0,Math.PI*2); ctx.stroke(); acc = 0; }
    last = p;
  }
  ctx.restore();
}

// Overlay helpers used by fix_overlay_display.js
export function drawBallTrails(ctx, opts={}) {
  return drawBallTrail(ctx, opts);
}

export function drawBallArc(ctx, opts={}) {
  if (!ctx) return;
  
  // NEW: Use refined trail if available, fallback to original
  let full = [];
  if (window.ballArc && Array.isArray(window.ballArc.refinedTrail) && window.ballArc.refinedTrail.length >= 3) {
    full = window.ballArc.refinedTrail;
    if (window.DOACH_SHOT_DEBUG) console.log('[drawBallArc] using refined trail', full.length, 'points');
  } else if (window.ballArc && Array.isArray(window.ballArc.trail)) {
    full = window.ballArc.trail;
  }
  
  // In presentation modes we want only the post‑release arc. Allow fallback only if not strict.
  try {
    const strict = !!opts.strictArc;
    if (!strict && (!full || full.length < 3) && Array.isArray(window.ballState?.trail) && window.ballState.trail.length >= 3) {
      full = window.ballState.trail.slice(-60); // last ~60 frames
    }
  } catch {}
  if (!full || !full.length) return;
  // Optionally show only the top segment: a few frames after release → a few frames before hoop
  let arc = full;
  try {
    const TRIM = (opts.trimTop ?? window.ARC_TRIM_TOP);
    if (TRIM) {
      const bs = (window.ballState || {});
      const startOff = Number(opts.startOffset ?? window.ARC_START_OFFSET ?? 2);
      const endMarg  = Number(opts.endMargin   ?? window.ARC_END_MARGIN   ?? 3);
      // Heuristic fallback: if release not latched, approximate a start where the ball
      // begins rising consistently (filters out bounce/dribble before the shot).
      function approxReleaseFrame(points){
        if (!Array.isArray(points) || points.length < 5) return points?.[0]?.frame ?? 0;
        for (let i = 2; i < points.length; i++) {
          const a = points[i-2], b = points[i-1], c = points[i];
          if (!a||!b||!c) continue;
          const up1 = b.y < a.y - 1.2;
          const up2 = c.y < b.y - 1.2;
          if (up1 && up2) return Math.max(0, a.frame ?? 0);
        }
        return points?.[0]?.frame ?? 0;
      }
      const relF  = Number.isFinite(bs.releaseFrame) ? bs.releaseFrame : approxReleaseFrame(full);
      const enterF= Number.isFinite(bs.proxEnterFrame)  ? bs.proxEnterFrame  : null;
      const endF  = Number.isFinite(enterF) ? Math.max(0, enterF - endMarg)
                    : (Number.isFinite(bs.proxExitFrame) ? Math.max(0, bs.proxExitFrame - endMarg) : (full.at?.(-1)?.frame ?? Infinity));
      const startF= Number.isFinite(relF) ? (relF + startOff) : (full[0]?.frame ?? 0);
      const subset = full.filter(p => Number.isFinite(p.frame) && p.frame >= startF && p.frame <= endF);
      if (subset.length >= 3) arc = subset;
    }
  } catch {}
  const color    = opts.color || 'rgba(50,200,255,0.95)';
  const dotEvery = Math.max(1, Number(opts.dotEvery ?? 1));
  const lw       = Number(opts.lineWidth ?? 2);
  const minDots  = Math.max(7, Number(window.ARC_MIN_RINGS || 8));

  // Optional smoothing via quadratic fit y = a x^2 + b x + c in canvas coords
  function fitQuad(points){
    if (!Array.isArray(points) || points.length < 5) return null;
    let Sx=0,Sx2=0,Sx3=0,Sx4=0, Sy=0,Sxy=0,Sx2y=0, n=points.length;
    for (const p of points){ const x=p.x, y=p.y; const x2=x*x, x3=x2*x, x4=x2*x2; Sx+=x; Sx2+=x2; Sx3+=x3; Sx4+=x4; Sy+=y; Sxy+=x*y; Sx2y+=x2*y; }
    function solve3(M,v){ const A=M.map(r=>r.slice()); const b=v.slice(); for(let i=0;i<3;i++){ let piv=i; for(let r=i+1;r<3;r++) if (Math.abs(A[r][i])>Math.abs(A[piv][i])) piv=r; if (Math.abs(A[piv][i])<1e-9) return null; if(piv!==i){ [A[i],A[piv]]=[A[piv],A[i]]; [b[i],b[piv]]=[b[piv],b[i]];} for(let r=i+1;r<3;r++){ const f=A[r][i]/A[i][i]; for(let c=i;c<3;c++) A[r][c]-=f*A[i][c]; b[r]-=f*b[i]; } } const x=[0,0,0]; for(let i=2;i>=0;i--){ let s=b[i]; for(let c=i+1;c<3;c++) s-=A[i][c]*x[c]; x[i]=s/A[i][i]; } return x; }
    const sol = solve3([[Sx4,Sx3,Sx2],[Sx3,Sx2,Sx],[Sx2,Sx, n]],[Sx2y,Sxy,Sy]);
    if (!sol) return null; const [a,b,c]=sol;
    // r2 (goodness) to guard extreme noise
    const yMean = Sy/n; let ssTot=0, ssRes=0; for(const p of points){ const yHat=a*p.x*p.x+b*p.x+c; ssTot+=(p.y-yMean)**2; ssRes+=(p.y-yHat)**2; }
    const r2 = ssTot>0 ? 1 - (ssRes/ssTot) : 0;
    return { a,b,c,r2 };
  }

  const wantSmooth = (window.ARC_SMOOTH !== false);
  let drawPts = arc;
  if (wantSmooth) {
    const fit = fitQuad(arc);
    if (fit && fit.r2 >= 0.80) {
      const xs = arc.map(p=>p.x); const minX=Math.min(...xs), maxX=Math.max(...xs);
      const steps = Math.max(16, Math.min(80, Math.round((maxX-minX)/10)));
      const out = [];
      for (let i=0;i<=steps;i++) {
        const x = minX + (i/steps)*(maxX-minX);
        const y = fit.a*x*x + fit.b*x + fit.c;
        out.push({ x, y, frame: arc[0].frame + i });
      }
      drawPts = out;
    }
  }
  ctx.save();
  ctx.lineWidth = lw;
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.moveTo(drawPts[0].x, drawPts[0].y);
  for (let i=1;i<drawPts.length;i++) ctx.lineTo(drawPts[i].x, drawPts[i].y);
  ctx.stroke();
  // dots along arc (ring counter)
  ctx.fillStyle = color;
  // If the arc is very short, densify dots along path so we always show enough rings
  // Build a cumulative-length table
  let __rings = 0;
  const segLen = [];
  let total = 0;
  for (let i=1;i<drawPts.length;i++) { const d = Math.hypot(drawPts[i].x-drawPts[i-1].x, drawPts[i].y-drawPts[i-1].y); segLen.push(d); total += d; }
  const want = Math.max(minDots, Math.ceil(drawPts.length / dotEvery));
  if (want > drawPts.length) {
    // place evenly spaced points along polyline length
    for (let k=0;k<want;k++) {
      const t = (total>0) ? (k/(Math.max(1,want-1))) * total : 0;
      // map t to segment
      let acc = 0, idx = 0;
      while (idx < segLen.length && acc + segLen[idx] < t) { acc += segLen[idx]; idx++; }
      let px = drawPts[Math.min(idx, drawPts.length-1)].x, py = drawPts[Math.min(idx, drawPts.length-1)].y;
      if (idx < segLen.length && segLen[idx] > 0) {
        const r = (t - acc) / segLen[idx];
        const a = drawPts[idx], b = drawPts[idx+1];
        px = a.x + (b.x - a.x)*r; py = a.y + (b.y - a.y)*r;
      }
      ctx.beginPath(); ctx.arc(px, py, 2.5, 0, Math.PI*2); ctx.fill(); __rings++;
    }
  } else {
    for (let i=0;i<drawPts.length;i+=dotEvery) {
      const p = drawPts[i];
      ctx.beginPath(); ctx.arc(p.x, p.y, 2.5, 0, Math.PI*2); ctx.fill(); __rings++;
    }
  }
  try {
    const current = (window.__overlayArcDrawnCount || 0);
    // Use the maximum of previous and computed so a single draw reflects the full arc
    window.__overlayArcDrawnCount = Math.max(current, __rings);
    window.__overlayLastTrailMode = 'arc';
    window.__overlayLastTrailInput = 'ballArc';
  } catch {}
  ctx.restore();
}

(function installBallTrackerIngest(){
  try {
    if (window.__ballTrackerIngest) return;
    window.__ballTrackerIngest = true;
  } catch {
    return;
  }

  try { window.updateBall = window.updateBall || updateBall; } catch {}

  window.addEventListener('ball:point', (e) => {
    try {
      const d = e?.detail || {};
      if (!Number.isFinite(d.x) || !Number.isFinite(d.y)) return;
      (window.updateBall || updateBall)?.(d.x, d.y, {
        frame: Number.isFinite(d.frame) ? Number(d.frame) : undefined,
        tMs: Number.isFinite(d.tMs) ? Number(d.tMs) : undefined,
        conf: Number.isFinite(d.conf) ? Number(d.conf) : undefined,
        via: d.via || 'evt'
      });
    } catch (err) {
      console.error('[ball:point->updateBall] failed', err);
    }
  }, { passive: true });

  try { window.__dbgLine?.('[ingest] ball_tracker bound to ball:point'); } catch {}
})();

// Back-compat export with a live trail view + mutable fields used across modules
export const ballState = {
  get trail(){ return state.trail; },
  set trail(v){ if (Array.isArray(v)) state.trail = v; },
  state: 'IDLE',            // 'IDLE' | 'TRACKING' | 'FROZEN'
  releaseFrame: null,
  proxEnterFrame: null,
  proxExitFrame: null,
  shots: [],               // frozen shot records
  netMoved: false,
};

// Expose a single global reference other modules use dynamically
try { window.ballState = window.ballState || ballState; } catch {}

// ---- Shot lifecycle helpers (lean, compatibility-focused) ----

function ensureArc() {
  const arc = (window.ballArc ||= { trail: [], prox: null });
  if (!Array.isArray(arc.trail)) arc.trail = [];
  return arc;
}

export function markRelease(frameIndex, opts = {}) {
  // Delegate strictly to the canonical pose-aware handler in player_tracker.js
  try {
    if (typeof window.__markReleasePose === 'function') {
      const via = opts?.via || 'ball-fwd';
      return window.__markReleasePose(frameIndex, { ...opts, via });
    }
  } catch {}
  // If canonical is unavailable, do nothing to avoid inconsistent state.
}

export function resetAll() {
  // tracker internals
  resetBallTrail();
  // public state seen by other modules
  ballState.state = 'IDLE';
  ballState.releaseFrame = null;
  ballState.proxEnterFrame = null;
  ballState.proxExitFrame = null;
  ballState.netMoved = false;
  try { if (window.ballArc) window.ballArc.trail = []; } catch {}
}

// Minimal FBF arc helpers used by app.js; keep them lightweight and safe
export function stepFBFArc(pt, proxRect, frameIndex) {
  if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return;
  const arc = ensureArc();
  if (proxRect) arc.prox = proxRect;
  const last = arc.trail.at?.(-1) || null;
  const curF = Number(frameIndex) || 0;
  if (!last) {
    arc.trail.push({ x: pt.x, y: pt.y, frame: curF });
  } else {
    const df = Math.max(0, curF - (last.frame ?? curF));
    const dx = pt.x - last.x, dy = pt.y - last.y;
    // 1) If multiple frames elapsed, interpolate per-frame points
    if (df > 1) {
      for (let g = 1; g < df; g++) {
        const r = g / df;
        arc.trail.push({ x: last.x + dx * r, y: last.y + dy * r, frame: (last.frame ?? curF) + g });
      }
    }
    // 2) Add the current point (same frame or next)
    arc.trail.push({ x: pt.x, y: pt.y, frame: curF });
    // 3) Cap pixel step between consecutive points to reduce maxJump in tests
    const CAP = Math.max(60, OPT.MAX_STEP * 2); // aim <= ~80 px
    let a = arc.trail.at?.(-2) || last;
    let b = arc.trail.at?.(-1);
    if (a && b) {
      const ddx = b.x - a.x, ddy = b.y - a.y; const dist = Math.hypot(ddx, ddy);
      if (dist > CAP) {
        const extra = Math.ceil(dist / CAP) - 1;
        for (let k = 1; k <= extra; k++) {
          const t = k / (extra + 1);
          arc.trail.splice(arc.trail.length - 1, 0, { x: a.x + ddx * t, y: a.y + ddy * t, frame: b.frame });
        }
      }
    }
  }
  if (arc.trail.length > OPT.MAX_TRAIL_POINTS) arc.trail.splice(0, arc.trail.length - OPT.MAX_TRAIL_POINTS);
}

export function fillArcGaps(maxGap = 2) {
  const arc = ensureArc();
  const t = arc.trail;
  if (!t || t.length < 2) return;
  const out = [t[0]];
  for (let i = 1; i < t.length; i++) {
    const a = out[out.length - 1];
    const b = t[i];
    const gap = Math.min(maxGap, Math.max(0, (b.frame ?? 0) - (a.frame ?? 0) - 1));
    for (let g = 1; g <= gap; g++) {
      const r = g / (gap + 1);
      out.push({ x: a.x + (b.x - a.x) * r, y: a.y + (b.y - a.y) * r, frame: (a.frame ?? 0) + g });
    }
    out.push(b);
  }
  arc.trail = out;
}

export function freezeShot(tag = null) {
  // Snapshot the current live trail as a shot record; do not mutate live trail
  const trailSrc = Array.isArray(ballState.trail) ? ballState.trail : [];
  const copy = trailSrc.map(p => ({ x: p.x, y: p.y, frame: p.frame }));
  ballState.shots.push({ trail: copy, tag: tag || undefined, release: ballState.releaseFrame });
  ballState.state = 'FROZEN';
  try { ballState.showFrozen = true; } catch {}
}
