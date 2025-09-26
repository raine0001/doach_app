// /static/coachAssistant.js

// --- Coach voice state (persisted) ---
window.__coachMuted = JSON.parse(localStorage.getItem('doach_muted') || 'false');

// HUD mute button → toggle voice
window.addEventListener('hud:mute-toggle', (e) => {
  const muted = !!(e?.detail?.muted);
  window.__coachMuted = muted;
  try { localStorage.setItem('doach_muted', JSON.stringify(muted)); } catch {}

  // 🔁 Keep doachPrefs in sync so window.coachSpeak() won't skip
  try {
    const get = window.doachGetPrefs?.() || {};
    const next = { ...get, audioOn: !muted };
    window.doachSetPrefs?.(next);
  } catch {}
});

// Default saved TTS preference to server voice if none is set (helps desktop first-run)
try {
  if (!localStorage.getItem('doach_tts')) {
    const v = (window.DOACH && window.DOACH.voice) || 'alloy';
    localStorage.setItem('doach_tts', JSON.stringify({ provider: 'server', voice: v }));
  }
} catch {}

// Also show a metrics overlay shortly after every shot:release (independent of coaching path)
try {
  if (!window.__poseOverlayWired) {
    window.__poseOverlayWired = true;
    window.addEventListener('shot:release', () => { try { if (window.DOACH_RELEASE_TRACE === true) console.log('[coach:evt] shot:release'); } catch {}
      setTimeout(async () => {
        try {
          let s = __getPoseSnapshot();
          if (!s && typeof __samplePoseSnapshotNow === 'function') { try { s = await __samplePoseSnapshotNow(); } catch {} }
          if (s) try { showPoseMetricsOverlay?.(s, Number(window.POSE_METRICS_MS || 1800)); } catch {}
        } catch {}
      }, 160);
    });
  }
} catch {}

// --- De-dupe + formatter ---
let __lastSpokenKey = null;

function formatCoachLine(s) {
  // keep it short & actionable
  const verdict = s.made ? 'Make.' : 'Miss.';
  const arc  = Number.isFinite(s.arcHeight) ? ` Arc ${Math.round(s.arcHeight)}.` : '';
  const entry= Number.isFinite(s.entryAngle) ? ` Entry ${s.entryAngle}°.` : '';
  const why  = (!s.made && s.missReason) ? ` ${s.missReason}.` : '';
  return s.made
    ? `Nice shot! ${verdict}${entry}${arc}`
    : `Shot missed.${why}${entry}${arc}`;
}

// --- Speak once per shot summary ---
window.addEventListener('shot:summary', (e) => {
  const s = e?.detail || (window.shotLog?.at ? window.shotLog.at(-1) : null);
  if (!s) return;

  // de-dupe key
  // Include a per-shot counter when available to avoid cross-shot suppression
  const shotNo = (typeof window.__HUD_SHOT_COUNT !== 'undefined')
    ? Number(window.__HUD_SHOT_COUNT)
    : (Array.isArray(window.shotLog) ? window.shotLog.length : 0);
  const key = `${shotNo}|${+s.made}|${Math.round(s.arcHeight||0)}|${s.entryAngle}|${s.releaseAngle}|${s.frameEnd||''}`;
  if (key === __lastSpokenKey) return;
  __lastSpokenKey = key;

  const line = formatCoachLine(s);
  window.__lastCoachText = line;   // so UI can show the same line if needed
  // Realtime-only: suppress static per-shot summary voice
  if (!window.DOACH_ONLY_REALTIME) coachSpeak(line);
// (release tips listener is now wired globally during init)
});

// Use ShotStore id for banner numbering
window.addEventListener('shot:feedback:request', (e) => {
  const lastFromStore =
    (typeof getShotRecords === 'function' && getShotRecords().length)
      ? getShotRecords().slice(-1)[0]?.idx
      : null;

  window.__CURRENT_SHOT_ID =
    Number(e?.detail?.shotId) ||
    Number(lastFromStore) ||
    Number(window.__SHOT_ID) ||
    1;
});



(function(){
  // ---------- Config ----------
  const DOACH = window.DOACH || {
    chatEndpoint: '/api/coach',  // POST {prompt, model}
    ttsEndpoint:  '/api/tts',    // POST {text, voice}
    model:        'gpt-4o-mini',
    tts:          'openai',      // 'openai' or 'web'
    voice:        'alloy',
    personality:  'positive, concise, basketball fundamentals-first',
    llmMode:      'off',        // 'primary' | 'polish' | 'off'
    poseOnly:     true,
  };
  window.DOACH = DOACH;
  if (typeof DOACH.poseOnly === 'undefined') DOACH.poseOnly = true;
  if (DOACH.poseOnly) DOACH.llmMode = 'off';
  try { if (typeof window.DOACH_ONLY_REALTIME === 'undefined') window.DOACH_ONLY_REALTIME = true; } catch {}
  console.log('[Doach] coachAssistant loaded');

  // Prevent double-initialization if the script is included twice
  if (window.__DOACH_INIT__) return;
  window.__DOACH_INIT__ = true;

  // Make sure live tips are enabled by default (belt-and-suspenders)
  try { if (typeof window.PREF_LIVE_TIPS === 'undefined') window.PREF_LIVE_TIPS = true; } catch {}

  // Small helper: ensure the HUD prompt node exists and return it
  function ensureCoachNotes(){
    try {
      let el = document.getElementById('coachNotes');
      if (!el) {
        const root = document.body || document.documentElement;
        el = document.createElement('div');
        el.id = 'coachNotes';
        el.style.cssText = 'position:absolute;top:14px;left:50%;transform:translateX(-50%);max-width:520px;background:rgba(0,0,0,0.7);color:#fff;padding:10px 14px;border-radius:8px;text-align:center;font-size:14px;line-height:1.4;z-index:900;pointer-events:none;display:none;';
        el.textContent = '';
        root.appendChild(el);
      }
      return el;
    } catch { return null; }
  }

  const SPEAK_DEDUP_MS = 1200;
  let __lastSpeak = { text: '', at: 0 };

  // Default: enable live tips unless explicitly disabled elsewhere
  try { if (typeof window.PREF_LIVE_TIPS === 'undefined') window.PREF_LIVE_TIPS = true; } catch {}
  // Defaults for tip cadence: every other shot, and 60% probability fallback
  try { if (typeof window.COACH_TIP_EVERY_N === 'undefined') window.COACH_TIP_EVERY_N = 2; } catch {}
  try { if (typeof window.COACH_TIP_PROB === 'undefined') window.COACH_TIP_PROB = 0.6; } catch {}

  // Pose snapshot + metrics (richer). Prefer window.extractPoseSnapshot if provided; else define here.
  function defineExtractPoseSnapshotOnce(){
    if (typeof window.extractPoseSnapshot === 'function') return;
    window.extractPoseSnapshot = function extractPoseSnapshot(keypoints, hoopBox){
      try {
        const kp = Array.isArray(keypoints) ? keypoints : (window.playerState?.keypoints||[]);
        if (!Array.isArray(kp) || kp.length < 33) return null;
        const k = (i)=> kp[i] && Number.isFinite(kp[i].x) && Number.isFinite(kp[i].y) ? kp[i] : null;
        const L = { NOSE:0, SHO:11, ELL:13, WRL:15, SHR:12, ELR:14, WRR:16, HPL:23, HPR:24, KNL:25, KNR:26, ANL:27, ANR:28, LFI:31, RFI:32, LIX:19, RIX:20 };
        const pts = { shL:k(L.SHO), shR:k(L.SHR), elL:k(L.ELL), elR:k(L.ELR), wrL:k(L.WRL), wrR:k(L.WRR),
                      hpL:k(L.HPL), hpR:k(L.HPR), knL:k(L.KNL), knR:k(L.KNR), anL:k(L.ANL), anR:k(L.ANR),
                      lfi:k(L.LFI), rfi:k(L.RFI), nose:k(L.NOSE), lix:k(L.LIX), rix:k(L.RIX) };
        const ok = Object.values(pts).some(Boolean); if (!ok) return null;
        const mid = (a,b)=> (a&&b)?({x:(a.x+b.x)/2,y:(a.y+b.y)/2}):(a||b||null);
        const v = (a,b)=> ({ x:(b.x-a.x), y:(b.y-a.y) });
        const mag = (u)=> Math.hypot(u.x,u.y);
        const angDeg = (u)=> (Math.atan2(u.y, u.x)*180/Math.PI);
        const angleAt = (a,b,c)=>{ if(!(a&&b&&c)) return null; const u=v(b,a), w=v(b,c); const m=mag(u)*mag(w)||1e-6; return Math.acos(Math.max(-1,Math.min(1, (u.x*w.x+u.y*w.y)/m)))*180/Math.PI; };
        const dist = (a,b)=> (a&&b)?Math.hypot(a.x-b.x,a.y-b.y):null;

        const hipC = mid(pts.hpL, pts.hpR); const shC = mid(pts.shL, pts.shR); const anC = mid(pts.anL, pts.anR);
        const hipW = dist(pts.hpL, pts.hpR) || 1;
        const stanceW = dist(pts.anL, pts.anR);
        const stanceRatio = (stanceW && hipW) ? (stanceW/hipW) : null;
        const torsoLean = (shC&&hipC)? (angDeg(v(hipC, shC)) - 90) : null; // 0=upright; +/− tilt
        const elbowAngleR = angleAt(pts.shr||pts.shR, pts.elR, pts.wrR);
        const elbowAngleL = angleAt(pts.shL, pts.elL, pts.wrL);
        const elbowExt = Math.max(elbowAngleR||0, elbowAngleL||0);
        const swAngR = (pts.shr&&pts.wrR)? (Math.abs(angDeg(v(pts.shr, pts.wrR)) - 90)) : null; // 0=vertical
        const swAngL = (pts.shL&&pts.wrL)? (Math.abs(angDeg(v(pts.shL, pts.wrL)) - 90)) : null;
        const armVerticality = Math.min(swAngR??90, swAngL??90); // smaller is better (closer to 0)
        const releaseAboveShoulderR = (pts.wrR&&pts.shr) ? (pts.wrR.y < pts.shr.y) : null;
        const releaseAboveShoulderL = (pts.wrL&&pts.shL) ? (pts.wrL.y < pts.shL.y) : null;
        const releaseAboveShoulder = (releaseAboveShoulderR===true || releaseAboveShoulderL===true);
        const elbowLock = Number.isFinite(elbowExt) ? (elbowExt >= 150) : null;
        // Feet lift vs previous few frames
        let footLiftPx = null;
        try {
          const hist = (window.playerState?.frameHistory || []).slice(-4,-1);
          if (hist.length) {
            const prev = hist.map(h=>h.keypoints).filter(Boolean);
            const avg = (arr)=> arr.reduce((s,v)=>s+v,0)/arr.length;
            if (prev.length) {
              const pAnL = avg(prev.map(p=> (p[L.ANL]?.y)||0));
              const pAnR = avg(prev.map(p=> (p[L.ANR]?.y)||0));
              const curL = pts.anL?.y, curR = pts.anR?.y;
              if (Number.isFinite(curL) && Number.isFinite(curR)) footLiftPx = Math.max((pAnL-curL),(pAnR-curR));
            }
          }
        } catch {}
        // Feet placement: angles and stagger, toe alignment to hoop
        let feetAngleDiff = null, footStagger = null, toeToHoopDeg = null;
        try {
          const dirL = (pts.anL&&pts.lfi) ? v(pts.anL, pts.lfi) : null;
          const dirR = (pts.anR&&pts.rfi) ? v(pts.anR, pts.rfi) : null;
          const aL = dirL ? angDeg(dirL) : null;
          const aR = dirR ? angDeg(dirR) : null;
          if (Number.isFinite(aL) && Number.isFinite(aR)) {
            const d = Math.abs(aL - aR); feetAngleDiff = Math.min(d, 360 - d);
          }
          if (Number.isFinite(pts.anL?.y) && Number.isFinite(pts.anR?.y)) footStagger = Math.abs(pts.anL.y - pts.anR.y);
          const hoop = hoopBox || window.getLockedHoopBox?.();
          const hc = hoop && Number.isFinite(hoop.cx) ? {x:hoop.cx, y:hoop.cy} : (hoop ? {x:hoop.x + (hoop.w||hoop.width||0)/2, y:hoop.y + (hoop.h||hoop.height||0)/2} : null);
          if (hc && anC) {
            const avgDir = (()=>{ const arr=[]; if(dirL)arr.push(dirL); if(dirR)arr.push(dirR); if(!arr.length) return null; return {x:arr.reduce((s,u)=>s+u.x,0)/arr.length, y:arr.reduce((s,u)=>s+u.y,0)/arr.length}; })();
            if (avgDir) {
              const feetAng = angDeg(avgDir);
              const hoopAng = angDeg(v(anC, hc));
              const d = Math.abs(feetAng - hoopAng); toeToHoopDeg = Math.min(d, 360 - d);
            }
          }
        } catch {}
        // Player center alignment to hoop
        let frameOffsetX = null;
        try {
          const hoop = hoopBox || window.getLockedHoopBox?.();
          const hc = hoop && Number.isFinite(hoop.cx) ? {x:hoop.cx, y:hoop.cy} : (hoop ? {x:hoop.x + (hoop.w||hoop.width||0)/2, y:hoop.y + (hoop.h||hoop.height||0)/2} : null);
          if (hc && shC) frameOffsetX = (shC.x - hc.x);
        } catch {}
        // Knee flex (power): convert knee angle to flex degrees (180 - angle)
        let kneeFlex = null; let kneeL=null, kneeR=null;
        try {
          const aL = angleAt(pts.hpL, pts.knL, pts.anL);
          const aR = angleAt(pts.hpR, pts.knR, pts.anR);
          if (Number.isFinite(aL)) kneeL = Math.max(0, 180 - aL);
          if (Number.isFinite(aR)) kneeR = Math.max(0, 180 - aR);
          const arr = [kneeL, kneeR].filter(Number.isFinite);
          if (arr.length) kneeFlex = arr.reduce((s,v)=>s+v,0)/arr.length;
        } catch {}

        // Wrist/index release cue: fingers down (index below wrist)
        let indexBelowWristPx = null, fingersDown = null;
        try {
          const dR = (Number.isFinite(pts.rix?.y) && Number.isFinite(pts.wrR?.y)) ? (pts.rix.y - pts.wrR.y) : null;
          const dL = (Number.isFinite(pts.lix?.y) && Number.isFinite(pts.wrL?.y)) ? (pts.lix.y - pts.wrL.y) : null;
          const arr = [dR, dL].filter(Number.isFinite);
          if (arr.length) { indexBelowWristPx = Math.max(...arr); fingersDown = indexBelowWristPx > 0; }
        } catch {}

        // Follow-through hold (approx): count recent frames with extended elbow & wrist above elbow
        let followThroughHoldFrames = null;
        try {
          const hist = (window.playerState?.frameHistory || []).slice(-6);
          let cnt = 0;
          for (const f of hist) {
            const p = f?.keypoints; if (!p) continue;
            const sh = p[12], el = p[14], wr = p[16];
            const elAng = angleAt(sh, el, wr);
            const wristAboveElbow = (wr?.y != null && el?.y != null) ? (wr.y < el.y) : false;
            if (Number.isFinite(elAng) && elAng >= 150 && wristAboveElbow) cnt++;
          }
          followThroughHoldFrames = cnt;
        } catch {}

        // Head direction: is nose vector pointing toward the hoop?
        let headToHoopDeg = null, lookingAtHoop = null;
        try {
          const hoop = hoopBox || window.getLockedHoopBox?.();
          const hc = hoop && Number.isFinite(hoop.cx) ? {x:hoop.cx, y:hoop.cy} : (hoop ? {x:hoop.x + (hoop.w||hoop.width||0)/2, y:hoop.y + (hoop.h||hoop.height||0)/2} : null);
          if (hc && shC && pts.nose) {
            const neckToNose = v(shC, pts.nose);
            const neckToHoop = v(shC, hc);
            const a = Math.abs(angDeg(neckToNose) - angDeg(neckToHoop));
            headToHoopDeg = Math.min(a, 360 - a);
            lookingAtHoop = headToHoopDeg <= 25;
          }
        } catch {}
        // Simple feet-to-hoop alignment (ankle line vs vector to hoop)
        let feetToHoopDeg = null;
        try {
          const hc = (window.getLockedHoopBox?.()||{}); const cx = Number.isFinite(hc.cx)?hc.cx: (hc.x + (hc.w||0)/2);
          const cy = Number.isFinite(hc.cy)?hc.cy: (hc.y + (hc.h||0)/2);
          if (Number.isFinite(cx) && Number.isFinite(cy) && pts.anL && pts.anR) {
            const dirFeet = v(pts.anL, pts.anR); // player base direction
            const dirHoop = { x: cx - anC.x, y: cy - anC.y };
            const a = Math.abs(angDeg(dirFeet) - angDeg(dirHoop));
            feetToHoopDeg = Math.min(a, 180 - a);
          }
        } catch {}
        return {
          stanceWidthPx: stanceW, stanceRatio,
          torsoLeanAngle: (Number.isFinite(torsoLean)? Math.round(torsoLean) : null),
          elbowExtDeg: (Number.isFinite(elbowExt)? Math.round(elbowExt) : null),
          armVerticalityDeg: (Number.isFinite(armVerticality)? Math.round(armVerticality) : null),
          releaseAboveShoulder,
          elbowLock,
          footLiftPx: (Number.isFinite(footLiftPx)? Math.round(footLiftPx) : null),
          frameOffsetX: (Number.isFinite(frameOffsetX)? Math.round(frameOffsetX) : null),
          feetToHoopDeg: (Number.isFinite(feetToHoopDeg)? Math.round(feetToHoopDeg) : null),
          feetAngleDiff: (Number.isFinite(feetAngleDiff)? Math.round(feetAngleDiff) : null),
          footStagger: (Number.isFinite(footStagger)? Math.round(footStagger) : null),
          toeToHoopDeg: (Number.isFinite(toeToHoopDeg)? Math.round(toeToHoopDeg) : null),
          kneeFlex: (Number.isFinite(kneeFlex)? Math.round(kneeFlex) : null),
          indexBelowWristPx: (Number.isFinite(indexBelowWristPx)? Math.round(indexBelowWristPx) : null),
          fingersDown: (typeof fingersDown === 'boolean') ? fingersDown : null,
          followThroughHoldFrames: (Number.isFinite(followThroughHoldFrames)? followThroughHoldFrames : null),
          headToHoopDeg: (Number.isFinite(headToHoopDeg)? Math.round(headToHoopDeg) : null),
          lookingAtHoop: (typeof lookingAtHoop === 'boolean') ? lookingAtHoop : null,
        };
      } catch { return null; }
    };
  }

  // Wire quick pose tips on release — gated off by default. Enable with window.PREF_LIVE_TIPS=true
  function __getPoseSnapshot(){
    try { defineExtractPoseSnapshotOnce(); } catch {}
    try {
      // Prefer extractPoseSnapshot(keypoints, hoopBox)
      if (typeof window.extractPoseSnapshot === 'function') {
        // Choose best-available keypoints: current → last good → last in history
        let kps = null;
        try {
          if (Array.isArray(window.playerState?.keypoints) && window.playerState.keypoints.length >= 33) kps = window.playerState.keypoints;
          if (!kps && Array.isArray(window.__lastPoseKP) && window.__lastPoseKP.length >= 33) kps = window.__lastPoseKP;
          if (!kps) {
            const hist = (window.playerState?.frameHistory || []).slice().reverse();
            const found = hist.find(f => Array.isArray(f?.keypoints) && f.keypoints.length >= 33);
            if (found) kps = found.keypoints;
          }
        } catch {}
        if (kps) return window.extractPoseSnapshot(kps, window.getLockedHoopBox?.());
      }
      // Fallback to any older capture API
      if (typeof window.capturePoseSnapshot === 'function') {
        return window.capturePoseSnapshot(window.playerState, window.getLockedHoopBox?.());
      }
    } catch {}
    // Construct a minimal snapshot from current keypoints or gate tests
    try {
      const kp = (window.playerState?.keypoints && Array.isArray(window.playerState.keypoints) && window.playerState.keypoints.length >= 33)
        ? window.playerState.keypoints
        : (Array.isArray(window.__lastPoseKP) && window.__lastPoseKP.length >= 33 ? window.__lastPoseKP : null);
      const gate = window.__LAST_GATE?.detail?.tests || {};
      if (Array.isArray(kp) && kp.length >= 33) {
        const wr = kp[16], el = kp[14], sh = kp[12];
        if (wr && el && sh && Number.isFinite(wr.x) && Number.isFinite(wr.y) && Number.isFinite(sh.x) && Number.isFinite(sh.y)) {
          const dx = Math.abs((wr.x||0) - (sh.x||0));
          const dy = Math.abs((sh.y||0) - (wr.y||0));
          const angle = Math.atan2(dy, dx) * 180 / Math.PI; // shoulder->wrist
          return {
            wristY: wr.y, elbowY: el.y, shoulderY: sh.y,
            releaseAboveShoulder: (wr.y < sh.y),
            shoulderToWristAngle: angle,
            torsoLeanAngle: null,
          };
        }
      }
      if (gate && (gate.wristAboveShoulder != null)) {
        // Approximate from gate tests and dx/dy
        const dx = Number(gate.dx || 0), dy = Number(gate.dy || 0);
        const angle = (dx||dy) ? (Math.atan2(Math.abs(dy), Math.abs(dx)) * 180 / Math.PI) : null;
        return {
          releaseAboveShoulder: !!gate.wristAboveShoulder,
          shoulderToWristAngle: angle,
          torsoLeanAngle: null,
        };
      }
    } catch {}
    return null;
  }

  // One-shot sampling from the live video element to build a fresh snapshot
  async function __samplePoseSnapshotNow() {
    try {
      const v = document.getElementById('videoPlayer');
      if (!v || !v.videoWidth) return null;
      const ts = performance.now();
      let people = null;
      try {
        if (window.poseDetector?.detectForVideo) {
          const res = await window.poseDetector.detectForVideo(v, ts);
          people = res?.landmarks || null;
        } else if (typeof window.poseDetectSerial === 'function') {
          const res = await window.poseDetectSerial();
          people = res?.landmarks || null;
        }
      } catch {}
      const ls = (Array.isArray(people) && Array.isArray(people[0]) && people[0].length >= 33) ? people[0] : null;
      if (!ls) return null;
      const looksNorm = ls.every(k => k && k.x <= 1.01 && k.y <= 1.01);
      const sx = looksNorm ? (v.videoWidth || 1) : 1;
      const sy = looksNorm ? (v.videoHeight || 1) : 1;
      const scaled = ls.map(k => ({ ...k, x: k.x * sx, y: k.y * sy }));
      try { defineExtractPoseSnapshotOnce(); } catch {}
      return (typeof window.extractPoseSnapshot === 'function')
        ? window.extractPoseSnapshot(scaled, window.getLockedHoopBox?.())
        : null;
    } catch { return null; }
  }

  function __ensureSummarizer(){
    try {
      if (typeof window.summarizePoseIssues === 'function') return;
      // Rich, rule-based summarizer. Returns top 2–3 concise notes.
      window.summarizePoseIssues = ({ poseSnapshot, golden }) => {
        const S = poseSnapshot || {};
        const out = [];
        const prev = (Array.isArray(window.__shotList) ? window.__shotList : []).map(s=>s.poseSnapshot).filter(Boolean);
        const avg = (arr)=> arr.length ? (arr.reduce((s,v)=>s+v,0)/arr.length) : null;
        const prevAvg = {
          stanceRatio: avg(prev.map(p=>p.stanceRatio).filter(Number.isFinite)),
          elbowExtDeg: avg(prev.map(p=>p.elbowExtDeg).filter(Number.isFinite)),
          armVerticalityDeg: avg(prev.map(p=>p.armVerticalityDeg).filter(Number.isFinite)),
          torsoLeanAngle: avg(prev.map(p=>p.torsoLeanAngle).filter(Number.isFinite)),
          feetToHoopDeg: avg(prev.map(p=>p.feetToHoopDeg).filter(Number.isFinite)),
        };
        // Targets (golden) with sensible defaults
        const G = Object.assign({
          stanceRatio: 1.2,           // feet ~hip to 1.4× hip
          elbowExtDeg: 150,           // near straight
          armVerticalityDeg: 10,      // near vertical
          torsoLeanAbsMax: 12,
          feetToHoopDegMax: 22,       // roughly squared
        }, golden||{});
        // Stance width
        if (Number.isFinite(S.stanceRatio)) {
          if (S.stanceRatio < 0.9) out.push('Wider base; feet shoulder‑width apart.');
          else if (S.stanceRatio > 1.6) out.push('Narrow your stance slightly.');
          else if (prevAvg.stanceRatio && S.stanceRatio > prevAvg.stanceRatio + 0.25) out.push('Good base — more stable than last shots.');
        }
        // Feet to hoop alignment
        if (Number.isFinite(S.feetToHoopDeg) && S.feetToHoopDeg > G.feetToHoopDegMax)
          out.push('Square your feet a bit more to the rim.');
        // Knee flex proxy: if elbow extension lags + arm verticality poor, cue power
        if (Number.isFinite(S.elbowExtDeg) && S.elbowExtDeg < (G.elbowExtDeg - 10))
          out.push('Fully extend the shooting arm through release.');
        if (Number.isFinite(S.armVerticalityDeg) && S.armVerticalityDeg > (G.armVerticalityDeg + 8))
          out.push('Get the forearm more vertical at release.');
        // Release height
        if (S.releaseAboveShoulder === false)
          out.push('Release above your shoulder line.');
        // Torso lean
        if (Number.isFinite(S.torsoLeanAngle) && Math.abs(S.torsoLeanAngle) > G.torsoLeanAbsMax)
          out.push('Stay taller — limit torso lean.');
        // Foot lift
        if (Number.isFinite(S.footLiftPx)) {
          if (S.footLiftPx > 8) out.push('Nice pop — light foot lift on release.');
          else out.push('Add a little upward pop as you snap.');
        }
        // Frame offset (contextual guidance only when large)
        if (Number.isFinite(S.frameOffsetX) && Math.abs(S.frameOffsetX) > 80)
          out.push('Center your body line with the rim before you shoot.');
        // Only keep top 2–3 to stay concise
        return out.slice(0, 3);
      };
    } catch {}
  }

  function assessPoseAndSpeak(via) {
    try {
      // Gate: only once session is armed and hoop is confirmed
      const armed = (window.__shotTrackingArmed === true);
      const confirmed = (window.__hoopConfirmed === true);
      if (!armed || !confirmed) {
        if (window.DOACH_RELEASE_TRACE === true) { try { console.log('[coach:tip:skip]', { via, reason: !armed ? 'not-armed' : 'no-hoop' }); } catch {} }
        return;
      }
      // Speak only on release (and allow score-trip fallback elsewhere)
      if (via !== 'shot:release') return;
      if (!window.PREF_LIVE_TIPS) return;  // default: no live tips, only summary
      
      // simple cooldown on our side (coachSpeak also dedups)
      const now = performance.now();
      const last = Number(window.__COACH_TIP_LAST_AT || 0);
      const gap = Number(window.COACH_TIP_MIN_MS || 900);
      
      // Always allow on the exact shot release event
      if (via === 'shot:release') {
        window.__COACH_TIP_LAST_AT = now;
        try { window.__COACH_LAST_REL_SPEAK = now; } catch {}
        assessPoseAndSpeakCore(via);
        return;
      }
      if (now - last < gap) return;
      // Frequency gating: speak on some shots, not all
      try {
        const cnt = Number(window.__HUD_SHOT_COUNT || window.shotTaken || 0);
        const everyN = Number(window.COACH_TIP_EVERY_N || 0);  // e.g., 2 → every other shot
        const prob   = Number(window.COACH_TIP_PROB || 0);     // e.g., 0.4 → 40% chance
        let allow = true;
        if (!(everyN > 1)) { try { allow = Math.random() < (Number(window.COACH_TIP_PROB || 0.5)); } catch {} }
        if (everyN > 1) allow = (cnt % everyN) === 1;          // speak on 1, 1+N, ...
        if (!allow && prob > 0) allow = Math.random() < prob;  // random backstop
        if (!allow) return;
      } catch {}
      window.__COACH_TIP_LAST_AT = now;

      // allow a small delay after release to stabilize pose if asked (release: no delay)
      const delay = (via === 'shot:release') ? 0 : Number(window.COACH_TIP_DELAY_MS || 900);
      if (delay > 0) {
        setTimeout(() => { try { assessPoseAndSpeakCore(via); } catch {} }, delay);
      } else {
        assessPoseAndSpeakCore(via);
      }
    } catch {}
  }

  async function assessPoseAndSpeakCore(via){
    try {
      let snap = __getPoseSnapshot();
      // Try an immediate one-shot sample before scheduling delayed resample
      if (!snap && typeof __samplePoseSnapshotNow === 'function') {
        try { snap = await __samplePoseSnapshotNow(); } catch {}
      }
      try {
        if (window.DOACH_RELEASE_TRACE === true) {
          const gate = window.__LAST_GATE?.detail?.tests || null;
          console.log('[coach:tip:snap]', { via, snap, gate });
        }
      } catch {}
      // If we fired exactly at release, give pose one short beat to land
      if (!snap && via === 'shot:release') {
        try {
          if (!window.__COACH_RESAMPLE_SCHED) {
            window.__COACH_RESAMPLE_SCHED = true;
            setTimeout(() => {
              (async () => {
                try {
                  window.__COACH_RESAMPLE_SCHED = false;
                  // Re-check gate
                  if (window.__shotTrackingArmed !== true || window.__hoopConfirmed !== true) return;
                  let s2 = __getPoseSnapshot();
                  if (!s2 && typeof __samplePoseSnapshotNow === 'function') {
                    try { s2 = await __samplePoseSnapshotNow(); } catch {}
                  }
                  if (!s2) {
                    try {
                      // Build a minimal snapshot from the unified gate tests so AI can still respond
                      const t = (window.__LAST_GATE?.detail?.tests) || {};
                      const mSnap = {
                        releaseAboveShoulder: (typeof t.wristAboveShoulder === 'boolean') ? t.wristAboveShoulder : null,
                        elbowExtDeg: Number.isFinite(t.elbowAngleDeg) ? Math.round(t.elbowAngleDeg) : null,
                        armVerticalityDeg: Number.isFinite(t.dx) && Number.isFinite(t.dy)
                          ? Math.round(Math.abs(90 - (Math.atan2(Math.abs(t.dy), Math.abs(t.dx)) * 180 / Math.PI)))
                          : null,
                        stanceRatio: null,
                        feetToHoopDeg: null,
                        torsoLeanAngle: null,
                        footLiftPx: null,
                        frameOffsetX: null,
                      };
                      const hasAny = Object.values(mSnap).some(v => v !== null);
                      if (hasAny) {
                        if (window.DOACH_RELEASE_TRACE === true) console.log('[coach:tip:minimal]', { via, snap: mSnap, gate: t });
                        speakWithAIOrRules(mSnap, via);
                      } else {
                        // No measurable cues at all — log + prompt only (no static speech)
                        const msg = 'Release pose not detected clearly — keep your upper body and shooting arm fully in frame, and check lighting.';
                        window.showPromptMessage?.(msg, 3000);
                        try { if (window.DOACH_RELEASE_TRACE === true) console.warn('[coach:tip:no-snapshot]'); } catch {}
                      }
                    } catch {}
                    return;
                  }
                  
                  const golden2 = window.DOACH_MEM?.get?.()?.golden;
                  const issues2 = (typeof window.summarizePoseIssues === 'function')
                    ? (window.summarizePoseIssues({ poseSnapshot: s2 }, golden2) || [])
                    : [];
                  // Persist snapshot for history and attach to last pending shot if missing
                  try {
                    (window.__poseHistory ||= []).push({ t: Date.now(), snap: s2 });
                    const lst = window.__shotList; const last = Array.isArray(lst) ? lst.at(-1) : null;
                    if (last && last.pending && !last.poseSnapshot) last.poseSnapshot = s2;
                  } catch {}
                  if (window.DOACH_RELEASE_TRACE === true) console.log('[coach:tip:resample]', { via, snap: s2, issues: issues2, lastGate: window.__LAST_GATE?.detail?.tests || null });
                  try { showPoseMetricsOverlay?.(s2, Number(window.POSE_METRICS_MS || 1800)); } catch {} 

                  speakWithAIOrRules(s2, via);
                } catch {}
              })();
            }, Math.max(120, Number(window.COACH_TIP_RESAMPLE_MS ?? 350)));
          }
        } catch {}
        return;
      }
      if (!snap) return;
      
      const golden = window.DOACH_MEM?.get?.()?.golden;
      const issues = (typeof window.summarizePoseIssues === 'function')
        ? (window.summarizePoseIssues({ poseSnapshot: snap }, golden) || [])
        : [];

      // Categorize and vary the coaching line so it doesn't repeat
      // Persist current snapshot for session-level analysis
      try {
        (window.__poseHistory ||= []).push({ t: Date.now(), snap });
        // also attach to last pending shot if present
        const lst = window.__shotList; const last = Array.isArray(lst) ? lst.at(-1) : null;
        if (last && last.pending && !last.poseSnapshot) last.poseSnapshot = snap;
      } catch {}

      // Overlay: show the metrics we will coach from
      try { showPoseMetricsOverlay?.(snap, Number(window.POSE_METRICS_MS || 1800)); } catch {}
      // Always use AI for release tips; no rule fallback
      speakWithAIOrRules(snap, via);
    } catch {}
  }

  async function speakWithAIOrRules(snap, via){
    function getShotNumber(){
    // Prefer the canonical id captured from ShotStore
    const id = Number(window.__CURRENT_SHOT_ID);
    if (Number.isFinite(id) && id > 0) return id;

    // Fallback: last row from ShotStore, if available
    try {
      if (typeof getShotRecords === 'function') {
        const last = getShotRecords().slice(-1)[0];
        if (last && Number.isFinite(last.idx)) return last.idx;
      }
    } catch {}

    // Legacy fallbacks (kept for safety)
    const vals = [];
    if (Number.isFinite(window.__SHOT_ID))          vals.push(Number(window.__SHOT_ID));
    if (Number.isFinite(window.__SCORE_SHOT_COUNT)) vals.push(Number(window.__SCORE_SHOT_COUNT));
    if (Array.isArray(window.shotLog))              vals.push(window.shotLog.length);
    if (Number.isFinite(window.__HUD_SHOT_COUNT))   vals.push(Number(window.__HUD_SHOT_COUNT));
    if (Number.isFinite(window.shotTaken))          vals.push(Number(window.shotTaken));
    const n = vals.filter(v => v > 0).reduce((m,v)=>Math.max(m,v), 0);
    return n > 0 ? n : 1;
  }

    function withShotPrefix(text){
      const n = getShotNumber();
      return (Number.isFinite(n) && n > 0) ? `Shot ${n}, ${text}` : String(text||'');
    }
    // Always use AI for pose assessment. If unavailable, show connection error — no rule fallback.
    function postDisconnected(){
      try {
        const msg = 'Doach is not connected. Please restart the session and check your internet connection.';
        window.showPromptMessage?.(msg, 2000);
        console.warn('[coach:ai:error] not connected');
      } catch {}
    }

    const llmMode = (window.DOACH && window.DOACH.llmMode) || 'off';

    const inferShotIdx0 = () => {
      const cur = Number(window.__CURRENT_SHOT_ID);
      if (Number.isFinite(cur) && cur > 0) return cur - 1;
      try { if (Number.isFinite(Number(shot?.coachIdx))) return Number(shot.coachIdx); } catch {}
      try { if (Number.isFinite(Number(shot?.idx)))      return Number(shot.idx); } catch {}
      try { if (Number.isFinite(Number(shot?.__idx)))    return Number(shot.__idx) - 1; } catch {}
      try { if (Number.isFinite(Number(window.__SHOT_IDX))) return Number(window.__SHOT_IDX); } catch {}
      try {
        const n = getShotNumber?.(); // 1-based if available
        if (Number.isFinite(n) && n > 0) return n - 1;
      } catch {}
      try {
        const len = (window.__shotList?.length || 0);
        if (len > 0) return Math.max(0, len - 1);
      } catch {}
      return 0;
    };

    const sendCoachFinalize = (finalLine) => {
      try {
        const sid = window.__SESSION_ID || null;
        if (!sid || !finalLine) return;
        const idxFinal = Number(inferShotIdx0());
        if (!Number.isFinite(idxFinal)) return;
        const poseOnly = DOACH?.poseOnly === true;
        const payload = {
          sid,
          shot_idx: idxFinal,
          text: finalLine,
          model: poseOnly ? 'pose-summary' : (window.DOACH?.model || 'coach-final'),
          provider: poseOnly ? 'pose' : (window.DOACH?.llmMode || 'final')
        };
        queueMicrotask(() => {
          try {
            fetch('/api/coach/finalize', {
              method:'POST',
              headers:{'Content-Type':'application/json'},
              body: JSON.stringify(payload),
              credentials:'include'
            }).catch(() => {});
          } catch {}
        });
      } catch {}
    };

    // If AI is explicitly off, fall back to local rule-based line immediately
    if (llmMode === 'off') {
      try {
        const local = composePoseFeedback(snap);
        if (local) {
          const out = withShotPrefix(local);
          window.__lastCoachText = out;
          try { if (window.DOACH_RELEASE_TRACE === true) console.log('[coach:speak:off]', { via, out }); } catch {}
          try { const el = (typeof ensureCoachNotes === 'function') ? ensureCoachNotes() : document.getElementById('coachNotes'); if (el) { el.style.display='block'; el.textContent = out; } } catch {}
          try { coachSpeak(out); } catch {}
          sendCoachFinalize(out);
        } else { postDisconnected(); }
      } catch { postDisconnected(); }
      return;
    }
    try {
      const ctrl = new AbortController();
      const ms = Math.max(1200, Number(window.COACH_AI_TIMEOUT_MS || 2500));
      const t = setTimeout(() => { try { ctrl.abort(); } catch {} }, ms);
      const body = {
        prompt: `You are a concise basketball shooting coach. Using only these metrics, give 1 or 2 short specific release cues. Metrics: ${JSON.stringify(snap)}`,
        model: (window.DOACH && window.DOACH.model) || 'gpt-4o-mini',
        lang: 'en-US',
        shot: snap,
        profile: (localStorage.getItem('doachProfile')||''),
        sid: (window.__SESSION_ID || null),
        shotId: inferShotIdx0(),
      };
      if (window.DOACH_RELEASE_TRACE === true) console.log('[coach:ai:req]', { via, ms, body });
      const r = await fetch('/api/coach', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body), signal: ctrl.signal, credentials:'include' });
      clearTimeout(t);
      if (!r.ok) throw new Error('coach_api_'+r.status);
      const j = await r.json();
      const text = String(j?.text||'').trim();
      if (window.DOACH_RELEASE_TRACE === true) console.log('[coach:ai:res]', { via, textLen: text.length, text });
      if (text) {
        try {
          const out = withShotPrefix(text);
          window.__lastCoachText = out;
          try { const el = (typeof ensureCoachNotes === 'function') ? ensureCoachNotes() : document.getElementById('coachNotes'); if (el) { el.style.display='block'; el.textContent = out; } } catch {}
          try { coachSpeak(out); } catch {}
          sendCoachFinalize(out);
        } catch {}
        return;
      }
      // No text returned → treat as unavailable; fall back to local
      try {
        const local = composePoseFeedback(snap);
        if (local) {
          const out = withShotPrefix(local);
          window.__lastCoachText = out;
          try { if (window.DOACH_RELEASE_TRACE === true) console.log('[coach:speak:fallback-local]', { via, out }); } catch {}
          try { const el = (typeof ensureCoachNotes === 'function') ? ensureCoachNotes() : document.getElementById('coachNotes'); if (el) { el.style.display='block'; el.textContent = out; } } catch {}
          try { coachSpeak(out); } catch {}
          sendCoachFinalize(out);
          return;
        }
      } catch {}
      postDisconnected();
    } catch (e) {
      if (window.DOACH_RELEASE_TRACE === true) console.warn('[coach:ai:error]', e?.message||e);
      // Fallback to local rule-based line on any error
      try {
        const local = composePoseFeedback(snap);
        if (local) {
          const out = withShotPrefix(local);
          window.__lastCoachText = out;
          try { if (window.DOACH_RELEASE_TRACE === true) console.log('[coach:speak:error-local]', { via, out }); } catch {}
          try { const el = (typeof ensureCoachNotes === 'function') ? ensureCoachNotes() : document.getElementById('coachNotes'); if (el) { el.style.display='block'; el.textContent = out; } } catch {}
          try { coachSpeak(out); } catch {}
          sendCoachFinalize(out);
          return;
        }
      } catch {}
      postDisconnected();
    }
  }

  // ---- Fine-grained feedback composer (snapshot → specific line) ----
  function composePoseFeedback(snap){
    try {
      const prev = Array.isArray(window.__poseHistory) && window.__poseHistory.length
        ? window.__poseHistory.map(e=>e.snap).filter(Boolean) : [];
      const avg = (arr)=> arr.length ? arr.reduce((s,v)=>s+v,0)/arr.length : null;
      const pAvg = {
        stanceRatio: avg(prev.map(p=>p.stanceRatio).filter(Number.isFinite)),
        elbowExtDeg: avg(prev.map(p=>p.elbowExtDeg).filter(Number.isFinite)),
        armVertDeg:  avg(prev.map(p=>p.armVerticalityDeg).filter(Number.isFinite)),
        torsoLean:   avg(prev.map(p=>p.torsoLeanAngle).filter(Number.isFinite)),
        feetToHoop:  avg(prev.map(p=>p.feetToHoopDeg).filter(Number.isFinite)),
        kneeFlex:    avg(prev.map(p=>p.kneeFlex).filter(Number.isFinite)),
        feetAngle:   avg(prev.map(p=>p.feetAngleDiff).filter(Number.isFinite)),
        footStag:    avg(prev.map(p=>p.footStagger).filter(Number.isFinite)),
      };
      const choose = (arr)=> arr[Math.floor(Math.random()*arr.length)];

      // Also draw from the unified gate tests when present
      const t = (window.__LAST_GATE && window.__LAST_GATE.detail && window.__LAST_GATE.detail.tests) ? window.__LAST_GATE.detail.tests : {};

      // Rank likely issues by severity so we pick the most actionable first
      const cand = [];
      const push = (sev, lines)=>{ if (sev > 0 && lines && lines.length) cand.push({ sev, lines }); };

      // Release height
      if (snap.releaseAboveShoulder === false || t.wristAboveShoulder === false) {
        push(10, ['Raise the release above your shoulder line.', 'Get the wrist above the shoulder at release.']);
      }
      // Elbow extension (target ~150+)
      if (Number.isFinite(snap.elbowExtDeg)) push(Math.max(0, 150 - snap.elbowExtDeg), ['Finish with stronger arm extension.', 'Straighten the elbow through the snap.']);
      else if (Number.isFinite(t.elbowAngleDeg)) push(Math.max(0, 150 - t.elbowAngleDeg), ['Finish with stronger arm extension.']);
      // Arm verticality (target ~<=12 off vertical)
      if (Number.isFinite(snap.armVerticalityDeg)) push(Math.max(0, snap.armVerticalityDeg - 12), ['Get the forearm more vertical at release.', 'Reach up for a taller finish.']);
      else if (Number.isFinite(t.dx)) push(Math.max(0, t.dx - (Number(window.REL_DX_MAX||60)-4)), ['Get the forearm more vertical at release.']);
      // Dy upward drive (target >= REL_DY_MIN)
      if (Number.isFinite(t.dy)) push(Math.max(0, (Number(window.REL_DY_MIN||18) - t.dy)), ['Drive up more through the release.']);
      if (t.wristUpTrend === false) push(6, ['Snap up through the ball, not forward.']);
      // Stance width (target ~1.0–1.5)
      if (Number.isFinite(snap.stanceRatio)) {
        const dist = (snap.stanceRatio < 1.0) ? (1.0 - snap.stanceRatio) : (snap.stanceRatio - 1.5);
        if (dist > 0) {
          push(6 + dist*10, snap.stanceRatio < 1.0 ? ['Wider base; feet shoulder-width apart.', 'Open to shoulder width.'] : ['Narrow your stance slightly for balance.']);
        }
      }
      // Feet to rim (target <=22 deg)
      if (Number.isFinite(snap.feetToHoopDeg)) push(Math.max(0, snap.feetToHoopDeg - 22), ['Square your feet a bit more to the rim.']);
      // Feet angle diff (target small, <=8–10 deg)
      if (Number.isFinite(snap.feetAngleDiff)) push(Math.max(0, snap.feetAngleDiff - 10), ['Make your toes more parallel.']);
      // Foot stagger (target small)
      if (Number.isFinite(snap.footStagger)) push(Math.max(0, snap.footStagger - 6), ['Even out your stance front-to-back.']);
      // Toe-to-hoop alignment (target <= 22 deg)
      if (Number.isFinite(snap.toeToHoopDeg)) push(Math.max(0, snap.toeToHoopDeg - 22), ['Point your toes a touch more toward the basket.']);
      // Knee flex (target around 28+ deg flex for power)
      if (Number.isFinite(snap.kneeFlex)) push(Math.max(0, 28 - snap.kneeFlex), ['Add a bit more knee bend on your lift.']);
      // Fingers down (index below wrist)
      if (snap.fingersDown === false) push(8, ['Snap the wrist — fingers down on the finish.']);
      // Follow-through hold (target >= 2–3 frames)
      if (Number.isFinite(snap.followThroughHoldFrames) && snap.followThroughHoldFrames < 2) push(6, ['Hold the follow‑through for a brief pause.']);
      // Head direction (target <= 25 deg off hoop)
      if (Number.isFinite(snap.headToHoopDeg) && snap.headToHoopDeg > 25) push(5, ['Eyes on the rim through the release.']);
      // Torso lean (target <=12 abs)
      if (Number.isFinite(snap.torsoLeanAngle)) push(Math.max(0, Math.abs(snap.torsoLeanAngle) - 12), ['Stay taller through your lift.', 'Keep your torso stacked over your hips.']);
      // Foot pop (target >=2 px)
      if (Number.isFinite(snap.footLiftPx)) push(Math.max(0, 2 - snap.footLiftPx), ['Add a little upward pop as you snap.']);
      // Centering (target |offset| <= 90 px)
      if (Number.isFinite(snap.frameOffsetX)) push(Math.max(0, Math.abs(snap.frameOffsetX) - 90), ['Center your body line with the rim before you shoot.']);

      if (cand.length) {
        cand.sort((a,b)=> b.sev - a.sev);
        return choose(cand[0].lines);
      }

      // Prioritized corrections
      if (snap.releaseAboveShoulder === false)
        return choose([
          'Raise the release above your shoulder line.',
          'Get the wrist above the shoulder at release.',
          'Finish higher — above the shoulder line.'
        ]);

      if (Number.isFinite(snap.elbowExtDeg) && snap.elbowExtDeg < 145)
        return choose([
          'Finish with stronger arm extension.',
          'Straighten the elbow through the snap.',
          'Drive the elbow to a straighter finish.'
        ]);

      if (Number.isFinite(snap.armVerticalityDeg) && snap.armVerticalityDeg > 14)
        return choose([
          'Get the forearm more vertical at release.',
          'Reach up — taller arm on the finish.',
          'Lift the forearm closer to vertical.'
        ]);

      if (Number.isFinite(snap.stanceRatio) && (snap.stanceRatio < 0.95 || snap.stanceRatio > 1.55))
        return snap.stanceRatio < 1 ?
          choose(['Wider base; feet shoulder‑width apart.','Open your stance to shoulder‑width.']) :
          choose(['Narrow your stance slightly for balance.','Bring feet in a touch toward shoulder‑width.']);

      if (Number.isFinite(snap.feetToHoopDeg) && snap.feetToHoopDeg > 24)
        return choose(['Square your feet a bit more to the rim.','Point your toes a touch more toward the basket.']);

      if (Number.isFinite(snap.torsoLeanAngle) && Math.abs(snap.torsoLeanAngle) > 14)
        return choose(['Stay taller through your lift.','Keep your torso stacked over your hips.']);

      if (Number.isFinite(snap.footLiftPx) && snap.footLiftPx < 2)
        return choose(['Add a little upward pop as you snap.','Extend through the ankles for a light lift.']);

      if (Number.isFinite(snap.frameOffsetX) && Math.abs(snap.frameOffsetX) > 90)
        return choose(['Center your body line with the rim before you shoot.','Square your chest to the rim before lifting.']);

      // Positive reinforcement when improvements vs average are detected
      try {
        if (Number.isFinite(pAvg.armVertDeg) && Number.isFinite(snap.armVerticalityDeg) && snap.armVerticalityDeg < pAvg.armVertDeg - 4)
          return choose(['Better arm verticality — keep that feel.','Nice tall finish — keep reaching up.']);
        if (Number.isFinite(pAvg.elbowExtDeg) && Number.isFinite(snap.elbowExtDeg) && snap.elbowExtDeg > pAvg.elbowExtDeg + 4)
          return choose(['Stronger extension — good snap.','Great elbow finish — keep extending.']);
        if (Number.isFinite(pAvg.stanceRatio) && Number.isFinite(snap.stanceRatio) && Math.abs(snap.stanceRatio-1.2) < Math.abs(pAvg.stanceRatio-1.2) - 0.1)
          return choose(['More stable base — nice adjustment.','Better stance width — keep that.']);
      } catch {}

      return choose(['Good release — hold your follow‑through.','Solid form — keep that finish high.']);
    } catch { return 'Good release — hold your follow‑through.'; }
  }

  // ---- Developer helper: inspect live pose + last snapshot/gate ----
  try {
    if (typeof window.dumpPoseData !== 'function') {
      window.dumpPoseData = function dumpPoseData(){
        try {
          const now = Date.now();
          const ps = window.playerState || {};
          const keypoints = Array.isArray(ps.keypoints) ? ps.keypoints : [];
          const lastTs = Number(window.__lastPoseTS || 0);
          const lastGate = window.__LAST_GATE?.detail?.tests || null;
          const lastShot = (Array.isArray(window.__shotList) && window.__shotList.length) ? window.__shotList.at(-1) : null;
          const lastHist = (Array.isArray(window.__poseHistory) && window.__poseHistory.length) ? window.__poseHistory.at(-1).snap : null;
          const hoop = window.getLockedHoopBox?.() || null;
          const snap = (function(){ try { return __getPoseSnapshot(); } catch { return null; } })();
          const data = {
            poseDetectorReady: !!window.poseDetector,
            keypointCount: keypoints.length,
            lastPoseAgeMs: lastTs ? (now - lastTs) : null,
            frameHistoryLen: Array.isArray(ps.frameHistory) ? ps.frameHistory.length : 0,
            hoopLocked: !!hoop,
            lastGate,
            snapshot: snap,
            lastShotPoseSnapshot: lastShot?.poseSnapshot || null,
            lastHistorySnapshot: lastHist || null,
          };
          console.log('[pose:dump]', data);
          return data;
        } catch (e) { console.warn('[pose:dump:error]', e); return null; }
      };
    }
  } catch {}

  // ---- Visual overlay: show release pose metrics for quick validation ----
  function showPoseMetricsOverlay(snap, ms = 1800) {
    try {
      const root = (typeof window.ensureHudRoot === 'function') ? window.ensureHudRoot() : (document.getElementById('hudRoot') || (function(){ const d=document.createElement('div'); d.id='hudRoot'; Object.assign(d.style,{position:'fixed',inset:'0',pointerEvents:'none',zIndex:10000}); document.body.appendChild(d); return d; })());
      let box = document.getElementById('poseMetricsHUD');
      if (!box) {
        box = document.createElement('div'); box.id='poseMetricsHUD';
        Object.assign(box.style, {
          position:'absolute', left:'50%', top:'14%', transform:'translateX(-50%)',
          background:'rgba(0,0,0,0.78)', color:'#fff', padding:'10px 12px',
          border:'1px solid rgba(255,255,255,0.15)', borderRadius:'10px',
          font:'600 12px system-ui, -apple-system, Segoe UI, Arial',
          pointerEvents:'none', zIndex:10030, minWidth:'240px', textAlign:'center',
          boxShadow:'0 10px 30px rgba(0,0,0,.35)'
        });
        root.appendChild(box);
      }
      const f = (n, d=1)=> (Number.isFinite(n)? n.toFixed(d): '—');
      const yesNo = (v)=> (v===true?'Yes':(v===false?'No':'—'));
      const html = `
        <div style="font-weight:700; margin-bottom:6px;">Release Pose</div>
        <div style="display:grid; grid-template-columns:auto auto; gap:4px 10px; text-align:left;">
          <div>Arm verticality</div><div>${f(snap.armVerticalityDeg,0)}°</div>
          <div>Elbow extension</div><div>${f(snap.elbowExtDeg,0)}°</div>
          <div>Release > shoulder</div><div>${yesNo(snap.releaseAboveShoulder)}</div>
          <div>Stance ratio</div><div>${f(snap.stanceRatio,2)}×</div>
          <div>Feet → rim</div><div>${f(snap.feetToHoopDeg,0)}°</div>
          <div>Torso lean</div><div>${f(snap.torsoLeanAngle,0)}°</div>
          <div>Foot pop</div><div>${f(snap.footLiftPx,0)} px</div>
          <div>Center offset X</div><div>${f(snap.frameOffsetX,0)} px</div>
        </div>`;
      box.innerHTML = html;
      box.style.opacity = '1'; box.style.display = 'block';
      if (box.__t) clearTimeout(box.__t);
      box.__t = setTimeout(()=>{ try { box.style.opacity='0'; box.style.display='none'; } catch {} }, ms);
    } catch {}
  }

  try {
    if (!window.__coachReleaseWired) {
      window.__coachReleaseWired = true;
      // Fire on strict shot release events (mark seen + reset cooldown first)
      window.addEventListener('shot:release', () => { try { if (window.DOACH_RELEASE_TRACE === true) console.log('[coach:evt] shot:release'); } catch {} try { window.__COACH_HAS_RELEASE = true; window.__COACH_TIP_LAST_AT = 0; } catch {} try { if (window.DOACH_RELEASE_TRACE === true) console.log('[coach:evt] shot:release'); } catch {} assessPoseAndSpeak('shot:release'); });
      // Fallback: if HUD increments shot counter but release speak didn't happen (timing), speak once
      window.addEventListener('hud:shot-taken', () => {
        try {
          if (window.__shotTrackingArmed !== true || window.__hoopConfirmed !== true) return;
          const now = performance.now();
          const last = Number(window.__COACH_LAST_REL_SPEAK || 0);
          if (window.DOACH_RELEASE_TRACE === true) { try { console.log('[coach:evt] hud:shot-taken', { now, last }); } catch {} }
          if (now - last < 500) return; // release path already spoke
          assessPoseAndSpeak('shot:release');
        } catch {}
      });
      // Additional fallback: when HUD score trips but no release event yet, provide a quick tip
      window.addEventListener('hud:score-trip', async () => {
        try {
          if (window.__shotTrackingArmed !== true || window.__hoopConfirmed !== true) return;
          const now = performance.now(); if (window.DOACH_RELEASE_TRACE === true) { try { console.log('[coach:evt] hud:score-trip'); } catch {} }
          const last = Number(window.__COACH_LAST_REL_SPEAK || 0);
          if (now - last < 700) return;
          let s = __getPoseSnapshot();
          if (!s && typeof __samplePoseSnapshotNow === 'function') { try { s = await __samplePoseSnapshotNow(); } catch {} }
          if (s) {
            try { showPoseMetricsOverlay?.(s, Number(window.POSE_METRICS_MS || 1800)); } catch {}
            speakWithAIOrRules(s, 'hud:score-trip');
            try { window.__COACH_LAST_REL_SPEAK = now; } catch {}
          }
        } catch {}
      });
      // Also fire when the HUD/score trip increments (our unified gate for visuals)
      // (No voice on these any more; UI only)
      // window.addEventListener('hud:score-trip', () => assessPoseAndSpeak('hud:score-trip'));
      // window.addEventListener('hud:shot-taken', () => assessPoseAndSpeak('hud:shot-taken'));
      // Add a secondary chance to speak on final summary (per shot)
      window.addEventListener('shot:summary', () => assessPoseAndSpeak('shot:summary'));
      // Removed pose:release voice; rely strictly on shot:release + summary to avoid pre-shot chatter
      // Per-shot reset so the next summary/tip is not suppressed
      window.addEventListener('shot:release', () => { try { if (window.DOACH_RELEASE_TRACE === true) console.log('[coach:evt] shot:release'); } catch {} try { __lastSpokenKey = null; window.__COACH_TIP_LAST_AT = 0; } catch {} });
      window.addEventListener('hud:shot-taken', () => { try { __lastSpokenKey = null; window.__COACH_TIP_LAST_AT = 0; } catch {} });
    }
  } catch {}

  // ---- Session end summary (aggregate pose notes + per‑metric trends) ----
  function summarizeSessionPose() {
    try {
      const list = Array.isArray(window.__shotList) ? window.__shotList : [];
      if (!list.length) return;

      // Helper: safe average over numeric values
      const avg = (arr)=>{
        const a = arr.filter(Number.isFinite);
        return a.length ? (a.reduce((s,v)=>s+v,0)/a.length) : null;
      };
      const round = (n, p=0)=> Number.isFinite(n) ? Number(n.toFixed(p)) : null;

      // Collect snapshots with indices
      const snaps = list.map((s,i)=> ({ i:i+1, snap: s.poseSnapshot||null })).filter(x=>!!x.snap);
      if (!snaps.length) return;

      // Split into early / late halves to detect trends
      const mid = Math.max(1, Math.floor(snaps.length/2));
      const early = snaps.slice(0, mid).map(x=>x.snap);
      const late  = snaps.slice(mid).map(x=>x.snap);

      const pick = (arr, key)=> avg(arr.map(s=> s?.[key]).filter(Number.isFinite));
      const pickBoolPct = (arr, key)=>{
        const vals = arr.map(s=> (typeof s?.[key]==='boolean')? (s[key]?1:0) : null).filter(v=>v!=null);
        return vals.length ? (100*vals.reduce((a,b)=>a+b,0)/vals.length) : null;
      };

      const E = {
        kneeFlex: pick(early,'kneeFlex'), armVert: pick(early,'armVerticalityDeg'), elbow: pick(early,'elbowExtDeg'),
        toes: pick(early,'toeToHoopDeg'), feetDiff: pick(early,'feetAngleDiff'), stagger: pick(early,'footStagger'),
        hold: pick(early,'followThroughHoldFrames'), head: pick(early,'headToHoopDeg'), fingers: pickBoolPct(early,'fingersDown')
      };
      const L = {
        kneeFlex: pick(late,'kneeFlex'), armVert: pick(late,'armVerticalityDeg'), elbow: pick(late,'elbowExtDeg'),
        toes: pick(late,'toeToHoopDeg'), feetDiff: pick(late,'feetAngleDiff'), stagger: pick(late,'footStagger'),
        hold: pick(late,'followThroughHoldFrames'), head: pick(late,'headToHoopDeg'), fingers: pickBoolPct(late,'fingersDown')
      };

      const trends = [];
      // Improvements: knee flex (higher better)
      if (Number.isFinite(E.kneeFlex) && Number.isFinite(L.kneeFlex) && (L.kneeFlex - E.kneeFlex) >= 6)
        trends.push(`Knee flex improved late (${round(L.kneeFlex)}° vs ${round(E.kneeFlex)}°).`);
      // Arm verticality (lower is better)
      if (Number.isFinite(E.armVert) && Number.isFinite(L.armVert) && (E.armVert - L.armVert) >= 4)
        trends.push(`Arm finished taller (vertical) late (${round(L.armVert)}° vs ${round(E.armVert)}°).`);
      // Elbow extension (higher better)
      if (Number.isFinite(E.elbow) && Number.isFinite(L.elbow) && (L.elbow - E.elbow) >= 5)
        trends.push(`Elbow extension strengthened (${round(L.elbow)}° vs ${round(E.elbow)}°).`);
      // Toes → hoop (lower better)
      if (Number.isFinite(E.toes) && Number.isFinite(L.toes) && (E.toes - L.toes) >= 5)
        trends.push(`Feet more square to rim (${round(L.toes)}° vs ${round(E.toes)}°).`);
      // Feet angle diff (lower better)
      if (Number.isFinite(E.feetDiff) && Number.isFinite(L.feetDiff) && (E.feetDiff - L.feetDiff) >= 5)
        trends.push(`Toe angles more parallel (${round(L.feetDiff)}° vs ${round(E.feetDiff)}°).`);
      // Foot stagger (lower better)
      if (Number.isFinite(E.stagger) && Number.isFinite(L.stagger) && (E.stagger - L.stagger) >= 6)
        trends.push(`Stance stagger reduced (${round(L.stagger)}px vs ${round(E.stagger)}px).`);
      // Follow-through hold (higher better)
      if (Number.isFinite(E.hold) && Number.isFinite(L.hold) && (L.hold - E.hold) >= 1)
        trends.push(`Better follow‑through hold late (${round(L.hold)} vs ${round(E.hold)} frames).`);
      // Head on rim (lower better)
      if (Number.isFinite(E.head) && Number.isFinite(L.head) && (E.head - L.head) >= 6)
        trends.push(`Gaze held on rim more consistently (${round(L.head)}° vs ${round(E.head)}°).`);
      // Fingers down (higher % better)
      if (Number.isFinite(E.fingers) && Number.isFinite(L.fingers) && (L.fingers - E.fingers) >= 20)
        trends.push(`Wrist snap improved — fingers down more often (${round(L.fingers)}% vs ${round(E.fingers)}%).`);

      // Most limiting metrics vs simple targets across whole session
      const all = snaps.map(x=>x.snap);
      const A = (key)=> avg(all.map(s=> s?.[key]).filter(Number.isFinite));
      const P = (key)=> pickBoolPct(all, key);
      const lim = [];
      const armVert = A('armVerticalityDeg');      if (Number.isFinite(armVert) && armVert > 14) lim.push('Get the forearm more vertical on finish.');
      const elbow   = A('elbowExtDeg');            if (Number.isFinite(elbow)   && elbow < 150) lim.push('Finish with stronger elbow extension.');
      const knee    = A('kneeFlex');               if (Number.isFinite(knee)    && knee  < 28)  lim.push('Add a bit more knee bend for power.');
      const toes    = A('toeToHoopDeg');           if (Number.isFinite(toes)    && toes  > 22)  lim.push('Square toes a touch more to the rim.');
      const fDiff   = A('feetAngleDiff');          if (Number.isFinite(fDiff)   && fDiff > 12)  lim.push('Make your toes more parallel.');
      const holdF   = A('followThroughHoldFrames');if (Number.isFinite(holdF)   && holdF < 2)   lim.push('Hold the follow‑through briefly.');
      const gaze    = A('headToHoopDeg');          if (Number.isFinite(gaze)    && gaze  > 25)  lim.push('Keep eyes on the rim through release.');
      const above   = P('releaseAboveShoulder');   if (Number.isFinite(above)   && above < 70)  lim.push('Release above the shoulder line.');

      const lines = [];
      if (trends.length) lines.push('Improvements: ' + trends.slice(0,3).join(' '));
      if (lim.length)    lines.push('Focus next: ' + lim.slice(0,3).join(' '));
      if (!lines.length) lines.push('Form was consistent — keep the rhythm and balance.');

      // Shot-specific groups (enumerate where key cues were off)
      try {
        const list = Array.isArray(window.__shotList) ? window.__shotList : [];
        const shots = list.map((s,i)=>({ idx:i+1, p:(s&&s.poseSnapshot)||null })).filter(x=>!!x.p);
        if (shots.length) {
          const g = (window.DOACH_MEM?.get?.()?.golden) || { stanceWidthFeet:120, kneeFlex:28, toeToHoopDeg:18, feetAngleDiff:8, feetStagger:6, shoulderToWristAngle:55, releaseAboveShoulder:true };
          const pickIdx = (pred) => shots.filter(({p}) => pred(p)).map(({idx}) => idx);
          const fmt = (arr) => arr.slice(0,6).join(', ');
          const followShort = pickIdx(p => Number.isFinite(p.followThroughHoldFrames) && p.followThroughHoldFrames < 2);
          const feetNarrow  = pickIdx(p => Number.isFinite(p.stanceWidthFeet) && g.stanceWidthFeet && (p.stanceWidthFeet < g.stanceWidthFeet - 20));
          const feetWide    = pickIdx(p => Number.isFinite(p.stanceWidthFeet) && g.stanceWidthFeet && (p.stanceWidthFeet > g.stanceWidthFeet + 20));
          const toesOff     = pickIdx(p => (Number.isFinite(p.toeToHoopDeg) && p.toeToHoopDeg > 22) || (Number.isFinite(p.feetAngleDiff) && p.feetAngleDiff > (g.feetAngleDiff||8) + 6));
          const staggerHi   = pickIdx(p => Number.isFinite(p.footStagger) && p.footStagger > (g.feetStagger||6) + 10);
          const armLow      = pickIdx(p => (Number.isFinite(p.shoulderToWristAngle) && p.shoulderToWristAngle < (g.shoulderToWristAngle||55) - 8) || (Number.isFinite(p.armVerticalityDeg) && p.armVerticalityDeg > 14));
          const elbowLow    = pickIdx(p => Number.isFinite(p.elbowExtDeg) && p.elbowExtDeg < 150);
          const belowSh     = pickIdx(p => (g.releaseAboveShoulder ?? true) && p.releaseAboveShoulder === false);
          const kneeLow     = pickIdx(p => Number.isFinite(p.kneeFlex) && p.kneeFlex < (g.kneeFlex||28) * 0.75);
          const gazeOff     = pickIdx(p => Number.isFinite(p.headToHoopDeg) && p.headToHoopDeg > 25);

          const bullets = [];
          if (followShort.length) bullets.push(`Follow‑through short on shots ${fmt(followShort)} — hold 1–2 beats longer.`);
          if (feetNarrow.length)  bullets.push(`Base narrow on shots ${fmt(feetNarrow)} — widen a touch.`);
          if (feetWide.length)    bullets.push(`Base wide on shots ${fmt(feetWide)} — narrow slightly.`);
          if (toesOff.length)     bullets.push(`Toes off-square on shots ${fmt(toesOff)} — align feet to rim.`);
          if (staggerHi.length)   bullets.push(`Feet staggered on shots ${fmt(staggerHi)} — level your base.`);
          if (armLow.length)      bullets.push(`Arm line low on shots ${fmt(armLow)} — finish taller.`);
          if (elbowLow.length)    bullets.push(`Elbow not fully extended on shots ${fmt(elbowLow)} — lock out at finish.`);
          if (belowSh.length)     bullets.push(`Release below shoulder on shots ${fmt(belowSh)} — finish above shoulder.`);
          if (kneeLow.length)     bullets.push(`Limited knee bend on shots ${fmt(kneeLow)} — add a bit more power.`);
          if (gazeOff.length)     bullets.push(`Gaze off rim on shots ${fmt(gazeOff)} — keep eyes on rim through release.`);

          if (bullets.length) {
            lines.push('Notable patterns: ' + bullets.slice(0,3).join(' '));
          }
        }
      } catch {}

      // Always deliver the session review regardless of DOACH_ONLY_REALTIME.
      const out = `Session review. ${lines.join(' ')}`;
      try { window.__lastCoachText = out; } catch {}
      try { const el = (typeof ensureCoachNotes === 'function') ? ensureCoachNotes() : document.getElementById('coachNotes'); if (el) { el.style.display='block'; el.style.zIndex='10070'; el.textContent = out; } } catch {}
      try { (window.doachSpeak || window.coachSpeak || (txt=>{ try{ const u=new SpeechSynthesisUtterance(txt); window.speechSynthesis?.speak(u);}catch{} }))(out); window.__SESSION_REVIEW_SPOKEN = true; } catch {}
    } catch {}
  }

  // Auto speak summary when HUD ends a session
  try {
    window.addEventListener('hud:end-session', () => {
      // Allow a moment so the last summary + snapshots settle and audio finish
      setTimeout(() => { try { summarizeSessionPose(); } catch {} }, 1200);
      // Failsafe: if nothing spoke yet, try again a bit later
      setTimeout(() => { try { if (!window.__SESSION_REVIEW_SPOKEN) summarizeSessionPose(); } catch {} }, 2500);
    });
    // Enable live tips when armed (force on, every shot)
    window.addEventListener('hud:armed', () => {
      try { window.PREF_LIVE_TIPS = true; } catch {}
      try { window.COACH_TIP_EVERY_N = 1; } catch {}
      try { window.COACH_TIP_PROB = 1.0; } catch {}
      try { window.COACH_TIP_MIN_MS = 200; } catch {}
    });
    // Reset tip cooldown per shot so every shot can speak
    window.addEventListener('hud:shot-taken', () => { try { window.__COACH_TIP_LAST_AT = 0; } catch {} });
    window.addEventListener('shot:summary', () => { try { window.__COACH_TIP_LAST_AT = 0; } catch {} });
    // Optional kickoff line on countdown (disabled by default)
    window.addEventListener('hud:arm-countdown', () => { try { if (window.PREF_COACH_INTRO === true) coachSpeak("Let's get started. Get into position and shoot when ready."); } catch {} });
  } catch {}

  // ---- Pref bridges (new) ----
  // Read new UI prefs if present; fall back to older doachPrefs values.
  function isAudioOn() {
    if (typeof window.PREF_AUDIO_ENABLED !== 'undefined') return !!window.PREF_AUDIO_ENABLED;
    const p = doachGetPrefs();                 // legacy store
    return (p.audioOn !== false);              // default true
  }
  function isMicAllowed() {
    if (typeof window.PREF_ALLOW_MIC !== 'undefined') return !!window.PREF_ALLOW_MIC;
    const p = doachGetPrefs();
    return (p.allowMic !== false);             // default true
  }


  // ---------- Prefs + Presets ----------
  const LS_KEY = 'doachPrefs';

  const getAC = () => (window.__doachAC ||= new (window.AudioContext||window.webkitAudioContext)());


  function doachGetPrefs() {
    try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; }
    catch { return {}; }
  }

  function doachSetPrefs(p) {
    const v = p || {};
    localStorage.setItem(LS_KEY, JSON.stringify(v));
    window.__doachPrefs = v;
    return v;
  }

  //  Doach Memory   ------------------------------------- //
  const MEM_KEY = 'doachMemoryV1';

  function memLoad(){
    try { return JSON.parse(localStorage.getItem(MEM_KEY)) || { made:[], miss:[], golden:null, lastShot:null }; }
    catch { return { made:[], miss:[], golden:null, lastShot:null }; }
  }
  function memSave(m){ localStorage.setItem(MEM_KEY, JSON.stringify(m)); return m; }
  function mean(arr){ return arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : null; }
  function clamp(n,a,b){ return Math.max(a, Math.min(b,n)); }

  function computeGolden(made){
    if (!made.length) return null;
    const take = made.slice(-30); // last N made shots
    const pick = k => take.map(s => s.poseSnapshot?.[k]).filter(v => Number.isFinite(v));
    const g = {
      stanceWidth      : mean(pick('stanceWidth')),
      stanceWidthFeet  : mean(pick('stanceWidthFeet')),
      kneeFlex         : mean(pick('kneeFlex')),
      torsoLeanAngle   : mean(pick('torsoLeanAngle')),
      shoulderToWristAngle: mean(pick('shoulderToWristAngle')),
      feetAngleDiff    : mean(pick('feetAngleDiff')),
      feetStagger      : mean(pick('feetStagger')),
      releaseAboveShoulder: take.filter(s => s.poseSnapshot?.releaseAboveShoulder).length / take.length >= 0.6,
      entryAngle       : mean(take.map(s => s.entryAngle).filter(Number.isFinite)),
      arcHeight        : mean(take.map(s => s.arcHeight).filter(Number.isFinite)),
      arcHeightNorm    : mean(take.map(s => s.arcHeightNorm).filter(Number.isFinite)),
      apexRiseFromRelease: mean(take.map(s => s.apexRiseFromRelease).filter(Number.isFinite)),
      apexRiseFromReleaseNorm: mean(take.map(s => s.apexRiseFromReleaseNorm).filter(Number.isFinite)),
      count: take.length
    };
    return g;
  }

  function addShotToMemory(shot){
    shot.ts = shot.ts || Date.now();
    const m = memLoad();
    m.lastShot = shot;
    if (shot.made) m.made.push(shot);
    else m.miss.push(shot);
    // trim
    if (m.made.length > 200) m.made = m.made.slice(-200);
    if (m.miss.length > 200) m.miss = m.miss.slice(-200);
    m.golden = computeGolden(m.made) || m.golden;
    memSave(m);
    return m;
  }

  window.DOACH_MEM = {
    get: memLoad,
    addShot: addShotToMemory,
    golden: () => memLoad().golden,
    reset: () => memSave({made:[],miss:[],golden:null,lastShot:null}),
    lastShot: () => memLoad().lastShot,
    recent: (n=10) => {
      const m = memLoad();
      const all = [...m.made, ...m.miss].filter(Boolean).sort((a,b)=> (a.ts||0)-(b.ts||0));
      return all.slice(-n);
    },
    reset: () => memSave({made:[],miss:[],golden:null,lastShot:null})
    };

  // Receives native transcripts (from the iOS wrapper)
  window.handleVoiceTranscript = async (text) => {
    const lower = (text || '').toLowerCase();
    // Reuse your wake-word/capture logic, or just route to your Q&A:
    try {
      if (/\b(end (the )?session|i'?m done|finish session)\b/.test(lower)) {
        window.dispatchEvent(new CustomEvent('hud:end-session'));
        return;
      }
      if (/\b(start (a )?new session|new session|begin session|start session)\b/.test(lower)) {
        window.dispatchEvent(new CustomEvent('hud:start-session'));
        return;
      }
    } catch {}
    if (doachSpeak) coachSpeak(`You said: ${text}`);
    // window.webkit?.messageHandlers?.doach?.postMessage({action: 'startVoice'})
  };

  // Export on window
  window.doachGetPrefs = doachGetPrefs;
  window.doachSetPrefs = doachSetPrefs;

  function getPrefs(){ try{ return JSON.parse(localStorage.getItem(LS_KEY))||{}; }catch{ return {}; } }
  function setPrefs(p){ localStorage.setItem(LS_KEY, JSON.stringify(p)); window.__doachPrefs=p; return p; }

  async function loadPresets(){
    try{ const r=await fetch('/api/voice_presets'); if(!r.ok) throw 0; const j=await r.json(); return Array.isArray(j.presets)?j.presets:[]; }
    catch{ try{ return JSON.parse(localStorage.getItem(LS_PRESETS))||[]; }catch{ return []; } }
  }
  async function savePreset(preset){
    try{ const r=await fetch('/api/voice_presets',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({preset})}); if(!r.ok) throw 0; return true; }
    catch{ const a=await loadPresets(); const i=a.findIndex(x=>x.name===preset.name); if(i>=0)a[i]=preset; else a.push(preset); localStorage.setItem(LS_PRESETS,JSON.stringify(a)); return true; }
  }
  async function deletePreset(name){
    try{ const r=await fetch('/api/voice_presets/'+encodeURIComponent(name),{method:'DELETE'}); if(!r.ok) throw 0; return true; }
    catch{ const a=await loadPresets(); localStorage.setItem(LS_PRESETS, JSON.stringify(a.filter(x=>x.name!==name))); return true; }
  }
  window.doachLoadPresets=loadPresets; window.doachSavePreset=savePreset; window.doachDeletePreset=deletePreset;


  // a better robot ----------------------------------------- //
  // --- Natural coaching line generator (varied, metric-aware)
  function seededRandom(seed){ const x = Math.sin(seed*9301+49297)*233280; return x - Math.floor(x); }
  function pick(arr, seed){ return arr[Math.floor(seededRandom(seed)*arr.length)] || arr[0]; }

  function craftCoachingLine(shot, golden, opts={}) {
    const p = shot.poseSnapshot || {};
    const seed = (shot.ts || Date.now()) + (opts.bumpSeed ? 101 : 0);

    // strengths for positive first sentence
    const strengths = [];
    if (p.releaseAboveShoulder) strengths.push('high release');
    if (Number.isFinite(p.shoulderToWristAngle) && p.shoulderToWristAngle >= 50) strengths.push('vertical arm');
    if (Number.isFinite(p.kneeFlex) && p.kneeFlex >= (golden?.kneeFlex || 28) * 0.8) strengths.push('good knee load');
    if (Number.isFinite(p.stanceWidthFeet) && golden?.stanceWidthFeet &&
        Math.abs(p.stanceWidthFeet - golden.stanceWidthFeet) <= 15) strengths.push('balanced base');
    if (Number.isFinite(shot.entryAngle) && golden?.entryAngle &&
        Math.abs(shot.entryAngle - golden.entryAngle) <= 4) strengths.push('target entry angle');

    const first = phrasePraise(strengths, seed);

    // pick best cue with variety
    const issues = buildIssues(shot, golden);
    const chosen = chooseCue(issues);
    const cueTxt = chosen ? chosen.msg : 'Hold your follow-through for a count.';
    const bridges = ['Quick cue:', 'Small tweak:', 'Next rep,', 'Dial this in:'];
    const bridge = bridges[ seed % bridges.length ];

    return `${first} ${bridge} ${cueTxt}`;
  }

  function craftMissLine(shot, golden, opts={}) {
    const seed = (shot.ts || Date.now()) + (opts.bumpSeed ? 303 : 0);
    const openers = ['Good look.', 'Right idea.', 'Close.', 'Almost.', 'Not far off.'];
    const opener = openers[ seed % openers.length ];

    const issues = buildIssues(shot, golden);
    const chosen = chooseCue(issues);
    const cueTxt = chosen ? chosen.msg : 'Load a touch more with your knees and finish high.';
    const bridges = ['Fix this next:', 'Quick cue:', 'Small tweak:', 'Next rep,'];
    const bridge = bridges[(seed+1) % bridges.length];

    return `${opener} ${bridge} ${cueTxt}`;
  }

  // ---- Issue builder with severity + category (new)
  function buildIssues(shot, golden) {
    const p = shot?.poseSnapshot || {};
    const g = golden || {
      stanceWidthFeet: 120, kneeFlex: 28, torsoLeanAngle: 0, shoulderToWristAngle: 55,
      feetAngleDiff: 8, feetStagger: 6, releaseAboveShoulder: true, entryAngle: 48, arcHeight: 120
    };

    const issues = [];
    const push = (cat, severity, msg) => { if (severity > 0) issues.push({cat, severity, msg}); };

    // Feet width
    if (Number.isFinite(p.stanceWidthFeet) && g.stanceWidthFeet) {
      const d = (p.stanceWidthFeet - g.stanceWidthFeet);
      const ad = Math.abs(d);
      if (ad > 35) push('feetWidth', 9, d < 0 ? 'Feet too narrow — widen ~2–3".' : 'Feet too wide — bring them in slightly.');
      else if (ad > 20) push('feetWidth', 6, d < 0 ? 'Open your base a touch for balance.' : 'Narrow your base slightly to stay stacked.');
    }

    // Feet alignment / stagger
    if (Number.isFinite(p.feetAngleDiff)) {
      const over = p.feetAngleDiff - (g.feetAngleDiff||8);
      if (over > 10) push('feetAngle', 7, 'Square both toes to the rim.');
      else if (over > 5) push('feetAngle', 5, 'Make your toes more parallel.');
    }
    if (Number.isFinite(p.feetStagger)) {
      const over = p.feetStagger - (g.feetStagger||6);
      if (over > 16) push('feetStagger', 6, 'Level your feet — reduce the front/back stagger.');
      else if (over > 10) push('feetStagger', 4, 'Even out your stance front-to-back.');
    }

    // Lower-body power
    if (Number.isFinite(p.kneeFlex)) {
      const ratio = p.kneeFlex / (g.kneeFlex||28);
      if (ratio < 0.6) push('power', 10, 'Add more knee bend to generate power.');
      else if (ratio < 0.8) push('power', 7, 'Dip a touch more with the knees.');
    }

    // Torso lean
    if (Number.isFinite(p.torsoLeanAngle)) {
      const a = Math.abs(p.torsoLeanAngle);
      if (a > 22) push('torso', 6, 'Stay taller through the lift.');
      else if (a > 18) push('torso', 4, 'Slightly more upright through the shot.');
    }

    // Arm / release
    if (Number.isFinite(p.shoulderToWristAngle)) {
      const d = (g.shoulderToWristAngle||55) - p.shoulderToWristAngle;
      if (d > 12) push('releaseArm', 8, 'Get the shooting arm more vertical on release.');
      else if (d > 6) push('releaseArm', 5, 'Finish with a taller arm line.');
    }
    if ((g.releaseAboveShoulder ?? true) && !p.releaseAboveShoulder) {
      push('releaseHeight', 7, 'Release above your shoulder line.');
    }
    if (p.wristY!=null && p.elbowY!=null && p.wristY > p.elbowY + 10) {
      push('wristFinish', 6, 'Snap the wrist high — finish above the elbow.');
    }

    // Ball metrics
    if (Number.isFinite(shot.entryAngle) && g.entryAngle) {
      const d = shot.entryAngle - g.entryAngle;
      if (d < -6) push('entryFlat', 9, 'Entry angle is flat — add arc.');
      else if (d > 6) push('entrySteep', 7, 'Entry angle is steep — soften the arc.');
    } else if (Number.isFinite(shot.entryAngle)) {
      if (shot.entryAngle < 44) push('entryFlat', 8, 'A bit flat — add arc.');
      else if (shot.entryAngle > 54) push('entrySteep', 6, 'A tad steep — soften the arc.');
    }

    // arc height vs golden
    if (Number.isFinite(shot.arcHeight) && g.arcHeight) {
      const d = shot.arcHeight - g.arcHeight;
      if (d < -20) push('arcLow', 6, 'Lift the arc slightly (more upward energy).');
      else if (d > 30) push('arcHigh', 4, 'Flatten the arc a touch (drive forward).');
    }

    // apex rise vs golden (power on release)
    if (Number.isFinite(shot.apexRiseFromRelease) && g.apexRiseFromRelease) {
      const d = shot.apexRiseFromRelease - g.apexRiseFromRelease;
      if (d < -18) push('powerLow', 9, 'Add power on release — drive up through the ball.');
      else if (d < -10) push('powerLow', 6, 'A touch more upward energy on release.');
    }
    if (Number.isFinite(shot.apexRiseFromReleaseNorm) && g.apexRiseFromReleaseNorm) {
      const d = shot.apexRiseFromReleaseNorm - g.apexRiseFromReleaseNorm;
      if (d < -0.15) push('powerLow', 9, 'Increase lift — get more rise before the apex.');
    }

    // Sort by severity descending
    issues.sort((a,b)=> b.severity - a.severity);
    return issues;
  }

  // Pick a cue with variety (avoid repeating same category)
  function chooseCue(issues) {
    if (!issues.length) return null;
    const hist = (window.__coachCueHistory ||= []);
    const lastCat = hist[hist.length - 1];
    let pick = issues[0];

    // If top issue repeats last category and we have alternatives, pick next best
    if (issues.length > 1 && pick.cat === lastCat) pick = issues[1];

    // Track history (cap)
    hist.push(pick.cat);
    if (hist.length > 6) window.__coachCueHistory = hist.slice(-6);

    return pick;
  }

  // Light variety wrappers
  function phrasePraise(strengths, seed) {
    const opens = ['Money.', 'Buckets.', 'Splash.', 'Nice make.', 'There it is.', 'Cash.'];
    const connectors = ['Lock that in.', 'That’s repeatable.', 'Keep that feel.', 'Love that tempo.'];
    const r = (n)=> Math.floor((Math.sin((seed+n)*9301+49297)*233280)%opens.length + opens.length) % opens.length;
    const r2= (n)=> Math.floor((Math.sin((seed+n)*7411+19333)*233280)%connectors.length + connectors.length) % connectors.length;
    const opener = opens[r(1)];
    const praise = strengths?.length ? `Nice ${strengths[r2(2)%strengths.length]}.` : connectors[r2(3)];
    return `${opener} ${praise}`;
  }

  // keep a tiny history so we don’t repeat exact lines back-to-back
  window.__coachLineHistory = [];
  function avoidRepeat(text, shot, golden, made) {
    const recent = window.__coachLineHistory.slice(-4);
    if (recent.includes(text)) {
      return (made ? craftCoachingLine : craftMissLine)(shot, golden, { bumpSeed: true });
    }
    return text;
  }

  // ---------- Web Speech voices ----------
  let webVoices=[];
  function refreshVoices(){ webVoices = window.speechSynthesis?.getVoices?.()||[]; return webVoices; }
  if('speechSynthesis' in window){ speechSynthesis.onvoiceschanged = refreshVoices; refreshVoices(); }
  window.doachListWebVoices = (lang='') => {
    const v=refreshVoices();
    return lang ? v.filter(x => (x.lang||'').toLowerCase().startsWith(lang.toLowerCase())) : v;
  };

  // ---------- OpenAI TTS + WebAudio EQ ----------
  async function ttsFetchBlob(text, voice){
    const res = await fetch(DOACH.ttsEndpoint,{
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ text, voice: voice||'alloy' }),
      credentials:'include'
    });
    if(!res.ok){ const t=await res.text().catch(()=> ''); throw new Error(`TTS failed: ${res.status} ${t}`.trim()); }
    return await res.blob();
  }
  async function playWithEQ(blob, p){
    const ctx = getAC();
    const arr = await blob.arrayBuffer();
    const buf = await ctx.decodeAudioData(arr);
    const src = ctx.createBufferSource(); src.buffer = buf;

    const bass = ctx.createBiquadFilter(); bass.type='lowshelf';  bass.frequency.value=180;  bass.gain.value = p?.bassDb ?? 0;
    const tre  = ctx.createBiquadFilter(); tre.type='highshelf'; tre.frequency.value=3000; tre.gain.value  = p?.trebleDb ?? 0;
    const gain = ctx.createGain();         gain.gain.value = p?.volume ?? 1;

    src.playbackRate.value = p?.speed ?? 1;
    src.connect(bass); bass.connect(tre); tre.connect(gain); gain.connect(ctx.destination);
    src.start(0);
    return new Promise(r => src.onended = r);
  }

  // ---------- Web Speech playback ----------
  async function speakWeb(text, p){
    if(!('speechSynthesis' in window)) throw new Error('Web Speech not supported');
    const u = new SpeechSynthesisUtterance(text);
    u.lang   = p?.lang   || 'en-US';
    u.rate   = p?.speed  ?? 1;
    u.pitch  = p?.pitch  ?? 1;
    u.volume = p?.volume ?? 1;
    if(p?.webVoiceName){
      const v = webVoices.find(v => v.name===p.webVoiceName && (!p.lang || v.lang.startsWith(p.lang)));
      if(v) u.voice = v;
    }
    return new Promise((res,rej)=>{ u.onend=res; u.onerror=e=>rej(e.error||e); speechSynthesis.speak(u); });
  }

  // ---------- Auto-translate for OpenAI TTS (text drives language) ----------
  async function translateIfNeeded(text, lang){
    if(!lang || lang.startsWith('en')) return text;
    try{
      const r = await fetch(DOACH.chatEndpoint, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ prompt:`Translate to ${lang}. Keep coaching tone. Only output the sentence:\n\n${text}`, model: DOACH.model })
      });
      if(!r.ok) return text; const j=await r.json(); return (j.text||text).trim();
    }catch{ return text; }
  }

  // ---------- Capture pose content for analysis ----------
  window.capturePoseSnapshot = function(playerState, hoopBox){
    try{
      const kp = playerState?.keypoints||[];
      // BlazePose indices
      const NOSE=0, L_SHOULDER=11,R_SHOULDER=12,L_ELBOW=13,R_ELBOW=14,L_WRIST=15,R_WRIST=16;
      const L_HIP=23,R_HIP=24,L_KNEE=25,R_KNEE=26,L_ANK=27,R_ANK=28,L_HEEL=29,R_HEEL=30,L_TOE=31,R_TOE=32;

      const need = [L_SHOULDER,R_SHOULDER,L_ELBOW,R_ELBOW,L_WRIST,R_WRIST,L_HIP,R_HIP,L_KNEE,R_KNEE,L_ANK,R_ANK,L_TOE,R_TOE]
        .every(i => kp[i]?.x!=null && kp[i]?.y!=null);
      if(!need) return null;

      const avg = (a,b)=>({x:(a.x+b.x)/2,y:(a.y+b.y)/2});
      const shoulder=avg(kp[L_SHOULDER],kp[R_SHOULDER]);
      const elbow   = avg(kp[L_ELBOW],kp[R_ELBOW]);
      const wrist   = avg(kp[L_WRIST],kp[R_WRIST]);
      const hip     = avg(kp[L_HIP],kp[R_HIP]);
      const knee    = avg(kp[L_KNEE],kp[R_KNEE]);
      const ank     = avg(kp[L_ANK],kp[R_ANK]);

      const deg = r => Math.round(r*180/Math.PI);
      const angleDeg=(a,b)=>deg(Math.atan2(a.y-b.y, b.x-a.x));   // vertical-ish measure
      const signed  =(a,b)=>deg(Math.atan2(b.y-a.y, b.x-a.x));   // signed around body

      // Feet angles (ankle → toe) and differences / stagger
      const footAngle = (ankle, toe) => deg(Math.atan2(toe.y-ankle.y, toe.x-ankle.x));
      const leftFootAngle  = footAngle(kp[L_ANK], kp[L_TOE]);
      const rightFootAngle = footAngle(kp[R_ANK], kp[R_TOE]);
      const feetAngleDiff  = Math.abs(leftFootAngle - rightFootAngle);
      const feetStagger    = Math.abs(kp[L_ANK].y - kp[R_ANK].y);

      // Useful metrics
      const stanceWidthFeet = Math.abs(kp[L_ANK].x - kp[R_ANK].x);
      const stanceWidthHip  = Math.abs(kp[L_HIP].x - kp[R_HIP].x); // keep your legacy
      const kneeFlex        = Math.max(0, (knee.y - hip.y));       // px: bigger = more bend
      const torsoLeanAngle  = signed(hip, shoulder);               // + forward, - backward
      const shoulderToWristAngle = angleDeg(shoulder, wrist);      // higher = more vertical arm
      const releaseAboveShoulder = (wrist.y + elbow.y)/2 < shoulder.y; // y-up is negative screen

      const wristToHoop = hoopBox
        ? Math.hypot((hoopBox.x + (hoopBox.w||0)/2) - wrist.x, (hoopBox.y + (hoopBox.h||0)/2) - wrist.y)
        : null;

      return {
        // keep old names so your code keeps working
        stanceWidth: stanceWidthHip,
        kneeFlex,
        torsoLeanAngle,
        shoulderToWristAngle,
        wristToHoop,

        // NEW: explicit heights for your rating rules
        wristY: wrist.y, elbowY: elbow.y, shoulderY: shoulder.y,
        releaseAboveShoulder,

        // NEW: feet metrics
        stanceWidthFeet,
        leftFootAngle, rightFootAngle, feetAngleDiff, feetStagger
      };
    }catch{ return null; }
  };

  //LLM helper
  function composeLLMPrompt(shot, golden, draftLine, made, personality) {
    const ctx = {
      metrics: {
        arcHeight: Math.round(shot.arcHeight || 0),
        entryAngle: shot.entryAngle ?? null,
        releaseAngle: shot.releaseAngle ?? null
      },
      pose: shot.poseSnapshot || null,
      golden: golden || null,
      lastCategories: (window.__coachCueHistory || []).slice(-3)
    };

    return `
  You are Doach, a ${personality} shooting coach.

  Write a single pose-focused coaching cue (one short sentence).
  - Base the cue entirely on pose metrics; ignore shot outcome or make/miss info.
  - Highlight the most important mechanical adjustment.
  - Use whole-number metrics when helpful.
  - Avoid repeating any of: ${JSON.stringify(ctx.lastCategories)} if another issue is equally important.
  - Keep it concrete and actionable.
  - No emojis. No bullet points.

  Context (JSON):
  ${JSON.stringify(ctx)}
  ${draftLine ? `
Draft to refine (optional): '${draftLine}'` : ''}

  Return only the final coaching line.
  `.trim();
  }


  // analyze shot pose
  window.doachOnShot = async function(shot){
  try{
    if (!shot.poseSnapshot && window.playerState) {
      shot.poseSnapshot = window.capturePoseSnapshot(window.playerState, window.getLockedHoopBox?.());
    }
    shot.ts = shot.ts || Date.now();

    const mem    = window.DOACH_MEM.get();
    const golden = mem.golden;
    const made   = !!shot.made;
    const poseOnly = DOACH.poseOnly === true;

    // Local draft (pose-only taps pose heuristics; otherwise keep legacy flow)
    let localText;
    if (poseOnly) {
      const snap = shot.poseSnapshot || null;
      const poseLine = snap && typeof composePoseFeedback === 'function' ? composePoseFeedback(snap) : null;
      const issues = window.summarizePoseIssues?.(shot, golden) || [];
      const fallbackPose = issues.filter(Boolean).slice(0, 3).join(' ');
      localText = poseLine || fallbackPose || 'Pose metrics captured.';
    } else {
      localText = made ? craftCoachingLine(shot, golden) : craftMissLine(shot, golden);
      localText = avoidRepeat(localText, shot, golden, made);
    }

    // Choose how to use the LLM
    const mode = (window.DOACH?.llmMode || 'polish').toLowerCase();
    let text = localText;
    const inferShotIdx0 = () => {
      try { if (Number.isFinite(Number(shot?.coachIdx))) return Number(shot.coachIdx); } catch {}
      try { if (Number.isFinite(Number(shot?.idx))) return Number(shot.idx); } catch {}
      try { if (Number.isFinite(Number(shot?.__idx))) return Number(shot.__idx) - 1; } catch {}
      try { if (Number.isFinite(Number(window.__SHOT_IDX))) return Number(window.__SHOT_IDX); } catch {}
      try {
        const n = getShotNumber?.(); // 1-based if available
        if (Number.isFinite(n) && n > 0) return n - 1;
      } catch {}
      try {
        const len = (window.__shotList?.length || 0);
        if (len > 0) return Math.max(0, len - 1);
      } catch {}
      return 0;
    };
    const sendCoachFinalize = (finalLine) => {
      try {
        const sid = window.__SESSION_ID || null;
        if (!sid || !finalLine) return;
        const idxFinal = Number(inferShotIdx0());
        if (!Number.isFinite(idxFinal)) return;
        const poseOnly = DOACH?.poseOnly === true;
        const payload = {
          sid,
          shot_idx: idxFinal,
          text: finalLine,
          model: poseOnly ? 'pose-summary' : (window.DOACH?.model || 'coach-final'),
          provider: poseOnly ? 'pose' : (window.DOACH?.llmMode || 'final')
        };
        queueMicrotask(() => {
          try {
            fetch('/api/coach/finalize', {
              method:'POST',
              headers:{'Content-Type':'application/json'},
              body: JSON.stringify(payload),
              credentials:'include'
            }).catch(() => {});
          } catch {}
        });
      } catch {}
    };

    if (!poseOnly && mode !== 'off' && window.DOACH?.chatEndpoint) {
      try {
        const prompt = composeLLMPrompt(
          shot, golden,
          mode === 'polish' ? localText : '', // primary: no draft; polish: send draft
          made,
          window.DOACH?.personality || 'positive, concise'
        );
        const r = await fetch(window.DOACH.chatEndpoint, {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ prompt, model: window.DOACH.model, temperature: 0.8 })
        });
        const j = await r.json();
        const llm = (j?.text || '').trim();
        if (llm) text = llm;
      } catch (e) {
        // silent fallback to local
      }
    }

    // Final de-dup + remember line
    text = avoidRepeat(text, shot, golden, made);
    window.__coachLineHistory.push(text);
    if (window.__coachLineHistory.length > 12) window.__coachLineHistory = window.__coachLineHistory.slice(-12);

    // Persist to last shot (for table) and update modal cell if present
    window.__lastCoachText = text;
    try {
      const list = window.__shotList || [];
      const last = list[list.length - 1];
      if (last) {
        last.doach = text;
        const idx = last.__idx ?? list.length;
        const modal = document.getElementById('fullShotModal');
        if (modal) {
          const cell =
            modal.querySelector(`tbody tr[data-shot-idx="${idx}"] td.coach`) ||
            modal.querySelector('tbody tr:last-child td.coach');
          if (cell) { cell.textContent = text; cell.title = text; }
        }
      }
    } catch (e) { console.warn('[doach] coach text UI update failed:', e); }

    const el = document.getElementById('coachNotes');
    if (el) { el.style.display='block'; el.textContent = text; }
    const now = Date.now();
      if (text === __lastSpeak.text && (now - __lastSpeak.at) < SPEAK_DEDUP_MS) {
        return; // skip duplicate speak
      }
      __lastSpeak = { text, at: now };
    // Realtime-only: do not speak table/summary lines; leave UI text only
    if (!window.DOACH_ONLY_REALTIME) {
      queueMicrotask(() => doachSpeak?.(text));
    }

  }catch(e){ console.warn('[doachOnShot]', e); }
};


  //  Pass analysis to memory  ------------------------------- //
  window.updateCoachNotes = function updateCoachNotes(shot) {
    const container = document.getElementById('coachNotes');
    if (!container || !shot) return;

    const mem = window.DOACH_MEM.get();
    const golden = mem.golden;
    const tips = window.summarizePoseIssues?.(shot, golden) || [];
    const rating = window.computeShotRating?.(shot.poseSnapshot, golden) ?? 50;

    let html = `
      <strong>🤖 Coach Feedback</strong><br>
      <div style="font-size: 18px; margin-bottom: 6px;">
        🏅 Shot Rating: <strong style="color:${rating >= 80 ? 'lightgreen' : rating >= 50 ? 'orange' : 'red'}">${rating}/100</strong>
        ${golden ? `<span style="opacity:.7;">(vs ${golden.count} reference shots)</span>` : ``}
      </div>
      ${tips.length ? `<ul>${tips.map(t => `<li>${t}</li>`).join('')}</ul>`
                    : `<span style="color:lightgreen;">✅ No major pose issues detected.</span>`}
    `;
    if (shot.discarded) {
      html = `<div style="color: orange; font-weight: bold; margin-bottom: 6px;">
        ⚠️ Shot was discarded: ${shot.missReason || 'No reason provided'}
      </div>` + html;
    }

    container.style.display = 'block';
    container.innerHTML = html;
    container.style.backgroundColor = 'rgba(0,0,0,0.9)';
    container.style.border = '1px solid lime';
    };

  window.computeShotRating = function computeShotRating(pose, golden){
    const clamp = (n,a,b) => Math.max(a, Math.min(b, n));
    if (!pose) return 50;
    // If we have a golden pose, score vs golden; else use sensible defaults
    const g = golden || {
      stanceWidthFeet: 120, kneeFlex: 28, torsoLeanAngle: 0, shoulderToWristAngle: 55,
      feetAngleDiff: 8, feetStagger: 6, releaseAboveShoulder: true
    };

    let score = 100;
    const penal = (amt) => { score -= amt; };

    // Feet: width, alignment, stagger
    if (g.stanceWidthFeet){
      const d = Math.abs((pose.stanceWidthFeet||g.stanceWidthFeet) - g.stanceWidthFeet);
      if (d > 35) penal(10); else if (d > 20) penal(5);
    }
    if (Number.isFinite(pose.feetAngleDiff)){
      if (pose.feetAngleDiff > (g.feetAngleDiff||8) + 8) penal(8);
      else if (pose.feetAngleDiff > (g.feetAngleDiff||8) + 4) penal(4);
    }
    if (Number.isFinite(pose.feetStagger) && pose.feetStagger > (g.feetStagger||6) + 10) penal(6);

    // Lower body power
    if (Number.isFinite(pose.kneeFlex)){
      if (pose.kneeFlex < (g.kneeFlex||28) * 0.6) penal(12);
      else if (pose.kneeFlex < (g.kneeFlex||28) * 0.8) penal(6);
    }

    // Torso
    if (Number.isFinite(pose.torsoLeanAngle) && Math.abs(pose.torsoLeanAngle) > 18) penal(8);

    // Arm / release
    if (Number.isFinite(pose.shoulderToWristAngle)){
      if (pose.shoulderToWristAngle < (g.shoulderToWristAngle||55) - 12) penal(10);
      else if (pose.shoulderToWristAngle < (g.shoulderToWristAngle||55) - 6) penal(5);
    }
    if (pose.wristY!=null && pose.elbowY!=null && pose.wristY > pose.elbowY + 10) penal(6);
    if (g.releaseAboveShoulder && !pose.releaseAboveShoulder) penal(8);

    return clamp(Math.round(score), 0, 100);
    };

  window.summarizePoseIssues = function summarizePoseIssues(shot, golden){
    const issues = [];
    const p = shot?.poseSnapshot; if (!p) return issues;
    const g = golden || {};

  // Feet
  if (Number.isFinite(p.stanceWidthFeet) && g.stanceWidthFeet){
    const d = p.stanceWidthFeet - g.stanceWidthFeet;
    if (d < -20) issues.push("Feet too narrow — widen ~2–3\".");
    else if (d > 20) issues.push("Feet too wide — narrow slightly.");
  }
  if (Number.isFinite(p.feetAngleDiff) && p.feetAngleDiff > (g.feetAngleDiff||8) + 6){
    issues.push("Feet not parallel — square both toes to the rim.");
  }
  if (Number.isFinite(p.feetStagger) && p.feetStagger > (g.feetStagger||6) + 10){
    issues.push("Feet staggered — level your base.");
  }

  // Power / lower body
  if (Number.isFinite(p.kneeFlex) && (p.kneeFlex < (g.kneeFlex||28) * 0.75)){
    issues.push("Add more knee bend to generate power.");
  }

  // Torso
  if (Number.isFinite(p.torsoLeanAngle) && Math.abs(p.torsoLeanAngle) > 18){
    issues.push("Stay more upright through the lift.");
  }

  // Arm / release
  if (Number.isFinite(p.shoulderToWristAngle) && p.shoulderToWristAngle < (g.shoulderToWristAngle||55) - 8){
    issues.push("Get your shooting arm more vertical on release.");
  }
  if (p.wristY!=null && p.elbowY!=null && p.wristY > p.elbowY + 10){
    issues.push("Finish higher — snap the wrist above the elbow.");
  }
  if ((g.releaseAboveShoulder ?? true) && !p.releaseAboveShoulder){
    issues.push("Release above your shoulder line.");
  }

  // Ball metrics if present
  if (Number.isFinite(shot.entryAngle) && g.entryAngle){
    if (shot.entryAngle < g.entryAngle - 5) issues.push("Entry angle a bit flat — add arc.");
    else if (shot.entryAngle > g.entryAngle + 5) issues.push("Entry angle steep — soften the arc.");
  }

  return issues;
  };

// ───────────────────────────────────────────────
// Hands-Free Doach (standalone, no global collisions)
// Exposes: window.doachHandsFree.start(), .stop(), .toggle(), .isActive()
// ───────────────────────────────────────────────
(() => {
  if (window.__doachHFInit) return;          // prevent duplicate init
  window.__doachHFInit = true;

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    console.warn('[Doach HF] Web Speech API not available');
    window.doachHandsFree = { start(){}, stop(){}, toggle(){}, isActive:()=>false };
    return;
  }

  // --- light metrics → answer helper (kept local to avoid globals)
  function answerFromMetrics(q, last, golden){
    if (!last?.poseSnapshot) return "I need a shot first to analyze.";
    const p = last.poseSnapshot;
    const g = golden || {};
    q = (q||'').toLowerCase();
    const say = (s)=>s.replace(/\s+/g,' ').trim();

    if (/foot|feet|base|stance/.test(q)) {
      const w = Math.round(p.stanceWidthFeet||p.stanceWidth||0);
      const tgt = g.stanceWidthFeet ? `, target ${Math.round(g.stanceWidthFeet)}px (Δ${w-Math.round(g.stanceWidthFeet)})` : '';
      const angle = Math.round(p.feetAngleDiff||0);
      const stag  = Math.round(p.feetStagger||0);
      return say(`Feet width ${w}px${tgt}. Toe alignment off by ${angle}°. ${stag>10?'Feet staggered; level your base.':'Base is level.'}`);
    }
    if (/release|follow/.test(q)) {
      const ang = Math.round(p.shoulderToWristAngle ?? 0);
      const high = p.releaseAboveShoulder ? "above" : "below";
      const wristVsElbow = (p.wristY!=null && p.elbowY!=null && p.wristY > p.elbowY + 10) ? "low" : "high";
      return say(`Arm angle ${ang}°. Release is ${high} shoulder. Wrist finished ${wristVsElbow}. Aim for a higher vertical finish.`);
    }
    if (/power|leg|knee/.test(q)) {
      const k = Math.round(p.kneeFlex||0);
      const tgt = g.kneeFlex ? `; target ~${Math.round(g.kneeFlex)}` : '';
      return say(`Knee bend ${k}px${tgt}. ${k < (g.kneeFlex||28)*0.75 ? 'Add more bend for power.' : 'Power from legs looked solid.'}`);
    }
    if (/arc|entry/.test(q)) {
      const ea = Math.round(last.entryAngle ?? 0);
      const ga = g.entryAngle ? Math.round(g.entryAngle) : 50;
      return say(`Entry angle ${ea}°. ${Math.abs(ea-ga)<=5?'On target.': ea<ga?'A bit flat — add arc.':'A tad steep — soften the arc.'}`);
    }
    if (/(accur|make|made)/.test(q)) {
      return say('Pose-only mode: accuracy tracking is disabled. Focus on repeating the pose cues.');
    }
    return "Ask about feet, release, power, arc, or pose adjustments.";
  }

  // --- private state for this module (distinct names)
  let hfRec = null;
  let hfActive = false;
  let hfStarting = false;
  let hfRestartTimer = null;

  function tryRestart() {
    if (!hfRec || document.hidden || hfStarting || hfActive) return;
    hfStarting = true;
    try { hfRec.start(); }
    catch { hfStarting = false; setTimeout(() => { try { hfRec.start(); hfStarting = true; } catch {} }, 400); }
  }

  async function start() {
    if (hfActive || hfStarting) return;
    // permission prime (helps UX)
    try { await navigator.mediaDevices.getUserMedia({ audio:true }); } catch {}

    hfRec = new SR();
    hfRec.lang = 'en-US';
    hfRec.continuous = true;       // hands-free mode
    hfRec.interimResults = false;

    hfRec.onstart = () => { hfStarting = false; hfActive = true; };

    hfRec.onresult = (e) => {
      const transcript = Array.from(e.results).map(r=>r[0].transcript).join(' ');
      const mem = window.DOACH_MEM?.get?.() || {};
      const reply = answerFromMetrics(transcript, mem.lastShot, mem.golden);
      doachSpeak?.(reply);

      const box = document.getElementById('coachNotes');
      if (box) box.innerHTML =
        `<strong>🎙 You:</strong> ${transcript}<br><strong>🤖 Doach:</strong> ${reply}`;
    };

    hfRec.onerror = (ev) => {
      const err = ev?.error || String(ev);
      if (err === 'no-speech') return; // harmless; keep listening
      if (['aborted','not-allowed','service-not-allowed','audio-capture'].includes(err)) {
        stop(); return;                 // needs user action
      }
      // soft backoff restart
      clearTimeout(hfRestartTimer);
      hfRestartTimer = setTimeout(tryRestart, 800);
    };

    hfRec.onend = () => {
      hfActive = false;
      if (!document.hidden) {
        clearTimeout(hfRestartTimer);
        hfRestartTimer = setTimeout(tryRestart, 300);
      }
    };

    hfStarting = true;
    try { hfRec.start(); }
    catch { hfStarting = false; setTimeout(() => { try { hfRec.start(); hfStarting = true; } catch {} }, 400); }

    doachSpeak?.("Listening. Ask about feet, release, power, arc, or pose adjustments.");
  }

  function stop() {
    clearTimeout(hfRestartTimer);
    hfRestartTimer = null;
    hfStarting = false;
    hfActive = false;
    try { hfRec?.stop(); } catch {}
    hfRec = null;
  }

  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });

  // public API
  window.doachHandsFree = {
    start, stop,
    toggle(){ (hfActive || hfStarting) ? stop() : start(); },
    isActive: () => hfActive
  };
})();


let __processedShotKeys = new Set();
const __processedExpireMs = 10_000; // keep keys ~10s then GC
let __processedTimestamps = [];

function makeShotKey(s) {
  // Build a stable signature from fields that don't change across re-emits
  const idLike = s.id ?? s.__idx ?? '';
  const start = s.startFrame ?? s.start ?? '';
  const end   = s.endFrame ?? s.end ?? '';
  const video = s.videoId ?? s.src ?? '';
  return [idLike, start, end, video].join('|');
}

function rememberKey(key) {
  const now = Date.now();
  __processedShotKeys.add(key);
  __processedTimestamps.push([key, now]);
  // GC old keys
  while (__processedTimestamps.length &&
        (now - __processedTimestamps[0][1]) > __processedExpireMs) {
    const [oldKey] = __processedTimestamps.shift();
    __processedShotKeys.delete(oldKey);
  }
}

window.addEventListener('shot:summary', (e) => {
  // If we’ve already handled THIS object, bail (covers re-dispatch)
  if (e.detail && e.detail.__doachHandled) return;

  const shot = e.detail;
  const key = makeShotKey(shot || {});
  if (key && __processedShotKeys.has(key)) return; // already handled a twin

  // Mark original payload so a re-dispatch of the same object won’t run again
  if (shot) shot.__doachHandled = true;
  rememberKey(key);

  console.log('[Doach] shot:summary handled key=', key, shot);

  // proceed with your existing logic
  const cloned = { ...shot };
  if (!cloned.poseSnapshot && window.playerState) {
    cloned.poseSnapshot = window.capturePoseSnapshot(window.playerState, window.getLockedHoopBox?.());
  }
  window.DOACH_MEM.addShot(cloned);
  window.updateCoachNotes?.(cloned);
  // Attach per-shot coach line for the table; respect voice preference inside doachOnShot
  window.doachOnShot?.(cloned);
});



// ───────────────────────────────────────────────
// DOACH Voice Q&A (single, hardened instance)
// ───────────────────────────────────────────────
(function () {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { console.warn('[Doach Voice] SpeechRecognition not supported'); return; }

  // Wake words (loose match)
  const DOACH = (window.DOACH ||= {});
  DOACH.WAKE_WORDS ||= ['hey doach', 'my coach', 'coach', 'douch'];

  const prefs = (window.doachGetPrefs?.() || {});

  // --- recognizer + state (define all the vars used below!)
  const recog = new SR();
  recog.lang = prefs.lang || 'en-US';
  recog.interimResults = true;
  recog.continuous = false;     // more reliable cross-browser than true

  let listening = false;
  let starting  = false;        // start() in-flight gate
  let armed     = false;        // user armed (allowed auto-restart)
  let restartTimer  = null;

  let captureMode   = false;    // true after wake-word; captures the question
  let captureTimer  = null;

  const norm = (s) => String(s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

  const hasWake = (t) => {
    const n = norm(t);
    return DOACH.WAKE_WORDS.some(w => n.includes(norm(w)));
  };

  function lastShot() { return window.DOACH_MEM?.lastShot?.() || null; }

  function answerLocal(q) {
    const L = lastShot();
    if (!L) return "I don't have a shot yet. Take one and ask again.";
    const p = L.poseSnapshot || {};
    const parts = [];
    const n = norm(q);

    // Feet / stance
    if (/(foot|feet|stance)/.test(n)) {
      const w = p.stanceWidth;
      parts.push(w == null
        ? "I couldn't see your feet clearly."
        : `Stance width was ${Math.round(w)}px — ${w < 100 ? 'a bit narrow' : 'solid'}. Aim for about shoulder width plus a bit.`);
    }
    // Release / wrist / elbow
    if (/(release|wrist|elbow|follow)/.test(n)) {
      const ang = p.shoulderToWristAngle;
      parts.push(ang == null
        ? "I couldn't read your arm angle."
        : `Release angle was ~${Math.round(ang)}°. Try finishing near 50–60° with a full follow-through.`);
    }
    // Power / knee bend
    if (/(power|legs|knee|dip|bend)/.test(n)) {
      const k = p.kneeFlex;
      parts.push(k == null
        ? "I couldn't estimate knee bend."
        : `Knee bend was ~${Math.round(k)}px. Add a bit more load if the shot felt short.`);
    }
    // Arc / entry
    if (/(arc|entry|angle)/.test(n)) {
      const arc = Math.round(L.arcHeight || 0);
      const entry = L.entryAngle ?? '–';
      parts.push(`Arc ~${arc}px, entry ${entry}°. Target mid-40s to low-50s.`);
    }
    // Accuracy (pose-only mode disabled tracking)
    if (/(make|accuracy|percent|score)/.test(n)) {
      parts.push('Pose-only mode: accuracy tracking is disabled. Focus on repeating the pose cues.');
    }

    if (!parts.length) {
      const issues = window.summarizePoseIssues?.(L) || [];
      parts.push(`Pose snapshot: arc ${Math.round(L.arcHeight || 0)}px, entry ${L.entryAngle ?? '–'}°, release ${L.releaseAngle ?? '–'}°. Focus on smooth, tall mechanics.`);
      if (issues[0]) parts.push(issues[0]);
    }
    return parts.join(' ');
  }

  function showDot(on) {
    const root = document.getElementById('hudRoot') || document.body || document.documentElement;
    if (!root) return;
    let dot = document.getElementById('doachVoiceDot');
    if (!dot) {
      dot = document.createElement('div');
      dot.id = 'doachVoiceDot';
      Object.assign(dot.style, {
        position: 'absolute', right: '12px', top: '12px',
        width: '10px', height: '10px', borderRadius: '50%',
        background: 'red', opacity: '0.5', zIndex: 10050, pointerEvents: 'none'
      });
      root.appendChild(dot);
    }
    dot.style.opacity = on ? '1' : '0.35';
    dot.style.background = captureMode ? 'lime' : 'red';
  }

  // --- robust start/stop with gates
  function tryStartRecog() {
    if (document.hidden || starting || listening) return;
    starting = true;
    try { recog.start(); }
    catch { starting = false; setTimeout(() => { try { recog.start(); starting = true; } catch {} }, 400); }
  }

  async function start() {
    if (!isMicAllowed()) {                     // << new
      console.warn('[Doach HF] mic disabled by preferences');
      return;
    }
    
    if (listening || starting) return;
    // mic prime improves UX/permissions
    try { await navigator.mediaDevices.getUserMedia({ audio: true }); } catch {}
    armed = true;
    tryStartRecog();
    showDot(true);
  }

  function stop() {
    armed = false;
    listening = false;
    starting = false;
    clearTimeout(restartTimer);
    clearTimeout(captureTimer);
    captureMode = false;
    try { recog.stop(); } catch {}
    showDot(false);
  }

  // --- handlers
  recog.onstart = () => { starting = false; listening = true; showDot(true); };

  recog.onresult = async (ev) => {
    let finalText = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      if (ev.results[i].isFinal) finalText += ev.results[i][0].transcript + ' ';
    }
    finalText = finalText.trim();
    if (!finalText) return;

    const lower = norm(finalText);

    // Step 1: detect wake word
    if (!captureMode && hasWake(lower)) {
      captureMode = true;
      showDot(true);
      clearTimeout(captureTimer);
      captureTimer = setTimeout(() => { captureMode = false; showDot(true); }, 5000);
      doachSpeak?.("Yes?");
      return;
    }

    // Step 2: capture the follow-up question
    if (captureMode) {
      clearTimeout(captureTimer);
      captureTimer = setTimeout(() => { captureMode = false; showDot(true); }, 1500);

      // strip wake words if included together
      const wakeRe = new RegExp(DOACH.WAKE_WORDS.map(w => norm(w)).join('|'), 'g');
      const q = lower.replace(wakeRe, '').trim();

      let reply = answerLocal(q);

      // Fallback to model for anything not covered by our quick rules
      if (!/(feet|stance|release|wrist|elbow|power|knee|arc|entry|angle|make|accuracy)/.test(q) && DOACH.chatEndpoint) {
        try {
          const ctx = { lastShot: lastShot(), recent: window.DOACH_MEM?.recent?.(5) };
          const r = await fetch(DOACH.chatEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              prompt: `You are Doach. User asked: "${finalText}". Use this context JSON:\n${JSON.stringify(ctx)}\nGive a specific, actionable answer in 1–2 short sentences.`,
              model: DOACH.model
            })
          });
          const j = await r.json();
          if (j?.text) reply = j.text.trim();
        } catch {}
      }

      doachSpeak?.(reply);
    }
  };

  recog.onerror = (e) => {
    const err = e?.error || String(e);

    // Common & harmless — ignore (optional soft retry)
    if (err === 'no-speech') {
      if (armed && !document.hidden) {
        clearTimeout(restartTimer);
        restartTimer = setTimeout(tryStartRecog, 600);
      }
      return;
    }

    starting = false;
    listening = false;

    // Require a new user gesture for these — do not auto-restart
    if (['aborted', 'not-allowed', 'service-not-allowed', 'audio-capture'].includes(err)) {
      armed = false;
      clearTimeout(restartTimer);
      restartTimer = null;
      showDot(false);
      return;
    }

    // Backoff restart only if the user armed and tab visible
    if (armed && !document.hidden) {
      clearTimeout(restartTimer);
      restartTimer = setTimeout(tryStartRecog, 800);
    }
  };

  recog.onend = () => {
    starting = false;
    listening = false;
    if (armed && !document.hidden) {
      clearTimeout(restartTimer);
      restartTimer = setTimeout(tryStartRecog, 300);
    } else {
      showDot(false);
    }
  };

  // Pause on hidden tab; require re-arming on return
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop();
  });

  // Public controls
  window.doachVoice = {
    on: start,
    off: stop,
    toggle: () => (listening || starting ? stop() : start()),
    isOn: () => listening
  };

  // Auto-start unless user disabled it in prefs
  if (prefs.voiceWake !== false) {
  if (prefs.voiceWake !== false && isMicAllowed()) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => start());
    } else {
      start();
    }
  }}
})();

  })();




