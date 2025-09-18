// âœ… [video_ui.js] - Enhancements for DOACH Mobile/Full-Screen Integration
import { setOverlayInteractive } from './fix_overlay_display.js';
import { speak } from './coach_voice.js';
import { arcHeightLabel } from './shot_utils.js';
import { enableHoopPickOnce } from './app.js';
import { stabilizeLockedHoop, getLockedHoopBox, handleHoopSelection } from './hoop_tracker.js';


window.getLockedHoopBox = getLockedHoopBox;
window.handleHoopSelection = handleHoopSelection; \r\ntry { if (typeof window.__sessionContinue === 'undefined') window.__sessionContinue = true; } catch {}\r\nconst shouldEnforceSessionCap = () => window.__sessionContinue !== true;\r\n\r\n// ---------------------------------------------------------------
// Connection banner: show backend origin and active session id
// ---------------------------------------------------------------
function mountConnectionBanner() {
  try {
    const root = ensureHudRoot?.() || document.body;
    let box = document.getElementById('connBanner');
    const hidden = (localStorage.getItem('doach_hide_conn_banner') === '1') && (window.SHOW_CONN_BANNER !== true);
    if (!box) {
      box = document.createElement('div');
      box.id = 'connBanner';
      box.className = 'hud-card';
      Object.assign(box.style, {
        position: 'absolute', top: '8px', left: '10px',
        padding: '6px 8px', font: '600 11px system-ui',
        zIndex: 10080, pointerEvents: 'auto',
        opacity: 0.95
      });
      root.appendChild(box);
    }

    const origin = (location && location.origin) ? location.origin : (location.protocol + '//' + location.host);
    const sid = (window.__SESSION_ID || 'â€”');
    const debugHref = (sid && sid !== 'â€”') ? `/admin/session/${sid}/debug` : null;
    const healthHref = '/healthz';
    const html = [
      `<span style="opacity:.9">Connected:</span> <span style="font-weight:700">${origin}</span>`,
      `&nbsp;&nbsp;<span style="opacity:.9">sid:</span> <span id="connSidVal" style="font-weight:700">${sid}</span>`,
      debugHref ? `&nbsp;<a id="connDbg" href="${debugHref}" target="_blank" style="text-decoration:none">debug</a>` : '',
      `&nbsp;<a id="connHealth" href="${healthHref}" target="_blank" style="text-decoration:none">health</a>`,
      `&nbsp;<button id="connHide" class="vc-btn" title="Hide" style="padding:0 6px">Ã—</button>`
    ].join('');
    box.innerHTML = html;
    box.style.display = hidden ? 'none' : 'block';

    // Wire hide
    try {
      box.querySelector('#connHide')?.addEventListener('click', () => {
        localStorage.setItem('doach_hide_conn_banner', '1');
        box.style.display = 'none';
      }, { once: true });
    } catch {}

    // Live update when SID changes
    clearInterval(box.__upd);
    box.__lastSid = sid;
    box.__upd = setInterval(() => {
      try {
        const curSid = (window.__SESSION_ID || 'â€”');
        if (curSid !== box.__lastSid) {
          box.__lastSid = curSid;
          const val = box.querySelector('#connSidVal');
          if (val) val.textContent = curSid;
          const a = box.querySelector('#connDbg');
          if (a) a.setAttribute('href', `/admin/session/${curSid}/debug`);
          box.style.display = ((localStorage.getItem('doach_hide_conn_banner') === '1') && (window.SHOW_CONN_BANNER !== true)) ? 'none' : 'block';
        }
      } catch {}
    }, 800);

  } catch {}
}
window.mountConnectionBanner = mountConnectionBanner;

// Slow_arbiter.js â€” make sure it reads SLOW_RATE
(function installSlowArbiter(){  
  // Fully opt-in only. Unless explicitly enabled, do nothing.
  if (window.ENABLE_SLOWMO !== true) { return; }
  if (window.__SESSION_ACTIVE) return;
  if (window.__SlowInstalled) return; window.__SlowInstalled = true;

  const getV = () => document.getElementById('videoPlayer') || document.querySelector('video');
  let desired = 1, capTo = 0;

  function cfgRate() {
    const r = Number(window.SLOW_RATE ?? 0.35);
    return (isFinite(r) && r > 0 && r <= 1) ? r : 0.35;
  }
  function setRate(r, why){
    const v = getV(); if (!v) return;
    if (v.playbackRate !== r) { try { v.playbackRate = r; } catch {} }
    desired = r;
    // console.log('[Slow]', why, 'â†’', r);
  }

  window.addEventListener('shot:release', (e) => {
    // In live sessions or when FBF disabled, never alter playback rate
    if (window.__SESSION_ACTIVE || window.USE_FBF_DURING_SHOT === false) return;
    if (window.__fbfActive) return;
    capTo = performance.now() + 2500;
    setRate(cfgRate(), 'release');
    console.log('[video_ui] shot:release()');
  });

  // HUD counters: reflect shot in-progress on release
  try {
    if (!window.__hudReleaseWired) {
      window.__hudReleaseWired = true;
  window.addEventListener('shot:release', (e) => {
        try {
          // Cap session at cap_DEFAULT shots
          try {
            const cap = getSessionCap();
            const cur = Array.isArray(window.__shotList) ? window.__shotList.length : 0;
            if (shouldEnforceSessionCap() && cur >= cap) return;
          } catch {}
          // Auto-create a backend session if missing
          try { ensureSessionId(); } catch {}
          // Ignore any release before hoop is confirmed/locked
          if (window.__hoopConfirmed !== true) return;
          if (!window.getLockedHoopBox?.()) return;
          if (window.__shotTrackingArmed !== true) return;
          // Require live pose before logging
          try { const k = (window.playerState?.keypoints||[]).length; if (k < 33) return; } catch {}
          // UI cooldown only; trust the upstream release latch
          const unlockMs = Number(window.NEXT_SHOT_UNLOCK_MS ?? 3000);
          const now = performance.now();
          const lastUiMs = Number(window.__UI_LAST_RELEASE_MS || 0);
          if (now - lastUiMs < unlockMs) return; // UI cooldown: ignore rapid repeats

          // Trust upstream latch; UI enforces only armed + hoop + cooldown

          // Ensure a pending shot record exists immediately on pose release
          const list = (window.__shotList ||= []);
          const rf = Number(e?.detail?.frame || 0);
          const lastEntry = list.at?.(-1) || null;
          const same = lastEntry && Number.isFinite(lastEntry.frameRelease) && lastEntry.frameRelease === rf;
          if (!same) {
            const snap = (typeof window.extractPoseSnapshot === 'function' && window.playerState?.keypoints)
              ? window.extractPoseSnapshot(window.playerState.keypoints, window.getLockedHoopBox?.())
              : null;
            list.push({ pending: true, frameRelease: rf, tMs: Date.now(), poseSnapshot: snap });
            try { console.log('[HUD:add-pending]', { frame: rf, len: list.length }); } catch {}
            try { window.__SHOT_IDX = (list.length - 1); } catch {}
          }
          window.__UI_LAST_RELEASE_MS = now;
          const taken = list.length;
          const made = (window.shotLog?.filter?.(s => s.made).length || 0);
          const acc = taken ? Math.round((made / taken) * 100) : 0;
          window.mountSessionHUD?.();
          window.updateSessionHUD?.({ taken, made, accuracy: acc, elapsedSec: Math.floor((Date.now() - (window.__sessionStart||Date.now()))/1000) });
          window.setSessionStatus?.('Shot ' + taken + ' in progress');
          if (window.SESSION_MANAGER_OWNS_ENDING !== true) {
            try {
              const cap = getSessionCap();
              const count = Math.max((window.__shotList||[]).length, Number(window.__SCORE_SHOT_COUNT || 0));
              if (shouldEnforceSessionCap() && Number.isFinite(cap) && count >= cap && window.__summaryShown !== true) {
                try { window.__sessionCapped = true; } catch {}
                try { window.__capAwait = true; } catch {}
                // Do NOT stop camera/analyzer yet; allow final summary to emit
                try { if (window.__capTimer) clearTimeout(window.__capTimer); } catch {}
                try {
                  window.__capTimer = setTimeout(() => {
                    try { if (window.__capAwait && window.__summaryShown !== true) window.autoEndSessionAndSummarize?.(); } catch {}
                  }, Math.max(1200, Number(window.CAP_SUMMARY_GRACE_MS || 1600)));
                } catch {}
              }
            } catch {}
          }
        } catch {}
      });
    }
  } catch {}

  window.addEventListener('shot:summary', () => {
    capTo = 0;
    setRate(1, 'summary');
    if (window.SESSION_MANAGER_OWNS_ENDING !== true) {
      try {
        if (window.__capAwait && window.__summaryShown !== true) {
          window.__capAwait = false;
          try { if (window.__capTimer) clearTimeout(window.__capTimer); } catch {}
          setTimeout(() => { try { window.autoEndSessionAndSummarize?.(); } catch {} }, 120);
        }
      } catch {}
    }
  });

  // On end-session, speak and open summary table automatically
  window.addEventListener('hud:end-session', () => {
    try { if (window.PREF_VOICE_INTRO === true) speak('I am finalizing the session with shot results.'); } catch {}
    try { renderFullShotTable(); wireFullShotModalActions(); } catch {}
  });

  window.addEventListener('shot:end', () => { setRate(1, 'end'); });

  // NEW: unlock on early "end" signal too
  window.addEventListener('shot:end', () => {
    capTo = 0;
    setRate(1, 'end');
  });

  // enforce / cap
  (function tick(){
    const v = getV();
    if (window.__fbfActive) { requestAnimationFrame(tick); return; }
    if (v && v.playbackRate !== desired) setRate(desired, 'enforce');
    // hard stop if tracker has finalized or we bounced to idle
    const bs = window.ballState || {};
    if (desired < 0.99 && (bs.state === 'FROZEN' || bs.state === 'IDLE')) setRate(1, 'state');
    if (desired < 0.99 && capTo && performance.now() > capTo) setRate(1, 'cap');
    requestAnimationFrame(tick);
  })();

  // media hygiene â€” any manual interaction cancels slow-mo
  const v = getV();
  if (v) {
    v.addEventListener('play',    () => setRate(1, 'play'));
    v.addEventListener('pause',   () => setRate(1, 'pause'));
    v.addEventListener('seeking', () => setRate(1, 'seek'));
    v.addEventListener('ended',   () => setRate(1, 'ended'));
    // Keep 1x during live sessions and uploaded demos; diagnose offenders changing rate
    try {
      clearInterval(window.__rateGuard);
      window.__rateGuard = setInterval(() => {
        try {
          if (!window.__BG_ONLY && v.playbackRate !== 1) {
            console.warn('[rateGuard] forcing 1x (was', v.playbackRate, ')');
            v.playbackRate = 1;
          }
        } catch {}
      }, 500);
    } catch {}
  }
})();

// --- Minimal HUD wires (always-on) -------------------------------------------
// Ensure the session HUD 'shots taken' and coach prefixes advance even when
// slow-mo arbiter is disabled. Reuses the same guard flag to avoid double wiring.
(function installMinimalHudWires(){
  try {
    if (window.__hudReleaseWired) return; // already wired by slowmo block
    window.__hudReleaseWired = true;

    window.addEventListener('shot:release', (e) => {
      try {
        // Ignore any release before hoop is confirmed/locked
        if (window.__hoopConfirmed !== true) return;
        if (!window.getLockedHoopBox?.()) return;
        // Ensure a pending shot record exists immediately on pose release
        const list = (window.__shotList ||= []);
        const rf = Number(e?.detail?.frame || 0);
        const lastEntry = list.at?.(-1) || null;
        const same = lastEntry && Number.isFinite(lastEntry.frameRelease) && lastEntry.frameRelease === rf;
        if (!same) {
          const snap = (typeof window.extractPoseSnapshot === 'function' && window.playerState?.keypoints)
            ? window.extractPoseSnapshot(window.playerState.keypoints, window.getLockedHoopBox?.())
            : null;
          list.push({ pending: true, frameRelease: rf, tMs: Date.now(), poseSnapshot: snap });
          try { window.__SHOT_IDX = (list.length - 1); } catch {}
        }
        const taken = list.length;
        const made = (window.shotLog?.filter?.(s => s.made).length || 0);
        const acc  = taken ? Math.round((made / taken) * 100) : 0;
        window.mountSessionHUD?.();
        window.updateSessionHUD?.({ taken, made, accuracy: acc, elapsedSec: Math.floor((Date.now() - (window.__sessionStart||Date.now()))/1000) });
        window.setSessionStatus?.('Shot ' + taken + ' in progress');

        // HARD STOP at cap: lock session and present summary
        if (window.SESSION_MANAGER_OWNS_ENDING === true) return;
        try {
          const cap = getSessionCap();
          const count = Math.max((window.__shotList||[]).length, Number(window.__SCORE_SHOT_COUNT || 0));
          if (shouldEnforceSessionCap() && Number.isFinite(cap) && count >= cap && window.__summaryShown !== true) {
            try { window.__sessionCapped = true; } catch {}
            try { window.__sessionEnded = true; } catch {}
            try { window.__SESSION_ACTIVE = false; } catch {}
            try { window.__shotTrackingArmed = false; } catch {}
            try { window.stopPoseReleaseSampler?.(); } catch {}
            setTimeout(() => { try { window.autoEndSessionAndSummarize?.(); } catch {} }, 120);
          }
        } catch {}
      } catch {}
    });

    // End on final summary as a backstop (ensures table even if release-path end was skipped)
    window.addEventListener('shot:summary', () => {
      if (window.SESSION_MANAGER_OWNS_ENDING === true) return;
      try {
        const cap   = getSessionCap();
        const taken = Math.max((window.__shotList||[]).length, Number(window.__SCORE_SHOT_COUNT || 0));
        if (shouldEnforceSessionCap() && Number.isFinite(cap) && taken >= cap && window.__summaryShown !== true) {
          // Lock and present now
          try { window.__sessionCapped = true; } catch {}
          try { window.__sessionEnded = true; } catch {}
          try { window.__SESSION_ACTIVE = false; } catch {}
          try { window.__shotTrackingArmed = false; } catch {}
          try { window.stopPoseReleaseSampler?.(); } catch {}
          setTimeout(() => { try { window.autoEndSessionAndSummarize?.(); } catch {} }, 60);
        }
      } catch {}
    }, { passive:true });
  } catch {}
})();

// ---- Global slow-mo FPS ----
window.FRAMEbyFRAME_RATE = window.FRAMEbyFRAME_RATE ?? 1.0; // default 1 fps
window.setFBFRate = (fps) => {
  window.FRAMEbyFRAME_RATE = Math.max(0.25, Number(fps) || 1.0);
  console.log('[video_ui] slow-mo fps =', window.FRAMEbyFRAME_RATE);
};

const SESSION_SIZE_DEFAULT = 10;  // default cap if nothing else provided
function getSessionCap() {
  // Query-string override (?cap=3)
  try {
    const q = new URLSearchParams(location.search || '');
    const qp = q.get('cap');
    const parsed = Number(qp);
    if (qp != null && qp !== '' && Number.isFinite(parsed) && parsed > 0) return parsed;
  } catch {}

  // Global values (SESSION_CAP, SESSION_SIZE, etc.)
  const env = Number(window.__SESSION_CAP ?? window.SESSION_CAP ?? window.SESSION_SIZE ?? window.TEST_SESSION_SIZE);
  if (Number.isFinite(env) && env > 0) return env;

  // LocalStorage override
  let ls = null;
  try { ls = Number(localStorage.getItem('doach.sessionCap')); } catch {}
  if (Number.isFinite(ls) && ls > 0) return ls;

  // Fallback default
  return SESSION_SIZE_DEFAULT;
}
try { window.getSessionCap = getSessionCap; } catch {}

let __capEnforceTimer = null;

export function moveUploadToSidebar() {
  const chooseBtn = document.getElementById('videoInput');
  const menuContainer = document.getElementById('sidebar-content');

  if (chooseBtn && menuContainer) {
    const label = document.createElement('label');
    label.innerHTML = 'ðŸ“‚ <strong>Upload Video</strong>';
    label.style.cursor = 'pointer';
    label.className = 'sidebar-upload-btn';
    label.appendChild(chooseBtn);
    chooseBtn.style.display = 'none';
    menuContainer.appendChild(label);
  }
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€ Single-frame step (RVFC/arbiter-safe) â”€â”€â”€â”€â”€â”€â”€â”€â”€

// Keep a tiny state so any old callers don't crash
let __framePlay = { on:false, timer:null, cleanup:null, fps:12, video:null };

function getVideoEl() {
  return window.__videoEl
      || window.video
      || document.getElementById('videoPlayer')
      || document.querySelector('video');
}

function getFPS(v) {
  // prefer a known fps if you set it elsewhere; fall back to 30
  return Number(window.__videoFPS) > 0 ? Number(window.__videoFPS) : 30;
}

// No-op, just clears any legacy timers if they exist
export function cancelFramePlay(){
  if (__framePlay.timer) clearTimeout(__framePlay.timer);
  if (__framePlay.cleanup) { try{ __framePlay.cleanup(); }catch{} }
  __framePlay = { on:false, timer:null, cleanup:null, fps:12, video:null };
}

// play control - step forward & back one frame
export async function stepFrame(video, dir = +1){
  video = video || getVideoEl();
  if (!video) return;

  try { video.pause(); } catch {}
  const fps  = getFPS(video);
  const dt   = (1 / fps) * (dir >= 0 ? 1 : -1);
  const next = Math.max(0, Math.min((video.duration || Infinity), (video.currentTime || 0) + dt));
  if (Math.abs(next - (video.currentTime || 0)) < 1e-6) return;

  // wait until that frame is actually decoded/presented
  const once = new Promise(res => video.addEventListener('seeked', res, { once:true }));
  video.currentTime = next;
  try { await once; } catch {}

  // If app.js exposes a one-shot render hook, use it; otherwise
  // any overlays will refresh next time you play.
  if (typeof window.renderCurrentFrameOnce === 'function') {
    try { window.renderCurrentFrameOnce(video); } catch {}
  } else {
    // Emit a lightweight signal in case the analyzer listens for manual steps
    window.dispatchEvent(new CustomEvent('video:stepped', { detail: { time: video.currentTime }}));
  }
}

// Legacy FBF shell (kept only so old callers wonâ€™t crash)
export function startFramePlay(/* video, fps */){
  console.log('[video_ui] startFramePlay() ignored (RVFC/arbiter active)');
  cancelFramePlay();
}

window.frameMode = {
  on()  { console.log('[video_ui] frameMode.on() ignored (RVFC/arbiter active)'); },
  off() { cancelFramePlay(); },
  isOn(){ return false; }
};


// UI toggle for scorer mode (Weighted / Hybrid)
export function mountScorerToggle(container) {
  const root = container || document.getElementById('promptBar') || document.body;
  if (!root || root.__scorerToggleMounted) return;
  root.__scorerToggleMounted = true;

  const wrap = document.createElement('div');
  wrap.className = 'scorer-toggle';
  Object.assign(wrap.style, {
    display: 'inline-flex',
    gap: '10px',
    alignItems: 'center',
    marginLeft: '12px',
    padding: '4px 6px',
    background: 'rgba(0,0,0,.35)',
    borderRadius: '8px'
  });
  wrap.innerHTML = `
    <span style="opacity:.85">Scorer:</span>
    <label><input type="radio" name="scorerMode" value="weighted"> Weighted</label>
    <label><input type="radio" name="scorerMode" value="hybrid"> Hybrid</label>
  `;
  root.appendChild(wrap);

  const apply = (m) => {
    window.setScorerMode?.(m);
    wrap.querySelectorAll('input[name="scorerMode"]').forEach(inp => {
      inp.checked = (inp.value === m);
    });
  };

  const saved = (window.SHOT_SCORER_MODE || localStorage.getItem('doach_scorer_mode') || 'weighted').toLowerCase();
  apply(saved);

  wrap.addEventListener('change', (e) => {
    if (e.target?.name === 'scorerMode') apply(e.target.value);
  });
}
window.mountScorerToggle = mountScorerToggle;


// where are we in the session
export function setSessionStatus(text = '') {
  const root = ensureHudRoot();
  let badge = document.getElementById('sessionStatusBadge');
  if (!badge) {
    badge = document.createElement('div');
    badge.id = 'sessionStatusBadge';
    badge.className = 'hud-card';
    Object.assign(badge.style, {
      position:'absolute', bottom:'90px', left:'50%', transform:'translateX(-50%)',
      padding:'6px 10px', font:'600 12px system-ui', letterSpacing:'0.04em',
      pointerEvents:'none'
    });
    root.appendChild(badge);
  }
  badge.textContent = text || 'SESSION IN PROGRESSâ€¦';
  badge.style.display = text === null ? 'none' : 'block';
}

// -----------------------------------------------------------------//
// â”€â”€â”€â”€â”€â”€â”€â”€â”€ Playback controls UI (mounted inside hudRoot) â”€â”€â”€â”€â”€â”€â”€â”€â”€//
// -----------------------------------------------------------------//
export function createPlaybackControls(video) {
  window.__videoEl = video;
  // remove any previous bar (prevent duplicates after re-load)
  const root = ensureHudRoot(); // <-- always sit above the video
  root.querySelectorAll('.video-controls').forEach(el => el.remove());

  // In background-only mode, do not render transport controls at all.
  if (window.__BG_ONLY) {
    return;
  }

  // Camera switcher now lives in the bottom HUD as an icon button

  // Skip transport controls for live camera feeds (srcObject present)
  // but still mount the session HUD so the bottom bar is always visible.
  try {
    if (video && video.srcObject) {
      try { mountSessionHUD(); setSessionStatus('SESSION IN PROGRESS'); } catch {}
      return;
    }
  } catch {}

  // If a live session is active, do NOT render playback transport controls.
  // We still mount the session HUD/status, but keep user playback in real-time.
  if (window.__SESSION_ACTIVE) {
    mountSessionHUD();
    setSessionStatus('SESSION IN PROGRESS');
    return;
  }

  const container = document.createElement('div');
  container.className = 'video-controls hud-card hud-pill';
  Object.assign(container.style, {
    position: 'absolute',
    left: '50%',
    transform: 'translateX(-50%)',
    bottom: '88px',            // sits above the bottom HUD
    display: 'flex',
    gap: '8px',
    pointerEvents: 'auto',
    zIndex: 10010              // over the HUD
  });

  const mk = (txt, title, on) => {
    const b = document.createElement('button');
    b.className = 'vc-btn';
    b.textContent = txt;
    b.title = title || '';
    b.addEventListener('click', (e) => { e.stopPropagation(); on?.(); });
    return b;
  };

  // ---- buttons ----
  const bHome  = mk('âª','Go to start',    () => { cancelFramePlay(); video.pause(); video.currentTime = 0; });
  const bPause = mk('â¸','Pause',          () => { cancelFramePlay(); video.pause(); });
  const bPlay  = mk('â–¶','Play', () => {
    if (!requireHoopOrPrompt()) return;
    cancelFramePlay(); try { video.playbackRate = 1.0; } catch {}
    video.play();
  });
  const bAuto  = mk('ðŸŽž','Auto-step', () => {
    if (!requireHoopOrPrompt()) return;
    if (__framePlay.on) { cancelFramePlay(); bAuto.dataset.active='0'; }
    else { startFramePlay(video, Number(window.FRAMEbyFRAME_RATE) || 1.0); video.pause(); bAuto.dataset.active='1'; }
  });
  const bNext  = mk('â­','Next',  () => { if (!requireHoopOrPrompt()) return; stepFrame(video,+1); });
  const bPrev  = mk('â®','Prev',  () => { if (!requireHoopOrPrompt()) return; stepFrame(video,-1); });

  [bPrev,bHome,bPlay,bPause,bAuto,bNext].forEach(b => container.appendChild(b));
  root.appendChild(container);

  // keep things tidy
  video.addEventListener('ended', () => { cancelFramePlay(); bAuto.dataset.active = '0'; });
  video.addEventListener('play',  () => { if (__framePlay.on) video.pause(); }); // donâ€™t fight auto-step

  // lift the rest of the HUD too (metrics + status)
  mountSessionHUD();
  setSessionStatus('SESSION IN PROGRESSâ€¦');

  // handy toggle for HTML
  window.togglePlay = () => {
    if (!requireHoopOrPrompt()) { video.pause(); return; }
    video.paused ? video.play() : video.pause();
  };
}

// Show shot summary overlay
export function showShotSummaryOverlay(summary) {
  const div = document.createElement('div');
  div.className = 'shot-overlay-summary';
  div.style.position = 'absolute';
  div.style.bottom = '20px';
  div.style.right = '20px';
  div.style.background = 'rgba(0,0,0,0.7)';
  div.style.color = 'white';
  div.style.padding = '10px';
  div.style.borderRadius = '8px';
  div.style.zIndex = '99';

  const arcLabel = (() => { try { return arcHeightLabel(summary); } catch { return 'good'; } })();
  div.innerHTML = `
    <strong>${summary.made ? 'âœ… Made' : 'âŒ Missed'} Shot</strong><br>
    Arc: ${arcLabel}<br>
    Entry Angle: ${summary.entryAngle}&#176;<br>
    Release Angle: ${summary.releaseAngle}&#176;<br>
    Accuracy: ${summary.accuracy}% (${summary.madeShots}/${summary.totalShots})<br>
  `;

  document.querySelector('.video-box').appendChild(div);
  setTimeout(() => div.remove(), 2500);
}

// Helper - hoop selection, user must confirm hoop on startup
window.__hoopConfirmed = false;

function requireHoopOrPrompt() {
  if (isHoopReady()) return true;
  showPromptMessage('ðŸ“ Tap the hoop to begin setup', 3000);
  if (!window.__hoopPickArmed) {
    window.__hoopPickArmed = true;
    window.enableHoopPickOnce?.();   // arm picker again if needed
  }
  return false;
}

window.isHoopReady = isHoopReady;
window.requireHoopOrPrompt = requireHoopOrPrompt;

// â”€â”€ Unified prompt system (uses #overlayPrompt if present, else #promptBar) â”€â”€

function hasCenter(h) {
  return Number.isFinite(h?.cx ?? h?.x) && Number.isFinite(h?.cy ?? h?.y);
}
function hasSize(h) {
  const w = h?.w ?? h?.width, hh = h?.h ?? h?.height;
  return Number.isFinite(w) && Number.isFinite(hh) && w >= 10 && hh >= 6;
}

// accept center-only OR sized boxes
function isValidHoopBox(h) {
  return !!h && (hasCenter(h) || hasSize(h));
}

function isHoopReady() {
  const h = window.getLockedHoopBox?.();  // ðŸ‘ˆ use window.*
  const ready = !!window.__hoopConfirmed && isValidHoopBox(h);
  try {
    if (window.DOACH_HOOP_GATE_LOG === true) {
      console.log('[gate:isHoopReady]', {
        confirmed: window.__hoopConfirmed,
        hasCenter: hasCenter(h),
        hasSize: hasSize(h),
        ready
      });
    }
  } catch {}
  return ready;
}


// Prompt element for user instructions
function getPromptEl() {
  const root = ensureHudRoot();
  let el = document.getElementById('overlayPrompt') || document.getElementById('promptBar');
  if (!el) {
    el = document.createElement('div');
    el.id = 'promptBar';
    root.appendChild(el);
  } else if (!root.contains(el)) {
    root.appendChild(el);
  }
  Object.assign(el.style, {
    position: 'absolute', top: '8px', left: '50%', transform: 'translateX(-50%)',
    background: 'rgba(0,0,0,0.7)', color: '#fff', padding: '8px 12px',
    borderRadius: '8px', font: '600 14px system-ui, sans-serif',
    display: 'none', pointerEvents: 'none', zIndex: '10001'
  });
  return el;
}

export function showPromptMessage(text, duration = 3000) {
  const el = getPromptEl();
  el.textContent = text;
  el.style.display = 'block';
  el.style.opacity = '1';
  if (el.__t) clearTimeout(el.__t);
  el.__t = setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => (el.style.display = 'none'), 300);
  }, duration);
}

function hidePromptMessage() {
  const el = document.getElementById('overlayPrompt') || document.getElementById('promptBar');
  if (!el) return;
  if (el.__t) clearTimeout(el.__t);
  el.style.display = 'none';
}

// Poll until hoop is *stably* locked (2 consecutive checks)
function startHoopPromptLoop() {
  clearInterval(window.__hoopPromptTimer);

  const tick = () => {
    if (!isHoopReady()) {
      showPromptMessage('ðŸ“ Tap the hoop to begin setup', 3000);
      if (!window.__hoopPickArmed) {
        window.__hoopPickArmed = true;
        window.enableHoopPickOnce?.();
      }
    }
  };

  tick();
  window.__hoopPromptTimer = setInterval(tick, 1500); // keep â€œpulsingâ€ until confirmed
}

window.enableHoopPickOnce = enableHoopPickOnce;


// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Video UI / HUD utilities
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** Ensure an absolute overlay root that sits on top of the video */
export function ensureHudRoot() {
  const video = document.getElementById('videoPlayer');
  const host  = video?.parentElement || document.body;
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';

  let root = document.getElementById('hudRoot');
  if (!root) {
    root = document.createElement('div');
    root.id = 'hudRoot';
    host.appendChild(root);
  }
  Object.assign(root.style, { position:'absolute', inset:'0', pointerEvents:'none', zIndex:10000 });
  return root;
}

// ------------------ Admin Observer (optional) ------------------
// Stream low-FPS overlay snapshots to the server for remote viewing.
// Enable from console: startObserverStreaming(); stopObserverStreaming();
let __observerTimer = null;
window.startObserverStreaming = function startObserverStreaming(fps = 2){
  try {
    const sid = (window.__SESSION_ID || null);
    if (!sid) { console.warn('[observer] missing __SESSION_ID'); return; }
    const overlay = document.getElementById('overlay') || document.getElementById('hudRoot');
    const video = document.getElementById('videoPlayer');
    if (!overlay) { console.warn('[observer] overlay not found'); return; }
    const period = Math.max(200, Math.round(1000/Math.max(0.5, fps)));
    if (__observerTimer) clearInterval(__observerTimer);
    const off = document.createElement('canvas');
    __observerTimer = setInterval(async () => {
      try {
        const oc = overlay.tagName === 'CANVAS' ? overlay : null;
        const vw = (video?.videoWidth || oc?.width || 0);
        const vh = (video?.videoHeight || oc?.height || 0);
        if (!vw || !vh) return;
        off.width = vw; off.height = vh;
        const ctx = off.getContext('2d');
        if (!ctx) return;
        // Draw camera frame first (if accessible)
        if (video && video.readyState >= 2) {
          try { ctx.drawImage(video, 0, 0, vw, vh); } catch {}
        }
        // Draw overlay on top
        if (oc) { try { ctx.drawImage(oc, 0, 0, vw, vh); } catch {} }
        off.toBlob(async (blob) => {
          if (!blob) return;
          const fd = new FormData();
          fd.append('image', blob, 'frame.jpg');
          await fetch(`/api/sessions/${sid}/observer_frame`, { method:'POST', body: fd, credentials:'include' }).catch(()=>{});
        }, 'image/jpeg', 0.65);
      } catch {}
    }, period);
    console.log('[observer] streaming at', fps, 'fps');
  } catch (e) { console.warn('[observer] failed', e); }
};
window.stopObserverStreaming = function stopObserverStreaming(){ if (__observerTimer) { clearInterval(__observerTimer); __observerTimer = null; console.log('[observer] stopped'); } };

// Ensure a backend session exists when first needed
async function ensureSessionId(){
  try {
    if (window.__SESSION_ID) return window.__SESSION_ID;
    const r = await fetch('/api/sessions/start', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ device: navigator.userAgent }), credentials:'include' });
    if (!r.ok) return null;
    const j = await r.json();
    window.__SESSION_ID = j?.id || null; window.__SHOT_IDX = 0;
    return window.__SESSION_ID;
  } catch { return null; }
}

// Idempotent shot upsert to backend session.json (and DB if configured)
const __postedShots = new Set();
async function postShotUpsert(idx, patch, opts){
  try {
    const sid = await ensureSessionId();
    if (!sid) return;
    const key = `${sid}|${idx}|${patch && patch.made != null ? +!!patch.made : 'na'}`;
    const force = !!(opts && opts.force);
    if (!force && __postedShots.has(key)) return;
    __postedShots.add(key);
    try { if (window.SESS_FINAL_TRACE === true) console.log('[postShotUpsert]', { sid, idx, patch, force }); } catch {}
    await fetch(`/api/sessions/${sid}/shot`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(Object.assign({ idx, t: Date.now() }, patch||{})),
      credentials:'include'
    }).catch(()=>{});
  } catch {}
}

// -----------------------------------------------------------------//
// Camera switcher (front/back toggle + device picker)
// -----------------------------------------------------------------//
function currentFacingLabel() {
  try {
    const f = (localStorage.getItem('doach_camera_facing') || '').toLowerCase();
    if (f === 'user' || f === 'front') return 'Front';
    if (f === 'environment' || f === 'back' || f === 'rear') return 'Back';
  } catch {}
  return 'Back';
}

export async function mountCameraSwitcher() {
  const root = ensureHudRoot();
  let btn = document.getElementById('camToggleBtn');
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'camToggleBtn';
    btn.className = 'hud-card';
    Object.assign(btn.style, {
      position: 'absolute', top: '80px', right: '10px',
      padding: '8px 10px', font: '600 12px system-ui',
      pointerEvents: 'auto', zIndex: 10005, cursor: 'pointer'
    });
    btn.textContent = 'Back  ðŸ”';
    root.appendChild(btn);
  }

  const refresh = () => {
    try {
      const lab = currentFacingLabel();
      btn.textContent = (lab === 'Back' ? 'Back' : 'Front') + '  ðŸ”';
    } catch {}
  };
  refresh();

  let pressTimer = null, pop = null;

  async function flip() {
    try {
      await (window.flipCamera?.() || Promise.resolve());
      refresh();
      try { (window.showPromptMessage||window.showPrompt)?.('Switched camera'); } catch {}
    } catch (e) { console.warn('[cam] flip failed', e); }
  }

  async function showPicker() {
    try {
      if (pop) { try { pop.remove(); } catch {}; pop = null; }
      const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
      pop = document.createElement('div');
      pop.id = 'camDevicePopover';
      Object.assign(pop.style, {
        position:'absolute', top: '46px', right: '10px',
        background:'rgba(0,0,0,0.85)', color:'#fff', padding:'8px',
        borderRadius:'8px', zIndex:10025, pointerEvents:'auto', minWidth:'180px',
        border:'1px solid rgba(255,255,255,.15)'
      });
      const makeItem = (label, on) => {
        const a = document.createElement('div');
        a.textContent = label;
        Object.assign(a.style, { padding:'6px 8px', cursor:'pointer', font:'600 12px system-ui', borderRadius:'6px' });
        a.onmouseenter = () => a.style.background = 'rgba(255,255,255,.08)';
        a.onmouseleave = () => a.style.background = 'transparent';
        a.onclick = async () => { try { await on?.(); } finally { try { pop.remove(); } catch {}; pop = null; } };
        return a;
      };
      if (!devs.length) pop.appendChild(makeItem('No cameras found', null));
      devs.forEach((d,i) => pop.appendChild(makeItem(d.label || `Camera ${i+1}`, async () => {
        try {
          localStorage.setItem('doach_camera_id', String(d.deviceId||''));
          // Infer facing from label when possible to improve mobile reliability
          const lab = (d.label||'').toLowerCase();
          if (/front|user/.test(lab)) {
            localStorage.setItem('doach_camera_facing', 'user');
          } else if (/back|rear|environment/.test(lab)) {
            localStorage.setItem('doach_camera_facing', 'environment');
          }
        } catch {}
        try { await window.setPreferredCamera?.(d.deviceId); } catch {}
        refresh();
      })));
      // quick front/back preset
      pop.appendChild(makeItem('Use Back Camera', async () => { try { await window.setPreferredFacing?.('environment'); } catch {} refresh(); }));
      pop.appendChild(makeItem('Use Front Camera', async () => { try { await window.setPreferredFacing?.('user'); } catch {} refresh(); }));
      root.appendChild(pop);
      // auto-hide after 5s
      setTimeout(() => { try { pop.remove(); } catch {}; pop = null; }, 5000);
    } catch (e) { console.warn('[cam] picker failed', e); }
  }

  const clearTimer = () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } };
  btn.onmousedown = () => { clearTimer(); pressTimer = setTimeout(showPicker, 550); };
  btn.onmouseup = () => { if (pressTimer) { clearTimer(); flip(); } };
  btn.ontouchstart = () => { clearTimer(); pressTimer = setTimeout(showPicker, 550); };
  btn.ontouchend = () => { if (pressTimer) { clearTimer(); flip(); } };
}
try { if (!window.mountCameraSwitcher) window.mountCameraSwitcher = mountCameraSwitcher; } catch {}

/** Top-center session status line (â€œSESSION IN PROGRESSâ€¦â€) */
/** Bottom HUD bar (metrics + End Session) */
export function mountSessionHUD() {
  const root = ensureHudRoot();
  let bar = document.getElementById('sessionHUD');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'sessionHUD';
    bar.className = 'hud-card hud-pill';
    Object.assign(bar.style, {
      position:'absolute', left:'50%', transform:'translateX(-50%)',
      bottom:'18px', gap:'20px', pointerEvents:'auto'
    });

    bar.innerHTML = `
      <button id="hudMute" class="vc-btn" title="Mute/Unmute">ðŸ”‡</button>
      <button id="hudCamFlip" class="vc-btn" title="Flip Camera">ðŸ“·â†º</button>

      <div class="hud-metric" id="mShots"><div class="num">0/10</div><div class="label">Shots Taken</div></div>
      <div class="hud-metric" id="mTime"><div class="num">0:00</div><div class="label">Time Elapsed</div></div>
    `;
    root.appendChild(bar);

    // Do not auto-enable live tips by default; respect HUD mute and explicit user toggle elsewhere
    try { if (typeof window.PREF_LIVE_TIPS === 'undefined') window.PREF_LIVE_TIPS = false; } catch {}

    const muteBtn = bar.querySelector('#hudMute');
    const camBtn  = bar.querySelector('#hudCamFlip');

    // --- unified apply function: UI, storage, prefs, event
    const applyMute = (muted) => {
      // button reflects CURRENT state
      muteBtn.setAttribute('data-muted', muted ? '1' : '0');
      muteBtn.textContent = muted ? 'ðŸ”‡' : 'ðŸ”Š';
      // keep any legacy floating cam toggle hidden; HUD contains the control now
      try { const legacy = document.getElementById('camToggleBtn'); if (legacy) legacy.style.display = 'none'; } catch {}

      // persist & sync with doachPrefs so doachSpeak() logic matches HUD
      try { localStorage.setItem('doach_muted', JSON.stringify(muted)); } catch {}
      try {
        const prefs = window.doachGetPrefs?.() || {};
        // audioOn === !muted
        window.doachSetPrefs?.({ ...prefs, audioOn: !muted });
      } catch {}

      // notify coachAssistant.js (it listens for this)
      window.dispatchEvent(new CustomEvent('hud:mute-toggle', { detail: { muted } }));
    };

    // --- initialize from saved state (prefer HUD key, then doachPrefs)
    let savedMuted = false;
    try {
      if (localStorage.getItem('doach_muted') != null) {
        savedMuted = JSON.parse(localStorage.getItem('doach_muted'));
      } else {
        const p = window.doachGetPrefs?.() || {};
        if (typeof p.audioOn !== 'undefined') savedMuted = !p.audioOn;
      }
    } catch {}
    applyMute(savedMuted);

    // --- click to toggle
    muteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const muted = muteBtn.getAttribute('data-muted') === '1';
      applyMute(!muted);
    });

    // --- camera flip button (short press: toggle front/back)
    camBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        // Toggle facing preference and restart camera
        const cur = (localStorage.getItem('doach_camera_facing') || 'environment').toLowerCase();
        const next = (cur === 'user' || cur === 'front') ? 'environment' : 'user';
        localStorage.setItem('doach_camera_facing', next);
        if (typeof window.setPreferredFacing === 'function') await window.setPreferredFacing(next);
        else if (typeof window.flipCamera === 'function') await window.flipCamera();
      } catch (err) { console.warn('[hud] flip camera failed', err); }
    });

    // other HUD buttons (unchanged)
    const endBtn = bar.querySelector('#endSessionBtn');
    endBtn && endBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.dispatchEvent(new CustomEvent('hud:end-session'));
    });

    const startBtn = bar.querySelector('#startSessionHUD');
    startBtn && startBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      try { if (!window.__sessionStart) window.__sessionStart = Date.now(); } catch {}
      window.dispatchEvent(new CustomEvent('hud:start-session'));
    });

    // removed My Sessions from HUD (available in main menu)

    const summaryBtn = bar.querySelector('#openSummaryBtn');
    if (summaryBtn && !summaryBtn.__wired) {
      summaryBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        renderFullShotTable();
        wireFullShotModalActions();
      });
      summaryBtn.__wired = true;
    }
  }
  return bar;
}

function resetSessionClockAndCount(){
  try { window.__sessionStart = Date.now(); } catch {}
  try { window.__HUD_SHOT_COUNT = 0; window.shotTaken = 0; } catch {}
  try { window.__shotList = []; } catch {}
  try { if (Array.isArray(window.shotLog)) window.shotLog.length = 0; } catch {}
  try { updateSessionHUD({ taken: 0, elapsedSec: 0 }); } catch {}
}


/** Update numbers in the bottom HUD bar */
export function updateSessionHUD({ taken=0, made=0, accuracy=0, elapsedSec=0 } = {}) {
  const bar = mountSessionHUD();                              // ensure it exists and scope queries to it
try { if (typeof window.setSessionStatus !== "function") window.setSessionStatus = setSessionStatus; } catch {}
try { if (typeof window.mountSessionHUD !== "function") window.mountSessionHUD = mountSessionHUD; } catch {}
try { if (typeof window.updateSessionHUD !== "function") window.updateSessionHUD = updateSessionHUD; } catch {}
  const $ = (id) => bar.querySelector(`#${id} .num`);        // query inside the HUD we created
  const mm = Math.floor(elapsedSec / 60);
  const ss = Math.floor(elapsedSec % 60).toString().padStart(2,'0');

  const elShots = $('mShots');
  const elMakes = $('mMakes');
  const elAcc   = $('mAcc');
  const elTime  = $('mTime');

  // Prefer the maximum of: explicit param, canonical counter, pending list, legacy HUD
  try {
    const canonTaken = Math.max(
      Number(window.__SCORE_SHOT_COUNT || 0),
      Array.isArray(window.__shotList) ? window.__shotList.length : 0,
      Array.isArray(window.shotLog) ? window.shotLog.length : 0
    );
    const hudTaken = Number(window.shotTaken || window.__HUD_SHOT_COUNT || 0);
    const cur = Number(taken || 0);
    taken = Math.max(cur, canonTaken, hudTaken);
  } catch {}
  if (elShots) {
    const capDisplay = getSessionCap();
    elShots.textContent = `${taken}/${capDisplay}`;
  }
  // Makes/Accuracy hidden in simplified HUD; keep code paths no-op for future use
  if (elMakes) elMakes.textContent = `${made}`;
  if (elAcc)   elAcc.textContent   = `${Math.round(accuracy)}%`;
  if (elTime)  elTime.textContent  = `${mm}:${ss}`;
}

// -------- Global voice cue helpers ---------
try {
  if (!window.speakShotNumber) {
    window.speakShotNumber = function speakShotNumber(){
      try {
        const cap = getSessionCap();
        const cnt = Number(window.__HUD_SHOT_COUNT || window.shotTaken || 0);
        speak(`You are on shot ${Math.max(0,cnt)} of ${cap}.`);
      } catch {}
    };
  }
  window.addEventListener('hud:start-session', () => {
    try { window.__SESSION_ACTIVE = true; } catch {}
    try { if (window.__sessionEnded) { location.reload(); return; } } catch {}
    try { window.__summaryShown = false; window.__SESSION_REVIEW_SPOKEN = false; } catch {}
    try { resetSessionClockAndCount(); window.__sessionCapPrompted = false; } catch {}
    try { if (typeof window.PREF_VOICE_INTRO === 'undefined') window.PREF_VOICE_INTRO = false; } catch {}
    try { if (window.PREF_VOICE_INTRO === true) speak('Start session. Shoot when ready.'); } catch {}
    // If hoop is already locked, run 5s countdown and arm; otherwise wait for hoop:locked
    try {
      const h = window.getLockedHoopBox?.();
      if (window.__hoopConfirmed === true && h && !window.__armCountdownActive && window.__shotTrackingArmed !== true) {
        try { window.__shotTrackingArmed = false; } catch {}
        startShotTrackingCountdown?.(5);
      }
    } catch {}
  });
  window.addEventListener('hud:end-session', () => {
    try { window.__sessionCapPrompted = false; } catch {}
    try { speak('Session ended.'); } catch {}
    try { window.__SESSION_ACTIVE = false; } catch {}
  });
  window.addEventListener('hud:pause-session', () => { try { speak('Session paused.'); } catch {} });
  window.addEventListener('hud:continue-session', () => { try { speak('Continuing session.'); } catch {} });
  window.addEventListener('hud:what-shot', () => { try { window.speakShotNumber?.(); } catch {} });
} catch {}

// Debug helper: inspect HUD + list quickly from console
try {
  if (typeof window.printHUDState !== 'function') {
    window.printHUDState = function printHUDState(){
      try {
        const list = window.__shotList || [];
        const last = list.at?.(-1) || null;
        const el = document.querySelector('#sessionHUD #mShots .num');
        console.log('[HUD]', { shotsInList: list.length, last, mShotsText: el?.textContent || null });
        return { len: list.length, last, text: el?.textContent || null };
      } catch (e) { console.warn('printHUDState failed', e); return null; }
    };
  }
} catch {}

// end session shot summary table
function getShotList(){ return (window.__shotList ||= []); }

// Build & show the centered full-session modal
function renderFullShotTable() {
  ensureShotTableStyles();
  const list = getShotList();
  const root = ensureHudRoot();

  // Choose a best shot (highest local rating among makes) to highlight
  let __bestIdx = -1; let __bestScore = -1;
  try {
    const golden = window.DOACH_MEM?.get?.()?.golden || null;
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (!s || !s.made) continue;
      const r = (typeof window.computeShotRating === 'function')
        ? Number(window.computeShotRating(s.poseSnapshot || null, golden))
        : -1;
      if (Number.isFinite(r) && r > __bestScore) { __bestScore = r; __bestIdx = i; }
    }
  } catch {}

  let modal = document.getElementById('fullShotModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'fullShotModal';
    modal.className = 'hud-card';
    Object.assign(modal.style, {
      position: 'absolute',
      left: '50%',
      transform: 'translateX(-50%)',
      top: '12%',
      maxWidth: '74%',
      minWidth: '640px',
      zIndex: 10020,
      pointerEvents: 'auto',
      maxHeight: '78vh',
      overflowY: 'auto',
      WebkitOverflowScrolling: 'touch'
    });
    root.appendChild(modal);
  }

  modal.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
      <div style="font-weight:600; display:flex; align-items:center; gap:10px;">
        <span>ðŸ“‹ Shot Summary (${list.length}/${getSessionCap()})</span>
        <span id=\"sessFinalBadge\" style=\"display:none; padding:3px 8px; border-radius:10px; font:600 11px system-ui; background:#f59e0b; color:#111;\">Finalizingâ€¦</span>
      </div>
      <div>
        <button id="exportCSV" class="vc-btn" title="Export CSV">â¬‡ï¸Ž CSV</button>
        <button id="closeFull" class="vc-btn">âœ–</button>
      </div>
    </div>
    <div id=\"sessReviewLine\" style=\"display:none;opacity:.95;margin:4px 0 10px;line-height:1.35\"></div>
    <table class="hud-table">
      <colgroup>
        <col id="cNum"><col id="cRes"><col id="cArc"><col id="cEntry"><col id="cRel"><col><col id="cFix">
      </colgroup>
      <thead>
        <tr>
          <th>#</th><th>Result</th><th>Arc</th><th>EntryÂ°</th><th>ReleaseÂ°</th><th>Doach Summary</th><th>Correct</th>
        </tr>
      </thead>
      <tbody></tbody>
    </table>
  `;


  const esc = (s) => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const pickCoach = (s) => s.doach || s.coach || s.coachText || s.feedback || s.summary || s.text || '';

  const tb = modal.querySelector('tbody');
  list.forEach((s, i) => {
    const coach = pickCoach(s);
    const tr = document.createElement('tr');
    tr.setAttribute('data-shot-idx', i + 1);
    if (i === __bestIdx) tr.setAttribute('data-best', '1');
    tr.innerHTML = `
      <td class="num">${i+1}</td>
      <td class="result" title="${i===__bestIdx ? 'Best shot' : ''}">${s.made ? (i===__bestIdx ? 'â­ï¸ âœ…' : 'âœ…') : 'âŒ'}</td>
      <td class="arc">${Math.round(s.arcHeight ?? 0) || 'â€“'}</td>
      <td class="entry">${s.entryAngle ?? 'â€“'}</td>
      <td class="release">${s.releaseAngle ?? 'â€“'}</td>
      <td class="coach">${coach ? esc(coach) : 'â€”'}</td>
      <td class="fix">
        <div style="display:flex;gap:6px">
          <button class="vc-btn btn-make"  title="Mark Make" data-id="${i+1}">âœ…</button>
          <button class="vc-btn btn-miss"  title="Mark Miss" data-id="${i+1}">âŒ</button>
          <button class="vc-btn btn-ai"    title="AI Review" data-id="${i+1}">ðŸ¤–</button>
        </div>
      </td>`;

    // Inject a Replay button between Miss and AI Review
    try {
      const bar = tr.querySelector('td.fix > div');
      if (bar) {
        const aiBtn = bar.querySelector('.btn-ai');
        const replay = document.createElement('button');
        replay.className = 'vc-btn btn-replay';
        replay.title = 'Replay';
        replay.dataset.id = String(i + 1);
        replay.textContent = 'â–¶';
        if (aiBtn) bar.insertBefore(replay, aiBtn); else bar.appendChild(replay);
      }
    } catch {}

    try {
      if (s && s.pending === true) {
        const setTxt = (cls, val) => { try { const el = tr.querySelector('.' + cls); if (el) el.textContent = val; } catch {} };
        setTxt('result',  'pending');
        setTxt('arc',     'pending');
        setTxt('entry',   'pending');
        setTxt('release', 'pending');
        const coachEl = tr.querySelector('.coach');
        if (coachEl && (!coachEl.textContent || coachEl.textContent === 'Ã¢â‚¬â€')) coachEl.textContent = 'pending';
      }
    } catch {}
    tb.appendChild(tr);
  });

  modal.querySelector('#closeFull').onclick = () => modal.style.display = 'none';
  modal.querySelector('#exportCSV').onclick = () => exportSessionCSV(list);
  modal.style.display = 'block';
  try { modal.style.zIndex = '10060'; } catch {}
  return modal;
}

// Cap prompt removed; auto-end handles finish

// keep the data
function exportSessionCSV(list){
  const pickCoach = (s) => s.doach || s.coach || s.coachText || s.feedback || s.summary || s.text || '';
  const rows = [['#','result','arc','entry','release','doach_summary']];
  list.forEach((s,i)=> rows.push([
    i+1, s.made?'made':'miss',
    Math.round(s.arcHeight ?? 0),
    s.entryAngle ?? '',
    s.releaseAngle ?? '',
    `"${pickCoach(s).replace(/"/g,'""')}"`
  ]));
  const csv = rows.map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], {type:'text/csv'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'doach_session.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}


// --- Central sink for every finalized shot ---
function computeTotals(list){
  const taken = list.length;
  const made  = list.filter(s => s.made).length;
  const acc   = taken ? (made / taken) * 100 : 0;
  return { taken, made, acc };
}

// Record a shot summary and update the session HUD
window.recordShotSummary = async function recordShotSummary(summary) {
  // de-dupe
  const key = `${+summary.made}|${Math.round(summary.arcHeight||0)}|${summary.entryAngle}|${summary.releaseAngle}|${summary.frameExit||''}`;
  if (window.__lastShotKey === key) return;
  window.__lastShotKey = key;

  // carry most recent coaching line if present
  if (!summary.doach && window.__lastCoachText) summary.doach = window.__lastCoachText;

  const list = (window.__shotList ||= []);
  let idx;
  // If the last record is a pending release placeholder, finalize it
  const last = list.at?.(-1) || null;
  if (last && last.pending) {
    Object.assign(last, summary, { pending: false });
    idx = list.length;
    summary.__idx = idx;
  } else {
    idx  = list.push(summary);      // 1-based index
    summary.__idx = idx;            // keep the index on the object for later
  }
  summary.idx = Math.max(0, idx - 1);
  summary.coachIdx = summary.idx;

  // If the full table is open, update existing pending row or append now
  const modal = document.getElementById('fullShotModal');
  if (modal) {
    const esc = (s) => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const tb  = modal.querySelector('tbody');
    if (tb) {
      let tr = modal.querySelector(`tr[data-shot-idx="${idx}"]`);
      if (!tr) {
        tr = document.createElement('tr');
        tr.setAttribute('data-shot-idx', idx);
        tr.innerHTML = `
          <td class="num">${idx}</td>
          <td class="result"></td>
          <td class="arc"></td>
          <td class="entry"></td>
          <td class="release"></td>
          <td class="coach"></td>
          <td class="fix"><div style="display:flex;gap:6px"></div></td>`;
        tb.appendChild(tr);
        // Inject buttons (including Replay)
        try {
          const bar = tr.querySelector('td.fix > div');
          const mk = document.createElement('button'); mk.className='vc-btn btn-make'; mk.title='Mark Make'; mk.dataset.id=String(idx); mk.textContent='âœ…'; bar.appendChild(mk);
          const ms = document.createElement('button'); ms.className='vc-btn btn-miss'; ms.title='Mark Miss'; ms.dataset.id=String(idx); ms.textContent='âŒ'; bar.appendChild(ms);
          const rp = document.createElement('button'); rp.className='vc-btn btn-replay'; rp.title='Replay'; rp.dataset.id=String(idx); rp.textContent='â–¶'; bar.appendChild(rp);
          const ai = document.createElement('button'); ai.className='vc-btn btn-ai'; ai.title='AI Review'; ai.dataset.id=String(idx); ai.textContent='ðŸ¤–'; bar.appendChild(ai);
        } catch {}
      }
      // Update existing row cells
      try { const c = tr.querySelector('.coach'); if (c) { c.textContent = summary.doach ? esc(summary.doach) : 'â€”'; c.title = esc(summary.doach||''); } } catch {}
      try { const e = tr.querySelector('.result');  if (e) e.textContent = summary.made ? 'âœ…' : 'âŒ'; } catch {}
      try { const e = tr.querySelector('.arc');     if (e) e.textContent = (Math.round(summary.arcHeight ?? 0) || 'â€“'); } catch {}
      try { const e = tr.querySelector('.entry');   if (e) e.textContent = (summary.entryAngle ?? 'â€“'); } catch {}
      try { const e = tr.querySelector('.release'); if (e) e.textContent = (summary.releaseAngle ?? 'â€“'); } catch {}
    }
  }

  // HUD counters
  const { taken, made, acc } = computeTotals(list);
  const start = (window.__sessionStart ||= Date.now());
  const elapsedSec = Math.floor((Date.now() - start) / 1000);
  updateSessionHUD({ taken, made, accuracy: acc, elapsedSec });

  // Attach/update per-shot coach line immediately for the table (no extra speech)
  try {
    const last = list[idx - 1];
    const snap = last?.poseSnapshot
      || (typeof window.extractPoseSnapshot === 'function' && window.playerState?.keypoints
          ? window.extractPoseSnapshot(window.playerState.keypoints, window.getLockedHoopBox?.())
          : null);
    const sForCoach = { ...summary, poseSnapshot: snap };
    window.doachOnShot?.(sForCoach); // respect DOACH_ONLY_REALTIME inside doachOnShot
  } catch {}

  // End-of-session prompt at 10 shots; reuse central prompt logic
  if (taken === getSessionCap() && !window.__sessionContinue && !window.__sessionCapPrompted) {
    window.__sessionCapPrompted = true;
    try { window.dispatchEvent(new Event('doach:show-cap-prompt')); } catch {}
    try { window.autoEndSessionAndSummarize?.(); } catch {}
  }

  // Persist summary to backend even if no shot:summary event fired
  try {
    let sid = (window.__SESSION_ID || null);
    if (!sid) { try { sid = await ensureSessionId(); } catch {} }
    if (sid) {
      let idxPost = null;
      try { idxPost = Number.isFinite(window.__SHOT_IDX) ? Number(window.__SHOT_IDX) : (list.length - 1); } catch {}
      const payload = {
        idx: idxPost,
        t: Date.now(),
        made: (summary?.made ?? null),
        arcHeight: (summary?.arcHeight ?? null),
        entryAngle: (summary?.entryAngle ?? null),
        releaseAngle: (summary?.releaseAngle ?? null),
        missReason: (summary?.missReason ?? null)
      };
      fetch(`/api/sessions/${sid}/shot`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload), credentials:'include' }).catch(()=>{});
    }
  } catch {}
};

// Wire correction buttons for the full-session modal (id: fullShotModal)
function wireFullShotModalActions() {
  const modal = document.getElementById('fullShotModal');
  if (!modal || modal.__wiredCorrections) return;
  modal.__wiredCorrections = true;

  const tbody = modal.querySelector('tbody');
  if (!tbody) return;

  // Update one table rowâ€™s UI after a correction
  function refreshRowUI(idx) {
    const list = window.__shotList || [];
    const s = list[idx - 1];
    const tr = modal.querySelector(`tr[data-shot-idx="${idx}"]`);
    if (!s || !tr) return;

    tr.querySelector('.result').textContent = s.made ? 'âœ…' : 'âŒ';

    // Recompute accuracy badge and HUD numbers from current list
    const { taken, made, acc } = computeTotals(list);
    try {
      updateSessionHUD({ taken, made, accuracy: acc, elapsedSec: Math.floor((Date.now() - (window.__sessionStart||Date.now()))/1000) });
    } catch {}
  }

  // Delegated button handlers (Replay / Make / Miss / AI)
  tbody.addEventListener('click', async (e) => {
    const b  = e.target.closest('button'); if (!b) return;
    const id = Number(b.dataset.id || 0);  if (!id) return;

    try {
      if (b.classList.contains('btn-replay')) {
        try { window.playShotReplay?.({ id }); } catch {}
        return;
      }
      if (b.classList.contains('btn-make')) {
        await window.applyShotCorrection?.({ id, made: true,  reason: 'Table' });
      } else if (b.classList.contains('btn-miss')) {
        await window.applyShotCorrection?.({ id, made: false, reason: 'Table' });
      } else if (b.classList.contains('btn-ai')) {
        await window.reviewShotWithAI?.({ id }); // applies suggestion via applyShotCorrection
      }
    } finally {
      refreshRowUI(id);
    }
  });

  // Live refresh if corrections happen elsewhere (voice, banner, etc)
  window.addEventListener('shot:corrected', (ev) => {
    const id = Number(ev?.detail?.id || 0);
    if (!id || modal.style.display !== 'block') return;
    refreshRowUI(id);
  }, { passive: true });

  // Allow clean re-open wiring
  modal.querySelector('#closeFull')?.addEventListener('click', () => {
    modal.style.display = 'none';
    modal.__wiredCorrections = false;
  }, { once: true });
}





// display the shot status banner for the session
function ensureShotBanner() {
  const root = ensureHudRoot();
  let el = document.getElementById('shotBanner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'shotBanner';
    el.className = 'hud-card';
    Object.assign(el.style, {
      position:'absolute', right:'18px', bottom:'96px',
      padding:'10px 12px', display:'none', pointerEvents:'none'
    });
    root.appendChild(el);
  }
  return el;
}

export function showShotBanner(summary, ms = 2500) {
  const el = ensureShotBanner();
  const list = window.__shotList || [];
  const made = list.filter(s => s.made).length;
  const acc  = list.length ? Math.round((made / list.length) * 100) : 0;

  el.innerHTML = `
    <strong>${summary.made ? 'âœ… Made' : 'âŒ Missed'} Shot</strong><br>
    Arc Height: ${Math.round(summary.arcHeight || 0)}px<br>
    Entry Angle: ${summary.entryAngle ?? 'â€“'}Â°<br>
    Release Angle: ${summary.releaseAngle ?? 'â€“'}Â°<br>
    Accuracy: ${acc}% (${made}/${list.length})`;
  el.style.display = 'block';
  clearTimeout(el.__t);
  el.__t = setTimeout(() => { el.style.display = 'none'; }, ms);
}
window.showShotBanner = showShotBanner;  // keep global for shot_logger

window.addEventListener('shot:summary', (e) => {
  const summary = e?.detail || (window.shotLog?.at ? window.shotLog.at(-1) : null);
  if (!summary) return;
  try { window.recordShotSummary?.(summary); } catch {}
});



// Initialize HUD for video element
export function initHUDForVideo(videoEl) {
  window.__videoEl = videoEl;
  ensureHudRoot();
  // Cleanup any legacy tables that might still be in the DOM
  document.querySelectorAll('#shotTable, #shotTableHUD, #miniShotTray').forEach(el => el.remove());


  const anchor = document.querySelector('.session-container') || document.body;
  if (!window.__hudMo) {
    window.__hudMo = new MutationObserver(() => ensureHudRoot());
    window.__hudMo.observe(anchor, { childList: true, subtree: true });
  }

  videoEl?.addEventListener('loadeddata', () => {
    ensureHudRoot();
    try { mountConnectionBanner(); } catch {}
    startHoopPromptLoop();
    showCenterCountdownAndPrompt();
    setOverlayInteractive(true);
  });

  // if video was already loaded (fast cache), still start the loop
  if (videoEl?.readyState >= 2) {
    ensureHudRoot();
    try { mountConnectionBanner(); } catch {}
    startHoopPromptLoop();
    showCenterCountdownAndPrompt();
    setOverlayInteractive(true);
  }

  // keep HUD on top when playback state toggles
  videoEl?.addEventListener('play',  ensureHudRoot);
  videoEl?.addEventListener('pause', ensureHudRoot);
  try { mountConnectionBanner(); } catch {}
  // Always ensure the bottom HUD is present for both uploads and live camera
  try { mountSessionHUD(); } catch {}
  try { setSessionStatus('SESSION IN PROGRESSâ€¦'); } catch {}

  // Keep elapsed time ticking during session while HUD is mounted
  try {
    if (window.__hudTimeTimer) clearInterval(window.__hudTimeTimer);
    window.__hudTimeTimer = setInterval(() => {
      try {
        const start = window.__sessionStart;
        if (!start) return; // session not started yet
        const list = (window.__shotList || window.shotLog || []);
        const taken = Array.isArray(list) ? list.length : 0;
        const elapsedSec = Math.floor((Date.now() - start) / 1000);
        updateSessionHUD({ taken, elapsedSec });
      } catch {}
    }, 1000);
  } catch {}

  // Clear HUD time ticker when session ends
  try {
    window.addEventListener('hud:end-session', () => {
      try { if (window.__hudTimeTimer) { clearInterval(window.__hudTimeTimer); window.__hudTimeTimer = null; } } catch {}
      try { window.stopObserverStreaming?.(); } catch {}
    }, { once: false });
  } catch {}

  // Optional: capture live clips around release and upload per shot (overlay-only)
  // Enable via: window.CAPTURE_LIVE_CLIPS = true
  (function wireLiveClipCapture(){
    if (window.__liveClipWired) return; window.__liveClipWired = true;
    function startLiveClip(){
      try {
        if (!window.CAPTURE_LIVE_CLIPS) return;
        if (window.__liveRec?.rec) return;
        const ov = document.getElementById('overlay');
        if (!ov || !ov.captureStream) return;
        const stream = ov.captureStream(30);
        const chunks = [];
        let rec;
        try { rec = new MediaRecorder(stream, { mimeType: 'video/webm' }); } catch { return; }
        rec.ondataavailable = (e)=>{ try { if (e.data && e.data.size) chunks.push(e.data); } catch {} };
        rec.start();
        window.__liveRec = { rec, chunks, idxHint: Number(window.__SHOT_IDX || (window.__shotList||[]).length || 0) };
      } catch {}
    }
    async function stopAndUpload(){
      try {
        const pack = window.__liveRec; if (!pack || !pack.rec) return;
        const { rec, chunks, idxHint } = pack;
        await new Promise((resolve)=>{
          try {
            rec.onstop = async () => {
              try {
                const blob = new Blob(chunks, { type:'video/webm' });
                const sid = await ensureSessionId();
                if (sid && blob && blob.size) {
                  const fd = new FormData();
                  fd.append('file', blob, `shot_${idxHint}.webm`);
                  await fetch(`/api/sessions/${sid}/shot_video?index=${idxHint}`, { method:'POST', body: fd, credentials:'include' }).catch(()=>{});
                }
              } catch {}
              finally { try { window.__liveRec = null; } catch {} resolve(); }
            };
            rec.stop();
          } catch { try { window.__liveRec = null; } catch {} resolve(); }
        });
      } catch {}
    }
    window.addEventListener('shot:release', startLiveClip);
    window.addEventListener('hud:score-trip', startLiveClip);
    window.addEventListener('shot:summary', () => { stopAndUpload(); });
  })();

  // Auto end helper: stop camera, black out, force post pending shots, show summary
  async function autoEndSessionAndSummarize(){
    try { if (window.__summaryShown === true) return; } catch {}
    try { window.__sessionCapped = true; } catch {}
    try { window.__sessionEnded = true; } catch {}
    try { window.__SESSION_ACTIVE = false; } catch {}
    try { window.__shotTrackingArmed = false; } catch {}
    try { window.stopPoseReleaseSampler?.(); } catch {}
    try { window.stopCamera?.(); } catch {}
    try {
      // Black overlay (dim, but keep table readable)
      const root = ensureHudRoot();
      let blk = document.getElementById('endBlackout');
      if (!blk) {
        blk = document.createElement('div'); blk.id='endBlackout';
        Object.assign(blk.style,{position:'absolute',inset:'0',background:'#000',opacity:'0.65',zIndex:10040, pointerEvents:'none'});
        root.appendChild(blk);
      } else { blk.style.display='block'; blk.style.opacity='0.65'; blk.style.zIndex = '10040'; blk.style.pointerEvents='none'; }
    } catch {}

    // Ensure the shot list has placeholders so the table reflects session cap
    try {
      const cap = getSessionCap();
      console.log('[finalize] ensuring placeholders up to cap', { cap });
      const curLen = Array.isArray(window.__shotList) ? window.__shotList.length : 0;
      const scoreCnt = Number(window.__SCORE_SHOT_COUNT || 0);
      const logCnt = Array.isArray(window.shotLog) ? window.shotLog.length : 0;
      // If the session was capped, force placeholders up to cap; otherwise use the max observed count
      const target = (window.__sessionCapped === true) ? cap : Math.max(curLen, scoreCnt, logCnt);
      const list = (window.__shotList ||= []);
      for (let i = list.length; i < target; i++) list.push({ pending: true });
      try { if (window.SESS_FINAL_TRACE === true) console.log('[end:placeholders]', { curLen, scoreCnt, logCnt, target, cap, capped: !!window.__sessionCapped }); } catch {}
    } catch {}
    // Force-post any pending summaries as placeholders
    try {
      const list = (window.__shotList||[]);
      for (let i=0;i<list.length;i++) {
        const s = list[i] || {};
        await postShotUpsert(i, { made: (s.made ?? null), entryAngle: s.entryAngle ?? null, releaseAngle: s.releaseAngle ?? null, arcHeight: s.arcHeight ?? null });
      }
    } catch {}
    // End server session to update totals
    try { const sid = window.__SESSION_ID; if (sid) await fetch(`/api/sessions/${sid}/end`, { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}', credentials:'include' }).catch(()=>{}); } catch {}
    // Show summary table (ensure above blackout)
    try {
      const modal = renderFullShotTable();
      try { if (modal && modal.style) modal.style.zIndex = '10060'; } catch {}
      wireFullShotModalActions();
      // Populate per-shot Doach Summary lines immediately from pose snapshots
      try {
        const list = window.__shotList || [];
        const golden = window.DOACH_MEM?.get?.()?.golden || null;
        for (let i = 0; i < list.length; i++) {
          const s = list[i]; if (!s) continue;
          if (!s.doach) {
            const issues = (typeof window.summarizePoseIssues === 'function')
              ? (window.summarizePoseIssues(s, golden) || [])
              : [];
            const line = issues.length ? issues.slice(0,2).join(' ') : 'Solid form. Hold your followâ€‘through.';
            s.doach = line;
            try {
              const cell = modal.querySelector(`tbody tr[data-shot-idx="${i+1}"] td.coach`) || null;
              if (cell) { cell.textContent = line; cell.title = line; }
            } catch {}
          }
        }
      } catch {}
      // Hydrate AI feedback from server and poll briefly for late arrivals
      try {
        let status = await hydrateAiFeedbackFromServer();
        let polls = 0;
        const iv = setInterval(async () => {
          try {
            status = await hydrateAiFeedbackFromServer();
            if (status && status.done) { clearInterval(iv); }
          } catch {}
          if (++polls >= 50 || window.__sessionContinue) { clearInterval(iv); }
        }, 1200);
      } catch {}
      // Background reconcile: if DB is missing rows, force-upsert from local list after a short delay
      try {
        setTimeout(async () => {
          try {
            const sid = (window.__SESSION_ID || null);
            if (!sid) return;
            const list = (window.__shotList || []);
            const dbg = await fetch(`/admin/session/${sid}/debug`, { credentials:'include' }).then(r=>r.ok?r.json():null).catch(()=>null);
            const have = new Set(Array.isArray(dbg?.shotsDB) ? dbg.shotsDB.map(r=>Number(r.idx)).filter(Number.isFinite) : []);
            try { if (window.SESS_FINAL_TRACE === true) console.log('[finalize:reconcile]', { have: Array.from(have).sort((a,b)=>a-b), need: list.length }); } catch {}
            for (let i = 0; i < list.length; i++) {
              if (!have.has(i)) {
                const s = list[i] || {};
                const patch = { made: (typeof s.made==='boolean'?s.made:null), arcHeight: s.arcHeight ?? null, entryAngle: s.entryAngle ?? null, releaseAngle: s.releaseAngle ?? null };
                await postShotUpsert(i, patch, { force: true });
              }
            }
          } catch {}
        }, 1500);
      } catch {}
      try { window.__summaryShown = true; } catch {}
    } catch {}
    // Announce + trigger coach session summary
    try { window.coachSpeak?.("That's your tenth shot â€” let's review the session."); } catch {}
    try { window.dispatchEvent(new CustomEvent('hud:end-session')); } catch {}
    try { window.__summaryShown = true; } catch {}
  }

  // Expose end-session routine globally for guards and other modules
  try { if (typeof window.autoEndSessionAndSummarize !== 'function') window.autoEndSessionAndSummarize = autoEndSessionAndSummarize; } catch {}

  // confirm hoop locker fires
window.addEventListener('hoop:locked', () => {
  window.__hoopConfirmed = true;      // <-- user has confirmed
  try { window.__SESSION_ACTIVE = true; } catch {}
  hidePromptMessage();
  clearInterval(window.__hoopPromptTimer);
  try { const v = document.getElementById('videoPlayer') || document.querySelector('video'); if (v) v.playbackRate = 1; } catch {}
  // Only start countdown if not already armed and no countdown is active
  try {
    if (window.__shotTrackingArmed === true) return;
    if (window.__armCountdownActive) return;
    // Reset armed and announce countdown
    window.__shotTrackingArmed = false;
    try { window.dispatchEvent(new CustomEvent('hud:arm-countdown', { detail: { sec: 5 } })); } catch {}
    try { if (typeof window.PREF_VOICE_INTRO === 'undefined') window.PREF_VOICE_INTRO = false; } catch {}
    try { if (window.PREF_VOICE_INTRO === true) speak(`Let's get started, select hoop, get into position, and shoot when ready.`); } catch {}
    startShotTrackingCountdown?.(5);
  } catch {}
});
}

// ---- Server AI feedback + metrics hydrator ----
// Returns status { present, haveMade, need, done }
async function hydrateAiFeedbackFromServer() {
  // Helper: merge from local memory only (no server)
  function hydrateFromLocalOnly() {
    try {
      const modal = document.getElementById('fullShotModal');
      const badge = modal?.querySelector('#sessFinalBadge') || null;
      // Inform the user in the review line
      try {
        const line = modal?.querySelector('#sessReviewLine') || null;
        if (line) { line.style.display = 'block'; line.textContent = 'Server offline â€” showing local summaries only.'; }
      } catch {}
      const list = (window.__shotList || window.shotLog || []);
      const need = Math.min(list.length, getSessionCap());
      let present = 0, haveMade = 0;
      for (let i = 0; i < list.length && i < need; i++) {
        const idx = i + 1;
        const s = list[i] || {};
        if (s && typeof s === 'object') {
          present++;
          if (typeof s.made === 'boolean') haveMade++;
          updateShotCells(idx, s);
          if (s.doach) updateCoachCell(idx, String(s.doach));
        }
      }
      if (badge) {
        badge.style.display = 'inline-block';
        const done = present >= (need || list.length || 0);
        if (done) {
          badge.textContent = 'Finalized';
          badge.style.background = '#22c55e';
          badge.style.color = '#071607';
        } else {
          badge.textContent = `Server offlineâ€¦ ${present}/${need || list.length || 0}`;
          badge.style.background = '#ef4444';
          badge.style.color = '#0b0b0b';
        }
      }
      const status = { present, haveMade, need, done: present >= (need || list.length || 0) };
      try { if (window.SESS_FINAL_TRACE === true) console.warn('[finalize:offline]', status); } catch {}
      return status;
    } catch {
      return { present:0, haveMade:0, need:0, done:false };
    }
  }

  try {
    // Ensure we have (or try to create) a session id
    let sid = window.__SESSION_ID || null;
    if (!sid) {
      try { sid = await ensureSessionId(); } catch {}
    }
    if (!sid) {
      // No server available to mint a session; hydrate from local memory only
      return hydrateFromLocalOnly();
    }

    const list = (window.__shotList ||= []);
    // Use admin joined view which includes ai_feedback rows and shotsDB metrics
    let j = null;
    try {
      const r = await fetch(`/admin/session/${sid}/debug`, { credentials:'include' });
      if (!r || !r.ok) {
        try { if (window.SESS_FINAL_TRACE === true) console.warn('[finalize] debug fetch not ok', r && r.status); } catch {}
        return hydrateFromLocalOnly();
      }
      j = await r.json();
    } catch (e) {
      // Network error (backend down); fill from local
      try { if (window.SESS_FINAL_TRACE === true) console.warn('[finalize] debug fetch error', e); } catch {}
      return hydrateFromLocalOnly();
    }

    try {
      if (window.UI_TRACE_HYDRATE === true || window.SESS_FINAL_TRACE === true) {
        const sdbN = Array.isArray(j?.shotsDB) ? j.shotsDB.length : 0;
        const sjN  = (j?.sessionFile && Array.isArray(j.sessionFile.shots)) ? j.sessionFile.shots.length : 0;
        console.log('[hydrate:debug]', { sid, sdbN, sjN, fbN: Array.isArray(j?.feedback)? j.feedback.length : 0 });
      }
    } catch {}

    // 1) Update finalization badge based on shotsDB rows
    const status = updateFinalizationBadgeFromDebug(j);

    // 2) Merge server shot metrics (made, arc, entry, release) into UI rows
    try {
      const sdb = Array.isArray(j?.shotsDB) ? j.shotsDB : [];
      const sjson = (j?.sessionFile && Array.isArray(j.sessionFile.shots)) ? j.sessionFile.shots : [];
      // Union by idx: start with session.json (filesystem), overlay DB (authoritative)
      const byIdx = new Map();
      for (const src of [sjson, sdb]) {
        for (const row of src) {
          const i0 = Number(row?.idx);
          if (!Number.isFinite(i0)) continue;
          const cur = byIdx.get(i0) || {};
          const merged = {
            idx: i0,
            made: (typeof row.made === 'boolean') ? row.made : (typeof cur.made === 'boolean' ? cur.made : null),
            arcHeight: (row.arcHeight != null) ? row.arcHeight : (cur.arcHeight != null ? cur.arcHeight : null),
            entryAngle: (row.entryAngle != null) ? row.entryAngle : (cur.entryAngle != null ? cur.entryAngle : null),
            releaseAngle: (row.releaseAngle != null) ? row.releaseAngle : (cur.releaseAngle != null ? cur.releaseAngle : null)
          };
          byIdx.set(i0, merged);
        }
      }
      const mergedIdxs = [];
      for (const [i0, row] of byIdx) {
        const idx = Math.min(list.length, Math.max(1, i0 + 1)); // DB is 0-based; UI is 1-based
        const shot = list[idx-1] || (list[idx-1] = {});
        if (typeof row.made === 'boolean') shot.made = row.made;
        if (row.arcHeight != null) shot.arcHeight = row.arcHeight;
        if (row.entryAngle != null) shot.entryAngle = row.entryAngle;
        if (row.releaseAngle != null) shot.releaseAngle = row.releaseAngle;
        updateShotCells(idx, shot);
        mergedIdxs.push(idx);
      }
      try { if (window.UI_TRACE_HYDRATE === true) console.log('[hydrate:merge]', { mergedIdxs: mergedIdxs.sort((a,b)=>a-b) }); } catch {}
    } catch {}

    // 3) Merge AI feedback text (if present). Do this last so text is fresh.
    try {
      const fbs = Array.isArray(j?.feedback) ? j.feedback.slice() : [];
      if (fbs.length) {
        try { fbs.sort((a,b)=> (new Date(a.created_at||0)) - (new Date(b.created_at||0))); } catch {}
        // Accept either 0-based or 1-based shot_idx. If indexes look unreliable
        // (e.g., all 0), fall back to sequential mapping by arrival order.
        const nums = fbs.map(x => Number(x.shot_idx)).filter(n => Number.isFinite(n));
        const uniq = new Set(nums);
        const idxLookReliable = (nums.length === fbs.length) && uniq.size > Math.max(1, Math.floor(fbs.length/3));
        if (idxLookReliable) {
          for (const fb of fbs) {
            const n = Number(fb.shot_idx);
            const idx = Math.min(list.length, Math.max(1, (n >= 1 ? n : (n + 1))));
            const text = String(fb.text||'').trim();
            if (text) { list[idx-1].doach = text; updateCoachCell(idx, text); }
          }
          try { if (window.UI_TRACE_HYDRATE === true) console.log('[hydrate:fb]', { mode:'index', count:fbs.length }); } catch {}
        } else {
          // Sequential mapping: spread feedback across rows 1..N
          for (let i = 0; i < list.length && i < fbs.length; i++) {
            const text = String(fbs[i].text||'').trim();
            if (text) { list[i].doach = text; updateCoachCell(i+1, text); }
          }
          try { if (window.UI_TRACE_HYDRATE === true) console.log('[hydrate:fb]', { mode:'sequential', count:fbs.length }); } catch {}
        }
      }
    } catch {}

    // Optional debug trace
    try { if (window.SESS_FINAL_TRACE === true) console.log('[finalize]', status); } catch {}
    return status;
  } catch {
    return { present:0, haveMade:0, need:0, done:false };
  }
}

function updateCoachCell(idx, text) {
  try {
    const modal = document.getElementById('fullShotModal');
    if (!modal) return;
    const cell = modal.querySelector(`tbody tr[data-shot-idx="${idx}"] td.coach`);
    if (cell) { cell.textContent = text; cell.title = text; }
  } catch {}
}

function updateShotCells(idx, shot) {
  try {
    const modal = document.getElementById('fullShotModal');
    if (!modal) return;
    const tr = modal.querySelector(`tbody tr[data-shot-idx="${idx}"]`);
    if (!tr) return;
    const set = (sel, val) => { const el = tr.querySelector(sel); if (el) el.textContent = val; };
    // Result
    if (typeof shot.made === 'boolean') set('.result', shot.made ? 'âœ…' : 'âŒ');
    // Arc / Entry / Release
    if (shot.arcHeight != null) set('.arc', `${Math.round(shot.arcHeight)||0}`);
    if (shot.entryAngle != null) set('.entry', `${shot.entryAngle}`);
    if (shot.releaseAngle != null) set('.release', `${shot.releaseAngle}`);
  } catch {}
}

function updateFinalizationBadgeFromDebug(j) {
  try {
    const modal = document.getElementById('fullShotModal');
    if (!modal) return { present:0, haveMade:0, need:0, done:false };
    const badge = modal.querySelector('#sessFinalBadge');
    if (!badge) return { present:0, haveMade:0, need:0, done:false };
    const list = window.__shotList || [];
    const need = Math.min(list.length, getSessionCap());
    const sdb = Array.isArray(j?.shotsDB) ? j.shotsDB : [];
    const sj  = (j?.sessionFile && Array.isArray(j.sessionFile.shots)) ? j.sessionFile.shots : [];
    const presentIdx = new Set();
    const madeIdx = new Set();
    // Count union of DB and session.json so late DB rows don't hide file rows
    for (const row of sdb) {
      const i0 = Number(row.idx);
      if (!Number.isFinite(i0)) continue;
      if (i0 >= 0 && i0 < need) presentIdx.add(i0);
      if (row.made === true || row.made === false) madeIdx.add(i0);
    }
    for (const row of sj) {
      const i0 = Number(row.idx);
      if (!Number.isFinite(i0)) continue;
      if (i0 >= 0 && i0 < need) presentIdx.add(i0);
      if (row.made === true || row.made === false) madeIdx.add(i0);
    }
    const present = presentIdx.size;
    const haveMade = madeIdx.size;
    if (!need) return { present:0, haveMade:0, need:0, done:false };
    badge.style.display = 'inline-block';
    // Flip to green as soon as all rows are present (do not wait for DB 'made')
    const done = present >= need;
    if (done) {
      badge.textContent = 'Finalized';
      badge.style.background = '#22c55e';
      badge.style.color = '#071607';
    } else {
      badge.textContent = `Finalizingâ€¦ ${present}/${need}`;
      badge.style.background = '#f59e0b';
      badge.style.color = '#111';
    }
    return { present, haveMade, need, done };
  } catch { return { present:0, haveMade:0, need:0, done:false }; }
}

window.ensureHudRoot = ensureHudRoot;

// clean up the summary table UI
function ensureShotTableStyles(){
  if (document.getElementById('shotTableStyles')) return;
  const css = document.createElement('style');
  css.id = 'shotTableStyles';
  css.textContent = `
    #fullShotModal .hud-table{ width:100%; border-collapse:collapse; table-layout:fixed; }
    #fullShotModal .hud-table col#cNum   { width:42px; }
    #fullShotModal .hud-table col#cRes   { width:60px; }
    #fullShotModal .hud-table col#cArc   { width:64px; }
    #fullShotModal .hud-table col#cEntry { width:72px; }
    #fullShotModal .hud-table col#cRel   { width:72px; }
    #fullShotModal .hud-table thead th{ position: sticky; top: 0; background: rgba(0,0,0,0.85); z-index: 2; backdrop-filter: blur(2px); }
    #fullShotModal .hud-table th,
    #fullShotModal .hud-table td{ padding:8px 10px; vertical-align:top; text-align:left;
      border-bottom:1px solid rgba(255,255,255,.12); }
    #fullShotModal .hud-table tbody tr:nth-child(even) td{ background:rgba(255,255,255,.03); }
    #fullShotModal td.num, #fullShotModal td.arc, #fullShotModal td.entry, #fullShotModal td.release { text-align:center; }
    #fullShotModal td.result{ text-align:center; }
    #fullShotModal td.coach{ white-space:normal; word-break:break-word; line-height:1.25; }
    #fullShotModal tbody tr[data-best="1"] td { background: rgba(255,215,0,0.10) !important; }
    #fullShotModal tbody tr[data-best="1"] td.result { font-weight: 800; }
  `;

  // Insert a "Replay Best" button if we found a best shot
  try {
    if (__bestIdx >= 0) {
      const actions = modal.querySelector('div > div:last-child');
      if (actions) {
        const btn = document.createElement('button');
        btn.id = 'replayBest';
        btn.className = 'vc-btn';
        btn.title = 'Replay Best Shot';
        btn.textContent = 'Best â–¶';
        btn.addEventListener('click', () => { try { window.playShotReplay?.({ id: (__bestIdx + 1) }); } catch {} });
        actions.insertBefore(btn, actions.querySelector('#exportCSV'));
      }
    }
  } catch {}

  // Post best-shot mark to backend once per session (optional; ignored if server doesn't use it)
  try {
    const sid = window.__SESSION_ID || null;
    if (sid && __bestIdx >= 0) {
      const key = `${sid}|best|${__bestIdx}`;
      window.__bestShotMarkSent ||= new Set();
      if (!window.__bestShotMarkSent.has(key)) {
        window.__bestShotMarkSent.add(key);
        fetch(`/api/sessions/${sid}/shot`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idx: __bestIdx, best: true, t: Date.now() }),
          credentials: 'include'
        }).catch(()=>{});
      }
    }
  } catch {}
  document.head.appendChild(css);
}

// --- Lightweight overlay replay of a shot trail (no video seek required) ---
function makeReplayCanvasSize() {
  const ov = document.getElementById('overlay');
  const v  = document.getElementById('videoPlayer') || document.querySelector('video');
  const w = ov?.width || v?.videoWidth || 640;
  const h = ov?.height || v?.videoHeight || 360;
  return { w: Math.max(320, w), h: Math.max(180, h) };
}

function drawHoopSimple(ctx) {
  try {
    const hoop = (typeof window.getLockedHoopBox === 'function') ? window.getLockedHoopBox() : null;
    if (!hoop) return;
    const cx = Number.isFinite(hoop.cx) ? hoop.cx : (hoop.x + (hoop.w||0)/2);
    const cy = Number.isFinite(hoop.cy) ? hoop.cy : (hoop.y + (hoop.h||0)/2);
    const r  = Math.max(28, Math.min(72, (hoop.w||hoop.width||60)/2));
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI*2);
    ctx.strokeStyle = 'rgba(255,165,0,0.9)'; ctx.lineWidth = 3; ctx.stroke();
    ctx.restore();
  } catch {}
}

function openShotReplay(shot) {
  const root = ensureHudRoot();
  let box = document.getElementById('shotReplayModal');
  if (!box) {
    box = document.createElement('div');
    box.id = 'shotReplayModal';
    Object.assign(box.style, {
      position:'absolute', left:'50%', top:'12%', transform:'translateX(-50%)', zIndex:10040,
      background:'rgba(0,0,0,0.88)', color:'#fff', border:'1px solid rgba(255,255,255,0.18)', borderRadius:'14px',
      boxShadow:'0 20px 50px rgba(0,0,0,0.45)', padding:'10px 10px', pointerEvents:'auto'
    });
    root.appendChild(box);
  }
  const { w, h } = makeReplayCanvasSize();
  const cw = Math.min(w, Math.round(window.innerWidth * 0.9));
  const ch = Math.round(cw * (h / w));

  box.innerHTML = '';
  const header = document.createElement('div');
  header.style.display = 'flex'; header.style.alignItems = 'center'; header.style.justifyContent='space-between'; header.style.margin='4px 6px 6px';
  header.innerHTML = `<div style="font-weight:700">Replay â€” Shot ${shot.__idx || '?'} ${shot.made ? 'âœ…' : 'âŒ'}</div>
    <div>
      <button id="replayToggle" class="vc-btn" style="margin-right:6px">â¯</button>
      <button id="replayClose" class="vc-btn">âœ–</button>
    </div>`;
  box.appendChild(header);

  const info = document.createElement('div');
  info.style.font = '600 12px system-ui'; info.style.opacity = '0.85'; info.style.margin = '0 8px 6px';
  info.textContent = `Arc ${Math.round(shot.arcHeight||0)}px Â· Entry ${shot.entryAngle??'â€“'}Â° Â· Release ${shot.releaseAngle??'â€“'}Â°`;
  box.appendChild(info);

  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h; canvas.style.width = `${cw}px`; canvas.style.height = `${ch}px`;
  canvas.style.display='block'; canvas.style.background='rgba(0,0,0,0.6)'; canvas.style.borderRadius='10px';
  box.appendChild(canvas);

  const ctx = canvas.getContext('2d');
  const trail = Array.isArray(shot.trail) ? shot.trail.slice() : [];
  let i = 0; let raf = 0; let playing = true;
  function drawFrame() {
    try {
      ctx.clearRect(0,0,canvas.width,canvas.height);
      // hoop
      drawHoopSimple(ctx);
      // path
      if (trail.length >= 2) {
        ctx.save();
        ctx.lineWidth = 3; ctx.strokeStyle = 'lime'; ctx.beginPath();
        const upto = Math.max(1, Math.min(i, trail.length-1));
        for (let k=0; k<=upto; k++) {
          const p = trail[k]; if (!p) continue;
          if (k===0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
        }
        ctx.stroke();
        // head dot
        const P = trail[upto];
        if (P) { ctx.beginPath(); ctx.arc(P.x, P.y, 6, 0, Math.PI*2); ctx.fillStyle = '#22c55e'; ctx.fill(); }
        ctx.restore();
      } else {
        ctx.save();
        ctx.fillStyle='rgba(255,255,255,0.85)'; ctx.font='600 14px system-ui';
        ctx.fillText('No trail available for this shot.', 16, 26);
        ctx.restore();
      }
    } catch {}
  }
  function step() {
    drawFrame();
    if (playing && trail.length) {
      i = Math.min(trail.length, i + 2);
      if (i < trail.length) raf = requestAnimationFrame(step);
    }
  }
  // wire controls
  const close = () => { try { cancelAnimationFrame(raf); } catch {} try { box.remove(); } catch {} };
  box.querySelector('#replayClose')?.addEventListener('click', close, { once:true });
  box.querySelector('#replayToggle')?.addEventListener('click', () => {
    playing = !playing;
    if (playing) { if (i >= trail.length) i = 0; raf = requestAnimationFrame(step); }
  });

  // start
  i = 0; playing = true; cancelAnimationFrame(raf); raf = requestAnimationFrame(step);
}

if (!window.playShotReplay) {
  window.playShotReplay = function playShotReplay({ id } = {}){
    try {
      const list = window.__shotList || [];
      const shot = list[id - 1];
      if (!shot) return;
      openShotReplay(shot);
    } catch {}
  };
}

// ---- Center prompt + countdown (on load/connect) ----
function showCenterPrompt(msg) {
  let el = document.getElementById('overlayPrompt'); if (el) { try { el.dataset.center = '1'; } catch {} }
  if (!el) { el = document.createElement('div'); el.id = 'overlayPrompt'; el.dataset.center = '1';
    Object.assign(el.style, {
      position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)',
      background: 'rgba(0,0,0,0.72)', color: '#fff', padding: '20px 28px',
      borderRadius: '12px', font: '700 32px/1.15 system-ui, -apple-system, Segoe UI, Arial', zIndex: 10020,
      textShadow: '0 2px 8px rgba(0,0,0,0.45)',
      pointerEvents: 'none', display: 'none'
    });
    ensureHudRoot().appendChild(el);
  }
  el.textContent = msg;
  el.style.display = 'block';
  return el;
}

function hideCenterPrompt() {
  const el = document.getElementById('overlayPrompt');
  if (el) el.style.display = 'none';
}

async function showCenterCountdownAndPrompt(sec = 5) {
  try {
    const v = document.getElementById('videoPlayer'); if (!v) return;
    // Do not disrupt background diagnostic mode
    if (window.__BG_ONLY) return;
    // One-time per source change
    if (v.__countdownShown) return; v.__countdownShown = true;

    // Optional once-per-device name preference (Dave vs David)
    let name = (localStorage.getItem('firstname') || 'player');
    if (!localStorage.getItem('firstname_confirmed')) {
      await new Promise((resolve) => {
        const root = ensureHudRoot();
        const box = document.createElement('div');
        box.id = 'namePrefOverlay';
        Object.assign(box.style, {
          position:'absolute', left:'50%', top:'50%', transform:'translate(-50%,-50%)',
          background:'rgba(0,0,0,0.78)', color:'#fff', padding:'18px 20px', borderRadius:'12px',
          font:'600 18px system-ui, -apple-system, Segoe UI, Arial', zIndex:10030, pointerEvents:'auto', textAlign:'center'
        });
        box.innerHTML = `
          <div style="font-size:20px; font-weight:700; margin-bottom:10px;">What should I call you?</div>
          <div style="display:flex; gap:12px; justify-content:center;">
            <button id="npDave"   style="font-weight:700; font-size:18px; padding:10px 14px; border-radius:10px; border:none; cursor:pointer;">Dave</button>
            <button id="npDavid"  style="font-weight:700; font-size:18px; padding:10px 14px; border-radius:10px; border:none; cursor:pointer;">David</button>
            <button id="npSkip"   style="font-weight:600; font-size:16px; padding:10px 14px; border-radius:10px; border:none; cursor:pointer; background:#333; color:#fff;">Skip</button>
          </div>`;
        root.appendChild(box);
        const pick = (v) => { try { localStorage.setItem('firstname', v); localStorage.setItem('firstname_confirmed','1'); name = v; } catch{}; try { box.remove(); } catch{}; resolve(); };
        box.querySelector('#npDave') .addEventListener('click', ()=> pick('Dave'));
        box.querySelector('#npDavid').addEventListener('click', ()=> pick('David'));
        box.querySelector('#npSkip') .addEventListener('click', ()=> pick(name));
      });
    }
    name = (localStorage.getItem('firstname') || name || 'player');
    const promptEl = showCenterPrompt('Get readyâ€¦');
    try { speak(`Hi ${name}, tap the hoop to begin the session.`); } catch {}
    for (let i = sec; i >= 1; i--) {
      promptEl.textContent = String(i);
      await new Promise(r => setTimeout(r, 1000));
    }
    promptEl.textContent = 'Tap the hoop to start session';
    setTimeout(hideCenterPrompt, 2200);
    try { window.enableHoopPickOnce?.(); } catch {}
  } catch {}
}

// After hoop lock: 5s countdown to arm shot tracking
function startShotTrackingCountdown(sec = 5) {
  try {
    // Avoid double countdowns
    if (window.__armCountdownActive) return; window.__armCountdownActive = true;
    // Block releases while counting down
    try { window.__shotTrackingArmed = false; } catch {}
    try { window.dispatchEvent(new CustomEvent('hud:arm-countdown', { detail: { sec } })); } catch {}

    // Build large centered number overlay
    const root = ensureHudRoot();
    let box = document.getElementById('countdownOverlay');
    if (!box) {
      box = document.createElement('div');
      box.id = 'countdownOverlay';
      Object.assign(box.style, {
        position:'absolute', left:'50%', top:'50%', transform:'translate(-50%,-50%)',
        background:'rgba(0,0,0,0.45)', color:'#fff', padding:'24px 32px', borderRadius:'16px',
        font:'900 120px/1 system-ui, -apple-system, Segoe UI, Arial',
        textShadow: '0 6px 18px rgba(0,0,0,.55)', zIndex:10040,
        pointerEvents:'none', display:'none'
      });
      root.appendChild(box);
    }
    const showNum = (t) => { box.style.display = 'block'; box.textContent = String(t); };
    const showGo  = () => { box.style.display = 'block'; box.textContent = 'GO'; };
    const hide    = () => { box.style.display = 'none'; };

    (async () => {
      try {
        for (let i = sec; i >= 1; i--) {
          showNum(i);
          await new Promise(r => setTimeout(r, 1000));
        }
        showGo();
        setTimeout(hide, 700);
        // Arm and announce
        window.__shotTrackingArmed = true;
        try { window.dispatchEvent(new CustomEvent('hud:armed')); } catch {}
        try { speak('Shoot when ready.'); } catch {}
        try { window.__releaseEventSent = false; } catch {}
      } finally {
        window.__armCountdownActive = false;
      }
    })();
  } catch {}
}
try { if (typeof window.startShotTrackingCountdown !== 'function') window.startShotTrackingCountdown = startShotTrackingCountdown; } catch {}

(function installSlowFailsafe(){
  const v = document.querySelector('#videoPlayer') || document.querySelector('video');
  if (!v) return;

  let lastRateSetAt = 0;

  function setRate(r){
    if (v.playbackRate !== r) {
      v.playbackRate = r;
      lastRateSetAt = performance.now();
    }
  }

  // Baseline: never start in slow-mo
  v.addEventListener('loadedmetadata', () => { setRate(1); }, { once:true });
  v.addEventListener('ended',          () => { setRate(1); });

  // Optional hooks, if your code toggles slow-mo deliberately:
  window.addEventListener('video:Slow:on',  () => setRate(0.25));
  window.addEventListener('video:Slow:off', () => setRate(1));

  // Hard guard: donâ€™t allow slow-mo to linger
  (function tick(){
    // if rate < 0.9 longer than configured slow-mo, bail out to 1Ã—
    const maxMs = Math.max(2000, (Number(window.Slow_MS) || 1200) + 600);
    if (v.playbackRate < 0.9 && performance.now() - lastRateSetAt > maxMs) {
      setRate(1);
    }
    requestAnimationFrame(tick);
  })();
})();


// Hard exit to 1Ã— as soon as summary is received
window.addEventListener('shot:summary', () => {
  const v = document.getElementById('videoPlayer') || document.querySelector('video');
  if (v) { try { v.playbackRate = 1; } catch {} }
});


// --- Global HUD wiring for shot counters (independent of slow-mo arbiter) ---
(function wireHudShotCounters(){
  if (window.__HudShotCountersWired) return; window.__HudShotCountersWired = true;

  const onRelease = (e) => {
    try {
      // Require hoop locked/confirmed and armed (post-countdown)
      if (window.__hoopConfirmed !== true) return;
      if (!window.getLockedHoopBox?.()) return;
      if (window.__shotTrackingArmed !== true) return;

      // UI cooldown to avoid duplicate counts from multiple emitters
      const unlockMs = Number(window.NEXT_SHOT_UNLOCK_MS ?? 2000);
      const now = performance.now();
      const lastUiMs = Number(window.__UI_LAST_RELEASE_MS || 0);
      if (now - lastUiMs < unlockMs) return;

      // Trust upstream latch; UI enforces only armed + hoop + cooldown

          const list = (window.__shotList ||= []);
          const rf = Number(e?.detail?.frame || 0);
      const last = list.at?.(-1) || null;
      const same = last && Number.isFinite(last.frameRelease) && last.frameRelease === rf;
      if (!same) {
        const snap = (typeof window.extractPoseSnapshot === 'function' && window.playerState?.keypoints)
          ? window.extractPoseSnapshot(window.playerState.keypoints, window.getLockedHoopBox?.())
          : null;
        list.push({ pending: true, frameRelease: rf, tMs: Date.now(), poseSnapshot: snap });
        // If snapshot was not yet ready at the exact release tick, grab one immediately
        try {
          queueMicrotask(async () => {
            try {
              const lastRow = list.at?.(-1) || null;
              if (lastRow && !lastRow.poseSnapshot && typeof window.__samplePoseSnapshotNow === 'function') {
                const s2 = await window.__samplePoseSnapshotNow();
                if (s2) lastRow.poseSnapshot = s2;
              }
            } catch {}
          });
        } catch {}
        try { window.__SHOT_IDX = (list.length - 1); } catch {}
        // also upsert a placeholder shot row to backend so admin shows attempts
        try { postShotUpsert((list.length - 1), { made: null }); } catch {}
      }
      window.__UI_LAST_RELEASE_MS = now;
      const taken = list.length;
      const start = (window.__sessionStart ||= Date.now());
      const elapsedSec = Math.floor((Date.now() - start) / 1000);
      window.mountSessionHUD?.();
      window.updateSessionHUD?.({ taken, elapsedSec });
      window.setSessionStatus?.('Shot ' + taken + ' in progress');
    } catch {}
  };
  window.addEventListener('shot:release', onRelease);

  // Also increment HUD on gate score trips (from overlay/app sampler),
  // so Shots Taken reflects pose releases even if a release event was swallowed.
  // This is visual/log-only; summaries still come from the scorer.
  window.addEventListener('hud:score-trip', (e) => {
    try {
      // Cap session at cap_DEFAULT
      try { const cap = getSessionCap(); const cur = (window.__shotList||[]).length; if (shouldEnforceSessionCap() && cur >= cap) return; } catch {}
      const list = (window.__shotList ||= []);
      // Prefer frame from event; fallback to latest sampler index or RELEASE_SCORE
      let rf = Number(e?.detail?.frame);
      if (!Number.isFinite(rf)) rf = Number(window.__AN_IDX);
      if (!Number.isFinite(rf)) rf = Number(window.RELEASE_SCORE?.frame);
      if (!Number.isFinite(rf)) rf = 0;

      const last = list.at?.(-1) || null;
      const same = last && Number.isFinite(last.frameRelease) && last.frameRelease === rf;
      if (same) return;

      // Require pose present
      try { const k = (window.playerState?.keypoints||[]).length; if (k < 33) return; } catch {}
      const snap = (typeof window.extractPoseSnapshot === 'function' && window.playerState?.keypoints)
        ? window.extractPoseSnapshot(window.playerState.keypoints, window.getLockedHoopBox?.())
        : null;
      list.push({ pending: true, frameRelease: rf, tMs: Date.now(), poseSnapshot: snap, via: 'score-trip' });
      // Freshen snapshot immediately if we didn't have one yet
      try {
        queueMicrotask(async () => {
          try {
            const lastRow = list.at?.(-1) || null;
            if (lastRow && !lastRow.poseSnapshot && typeof window.__samplePoseSnapshotNow === 'function') {
              const s2 = await window.__samplePoseSnapshotNow();
              if (s2) lastRow.poseSnapshot = s2;
            }
          } catch {}
        });
      } catch {}
      try { window.__SHOT_IDX = (list.length - 1); } catch {}

      const taken = list.length;
      const start = (window.__sessionStart ||= Date.now());
      const elapsedSec = Math.floor((Date.now() - start) / 1000);
      window.mountSessionHUD?.();
      window.updateSessionHUD?.({ taken, elapsedSec });
      window.setSessionStatus?.('Shot ' + taken + ' in progress');
      if (window.DOACH_RELEASE_TRACE === true) console.log('[HUD:add-pending:score-trip]', { frame: rf, len: taken });

      // Fallback: persist a release mark to the backend even if no strict release event fired
      (async () => {
        try {
          let sid = (window.__SESSION_ID || null);
          if (!sid) { try { sid = await ensureSessionId(); } catch {} }
          if (!sid) return;
          const payload = {
            sessionId: sid,
            shotId: (window.__SHOT_IDX || (list.length - 1) || 0),
            frame: rf,
            tMs: Date.now(),
            via: 'hud:score-trip',
            poseSnapshot: snap,
            hoop: (typeof window.getLockedHoopBox === 'function') ? window.getLockedHoopBox() : null,
            gate: (window.__LAST_GATE || null)
          };
          await fetch('/api/release_mark', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload), credentials:'include' }).catch(()=>{});
        } catch {}
      })();

      // Auto end at cap
      try { const cap = getSessionCap(); if (shouldEnforceSessionCap() && taken >= cap) autoEndSessionAndSummarize(); } catch {}

      // If the full table is open, refresh so the new row appears as "pending"
      try {
        const modal = document.getElementById('fullShotModal');
        if (modal && modal.style.display === 'block') { renderFullShotTable(); wireFullShotModalActions(); }
      } catch {}
    }  
    catch (err) { if (window.DOACH_RELEASE_TRACE === true) console.warn('[HUD:score-trip:error]', err); }
  });

  // Live update the bottom HUD when HUD shot counter changes
  window.addEventListener('hud:shot-taken', (e) => {
    try {
      const cnt = Number(e?.detail?.count || window.shotTaken || window.__HUD_SHOT_COUNT || 0);
      const start = (window.__sessionStart ||= Date.now());
      const elapsedSec = Math.floor((Date.now() - start) / 1000);
      window.updateSessionHUD?.({ taken: cnt, elapsedSec });
      if (window.DOACH_RELEASE_TRACE === true) console.log('[HUD:update:mShots]', { taken: cnt });
      // Auto-end as soon as HUD count reaches cap
      if (window.SESSION_MANAGER_OWNS_ENDING !== true) {
        try {
          const cap = getSessionCap();
          if (shouldEnforceSessionCap() && cnt >= cap && !window.__sessionCapped) {
            window.__sessionCapped = true;
            autoEndSessionAndSummarize();
            return;
          }
        } catch {}
      }
      // Ensure local list has a pending record for this HUD shot index
      try {
        // Require pose present
        try { const k = (window.playerState?.keypoints||[]).length; if (k < 33) return; } catch {}
        const list = (window.__shotList ||= []);
        const targetIdx = Math.max(0, cnt - 1); // 0-based index from HUD count
        // Grow list with pending placeholders up to targetIdx
        while (list.length <= targetIdx) {
          const snap = (typeof window.extractPoseSnapshot === 'function' && window.playerState?.keypoints)
            ? window.extractPoseSnapshot(window.playerState.keypoints, window.getLockedHoopBox?.())
            : null;
          list.push({ pending: true, frameRelease: null, tMs: Date.now(), poseSnapshot: snap, via: 'hud:shot-taken' });
          // If just-added row has no snapshot, try sampling once immediately
          try {
            queueMicrotask(async () => {
              try {
                const lastRow = list.at?.(-1) || null;
                if (lastRow && !lastRow.poseSnapshot && typeof window.__samplePoseSnapshotNow === 'function') {
                  const s2 = await window.__samplePoseSnapshotNow();
                  if (s2) lastRow.poseSnapshot = s2;
                }
              } catch {}
            });
          } catch {}
        }
        try { window.__SHOT_IDX = targetIdx; } catch {}
        // Ensure a placeholder row exists in backend for this attempt
        postShotUpsert(targetIdx, { made: null });
      } catch {}
      // Also persist a release snapshot for admin even if strict release event didn't fire
      (async () => {
        try {
          let sid = (window.__SESSION_ID || null);
          if (!sid) { try { sid = await ensureSessionId(); } catch {} }
          if (!sid) return;
          // Pick a reasonable frame index approximation
          let rf = Number(window.__AN_IDX);
          if (!Number.isFinite(rf)) rf = Number(window.RELEASE_SCORE?.frame);
          if (!Number.isFinite(rf)) rf = 0;
          const snap = (typeof window.extractPoseSnapshot === 'function' && window.playerState?.keypoints)
            ? window.extractPoseSnapshot(window.playerState.keypoints, window.getLockedHoopBox?.())
            : null;
          const payload = {
            sessionId: sid,
            shotId: (window.__SHOT_IDX || Math.max(0, cnt - 1) || 0),
            frame: rf,
            tMs: Date.now(),
            via: 'hud:shot-taken',
            poseSnapshot: snap,
            hoop: (typeof window.getLockedHoopBox === 'function') ? window.getLockedHoopBox() : null,
            gate: (window.__LAST_GATE || null)
          };
          await fetch('/api/release_mark', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload), credentials:'include' }).catch(()=>{});
        } catch {}
      })();
      // Auto end at cap
      try { const cap = getSessionCap(); if (shouldEnforceSessionCap() && cnt >= cap) autoEndSessionAndSummarize(); } catch {}
    } catch {}
  });
})();



window.showCenterPrompt = showCenterPrompt;

// --- Live: force a fresh pose step immediately after hoop lock ---
// Ensures the skeleton updates on the very next paint in case the analyzer
// is still spinning up and BG pose hasn't sampled yet.
(function installForcePoseStep(){
  if (window.__forcePoseStepInstalled) return; window.__forcePoseStepInstalled = true;

  async function forcePoseStepOnce(){
    try {
      const v = document.getElementById('videoPlayer');
      if (!v || !v.videoWidth) return;
      const ts = performance.now();
      const res = await (window.poseDetector?.detectForVideo ? window.poseDetector.detectForVideo(v, ts) : (window.poseDetectSerial?.() || Promise.resolve(null)));
      const people = res?.landmarks || [];
      const ls = (Array.isArray(people) && Array.isArray(people[0]) && people[0].length >= 33) ? people[0] : null;
      if (!ls) return;
      const looksNorm = ls.every(k=>k && k.x <= 1.00 && k.y <= 1.00);
      const sx = looksNorm ? (v.videoWidth  || 1) : 1;
      const sy = looksNorm ? (v.videoHeight || 1) : 1;
      const scaled = ls.map(k=>({ ...k, x: k.x * sx, y: k.y * sy }));
      try {
        if (!window.playerState) window.playerState = { keypoints: [] };
        window.playerState.keypoints = scaled;
        window.__lastPoseKP = scaled; window.__lastPoseTS = performance.now();
        window.__lastPoseUpdateMs = performance.now(); window.__lastPoseWrist = scaled[16] || null;
      } catch {}
      try { window.drawLiveOverlay?.(window.lastDetectedFrame?.objects || [], window.playerState); } catch {}
    } catch {}
  }

  window.addEventListener('hoop:locked', () => {
    try {
      const v = document.getElementById('videoPlayer');
      const live = !!(v && v.srcObject);
      if (!live) return;
      // rAF + short timeout to cover layout resync and decoder latency
      requestAnimationFrame(() => { forcePoseStepOnce(); });
      setTimeout(forcePoseStepOnce, 140);
      // Start admin observer streaming automatically for demos
      try { window.startObserverStreaming?.(2); } catch {}

      // For the next ~2.5s after lock, actively sample pose at ~8â€“10 fps
      // so playerState keeps moving even if analyzer is spinning up.
      try { clearInterval(window.__forcePoseInterval); } catch {}
      const T0 = performance.now();
      window.__forcePoseInterval = setInterval(async () => {
        try {
          if (performance.now() - T0 > 2500) { clearInterval(window.__forcePoseInterval); return; }
          const ts = performance.now();
          const res = await (window.poseDetector?.detectForVideo ? window.poseDetector.detectForVideo(v, ts) : (window.poseDetectSerial?.() || Promise.resolve(null)));
          const people = res?.landmarks || [];
          const ls = (Array.isArray(people) && Array.isArray(people[0]) && people[0].length >= 33) ? people[0] : null;
          if (!ls) return;
          const looksNorm = ls.every(k=>k && k.x <= 1.01 && k.y <= 1.01);
          const sx = looksNorm ? (v.videoWidth||1)  : 1;
          const sy = looksNorm ? (v.videoHeight||1) : 1;
          const scaled = ls.map(k=>({ ...k, x: k.x * sx, y: k.y * sy }));
          try {
            if (!window.playerState) window.playerState = { keypoints: [] };
            window.playerState.keypoints = scaled;
            window.__lastPoseKP = scaled; window.__lastPoseTS = performance.now();
            window.__lastPoseUpdateMs = performance.now(); window.__lastPoseWrist = scaled[16] || null;
          } catch {}
          try { window.drawLiveOverlay?.(window.lastDetectedFrame?.objects || [], window.playerState); } catch {}
        } catch {}
      }, 120);
    } catch {}
  }, { passive: true });
})();

window.addEventListener('session:ended', () => {
  try {
    if (__capEnforceTimer) {
      clearTimeout(__capEnforceTimer);
      __capEnforceTimer = null;
    }
  } catch {}
});

window.addEventListener('shot:summary', () => {
  try {
    const cap = getSessionCap();
    if (!Number.isFinite(cap) || cap <= 0) return;
    const count = Number(window.__SESSION_SHOT_COUNT || 0);
    if (shouldEnforceSessionCap() && count >= cap) {
      if (__capEnforceTimer) return;
      const delay = Math.max(600, Number(window.CAP_SUMMARY_GRACE_MS || 1600));
      __capEnforceTimer = setTimeout(() => {
        __capEnforceTimer = null;
        try {
          if (window.__sessionEnded === true || window.__sessionCapped === true) return;
          console.warn('[video_ui] cap fallback auto-end', { cap, count });
          const maybe = autoEndSessionAndSummarize?.();
          if (maybe && typeof maybe.catch === 'function') {
            maybe.catch(() => {});
          }
        } catch {}
      }, delay);
    }
  } catch {}
});









