// Legacy loader that backfills the ES module version of shot_arc when this file is included
// via a classic <script> tag (no type="module"). It keeps older entrypoints working while
// newer code imports /static/js/shot_arc.module.js directly.




(function legacyShotArcBootstrap(){
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return;
  }
  if (window.__shotArcLegacyBootstrapped) {
    return;
  }
  window.__shotArcLegacyBootstrapped = true;

  const target = (typeof window.shotArc === 'object' && window.shotArc) ? window.shotArc : {};
  window.shotArc = target;

  const resetStub = target.resetShotFSM || function resetShotFSMLegacy() {};
  const releaseStub = target.updateRelease || function updateReleaseLegacy() { return false; };
  const exitStub = target.updateExit || function updateExitLegacy() { return false; };
  const tickStub = target.updateShotArcTick || function updateShotArcTickLegacy() { return null; };
  const arcStub = target.updateArc || function updateArcLegacy() { return null; };
  const proxStub = target.proxFromHoop || function proxFromHoopLegacy() { return null; };
  const refineStub = target.refineBallTrajectory || function refineBallTrajectoryLegacy() { return target; };
  const testStub = target.testTrajectoryRefinement || function testTrajectoryRefinementLegacy() { return target; };

  target.resetShotFSM = resetStub;
  target.updateRelease = releaseStub;
  target.updateExit = exitStub;
  target.updateShotArcTick = tickStub;
  target.updateArc = arcStub;
  target.proxFromHoop = proxStub;
  target.refineBallTrajectory = refineStub;
  target.testTrajectoryRefinement = testStub;

  const current = document.currentScript;
  const src = (current && current.src) || '';
  const moduleUrl = (() => {
    const match = src.match(/^(.*\/)?shot_arc\.js(\?.*)?$/i);
    if (!match) return 'shot_arc.module.js';
    const prefix = match[1] || '';
    const suffix = match[2] || '';
    return `${prefix}shot_arc.module.js${suffix}`;
  })();

  const script = document.createElement('script');
  script.type = 'module';
  script.src = moduleUrl;
  script.onload = () => {
    try {
      if (window.shotArcModule && typeof window.shotArcModule === 'object') {
        Object.assign(target, window.shotArcModule);
      }
      window.__shotArcLoadedOnce = true;
      if (window.console && typeof window.console.log === 'function') {
        console.log('[shot_arc] legacy bootstrap loaded module version');
      }
    } catch {}
  };
  script.onerror = (err) => {
    window.__shotArcLegacyError = err;
    if (window.console && typeof window.console.warn === 'function') {
      console.warn('[shot_arc] failed to load module build', err);
    }
  };

  const parent = document.head || document.documentElement || document.body;
  if (parent) {
    parent.appendChild(script);
  }
})();
