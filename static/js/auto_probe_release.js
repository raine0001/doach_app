// auto_probe_release.js — attach live camera release diagnostics automatically - listener for ?probe=release
// Intended for use in release testing and form analysis
// Enables local pose detector, quick coach sampler, and release tracing
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

    const fps = Number(window.__videoFPS) || 10;
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
    // Consolidated: do not override gate knobs here. If needed, use setReleaseKnobs().
    // Allow URL overrides e.g., ?ext=140&strict=160&shy=8
    try {
      const patch = {};
      if (typeof URLSearchParams !== 'undefined') {
        const q2 = new URLSearchParams(location.search||'');
        if (q2.has('ext'))    patch.elbowExtMin    = Number(q2.get('ext'));
        if (q2.has('strict')) patch.elbowStrictMin = Number(q2.get('strict'));
        if (q2.has('shy'))    patch.shYTol         = Number(q2.get('shy'));
        if (q2.has('ytol'))   patch.yTol           = Number(q2.get('ytol'));
        if (q2.has('dx'))     patch.dxMax          = Number(q2.get('dx'));
        if (q2.has('dy'))     patch.dyMin          = Number(q2.get('dy'));
        if (q2.has('up'))     patch.upDy           = Number(q2.get('up'));
        if (q2.has('score'))  patch.scoreThresh    = Number(q2.get('score'));
        if (q2.has('streak')) patch.streakNeed     = Number(q2.get('streak'));
      }
      if (Object.keys(patch).length && typeof window.setReleaseKnobs === 'function') {
        window.setReleaseKnobs(patch);
      }
      window.__POSE_HOLD_MS = 1000; // harmless visual hold for HUD
      if (releaseOnly) window.COACH_POSE_MS = 120; // give CPU headroom in live capture
    } catch {}
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

    // Do not auto-reset release event latch here; cooldown is enforced centrally.

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
