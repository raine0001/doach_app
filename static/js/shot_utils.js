// shot_utils.js, Cleaned 8-11-25 dr, scoring logic and geometric helpers

/**
 * Estimate the initial release angle from the first few trail points.
 * Returns a 0–90 degree angle relative to the horizontal.
 *
 * opts.window: how many frames from the start to use (default 6)
 */
export function estimateReleaseAngle(trail, opts = {}) {
  const W = Math.max(2, Math.min(opts.window ?? 6, trail?.length ?? 0));
  if (!trail || trail.length < 2) return 0;

  // Use the first W points (from release)
  const n = Math.min(W, trail.length);
  let sumDx = 0, sumDyUp = 0; // DyUp: positive when going upward on screen

  for (let i = 1; i < n; i++) {
    const a = trail[i - 1], b = trail[i];
    sumDx   += (b.x - a.x);
    sumDyUp += (a.y - b.y);   // canvas Y increases downward → flip so "up" is positive
  }

  // Average direction vector
  const dx = sumDx / (n - 1);
  const dy = sumDyUp / (n - 1);

  // Angle relative to horizontal; ignore left/right sign
  const angleRad = Math.atan2(Math.max(0, dy), Math.abs(dx) + 1e-6);
  const deg = Math.max(0, Math.min(90, Math.round(angleRad * 180 / Math.PI)));
  return deg;
}

/**
 * Fit y ≈ a x^2 + b x + c to the (x,y) trail in *canvas* coords (y downward).
 * Returns apex, entryAngle (0–90°), curve coeffs, and R².
 *
 * opts.cutTail: drop this many points from the end before fitting (default 0)
 * opts.maxPoints: subsample to at most this many points (default: use all)
 * opts.robust: if true, refit after trimming the worst 20% residuals (default false)
 * opts.entryWindow: how many last frames to average for entry angle (default 4)
 */
export function fitTrajectory(trail, opts = {}) {
  if (!trail || trail.length < 5) return null;

  const cutTail = Math.max(0, opts.cutTail ?? 0);
  const entryWindow = Math.max(2, Math.min(opts.entryWindow ?? 4, trail.length - 1));
  const maxPoints = Math.max(5, opts.maxPoints ?? trail.length);

  // 1) Choose points to fit (optionally drop noisy tail and subsample)
  let pts = trail.slice(0, trail.length - cutTail || trail.length);
  if (pts.length < 5) return null;
  if (pts.length > maxPoints) {
    // even subsample
    const step = pts.length / maxPoints;
    const pick = [];
    for (let i = 0; i < pts.length; i += step) pick.push(pts[Math.floor(i)]);
    pts = pick;
  }

  // Internal: solve normal equations for quadratic via 3x3 Gaussian elimination
  function solveQuadraticLS(points) {
    let Sx=0,Sx2=0,Sx3=0,Sx4=0, Sy=0,Sxy=0,Sx2y=0, n=points.length;
    for (const p of points) {
      const x = p.x, y = p.y;
      const x2 = x*x, x3 = x2*x, x4 = x2*x2;
      Sx+=x; Sx2+=x2; Sx3+=x3; Sx4+=x4;
      Sy+=y; Sxy+=x*y; Sx2y+=x2*y;
    }
    // M * [a,b,c]^T = v
    const M = [
      [Sx4, Sx3, Sx2],
      [Sx3, Sx2, Sx ],
      [Sx2, Sx , n  ],
    ];
    const v = [Sx2y, Sxy, Sy];

    const sol = solve3x3(M, v);
    if (!sol) return null;
    const [a, b, c] = sol;

    // compute R^2
    const yMean = Sy / n;
    let ssTot = 0, ssRes = 0;
    for (const p of points) {
      const yHat = a*p.x*p.x + b*p.x + c;
      ssTot += (p.y - yMean) ** 2;
      ssRes += (p.y - yHat) ** 2;
    }
    const r2 = ssTot > 0 ? 1 - (ssRes / ssTot) : 0;

    return { a, b, c, r2 };
  }

  function solve3x3(M, v) {
    // naive Gaussian elimination with partial pivoting
    const A = M.map(row => row.slice());
    const b = v.slice();
    const N = 3;

    for (let i = 0; i < N; i++) {
      // pivot
      let piv = i;
      for (let r = i+1; r < N; r++) if (Math.abs(A[r][i]) > Math.abs(A[piv][i])) piv = r;
      if (Math.abs(A[piv][i]) < 1e-9) return null;
      if (piv !== i) { [A[i], A[piv]] = [A[piv], A[i]]; [b[i], b[piv]] = [b[piv], b[i]]; }
      // eliminate
      for (let r = i+1; r < N; r++) {
        const f = A[r][i] / A[i][i];
        for (let c = i; c < N; c++) A[r][c] -= f * A[i][c];
        b[r] -= f * b[i];
      }
    }
    // back-substitute
    const x = new Array(N).fill(0);
    for (let i = N-1; i >= 0; i--) {
      let s = b[i];
      for (let c = i+1; c < N; c++) s -= A[i][c] * x[c];
      x[i] = s / A[i][i];
    }
    return x;
  }

  // 2) Fit once
  let fit = solveQuadraticLS(pts);
  if (!fit) return null;

  // 3) Optionally robustify: drop the worst 20% residuals and refit
  if (opts.robust) {
    const { a, b, c } = fit;
    const withRes = pts.map(p => {
      const yHat = a*p.x*p.x + b*p.x + c;
      return { p, r: Math.abs(p.y - yHat) };
    }).sort((u, v) => u.r - v.r);
    const keep = withRes.slice(0, Math.max(5, Math.floor(withRes.length * 0.8))).map(o => o.p);
    fit = solveQuadraticLS(keep) || fit; // fall back to previous fit if degenerate
  }

  const { a, b, c, r2 } = fit;
  if (Math.abs(a) < 1e-9) return { apex: null, entryAngle: 0, curve: { a, b, c }, r2 };

  // Canvas coordinates: y increases downward, so typical arcs give a > 0.
  // Apex at derivative = 0 → x* = -b / (2a)
  const apexX = -b / (2 * a);
  const apexY = a*apexX*apexX + b*apexX + c;

  // Entry angle: average last few segments to reduce noise (0–90°)
  let sumDx = 0, sumDy = 0;
  for (let i = trail.length - entryWindow; i < trail.length; i++) {
    const p0 = trail[i - 1], p1 = trail[i];
    sumDx += (p1.x - p0.x);
    sumDy += (p1.y - p0.y);  // canvas down is positive; angle magnitude only
  }
  const dx = sumDx / entryWindow;
  const dy = sumDy / entryWindow;
  const angleRad = Math.atan2(Math.abs(dy), Math.abs(dx) + 1e-6);
  const entryAngle = Math.round(Math.min(90, Math.max(0, angleRad * 180 / Math.PI)));

  return {
    apex: { x: apexX, y: apexY },
    entryAngle,
    curve: { a, b, c },
    r2
  };
}


/**
 * Is point `center` inside the hoop region?
 * Accepts hoop boxes where x,y are either CENTER or TOP-LEFT. We normalize to center.
 *
 * opts.xHalf  — horizontal half-width of region (default: hw * 0.5)
 * opts.yAbove — how far ABOVE rim center to include (default: hh)
 * opts.yBelow — how far BELOW rim center to include (default: hh * 0.5)
 */
export function inHoopRegion(center, hoopBox, opts = {}) {
  if (!center || !hoopBox) return false;
  const H = toCenterHoop(hoopBox); // { cx, cy, w, h }

  const xHalf  = opts.xHalf  ?? H.w * 0.5;  // matches your previous hw
  const yAbove = opts.yAbove ?? H.h * 1.0;  // same as old "hy - hh"
  const yBelow = opts.yBelow ?? H.h * 0.5;  // same as old "hy + 0.5*hh"

  const x1 = H.cx - xHalf, x2 = H.cx + xHalf;
  const y1 = H.cy - yAbove, y2 = H.cy + yBelow;

  const x = center.x, y = center.y;
  return x > x1 && x < x2 && y > y1 && y < y2;
}

/** Normalize any hoop box to center-based coords. */
function toCenterHoop(hoopBox) {
  const w = Math.max(1, hoopBox.w || 0);
  const h = Math.max(1, hoopBox.h || 0);

  // If the object explicitly provides a center, use it
  if (hoopBox.cx != null && hoopBox.cy != null) {
    return { cx: hoopBox.cx, cy: hoopBox.cy, w, h };
  }

  // Hints that x,y are top-left
  const isTopLeft =
    hoopBox.anchor === 'topleft' ||
    hoopBox.leftTop === true ||
    hoopBox.isLeftTop === true;

  if (isTopLeft) {
    return { cx: hoopBox.x + w / 2, cy: hoopBox.y + h / 2, w, h };
  }

  // Default: treat x,y as CENTER (this matches most of your other code paths)
  return { cx: hoopBox.x, cy: hoopBox.y, w, h };
}


export function score(ballTrail, hoopBox, netMotionDetected = null) {
  return evaluateShotByRegionsV2(ballTrail, hoopBox, netMotionDetected);
}

// Narrow “tube” under rim and robust crossing tests (center-safe, apex-aware)
export function evaluateShotByRegionsV2(trail, hoopBox, netMotion = null, opts = {}) {
  if (!trail || trail.length < 5 || !hoopBox) {
    return { made: false, reason: 'Invalid input', entryAngle: 0 };
  }

  // --- Normalize hoop to center coords ---
  const H = centerHoop(hoopBox); // { cx, cy, w, h }
  const rimY = H.cy;             // rim line ~ vertical center

  // --- Tunables (safe defaults) ---
  const xTolMult     = opts.xTolMult ?? 1.1;        // widen center lane a bit
  const tubeRatio    = opts.tubeRatio ?? 0.18;      // tube half-width = w * ratio
  const netRatio     = opts.netRatio  ?? 0.33;      // net band half-width
  const riseMargin   = opts.riseMargin ?? 8;        // must rise above rim by this many px
  const lingerNeed   = Math.max(3, opts.lingerNeed ?? 3);
  const entryWindow  = Math.max(2, Math.min(opts.entryWindow ?? 4, trail.length - 1));
  const smallUpTol   = opts.smallUpTol ?? 1.5;      // allow tiny upwards deltas while “descending”

  const tubeHalf = Math.max(12, Math.round(H.w * tubeRatio));
  const netHalf  = Math.max(26, Math.round(H.w * netRatio));
  const xTol     = Math.max(55, H.w * xTolMult);

  const tubeX1 = H.cx - tubeHalf, tubeX2 = H.cx + tubeHalf;
  const netX1  = H.cx - netHalf,  netX2  = H.cx + netHalf;

  const netYTop = rimY;                              // start of net band
  const netYBot = H.cy + Math.max(48, Math.round(H.h * 1.2)); // bottom of net band

  // --- 0) Apex must be above rim line ---
  const apexIdx = indexOfMinY(trail);
  const apexY   = trail[apexIdx].y;
  if (apexY >= rimY - riseMargin) {
    return { made: false, reason: 'Did not rise above rim', entryAngle: 0 };
  }

  // --- 1) First rim cross *after* apex, and near the center lane ---
  const cross = firstRimCrossAfter(trail, apexIdx, rimY, H.cx, xTol);
  if (!cross) {
    return { made: false, reason: 'No rim crossing', entryAngle: 0 };
  }
  const { idx: crossIdx, xAt } = cross;

  // Prefer tube lane, but allow net band fallback
  const nearTube = (xAt >= tubeX1 && xAt <= tubeX2);
  const nearNet  = (xAt >= netX1  && xAt <= netX2);
  if (!nearTube && !nearNet) {
    return { made: false, reason: 'Rim cross too far from center', entryAngle: 0 };
  }

  // --- 2) Linger/run descending inside net band for a few frames (post-cross only) ---
  const lingerOK = consecutiveInRectDesc(
    trail, crossIdx, netX1, netYTop, netX2, netYBot, lingerNeed, smallUpTol
  );
  if (!lingerOK) {
    return { made: false, reason: 'Did not descend through net region', entryAngle: 0 };
  }

  // --- 3) Optional net motion confirmation (if we explicitly know it’s false, fail) ---
  if (netMotion === false) {
    return { made: false, reason: 'No net movement detected', entryAngle: 0 };
  }

  // --- 4) Entry angle: average last few segments (0–90°) for stability ---
  let sumDx = 0, sumDy = 0;
  for (let i = trail.length - entryWindow; i < trail.length; i++) {
    const a = trail[i - 1], b = trail[i];
    sumDx += (b.x - a.x);
    sumDy += (b.y - a.y); // canvas down positive; we use magnitude
  }
  const dx = sumDx / entryWindow;
  const dy = sumDy / entryWindow;
  const entryAngle = Math.round(Math.min(90, Math.max(0, Math.atan2(Math.abs(dy), Math.abs(dx) + 1e-6) * 180 / Math.PI)));

  return {
    made: true,
    reason: 'Valid arc, rim cross, net descent' + (netMotion ? ' + net motion' : ''),
    entryAngle
  };

  // ---------- helpers ----------
  function centerHoop(hoop) {
    const w = Math.max(1, hoop.w || 0), h = Math.max(1, hoop.h || 0);
    if (hoop.cx != null && hoop.cy != null) return { cx: hoop.cx, cy: hoop.cy, w, h };
    // heuristic: default treat x,y as CENTER (matches the rest of your pipeline)
    // if you KNOW x,y are top-left, pass { anchor: 'topleft' } in hoopBox and switch:
    if (hoop.anchor === 'topleft') return { cx: hoop.x + w / 2, cy: hoop.y + h / 2, w, h };
    return { cx: hoop.x, cy: hoop.y, w, h };
  }

  function indexOfMinY(arr) {
    let idx = 0, y = arr[0].y;
    for (let i = 1; i < arr.length; i++) if (arr[i].y < y) { y = arr[i].y; idx = i; }
    return idx;
  }

  // Find first crossing of y = rimY after `startIdx`, descending through the rim,
  // and return interpolated xAt at the crossing point. Require near-center horizontally (xTol).
  function firstRimCrossAfter(tr, startIdx, yLine, cx, xTol) {
    for (let i = Math.max(1, startIdx + 1); i < tr.length; i++) {
      const p0 = tr[i - 1], p1 = tr[i];
      const descending = (p1.y - p0.y) > 0;
      const spans = (p0.y <= yLine && p1.y > yLine); // cross from above to below
      if (!descending || !spans) continue;
      const t = (yLine - p0.y) / (p1.y - p0.y);      // 0..1
      const xAt = p0.x + (p1.x - p0.x) * t;
      if (Math.abs(xAt - cx) <= xTol) return { idx: i, xAt };
    }
    return null;
  }

  // count consecutive frames inside rect (x1..x2, y1..y2) AFTER index `fromIdx`
  // while largely descending (allow tiny up-ticks up to smallUpTol).
  function consecutiveInRectDesc(tr, fromIdx, x1, y1, x2, y2, need, smallUpTol) {
    let run = 0, best = 0;
    for (let i = Math.max(fromIdx + 1, 1); i < tr.length; i++) {
      const p0 = tr[i - 1], p1 = tr[i];
      const inside = (p1.x >= x1 && p1.x <= x2 && p1.y >= y1 && p1.y <= y2);
      const dy = p1.y - p0.y;
      const descendingOrFlat = dy >= -smallUpTol;
      if (inside && descendingOrFlat) { run++; best = Math.max(best, run); }
      else { run = 0; }
      if (best >= need) return true;
    }
    return best >= need;
  }
}

// --- make the boxed hoop anchor 'center' ---
// Normalize anything (YOLO x1..x2, TL x,y,w,h, or center cx,cy,w,h) to center form.
export function canonHoop(raw = {}) {
  const w = Math.max(1, raw.w ?? raw.width ?? ((raw.x2 ?? 0) - (raw.x1 ?? 0)));
  const h = Math.max(1, raw.h ?? raw.height ?? ((raw.y2 ?? 0) - (raw.y1 ?? 0)));

  let cx, cy;
  if (raw.cx != null && raw.cy != null) {
    cx = raw.cx; cy = raw.cy; // already center
  } else if (raw.x1 != null && raw.y1 != null && raw.x2 != null && raw.y2 != null) {
    cx = raw.x1 + w/2; cy = raw.y1 + h/2; // x1,y1,x2,y2
  } else if (raw.anchor === 'topleft' || raw.leftTop || raw.topLeft || raw.isLeftTop) {
    cx = (raw.x ?? 0) + w/2; cy = (raw.y ?? 0) + h/2; // TL
  } else if (raw.x != null && raw.y != null) {
    // If someone passed x,y but meant center, accept it
    cx = raw.x; cy = raw.y;
  } else {
    cx = 0; cy = 0;
  }

  const x1 = cx - w/2, y1 = cy - h/2;
  return { cx, cy, w, h, x1, y1, x2: x1 + w, y2: y1 + h, rimY: y1 };
}

// Convert back to TL *only* when drawing or calling a TL consumer.
export function asTopLeft(H) {
  return { x: H.x1, y: H.y1, w: H.w, h: H.h };
}




// --- Net motion (single source of truth) ---
let _netState = { luma: null, w: 0, h: 0, frames: 0 };

/** Call when a new video loads or hoop is re-locked */
export function resetNetMotion() { _netState = { luma: null, w: 0, h: 0, frames: 0 }; }

/**
 * Detect net motion from a Canvas ROI below the rim.
 * Returns boolean; also usable as the 3rd arg to evaluateShotByRegionsV2.
 *
 * opts: { diffThreshold=28, movementThreshold=0.06, stride=2, heightRatio=0.6 }
 */
export function detectNetMotionFromCanvas(canvas, hoopBox, opts = {}) {
  if (!canvas || !hoopBox) return false;

  const ctx = canvas.getContext('2d');
  const w = Math.max(8, Math.round(hoopBox.w));
  const h = Math.max(8, Math.round((hoopBox.h || 40) * (opts.heightRatio ?? 0.6)));
  const x = Math.round(hoopBox.x - w / 2);
  const y = Math.round(hoopBox.y + (hoopBox.h || 40));

  // Clamp ROI inside canvas
  const cw = canvas.width, ch = canvas.height;
  const rx = Math.max(0, Math.min(cw - 1, x));
  const ry = Math.max(0, Math.min(ch - 1, y));
  const rw = Math.max(1, Math.min(cw - rx, w));
  const rh = Math.max(1, Math.min(ch - ry, h));

  const img = ctx.getImageData(rx, ry, rw, rh);
  const data = img.data;

  const stride = Math.max(1, opts.stride ?? 2);
  const diffThreshold = opts.diffThreshold ?? 28;      // luma delta
  const movementThreshold = opts.movementThreshold ?? 0.06;

  // Build current luma (down-sampled)
  const cur = new Uint8ClampedArray(Math.ceil((rw * rh) / (stride * stride)));
  let idx = 0;
  for (let yy = 0; yy < rh; yy += stride) {
    for (let xx = 0; xx < rw; xx += stride) {
      const i = (yy * rw + xx) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      // Rec.601 luma
      cur[idx++] = (0.299 * r + 0.587 * g + 0.114 * b) | 0;
    }
  }

  // Warm-up or dimension change → seed and return false
  const dimChanged = _netState.w !== rw || _netState.h !== rh || !_netState.luma || _netState.luma.length !== cur.length;
  if (dimChanged || _netState.frames < 1) {
    _netState = { luma: cur, w: rw, h: rh, frames: (_netState.frames + 1) };
    return false;
  }

  // Compare with last luma
  let moved = 0;
  for (let i = 0; i < cur.length; i++) {
    if (Math.abs(cur[i] - _netState.luma[i]) > diffThreshold) moved++;
  }
  const pct = moved / cur.length;

  // Update state
  _netState.luma = cur;
  _netState.frames++;

  if (pct > movementThreshold) {
    console.log(`🕸️ Net moved ${(pct * 100).toFixed(1)}%`);
    return true;
  }
  return false;
}

/**
 * Legacy signature support: pass an ImageData-like "mask" with .data/.width/.height.
 * Prefer detectNetMotionFromCanvas(..) in new code.
 */
export function detectNetMotion(currentMask) {
  if (!currentMask || !currentMask.data || !currentMask.width || !currentMask.height) return false;
  // Create a fake canvas-style call by constructing a temporary ImageData container.
  // Simpler: wrap its buffer in a Uint8ClampedArray and compare like above.
  // Here we just adapt to the new pipeline by making a lightweight ROI object.
  const fakeCanvas = { width: currentMask.width, height: currentMask.height, getContext: () => ({
    getImageData: () => ({ data: currentMask.data, width: currentMask.width, height: currentMask.height })
  })};
  // Minimal hoop box to satisfy ROI clipping (centered)
  const hoopBox = { x: currentMask.width / 2, y: 0, w: currentMask.width, h: Math.max(10, currentMask.height * 0.2) };
  return detectNetMotionFromCanvas(fakeCanvas, hoopBox);
}


// floating overlay on the canvas (top-center-ish near hoop)
// module scope
let lastShotSummary = null;
let summaryExpireTime = 0;
let SUMMARY_DISPLAY_MS = 2500; // default 2.5s

export function showShotSummaryOverlay(shot, hoop, ms = SUMMARY_DISPLAY_MS) {
  lastShotSummary = { shot, hoop, ms };
  summaryExpireTime = performance.now() + ms;

  // Also show the DOM HUD banner if it's present (doesn't depend on canvas redraws)
  try {
    const madeShots = window.shotLog?.filter?.(s => s.made).length ?? null;
    const totalShots = window.shotLog?.length ?? null;
    const accuracy = (madeShots != null && totalShots) ? Math.round((madeShots / totalShots) * 100) : null;
    window.showShotBanner?.({
      made: !!shot.made,
      arcHeight: shot.arcHeight,
      entryAngle: shot.entryAngle,
      releaseAngle: shot.releaseAngle,
      accuracy, madeShots, totalShots
    });
  } catch (_) { /* no-op */ }
}

// helper: place the overlay near hoop but clamp to canvas bounds
function placeBox(ctx, hoop, w, h, pad = 10) {
  const cw = ctx.canvas.width;
  const ch = ctx.canvas.height;

  // Start above-right of hoop center
  let x = (hoop?.x ?? cw * 0.5) + 20;
  let y = (hoop?.y ?? ch * 0.5) - (h + 20);

  // If no room above, move below
  if (y < pad) y = (hoop?.y ?? ch * 0.5) + 20;

  // Clamp to canvas
  if (x + w + pad > cw) x = cw - w - pad;
  if (x < pad) x = pad;
  if (y + h + pad > ch) y = ch - h - pad;
  if (y < pad) y = pad;

  return { x, y };
}

export function drawFinalShotSummary(ctx) {
  if (!ctx) return;
  if (!lastShotSummary || performance.now() > summaryExpireTime) {
    lastShotSummary = null;
    return;
  }

  const { shot, hoop } = lastShotSummary;
  if (!shot) return;

  // box metrics
  const W = 240;
  // height depends on whether we show the miss reason
  const showReason = !shot.made && shot.missReason;
  const H = showReason ? 125 : 105;

  const { x, y } = placeBox(ctx, hoop, W, H, 12);

  ctx.save();

  // background
  ctx.globalAlpha = 1;
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.fillRect(x - 10, y - 10, W + 20, H + 20);

  // border + slight glow for readability
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = 2;
  ctx.strokeRect(x - 10, y - 10, W + 20, H + 20);

  // text
  ctx.fillStyle = shot.made ? 'lime' : 'red';
  ctx.font = 'bold 14px system-ui, -apple-system, Segoe UI, sans-serif';
  ctx.fillText(`${shot.made ? '✅ Made Shot' : '❌ Missed Shot'}`, x, y + 2);

  ctx.fillStyle = 'white';
  ctx.font = '12px system-ui, -apple-system, Segoe UI, sans-serif';
  ctx.fillText(`Arc Height: ${Math.round(shot.arcHeight || 0)}px`, x, y + 22);
  ctx.fillText(`Entry Angle: ${shot.entryAngle ?? '–'}°`,          x, y + 38);
  ctx.fillText(`Release Angle: ${shot.releaseAngle ?? '–'}°`,       x, y + 54);

  if (showReason) {
    ctx.fillStyle = 'orange';
    ctx.fillText(`Reason: ${shot.missReason}`, x, y + 74);
  }

  ctx.restore();
}




