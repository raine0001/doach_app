// ball_tracker.js — clean lifecycle + trail
import { isBallInProximityZone } from './shot_logger.js';

// ---- Config ----
const MAX_FRAMES_TO_PROX = 40;   // frames after release before we give up
const MAX_LIVE_TAIL      = 120;  // hard cap so trail never explodes
const GAP_FILL_MAX       = 3;    // interpolate ≤3 frame holes
const MIN_FREEZE_LEN     = 6;    // don’t freeze if comically short
const PRE_ROLL_FRAMES    = 0;    // add for a little pre-roll
const JUMP_PX_LIMIT_1    = 700;  // early path
const JUMP_PX_LIMIT_2    = 1500; // later path
const PRE_BUFFER_SIZE    = 90;   // frames
const MIN_UP_RUN         = 3;    // need 3 upward frames to call it a release
let preTrail = [];

// ---- State machine ----
const State = Object.freeze({
  IDLE: 'IDLE',           // nothing armed
  ARMING: 'ARMING',       // ball in proximity before release
  TRACKING: 'TRACKING',   // released; building trail
  FINALIZING: 'FINALIZING',// exiting proximity, wrap up
  FROZEN: 'FROZEN',       // last shot frozen (until next release)
  REVIEW: { active: false, idx: -1 },
});

// ---- API to control review ----
export function reviewStart(idx = ballState.shots.length - 1) {
  if (!ballState.shots.length) return false;
  ballState.review.active = true;
  ballState.review.idx = Math.max(0, Math.min(idx, ballState.shots.length - 1));
  return true;
}
export function reviewStop() {
  ballState.review.active = false;
  ballState.review.idx = -1;
}
export function reviewNext(delta = 1) {
  if (!ballState.review.active || !ballState.shots.length) return;
  const n = ballState.shots.length;
  ballState.review.idx = (ballState.review.idx + delta + n) % n;
}
export function getShotCount()       { return ballState.shots.length; }
export function getReviewIndex()     { return ballState.review.idx;  }
export function getReviewedShot()    { return ballState.review.active ? ballState.shots[ballState.review.idx] : null; }

export const ballState = {
   f: 0,
   state: State.IDLE,
   hoop: null,
   trail: [],
   shots: [],
   releaseFrame: null,
   proxEnterFrame: null,
   proxExitFrame: null,
  // render control: show last frozen arc until next release
  showFrozen: false,
  review: { active: false, idx: -1 },
 };

// ---------- public API ----------
export function resetAll() {
  ballState.state = State.IDLE;
  ballState.trail = [];
  ballState.shots = [];
  ballState.releaseFrame = null;
  ballState.proxEnterFrame = null;
  ballState.proxExitFrame = null;
  ballState.hoop = null;
  ballState.f = 0;
  ballState.showFrozen = false;
}

export function attachHoop(hoopLocked) {
  // expects {x,y,w,h}; x,y = LEFT/TOP
  if (!hoopLocked) return;
  ballState.hoop = { ...hoopLocked };
}

export function markRelease(frame) {
  // estimate release inside the pre-buffer (ball started moving upward)
  const startIdx = estimateReleaseIdx(preTrail);
  const seed = preTrail.slice(startIdx);

  // Ignore duplicate release while already tracking this shot
  if (ballState.state === State.TRACKING && ballState.releaseFrame != null) {
    if (frame - ballState.releaseFrame <= 120) {
      log('⏩ markRelease ignored (already tracking this shot)');
      return;
    }
  }

  ballState.state = State.TRACKING;

  ballState.trail = seed.length ? seed.map(p => ({ ...p })) : [];
  ballState.releaseFrame = seed[0]?.frame ?? frame;
  ballState.proxEnterFrame = null;
  ballState.proxExitFrame = null;
  preTrail.length = 0; // consumed
  log('🎬 Release @', ballState.releaseFrame, `(seed=${seed.length})`);
  ballState.showFrozen = false;
}


// identify when ball enters proximity of the next to account for a shot attempt
export function enterProximity(frame) {
  // called when point enters proximity zone
  if (ballState.state === State.TRACKING || ballState.state === State.ARMING) {
    if (ballState.proxEnterFrame == null) {
      ballState.proxEnterFrame = frame;
      log('🟩 Proximity ENTER @', frame);
    }
    // If we never started the shot yet, start it now (will seed from preTrail)
    if (ballState.state === State.ARMING) markRelease(frame);
  }
}

export function exitProximity(frame) {
  // called when point exits proximity zone
  if (ballState.state === State.TRACKING) {
    ballState.proxExitFrame = frame;
    ballState.state = State.FINALIZING;
    log('🟥 Proximity EXIT @', frame);
    // freeze on next update tick (so last point is appended)
  }
}


// Save only complete shots
export function freezeShot(made = null) {
  if (ballState.trail.length < MIN_FREEZE_LEN) return;
  // only save if we have both proximity enter & exit
  if (ballState.proxEnterFrame == null || ballState.proxExitFrame == null) {
    console.log('[trail] ⛔ not saved: incomplete proximity segment');
    ballState.state = State.FROZEN; // still freeze/clear live
    return;
  }
  ballState.shots.push({
    made,
    trail: ballState.trail.map(p => ({...p})),
    release: ballState.releaseFrame,
    proxEnter: ballState.proxEnterFrame,
    proxExit: ballState.proxExitFrame,
  });
  ballState.state = State.FROZEN;
  ballState.showFrozen = true;
  console.log(`[trail] 💾 Shot saved (len=${ballState.trail.length})`);
}


export function downloadShotsJSON() {
  const data = JSON.stringify(ballState.shots, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'shots.json'; a.click();
  URL.revokeObjectURL(url);
}

// ---------- per frame ----------
export function updateBall(ball, frameIndex) {
  ballState.f = frameIndex;
  if (!ball || !Number.isFinite(ball.x) || !Number.isFinite(ball.y)) return;
  if (!ballState.hoop) return; // need hoop locked

  const p = { x: ball.x, y: ball.y, frame: frameIndex };
  // Always keep a rolling pre-buffer while not tracking,
  // so we can backfill the arc to the true release moment.
  if (ballState.state === State.IDLE || ballState.state === State.ARMING) {
    preTrail.push(p);
    if (preTrail.length > PRE_BUFFER_SIZE) preTrail.shift();
  }

  // when idle, decide if we should arm based on proximity (pre-release scanning)
  if (ballState.state === State.IDLE) {
    if (isBallInProximityZone(p)) {
      ballState.state = State.ARMING;
      log('🟡 ARMING (proximity pre-release)');
    }
    return; // do not accumulate trail yet
  }

  // if TRACKING but never entered proximity, auto cancel after MAX_FRAMES_TO_PROX
  if (ballState.state === State.TRACKING && ballState.proxEnterFrame == null) {
    const waited = frameIndex - (ballState.releaseFrame ?? frameIndex);
    if (waited > MAX_FRAMES_TO_PROX && !isBallInProximityZone(p)) {
      log('⌛ Cancel shot — no proximity within window');
      // reset to FROZEN (no saved shot) or back to IDLE
      ballState.state = State.IDLE;
      ballState.trail = [];
      ballState.releaseFrame = null;
      return;
    }
  }

  // proximity transitions while tracking
  if (ballState.state === State.TRACKING) {
    if (isBallInProximityZone(p)) {
      if (ballState.proxEnterFrame == null) enterProximity(frameIndex);
    } else {
      // if we had already entered, exiting now means we can finalize
      if (ballState.proxEnterFrame != null) exitProximity(frameIndex);
    }
  }

  // collect live trail only AFTER release
  if (ballState.state === State.TRACKING || ballState.state === State.FINALIZING) {
    const last = ballState.trail.at(-1);
    // ghost/jump guards
    if (last) {
      const dist = Math.hypot(p.x - last.x, p.y - last.y);
      const maxJump = ballState.trail.length > 5 ? JUMP_PX_LIMIT_2 : JUMP_PX_LIMIT_1;
      if (dist > maxJump) return;

      // fill small gaps (≤ GAP_FILL_MAX)
      const gap = p.frame - last.frame;
      if (gap > 1 && gap <= GAP_FILL_MAX) {
        const dx = (p.x - last.x) / gap;
        const dy = (p.y - last.y) / gap;
        for (let k = 1; k < gap; k++) {
          ballState.trail.push({ x: last.x + dx * k, y: last.y + dy * k, frame: last.frame + k });
        }
      }
    }

    ballState.trail.push(p);
  }

  // finalize once we’ve exited proximity (we push the exit point first)
  if (ballState.state === State.FINALIZING) {
    freezeShot(null);       // let scorer fill .made later
    // stay in FROZEN until next release resets us
  }
}

// ---------- utils ---------- //

function estimateReleaseIdx(buf) {
  if (!buf || buf.length < MIN_UP_RUN + 1) return 0;
  // scan backwards for the last run of upward motion (y decreasing on canvas)
  for (let i = buf.length - MIN_UP_RUN - 1; i >= 1; i--) {
    let up = true;
    for (let k = 0; k < MIN_UP_RUN; k++) {
      const a = buf[i + k], b = buf[i + k + 1];
      if (!(b.y < a.y)) { up = false; break; }  // not rising
    }
    if (up) return Math.max(0, i - 1); // include 1 frame pre-roll
  }
  return Math.max(0, buf.length - 18); // safe fallback
}

function log(...args) { console.log('[trail]', ...args); }

// used in app.js.analyzeVideoFrameByFrame
export function getShotWindowBuffers() {
  return {
    pre: [...shotWindow.pre],
    post: [...shotWindow.post],
    active: shotWindow.active,
    releaseFrame: shotWindow.releaseFrame
  };
}

// Shot window buffer (pre/post release)
let shotWindow = {
  pre: [],
  post: [],
  active: false,
  counter: 0,
  releaseFrame: null,
  rimFrame: null
};

//--------------------------------------------------------------------//
//                   ball tracking color & style                      //
//--------------------------------------------------------------------//

// === TRAIL RENDERING (30px outlined circles + quality tint) ===
export function drawBallTrails(ctx) {
  if (!ctx) return;

  // 1) Review takes priority
  const rs = getReviewedShot?.();
  if (rs) {
    drawOneShot(ctx, rs);
    return;
  }

  // 2) Last frozen (until next release)
  if (ballState.showFrozen && ballState.shots.length) {
    drawOneShot(ctx, ballState.shots.at(-1));
  }

  // 3) Live guide (keep circles 30px diameter = r15)
  if ((ballState.state === State.TRACKING || ballState.state === State.FINALIZING) &&
      ballState.trail.length > 1) {
    drawThickPath(ctx, ballState.trail, 30, 'rgba(255,255,255,0.12)');
    drawOutlinedCircles(ctx, ballState.trail, 15, 'rgba(180,130,255,0.95)', 2);
  }
}


function splitByPhase(trail, releaseF, enterF, exitF) {
  const idxFromFrame = f => {
    if (f == null) return trail.length;
    const i = trail.findIndex(p => p.frame >= f);
    return i === -1 ? trail.length : i;
  };

  const relIdx   = releaseF != null ? idxFromFrame(releaseF) : 0;
  const enterIdx = enterF   != null ? idxFromFrame(enterF)   : trail.length;
  const exitIdx  = exitF    != null ? idxFromFrame(exitF)    : trail.length;

  const releaseSeg   = trail.slice(relIdx, Math.min(relIdx + 8, trail.length));
  const arcSeg       = trail.slice(relIdx + 8, Math.min(enterIdx, trail.length));
  const proximitySeg = trail.slice(enterIdx, Math.min(exitIdx, trail.length));
  return { releaseSeg, arcSeg, proximitySeg };
}

function strokePath(ctx, pts) {
  if (!pts || pts.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.stroke();
}

// super lightweight arc “quality” read just for color hints
function classifyArcQuality(arcSeg, hoop) {
  if (!arcSeg?.length || !hoop) return 'unknown';
  if (arcSeg.length < 6) return 'unknown';

  const apexY = Math.min(...arcSeg.map(p => p.y));   // lower y = higher on screen
  const risePx = (hoop.y - apexY);                   // >0 means ball went above rim line

  // Simple gates – tune to pixels/footage
  if (risePx > 35) return 'good';   // clearly above the rim band
  if (risePx < 10) return 'low';    // never really climbed
  return 'ok';
}

  // ---------------- Frozen shots (thick, “ball width”) ----------------
  for (const s of ballState.shots) {
    if (!s?.trail?.length) continue;
    const { releaseSeg, arcSeg, proximitySeg } =
      splitByPhase(s.trail, s.release, s.proxEnter, s.proxExit);

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 10; // ≈ ball width

    // 1) Release (first 8 frames): cyan
    ctx.strokeStyle = 'rgba(0,200,255,0.95)';
    strokePath(ctx, releaseSeg);

    // 2) Arc: color by quality (green/good, yellow/ok, orange/red/low)
    const hoop = ballState.hoop;
    const q = classifyArcQuality(arcSeg, hoop);
    ctx.strokeStyle =
      q === 'good' ? 'rgba(0,255,120,0.95)' :
      q === 'ok'   ? 'rgba(255,220,0,0.95)' :
      q === 'low'  ? 'rgba(255,120,0,0.95)' :
                     'rgba(255,220,0,0.75)'; // unknown → soft yellow
    strokePath(ctx, arcSeg);

    // 3) Proximity segment: outcome color if known
    ctx.strokeStyle =
      s.made === true  ? 'rgba(0,255,120,0.95)' :
      s.made === false ? 'rgba(255,80,80,0.95)' :
                         'rgba(255,160,0,0.95)'; // undecided yet
    strokePath(ctx, proximitySeg);
  }

  // ---------------- Live trail (thin) while tracking ----------------
  if (ballState.trail.length > 1) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(180,130,255,0.95)'; // violet
    strokePath(ctx, ballState.trail);

    // optional: glow dots to make motion clearer
    const seg = ballState.trail;
    for (let i = 0; i < seg.length; i++) {
      const a = 0.25 + 0.75 * (i / seg.length);
      const r = 6 - 4 * (i / seg.length);
      ctx.beginPath();
      ctx.arc(seg[i].x, seg[i].y, r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,255,0,${a})`;
      ctx.fill();
    }
  }

// --- new helpers for the circle-style trail --- //
function drawThickPath(ctx, pts, width = 40, color = 'rgba(255,255,255,0.18)') {
  if (!pts || pts.length < 2) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = width;
  ctx.strokeStyle = color;
  strokePath(ctx, pts); // uses existing polyline helper
  ctx.restore();
}

function drawOutlinedCircles(ctx, pts, radius = 20, stroke, lineWidth = 3) {
  if (!pts || !pts.length) return;
  ctx.save();
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = stroke;
  ctx.fillStyle = 'transparent';   // explicitly no fill
  for (const p of pts) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

// optional: a thin quality-tint ring for the arc segment
function drawQualityRing(ctx, pts, radius = 20, stroke, lineWidth = 2) {
  if (!pts || !pts.length) return;
  ctx.save();
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = stroke;
  for (const p of pts) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius - 5, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}


// replay / draw a prior shot trail
function drawOneShot(ctx, s) {
  if (!s?.trail?.length) return;
  const { releaseSeg, arcSeg, proximitySeg } =
    splitByPhase(s.trail, s.release, s.proxEnter, s.proxExit);

  drawThickPath(ctx, s.trail, 30, 'rgba(255,255,255,0.18)');

  const q = classifyArcQuality(arcSeg, ballState.hoop);
  const releaseStroke =
    q === 'good' ? 'rgba(0,255,0,0.95)' :
    q === 'low'  ? 'rgba(255,255,0,0.95)' :
                   'rgba(255,165,0,0.95)';
  drawOutlinedCircles(ctx, releaseSeg, 15, releaseStroke, 3);

  const arcStroke =
    q === 'good' ? 'rgba(0,255,0,0.95)' :
    q === 'low'  ? 'rgba(255,69,0,0.95)' :
                   'rgba(255,255,0,0.95)';
  drawOutlinedCircles(ctx, arcSeg, 15, arcStroke, 3);
  const qualityTint =
    q === 'good' ? 'rgba(0,255,120,0.85)' :
    q === 'low'  ? 'rgba(255,120,0,0.85)' :
                   'rgba(255,220,0,0.75)';
  drawQualityRing(ctx, arcSeg, 15, qualityTint, 2);

  const proxStroke =
    s.made === true  ? 'rgba(0,255,0,0.95)' :
    s.made === false ? 'rgba(255,0,0,0.95)' :
                       'rgba(255,165,0,0.95)';
  drawOutlinedCircles(ctx, proximitySeg, 15, proxStroke, 3);
}
