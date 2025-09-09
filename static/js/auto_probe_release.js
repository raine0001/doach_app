// auto_probe_release.js — attach live camera release diagnostics automatically
(function installAutoProbe(){
  try {
    const qp = new URLSearchParams(location.search||'');
    if ((qp.get('probe')||'').toLowerCase() !== 'release') return;
  } catch { return; }

  function once(el, ev, fn){ const h=(e)=>{ try{fn(e)}finally{el.removeEventListener(ev,h)} }; el.addEventListener(ev,h); }

  window.addEventListener('DOMContentLoaded', () => {
    try { window.DOACH_SHOT_DEBUG = true; } catch {}
    try { window.DOACH_RELEASE_TRACE = true; } catch {}
    try { window.__forceServerDetect = false; window.__LOCAL_DETECTOR = true; } catch {}
    try { window.enableLocalDetector?.(); } catch {}
    try { document.getElementById('overlayPrompt')?.style?.setProperty('display','block'); } catch {}

    // Simple HUD
    const hud = document.createElement('div');
    Object.assign(hud.style, { position:'fixed', left:'12px', top:'12px', zIndex: 9999,
      background:'rgba(0,0,0,0.70)', color:'#fff', padding:'8px 10px', borderRadius:'8px',
      font:'600 12px system-ui, sans-serif' });
    hud.id = 'probeHud';
    hud.innerHTML = '<div>Release Probe</div><div id="p_rel">release: -</div><div id="p_watch">watch: -</div><div id="p_pose">poseΔ: -</div>';
    document.body.appendChild(hud);
    const setText = (id, v) => { const el=document.getElementById(id); if (el) el.textContent=v; };

    const fps = Number(window.__videoFPS) || 30;
    const qp = new URLSearchParams(location.search||'');
    const releaseOnly = /^(1|true|yes)$/i.test(qp.get('releaseOnly')||'');
    const relTime = qp.get('release');
    const relFrame = qp.get('frame');
    if (relTime) { try { window.watchReleaseAtTime?.(relTime); setText('p_watch', 'watch: time '+relTime); } catch {} }
    else if (relFrame) { try { const f=Number(relFrame)||0; window.watchReleaseAtFrame?.(f); setText('p_watch', 'watch: frame '+f); } catch {} }

    // Update poseΔ display and release frame
    setInterval(() => {
      try {
        const ms = Math.round(performance.now() - (window.__lastPoseUpdateMs || 0));
        setText('p_pose', 'poseΔ: '+ms+' ms');
        const rf = (window.ballState?.releaseFrame != null) ? window.ballState.releaseFrame : '-';
        setText('p_rel', 'release: '+rf);
      } catch {}
    }, 300);

    // Force overlay & helpers
    try { window.setOverlayMode?.('coach'); } catch {}
    try { window.setShotDebug?.(true); } catch {}
    try { window.setReleaseTrace?.(true); } catch {}
    try { window.POSE_MODEL = 'full'; } catch {}
    if (releaseOnly) {
      // In release-only mode favor lower-latency pose model
      try { window.POSE_MODEL = 'lite'; } catch {}
      try { window.__SESSION_ACTIVE = true; } catch {}
      try { window.USE_FBF_DURING_SHOT = false; } catch {}
      try { window.__coachMuted = true; } catch {}
      try { window.__RELEASE_ONLY = true; } catch {}
    }
    try {
      window.REL_SCORE_THRESH = 0.44;
      window.REL_ELBOW_EXT_MIN = 150;
      window.REL_Y_TOL = 8;
      window.REL_DX_MAX = 130;
      window.REL_DY_MIN = 10;
      window.__POSE_HOLD_MS = 1000;
      window.HEUR_STREAK_NEED = 1;
      if (releaseOnly) window.COACH_POSE_MS = 120; // give CPU headroom in live capture
    } catch {}
    try { window.REL_SCORE_THRESH = 0.48; } catch {}
    try { window.COACH_POSE_MS = 60; } catch {}
    try { window.__SESSION_ACTIVE = false; } catch {}
    try { window.USE_FBF_DURING_SHOT = true; } catch {}

    // If live camera, ensure picker and PD
    const ready = () => {
      try {
        const v = document.getElementById('videoPlayer');
        if (v?.srcObject) {
          // Skip pre-detection in release-only mode to avoid any pause/CPU spikes
          if (!releaseOnly) {
            try { window.installPreDetectorFor?.(v); } catch {}
            try { window.startPreDetection?.(v); } catch {}
          }
        }
      } catch {}
    };
    const v = document.getElementById('videoPlayer');
    if (v) once(v, 'loadedmetadata', ready);
    // Try to start camera automatically for probe runs
    setTimeout(() => { try { window.startCamera?.(); } catch {} }, 300);
    // Try to start sampler shortly after camera boot (even before hoop is locked)
    setTimeout(() => {
      try {
        const ok = window.startCoachSamplerQuick?.(60);
        if (ok) console.log('[probe] sampler started (early)');
      } catch {}
    }, 900);
    // Retry a few times until sampler is active (in case of slow camera permissions)
    try {
      let tries = 0;
      const iv = setInterval(() => {
        try {
          if (window.__coachSamplerActive) { clearInterval(iv); return; }
          const ok = window.startCoachSamplerQuick?.(60);
          if (ok) { console.log('[probe] sampler started (retry)'); clearInterval(iv); return; }
        } catch {}
        if (++tries >= 8) clearInterval(iv);
      }, 700);
    } catch {}
    // If a hoop is already attached programmatically, arm the quick coach sampler
    setTimeout(() => {
      try {
        const H = window.getLockedHoopBox?.();
        if (H) window.startCoachSamplerQuick?.(120);
      } catch {}
    }, 1500);
    // Start analyzer automatically on hoop lock (live camera) unless releaseOnly is enabled
    if (!releaseOnly) {
      try {
        window.addEventListener('hoop:locked', () => {
          try { window.useRealTimeTracking = true; } catch {}
          try { window.startTracking?.(); } catch {}
          console.log('[probe] analyzer started on hoop lock');
        });
      } catch {}
    }

    // In probe mode allow multiple pose-only releases even if no end/summary arrives
    window.addEventListener('shot:release', () => {
      try { setTimeout(() => { window.__releaseEventSent = false; }, 1500); } catch {}
    });

    // Release-only: show a small on-screen pose assessment at each release (no arc scoring)
    if (releaseOnly) {
      try {
        window.addEventListener('shot:release', () => {
          try {
            const snap = window.capturePoseSnapshot?.(window.playerState, window.getLockedHoopBox?.());
            const golden = window.DOACH_MEM?.get?.()?.golden;
            const issues = (window.summarizePoseIssues?.({ poseSnapshot: snap }, golden) || []).slice(0,3);
            const line = issues.length ? issues.join(' • ') : 'Solid form. Hold your follow-through.';
            const box = document.createElement('div');
            Object.assign(box.style, { position:'fixed', top:'12px', left:'50%', transform:'translateX(-50%)', background:'rgba(0,0,0,0.78)', color:'#fff', padding:'8px 12px', borderRadius:'10px', zIndex:9999, font:'600 13px system-ui, sans-serif', maxWidth:'70vw' });
            box.textContent = line;
            document.body.appendChild(box);
            setTimeout(()=>{ try { box.remove(); } catch {} }, 1800);
          } catch {}
        });
      } catch {}
    }

    // Start quick sampler once the user locks the hoop
    try {
      window.addEventListener('hoop:locked', () => {
        try { window.startCoachSamplerQuick?.(60); console.log('[probe] sampler started on hoop lock'); } catch {}
      });
    } catch {}
  });
})();
