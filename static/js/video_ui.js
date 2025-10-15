// video_ui.js — UI only. iOS-safe. No cap enforcement, no auto-end, no recording, no server writes.
// Owns: HUD, prompts, camera switcher, summary table rendering, UI updates from events.
// Exposes: showPromptMessage, ensureHudRoot, mountSessionHUD, updateSessionHUD, renderFullShotTable,
//          autoEndSessionAndSummarize (callable, not auto-triggered).

import { setOverlayInteractive, syncOverlayToVideo } from './fix_overlay_display.js';
import { enableHoopPickOnce } from './app.js';
import { getLockedHoopBox, handleHoopSelection, canonHoop } from '/static/arc_mm/hoop_tracker.js';

// Soft demo toggles (ignored by logic that could conflict)
window.DEMO = true;
window.DEMO_MINIMAL_TABLE = true;

// Make these helpers reachable to other modules
window.getLockedHoopBox = getLockedHoopBox;
window.handleHoopSelection = handleHoopSelection;
window.startLandscapeRecorder = startLandscapeRecorder;

// stop the compositor when the session ends or page unloads
window.addEventListener('hud:end-session', async () => {
  try { await window.__landscapeRecController?.stop(); } catch {}
  window.__landscapeRecController = null;
});
window.addEventListener('beforeunload', () => {
  try { window.__landscapeRecController?.stop(); } catch {}
});

/* ----------------------- iOS viewport + basics ----------------------- */
(function installMobileViewportFixes() {
    let tag = document.querySelector('meta[name="viewport"]');
    if (!tag) { tag = document.createElement('meta'); tag.name = 'viewport'; document.head.appendChild(tag); }
    tag.setAttribute('content', [
        'width=device-width',
        'initial-scale=1',
        'maximum-scale=1',
        'viewport-fit=cover',
        'user-scalable=no'
    ].join(','));

    if (!document.getElementById('doach-mobile-css')) {
        const css = document.createElement('style');
        css.id = 'doach-mobile-css';
        css.textContent = `
      html, body { margin:0; padding:0; height:100%; background:#000; overscroll-behavior:none; }
      .session-container, #videoPlayer { width:100%; height:100svh; object-fit:cover; }
      #hudRoot { inset: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); }
      .hud-card, .hud-pill { -webkit-tap-highlight-color: transparent; }
      button.vc-btn { font: 600 12px system-ui; border-radius: 10px; padding: 6px 10px; }
    `;
        document.head.appendChild(css);
    }

    window.addEventListener('load', () => {
        const v = document.getElementById('videoPlayer');
        if (v) { v.setAttribute('playsinline', ''); v.muted = true; }
    });
})();

/* ---------------------------- HUD root ----------------------------- */
export function ensureHudRoot() {
    const video = document.getElementById('videoPlayer');
    const host = video?.parentElement || document.body;
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';

    let root = document.getElementById('hudRoot');
    if (!root) {
        root = document.createElement('div');
        root.id = 'hudRoot';
        host.appendChild(root);
    }
    Object.assign(root.style, { position: 'absolute', inset: '0', pointerEvents: 'none', zIndex: 10000 });
    return root;
}
window.ensureHudRoot = ensureHudRoot;

/* ----------------------------- Prompts ----------------------------- */
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
        position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
        background: 'rgba(0,0,0,0.75)', color: '#fff', padding: '18px 28px',
        borderRadius: '18px', font: '700 20px/1.4 system-ui, sans-serif',
        textAlign: 'center', minWidth: '320px',
        display: 'none', pointerEvents: 'none', zIndex: '10001',
        boxShadow: '0 12px 30px rgba(0,0,0,0.35)'
    });
    return el;
}

export function showPromptMessage(text, duration = 3000) {
    const el = getPromptEl();
    el.textContent = text;
    el.style.display = 'block';
    el.style.opacity = '1';
    clearTimeout(el.__t);
    el.__t = setTimeout(() => {
        el.style.opacity = '0';
        setTimeout(() => (el.style.display = 'none'), 300);
    }, duration);
}
window.showPromptMessage = showPromptMessage;

function hidePromptMessage() {
    const el = document.getElementById('overlayPrompt') || document.getElementById('promptBar');
    if (!el) return;
    clearTimeout(el.__t);
    el.style.display = 'none';
}

/* ----------------------------- HUD bar ----------------------------- */
const ICON_AUDIO_ON = '\u{1F50A}';
const ICON_AUDIO_OFF = '\u{1F507}';
const ICON_CAMERA_FRONT = '\u{1F4F8}';
const ICON_CAMERA_BACK = '\u{1F4F7}';
const ICON_CAMERA_SWITCH = '\u{1F503}';
const SYMBOL_INFINITY = '\u{221E}';

function formatCapDisplay(cap) {
    const n = Number(cap);
    return (Number.isFinite(n) && n > 0) ? String(n) : SYMBOL_INFINITY;
}
function currentFacingLabel() {
    try {
        const f = (localStorage.getItem('doach_camera_facing') || '').toLowerCase();
        if (f === 'user' || f === 'front') return 'Front';
        if (f === 'environment' || f === 'back' || f === 'rear') return 'Back';
    } catch { }
    return 'Back';
}
function formatHudCameraIcon(lab) {
    return (lab === 'Back') ? ICON_CAMERA_BACK : ICON_CAMERA_FRONT;
}

export function mountSessionHUD() {
    const root = ensureHudRoot();
    let bar = document.getElementById('sessionHUD');
    if (!bar) {
        bar = document.createElement('div');
        bar.id = 'sessionHUD';
        bar.className = 'hud-card hud-pill';
        Object.assign(bar.style, {
            position: 'absolute', left: '50%', transform: 'translateX(-50%)',
            bottom: 'calc(env(safe-area-inset-bottom, 0px) + 18px)', gap: '20px', pointerEvents: 'auto'
        });

        bar.innerHTML = `
      <div class="hud-controls">
        <button id="hudVoiceToggle" class="hud-icon-btn voice-toggle is-on" data-muted="0" aria-pressed="true" aria-label="Toggle voice">
          <span class="icon-on" aria-hidden="true">${ICON_AUDIO_ON}</span>
          <span class="icon-off" aria-hidden="true">${ICON_AUDIO_OFF}</span>
        </button>
        <button id="hudCamFlip" class="hud-icon-btn" aria-label="Switch camera" title="Switch camera">
          <span class="icon" aria-hidden="true">${formatHudCameraIcon(currentFacingLabel())}</span>
        </button>
      </div>
      <div class="hud-metric" id="mShots"><div class="num">0/${formatCapDisplay(window.SESSION_SIZE)}</div><div class="label">Shots Taken</div></div>
      <div class="hud-metric" id="mTime"><div class="num">0:00</div><div class="label">Time Elapsed</div></div>
    `;
        root.appendChild(bar);


        const camBtn = bar.querySelector('#hudCamFlip');

        // ===== Voice toggle (no innerHTML stomping + iOS-safe) =====
        (() => {
            // iOS unlock, idempotent
            async function __unlockIOSAudioOnce() {
                if (window.__iosAudioUnlocked) return true;
                let unlocked = false;

                const markUnlocked = () => { unlocked = true; };

                try {
                    if (typeof window.primeCoachAudio === 'function') {
                        let primeResult = window.primeCoachAudio();
                        if (primeResult && typeof primeResult.then === 'function') {
                            primeResult = await primeResult.catch(() => false);
                        }
                        if (primeResult !== false) markUnlocked();
                    }
                } catch (err) {
                    try { console.warn('[hud] primeCoachAudio unlock failed', err); } catch { }
                }

                // WebAudio path
                try {
                    const Ctx = window.AudioContext || window.webkitAudioContext;
                    if (Ctx) {
                        const ctx = window.__coachPrimeCtx || (window.__coachPrimeCtx = new Ctx());
                        if (ctx.state === 'suspended' && ctx.resume) {
                            try { await ctx.resume(); markUnlocked(); } catch { }
                        } else if (ctx.state === 'running') {
                            markUnlocked();
                        }
                        const src = ctx.createBufferSource();
                        src.buffer = ctx.createBuffer(1, 1, 22050);
                        const gain = ctx.createGain(); gain.gain.value = 0;
                        src.connect(gain); gain.connect(ctx.destination);
                        try { src.start(0); src.stop(0); markUnlocked(); } catch { }
                    }
                } catch (err) {
                    try { console.warn('[hud] AudioContext unlock failed', err); } catch { }
                }

                // HTMLMediaElement path
                try {
                    let el = window.__coachAudioEl;
                    if (!el) {
                        el = document.createElement('audio');
                        el.style.display = 'none';
                        el.setAttribute('playsinline', ''); el.playsInline = true;
                        document.body.appendChild(el);
                        window.__coachAudioEl = el;
                    }
                    el.muted = false; el.volume = 1;
                    el.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=';
                    let playResult = el.play?.();
                    if (playResult && typeof playResult.then === 'function') {
                        playResult = await playResult.catch(() => false);
                    }
                    if (playResult !== false) markUnlocked();
                    try { el.pause?.(); el.removeAttribute('src'); el.load?.(); } catch { }
                } catch (err) {
                    try { console.warn('[hud] HTMLAudio unlock failed', err); } catch { }
                }

                if (!unlocked) {
                    try { window.__iosAudioUnlocked = false; } catch { }
                    return false;
                }

                try { window.__iosAudioUnlocked = true; } catch { }
                try { console.debug('[hud] iOS audio unlocked'); } catch { }
                return true;
            }


            function findBtn() {
                return document.getElementById('hudVoiceToggle')
                    || document.querySelector('[data-role="hud-voice-toggle"]')
                    || document.querySelector('#hud .voice-toggle, .hud .voice-toggle');
            }

            function setState(btn, muted) {
                // Do NOT touch innerHTML/textContent. CSS should react to these only:
                btn.dataset.muted = muted ? '1' : '0';
                btn.setAttribute('aria-pressed', muted ? 'false' : 'true');
                btn.classList.toggle('is-muted', !!muted);
                btn.classList.toggle('is-on', !muted);
                // force visible just in case
                btn.style.display = '';
                btn.style.visibility = 'visible';
            }

            function applyMute(btn, muted, announce = false) {
                setState(btn, muted);
                try { localStorage.setItem('doach_muted', JSON.stringify(muted)); } catch { }
                try { window.__coachMuted = muted; } catch { }
                try { window.dispatchEvent(new CustomEvent('hud:mute-toggle', { detail: { muted } })); } catch { }

                if (!announce) return;

                if (!muted) {
                    try {
                        const maybe = __unlockIOSAudioOnce();
                        if (maybe && maybe.catch) maybe.catch(() => { });
                    } catch { }
                    try { window.CoachAudio?.unlock?.(); } catch { }
                    if (window.PREF_ALLOW_MIC === true) {
                        try { window.__startCoachVoiceRecognition?.(); } catch { }
                        try { window.dispatchEvent(new CustomEvent('coach:voice-rec-start', { detail: { via: 'hud-voice-toggle' } })); } catch { }
                    }
                }

                if (typeof window.doachSpeak === 'function') {
                    try { window.doachSpeak(muted ? 'Voice off.' : 'Voice on.'); } catch { }
                }
            }

            function wire(btn) {
                // restore saved
                let savedMuted = false;
                try {
                    const raw = localStorage.getItem('doach_muted');
                    if (raw != null) savedMuted = JSON.parse(raw);
                } catch { }
                applyMute(btn, savedMuted, false);

                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    try {
                        const maybe = __unlockIOSAudioOnce();
                        if (maybe && typeof maybe.then === 'function') {
                            maybe.catch(() => { });
                        }
                    } catch { }

                    const wasMuted = btn.dataset.muted === '1';
                    applyMute(btn, !wasMuted, true);
                }, { passive: true });

                // one-time unlock for early touch
                window.addEventListener('touchstart', () => {
                    try { __unlockIOSAudioOnce(); } catch { }
                }, { once: true, passive: true });
                window.addEventListener('pointerdown', () => {
                    try { __unlockIOSAudioOnce(); } catch { }
                }, { once: true, passive: true });
                window.addEventListener('mousedown', () => {
                    try { __unlockIOSAudioOnce(); } catch { }
                }, { once: true, passive: true });
                window.addEventListener('hud:start-session', () => {
                    try {
                        const fn = (typeof window.unlockIOSAudio === 'function') ? window.unlockIOSAudio : __unlockIOSAudioOnce;
                        const maybe = (typeof fn === 'function') ? fn() : null;
                        if (maybe && typeof maybe.catch === 'function') maybe.catch(() => { });
                    } catch { }
                }, { once: true });
            }

            // Wait for button if HUD mounts late
            const btnNow = findBtn();
            if (btnNow) { if (!btnNow.__voiceWired) { btnNow.__voiceWired = true; wire(btnNow); } }
            else {
                const obs = new MutationObserver(() => {
                    const b = findBtn();
                    if (b) {
                        if (!b.__voiceWired) { b.__voiceWired = true; wire(b); }
                        obs.disconnect();
                    }
                });
                try { obs.observe(document.documentElement, { childList: true, subtree: true }); } catch { }
            }
        })();


        // Camera flip
        const updateHudCamButton = () => {
            const facing = currentFacingLabel();
            const icon = formatHudCameraIcon(facing);
            camBtn.dataset.facing = facing;
            camBtn.innerHTML = `<span class="icon" aria-hidden="true">${icon}</span>`;
            const next = facing === 'Back' ? 'front' : 'back';
            camBtn.setAttribute('aria-label', `Switch to ${next} camera`);
            camBtn.title = `Switch to ${next} camera`;
        };
        updateHudCamButton();
        window.addEventListener('camera:facing-changed', updateHudCamButton);

        camBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            try {
                const cur = (localStorage.getItem('doach_camera_facing') || 'environment').toLowerCase();
                const next = (cur === 'user' || cur === 'front') ? 'environment' : 'user';
                localStorage.setItem('doach_camera_facing', next);
                if (typeof window.setPreferredFacing === 'function') await window.setPreferredFacing(next);
                else if (typeof window.flipCamera === 'function') await window.flipCamera();
            } catch (err) {
                console.warn('[hud] flip camera failed', err);
            } finally {
                updateHudCamButton();
            }
        });
    }
    return bar;
}
window.mountSessionHUD = mountSessionHUD;

export function updateSessionHUD({ taken = 0, made = 0, accuracy = 0, elapsedSec = 0 } = {}) {
    const bar = mountSessionHUD();
    const $ = (id) => bar.querySelector(`#${id} .num`);
    const mm = Math.floor(elapsedSec / 60);
    const ss = Math.floor(elapsedSec % 60).toString().padStart(2, '0');

    // Use FINALIZED rows only, never overlay pulses
    try {
        const list = Array.isArray(window.__shotList) ? window.__shotList : [];
        const finalized = list.filter(s => s && s.pending === false).length;
        taken = Math.max(Number(taken || 0), finalized);
    } catch { }

    const elShots = $('mShots');
    const elTime = $('mTime');
    if (elShots) elShots.textContent = `${taken}/${(Number(window.SESSION_SIZE) || '∞')}`;
    if (elTime) elTime.textContent = `${mm}:${ss}`;
}
window.updateSessionHUD = updateSessionHUD;

/* ------------------------ Camera switcher UI ------------------------ */
(function installCameraSwitcher() {
    if (window.__cameraSwitcherInstalled) return; window.__cameraSwitcherInstalled = true;

    function formatCameraFacing(label) {
        return ((label === 'Back') ? ICON_CAMERA_BACK : ICON_CAMERA_FRONT) + ' ' + label;
    }
    function readPref() { try { return localStorage.getItem('cam_facing') || 'Back'; } catch { return 'Back'; } }
    function writePref(v) {
        try { localStorage.setItem('cam_facing', v); } catch { }
        try { localStorage.setItem('doach_camera_facing', v === 'Back' ? 'environment' : 'user'); } catch { }
    }

    function stopStream() {
        const v = document.getElementById('videoPlayer');
        const s = v && v.srcObject;
        if (s?.getTracks) s.getTracks().forEach(t => { try { t.stop(); } catch { } });
        if (v) v.srcObject = null;
    }
    function labelToFacing(label) { return (String(label).toLowerCase().startsWith('b')) ? 'environment' : 'user'; }

    async function startWithConstraints(cons) {
        const v = document.getElementById('videoPlayer');
        if (!v) return false;

        const preferredSizing = {
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 30 }
        };

        const normalize = (raw) => {
            if (!raw) return {};
            if (typeof raw === 'string') return { facingMode: raw };
            if (typeof raw === 'object') return { ...raw };
            return {};
        };

        const buildAttempts = (raw) => {
            const base = normalize(raw);
            const attempts = [];
            const seen = new Set();
            const pushUnique = (obj) => {
                if (!obj) return;
                const sig = JSON.stringify(obj);
                if (seen.has(sig)) return;
                seen.add(sig);
                attempts.push(obj);
            };
            pushUnique({ ...preferredSizing, ...base });
            pushUnique(base);
            pushUnique({ ...preferredSizing });
            return attempts;
        };

        const attempts = buildAttempts(cons);
        for (const videoCons of attempts) {
            let stream = null;
            try {
                stream = await navigator.mediaDevices.getUserMedia({ video: videoCons, audio: false });
                try {
                    v.setAttribute('playsinline', '');
                    v.playsInline = true;
                    v.muted = true;
                    v.autoplay = true;
                } catch { }
                v.srcObject = stream;

                if (v.readyState < 1 || !v.videoWidth || !v.videoHeight) {
                    await new Promise((resolve) => {
                        let done = false;
                        let timer = null;
                        const cleanup = () => {
                            if (done) return;
                            done = true;
                            if (timer != null) {
                                try { clearTimeout(timer); } catch { }
                            }
                            try { v.removeEventListener('loadedmetadata', onMeta); } catch { }
                            try { v.removeEventListener('error', onError); } catch { }
                            resolve();
                        };
                        const onMeta = () => cleanup();
                        const onError = () => cleanup();
                        timer = setTimeout(cleanup, 650);
                        v.addEventListener('loadedmetadata', onMeta, { once: true });
                        v.addEventListener('error', onError, { once: true });
                    });
                }

                try {
                    await v.play();
                } catch (err) {
                    try { console.warn('[camera] video play blocked', err); } catch { }
                    throw err;
                }

                try { syncOverlayToVideo?.(); } catch { }
                try {
                    requestAnimationFrame(() => {
                        try { syncOverlayToVideo?.(); } catch { }
                    });
                } catch { }
                try { window.scheduleSyncOverlay?.(); } catch { }

                return true;
            } catch (err) {
                const isLastAttempt = (videoCons === attempts[attempts.length - 1]);
                try {
                    const log = isLastAttempt ? (console.warn || console.log) : (console.debug || console.log);
                    if (typeof log === 'function') {
                        log.call(console, isLastAttempt ? '[camera] getUserMedia failed' : '[camera] getUserMedia retry', err);
                    }
                } catch { }
                if (stream?.getTracks) {
                    try { stream.getTracks().forEach((t) => { try { t.stop(); } catch { }; }); } catch { }
                }
                if (v.srcObject === stream) {
                    try { v.srcObject = null; } catch { }
                }
            }
        }
        return false;
    }

    async function restartCamera(label) {
        if (!navigator.mediaDevices?.getUserMedia) return false;
        // prefer facingMode path on iOS; deviceId after we learned labels
        try {
            stopStream();
            const facing = labelToFacing(label);
            const ok = await startWithConstraints({ facingMode: { exact: facing } });
            if (ok) return true;
        } catch { }
        try {
            stopStream();
            const ok = await startWithConstraints({ facingMode: labelToFacing(label) });
            if (ok) return true;
        } catch { }
        return false;
    }

    window.getCameraFacing = () => window.__CAM_FACING || readPref();
    window.setCameraFacing = async function (label) {
        const current = window.getCameraFacing();
        const target = (label === 'Front' || label === 'Back') ? label : (current === 'Back' ? 'Front' : 'Back');
        const ok = await restartCamera(target);
        if (ok) {
            window.__CAM_FACING = target;
            writePref(target);
            try {
                const hud = document.getElementById('hudCamFlip');
                if (hud) {
                    hud.dataset.facing = target;
                    const icon = formatHudCameraIcon(target);
                    hud.innerHTML = `<span class="icon" aria-hidden="true">${icon}</span>`;
                    const next = target === 'Back' ? 'front' : 'back';
                    hud.setAttribute('aria-label', `Switch to ${next} camera`);
                    hud.title = `Switch to ${next} camera`;
                }
            } catch { }
            try { window.dispatchEvent(new Event('camera:facing-changed')); } catch { }
            try { window.dispatchEvent(new CustomEvent('camera:changed', { detail: { label: target } })); } catch { }
        }
        return ok;
    };

    // Legacy helpers to support older callsites expecting the previous camera API.
    window.setPreferredFacing = async function (pref) {
        const facing = String(pref || '').toLowerCase();
        const label = (facing === 'user' || facing === 'front') ? 'Front' : 'Back';
        try {
            const ok = await window.setCameraFacing(label);
            return ok;
        } catch (err) {
            console.warn('[camera] setPreferredFacing failed', err);
            return false;
        }
    };

    window.flipCamera = async function () {
        try {
            const current = window.getCameraFacing();
            const target = current === 'Back' ? 'Front' : 'Back';
            return await window.setCameraFacing(target);
        } catch (err) {
            console.warn('[camera] flipCamera failed', err);
            return false;
        }
    };

    // Wrap startCamera so initial start honors preference
    (function wrapStartCamera() {
        const orig = window.startCamera;
        window.startCamera = async function () {
            const label = window.getCameraFacing();
            const ok = await restartCamera(label);
            if (!ok && typeof orig === 'function') return orig();
            return ok;
        };
    })();
})();

/* ------------------------ Session status badge ------------------------ */
export function setSessionStatus(text = '') {
    const root = ensureHudRoot();
    let badge = document.getElementById('sessionStatusBadge');
    if (!badge) {
        badge = document.createElement('div');
        badge.id = 'sessionStatusBadge';
        badge.className = 'hud-card';
        Object.assign(badge.style, {
            position: 'absolute', bottom: '90px', left: '50%', transform: 'translateX(-50%)',
            padding: '6px 10px', font: '600 12px system-ui', letterSpacing: '0.04em', pointerEvents: 'none'
        });
        root.appendChild(badge);
    }
    badge.textContent = text || 'SESSION IN PROGRESS…';
    badge.style.display = text === null ? 'none' : 'block';
}
window.setSessionStatus = setSessionStatus;

/* ------------------------ Summary table (UI) ------------------------ */
const SHOT_SUMMARY_TEXT = {
    modalTitle: 'Shot Summary',
    finalizing: 'Finalizing...',
    exportCsv: 'Export CSV',
    close: 'Close',
    pending: 'Pending',
    noValue: '--',
    buttons: { make: 'Make', miss: 'Miss', replay: 'Replay', ai: 'AI Review' }
};

function ensureShotTableStyles() {
    if (document.getElementById('shotTableStyles')) return;
    const css = document.createElement('style');
    css.id = 'shotTableStyles';
    css.textContent = `
    #fullShotModal .hud-table{ width:100%; border-collapse:collapse; table-layout:fixed; }
    #fullShotModal .hud-table col#cNum{ width:42px; } #fullShotModal .hud-table col#cCoach{ width:auto; }
    #fullShotModal .hud-table col#cClip{ width:90px; text-align:center; }
    #fullShotModal .hud-table thead th{ position:sticky; top:0; background:rgba(0,0,0,0.85); z-index:2; backdrop-filter:blur(2px); }
    #fullShotModal .hud-table th, #fullShotModal .hud-table td{ padding:8px 10px; vertical-align:top; text-align:left; border-bottom:1px solid rgba(255,255,255,.12); }
    #fullShotModal .hud-table tbody tr:nth-child(even) td{ background:rgba(255,255,255,.03); }
    #fullShotModal td.num, #fullShotModal td.score, #fullShotModal td.clip { text-align:center; }
    #fullShotModal td.coach{ white-space:normal; word-break:break-word; line-height:1.25; }
    #fullShotModal .hud-table #cScore { width:70px; }
  `;
    document.head.appendChild(css);
}

function deriveShotScore(shot) {
    if (!shot || typeof shot !== 'object') return null;
    const candidates = [
        shot.poseScore,
        shot.pose_score,
        shot.score,
        shot.weightedScore,
        shot.weighted_score,
        shot.arcmm?.summary?.poseScore,
        shot.arcmm?.poseScore,
        shot.pose?.score,
    ];
    for (const candidate of candidates) {
        const val = Number(candidate);
        if (Number.isFinite(val)) {
            const normalized = val <= 1 ? val * 100 : val;
            return normalized;
        }
    }
    return null;
}

function normalizeShotScore(shot) {
    if (!shot || typeof shot !== 'object') return shot;
    const val = deriveShotScore(shot);
    if (val != null) shot.poseScore = val;
    return shot;
}

function updateShotTableTotalsFromDOM(modal) {
    if (!modal) return;
    const tbody = modal.querySelector('tbody');
    if (!tbody) return;
    let total = 0;
    let count = 0;
    tbody.querySelectorAll('tr[data-shot-idx] .score').forEach((cell) => {
        const val = Number(cell.textContent);
        if (Number.isFinite(val)) {
            total += val;
            count += 1;
        }
    });
    let totalRow = tbody.querySelector('tr.totals');
    if (count === 0) {
        if (totalRow) totalRow.remove();
        return;
    }
    if (!totalRow) {
        totalRow = document.createElement('tr');
        totalRow.className = 'totals';
        totalRow.innerHTML = '<td class="num">Σ</td><td class="coach">Total Pose Score</td><td class="score"></td><td class="clip"></td>';
    } else {
        totalRow.remove();
    }
    const scoreCell = totalRow.querySelector('.score');
    if (scoreCell) scoreCell.textContent = Math.round(total);
    const reviewRow = tbody.querySelector('#sessionReviewRow');
    if (reviewRow) tbody.insertBefore(totalRow, reviewRow);
    else tbody.appendChild(totalRow);
}

function getClipHrefForShot(idx1Based, shot) {
    if (shot?.clip?.path) return shot.clip.path;
    try {
        const sid = window.__SESSION_ID;
        if (sid != null) return `/sessions/${sid}/clips/shot-${idx1Based}.webm`;
    } catch { }
    return null;
}

export function renderFullShotTable() {
    const list = (window.__shotList ||= []);
    list.forEach(normalizeShotScore);
    const root = ensureHudRoot();
    list.forEach(normalizeShotScore);
    const minimal = true; // skinny table only

    ensureShotTableStyles();
    let modal = document.getElementById('fullShotModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'fullShotModal';
        modal.className = 'hud-card';
        Object.assign(modal.style, {
            position: 'absolute', left: '50%', transform: 'translateX(-50%)', top: '12%',
            maxWidth: '74%', minWidth: '640px', zIndex: 10020, pointerEvents: 'auto',
            maxHeight: '78vh', overflowY: 'auto', WebkitOverflowScrolling: 'touch'
        });
        root.appendChild(modal);
    }

    modal.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
      <div style="font-weight:600; display:flex; align-items:center; gap:10px;">
        <span>Shot Summary (${list.length}/${formatCapDisplay(window.SESSION_SIZE)})</span>
        <span id="sessFinalBadge" style="display:none; padding:3px 8px; border-radius:10px; font:600 11px system-ui; background:#f59e0b; color:#111;">Finalizing…</span>
      </div>
      <div>
        <button id="closeFull" class="vc-btn">Close</button>
      </div>
    </div>
    <div id="sessReviewLine" style="display:none;opacity:.95;margin:4px 0 10px;line-height:1.35"></div>
    <table class="hud-table">
      <colgroup><col id="cNum"><col id="cCoach"><col id="cScore"><col id="cClip"></colgroup>
      <thead><tr><th>#</th><th>Coach Pose Assessment</th><th>Score</th><th>Clip</th></tr></thead>
      <tbody></tbody>
    </table>
  `;

    const tbody = modal.querySelector('tbody');
    tbody.textContent = '';
    list.forEach((shot, idx) => {
        const coachSource = shot && !shot.pending
            ? (shot.doach || shot.coach || shot.coachText || shot.feedback || shot.summary || shot.text || '')
            : '';
        const coachText = coachSource ? coachSource : SHOT_SUMMARY_TEXT.pending;

        const tr = document.createElement('tr');
        tr.setAttribute('data-shot-idx', idx + 1);
        tr.innerHTML = `<td class="num">${idx + 1}</td><td class="coach"></td><td class="score"></td><td class="clip"></td>`;
        tr.querySelector('.coach').textContent = coachText;

        const tdScore = tr.querySelector('.score');
        const scoreVal = deriveShotScore(shot);
        if (scoreVal != null) {
            const display = Math.round(scoreVal);
            tdScore.textContent = display;
            tdScore.dataset.value = display;
        } else {
            tdScore.textContent = '—';
        }

        const tdClip = tr.querySelector('.clip');
        const href = getClipHrefForShot(idx + 1, shot);
        if (href) {
            const a = document.createElement('a'); a.href = href; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'clip';
            tdClip.appendChild(a);
        } else {
            const status = shot?.clip?.status;
            tdClip.textContent = status === 'recording' ? 'recording…' : 'processing…';
        }
        tbody.appendChild(tr);
    });
    updateShotTableTotalsFromDOM(modal);

    modal.querySelector('#closeFull').onclick = () => { modal.style.display = 'none'; };
    modal.style.display = 'block';
    try { modal.style.zIndex = '10060'; } catch { }

    try {
        const detail = window.__SESSION_REVIEW_LAST;
        if (detail?.summary) {
            let row = modal.querySelector('#sessionReviewRow');
            if (!row) {
                row = document.createElement('tr');
                row.id = 'sessionReviewRow';
                row.innerHTML = '<td class="num">~</td><td class="coach session-review"></td><td class="score"></td><td class="clip"></td>';
                modal.querySelector('tbody')?.appendChild(row);
            }
            const cell = row.querySelector('.coach');
            if (cell) cell.textContent = detail.summary;
            const scoreCell = row.querySelector('.score');
            if (scoreCell) scoreCell.textContent = '—';
            row.style.display = 'table-row';
            row.dataset.visible = 'true';
        }
    } catch { }
    updateShotTableTotalsFromDOM(modal);

    return modal;
}
window.renderFullShotTable = renderFullShotTable;

/* ------------------- UI sink for finalized shots ------------------- */
function computeTotals(list) {
    const taken = list.length;
    const made = list.filter(s => s.made).length;
    const acc = taken ? (made / taken) * 100 : 0;
    return { taken, made, acc };
}

// Count finalized shots only
window.__finalizedShotIds ||= new Set();


// Record a finalized shot summary (UI only, no server)
window.recordShotSummary = function recordShotSummary(summary) {
    summary = normalizeShotScore(summary);
    const originalWeighted = Number.isFinite(summary?.weightedScore) ? summary.weightedScore : null;
    const debugKey = Number.isFinite(summary?.shotId) ? String(summary.shotId) : null;
    const debugSnapshot = debugKey && window.__POSE_SCORE_DEBUG?.get?.(debugKey);
    if (debugSnapshot) summary.__poseDebug = debugSnapshot;
    delete summary.trailWeightedScore;

    if (!summary?.poseSnapshot && Number.isFinite(summary?.shotId)) {
        let snapFromStore = null;
        if (window.__poseIsFreshFor?.(summary.shotId)) {
            try { snapFromStore = window.poseStore?.get(summary.shotId) || null; } catch { }
        }
        if (snapFromStore) summary.poseSnapshot = snapFromStore;
    }

    try {
        if (typeof window.computePoseScoreFallback === 'function' && summary?.poseSnapshot) {
            const baseWeighted = null;
            const weightedSource = summary?.weightedScoreSource && typeof summary.weightedScoreSource === 'string'
                ? summary.weightedScoreSource
                : null;
            const recomputed = window.computePoseScoreFallback(
                summary.poseSnapshot,
                baseWeighted,
                summary?.shotId ?? summary?.id ?? null,
                weightedSource ? { weightedSource } : {}
            );
            if (Number.isFinite(recomputed)) {
                summary.poseScore = recomputed;
                summary.poseScoreSource = summary.poseScoreSource || 'pose-recalc';
                summary.weightedScore = Math.max(0, Math.min(1, recomputed / 100));
                summary.weightedScoreSource = 'pose-recalc';
                const updatedDebug = debugKey && window.__POSE_SCORE_DEBUG?.get?.(debugKey);
                if (updatedDebug) summary.__poseDebug = updatedDebug;
                if (window.SCORE_DEBUG === true) {
                    console.log('[score:recordShotSummary:recomputed]', {
                        shotId: summary?.shotId ?? summary?.id ?? null,
                        poseScore: summary.poseScore,
                        poseScoreSource: summary.poseScoreSource,
                        weightedScore: summary.weightedScore,
                        weightedScoreSource: summary.weightedScoreSource,
                        baseWeighted,
                        weightedSource
                    });
                }
            }
        }
    } catch (err) {
        console.warn('[score:recordShotSummary] recompute failed', err);
    }

    if (!summary?.poseSnapshot && window.SCORE_DEBUG === true) {
        console.warn('[score:recordShotSummary] no snapshot; skip pose-recalc', { shotId: summary?.shotId ?? null });
    }

    if (!Number.isFinite(summary.poseScore)) {
        const fallbackScore = deriveShotScore(summary);
        if (Number.isFinite(fallbackScore)) {
            summary.poseScore = fallbackScore;
            summary.poseScoreSource = summary.poseScoreSource || 'fallback-derive';
        }
    }
    if (!Number.isFinite(summary.weightedScore) && Number.isFinite(summary.poseScore)) {
        summary.weightedScore = Math.max(0, Math.min(1, summary.poseScore / 100));
        summary.weightedScoreSource = summary.weightedScoreSource || 'fallback-derive';
    }
    if (!summary.__poseDebug && debugKey) {
        const fallbackDebug = window.__POSE_SCORE_DEBUG?.get?.(debugKey);
        if (fallbackDebug) summary.__poseDebug = fallbackDebug;
    }
    try {
        const derived = deriveShotScore(summary);
        const shotId = summary?.shotId ?? summary?.id ?? null;
        const idxDbg = summary?.__idx ?? null;
        const dbg = {
            shotId,
            idx: idxDbg,
            poseScore: summary?.poseScore ?? null,
            poseScoreSource: summary?.poseScoreSource ?? null,
            weightedScore: summary?.weightedScore ?? summary?.weightScore ?? null,
            weightedScoreSource: summary?.weightedScoreSource ?? null,
            derived,
            poseDebug: summary.__poseDebug || null
        };
        if (summary?.arcmm?.summary?.poseScore != null) dbg.arcmmPose = summary.arcmm.summary.poseScore;
        if (summary?.data?.weightedScore != null) dbg.dataWeighted = summary.data.weightedScore;
        console.log('[score:recordShotSummary]', { ...dbg, poseDebug: summary.__poseDebug || null }, summary);
    } catch (err) {
        console.warn('[score:recordShotSummary] failed to inspect summary', err);
    }
    // de-dupe by shotId first (but allow richer follow-up updates)
    const sid = Number(summary.shotId || 0);
    if (sid > 0) {
        if (!window.__finalizedShotIds.has(sid)) {
            window.__finalizedShotIds.add(sid);
        }
    }

    const list = (window.__shotList ||= []);

    // de-dupe minor repeats by value signature but allow richer follow-ups
    const key = `${sid || '?'}|${+!!summary.made}|${Math.round(summary.arcHeight || 0)}|${summary.entryAngle}|${summary.releaseAngle}`;
    if (window.__lastShotKey === key) {
        const idxForKey = Number.isFinite(sid) && sid > 0 ? sid - 1 : -1;
        const existingForKey = idxForKey >= 0 ? list[idxForKey] : null;
        const incomingScoreVal = deriveShotScore(summary);
        const existingScoreVal = deriveShotScore(existingForKey);
        const addsPoseSnapshot = !!summary?.poseSnapshot && !existingForKey?.poseSnapshot;
        const addsWeighted = Number.isFinite(summary?.weightedScore) && !Number.isFinite(existingForKey?.weightedScore);
        const addsPoseScore = Number.isFinite(incomingScoreVal) && (
            !Number.isFinite(existingScoreVal) ||
            Math.abs(incomingScoreVal - existingScoreVal) >= 0.5
        );
        const hasNewInfo = addsPoseSnapshot || addsWeighted || addsPoseScore;
        if (!hasNewInfo) {
            return;
        }
    }
    window.__lastShotKey = key;

    // carry coach and via
    if (!summary.doach && window.__lastCoachText) summary.doach = window.__lastCoachText;
    if (!summary.via) summary.via = window.__lastReleaseVia || summary.via || '';

    const mergeSummary = (target = {}) => {
        Object.assign(target, summary);
        target.pending = false;
        if (Number.isFinite(summary.poseScore)) target.poseScore = summary.poseScore;
        if (Number.isFinite(summary.weightedScore)) target.weightedScore = summary.weightedScore;
        if (summary.weightedScoreSource) target.weightedScoreSource = summary.weightedScoreSource;
        if (summary.poseScoreSource) target.poseScoreSource = summary.poseScoreSource;
        return target;
    };

    let idx = sid;
    if (Number.isFinite(idx) && idx > 0) {
        while (list.length < idx) list.push({ pending: true });
        list[idx - 1] = mergeSummary(list[idx - 1] || {});
    } else {
        const p = list.findIndex(s => s?.pending === true);
        if (p !== -1) {
            list[p] = mergeSummary(list[p] || {});
            idx = p + 1;
        } else {
            list.push(mergeSummary({}));
            idx = list.length;
        }
    }
    summary.__idx = idx;

    // If the skinny table is open, refresh the row
    const modal = document.getElementById('fullShotModal');
    if (modal) {
        const tbody = modal.querySelector('tbody');
        let tr = tbody.querySelector(`tr[data-shot-idx="${idx}"]`);
        if (!tr) {
            tr = document.createElement('tr');
            tr.setAttribute('data-shot-idx', idx);
            tr.innerHTML = `<td class="num">${idx}</td><td class="coach"></td><td class="score"></td><td class="clip"></td>`;
            tbody.appendChild(tr);
        }
        const merged = (Number.isFinite(idx) && idx > 0 && list[idx - 1]) ? list[idx - 1] : summary;
        const coach = String(merged.doach || '—');
        const tdCoach = tr.querySelector('.coach');
        if (tdCoach) { tdCoach.textContent = coach; tdCoach.title = coach; }

        const scoreCell = tr.querySelector('.score');
        if (scoreCell) {
            const scoreVal = deriveShotScore(merged);
            scoreCell.textContent = scoreVal != null ? Math.round(scoreVal) : '—';
            console.log('[score:table:update]', {
                shotIdx: idx,
                shotId: merged?.shotId ?? merged?.id ?? null,
                poseScore: merged?.poseScore ?? null,
                weightedScore: merged?.weightedScore ?? null,
                    displayed: scoreCell.textContent
            });
        }

        const tdClip = tr.querySelector('.clip');
        if (tdClip) {
            tdClip.textContent = '';
            const href = merged.clip?.path || (function () {
                try { const sid = window.__SESSION_ID; return sid != null ? `/api/sessions/${sid}/shot_video?index=${idx - 1}` : null; } catch { return null; }
            })();
            if (href) {
                const a = document.createElement('a'); a.href = href; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'clip';
                tdClip.appendChild(a);
            } else {
                tdClip.textContent = merged.clip?.status === 'recording' ? 'recording…' : 'processing…';
            }
        }
        updateShotTableTotalsFromDOM(modal);
    }

    // HUD counters — FINALIZED only
    try {
        const finalized = list.filter(s => s && s.pending === false).length;
        const start = (window.__sessionStart ||= Date.now());
        const elapsedSec = Math.floor((Date.now() - start) / 1000);
        updateSessionHUD?.({ taken: finalized, elapsedSec, ...computeTotals(list) });
    } catch { }
};

// capture the last release source for carry-forward
window.addEventListener('shot:release', (e) => { window.__lastReleaseVia = e?.detail?.via || ''; });



// Always reset playbackRate to 1× on summary (safari sanity)
window.addEventListener('shot:summary', () => {
    const v = document.getElementById('videoPlayer') || document.querySelector('video');
    if (v) { try { v.playbackRate = 1; } catch { } }
});

/* ------------------------ Session restart prompt ------------------------ */
const NEW_SESSION_PROMPT_DELAY_MS = 25000;
let __newSessionPromptTimer = null;
let __newSessionResetWatcher = null;
let __newSessionQuestionAsked = false;
let __newSessionFinalized = false;
let __newSessionAwaitingConfirm = false;

function setAwaitingNewSessionConfirm(state) {
    __newSessionAwaitingConfirm = !!state;
    try { window.__AWAITING_NEW_SESSION_CONFIRM = __newSessionAwaitingConfirm; } catch { }
}

function hideStartSessionOverlay() {
    try {
        const overlay = document.getElementById('startSessionOverlay');
        if (overlay) overlay.style.display = 'none';
    } catch { }
}

function showStartSessionOverlay() {
    try {
        const overlay = document.getElementById('startSessionOverlay');
        if (overlay) overlay.style.display = 'flex';
    } catch { }
}

function getPlayerDisplayNameForPrompt() {
    try {
        const nameLike = [
            window.__USER_NAME,
            window.__USER_DISPLAY_NAME,
            window.__PLAYER_NAME
        ].find((n) => typeof n === 'string' && n.trim());
        if (nameLike) return nameLike.trim();
    } catch { }
    try {
        const lsName = localStorage.getItem('firstname');
        if (typeof lsName === 'string' && lsName.trim()) return lsName.trim();
    } catch { }
    try {
        const raw = localStorage.getItem('doachProfile');
        if (raw) {
            const profile = JSON.parse(raw);
            const name = profile?.name || profile?.firstName;
            if (typeof name === 'string' && name.trim()) return name.trim();
        }
    } catch { }
    return 'Player';
}

function isElementVisible(el) {
    if (!el) return false;
    if (el.hidden === true) return false;
    const display = (el.style && el.style.display) || '';
    if (display && display.toLowerCase() === 'none') return false;
    return true;
}

function clearNewSessionPromptTimers() {
    if (__newSessionPromptTimer) {
        clearTimeout(__newSessionPromptTimer);
        __newSessionPromptTimer = null;
    }
    if (__newSessionResetWatcher) {
        clearInterval(__newSessionResetWatcher);
        __newSessionResetWatcher = null;
    }
}

// keep session in landscape mode
async function startLandscapeRecorder(videoEl, opts = {}) {
  const fps = opts.fps || 30;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent||'');
  const wantW = opts.width  || 1280;  // target output
  const wantH = opts.height || 720;

  // Offscreen canvas = our compositor
  const cvs = document.createElement('canvas');
  const ctx = cvs.getContext('2d', { alpha: false });

  function orientationAngle() {
    // iOS: screen.orientation is incomplete; window.orientation exists (deg)
    if (typeof screen?.orientation?.angle === 'number') return screen.orientation.angle;
    if (typeof window.orientation === 'number') return window.orientation; // 0, 90, -90
    // fallback guess: treat width>height as landscape
    return (innerWidth > innerHeight) ? 90 : 0;
  }

  function layoutForLandscape() {
    const angle = orientationAngle();
    const rot90 = angle === 90 || angle === -90;

    // We want the final file in landscape WxH
    cvs.width  = wantW;
    cvs.height = wantH;

    // Compute draw transform
    // We’ll scale to fill and rotate if stream arrives portrait
    const vW = videoEl.videoWidth  || 1080;
    const vH = videoEl.videoHeight || 1920;

    // Many iPhones report vW<vH even when physically landscape.
    const isPortraitStream = vH > vW;

    return { angle, rot90, isPortraitStream };
  }

  const { rot90, isPortraitStream } = layoutForLandscape();

  // Start the recorder from the canvas stream
  const stream = cvs.captureStream(fps);
  const chunks = [];
  const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9' });
  rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  const done = new Promise(resolve => rec.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' })));
  rec.start();

  let rafId = 0;
  function draw() {
    const w = cvs.width;
    const h = cvs.height;
    ctx.clearRect(0, 0, w, h);

    // Letterbox/pillarbox: scale to cover
    const vW = videoEl.videoWidth  || 1080;
    const vH = videoEl.videoHeight || 1920;
    const scaleCover = Math.max(w / vW, h / vH);

    ctx.save();

    // If the stream is portrait but we want landscape output, rotate
    // On iOS this is almost always true when the device is held landscape.
    if (isPortraitStream) {
      // rotate 90 degrees clockwise and draw centered
      ctx.translate(w, 0);
      ctx.rotate(Math.PI / 2);

      const dW = h / scaleCover; // because we rotated, canvas dims swap roles
      const dH = w / scaleCover;
      const x = (0 - (dW - vW) / 2);
      const y = (0 - (dH - vH) / 2);
      ctx.drawImage(videoEl, x, y, dW, dH);
    } else {
      // Already landscape: just draw scaled to cover
      const drawW = vW * scaleCover;
      const drawH = vH * scaleCover;
      const x = (w - drawW) / 2;
      const y = (h - drawH) / 2;
      ctx.drawImage(videoEl, x, y, drawW, drawH);
    }

    ctx.restore();
    rafId = requestAnimationFrame(draw);
  }

  // kick the compositor loop once metadata is ready
  if (videoEl.readyState >= 2) draw();
  else videoEl.addEventListener('loadedmetadata', draw, { once: true });

  // return a small controller
  return {
    stop: () => {
      cancelAnimationFrame(rafId);
      try { rec.stop(); } catch {}
      return done;
    },
    stream
  };
}

// Reset to start overlay state
function finalizeToStartOverlay() {
    if (__newSessionFinalized !== false) return;
    __newSessionFinalized = true;
    clearNewSessionPromptTimers();
    setAwaitingNewSessionConfirm(false);
    try {
        const blk = document.getElementById('endBlackout');
        if (blk) blk.style.display = 'none';
    } catch { }
    try {
        const modal = document.getElementById('fullShotModal');
        if (modal) modal.style.display = 'none';
    } catch { }
    try {
        const coach = document.getElementById('coachNotes');
        if (coach) {
            coach.style.display = 'none';
            coach.dataset.dismissed = 'false';
            if (coach.dataset.baseZ) coach.style.zIndex = coach.dataset.baseZ;
        }
    } catch { }
    try { setSessionStatus?.(null); } catch { }
    try { updateSessionHUD?.({ taken: 0, made: 0, accuracy: 0, elapsedSec: 0 }); } catch { }
    try { window.doachSession?.reset?.(); } catch { }
    try { clearInterval(window.__coachPoseInterval); window.__coachPoseInterval = null; } catch { }
    try { cancelAnimationFrame(window.__coachPaintRaf); window.__coachPaintRaf = null; } catch { }
    showStartSessionOverlay();
    __newSessionQuestionAsked = false;
    try { window.__SESSION_REVIEW_SPOKEN = false; } catch { }
    try { window.__NEW_SESSION_PROMPTED = false; } catch { }
}

function scheduleNewSessionResetWatcher() {
    if (__newSessionResetWatcher) return;
    __newSessionResetWatcher = setInterval(() => {
        if (!__newSessionQuestionAsked) return;
        const summaryVisible = isElementVisible(document.getElementById('fullShotModal'));
        const coachVisible = isElementVisible(document.getElementById('coachNotes'));
        if (!summaryVisible && !coachVisible) {
            finalizeToStartOverlay();
        }
    }, 650);
}

function ensureCoachFeedbackVisible() {
    try {
        const coach = document.getElementById('coachNotes');
        if (!coach) return;
        coach.style.display = 'block';
        coach.dataset.dismissed = 'false';
        if (!coach.dataset.baseZ) coach.dataset.baseZ = coach.style.zIndex || '10050';
        coach.style.zIndex = '10070';
    } catch { }
}

async function speakNewSessionInvite(line) {
    if (!line) return;
    if (typeof window.doachSpeak === 'function') {
        try {
            await window.doachSpeak(line);
            return;
        } catch { }
    }
}

function requestNewSessionPrompt(options = {}) {
    if (__newSessionPromptTimer || __newSessionQuestionAsked) return;
    const delayMs = Math.max(0, Number(options.delayMs ?? window.NEW_SESSION_PROMPT_DELAY_MS ?? NEW_SESSION_PROMPT_DELAY_MS) || 0);
    __newSessionFinalized = false;
    __newSessionQuestionAsked = false;

    __newSessionPromptTimer = setTimeout(async () => {
        __newSessionPromptTimer = null;
        let modal = null;
        try {
            modal = renderFullShotTable?.();
        } catch { }
        if (!modal) {
            try { modal = document.getElementById('fullShotModal'); }
            catch { modal = null; }
        }
        if (modal) {
            try { modal.dataset.pendingNewSession = ''; } catch { }
            try { modal.style.display = 'block'; } catch { }
            try { modal.style.zIndex = '10060'; } catch { }
        }

        ensureCoachFeedbackVisible();
        scheduleNewSessionResetWatcher();

        const name = getPlayerDisplayNameForPrompt();
        const line = `${name}, do you want to start a new session?`;
        try {
            await speakNewSessionInvite(line);
        } finally {
            __newSessionQuestionAsked = true;
            setAwaitingNewSessionConfirm(true);
        }
    }, delayMs);
}

if (typeof window.requestNewSessionPrompt !== 'function') {
    window.requestNewSessionPrompt = requestNewSessionPrompt;
}

function handleHudStartSession(event) {
    clearNewSessionPromptTimers();
    setAwaitingNewSessionConfirm(false);
    __newSessionQuestionAsked = false;
    __newSessionFinalized = false;
    try { window.__NEW_SESSION_PROMPTED = false; } catch { }
    try { window.__SESSION_REVIEW_SPOKEN = false; } catch { }
    try { window.__SESSION_REVIEW_LAST = null; } catch { }

    hideStartSessionOverlay();
    try {
        const blk = document.getElementById('endBlackout');
        if (blk) blk.style.display = 'none';
    } catch { }
    try {
        const modal = document.getElementById('fullShotModal');
        if (modal) modal.style.display = 'none';
    } catch { }
    try {
        const coach = document.getElementById('coachNotes');
        if (coach) {
            coach.style.display = 'none';
            coach.dataset.dismissed = 'false';
            if (coach.dataset.baseZ) coach.style.zIndex = coach.dataset.baseZ;
        }
    } catch { }

    try { window.__shotList = []; } catch { }
    try {
        if (window.__finalizedShotIds instanceof Set) window.__finalizedShotIds.clear();
        else window.__finalizedShotIds = new Set();
    } catch { }
    try {
        window.__shots = new Map();
        window.__SHOT_ID = 0;
        window.__sessionTotals = { attempts: 0, made: 0 };
    } catch { }
    try { updateSessionHUD?.({ taken: 0, made: 0, accuracy: 0, elapsedSec: 0 }); } catch { }

    try { window.__sessionStart = Date.now(); } catch { }
    try { window.__SESSION_ACTIVE = true; } catch { }
    try { window.__SESSION_SHOT_COUNT = 0; } catch { }
    try { window.__armCountdownActive = false; } catch { }

    try { setSessionStatus?.('SESSION IN PROGRESS…'); } catch { }
    try { hidePromptMessage(); } catch { }

    const hoopBox = (() => {
        try { return getLockedHoopBox?.(); } catch { return null; }
    })();
    const hoopWasLocked = (() => {
        try { return !!hoopBox || window.__hoopConfirmed === true || !!window.__lockedHoopBox; }
        catch { return !!hoopBox; }
    })();

    try { window.__shotTrackingArmed = false; } catch { }
    try { window.__armCountdownActive = false; } catch { }
    try { window.__RELEASE_LOCK_UNTIL = 0; window.__REL_LAST_FIRE_MS = 0; window.__releaseLatchUntil = 0; window.__LAST_FIRED_FRAME = null; } catch { }
    try { window.__SAMPLER_BLOCK_UNTIL = 0; } catch { }

    if (hoopWasLocked) {
        try { window.__hoopConfirmed = true; } catch { }
        try { window.resumeHoopTracking?.(); } catch { }
        setTimeout(() => {
            try {
                window.dispatchEvent(new CustomEvent('hoop:locked', { detail: { via: 'session-restart' } }));
            } catch { }
            try { window.scheduleArmWhenReady?.(0); } catch { }
        }, 0);
    } else {
        try { window.__hoopConfirmed = false; } catch { }
        if (window.__pickingHoop === true || window.__hoopPromptSpeakTimer || window.__hoopPromptRepeatTimer) {
            return;
        }
        setTimeout(() => {
            try { enableHoopPickOnce?.(); } catch { }
        }, 120);
    }
}

window.addEventListener('hud:start-session', handleHudStartSession);

/* -------------------- Center prompt + countdown -------------------- */
function showCenterPrompt(msg) {
    let el = document.getElementById('overlayPrompt');
    if (!el) {
        el = document.createElement('div');
        el.id = 'overlayPrompt';
        Object.assign(el.style, {
            position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)',
            background: 'rgba(0,0,0,0.72)', color: '#fff', padding: '20px 28px',
            borderRadius: '12px', font: '700 32px/1.15 system-ui, -apple-system, Segoe UI, Arial', zIndex: 10020,
            textShadow: '0 2px 8px rgba(0,0,0,0.45)', pointerEvents: 'none', display: 'none'
        });
        ensureHudRoot().appendChild(el);
    }
    el.textContent = msg;
    el.style.display = 'block';
    return el;
}
window.showCenterPrompt = showCenterPrompt;

function startShotTrackingCountdown(sec = 5) {
    if (window.__armCountdownActive) return; window.__armCountdownActive = true;
    try { window.__shotTrackingArmed = false; } catch { }
    try { window.dispatchEvent(new CustomEvent('hud:arm-countdown', { detail: { sec } })); } catch { }

    const root = ensureHudRoot();
    let box = document.getElementById('countdownOverlay');
    if (!box) {
        box = document.createElement('div');
        box.id = 'countdownOverlay';
        Object.assign(box.style, {
            position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)',
            background: 'rgba(0,0,0,0.45)', color: '#fff', padding: '24px 32px', borderRadius: '16px',
            font: '900 120px/1 system-ui, -apple-system, Segoe UI, Arial',
            textShadow: '0 6px 18px rgba(0,0,0,.55)', zIndex: 10040, pointerEvents: 'none', display: 'none'
        });
        root.appendChild(box);
    }
    const showNum = (t) => { box.style.display = 'block'; box.textContent = String(t); };
    const showGo = () => { box.style.display = 'block'; box.textContent = 'GO'; };
    const hide = () => { box.style.display = 'none'; };

    (async () => {
        try {
            for (let i = sec; i >= 1; i--) { showNum(i); await new Promise(r => setTimeout(r, 1000)); }
            showGo(); setTimeout(hide, 700);
            window.__shotTrackingArmed = true;
            try { window.dispatchEvent(new CustomEvent('hud:armed')); } catch { }
            try {
                if (typeof window.doachSpeak === 'function') {
                    await window.doachSpeak('Shoot when ready.');
                } else {
                    console.warn('[countdown] doachSpeak unavailable for cue');
                }
            } catch (err) {
                console.warn('[countdown] cue failed', err);
            }
            try { window.__releaseEventSent = false; } catch { }
        } finally {
            window.__armCountdownActive = false;
        }
    })();
}
if (typeof window.startShotTrackingCountdown !== 'function') window.startShotTrackingCountdown = startShotTrackingCountdown;

/* ----------------------- Callable finalizer only ----------------------- */
// This DOES NOT trigger automatically. Call from session_manager.js when ending.
async function autoEndSessionAndSummarize() {
    // Dim background a bit for readability
    try {
        const root = ensureHudRoot?.() || document.body;
        let blk = document.getElementById('endBlackout');
        if (!blk) {
            blk = document.createElement('div'); blk.id = 'endBlackout';
            Object.assign(blk.style, { position: 'absolute', inset: '0', background: '#000', opacity: '0.65', zIndex: 10040, pointerEvents: 'none' });
            root.appendChild(blk);
        } else {
            blk.style.display = 'block'; blk.style.opacity = '0.65'; blk.style.zIndex = '10040'; blk.style.pointerEvents = 'none';
        }
    } catch { }

    try {
        const modal = renderFullShotTable?.();
        if (modal) {
            modal.dataset.pendingNewSession = '1';
            modal.style.display = 'none';
        }
    } catch { }
    try { window.dispatchEvent(new CustomEvent('hud:end-session')); } catch { }

    setTimeout(() => {
        try {
            if (!window.__NEW_SESSION_PROMPTED) {
                requestNewSessionPrompt?.({ delayMs: 0 });
            }
        } catch { }
    }, Math.max(0, Number(window.NEW_SESSION_PROMPT_FALLBACK_MS || 26000)));
}
if (typeof window.autoEndSessionAndSummarize !== 'function') window.autoEndSessionAndSummarize = autoEndSessionAndSummarize;

/* --------------------------- Video HUD init --------------------------- */
export function initHUDForVideo(videoEl) {
    window.__videoEl = videoEl;
    ensureHudRoot();

    const anchor = document.querySelector('.session-container') || document.body;
    if (!window.__hudMo) {
        window.__hudMo = new MutationObserver(() => ensureHudRoot());
        window.__hudMo.observe(anchor, { childList: true, subtree: true });
    }

    const boot = () => {
        ensureHudRoot();
        mountSessionHUD();
        setSessionStatus('SESSION IN PROGRESS…');
        setOverlayInteractive(true);
        try { enableHoopPickOnce?.(); } catch { }
    };

    videoEl?.addEventListener('loadeddata', () => boot(), { once: true });
    if (videoEl?.readyState >= 2) boot();

    videoEl?.addEventListener('play', ensureHudRoot);
    videoEl?.addEventListener('pause', ensureHudRoot);

    // Elapsed time ticker
    if (window.__hudTimeTimer) clearInterval(window.__hudTimeTimer);
    window.__hudTimeTimer = setInterval(() => {
        try {
            const start = window.__sessionStart;
            if (!start) return;
            const list = (window.__shotList || window.shotLog || []);
            const taken = Array.isArray(list) ? list.length : 0;
            const elapsedSec = Math.floor((Date.now() - start) / 1000);
            updateSessionHUD({ taken, elapsedSec });
        } catch { }
    }, 1000);

    window.addEventListener('hud:end-session', () => {
        try { if (window.__hudTimeTimer) { clearInterval(window.__hudTimeTimer); window.__hudTimeTimer = null; } } catch { }
    });
}
window.initHUDForVideo = initHUDForVideo;

/* ------------------------- Hoop lock listeners ------------------------- */
window.addEventListener('hoop:locked', () => {
    window.__hoopConfirmed = true;
    try { window.__SESSION_ACTIVE = true; } catch { }
    hidePromptMessage();
    try { const v = document.getElementById('videoPlayer') || document.querySelector('video'); if (v) v.playbackRate = 1; } catch { }
    // If not armed and no countdown active, start countdown
    try {
        if (window.__shotTrackingArmed !== true && !window.__armCountdownActive) {
            window.__shotTrackingArmed = false;
            startShotTrackingCountdown?.(5);
        }
    } catch { }
});

/* ------------------- Update UI on every shot summary ------------------- */
window.addEventListener('shot:summary', () => {
    try {
        const list = window.__shotList || window.shotLog || [];
        const taken = Array.isArray(list) ? list.length : 0;
        const start = (window.__sessionStart ||= Date.now());
        const elapsedSec = Math.floor((Date.now() - start) / 1000);
        updateSessionHUD({ taken, elapsedSec });
    } catch { }
});

