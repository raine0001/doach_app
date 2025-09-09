// auto_fix_orchestrator.js
(function installSelfHealWatchdog(){
  if (window.__doachWatchdogInstalled) return;
  window.__doachWatchdogInstalled = true;

  const MAX_STEPS = 4;
  let steps = 0;

  // Runtime knobs (idempotent)
  window.DoachFix = Object.assign({
    enableProxFSM:   false,
    autoArmScoring:  true,
    finalizeOnEnded: true,
    proxX:           200,
    proxYAbove:      170,
    proxYBelow:      100,
    postExitHold:    8,
    belowMargin:     10,
  }, window.DoachFix || {});

  function applyKnobs() {
    window.__ENABLE_PROX_FSM      = !!window.DoachFix.enableProxFSM;
    window.__readyForScoring      ||= !!window.DoachFix.autoArmScoring;
    window.POST_EXIT_HOLD          = window.DoachFix.postExitHold;
    window.FINALIZE_BELOW_MARGIN   = window.DoachFix.belowMargin;
    window.proxX                   = window.DoachFix.proxX;
    window.proxYAbove              = window.DoachFix.proxYAbove;
    window.proxYBelow              = window.DoachFix.proxYBelow;
  }
  applyKnobs();

  // Public entry point the app can call with its diag blob
  window.reportNoProgress = function reportNoProgress(diag) {
    if (steps >= MAX_STEPS) return;
    steps++;

    const arcZero = (diag?.arc?.len ?? 0) === 0;
    const enter   = diag?.bs?.proxEnterFrame;
    const exit    = diag?.bs?.proxExitFrame;
    const noEnter = !Number.isFinite(enter);
    const noExit  = !Number.isFinite(exit);

    // 1) Widen proximity window if we never stamp enter/exit
    if (noEnter || noExit) {
      window.DoachFix.proxX      = Math.min(280, (window.DoachFix.proxX || 200) + 40);
      window.DoachFix.proxYAbove = Math.min(220, (window.DoachFix.proxYAbove || 170) + 20);
      window.DoachFix.proxYBelow = Math.min(160, (window.DoachFix.proxYBelow || 100) + 20);
    }
    // 2) Make finalization easier if exit doesn’t advance
    if (noExit) {
      window.DoachFix.postExitHold = Math.max(4, (window.DoachFix.postExitHold || 8) - 2);
      window.DoachFix.belowMargin  = Math.max(6, (window.DoachFix.belowMargin  || 10) - 2);
    }
    // 3) If arc stays zero or never enters, force the direct prox FSM
    if (arcZero || noEnter) {
      window.DoachFix.enableProxFSM = true;
    }
    applyKnobs();

    // Re-kick analyzer in the same run
    try {
      const v = window.__videoEl || document.getElementById('videoPlayer') || document.querySelector('video');
      const c = document.getElementById('overlay') || document.getElementById('videoCanvas') || window.videoCanvas;
      if (v && c) {
        window.stopFrameAnalysis?.();
        window.analyzeVideoFrameByFrame?.(v, c);
      }
    } catch {}

    window.dispatchEvent(new CustomEvent('autofix:applied', { detail: { steps, DoachFix: {...window.DoachFix} } }));
  };
})();