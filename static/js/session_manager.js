// session_manager.js — Demo Mode FBF sessions (clean arcs + stable accuracy)

import { speak, listenForEndSession } from '/static/js/coach_voice.js';

async function postJSON(url, body) {
  const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body||{}), credentials:'include' });
  const text = await r.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
  if (!r.ok) {
    const errMsg = data?.err || data?.error || data?.message || ('HTTP '+r.status);
    const error = new Error(errMsg);
    error.status = r.status;
    error.response = data;
    throw error;
  }
  return data;
}

async function uploadBlob(url, blob, filename='clip.webm', field='file') {
  const fd = new FormData(); fd.append(field, blob, filename);
  const r = await fetch(url, { method:'POST', body: fd, credentials:'include' }); if (!r.ok) throw new Error('HTTP '+r.status); return await r.json();
}

(function installDemoSession(){
  const btnStart = document.getElementById('btnStartSession');
  const btnEnd   = document.getElementById('btnEndSession');
  if (!btnStart || !btnEnd) return;

  let sessId = null; let shotIdx = 0; let rec = null; let recChunks = []; let recStream = null; let recCanvas = null;
  let pendingChallengeSlug = null;

  function startRecorder() {
    try {
      const ov = document.getElementById('overlay'); if (!ov) return false;
      recCanvas = ov; recStream = ov.captureStream(30);
      recChunks = []; rec = new MediaRecorder(recStream, { mimeType: 'video/webm' });
      rec.ondataavailable = e => { if (e.data && e.data.size) recChunks.push(e.data); };
      rec.start(); return true;
    } catch { return false; }
  }
  async function stopRecorderAndUpload() {
    return await new Promise((resolve)=>{
      try {
        if (!rec) return resolve(null);
        rec.onstop = async () => {
          try {
            const blob = new Blob(recChunks, { type:'video/webm' });
            if (sessId != null) {
              await uploadBlob(`/api/sessions/${sessId}/shot_video?index=${shotIdx}`, blob, `shot_${shotIdx}.webm`);
            }
          } catch {}
          resolve(null);
        };
        rec.stop();
      } catch { resolve(null); }
    });
  }

  async function startSession() {
    if (sessId) return; // already
    try {
      // Analyzer runs fully in the background; keep user playback at 1x
      window.USE_FBF_DURING_SHOT = false;   // do not pause/step the visible player
      // Recommended demo defaults
      window.ROI_SUPERSAMPLE = Number(window.ROI_SUPERSAMPLE || 1.6);
      window.BALL_MAX_STEP   = Number(window.BALL_MAX_STEP || 32);
      window.EXIT_BELOW_MARGIN = Number(window.EXIT_BELOW_MARGIN || 14);
      window.__PREROLL_FPS   = Number(window.__PREROLL_FPS || 10);
      window.DETECT_EVERY    = 1;
      window.SLOW_RATE       = Number(window.SLOW_RATE || 0.35);
      try { window.setOverlayMode?.('arc-only'); } catch {}

      window.__SESSION_ACTIVE = true;
      // Stable detection & presentation
      window.__forceServerDetect = true; window.DETECT_ROI_ONLY = true; window.__ROI_DETECT_ALWAYS = true;
      window.REL_HAND_DIST_PX = 120; window.REL_POSE_STREAK = 1; window.REL_UPWARD_MIN_FRAMES = 1; window.RELEASE_DELAY_FRAMES = 1;
      try {
        const name = (localStorage.getItem('firstname') || 'player');
        speak(`Hi ${name}, select the hoop, then shoot when ready.`);
      } catch {}
      try { window.enableHoopPickOnce?.(); window.showPrompt?.('Tap the hoop to lock it'); } catch {}
      const body = { device: navigator.userAgent };
      const challengeSlug = pendingChallengeSlug || window.__pendingChallengeEvent || null;
      if (challengeSlug) {
        body.event = challengeSlug;
        body.challenge = true;
      }
      const res = await postJSON('/api/sessions/start', body);
      sessId = res.id; shotIdx = 0; try { window.__SESSION_ID = sessId; window.__SHOT_IDX = shotIdx; } catch {}
      if (challengeSlug) {
        pendingChallengeSlug = null;
        try { window.__pendingChallengeEvent = null; } catch {}
        window.dispatchEvent(new CustomEvent('challenge:session-started', { detail: { slug: challengeSlug, payload: res.event||null, sessionId: sessId } }));
      }
      try { document.querySelectorAll('.video-controls').forEach(el => el.remove()); } catch {}
      try { window.mountSessionHUD?.(); window.setSessionStatus?.('SESSION IN PROGRESS'); } catch {}

      // Wire shot lifecycle for demo mode
      // Start recording slightly before release: when prox enter stamps
      const onFrame = () => {
        try {
          const bs = (window.ballState||{});
          if (Number.isFinite(bs.proxEnterFrame) && !rec) startRecorder();
        } catch {}
      };
      window.addEventListener('analyzer:frame-done', onFrame);

      const onRelease = (e) => {
        // Live session: keep user playback at 1x; analyze in background (analyzer.js)
        try { const v = document.getElementById('videoPlayer'); if (v) v.playbackRate = 1; } catch {}
        if (!rec) startRecorder();
        // Ignore before hoop lock in demo mode
        try { if (window.__hoopConfirmed !== true || !window.getLockedHoopBox?.()) return; } catch {}
        // Gate demo HUD attempt increments to "all four" pose checks + cooldown
        try {
          const unlockMs = Number(window.NEXT_SHOT_UNLOCK_MS ?? 2000);
          const now = performance.now();
          const last = Number(window.__UI_LAST_RELEASE_MS || 0);
          if (now - last < unlockMs) return; // cooldown: ignore rapid repeats
          const hist = (window.playerState?.frameHistory || []).slice(-5);
          let ok = false;
          if (typeof window.releaseGate === 'function') {
            try { ok = !!window.releaseGate(hist)?.released; } catch {}
          }
          if (!ok) return; // don't increment HUD attempts unless gate says released
          window.__UI_LAST_RELEASE_MS = now;
        } catch {}
        // Report to backend immediately (authoritative release anchor)
        try {
          const d = (e && e.detail) || {};
          const payload = {
            sessionId: sessId,
            shotId: shotIdx,
            frame: Number(d.frame||0),
            tMs: Number(d.tMs||Date.now()),
            via: d.via || 'frontend',
            poseSnapshot: (typeof window.extractPoseSnapshot === 'function' && window.playerState?.keypoints) ? window.extractPoseSnapshot(window.playerState.keypoints, window.getLockedHoopBox?.()) : null,
            hoop: (typeof window.getLockedHoopBox === 'function') ? window.getLockedHoopBox() : null,
          };
          postJSON('/api/release_mark', payload).catch(()=>{});
        } catch {}
        // Increment HUD attempts immediately so UI shows 1/10, 2/10, etc.
        try {
          const list = (window.__shotList || []);
          const made = list.filter(s => s.made).length;
          const acc  = list.length ? Math.round((made / list.length) * 100) : 0;
          const start = (window.__sessionStart ||= Date.now());
          const elapsedSec = Math.floor((Date.now() - start) / 1000);
          window.updateSessionHUD?.({ taken: list.length + 1, made, accuracy: acc, elapsedSec });
          try { console.log('[HUD:demo-increment]', { len: list.length + 1 }); } catch {}
        } catch {}
        try { window.setSessionStatus?.(`Shot ${shotIdx+1} in progress…`); } catch {}
      };
      const onSummary = async (e) => {
        // In demo uploads we present a frozen clean arc; in live sessions keep coach mode active
        try {
          if (!window.__SESSION_ACTIVE) {
            window.setOverlayMode?.('clean');
            window.__overlayFreeze = true;
          }
        } catch {}
        const detail = (e && e.detail) || (window.__lastSummary || {});
        const shot = {
          idx: shotIdx,
          t: Date.now(),
          made: !!detail?.made,
          arcHeight: detail?.arcHeight ?? null,
          entryAngle: detail?.entryAngle ?? null,
          releaseAngle: detail?.releaseAngle ?? null,
        };
        try { await postJSON(`/api/sessions/${sessId}/shot`, shot); } catch {}
        try { await stopRecorderAndUpload(); } catch {}
        shotIdx++; try { window.__SHOT_IDX = shotIdx; } catch {}
        try { speak(shot.made ? 'Nice make.' : 'Missed. Adjust and try again.'); } catch {}
      };
      window.addEventListener('shot:release', onRelease);
      window.addEventListener('shot:summary', onSummary);

      // Voice command: end session
      const stopListen = listenForEndSession('hey doach, end the session', async ()=>{ try { await endSession(); } catch {} });
      window.__demoStopVoice = stopListen;

      btnStart.disabled = true; btnEnd.disabled = false;
    } catch (e) {
      console.warn('startSession failed', e);
      if (pendingChallengeSlug) {
        window.dispatchEvent(new CustomEvent('challenge:session-start-error', { detail: { slug: pendingChallengeSlug, error: e } }));
        pendingChallengeSlug = null;
        try { window.__pendingChallengeEvent = null; } catch {}
      }
    }
  }

  async function endSession() {
    // Delegate: use the canonical UI end routine
    try { await window.autoEndSessionAndSummarize?.(); } catch {}
    try { await stopRecorderAndUpload(); } catch {}
    try { window.__SESSION_ACTIVE = false; } catch {}
    try { btnStart.disabled = false; btnEnd.disabled = true; } catch {}
  }

  btnStart.addEventListener('click', startSession);
  btnEnd.addEventListener('click', endSession);
  // HUD integration: respond to bottom bar events
  window.addEventListener('hud:end-session', () => { try { endSession(); } catch {} });
  window.addEventListener('hud:start-session', () => { try { startSession(); } catch {} });

  window.startChallengeSession = async function startChallengeSession(slug) {
    if (!slug) return;
    pendingChallengeSlug = slug;
    try { window.__pendingChallengeEvent = slug; } catch {}
    await startSession();
  };
})();
