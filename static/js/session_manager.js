// session_manager.js — Demo Mode FBF sessions (clean arcs + stable accuracy)

async function postJSON(url, body) {
  const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body||{}) });
  if (!r.ok) throw new Error('HTTP '+r.status); return await r.json();
}

async function uploadBlob(url, blob, filename='clip.webm', field='file') {
  const fd = new FormData(); fd.append(field, blob, filename);
  const r = await fetch(url, { method:'POST', body: fd }); if (!r.ok) throw new Error('HTTP '+r.status); return await r.json();
}

import { speak, listenForEndSession } from '/static/js/coach_voice.js';
import { ensureHudRoot } from '/static/js/video_ui.js';

(function installDemoSession(){
  const btnStart = document.getElementById('btnStartSession');
  const btnEnd   = document.getElementById('btnEndSession');
  if (!btnStart || !btnEnd) return;

  let sessId = null; let shotIdx = 0; let rec = null; let recChunks = []; let recStream = null; let recCanvas = null;

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
      const res = await postJSON('/api/sessions/start', { device: navigator.userAgent });
      sessId = res.id; shotIdx = 0; try { window.__SESSION_ID = sessId; window.__SHOT_IDX = shotIdx; } catch {}
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
    }
  }

  async function endSession() {
    // Centered loading/progress overlay
    const showProgress = (() => {
      let box = document.getElementById('sessionLoadingOverlay');
      if (!box) {
        const root = ensureHudRoot();
        box = document.createElement('div');
        box.id = 'sessionLoadingOverlay';
        Object.assign(box.style, {
          position:'absolute', left:'50%', top:'50%', transform:'translate(-50%,-50%)',
          background:'rgba(0,0,0,0.82)', color:'#fff', padding:'18px 20px', borderRadius:'12px',
          font:'600 18px system-ui, -apple-system, Segoe UI, Arial', zIndex:10040, minWidth:'300px', textAlign:'center',
          pointerEvents:'auto'
        });
        box.innerHTML = `
          <div style="font-size:20px; font-weight:700; margin-bottom:10px;">Session loading…</div>
          <div id="sessLoadMsg" style="opacity:.9;margin-bottom:12px;">Finalizing your session</div>
          <div style="height:12px; background:rgba(255,255,255,0.12); border-radius:8px; overflow:hidden;">
            <div id="sessLoadBar" style="height:100%; width:0%; background:#22c55e; transition:width .25s ease;"></div>
          </div>`;
        root.appendChild(box);
      }
      const set = (p, msg) => {
        try { box.querySelector('#sessLoadBar').style.width = `${Math.max(0, Math.min(100, Math.round(p)))}%`; } catch {}
        if (msg) try { box.querySelector('#sessLoadMsg').textContent = msg; } catch {}
      };
      const hide = () => { try { box.remove(); } catch {} };
      return { set, hide };
    })();

    try {
      await stopRecorderAndUpload();
      const list = (window.__shotList || window.shotLog || []);
      const total = Array.isArray(list) ? list.length : 0;
      showProgress.set(15, total ? `Posting ${total} shot${total===1?'':'s'}…` : 'Finalizing your session…');

      // Animate to 90% while waiting for the server to finalize
      let p = 15; const t0 = performance.now();
      const timer = setInterval(() => { p = Math.min(90, 15 + (performance.now() - t0)/12); showProgress.set(p); }, 120);
      try { if (sessId) await postJSON(`/api/sessions/${sessId}/end`, {}); } finally { try { clearInterval(timer); } catch {} }
      showProgress.set(100, 'Done');
      setTimeout(() => showProgress.hide(), 400);
    } catch {}
    try { window.__demoStopVoice?.(); } catch {}
    try { const v = document.getElementById('videoPlayer'); if (v) v.playbackRate = 1; } catch {}
    window.__SESSION_ACTIVE = false;
    btnStart.disabled = false; btnEnd.disabled = true;

    // Voice short summary and open the summary table
    try {
      const taken = (window.__shotList?.length || window.shotLog?.length || 0);
      const made  = (window.shotLog?.filter?.(s => s.made).length || 0);
      const acc   = taken ? Math.round((made / taken) * 100) : 0;
      if (taken > 0) speak(`Session complete. You took ${taken} shots, made ${made}, for ${acc} percent accuracy.`);
      const summaryBtn = document.querySelector('#openSummaryBtn');
      if (summaryBtn) setTimeout(() => summaryBtn.click(), 350);
    } catch {}
  }

  btnStart.addEventListener('click', startSession);
  btnEnd.addEventListener('click', endSession);
  // HUD integration: respond to bottom bar events
  window.addEventListener('hud:end-session', () => { try { endSession(); } catch {} });
  window.addEventListener('hud:start-session', () => { try { startSession(); } catch {} });
})();
