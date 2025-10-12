// session_manager.js — single-owner: start/end + cap + server persistence.
// Owns: session start/stop, cap truth, POST /start and /shot
// Listens: hud:start-session, hud:end-session, shot:summary
// Emits:  hud:start-session (on explicit start), hud:end-session (on end)
// Does NOT: generate releases, record clips, enforce UI, open tables automatically.

import { speak, doachSpeak, primeCoachAudio, listenForEndSession } from '/static/js/coach_voice.js';

/* ------------------------ tiny helpers ------------------------ */
async function postJSON(url, body) {
    const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
        credentials: 'include'
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json().catch(() => ({}));
}

// Unified cap reader/writer (session_manager is the only writer)
function setSessionCap(n) {
    const cap = Number(n);
    const v = Number.isFinite(cap) && cap > 0 ? cap : undefined;
    try {
        if (v) {
            window.__SESSION_CAP = v;
            window.SESSION_SIZE = v;               // UI reads this to show N/Cap
            localStorage.setItem('doach.sessionCap', String(v));
        } else {
            window.__SESSION_CAP = undefined;
            window.SESSION_SIZE = undefined;
            localStorage.removeItem('doach.sessionCap');
        }
    } catch { }
}
function getSessionCap() {
    try {
        if (Number.isFinite(window.__SESSION_CAP)) return Number(window.__SESSION_CAP);
        if (Number.isFinite(window.SESSION_SIZE)) return Number(window.SESSION_SIZE);
        const ls = Number(localStorage.getItem('doach.sessionCap'));
        if (Number.isFinite(ls) && ls > 0) return ls;
    } catch { }
    return 10;
}
window.getSessionCap = getSessionCap; // let others read

/* ------------------------ internal shot accounting ------------------------ */
/**
 * Stop depending on UI arrays to count shots. We keep our own counter and
 * a dedupe set of processed summary keys.
 */
let __shotCounter = 0; // monotonic per session
const __processedSummaries = new Set(); // keys: `${shotId}|${frameEnd||''}|${frame||''}`

// Returns the next 1-based shot index owned by the session manager
function nextShotIndex() {
    __shotCounter = Number(__shotCounter || 0) + 1;
    window.__SESSION_SHOT_COUNT = __shotCounter;
    return __shotCounter;
}

// Best-effort finalized count for display; prefer our counter
function getFinalizedCount() {
    if (Number.isFinite(__shotCounter) && __shotCounter > 0) return __shotCounter;
    try {
        const recs = typeof window.getShotRecords === 'function' ? (window.getShotRecords() || []) : [];
        if (recs.length) return recs.length;
    } catch { }
    try {
        const list = window.__shotList || [];
        return list.filter(s => s && s.pending === false).length;
    } catch { }
    return Number(window.__SESSION_SHOT_COUNT || 0);
}

/* ------------------------ state ------------------------ */
let __wired = false;
let __sid = null;
let __ended = false;

// Display name for voice (fallbacks)
function getDisplayName() {
    try {
        return window.__USER_NAME || localStorage.getItem('firstname') || 'Player';
    } catch {
        return window.__USER_NAME || 'Player';
    }
}
const name = getDisplayName();

/* ------------------------ core actions ------------------------ */
async function startSession() {
    if (__sid) return __sid;      // already started
    __ended = false;
    __shotCounter = 0;
    __processedSummaries.clear();

    // choose cap once per session (URL > env > LS > default)
    let cap = (() => {
        try {
            const q = new URLSearchParams(location.search || '');
            const qp = Number(q.get('cap'));
            if (Number.isFinite(qp) && qp > 0) return qp;
        } catch { }
        return Number(window.DEMO_SESSION_CAP ?? window.__SESSION_CAP ?? window.SESSION_CAP);
    })();
    if (!Number.isFinite(cap) || cap <= 0) cap = 10;
    setSessionCap(cap);

    // mint session
    const res = await postJSON('/api/sessions/start', { device: navigator.userAgent });
    __sid = res?.id || null;
    window.__SESSION_ID = __sid || null;
    window.__SESSION_ACTIVE = true;
    window.__SESSION_SHOT_COUNT = 0;
    window.__sessionStart = Date.now();

    // nudge HUD
    try { window.mountSessionHUD?.(); window.setSessionStatus?.('SESSION IN PROGRESS'); } catch { }

    // tell everyone
    try { window.dispatchEvent(new CustomEvent('hud:start-session')); } catch { }

    // start session voice cue
    try {
        try { localStorage.setItem('doach_muted', 'false'); window.__coachMuted = false; } catch { }
        if (localStorage.getItem('doach_muted') !== 'true') {
            const hoopLocked = window.__hoopConfirmed === true;
            if (!hoopLocked) {
                const greeting = `Hi ${name}, let's get started. Tap the hoop area, then get into position to take your first shot.`;
                try { await primeCoachAudio?.(); } catch { }
                try {
                    if (typeof doachSpeak === 'function') {
                        await doachSpeak(greeting);
                    } else {
                        speak(greeting);
                    }
                } catch {
                    speak(greeting);
                }
            }
        }
    } catch { }

    return __sid;
}

async function persistShotFromSummary(detail) {
    console.debug('[persistShot] detail', detail);

    const shotId = Number(detail?.shotId);
    const releasePose = Number.isFinite(shotId)
        ? window.poseStore?.get(shotId) || null
        : null;

    let poseSnapshot = null;
    const poseSource = releasePose || detail?.poseSnapshot || null;
    if (poseSource && typeof poseSource === 'object') {
        try {
            poseSnapshot = typeof structuredClone === 'function'
                ? structuredClone(poseSource)
                : JSON.parse(JSON.stringify(poseSource));
        } catch {
            try { poseSnapshot = JSON.parse(JSON.stringify(poseSource)); }
            catch { poseSnapshot = null; }
        }
    }
    if (!poseSnapshot) {
        console.warn('[persistShot] missing canonical pose snapshot', { shotId });
        window.dispatchEvent(new CustomEvent('pose:capture-missing', { detail: { shotId, reason: 'no-pose-for-summary' } }));
    } else {
        detail.poseSnapshot = poseSnapshot;
        try { window.poseStore?.set(shotId, poseSnapshot, { source: 'persist', overwrite: false }); } catch { }
    }

    // Only persist if we have a session id; otherwise try to start one lazily
    if (!__sid) {
        try { await startSession(); } catch { }
    }
    if (!__sid) return;

    // Build a stable de-dupe key from what we actually have
    const sid = String(__sid || '');
    const shot = shotId;
    const fEnd = Number(detail?.frameEnd ?? detail?.endFrame ?? NaN);
    const fAny = Number(detail?.frame ?? NaN);
    const key = [sid, Number.isFinite(shot) ? shot : '', Number.isFinite(fEnd) ? fEnd : '', Number.isFinite(fAny) ? fAny : ''].join('|');

    if (__processedSummaries.has(key)) {
        // we've already persisted this summary; ignore
        return;
    }

    // Compute idx: prefer provided shotId; else allocate our own
    let idx = shotId;
    if (!Number.isFinite(idx) || idx <= 0) idx = nextShotIndex();

    const payload = {
        idx,
        t: Date.now(),
        made: Number.isFinite(detail?.made) ? Number(detail.made) : null,
        arcHeight: Number.isFinite(detail?.arcHeight) ? Number(detail.arcHeight) : null,
        entryAngle: Number.isFinite(detail?.entryAngle) ? Number(detail.entryAngle) : null,
        releaseAngle: Number.isFinite(detail?.releaseAngle) ? Number(detail.releaseAngle) : null,
        pose: poseSnapshot || null   // optional, server can ignore
    };

    try {
        await postJSON(`/api/sessions/${__sid}/shot`, payload);
        __processedSummaries.add(key);
        // bump our counter to at least idx
        if (idx > __shotCounter) __shotCounter = idx;
        window.__SESSION_SHOT_COUNT = __shotCounter;
        console.debug('[persistShot]', { idx, ok: true });
    } catch (err) {
        console.warn('[persistShot] failed', err, { idx, payload });
    }

    // Cap check owned here only
    try {
        const taken = getFinalizedCount();
        const cap = getSessionCap();
        if (Number.isFinite(cap) && taken >= cap) {
            // tiny grace so the last row/clip paths land before UI opens table
            setTimeout(() => { endSession('cap').catch(() => { }); }, Math.max(200, Number(window.CAP_SUMMARY_GRACE_MS || 600)));
        }
    } catch { }
}

async function endSession(reason = 'normal') {
    if (__ended) return;
    __ended = true;

    // single finalizer: dim + open table (UI-owned)
    try { await window.autoEndSessionAndSummarize?.(); } catch { }

    // flip flags
    try { window.__SESSION_ACTIVE = false; } catch { }

    // optional voice cue
    try {
        try { localStorage.setItem('doach_muted', 'false'); window.__coachMuted = false; } catch { }
        if (localStorage.getItem('doach_muted') !== 'true') {
            const line = 'Session ended.';
            try { await primeCoachAudio?.(); } catch { }
            try {
                if (typeof doachSpeak === 'function') {
                    await doachSpeak(line);
                } else {
                    speak(line);
                }
            } catch {
                speak(line);
            }
        }
    } catch { }

    return true;
}
function resetSessionForNewStart() {
    __sid = null;
    __ended = false;
    __shotCounter = 0;
    __processedSummaries.clear();
    try {
        window.__SESSION_ID = null;
        window.__SESSION_ACTIVE = false;
        window.__SESSION_SHOT_COUNT = 0;
        window.__sessionStart = null;
    } catch { }
    return true;
}



/* ------------------------ wiring ------------------------ */
(function wireOnce() {
    if (__wired) return; __wired = true;

    // Buttons are optional
    const btnStart = document.getElementById('btnStartSession');
    const btnEnd = document.getElementById('btnEndSession');
    if (btnStart) btnStart.addEventListener('click', () => { startSession().catch(() => { }); });
    if (btnEnd) btnEnd.addEventListener('click', () => { endSession().catch(() => { }); });

    // HUD bridge: treat these as canonical controls
    window.addEventListener('hud:start-session', () => { startSession().catch(() => { }); });
    window.addEventListener('hud:end-session', () => { endSession().catch(() => { }); });

    // Persist every finalized shot (deduped here), then check cap
    window.addEventListener('shot:summary', (e) => {
        const detail = e?.detail || {};
        // Never gate summaries on "armed"; capture is upstream.
        persistShotFromSummary(detail).catch(() => { });
    }, { passive: true });

    // Voice exit (optional; ignores if voice isn’t available)
    try {
        const stopListen = listenForEndSession?.('hey doach, end the session', async () => { await endSession('voice'); });
        window.__voiceEndHandle = stopListen;
    } catch { }
})();

/* ------------------------ exports (optional) ------------------------ */
window.doachSession = {
    start: startSession,
    end: endSession,
    reset: resetSessionForNewStart,
    getCap: getSessionCap,
    setCap: setSessionCap,
    get id() { return __sid; }
};

