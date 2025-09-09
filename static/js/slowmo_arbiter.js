(function installSlowmoArbiter(){
  if (window.DISABLE_SLOWMO || window.__SESSION_ACTIVE || window.USE_FBF_DURING_SHOT === false) {
    window.slowmoTick = () => {};
    return;
  }
  const SLOW_FPS   = Number(window.slowmoFps || 3);
  const MAX_FRAMES = Number(window.slowmoMaxFrames || 240);

  let active = false;
  let releaseFrame = null;
  let lastSeenFrame = -1;

  function setPlaybackRate(rate){
    try { const v = document.getElementById('videoPlayer') || window.videoPlayer; if (v) v.playbackRate = rate; } catch {}
  }
  function setToSlow(){ setPlaybackRate(Math.max(0.1, SLOW_FPS / (window.sourceFps || 30))); }
  function setToNormal(){ setPlaybackRate(1); }

  function armSlow(frame){ releaseFrame = frame; lastSeenFrame = frame; if (!active){ setToSlow(); active = true; } }
  function disarmSlow(reason, frame){ if (active){ setToNormal(); active = false; } releaseFrame = null; }

  window.slowmoTick = function(frameIdx){
    lastSeenFrame = frameIdx;
    const bs = window.ballState || {};
    if (!active) return;
    if (bs?.proxExitFrame != null || bs?.state === 'FROZEN') return disarmSlow('exit-or-frozen', frameIdx);
    if (Number.isFinite(releaseFrame) && frameIdx - releaseFrame > MAX_FRAMES) return disarmSlow('timeout', frameIdx);
    if (bs?._btFramesOutside >= ((Number(window.PROX_OUT_CONSEC_MIN)||2)+6)) return disarmSlow('outside-too-long', frameIdx);
  };

  window.addEventListener('shot:release', (e) => { armSlow(e?.detail?.frame ?? (window.ballState?.f ?? 0)); });
  window.addEventListener('shot:end',     (e) => disarmSlow('end',     e?.detail?.frame ?? lastSeenFrame));
  window.addEventListener('shot:summary', (e) => disarmSlow('summary', e?.detail?.frame ?? lastSeenFrame));
})();