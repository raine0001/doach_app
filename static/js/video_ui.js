// ✅ [video_ui.js] - Enhancements for DOACH Mobile/Full-Screen Integration
import { setOverlayInteractive } from './fix_overlay_display.js';
import { speak } from './coach_voice.js';
import { arcHeightLabel } from './shot_utils.js';
import { enableHoopPickOnce } from './app.js';
import { stabilizeLockedHoop, getLockedHoopBox, handleHoopSelection } from './hoop_tracker.js';


window.getLockedHoopBox = getLockedHoopBox;
window.handleHoopSelection = handleHoopSelection; 

// Slow_arbiter.js — make sure it reads SLOW_RATE
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
    // console.log('[Slow]', why, '→', r);
  }

  window.addEventListener('shot:release', () => {
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
      window.addEventListener('shot:release', () => {
        try {
          const list = (window.__shotList || window.shotLog || []);
          const taken = list.length + 1;
          const made = (window.shotLog?.filter?.(s => s.made).length || 0);
          const acc = taken ? Math.round((made / taken) * 100) : 0;
          window.mountSessionHUD?.();
          window.updateSessionHUD?.({ taken, made, accuracy: acc, elapsedSec: Math.floor((Date.now() - (window.__sessionStart||Date.now()))/1000) });
          window.setSessionStatus?.('Shot ' + taken + ' in progress');
        } catch {}
      });
    }
  } catch {}

  window.addEventListener('shot:summary', () => {
    capTo = 0;
    setRate(1, 'summary');
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

  // media hygiene — any manual interaction cancels slow-mo
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

// ---- Global slow-mo FPS ----
window.FRAMEbyFRAME_RATE = window.FRAMEbyFRAME_RATE ?? 1.0; // default 1 fps
window.setFBFRate = (fps) => {
  window.FRAMEbyFRAME_RATE = Math.max(0.25, Number(fps) || 1.0);
  console.log('[video_ui] slow-mo fps =', window.FRAMEbyFRAME_RATE);
};

const SESSION_SIZE = 10;  // # of shots in a session

export function moveUploadToSidebar() {
  const chooseBtn = document.getElementById('videoInput');
  const menuContainer = document.getElementById('sidebar-content');

  if (chooseBtn && menuContainer) {
    const label = document.createElement('label');
    label.innerHTML = '📂 <strong>Upload Video</strong>';
    label.style.cursor = 'pointer';
    label.className = 'sidebar-upload-btn';
    label.appendChild(chooseBtn);
    chooseBtn.style.display = 'none';
    menuContainer.appendChild(label);
  }
}

// ───────── Single-frame step (RVFC/arbiter-safe) ─────────

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

// Legacy FBF shell (kept only so old callers won’t crash)
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
      position:'absolute', top:'10px', left:'50%', transform:'translateX(-50%)',
      padding:'6px 10px', font:'600 12px system-ui', letterSpacing:'0.04em',
      pointerEvents:'none'
    });
    root.appendChild(badge);
  }
  badge.textContent = text || 'SESSION IN PROGRESS…';
  badge.style.display = text === null ? 'none' : 'block';
}

// -----------------------------------------------------------------//
// ───────── Playback controls UI (mounted inside hudRoot) ─────────//
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

  // Skip transport controls for live camera feeds (srcObject present)
  try {
    if (video && video.srcObject) {
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
  const bHome  = mk('⏪','Go to start',    () => { cancelFramePlay(); video.pause(); video.currentTime = 0; });
  const bPause = mk('⏸','Pause',          () => { cancelFramePlay(); video.pause(); });
  const bPlay  = mk('▶','Play', () => {
    if (!requireHoopOrPrompt()) return;
    cancelFramePlay(); try { video.playbackRate = 1.0; } catch {}
    video.play();
  });
  const bAuto  = mk('🎞','Auto-step', () => {
    if (!requireHoopOrPrompt()) return;
    if (__framePlay.on) { cancelFramePlay(); bAuto.dataset.active='0'; }
    else { startFramePlay(video, Number(window.FRAMEbyFRAME_RATE) || 1.0); video.pause(); bAuto.dataset.active='1'; }
  });
  const bNext  = mk('⏭','Next',  () => { if (!requireHoopOrPrompt()) return; stepFrame(video,+1); });
  const bPrev  = mk('⏮','Prev',  () => { if (!requireHoopOrPrompt()) return; stepFrame(video,-1); });

  [bPrev,bHome,bPlay,bPause,bAuto,bNext].forEach(b => container.appendChild(b));
  root.appendChild(container);

  // keep things tidy
  video.addEventListener('ended', () => { cancelFramePlay(); bAuto.dataset.active = '0'; });
  video.addEventListener('play',  () => { if (__framePlay.on) video.pause(); }); // don’t fight auto-step

  // lift the rest of the HUD too (metrics + status)
  mountSessionHUD();
  setSessionStatus('SESSION IN PROGRESS…');

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
    <strong>${summary.made ? '✅ Made' : '❌ Missed'} Shot</strong><br>
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
  showPromptMessage('📍 Tap the hoop to begin setup', 2000);
  if (!window.__hoopPickArmed) {
    window.__hoopPickArmed = true;
    window.enableHoopPickOnce?.();   // arm picker again if needed
  }
  return false;
}

window.isHoopReady = isHoopReady;
window.requireHoopOrPrompt = requireHoopOrPrompt;

// ── Unified prompt system (uses #overlayPrompt if present, else #promptBar) ──

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
  const h = window.getLockedHoopBox?.();  // 👈 use window.*
  const ready = !!window.__hoopConfirmed && isValidHoopBox(h);
  console.log('[gate:isHoopReady]', {
    confirmed: window.__hoopConfirmed,
    hasCenter: hasCenter(h),
    hasSize: hasSize(h),
    ready
  });
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
      showPromptMessage('📍 Tap the hoop to begin setup', 2000);
      if (!window.__hoopPickArmed) {
        window.__hoopPickArmed = true;
        window.enableHoopPickOnce?.();
      }
    }
  };

  tick();
  window.__hoopPromptTimer = setInterval(tick, 1500); // keep “pulsing” until confirmed
}

window.enableHoopPickOnce = enableHoopPickOnce;


// ───────────────────────────────────────────────────────────────
// Video UI / HUD utilities
// ───────────────────────────────────────────────────────────────

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

/** Top-center session status line (“SESSION IN PROGRESS…”) */
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
      <button id="hudMute" class="vc-btn" title="Mute/Unmute">🔇</button>

      <div class="hud-metric" id="mShots"><div class="num">0/10</div><div class="label">Shots Taken</div></div>
      <div class="hud-metric" id="mMakes"><div class="num">0</div><div class="label">Makes</div></div>
      <div class="hud-metric" id="mAcc"><div class="num">0%</div><div class="label">Accuracy</div></div>
      <div class="hud-metric" id="mTime"><div class="num">0:00</div><div class="label">Time Elapsed</div></div>

      <button id="openSummaryBtn" class="hud-btn">Summary</button>
      <button id="startSessionHUD" class="hud-btn">Start Session</button>
      <button id="endSessionBtn" class="hud-btn">End Session</button>
      <button id="mySessionsHUD" class="hud-btn">My Sessions</button>
    `;
    root.appendChild(bar);

    const muteBtn = bar.querySelector('#hudMute');

    // --- unified apply function: UI, storage, prefs, event
    const applyMute = (muted) => {
      // button reflects CURRENT state
      muteBtn.setAttribute('data-muted', muted ? '1' : '0');
      muteBtn.textContent = muted ? '🔇' : '🔊';

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

    // other HUD buttons (unchanged)
    const endBtn = bar.querySelector('#endSessionBtn');
    endBtn && endBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.dispatchEvent(new CustomEvent('hud:end-session'));
    });

    const startBtn = bar.querySelector('#startSessionHUD');
    startBtn && startBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.dispatchEvent(new CustomEvent('hud:start-session'));
    });

    const myBtn = bar.querySelector('#mySessionsHUD');
    myBtn && myBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      try { window.open('/static/my_sessions.html','_blank'); } catch {}
    });

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

  if (elShots) elShots.textContent = `${taken}/${SESSION_SIZE}`;
  if (elMakes) elMakes.textContent = `${made}`;
  if (elAcc)   elAcc.textContent   = `${Math.round(accuracy)}%`;
  if (elTime)  elTime.textContent  = `${mm}:${ss}`;
}

// end session shot summary table
function getShotList(){ return (window.__shotList ||= []); }

// Build & show the centered full-session modal
function renderFullShotTable() {
  ensureShotTableStyles();
  const list = getShotList();
  const root = ensureHudRoot();

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
      pointerEvents: 'auto'
    });
    root.appendChild(modal);
  }

  modal.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
      <div style="font-weight:600">📋 Shot Summary (${list.length}/${SESSION_SIZE})</div>
      <div>
        <button id="exportCSV" class="vc-btn" title="Export CSV">⬇︎ CSV</button>
        <button id="closeFull" class="vc-btn">✖</button>
      </div>
    </div>
    <table class="hud-table">
      <colgroup>
        <col id="cNum"><col id="cRes"><col id="cArc"><col id="cEntry"><col id="cRel"><col><col id="cFix">
      </colgroup>
      <thead>
        <tr>
          <th>#</th><th>Result</th><th>Arc</th><th>Entry°</th><th>Release°</th><th>Doach Summary</th><th>Correct</th>
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
    tr.innerHTML = `
      <td class="num">${i+1}</td>
      <td class="result">${s.made ? '✅' : '❌'}</td>
      <td class="arc">${Math.round(s.arcHeight ?? 0) || '–'}</td>
      <td class="entry">${s.entryAngle ?? '–'}</td>
      <td class="release">${s.releaseAngle ?? '–'}</td>
      <td class="coach">${coach ? esc(coach) : '—'}</td>
      <td class="fix">
        <div style="display:flex;gap:6px">
          <button class="vc-btn btn-make"  title="Mark Make" data-id="${i+1}">✅</button>
          <button class="vc-btn btn-miss"  title="Mark Miss" data-id="${i+1}">❌</button>
          <button class="vc-btn btn-ai"    title="AI Review" data-id="${i+1}">🤖</button>
        </div>
      </td>`;

    tb.appendChild(tr);
  });

  modal.querySelector('#closeFull').onclick = () => modal.style.display = 'none';
  modal.querySelector('#exportCSV').onclick = () => exportSessionCSV(list);
  modal.style.display = 'block';
  return modal;
}

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
window.recordShotSummary = function recordShotSummary(summary) {
  // de-dupe
  const key = `${+summary.made}|${Math.round(summary.arcHeight||0)}|${summary.entryAngle}|${summary.releaseAngle}|${summary.frameExit||''}`;
  if (window.__lastShotKey === key) return;
  window.__lastShotKey = key;

  // carry most recent coaching line if present
  if (!summary.doach && window.__lastCoachText) summary.doach = window.__lastCoachText;

  const list = (window.__shotList ||= []);
  const idx  = list.push(summary);      // 1-based index
  summary.__idx = idx;                  // keep the index on the object for later

  // If the full table is open, append this row now (properly marked up)
  const modal = document.getElementById('fullShotModal');
  if (modal) {
    const esc = (s) => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const tb  = modal.querySelector('tbody');
    if (tb) {
      const tr = document.createElement('tr');
      tr.setAttribute('data-shot-idx', idx);
      tr.innerHTML = `
        <td class="num">${idx}</td>
        <td class="result">${summary.made ? '✅' : '❌'}</td>
        <td class="arc">${Math.round(summary.arcHeight ?? 0) || '–'}</td>
        <td class="entry">${summary.entryAngle ?? '–'}</td>
        <td class="release">${summary.releaseAngle ?? '–'}</td>
        <td class="coach" title="${esc(summary.doach||'')}">${summary.doach ? esc(summary.doach) : '—'}</td>
        <td class="fix">
          <div style="display:flex;gap:6px">
            <button class="vc-btn btn-make"  title="Mark Make" data-id="${idx}">✅</button>
            <button class="vc-btn btn-miss"  title="Mark Miss" data-id="${idx}">❌</button>
            <button class="vc-btn btn-ai"    title="AI Review" data-id="${idx}">🤖</button>
          </div>
        </td>`;
      tb.appendChild(tr);
    }
  }

  // HUD counters
  const { taken, made, acc } = computeTotals(list);
  const start = (window.__sessionStart ||= Date.now());
  const elapsedSec = Math.floor((Date.now() - start) / 1000);
  updateSessionHUD({ taken, made, accuracy: acc, elapsedSec });

  // End-of-session
  if (taken === SESSION_SIZE) {
    renderFullShotTable(); 
    wireFullShotModalActions(); 
  }
};

// Wire correction buttons for the full-session modal (id: fullShotModal)
function wireFullShotModalActions() {
  const modal = document.getElementById('fullShotModal');
  if (!modal || modal.__wiredCorrections) return;
  modal.__wiredCorrections = true;

  const tbody = modal.querySelector('tbody');
  if (!tbody) return;

  // Update one table row’s UI after a correction
  function refreshRowUI(idx) {
    const list = window.__shotList || [];
    const s = list[idx - 1];
    const tr = modal.querySelector(`tr[data-shot-idx="${idx}"]`);
    if (!s || !tr) return;

    tr.querySelector('.result').textContent = s.made ? '✅' : '❌';

    // Recompute accuracy badge and HUD numbers from current list
    const { taken, made, acc } = computeTotals(list);
    try {
      updateSessionHUD({ taken, made, accuracy: acc, elapsedSec: Math.floor((Date.now() - (window.__sessionStart||Date.now()))/1000) });
    } catch {}
  }

  // Delegated button handlers (Make / Miss / AI)
  tbody.addEventListener('click', async (e) => {
    const b  = e.target.closest('button'); if (!b) return;
    const id = Number(b.dataset.id || 0);  if (!id) return;

    try {
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
    <strong>${summary.made ? '✅ Made' : '❌ Missed'} Shot</strong><br>
    Arc Height: ${Math.round(summary.arcHeight || 0)}px<br>
    Entry Angle: ${summary.entryAngle ?? '–'}°<br>
    Release Angle: ${summary.releaseAngle ?? '–'}°<br>
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
    startHoopPromptLoop();
    showCenterCountdownAndPrompt();
    setOverlayInteractive(true);
  });

  // if video was already loaded (fast cache), still start the loop
  if (videoEl?.readyState >= 2) {
    ensureHudRoot();
    startHoopPromptLoop();
    showCenterCountdownAndPrompt();
    setOverlayInteractive(true);
  }

  // keep HUD on top when playback state toggles
  videoEl?.addEventListener('play',  ensureHudRoot);
  videoEl?.addEventListener('pause', ensureHudRoot);

  // confirm hoop locker fires
  window.addEventListener('hoop:locked', () => {
  window.__hoopConfirmed = true;      // <-- user has confirmed
  hidePromptMessage();
  clearInterval(window.__hoopPromptTimer);
  try { const v = document.getElementById('videoPlayer') || document.querySelector('video'); if (v) v.playbackRate = 1; } catch {}
});
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
    #fullShotModal .hud-table th,
    #fullShotModal .hud-table td{ padding:8px 10px; vertical-align:top; text-align:left;
      border-bottom:1px solid rgba(255,255,255,.12); }
    #fullShotModal .hud-table tbody tr:nth-child(even) td{ background:rgba(255,255,255,.03); }
    #fullShotModal td.num, #fullShotModal td.arc, #fullShotModal td.entry, #fullShotModal td.release { text-align:center; }
    #fullShotModal td.result{ text-align:center; }
    #fullShotModal td.coach{ white-space:normal; word-break:break-word; line-height:1.25; }
  `;
  document.head.appendChild(css);
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
    const promptEl = showCenterPrompt('Get ready…');
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

  // Hard guard: don’t allow slow-mo to linger
  (function tick(){
    // if rate < 0.9 longer than configured slow-mo, bail out to 1×
    const maxMs = Math.max(2000, (Number(window.Slow_MS) || 1200) + 600);
    if (v.playbackRate < 0.9 && performance.now() - lastRateSetAt > maxMs) {
      setRate(1);
    }
    requestAnimationFrame(tick);
  })();
})();


// Hard exit to 1× as soon as summary is received
window.addEventListener('shot:summary', () => {
  const v = document.getElementById('videoPlayer') || document.querySelector('video');
  if (v) { try { v.playbackRate = 1; } catch {} }
});



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
      const looksNorm = ls.every(k=>k && k.x <= 1.01 && k.y <= 1.01);
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

      // For the next ~2.5s after lock, actively sample pose at ~8–10 fps
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
