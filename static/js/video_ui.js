// ✅ [video_ui.js] - Enhancements for DOACH Mobile/Full-Screen Integration
import { setOverlayInteractive } from './fix_overlay_display.js';
import { enableHoopPickOnce } from './app.js';
import { stabilizeLockedHoop, getLockedHoopBox, handleHoopSelection } from './hoop_tracker.js';


window.getLockedHoopBox = getLockedHoopBox;
window.handleHoopSelection = handleHoopSelection; 

const FRAMEbyFRAME_RATE = 3;   //set frame by frame rate playback

// ---- Global slow-mo FPS (editable in console: setFBFRate(0.7)) ----
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


// play, pause, manual step while paused, restart                         //
// ───────── Frame-by-frame engine with analyzer back-pressure ─────────  //
let __framePlay = { on:false, timer:null, cleanup:null, fps:12, video:null };

function getFPS(v){ return Number(window.__videoFPS)>0 ? Number(window.__videoFPS) : 30; }

function stepOnce(v){ const fd=1/getFPS(v); try{ v.currentTime = Math.min(v.duration||Infinity, (v.currentTime||0)+fd); }catch{} }

export function cancelFramePlay(){
  if (__framePlay.timer) clearTimeout(__framePlay.timer);
  if (__framePlay.cleanup) { try{ __framePlay.cleanup(); }catch{} }
  __framePlay = { on:false, timer:null, cleanup:null, fps:12, video:null };
}

//start frame by frame play - primarily for ball arc/shot analysis
export function startFramePlay(video, fps=12){
  cancelFramePlay();
  __framePlay.on  = true;
  __framePlay.fps = fps;
  __framePlay.video = video;
  video.pause(); // we drive time via seeks/sets

  if (window.__analyzerActive) {
    const onDone = () => {
      if (!__framePlay.on) return;
      stepOnce(video);
      clearTimeout(__framePlay.timer);
      __framePlay.timer = setTimeout(() => { if (__framePlay.on) stepOnce(video); }, Math.max(0, 1000/fps + 50));
    };
    window.addEventListener('analyzer:frame-done', onDone);
    __framePlay.cleanup = () => window.removeEventListener('analyzer:frame-done', onDone);
    stepOnce(video); // kick initial step
  } else {
    const tick = () => {
      if (!__framePlay.on) return;
      stepOnce(video);
      __framePlay.timer = setTimeout(tick, Math.max(0, 1000/fps));
    };
    tick();
  }
}

// Step frame by frame
export function stepFrame(video, dir=+1){
  cancelFramePlay();
  video.pause();
  const fd=1/getFPS(video);
  try { video.currentTime = Math.max(0, Math.min((video.duration||0), (video.currentTime||0)+dir*fd)); }
  catch(e){ console.warn('[stepFrame] failed:', e); }
}

function getVideoEl() {
  return window.__videoEl
      || window.video
      || document.getElementById('videoPlayer')   // your ensureHudRoot uses this id
      || document.getElementById('video')
      || document.querySelector('video');
}


// ---- expose frame-by-frame controls for other files ----
window.frameMode = {
  on() {
    const vid = getVideoEl();
    if (vid && !__framePlay.on) { startFramePlay(vid, FRAMEbyFRAME_RATE); vid.pause(); }
  },
  off() { if (__framePlay.on) cancelFramePlay(); },
  isOn() { return !!__framePlay.on; }
};

// slow-motion helpers  -----------------------------------------------//

// Auto slow-mo at release, back to normal at summary
// Auto slow-mo at release, back to normal at summary
(function attachFBFHandlers(){
  if (window.__fbfWired) return;   // prevent duplicates
  window.__fbfWired = true;

  let resumeAfterFBF = false;      // we turned slow-mo on → resume later

  function onRelease(e){
    console.log('[video_ui] shot:release', e?.detail);
    const vid = getVideoEl();
    if (!vid) return console.warn('[video_ui] no <video> element found');
    resumeAfterFBF = true;
    const rate = Number(window.FRAMEbyFRAME_RATE) || 1.0;
    startFramePlay(vid, rate);
    vid.pause();
    console.log('[video_ui] FBF ON @', rate, 'fps');
  }

  function onSummary(e){
    console.log('[video_ui] shot:summary', e?.detail);
    cancelFramePlay();
    if (resumeAfterFBF) {
      const vid = getVideoEl();
      if (vid && vid.paused) { try { vid.play(); } catch (err) { console.warn('[video_ui] resume failed', err); } }
      resumeAfterFBF = false;
      console.log('[video_ui] FBF OFF → resume play');
    } else {
      console.log('[video_ui] FBF OFF');
    }
  }

  window.addEventListener('shot:release', onRelease);
  window.addEventListener('shot:summary', onSummary);
})();


//  end slow mo helpers  -----------------------------------------------//



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


// ───────── Playback controls UI (mounted inside hudRoot) ─────────
export function createPlaybackControls(video) {
  window.__videoEl = video;
  // remove any previous bar (prevent duplicates after re-load)
  const root = ensureHudRoot(); // <-- always sit above the video
  root.querySelectorAll('.video-controls').forEach(el => el.remove());

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

  div.innerHTML = `
    <strong>${summary.made ? '✅ Made' : '❌ Missed'} Shot</strong><br>
    Arc Height: ${summary.arcHeight}px<br>
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
      <button id="endSessionBtn" class="hud-btn">End Session</button>
    `;
    root.appendChild(bar);

    const muteBtn = bar.querySelector('#hudMute');
    muteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const on = muteBtn.getAttribute('data-active') === '1';
      muteBtn.setAttribute('data-active', on ? '0' : '1');
      muteBtn.textContent = on ? '🔇' : '🔊';
      window.dispatchEvent(new CustomEvent('hud:mute-toggle', { detail: { muted: !on }}));
    });

    bar.querySelector('#endSessionBtn').addEventListener('click', (e) => {
      e.stopPropagation();
      window.dispatchEvent(new CustomEvent('hud:end-session'));
    });

    const summaryBtn = bar.querySelector('#openSummaryBtn');
    if (summaryBtn && !summaryBtn.__wired) {
      summaryBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        renderFullShotTable();
      });
      summaryBtn.__wired = true;
    }
  }
  return bar;
}

/** Update numbers in the bottom HUD bar */
export function updateSessionHUD({ taken=0, made=0, accuracy=0, elapsedSec=0 } = {}) {
  const bar = mountSessionHUD();                              // ensure it exists and scope queries to it
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
        <col id="cNum"><col id="cRes"><col id="cArc"><col id="cEntry"><col id="cRel"><col>
      </colgroup>
      <thead>
        <tr>
          <th>#</th><th>Result</th><th>Arc</th><th>Entry°</th><th>Release°</th><th>Doach Summary</th>
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
      <td class="coach">${coach ? esc(coach) : '—'}</td>`;
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

  // ⬇️ If the full table is open, append this row now (properly marked up)
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
        <td class="coach" title="${esc(summary.doach||'')}">${summary.doach ? esc(summary.doach) : '—'}</td>`;
      tb.appendChild(tr);
    }
  }

  // HUD counters
  const { taken, made, acc } = computeTotals(list);
  const start = (window.__sessionStart ||= Date.now());
  const elapsedSec = Math.floor((Date.now() - start) / 1000);
  updateSessionHUD({ taken, made, accuracy: acc, elapsedSec });

  // End-of-session
  if (taken === SESSION_SIZE) renderFullShotTable();
};



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
  window.recordShotSummary?.(e.detail);
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
    setOverlayInteractive(true);
  });

  // if video was already loaded (fast cache), still start the loop
  if (videoEl?.readyState >= 2) {
    ensureHudRoot();
    startHoopPromptLoop();
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

(function installSlowMoFailsafe(){
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
  window.addEventListener('video:slowmo:on',  () => setRate(0.25));
  window.addEventListener('video:slowmo:off', () => setRate(1));

  // Hard guard: don’t allow slow-mo to linger
  (function tick(){
    // if rate < 0.9 for > 2000ms, bail out to 1×
    if (v.playbackRate < 0.9 && performance.now() - lastRateSetAt > 2000) {
      setRate(1);
    }
    requestAnimationFrame(tick);
  })();
})();


