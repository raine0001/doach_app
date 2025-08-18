// slowmo_arbiter.js — single authority over playbackRate
(function installSlowmoArbiter(){
  if (window.__slowmoInstalled) return; window.__slowmoInstalled = true;

  const getVideo = () => window.__videoEl || document.getElementById('videoPlayer') || document.querySelector('video');
  let v = getVideo();
  if (!v) {
    // if video isn't in the DOM yet, wait and retry once
    window.addEventListener('DOMContentLoaded', () => {
      v = getVideo();
      if (!v) console.warn('[slowmo] no video element found');
    });
  }

  const state = {
    target: 1.0,         // desired rate
    reason: null,        // 'release' | 'manual' | null
    until:  0,           // performance.now() deadline in ms
    dbg:    false        // flip to true to see logs
  };
  const log = (...a)=> state.dbg && console.log('[slowmo]', ...a);

  function setTarget(rate, why) {
    if (!v) v = getVideo();
    if (!v) return;
    if (state.target !== rate) {
      state.target = rate;
      log('target ->', rate, 'reason:', why);
    }
  }

  function off(why='off') {
    state.reason = null;
    state.until  = 0;
    setTarget(1.0, why);
  }

  function on({ rate=0.35, ms=1200, why='release' } = {}) {
    state.reason = why;
    state.until  = performance.now() + ms;
    setTarget(rate, why);
  }

  // Main enforcement loop — if someone else changes the rate, we put it back
  let raf = 0;
  function tick() {
    const now = performance.now();
    if (state.reason && now >= state.until) {
      log('window elapsed, back to normal');
      off('window-elapsed');
    }
    if (v && v.playbackRate !== state.target) {
      try { v.playbackRate = state.target; } catch {}
    }
    raf = requestAnimationFrame(tick);
  }
  raf = requestAnimationFrame(tick);

  // Public API
  window.slowmo = {
    on, off,
    info(){ return { target: state.target, reason: state.reason, remainingMs: Math.max(0, state.until - performance.now()), actual: v?.playbackRate }; },
    debug(on=true){ state.dbg = !!on; }
  };

  // Wire canonical events
  window.addEventListener('video:loaded',   () => off('video-loaded'));
  window.addEventListener('shot:release',   () => on({ rate: 0.35, ms: 1200, why: 'release' })); // tweak here
  window.addEventListener('shot:summary',   () => off('shot-summary'));

  // Media state changes should always cancel slow-mo
  const ensureVideoListeners = () => {
    if (!v) return;
    v.addEventListener('play',   () => off('play'));
    v.addEventListener('pause',  () => off('pause'));
    v.addEventListener('seeking',() => off('seeking'));
    v.addEventListener('ended',  () => off('ended'));
  };
  if (v) ensureVideoListeners(); else window.addEventListener('DOMContentLoaded', ensureVideoListeners);

  log('installed');
})();
