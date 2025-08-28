// slowmo_arbiter.js — resilient slow-mo controller

(function () {
  const SLOW_FPS   = Number(window.slowmoFps || 3);
  const MAX_FRAMES = Number(window.slowmoMaxFrames || 240); // hard cap ~8s at 30fps

  let active = false;
  let releaseFrame = null;
  let lastSeenFrame = -1;

  // You should implement these two using your existing player controls
  function setPlaybackRate(rate) {
    try { window.videoPlayer.playbackRate = rate; } catch {}
  }
  function setToSlow() { setPlaybackRate(Math.max(0.1, SLOW_FPS / (window.sourceFps || 30))); }
  function setToNormal() { setPlaybackRate(1); }

  function armSlow(frame) {
    releaseFrame = frame;
    lastSeenFrame = frame;
    if (!active) {
      setToSlow();
      active = true;
      // console.log('[slowmo] ON @', frame);
    }
  }

  function disarmSlow(reason, frame) {
    if (active) {
      setToNormal();
      active = false;
      // console.log('[slowmo] OFF:', reason, '@', frame);
    }
    releaseFrame = null;
  }

  // Public per-frame tick (call from your main loop)
  window.slowmoTick = function slowmoTick(frameIdx) {
    lastSeenFrame = frameIdx;

    const bs = window.ballState || {};
    // If we never armed, nothing to do
    if (!active) return;

    // 1) Normal end conditions
    if (bs?.proxExitFrame != null || bs?.state === 'FROZEN') {
      return disarmSlow('exit-or-frozen', frameIdx);
    }

    // 2) Safety: if we’ve been slow for too long, bail out
    if (Number.isFinite(releaseFrame) && frameIdx - releaseFrame > MAX_FRAMES) {
      return disarmSlow('timeout', frameIdx);
    }

    // 3) Safety: if we lost the hoop/ball for a while after release, bail out
    if (bs?._btFramesOutside >= (Number(window.PROX_OUT_CONSEC_MIN) || 2) + 6) {
      return disarmSlow('outside-too-long', frameIdx);
    }
  };

  // Events from your scorer
  window.addEventListener('shot:release', (e) => {
    const frame = e?.detail?.frame ?? (window.ballState?.f ?? 0);
    armSlow(frame);
  });

  // Either of these should kill slow-mo
  window.addEventListener('shot:end',     (e) => disarmSlow('end',     e?.detail?.frame ?? lastSeenFrame));
  window.addEventListener('shot:summary', (e) => disarmSlow('summary', e?.detail?.frame ?? lastSeenFrame));
})();
