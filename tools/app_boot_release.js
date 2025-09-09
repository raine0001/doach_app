// tools/app_boot_release.js — small deterministic boot for demo/release
;(function installDoachReleaseBoot(){
  if (window.__doachBootInstalled) return; window.__doachBootInstalled = true;

  // Default demo config (override by defining window.DOACH_RELEASE earlier)
  const DEF = {
    fps: 30,
    overlayMode: 'clean',
    forceHoop: null, // e.g., { cx:1216, cy:244, w:140, h:100 }
  };
  const CFG = Object.assign({}, DEF, window.DOACH_RELEASE || {});

  // 1) FPS for the analyzer frame‑pump
  try { window.__videoFPS = Number(CFG.fps) > 0 ? Number(CFG.fps) : 30; } catch {}

  // 2) Make clean overlay the default visual mode
  function tryCleanMode() { try { window.setOverlayMode?.(CFG.overlayMode || 'clean'); } catch {} }
  // Early attempt and a few retries for load‑order safety
  tryCleanMode();
  let __modeTries = 0; const __modeTimer = setInterval(() => { __modeTries++; tryCleanMode(); if (__modeTries > 20) clearInterval(__modeTimer); }, 100);

  // 3) Deterministic hoop lock once the video metadata is ready
  function forceLockHoop() {
    const H = CFG.forceHoop; if (!H) return;
    const cx = Number(H.cx ?? (H.x ?? 0) + (H.w ?? 140)/2);
    const cy = Number(H.cy ?? (H.y ?? 0) + (H.h ?? 100)/2);
    const w  = Number(H.w ?? 140), h = Number(H.h ?? 100);
    function applyAttach(){
      // Respect any existing/manual lock
      try {
        if (window.isUserLocked?.() === true) return true;
        const cur = window.getLockedHoopBox?.();
        if (cur && Number.isFinite(cur.cx ?? cur.x) && Number.isFinite(cur.cy ?? cur.y)) return true;
        if (window.__hoopConfirmed === true) return true;
      } catch {}
      try { if (typeof window.attachHoop === 'function') { window.attachHoop({ cx, cy, w, h }); window.__hoopConfirmed = true; return true; } } catch {}
      // Fallback shim (used by overlay + some paths); safe if real API isn’t exposed yet
      try {
        window.__lockedHoopBox = { cx, cy, x: cx - w/2, y: cy - h/2, w, h };
        if (!window.getLockedHoopBox) window.getLockedHoopBox = () => window.__lockedHoopBox;
        window.__hoopConfirmed = true;
        return true;
      } catch {}
      return false;
    }
    // Try a few times in case modules export later
    let tries = 0; const t = setInterval(() => { tries++; if (applyAttach() || tries > 20) clearInterval(t); }, 100);
  }

  function onMetaOnce(){ forceLockHoop(); }
  document.addEventListener('DOMContentLoaded', () => {
    try { const v = document.getElementById('videoPlayer'); if (v) v.addEventListener('loadedmetadata', onMetaOnce, { once: true }); } catch {}
    // Be generous with release gating in demo/release builds
    try { window.RELEASE_ON_ENTER = (window.RELEASE_ON_ENTER !== false); } catch {}
  });

  console.log('[boot] DOACH release boot installed', CFG);
})();
