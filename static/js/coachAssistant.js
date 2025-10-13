// /static/coachAssistant.js

// --- Coach voice state (persisted) ---
// Track if we already offered a new-session prompt after summary
try { if (typeof window.__NEW_SESSION_PROMPTED === 'undefined') window.__NEW_SESSION_PROMPTED = false; } catch { }

window.__coachMuted = JSON.parse(localStorage.getItem('doach_muted') || 'false');
// --- Coach bootstrap shim: never crash while the file is still loading ---
window.__COACH_READY = false;
window.__COACH_QUEUE = [];

// One voice, one line — let shot:summary own speaking
window.DOACH_ONLY_REALTIME = true;


window.generatePoseCoaching = window.generatePoseCoaching || function (pose) {
    // ultra-safe fallback, metrics-based but minimal, so we don't throw during early boot
    try {
        const p = pose || {};
        const msgs = [];
        if (Number(p.elbowExtDeg) && p.elbowExtDeg < 150) msgs.push('Extend the elbow through release.');
        if (p.fingersDown === false) msgs.push('Finish with fingers down.');
        if (Number(p.followThroughHoldFrames) < 2) msgs.push('Hold the follow-through for two counts.');
        if (!msgs.length) msgs.push('Eyes on the rim. Hold your finish.');
        return { line: msgs[0], bullets: msgs.slice(0, 2) };
    } catch {
        return { line: 'Eyes on the rim. Hold your finish.', bullets: [] };
    }
};

// internal processor the handler will call once ready
window.__onShotSummaryInternal = function (s) {
    const pose = s.pose || (window.__lastPoseSnapshot?.metrics) || {};
    const gate = s.gate || window.__lastPoseSnapshot?.gate || null;
    const advice = window.generatePoseCoaching(pose, { shotIdx: s.idx, gate });
    const line = advice.line && advice.line.trim() ? advice.line : 'Eyes on the rim. Hold your finish.';
    try { (window.doachSpeak || window.coachSpeak)?.(line); } catch { }
    try { window.recordShotFeedback?.({ idx: s.idx, text: line, pose }); } catch { }
    window.__lastCoachText = line;
};

window.__flushCoachQueue = function () {
    const q = window.__COACH_QUEUE || [];
    window.__COACH_QUEUE = [];
    for (const s of q) {
        try { window.__onShotSummaryInternal(s); } catch (e) { console.warn('[coach] flush error', e); }
    }
};

// Let summaries speak once session starts.
window.addEventListener('hud:start-session', () => {
    try { window.DOACH_ONLY_REALTIME = false; } catch { }
});


// HUD mute button -> toggle voice
window.addEventListener('hud:mute-toggle', (e) => {
    const muted = !!(e?.detail?.muted);
    window.__coachMuted = muted;
    try { localStorage.setItem('doach_muted', JSON.stringify(muted)); } catch { }

    // 🔁 Keep doachPrefs in sync so window.coachSpeak() won't skip
    try {
        const get = window.doachGetPrefs?.() || {};
        const next = { ...get, audioOn: !muted };
        window.doachSetPrefs?.(next);
    } catch { }
});

// Default: no extra intro from coachAssistant; session_manager owns greeting.
if (typeof window.PREF_COACH_INTRO === 'undefined') window.PREF_COACH_INTRO = false;

// --- Intro voice: trigger shared greeter once per ceremony, gated by PREF_COACH_INTRO ---
try {
    if (!window.__coachIntroWired) {
        window.__coachIntroWired = true;

        // Fire when countdown arms, but only if the user actually wants the intro
        window.addEventListener('hud:arm-countdown', () => {
            try {
                if (window.PREF_COACH_INTRO === true) {
                    // shared greeter handles unlock, mute, one-shot
                    window.coachGreetingOnce?.("Let's get started. Get into position and shoot when ready.");
                }
            } catch { }
        });

        // Reset greeting on end/reset so next ceremony can greet again if enabled
        ['hud:end-session', 'session:reset', 'hud:arm-reset'].forEach(evt => {
            window.addEventListener(evt, () => {
                try { window.resetCoachGreeting?.(); } catch { }
            });
        });
    }
} catch { }



// Default saved TTS preference to server voice if none is set (helps desktop first-run)
try {
    if (!localStorage.getItem('doach_tts')) {
        const v = (window.DOACH && window.DOACH.voice) || 'alloy';
        localStorage.setItem('doach_tts', JSON.stringify({ provider: 'server', voice: v }));
    }
} catch { }


// Also show a metrics overlay shortly after every shot:release (independent of coaching voice)
try {
    if (!window.__poseOverlayWired) {
        window.__poseOverlayWired = true;
        window.addEventListener('shot:release', () => {
            try { if (window.DOACH_RELEASE_TRACE === true) console.log('[coach:evt] shot:release'); } catch { }
            setTimeout(async () => {
                try {
                    let s = __getPoseSnapshot();
                    if (!s && typeof __samplePoseSnapshotNow === 'function') { try { s = await __samplePoseSnapshotNow(); } catch { } }
                    if (s) try { showPoseMetricsOverlay?.(s, Number(window.POSE_METRICS_MS || 1800)); } catch { }
                } catch { }
            }, 160);
        });
    }
} catch { }

// Remove any extra speaking on these; summary will talk.
try {
    if (!window.__coachReleaseWired) {
        window.__coachReleaseWired = true;

        window.addEventListener('shot:release', () => {
            try { __lastSpokenKey = null; window.__COACH_TIP_LAST_AT = 0; } catch { }
            // no speaking here; overlay only
        });

        // Fallback visual tip paths can stay, but must not speak
        window.addEventListener('hud:shot-taken', () => { try { __lastSpokenKey = null; } catch { } });
        // Do NOT call assessPoseAndSpeak on shot:summary anymore. Voice is handled above.
        // window.addEventListener('shot:summary', () => assessPoseAndSpeak('shot:summary')); // removed
    }
} catch { }


// --- De-dupe + formatter ---
let __lastSpokenKey = null;

// Prefer explicit shotId for numbering; fall back sanely
function preferShotNumber(s) {
    const n = Number(s?.shotId);
    if (Number.isFinite(n) && n > 0) return n;
    try {
        if (typeof getShotRecords === 'function') {
            const recs = getShotRecords();
            if (recs && recs.length && Number.isFinite(recs[recs.length - 1].idx)) {
                return recs[recs.length - 1].idx;
            }
        }
    } catch { }
    try {
        const list = window.__shotList || [];
        if (list.length) return list.length;
    } catch { }
    return Number(window.__SHOT_ID || 0);
}

/* === Pose cue engine v3: normalized scoring + variety (drop-in) ============== */
(function () {
    const VARIETY_WINDOW = 4;       // keep last N categories to avoid repeats
    const MIN_ALT_RATIO = 0.70;    // runner-up must be at least 70% of top severity

    function targets(g) {
        // sensible defaults; merged with your golden if present
        return Object.assign({
            stanceRatioIdeal: 1.20,     // ~shoulder width
            stanceRatioMin: 0.95,     // too narrow below this
            stanceRatioMax: 1.55,     // too wide above this
            feetAngleMax: 10,       // degrees; difference between toes
            feetToHoopMax: 22,       // degrees; base vs hoop vector
            armVertMax: 12,       // degrees from vertical
            elbowExtMin: 150,      // degrees of extension
            kneeFlexMin: 28,       // degrees (proxy from joint angle)
            headToHoopMax: 25,       // degrees
            frameOffsetMax: 90        // px from hoop center
        }, g || {});
    }

    function rankIssues(p, g) {
        const t = targets(g);
        const issues = [];
        const push = (cat, sev, msgs) => { if (Number.isFinite(sev) && sev > 0 && msgs?.length) issues.push({ cat, sev, msgs }); };

        // Power / knees
        const kneeSev = Number.isFinite(p.kneeFlex) ? Math.max(0, t.kneeFlexMin - p.kneeFlex) : 0;
        push('power', kneeSev, [
            'Add more knee bend to generate power.',
            'Load a bit more with the knees before you lift.',
            'Sink slightly more to build upward force.'
        ]);

        // Arm verticality (0 is vertical, lower is better)
        const armSev = Number.isFinite(p.armVerticalityDeg) ? Math.max(0, p.armVerticalityDeg - t.armVertMax) : 0;
        push('armVertical', armSev, [
            'Get the forearm more vertical on the finish.',
            'Reach up taller at release.',
            'Lift the forearm closer to vertical.'
        ]);

        // Elbow extension
        const elbowSev = Number.isFinite(p.elbowExtDeg) ? Math.max(0, t.elbowExtMin - p.elbowExtDeg) : 0;
        push('elbow', elbowSev, [
            'Finish with stronger arm extension.',
            'Straighten the elbow through the snap.',
            'Drive to full elbow extension.'
        ]);

        // Release height
        const relSev = (p.releaseAboveShoulder === false) ? 25 : 0;
        push('releaseHeight', relSev, [
            'Release above your shoulder line.',
            'Finish higher — above the shoulder.'
        ]);

        // Feet to rim
        const baseVsRimSev = Number.isFinite(p.feetToHoopDeg) ? Math.max(0, p.feetToHoopDeg - t.feetToHoopMax) : 0;
        push('feetToHoop', baseVsRimSev, [
            'Square your feet a touch more to the rim.',
            'Point your toes a bit more toward the basket.'
        ]);

        // Toe parallel
        const toeDiffSev = Number.isFinite(p.feetAngleDiff) ? Math.max(0, p.feetAngleDiff - t.feetAngleMax) : 0;
        push('feetParallel', toeDiffSev, [
            'Make your toes more parallel.',
            'Match toe angles left and right.'
        ]);

        // Stance width: use ratio if available
        if (Number.isFinite(p.stanceRatio)) {
            const narrowSev = (p.stanceRatio < t.stanceRatioMin) ? (t.stanceRatioMin - p.stanceRatio) * 100 : 0;
            const wideSev = (p.stanceRatio > t.stanceRatioMax) ? (p.stanceRatio - t.stanceRatioMax) * 100 : 0;
            push('stanceNarrow', narrowSev, [
                'Wider base — feet near shoulder width.',
                'Open your stance to shoulder-width.'
            ]);
            push('stanceWide', wideSev, [
                'Feet too wide — bring them in slightly.',
                'Narrow the stance a touch for balance.'
            ]);
        }

        // Head / gaze
        const headSev = Number.isFinite(p.headToHoopDeg) ? Math.max(0, p.headToHoopDeg - t.headToHoopMax) : 0;
        push('gaze', headSev, [
            'Keep eyes on the rim through the release.',
            'Lock your gaze on the rim.'
        ]);

        // Follow-through hold
        const holdSev = Number.isFinite(p.followThroughHoldFrames) ? Math.max(0, 2 - p.followThroughHoldFrames) * 10 : 0;
        push('followThrough', holdSev, [
            'Hold the follow-through for a beat.',
            'Freeze the wrist and fingers for a moment.'
        ]);

        // Centering
        const centerSev = Number.isFinite(p.frameOffsetX) ? Math.max(0, Math.abs(p.frameOffsetX) - t.frameOffsetMax) / 2 : 0;
        push('centering', centerSev, [
            'Center your body line with the rim before you lift.',
            'Square your chest to the rim before you shoot.'
        ]);

        // Wrist snap
        const wristSev = (p.fingersDown === false) ? 15 : 0;
        push('wrist', wristSev, [
            'Snap the wrist — fingers down on the finish.',
            'Finish with fingers down.'
        ]);

        issues.sort((a, b) => b.sev - a.sev);
        return issues;
    }

    function pickWithVariety(issues, shotId) {
        if (!issues.length) return null;
        const hist = (window.__coachCueHistory ||= []);
        const last = hist[hist.length - 1];

        let choice = issues[0]; // top by severity
        // If top repeats last and runner-up is strong, use runner-up
        if (last && choice.cat === last && issues[1] && (issues[1].sev >= issues[0].sev * MIN_ALT_RATIO)) {
            choice = issues[1];
        }
        // Avoid three-in-a-row same category if any alternative exists
        const last2 = hist.slice(-2);
        if (last2.length === 2 && last2[0] === last2[1] && last2[0] === choice.cat && issues[1]) {
            choice = issues[1];
        }

        hist.push(choice.cat);
        if (hist.length > VARIETY_WINDOW) window.__coachCueHistory = hist.slice(-VARIETY_WINDOW);

        // Deterministic variant selection by shotId (stable phrasing across re-emits)
        const msgs = choice.msgs || ['Good release — hold your follow-through.'];
        const idx = Number.isFinite(shotId) ? (shotId % msgs.length) : Math.floor(Math.random() * msgs.length);
        return { text: msgs[idx], cat: choice.cat, sev: choice.sev };
    }

    // Main single-line composer used by formatCoachLine()
    window.composePoseFeedback = function composePoseFeedbackV3(snap) {
        try {
            const g = window.DOACH_MEM?.get?.()?.golden || null;
            const issues = rankIssues(snap || {}, g);
            const shotId = Number(window.__CURRENT_SHOT_ID) || Number(window.__SHOT_ID) || 0;

            // First line with variety
            const first = pickWithVariety(issues, shotId);
            if (!first) return 'Good release — keep the rhythm.';

            // If a strong second exists from a different category, append it for richness
            const second = issues.find(i => i.cat !== first.cat && i.sev >= first.sev * 0.85);
            if (second) {
                const sMsgs = second.msgs || [];
                const sText = sMsgs.length ? sMsgs[(shotId + 1) % sMsgs.length] : '';
                if (sText) return `${first.text} ${sText}`;
            }
            return first.text;
        } catch {
            return 'Good release — hold your follow-through.';
        }
    };

    // Keep summarizePoseIssues aligned for table bullets (top 2–3)
    window.summarizePoseIssues = function summarizePoseIssuesV4(shot) {
        const p = shot?.poseSnapshot || {};
        const out = [];

        // Elbow extension
        if (Number.isFinite(p.elbowExtDeg) && p.elbowExtDeg < 150)
            out.push(`Elbow extension ${Math.round(p.elbowExtDeg)}° — finish longer.`);

        // Release height
        if ((p.releaseAboveShoulder === false) ||
            (Number.isFinite(p.shoulderToWristAngle) && p.shoulderToWristAngle < 52))
            out.push(`Release height low${Number.isFinite(p.shoulderToWristAngle) ? ` (${Math.round(p.shoulderToWristAngle)}°)` : ''}.`);

        // Wrist/fingers
        if (p.fingersDown === false ||
            (Number.isFinite(p.indexBelowWristPx) && p.indexBelowWristPx > -2))
            out.push(`Wrist snap — finish fingers down.`);

        // Follow-through hold
        if (Number.isFinite(p.followThroughHoldFrames) && p.followThroughHoldFrames < 2)
            out.push(`Hold the follow-through 2 counts.`);

        // Lift from legs
        if (Number.isFinite(p.kneeFlex) && p.kneeFlex < 28)
            out.push(`Add a bit more knee load.`);

        // Eyes and alignment
        if ((p.lookingAtHoop === false) || (Number.isFinite(p.headToHoopDeg) && p.headToHoopDeg > 25))
            out.push(`Eyes to rim earlier.`);

        // Torso lean guard
        if (Number.isFinite(p.torsoLeanAngle) && Math.abs(p.torsoLeanAngle) > 12)
            out.push(`Torso lean ${Math.round(p.torsoLeanAngle)}° — stay taller.`);

        // Foot notes are allowed but last
        if (Number.isFinite(p.feetToHoopDeg) && p.feetToHoopDeg > 22)
            out.push(`Square feet to rim (${Math.round(p.feetToHoopDeg)}° off).`);
        if (Number.isFinite(p.feetAngleDiff) && p.feetAngleDiff > 10)
            out.push(`Toes parallel (Δ ${Math.round(p.feetAngleDiff)}°).`);
        if (Number.isFinite(p.footStagger) && p.footStagger > 8)
            out.push(`Level base (front/back stagger ${Math.round(p.footStagger)}px).`);

        // Keep it punchy
        return out.filter(Boolean).slice(0, 3);
    };

})();


// === Session review: exactly-once per session id ===
(function () {
    if (window.__endSummaryOnceWired) return;
    window.__endSummaryOnceWired = true;

    function runOnce() {
        const sid = window.__SESSION_ID || 'no-session';
        if (window.__SESSION_REVIEW_FOR_SID === sid) return;   // already ran for this session
        window.__SESSION_REVIEW_FOR_SID = sid;
        try { summarizeSessionPose?.(); } catch { }
    }

    // run once, small settle delay for last shot
    window.addEventListener('hud:end-session', () => {
        setTimeout(runOnce, 900);
    }, { passive: true });

    // reset guard on new session
    window.addEventListener('hud:start-session', () => {
        window.__SESSION_REVIEW_FOR_SID = null;
    }, { passive: true });
})();





window.addEventListener('doach:session-review', (event) => {
    try {
        const summary = event?.detail?.summary;
        if (!summary) return;
        const table = document.querySelector('.hud-table tbody');
        if (!table) return;
        try { window.__SESSION_REVIEW_LAST = event.detail || { summary }; } catch { }
        let row = document.getElementById('sessionReviewRow');
        if (!row) {
            row = document.createElement('tr');
            row.id = 'sessionReviewRow';
            row.innerHTML = '<td class="num">~</td><td class="coach session-review"></td><td class="clip"></td>';
            table.appendChild(row);
        }
        const cell = row.querySelector('.coach');
        if (cell) {
            cell.textContent = summary;
            row.style.display = 'table-row';
            row.dataset.visible = 'true';
        }
    } catch (err) { console.warn('[session-review] inline render failed', err); }
});

window.addEventListener('hud:start-session', () => {
    try {
        const row = document.getElementById('sessionReviewRow');
        if (row) {
            row.style.display = 'none';
            row.dataset.visible = 'false';
            const cell = row.querySelector('.coach');
            if (cell) cell.textContent = '';
        }
        hideCoachNotes();
    } catch { }
    try { window.__NEW_SESSION_PROMPTED = false; } catch { }
    try { window.__SESSION_REVIEW_LAST = null; } catch { }
});


/* ===========================================================
   Pose Coaching V4 — broader variety, strict metric gating
   Overrides window.composePoseFeedback + summarizePoseIssues
   =========================================================== */
(function () {
    // Tunables
    const CFG = {
        // cooldown so we don’t spam the same category every shot
        categoryCooldownShots: 4,
        // foot-related notes can dominate; cap them within a sliding window
        maxFootNotesPer8: 1,
        // minimum “off-ness” before we even consider nagging
        thresholds: {
            elbowExtGood: 150,
            elbowExtLock: 165,
            armVertMax: 12,           // deg from vertical; greater is worse
            relAngleMin: 52,          // shoulder-to-wrist angle target
            followHoldMin: 2,         // frames
            kneeFlexMin: 28,          // deg bend
            headToHoopMax: 25,        // deg off rim
            torsoLeanMax: 12,         // deg
            feetToHoopMax: 22,        // deg
            toeParallelMax: 10,       // deg difference
            footStaggerMax: 6,        // px
            centerOffsetMax: 140,     // px greater tollerance for wide angle
            centerOffsetFrac: 0.08,   // of frame width
            footLiftMin: 2            // px
        },
        // severity weights (higher wins)
        weights: {
            centering: 0.45,
            feetToHoop: 0.55,
            stanceNarrow: 0.60,
            elbow: 1.00,
            armVertical: 0.95,
            releaseHeight: 0.90,
            wristSnap: 0.85,
            followHold: 0.80,
            kneeFlex: 0.80,
            headGaze: 0.75,
            torsoLean: 0.70,
            feetSquare: 0.60,
            toesParallel: 0.55,
            footStagger: 0.50,
            footLift: 0.45
        }
    };

    // === Positive reinforcement (light, gated) ===========================
    try {
        if (typeof window.PREF_COACH_POSITIVE_RATE === 'undefined') window.PREF_COACH_POSITIVE_RATE = 0.35; // 35% chance when positives exist
        if (typeof window.PREF_COACH_POSITIVE_MIN_GAP === 'undefined') window.PREF_COACH_POSITIVE_MIN_GAP = 2; // min shots between praise
    } catch { }

    const __posHist = { lastShotId: -999, lastUsedAtShot: -999, lastCat: null };

    // Return an array of {cat, text} positives that are actually true
    function buildPositives(p) {
        const yes = [];
        const T = CFG.thresholds;

        // Arm verticality good
        if (Number.isFinite(p.armVerticalityDeg) && p.armVerticalityDeg <= T.armVertMax)
            yes.push({ cat: 'armVertical', text: 'Nice tall finish — forearm vertical.' });

        // Elbow extension good
        if (Number.isFinite(p.elbowExtDeg) && p.elbowExtDeg >= T.elbowExtLock)
            yes.push({ cat: 'elbow', text: 'Great elbow extension on the snap.' });

        // Release above shoulder
        if (p.releaseAboveShoulder === true)
            yes.push({ cat: 'releaseHeight', text: 'Good high release above the shoulder.' });

        // Feet square to hoop
        if (Number.isFinite(p.feetToHoopDeg) && p.feetToHoopDeg <= T.feetToHoopMax)
            yes.push({ cat: 'feetToHoop', text: 'Feet were nicely squared to the rim.' });

        // Toe angles parallel
        if (Number.isFinite(p.feetAngleDiff) && p.feetAngleDiff <= T.toeParallelMax)
            yes.push({ cat: 'toesParallel', text: 'Toe angles matched well — stable base.' });

        // Follow-through hold
        if (Number.isFinite(p.followThroughHoldFrames) && p.followThroughHoldFrames >= T.followHoldMin)
            yes.push({ cat: 'followThrough', text: 'Good follow-through hold.' });

        // Head/gaze on rim
        if ((typeof p.lookingAtHoop === 'boolean' && p.lookingAtHoop === true) ||
            (Number.isFinite(p.headToHoopDeg) && p.headToHoopDeg <= T.headToHoopMax))
            yes.push({ cat: 'headGaze', text: 'Eyes stayed on the rim — love it.' });

        // Centering close to target
        if (Number.isFinite(p.frameOffsetX)) {
            const vw = document.getElementById('videoPlayer')?.videoWidth || 0;
            const adaptiveMax = Math.max(T.centerOffsetMax, Math.round(vw * (T.centerOffsetFrac || 0.08)));
            if (Math.abs(p.frameOffsetX) <= adaptiveMax)
                yes.push({ cat: 'centering', text: 'Centered well before the lift.' });
        }

        return yes;
    }

    // Decide if we should emit a positive line on this shot
    function shouldPraise(shotId) {
        const n = Number(shotId) || 0;
        const gap = (n - __posHist.lastUsedAtShot);
        if (gap <= Number(window.PREF_COACH_POSITIVE_MIN_GAP || 2)) return false;  // cooldown
        // Light probability gate to avoid sounding scripted
        return Math.random() < Number(window.PREF_COACH_POSITIVE_RATE || 0.35);
    }



    // Small session memory for variety rules
    const hist = {
        lastCats: [],           // recent categories
        lastTexts: [],          // recent exact lines
        footFlags: []           // recent “foot” booleans for window cap
    };
    function pushHist(cat, text, isFoot) {
        hist.lastCats.push(cat); if (hist.lastCats.length > 8) hist.lastCats.shift();
        hist.lastTexts.push(text); if (hist.lastTexts.length > 12) hist.lastTexts.shift();
        hist.footFlags.push(!!isFoot); if (hist.footFlags.length > 8) hist.footFlags.shift();
    }
    function recentFootCount() { return hist.footFlags.reduce((a, b) => a + (b ? 1 : 0), 0); }
    function catOnCooldown(cat) {
        const cd = CFG.categoryCooldownShots;
        if (!cd) return false;
        const recent = hist.lastCats.slice(-cd);
        return recent.includes(cat);
    }
    const isFootCat = (c) => c === 'feetSquare' || c === 'toesParallel' || c === 'footStagger';

    // --- Personalization knobs (use player's name) ---
    try {
        if (typeof window.PREF_COACH_NAME_PERSONAL === 'undefined') window.PREF_COACH_NAME_PERSONAL = true;
        if (typeof window.COACH_NAME_PROB === 'undefined') window.COACH_NAME_PROB = 0.35;  // ~35% of the time
        if (typeof window.COACH_NAME_COOLDOWN === 'undefined') window.COACH_NAME_COOLDOWN = 2; // min shots between name drops
    } catch { }

    (function () {
        let __nameShots = [];  // recent shotIds where we used the name

        function getDisplayName() {
            try { return window.__USER_NAME || localStorage.getItem('firstname') || 'Player'; }
            catch { return window.__USER_NAME || 'Player'; }
        }

        function shouldPersonalize(shotId) {
            if (!window.PREF_COACH_NAME_PERSONAL) return false;
            const name = getDisplayName();
            if (!name || name.toLowerCase() === 'player' || name.length < 2) return false;

            // cooldown
            const last = __nameShots.at?.(-1);
            if (Number.isFinite(last) && Number.isFinite(shotId) && (shotId - last) <= window.COACH_NAME_COOLDOWN) return false;

            // chance gate (stable-ish per shot)
            const r = Math.abs(Math.sin((Number(shotId) || 0) * 9301 + 49297)) % 1;
            return r < Number(window.COACH_NAME_PROB || 0.3);
        }

        function insertName(text, shotId) {
            const name = getDisplayName();
            if (!shouldPersonalize(shotId)) return text;

            // Don’t double-insert
            const lower = String(text).toLowerCase();
            if (lower.startsWith((name + ',').toLowerCase())) return text;

            // Prefer after "Shot X,"
            const m = /^(\s*Shot\s+\d+,\s*)(.*)$/i.exec(text);
            let out;
            if (m) out = `${m[1]}${name}, ${m[2]}`;
            else out = `${name}, ${text}`;

            // remember use
            if (Number.isFinite(shotId)) {
                __nameShots.push(shotId);
                if (__nameShots.length > 10) __nameShots = __nameShots.slice(-10);
            }
            return out;
        }

        // expose
        window.__coachMaybePersonalize = insertName;
    })();


    // Phrase helpers
    const rnd = (n) => (Math.random() * n) | 0;
    const pick = (arr, keySeed = 0) => arr[(keySeed + rnd(arr.length)) % arr.length];
    const fmt = (n, p = 0) => Number.isFinite(n) ? Number(n).toFixed(p) : '-';

    // Build issue list with severity
    function scoreIssues(p) {
        const T = CFG.thresholds, W = CFG.weights;
        const issues = [];
        const add = (cat, sev, lines, params = {}) => {
            if (sev <= 0) return;
            if (!Array.isArray(lines) || !lines.length) return;
            const weight = W[cat] || 1;
            issues.push({ cat, sev: sev * weight, lines, params, foot: isFootCat(cat) });
        };

        // Elbow extension
        if (Number.isFinite(p.elbowExtDeg)) {
            const miss = Math.max(0, T.elbowExtGood - p.elbowExtDeg);
            add('elbow', miss, [
                `Finish with stronger arm extension (now ~${fmt(p.elbowExtDeg, 0)}°).`,
                `Straighten the elbow through the snap; aim ≥ ${T.elbowExtGood}°.`,
                `Drive the elbow long on finish (currently ${fmt(p.elbowExtDeg, 0)}°).`
            ], { val: p.elbowExtDeg });
        }

        // Arm verticality
        if (Number.isFinite(p.armVerticalityDeg)) {
            const over = Math.max(0, p.armVerticalityDeg - T.armVertMax);
            add('armVertical', over, [
                `Get the forearm more vertical at release (${fmt(p.armVerticalityDeg, 0)}° off).`,
                `Reach up for a taller finish; trim ${fmt(over, 0)}° of tilt.`,
                `Lift the forearm closer to vertical (target ≤ ${T.armVertMax}°).`
            ], { val: p.armVerticalityDeg });
        }

        // Release height
        const sw = Number(p.shoulderToWristAngle);
        if (p.releaseAboveShoulder === false || (Number.isFinite(sw) && sw < T.relAngleMin)) {
            const sev = Number.isFinite(sw) ? Math.max(0, T.relAngleMin - sw) : 12;
            add('releaseHeight', sev, [
                `Release above the shoulder; lift to ≥ ${T.relAngleMin}° (now ${fmt(sw, 0)}°).`,
                `Get the wrist higher at release; finish above the shoulder.`,
                `Raise the release point before the snap.`
            ], { val: sw });
        }

        // Wrist snap / fingers
        if (p.fingersDown === false) {
            add('wristSnap', 12, [
                `Snap the wrist so fingers point down on the finish.`,
                `Finish with fingers down; let the wrist roll over.`,
                `Get the index under the wrist at finish.`
            ]);
        } else if (Number.isFinite(p.indexBelowWristPx) && p.indexBelowWristPx <= 0) {
            add('wristSnap', 8, [
                `Stronger wrist snap — finish fingers down.`,
                `Emphasize the wrist roll at the end.`,
                `Let the ball roll off the index; fingers down.`
            ]);
        }

        // Follow-through hold
        if (Number.isFinite(p.followThroughHoldFrames) && p.followThroughHoldFrames < T.followHoldMin) {
            add('followHold', (T.followHoldMin - p.followThroughHoldFrames) * 6, [
                `Hold the follow-through for a full beat.`,
                `Freeze the finish for 2 counts; don’t drop early.`,
                `Keep the arm up; hold your pose briefly.`
            ], { val: p.followThroughHoldFrames });
        }

        // Lower body power
        if (Number.isFinite(p.kneeFlex) && p.kneeFlex < T.kneeFlexMin) {
            add('kneeFlex', (T.kneeFlexMin - p.kneeFlex), [
                `Add more knee bend to generate power (now ~${fmt(p.kneeFlex, 0)}°).`,
                `Load the knees a touch more, then rise.`,
                `Small extra knee load will help the lift.`
            ], { val: p.kneeFlex });
        }

        // Head/gaze
        if ((p.lookingAtHoop === false) || (Number.isFinite(p.headToHoopDeg) && p.headToHoopDeg > T.headToHoopMax)) {
            const sev = Number.isFinite(p.headToHoopDeg) ? (p.headToHoopDeg - T.headToHoopMax) : 10;
            add('headGaze', sev, [
                `Eyes on the rim before you lift.`,
                `Pick the target earlier — eyes to the rim.`,
                `Lock the rim with your eyes, then lift.`
            ], { val: p.headToHoopDeg });
        }

        // Torso lean
        if (Number.isFinite(p.torsoLeanAngle) && Math.abs(p.torsoLeanAngle) > T.torsoLeanMax) {
            add('torsoLean', Math.abs(p.torsoLeanAngle) - T.torsoLeanMax, [
                `Stay taller through your lift (torso lean ${fmt(p.torsoLeanAngle, 0)}°).`,
                `Keep your torso stacked over your hips.`,
                `Reduce the forward lean at finish.`
            ], { val: p.torsoLeanAngle });
        }

        // Centering vs hoop (adaptive + gated by gaze/feet so we don't overfire)
        if (Number.isFinite(p.frameOffsetX)) {
            const vw = document.getElementById('videoPlayer')?.videoWidth || 0;
            const adaptiveMax = Math.max(T.centerOffsetMax, Math.round(vw * (T.centerOffsetFrac || 0.08)));
            const off = Math.max(0, Math.abs(p.frameOffsetX) - adaptiveMax);
            // Only nag centering when eyes/feet aren't already the bigger culprit
            const gazeOk = !Number.isFinite(p.headToHoopDeg) || p.headToHoopDeg <= (T.headToHoopMax + 6);
            const feetOk = !Number.isFinite(p.feetToHoopDeg) || p.feetToHoopDeg <= (T.feetToHoopMax + 8);
            if (off > 0 && gazeOk && feetOk) {
                // gentler severity to avoid topping the chart constantly
                add('centering', off / 3, [
                    'Center your body line with the rim before you lift.',
                    'Square your chest to the rim before you shoot.'
                ], { val: p.frameOffsetX, adaptiveMax });
            }
        }

        // Feet to rim
        if (Number.isFinite(p.feetToHoopDeg) && p.feetToHoopDeg > T.feetToHoopMax) {
            add('feetSquare', p.feetToHoopDeg - T.feetToHoopMax, [
                `Square your feet a touch more to the rim (${fmt(p.feetToHoopDeg, 0)}° off).`,
                `Point your toes a bit more toward the basket.`,
                `Reduce the turnout toward the sidelines.`
            ], { val: p.feetToHoopDeg });
        }

        // Toe parallel
        if (Number.isFinite(p.feetAngleDiff) && p.feetAngleDiff > T.toeParallelMax) {
            add('toesParallel', p.feetAngleDiff - T.toeParallelMax, [
                `Make your toes more parallel (Δ ${fmt(p.feetAngleDiff, 0)}°).`,
                `Match toe angles left and right.`,
                `Line up the toes; avoid splaying.`
            ], { val: p.feetAngleDiff });
        }

        // Foot stagger
        if (Number.isFinite(p.footStagger) && p.footStagger > T.footStaggerMax) {
            add('footStagger', p.footStagger - T.footStaggerMax, [
                `Level your base — reduce front/back foot stagger (${fmt(p.footStagger, 0)}px).`,
                `Even out your stance front-to-back.`,
                `Bring the front foot back to level the base.`
            ], { val: p.footStagger });
        }

        // Foot pop
        if (Number.isFinite(p.footLiftPx) && p.footLiftPx < T.footLiftMin) {
            add('footLift', (T.footLiftMin - p.footLiftPx), [
                `Add a little upward pop as you snap.`,
                `Extend through the ankles for a light lift.`,
                `Let the heels float slightly on the finish.`
            ], { val: p.footLiftPx });
        }

        // Sort by severity (desc)
        issues.sort((a, b) => b.sev - a.sev);
        return issues;
    }

    // Selection logic with variety + foot bias brake
    function selectIssues(issues) {
        if (!issues.length) return [];
        // deprioritize feet if we’ve already nagged too much recently
        const footCapHit = recentFootCount() >= CFG.maxFootNotesPer8;
        const centerSeen = (hist.lastCats || []).slice(-8).filter(c => c === 'centering').length;
        const centerCapHit = centerSeen >= (CFG.maxCenterNotesPer8 || 1);

        const pool = issues
            .filter(i => !catOnCooldown(i.cat))
            .filter(i => !footCapHit || !i.foot || i.sev >= 1.5 * issues[0].sev)
            // block centering unless it's decisively the top problem
            .filter(i => !(centerCapHit && i.cat === 'centering' && i.sev < 1.35 * issues[0].sev));

        const list = pool.length ? pool : issues; // fallback if everything cooled

        const first = list[0];
        // second from different category with high enough severity
        const second = list.find(i => i.cat !== first.cat && i.sev >= first.sev * 0.85);

        return second ? [first, second] : [first];
    }

    // Render a single cue line
    function renderCue(issue, shotSeed = 0) {
        const lines = issue.lines || ['Good release — hold your follow-through.'];
        // avoid verbatim repeats
        let pickIdx = (shotSeed + lines.length) % lines.length;
        let text = lines[pickIdx];
        for (let k = 0; k < lines.length && hist.lastTexts.includes(text); k++) {
            pickIdx = (pickIdx + 1) % lines.length;
            text = lines[pickIdx];
        }
        return text;
    }

    // Public replacement: one or two short cues, distinct categories
    window.composePoseFeedback = function composePoseFeedbackV4(snap) {
        try {
            const issues = scoreIssues(snap || {});
            const shotId = Number(window.__CURRENT_SHOT_ID || window.__SHOT_ID || 0);

            // 1) Check for valid positives
            const positives = buildPositives(snap || {});
            const canPraise = positives.length > 0 && shouldPraise(shotId);

            if (canPraise) {
                // avoid repeating the same praise category back-to-back
                const pick = positives.find(p => p.cat !== __posHist.lastCat) || positives[0];
                __posHist.lastCat = pick.cat;
                __posHist.lastUsedAtShot = shotId || (__posHist.lastUsedAtShot + 1);
                return pick.text;
            }

            // 2) Otherwise do normal corrective coaching with variety
            if (!issues.length) return 'Good release — keep the rhythm.';
            const [first, second] = (function selectIssues(issues) {
                // original selectIssues logic (unchanged)
                const footCapHit = recentFootCount() >= CFG.maxFootNotesPer8;
                const centerSeen = (hist.lastCats || []).slice(-8).filter(c => c === 'centering').length;
                const centerCapHit = centerSeen >= (CFG.maxCenterNotesPer8 || 1);

                const pool = issues
                    .filter(i => !catOnCooldown(i.cat))
                    .filter(i => !footCapHit || !i.foot || i.sev >= 1.5 * issues[0].sev)
                    .filter(i => !(centerCapHit && i.cat === 'centering' && i.sev < 1.35 * issues[0].sev));
                const list = pool.length ? pool : issues;
                const f = list[0];
                const s = list.find(i => i.cat !== f.cat && i.sev >= f.sev * 0.85);
                return s ? [f, s] : [f];
            })(issues);

            // seed by shot for stable variety
            const shotSeed = shotId;
            const line1 = (function renderCue(issue, seed) {
                const lines = issue.lines || ['Good release — hold your follow-through.'];
                let i = (seed + lines.length) % lines.length;
                let t = lines[i];
                for (let k = 0; k < lines.length && hist.lastTexts.includes(t); k++) { i = (i + 1) % lines.length; t = lines[i]; }
                return t;
            })(first, shotSeed);

            const line2 = second ? (function renderCue(issue, seed) {
                const lines = issue.lines || []; if (!lines.length) return '';
                let i = (seed + lines.length) % lines.length; let t = lines[i];
                for (let k = 0; k < lines.length && hist.lastTexts.includes(t); k++) { i = (i + 1) % lines.length; t = lines[i]; }
                return t;
            })(second, shotSeed + 1) : '';

            const finalText = [line1, line2].filter(Boolean).join(' ');
            pushHist(first.cat, line1, first.foot);
            if (second) pushHist(second.cat, line2, second.foot);
            return finalText;
        } catch {
            return 'Eyes on the rim. Hold the finish.';
        }
    };


    // Table bullets: top 2–3 different categories (no duplicates)
    window.summarizePoseIssues = function summarizePoseIssuesV4(shot) {
        try {
            const p = (shot && (shot.poseSnapshot || shot)) || {};
            const issues = scoreIssues(p).filter(i => i.sev >= 5);
            const uniq = [];
            for (const it of issues) {
                if (uniq.find(u => u.cat === it.cat)) continue;
                uniq.push(it);
                if (uniq.length >= 3) break;
            }
            return uniq.map(u => u.lines[0]);
        } catch { return []; }
    };
})();


// after installing the real engine:
window.__COACH_READY = true;
try { window.__flushCoachQueue?.(); } catch { }




// === SNAPSHOT V2: force replace extractor + rescue bad summaries =================

// 1) Force the new extractor (do NOT early-return if an old one exists)
window.extractPoseSnapshot = function extractPoseSnapshot_v2(keypoints, hoopBox) {
    try {
        // ---------- helpers ----------
        const kp = Array.isArray(keypoints) ? keypoints : (window.playerState?.keypoints || []);
        if (!Array.isArray(kp) || kp.length < 33) return null;

        const k = (i) => (kp[i] && Number.isFinite(kp[i].x) && Number.isFinite(kp[i].y)) ? kp[i] : null;
        const v = (a, b) => ({ x: (b.x - a.x), y: (b.y - a.y) });
        const mag = (u) => Math.hypot(u.x, u.y);
        const dist = (a, b) => (a && b) ? Math.hypot(a.x - b.x, a.y - b.y) : null;
        const mid = (a, b) => (a && b) ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : (a || b || null);
        const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
        const rnd = (n, p = 0) => Number.isFinite(n) ? Number(n.toFixed(p)) : null;

        const angleFromHorizontal = (u) => {
            if (!u || !Number.isFinite(u.x) || !Number.isFinite(u.y)) return null;
            return Math.abs(Math.atan2(u.y, u.x) * 180 / Math.PI);  // 0 = horizontal, 90 = vertical
        };
        const angleFromVertical = (u) => {
            if (!u || !Number.isFinite(u.x) || !Number.isFinite(u.y)) return null;
            const m = mag(u) || 1e-6;
            // vertical-up unit is (0,-1) in screen coords
            const dot = (u.x * 0) + (u.y * -1);
            const t = clamp(dot / m, -1, 1);
            return Math.abs(Math.acos(t) * 180 / Math.PI);          // 0 = vertical up, 90 = horizontal
        };
        const angleAt = (a, b, c) => {
            if (!(a && b && c)) return null;
            const u = v(b, a), w = v(b, c);
            const m = (mag(u) * mag(w)) || 1e-6;
            const t = clamp((u.x * w.x + u.y * w.y) / m, -1, 1);
            return Math.acos(t) * 180 / Math.PI;                     // 0..180 interior
        };

        // ---------- keypoints ----------
        const L = {
            NOSE: 0, L_SHO: 11, R_SHO: 12, L_ELB: 13, R_ELB: 14, L_WRI: 15, R_WRI: 16,
            L_HIP: 23, R_HIP: 24, L_KNE: 25, R_KNE: 26, L_ANK: 27, R_ANK: 28,
            L_TOE: 31, R_TOE: 32, L_IDX: 19, R_IDX: 20
        };

        const pts = {
            shL: k(L.L_SHO), shR: k(L.R_SHO), elL: k(L.L_ELB), elR: k(L.R_ELB),
            wrL: k(L.L_WRI), wrR: k(L.R_WRI), hpL: k(L.L_HIP), hpR: k(L.R_HIP),
            knL: k(L.L_KNE), knR: k(L.R_KNE), anL: k(L.L_ANK), anR: k(L.R_ANK),
            toeL: k(L.L_TOE), toeR: k(L.R_TOE), lix: k(L.L_IDX), rix: k(L.R_IDX),
            nose: k(L.NOSE)
        };
        if (!Object.values(pts).some(Boolean)) return null;

        // ---------- centers & vectors ----------
        const shC = mid(pts.shL, pts.shR);
        const hpC = mid(pts.hpL, pts.hpR);
        const anC = mid(pts.anL, pts.anR);

        const hoop = hoopBox || window.getLockedHoopBox?.();
        const hc = hoop
            ? (Number.isFinite(hoop.cx) && Number.isFinite(hoop.cy)
                ? { x: hoop.cx, y: hoop.cy }
                : { x: hoop.x + (hoop.w || hoop.width || 0) / 2, y: hoop.y + (hoop.h || hoop.height || 0) / 2 })
            : null;

        const torsoVec = (hpC && shC) ? v(hpC, shC) : null;
        const forearmR = (pts.shR && pts.wrR) ? v(pts.shR, pts.wrR) : null;
        const forearmL = (pts.shL && pts.wrL) ? v(pts.shL, pts.wrL) : null;

        // ---------- torso & arm ----------
        const torsoLeanAngle = angleFromVertical(torsoVec);                           // 0 = upright
        const elbowR = angleAt(pts.shR, pts.elR, pts.wrR);
        const elbowL = angleAt(pts.shL, pts.elL, pts.wrL);
        const elbowExtDeg = (Number.isFinite(elbowR) || Number.isFinite(elbowL))
            ? Math.max(elbowR || 0, elbowL || 0) : null;

        const armVertR = angleFromVertical(forearmR);
        const armVertL = angleFromVertical(forearmL);
        const armVerticalityDeg = Math.min(
            Number.isFinite(armVertR) ? Math.round(armVertR) : 90,
            Number.isFinite(armVertL) ? Math.round(armVertL) : 90
        );

        const shWrAngR = angleFromHorizontal(forearmR);
        const shWrAngL = angleFromHorizontal(forearmL);
        const shoulderToWristAngle = Math.min(
            Number.isFinite(shWrAngR) ? Math.round(shWrAngR) : 90,
            Number.isFinite(shWrAngL) ? Math.round(shWrAngL) : 90
        );

        const releaseAboveShoulderR = (pts.wrR && pts.shR) ? (pts.wrR.y < pts.shR.y) : null;
        const releaseAboveShoulderL = (pts.wrL && pts.shL) ? (pts.wrL.y < pts.shL.y) : null;
        const releaseAboveShoulder = (releaseAboveShoulderR === true || releaseAboveShoulderL === true);
        const elbowLock = Number.isFinite(elbowExtDeg) ? (elbowExtDeg >= 150) : null;

        // ---------- stance / feet ----------
        const hipWidthPx = dist(pts.hpL, pts.hpR) || 1;
        const stanceWidthPx = dist(pts.anL, pts.anR);
        const stanceRatio = (stanceWidthPx && hipWidthPx) ? (stanceWidthPx / hipWidthPx) : null;

        const dirToeL = (pts.anL && (pts.toeL || pts.lix)) ? v(pts.anL, (pts.toeL || pts.lix)) : null;
        const dirToeR = (pts.anR && (pts.toeR || pts.rix)) ? v(pts.anR, (pts.toeR || pts.rix)) : null;

        let feetAngleDiff = null, footStagger = null, toeToHoopDeg = null, feetToHoopDeg = null;
        try {
            const aL = angleFromHorizontal(dirToeL);
            const aR = angleFromHorizontal(dirToeR);
            if (Number.isFinite(aL) && Number.isFinite(aR)) {
                const d = Math.abs(aL - aR);
                feetAngleDiff = Math.min(d, 360 - d);
            }
            if (Number.isFinite(pts.anL?.y) && Number.isFinite(pts.anR?.y)) {
                footStagger = Math.abs(pts.anL.y - pts.anR.y);
            }
            if (hc && anC) {
                const avgDir = (() => {
                    const arr = []; if (dirToeL) arr.push(dirToeL); if (dirToeR) arr.push(dirToeR);
                    if (!arr.length) return null;
                    return { x: arr.reduce((s, u) => s + u.x, 0) / arr.length, y: arr.reduce((s, u) => s + u.y, 0) / arr.length };
                })();
                if (avgDir) {
                    const feetAng = angleFromHorizontal(avgDir);
                    const hoopAng = angleFromHorizontal(v(anC, hc));
                    const d = Math.abs(feetAng - hoopAng);
                    toeToHoopDeg = Math.min(d, 360 - d);
                }
            }
            if (hc && pts.anL && pts.anR && anC) {
                const dirFeet = v(pts.anL, pts.anR);
                const dirHoop = { x: hc.x - anC.x, y: hc.y - anC.y };
                const aF = angleFromHorizontal(dirFeet);
                const aH = angleFromHorizontal(dirHoop);
                const d = Math.abs(aF - aH);
                feetToHoopDeg = Math.min(d, 180 - d);
            }
        } catch { }

        // ---------- knee flex ----------
        let kneeFlex = null;
        try {
            const aL = angleAt(pts.hpL, pts.knL, pts.anL);
            const aR = angleAt(pts.hpR, pts.knR, pts.anR);
            const kL = Number.isFinite(aL) ? Math.max(0, 180 - aL) : null;
            const kR = Number.isFinite(aR) ? Math.max(0, 180 - aR) : null;
            const arr = [kL, kR].filter(Number.isFinite);
            if (arr.length) kneeFlex = arr.reduce((s, v) => s + v, 0) / arr.length;
        } catch { }

        // ---------- foot pop (from history) ----------
        let footLiftPx = null;
        try {
            const hist = (window.playerState?.frameHistory || []).slice(-4, -1);
            if (hist.length && pts.anL && pts.anR) {
                const avg = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;
                const prev = hist.map(h => h.keypoints).filter(Boolean);
                if (prev.length) {
                    const pAnL = avg(prev.map(p => (p[L.L_ANK]?.y) || 0));
                    const pAnR = avg(prev.map(p => (p[L.R_ANK]?.y) || 0));
                    const curL = pts.anL.y, curR = pts.anR.y;
                    if (Number.isFinite(curL) && Number.isFinite(curR)) {
                        footLiftPx = Math.max(pAnL - curL, pAnR - curR);
                    }
                }
            }
        } catch { }

        // ---------- wrist index cue ----------
        let indexBelowWristPx = null, fingersDown = null;
        try {
            const dR = (Number.isFinite(pts.rix?.y) && Number.isFinite(pts.wrR?.y)) ? (pts.rix.y - pts.wrR.y) : null;
            const dL = (Number.isFinite(pts.lix?.y) && Number.isFinite(pts.wrL?.y)) ? (pts.lix.y - pts.wrL.y) : null;
            const arr = [dR, dL].filter(Number.isFinite);
            if (arr.length) { indexBelowWristPx = Math.max(...arr); fingersDown = indexBelowWristPx > 0; }
        } catch { }

        // ---------- follow-through hold frames ----------
        let followThroughHoldFrames = null;
        try {
            const hist = (window.playerState?.frameHistory || []).slice(-6);
            let cnt = 0;
            for (const f of hist) {
                const p = f?.keypoints; if (!p) continue;
                const sh = p[L.R_SHO], el = p[L.R_ELB], wr = p[L.R_WRI];
                const elAng = angleAt(sh, el, wr);
                const wristAboveElbow = (wr?.y != null && el?.y != null) ? (wr.y < el.y) : false;
                if (Number.isFinite(elAng) && elAng >= 150 && wristAboveElbow) cnt++;
            }
            followThroughHoldFrames = cnt;
        } catch { }

        // ---------- head toward hoop / centering ----------
        let headToHoopDeg = null, lookingAtHoop = null, frameOffsetX = null;
        try {
            if (hc && shC && pts.nose) {
                const neckToNose = v(shC, pts.nose);
                const neckToHoop = v(shC, hc);
                const a = Math.abs(angleFromHorizontal(neckToNose) - angleFromHorizontal(neckToHoop));
                headToHoopDeg = Math.min(a, 360 - a);
                lookingAtHoop = headToHoopDeg <= 25;
            }
            if (hc && shC) frameOffsetX = shC.x - hc.x;
            // Smooth noisy offsets with a short median (last 2 + current)
            try {
                const prev = (window.__poseHistory || []).slice(-2).map(e => e.snap?.frameOffsetX).filter(Number.isFinite);
                if (prev.length && Number.isFinite(frameOffsetX)) {
                    const arr = prev.concat(frameOffsetX).sort((a, b) => a - b);
                    frameOffsetX = arr[Math.floor(arr.length / 2)];
                }
            } catch { }
        } catch { }

        // ---------- export ----------
        const out = {
            stanceWidthPx: rnd(stanceWidthPx, 0),
            stanceWidthFeet: rnd(stanceWidthPx, 0),
            stanceRatio: rnd(stanceRatio, 2),

            torsoLeanAngle: rnd(torsoLeanAngle, 0),
            elbowExtDeg: rnd(elbowExtDeg, 0),
            armVerticalityDeg,
            shoulderToWristAngle,

            releaseAboveShoulder,
            elbowLock,

            feetAngleDiff: rnd(feetAngleDiff, 0),
            footStagger: rnd(footStagger, 0),
            toeToHoopDeg: rnd(toeToHoopDeg, 0),
            feetToHoopDeg: rnd(feetToHoopDeg, 0),

            kneeFlex: rnd(kneeFlex, 0),
            footLiftPx: rnd(footLiftPx, 0),

            indexBelowWristPx: rnd(indexBelowWristPx, 0),
            fingersDown: (typeof fingersDown === 'boolean') ? fingersDown : null,
            followThroughHoldFrames: Number.isFinite(followThroughHoldFrames) ? followThroughHoldFrames : null,

            headToHoopDeg: rnd(headToHoopDeg, 0),
            lookingAtHoop: (typeof lookingAtHoop === 'boolean') ? lookingAtHoop : null,
            frameOffsetX: rnd(frameOffsetX, 0),

            __impl: 'snapshot-v2'
        };
        return out;
    } catch {
        return null;
    }
};
try { window.__SNAP_IMPL = 'snapshot-v2'; } catch { }

// // 2) Rescue hook: if a summary arrives with a bad/old snapshot, recompute it immediately
// (function(){
//   if (window.__summaryResnapWired) return; window.__summaryResnapWired = true;

//   function looksBad(snap){
//     if (!snap) return true;
//     // old extractor negative lean, or missing core fields
//     if (typeof snap.torsoLeanAngle === 'number' && snap.torsoLeanAngle < -0.1) return true;
//     if (typeof snap.armVerticalityDeg !== 'number') return true;
//     if (typeof snap.shoulderToWristAngle !== 'number') return true;
//     return false;
//   }

//   window.addEventListener('shot:summary', (e) => {
//     try {
//       const d = e?.detail || {};
//       if (!looksBad(d.poseSnapshot)) return;

//       const kps  = window.playerState?.keypoints || null;
//       const hoop = window.getLockedHoopBox?.() || null;
//       const snap = window.extractPoseSnapshot?.(kps, hoop) || null;
//       if (snap) {
//         d.poseSnapshot = snap;                          // fix payload in-place
//         try {
//           // also patch the last UI row so table/overlay match
//           const list = window.__shotList || [];
//           const last = list.at?.(-1);
//           if (last) last.poseSnapshot = snap;
//         } catch {}
//       }
//     } catch {}
//   }, { passive:true });
// })();




function getShotScoreForSummary(shot) {
    try {
        if (Number.isFinite(shot?.weightedScore)) return Math.round(shot.weightedScore);
        if (typeof window.computeWeightedShotScore === 'function' && shot?.poseSnapshot) {
            return Math.round(window.computeWeightedShotScore(shot.poseSnapshot));
        }
        const last = window.shotLog?.at?.(-1);
        if (Number.isFinite(last?.weightedScore)) return Math.round(last.weightedScore);
    } catch { }
    return null;
}


// --- Format (no speaking here) ---
function formatCoachLine(s) {
    const snap = getPoseSnapshotFrom(s);
    try {
        const list = window.__shotList || [];
        const lastRow = list.at?.(-1) || {};
        const golden = window.DOACH_MEM?.get?.()?.golden || null;

        const cues = [];
        const poseLine = (snap && typeof composePoseFeedback === 'function')
            ? composePoseFeedback(snap)
            : '';
        if (poseLine) cues.push(poseLine.trim());

        try {
            const issues = (typeof window.summarizePoseIssues === 'function')
                ? (window.summarizePoseIssues({ poseSnapshot: snap }, golden) || [])
                : [];
            for (const note of issues) {
                const txt = String(note || '').trim();
                if (txt && !cues.includes(txt)) cues.push(txt);
            }
        } catch { }

        let body = cues.slice(0, 2).join(' ') || 'Pose metrics captured. Focus on repeatable release mechanics.';

        const sc = getShotScoreForSummary({ poseSnapshot: snap, ...s, ...lastRow });
        if (Number.isFinite(sc)) body += ` Score ${sc}/100.`;

        const n = preferShotNumber(s);
        return n > 0 ? `Shot ${n}, ${body}` : body;
    } catch (err) {
        console.warn('[coachAssistant:formatCoachLine]', err);
        return 'Pose metrics captured.';
    }
}
window.formatCoachLine = formatCoachLine;  // ensure global


// Canonical "what shot # am I on?" helper
window.getShotNumber = window.getShotNumber || function () {
    try {
        if (typeof getShotRecords === 'function') {
            const recs = getShotRecords();
            if (recs && recs.length) return recs.slice(-1)[0].idx; // 1-based
        }
    } catch { }
    try {
        const list = window.__shotList || [];
        if (list.length) return list.length;
    } catch { }
    return Number(window.__SHOT_ID || 0);
};


// Canonical pose snapshot getter used across coach paths.
function getPoseSnapshotFrom(s) {
    try { if (s && s.poseSnapshot) return s.poseSnapshot; } catch { }
    const shotId = Number(s?.shotId);
    if (Number.isFinite(shotId)) {
        const stored = window.poseStore?.get(shotId) || null;
        if (stored) return stored;
    }
    try {
        const state = window.playerState || null;
        if (state && Array.isArray(state.keypoints) && state.keypoints.length >= 33 && typeof window.extractPoseSnapshot === 'function') {
            return window.extractPoseSnapshot(state.keypoints, window.getLockedHoopBox?.());
        }
    } catch { }
    return null;
}


// --- Speak once per shot summary ---
async function finalizeCoachLine(line, provider = 'pose', model = 'pose-summary', idx0Override) {
    try {
        const sid = window.__SESSION_ID || null;
        if (!sid || !line) return;
        const idx0 = Number.isFinite(idx0Override)
            ? idx0Override
            : Math.max(0, (preferShotNumber({}) || 1) - 1);
        const payload = { sid, shot_idx: idx0, text: line, provider, model, latency_ms: 0 };

        const urls = [
            '/api/coach/finalize',
            `/api/sessions/${sid}/ai_feedback`,
            '/api/ai_feedback'
        ];
        for (const url of urls) {
            try {
                const r = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                    credentials: 'include'
                });
                if (r.ok) { console.debug('[ai_feedback] saved via', url); break; }
            } catch { }
        }
    } catch (e) { console.warn('[ai_feedback] save failed', e); }
}
window.finalizeCoachLine = window.finalizeCoachLine || finalizeCoachLine;

// Stable, minimal de-dupe for summaries: use identity, not scenery
const __summarySeen = new Set();
function makeSummaryKey(s) {
    const sid = String(window.__SESSION_ID || '');
    const id = Number(s?.shotId);
    return sid + '|' + (Number.isFinite(id) ? id : '');
}

window.addEventListener('shot:summary', (e) => {
    const s = e?.detail;
    if (!s) return;

    // de-dupe by session + shotId only
    const key = makeSummaryKey(s);
    if (key && __summarySeen.has(key)) return;
    if (key) __summarySeen.add(key);

    // Build final line - doach assessment
    const formatted = window.formatCoachLine(s);
    const shotId = Number(s?.shotId) || Number(window.__CURRENT_SHOT_ID) || Number(window.__SHOT_ID) || 0;
    const personalized = window.__coachMaybePersonalize ? window.__coachMaybePersonalize(formatted, shotId) : formatted;
    window.__lastCoachText = personalized;

    // Update UI text
    try {
        setCoachNotesContent(personalized);
    } catch { }

    // Tell the frontend store (table/row) what the coach line is
    try {
        window.dispatchEvent(new CustomEvent('shot:feedback:result', {
            detail: { shotId: Number(s.shotId) || null, text: formatted }
        }));
    } catch { }

    // Speak once, here
    try { if (!window.__coachMuted) (window.doachSpeak || window.coachSpeak)?.(personalized); } catch { }

    // Persist ai_feedback with correct index (shotId-1)
    try {
        const idx0 = Number.isFinite(Number(s?.shotId)) ? (Number(s.shotId) - 1)
            : Math.max(0, (preferShotNumber(s) || 1) - 1);
        finalizeCoachLine(personalized, 'pose', 'pose-summary', idx0);
    } catch { }
});



// Use ShotStore id for banner numbering
window.addEventListener('shot:feedback:request', (e) => {
    const lastFromStore =
        (typeof getShotRecords === 'function' && getShotRecords().length)
            ? getShotRecords().slice(-1)[0]?.idx
            : null;

    window.__CURRENT_SHOT_ID =
        Number(e?.detail?.shotId) ||
        Number(lastFromStore) ||
        Number(window.__SHOT_ID) ||
        1;
});



(function () {
    // ---------- Config ----------
    const DOACH = window.DOACH || {
        chatEndpoint: '/api/coach',  // POST {prompt, model}
        ttsEndpoint: '/api/tts',    // POST {text, voice}
        model: 'gpt-4o-mini',
        tts: 'openai',      // 'openai' or 'webspeech'
        voice: 'alloy',
        personality: 'positive, concise, basketball fundamentals-first',
        llmMode: 'off',        // 'primary' | 'polish' | 'off'
        poseOnly: true,
    };
    window.DOACH = DOACH;
    if (typeof DOACH.poseOnly === 'undefined') DOACH.poseOnly = true;
    if (DOACH.poseOnly) DOACH.llmMode = 'off';
    try { if (typeof window.DOACH_ONLY_REALTIME === 'undefined') window.DOACH_ONLY_REALTIME = true; } catch { }
    console.log('[Doach] coachAssistant loaded');

    // Prevent double-initialization if the script is included twice
    if (window.__DOACH_INIT__) return;
    window.__DOACH_INIT__ = true;

    // Make sure live tips are enabled by default (belt-and-suspenders)
    try { if (typeof window.PREF_LIVE_TIPS === 'undefined') window.PREF_LIVE_TIPS = true; } catch { }

    // Small helper: ensure the HUD prompt node exists and return it
    function ensureCoachNotes() {
        try {
            let el = document.getElementById('coachNotes');
            if (!el) {
                const root = document.body || document.documentElement;
                el = document.createElement('div');
                el.id = 'coachNotes';
                root.appendChild(el);
            }
            const baseStyles = {
                position: 'absolute',
                top: '14px',
                left: '50%',
                transform: 'translateX(-50%)',
                maxWidth: '520px',
                background: 'rgba(0,0,0,0.7)',
                color: '#fff',
                padding: '16px 20px 14px',
                borderRadius: '10px',
                textAlign: 'center',
                fontSize: '14px',
                lineHeight: '1.4',
                pointerEvents: 'auto',
                boxShadow: '0 12px 24px rgba(0,0,0,0.35)'
            };
            Object.assign(el.style, baseStyles);
            if (!el.dataset.baseZ) el.dataset.baseZ = '900';
            if (!el.style.zIndex) el.style.zIndex = el.dataset.baseZ;
            if (!el.style.display) el.style.display = 'none';
            ensureCoachNotesBody(el);
            ensureCoachNotesClose(el);
            return el;
        } catch { return null; }
    }

    function ensureCoachNotesBody(el) {
        if (!el) return null;
        let body = el.querySelector('.coach-notes__body');
        if (!body) {
            body = document.createElement('div');
            body.className = 'coach-notes__body';
            el.appendChild(body);
        }
        return body;
    }

    function ensureCoachNotesClose(el) {
        if (!el) return null;
        let btn = el.querySelector('.coach-notes__close');
        if (!btn) {
            btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'coach-notes__close';
            btn.setAttribute('aria-label', 'Close coach summary');
            btn.innerHTML = '&times;';
            Object.assign(btn.style, {
                position: 'absolute',
                top: '8px',
                right: '10px',
                width: '26px',
                height: '26px',
                border: 'none',
                borderRadius: '50%',
                background: 'rgba(255,255,255,0.16)',
                color: '#fff',
                fontSize: '18px',
                lineHeight: '1',
                cursor: 'pointer',
                padding: '0',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
            });
            btn.addEventListener('click', (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                if (el.dataset.baseZ) el.style.zIndex = el.dataset.baseZ;
                el.style.display = 'none';
                el.dataset.dismissed = 'true';
            });
            el.appendChild(btn);
        }
        return btn;
    }

    function setCoachNotesContent(content, options = {}) {
        const el = ensureCoachNotes();
        if (!el) return null;
        const body = ensureCoachNotesBody(el);

        if (options.html === true) {
            body.innerHTML = content ?? '';
        } else if (typeof content === 'string') {
            body.textContent = content;
        } else {
            body.textContent = content == null ? '' : String(content);
        }

        if (typeof options.zIndex !== 'undefined') {
            el.style.zIndex = String(options.zIndex);
        } else if (options.resetZ === true && el.dataset.baseZ) {
            el.style.zIndex = el.dataset.baseZ;
        }

        if (options.extraStyles && typeof options.extraStyles === 'object') {
            Object.assign(el.style, options.extraStyles);
        }

        const dismissed = el.dataset.dismissed === 'true';
        const forceShow = options.force === true;
        if (forceShow || !dismissed) {
            el.style.display = options.display ?? 'block';
            el.dataset.dismissed = 'false';
        }

        ensureCoachNotesClose(el);
        return el;
    }

    function hideCoachNotes() {
        const el = document.getElementById('coachNotes');
        if (!el) return null;
        el.style.display = 'none';
        if (el.dataset.baseZ) el.style.zIndex = el.dataset.baseZ;
        el.dataset.dismissed = 'false';
        const body = ensureCoachNotesBody(el);
        if (body) body.textContent = '';
        return el;
    }

    const SPEAK_DEDUP_MS = 1200;
    let __lastSpeak = { text: '', at: 0 };

    // Default: enable live tips unless explicitly disabled elsewhere
    try { if (typeof window.PREF_LIVE_TIPS === 'undefined') window.PREF_LIVE_TIPS = true; } catch { }
    // Defaults for tip cadence: every other shot, and 60% probability fallback
    try { if (typeof window.COACH_TIP_EVERY_N === 'undefined') window.COACH_TIP_EVERY_N = 2; } catch { }
    try { if (typeof window.COACH_TIP_PROB === 'undefined') window.COACH_TIP_PROB = 0.6; } catch { }

    // Pose snapshot + metrics shim (kept for legacy callers)
    function defineExtractPoseSnapshotOnce() {
        /* no-op: snapshot-v2 is the authoritative extractor */
    }

    // Wire quick pose tips on release - gated off by default. Enable with window.PREF_LIVE_TIPS=true
    function __getPoseSnapshot() {
        try {
            const entries = window.poseStore?.entries?.() || [];
            if (entries.length) {
                const latest = entries[entries.length - 1];
                if (latest?.snap) return latest.snap;
            }
        } catch { }
        try {
            if (typeof window.capturePoseSnapshot === 'function') {
                return window.capturePoseSnapshot(window.playerState, window.getLockedHoopBox?.());
            }
        } catch { }
        return null;
    }


    // One-shot sampling from the live video element to build a fresh snapshot
    async function __samplePoseSnapshotNow() {
        try {
            const v = document.getElementById('videoPlayer');
            if (!v || !v.videoWidth) return null;
            const ts = performance.now();
            let people = null;
            try {
                if (window.poseDetector?.detectForVideo) {
                    const res = await window.poseDetector.detectForVideo(v, ts);
                    people = res?.landmarks || null;
                } else if (typeof window.poseDetectSerial === 'function') {
                    const res = await window.poseDetectSerial();
                    people = res?.landmarks || null;
                }
            } catch { }
            const ls = (Array.isArray(people) && Array.isArray(people[0]) && people[0].length >= 33) ? people[0] : null;
            if (!ls) return null;
            const looksNorm = ls.every(k => k && k.x <= 1.01 && k.y <= 1.01);
            const sx = looksNorm ? (v.videoWidth || 1) : 1;
            const sy = looksNorm ? (v.videoHeight || 1) : 1;
            const scaled = ls.map(k => ({ ...k, x: k.x * sx, y: k.y * sy }));
            try { defineExtractPoseSnapshotOnce(); } catch { }
            return (typeof window.extractPoseSnapshot === 'function')
                ? window.extractPoseSnapshot(scaled, window.getLockedHoopBox?.())
                : null;
        } catch { return null; }
    }

    function __ensureSummarizer() {
        try {
            if (typeof window.summarizePoseIssues === 'function') return;
            // Rich, rule-based summarizer. Returns top 2-3 concise notes.
            window.summarizePoseIssues = ({ poseSnapshot, golden }) => {
                const S = poseSnapshot || {};
                const out = [];
                const prev = (Array.isArray(window.__shotList) ? window.__shotList : []).map(s => s.poseSnapshot).filter(Boolean);
                const avg = (arr) => arr.length ? (arr.reduce((s, v) => s + v, 0) / arr.length) : null;
                const prevAvg = {
                    stanceRatio: avg(prev.map(p => p.stanceRatio).filter(Number.isFinite)),
                    elbowExtDeg: avg(prev.map(p => p.elbowExtDeg).filter(Number.isFinite)),
                    armVerticalityDeg: avg(prev.map(p => p.armVerticalityDeg).filter(Number.isFinite)),
                    torsoLeanAngle: avg(prev.map(p => p.torsoLeanAngle).filter(Number.isFinite)),
                    feetToHoopDeg: avg(prev.map(p => p.feetToHoopDeg).filter(Number.isFinite)),
                };
                // Targets (golden) with sensible defaults
                const G = Object.assign({
                    stanceRatio: 1.2,           // feet ~hip to 1.4× hip
                    elbowExtDeg: 150,           // near straight
                    armVerticalityDeg: 10,      // near vertical
                    torsoLeanAbsMax: 12,
                    feetToHoopDegMax: 22,       // roughly squared
                }, golden || {});
                // Stance width
                if (Number.isFinite(S.stanceRatio)) {
                    if (S.stanceRatio < 0.9) out.push('Wider base; feet shoulder‑width apart.');
                    else if (S.stanceRatio > 1.6) out.push('Narrow your stance slightly.');
                    else if (prevAvg.stanceRatio && S.stanceRatio > prevAvg.stanceRatio + 0.25) out.push('Good base - more stable than last shots.');
                }
                // Feet to hoop alignment
                if (Number.isFinite(S.feetToHoopDeg) && S.feetToHoopDeg > G.feetToHoopDegMax)
                    out.push('Square your feet a bit more to the rim.');
                // Knee flex proxy: if elbow extension lags + arm verticality poor, cue power
                if (Number.isFinite(S.elbowExtDeg) && S.elbowExtDeg < (G.elbowExtDeg - 10))
                    out.push('Fully extend the shooting arm through release.');
                if (Number.isFinite(S.armVerticalityDeg) && S.armVerticalityDeg > (G.armVerticalityDeg + 8))
                    out.push('Get the forearm more vertical at release.');
                // Release height
                if (S.releaseAboveShoulder === false)
                    out.push('Release above your shoulder line.');
                // Torso lean
                if (Number.isFinite(S.torsoLeanAngle) && Math.abs(S.torsoLeanAngle) > G.torsoLeanAbsMax)
                    out.push('Stay taller - limit torso lean.');
                // Foot lift
                if (Number.isFinite(S.footLiftPx)) {
                    if (S.footLiftPx > 8) out.push('Nice pop - light foot lift on release.');
                    else out.push('Add a little upward pop as you snap.');
                }
                // Frame offset (contextual guidance only when large)
                if (Number.isFinite(S.frameOffsetX) && Math.abs(S.frameOffsetX) > 80)
                    out.push('Center your body line with the rim before you shoot.');
                // Only keep top 2-3 to stay concise
                return out.slice(0, 3);
            };
        } catch { }
    }

    function assessPoseAndSpeak(via) {
        try {
            // Gate: only once session is armed and hoop is confirmed
            const armed = (window.__shotTrackingArmed === true);
            const confirmed = (window.__hoopConfirmed === true);
            if (!armed || !confirmed) {
                if (window.DOACH_RELEASE_TRACE === true) { try { console.log('[coach:tip:skip]', { via, reason: !armed ? 'not-armed' : 'no-hoop' }); } catch { } }
                return;
            }
            // Speak only on release (and allow score-trip fallback elsewhere)
            if (via !== 'shot:release') return;
            if (!window.PREF_LIVE_TIPS) return;  // default: no live tips, only summary

            // simple cooldown on our side (coachSpeak also dedups)
            const now = performance.now();
            const last = Number(window.__COACH_TIP_LAST_AT || 0);
            const gap = Number(window.COACH_TIP_MIN_MS || 900);

            // Always allow on the exact shot release event
            if (via === 'shot:release') {
                window.__COACH_TIP_LAST_AT = now;
                try { window.__COACH_LAST_REL_SPEAK = now; } catch { }
                assessPoseAndSpeakCore(via);
                return;
            }
            if (now - last < gap) return;
            // Frequency gating: speak on some shots, not all
            try {
                const cnt = Number(window.__HUD_SHOT_COUNT || window.shotTaken || 0);
                const everyN = Number(window.COACH_TIP_EVERY_N || 0);  // e.g., 2 -> every other shot
                const prob = Number(window.COACH_TIP_PROB || 0);     // e.g., 0.4 -> 40% chance
                let allow = true;
                if (!(everyN > 1)) { try { allow = Math.random() < (Number(window.COACH_TIP_PROB || 0.5)); } catch { } }
                if (everyN > 1) allow = (cnt % everyN) === 1;          // speak on 1, 1+N, ...
                if (!allow && prob > 0) allow = Math.random() < prob;  // random backstop
                if (!allow) return;
            } catch { }
            window.__COACH_TIP_LAST_AT = now;

            // allow a small delay after release to stabilize pose if asked (release: no delay)
            const delay = (via === 'shot:release') ? 0 : Number(window.COACH_TIP_DELAY_MS || 900);
            if (delay > 0) {
                setTimeout(() => { try { assessPoseAndSpeakCore(via); } catch { } }, delay);
            } else {
                assessPoseAndSpeakCore(via);
            }
        } catch { }
    }

    async function assessPoseAndSpeakCore(via) {
        try {
            let snap = __getPoseSnapshot();
            // Try an immediate one-shot sample before scheduling delayed resample
            if (!snap && typeof __samplePoseSnapshotNow === 'function') {
                try { snap = await __samplePoseSnapshotNow(); } catch { }
            }
            try {
                if (window.DOACH_RELEASE_TRACE === true) {
                    const gate = window.__LAST_GATE?.detail?.tests || null;
                    console.log('[coach:tip:snap]', { via, snap, gate });
                }
            } catch { }
            // If we fired exactly at release, give pose one short beat to land
            if (!snap && via === 'shot:release') {
                try {
                    if (!window.__COACH_RESAMPLE_SCHED) {
                        window.__COACH_RESAMPLE_SCHED = true;
                        setTimeout(() => {
                            (async () => {
                                try {
                                    window.__COACH_RESAMPLE_SCHED = false;
                                    // Re-check gate
                                    if (window.__shotTrackingArmed !== true || window.__hoopConfirmed !== true) return;
                                    let s2 = __getPoseSnapshot();
                                    if (!s2 && typeof __samplePoseSnapshotNow === 'function') {
                                        try { s2 = await __samplePoseSnapshotNow(); } catch { }
                                    }
                                    if (!s2) {
                                        try {
                                            // Build a minimal snapshot from the unified gate tests so AI can still respond
                                            const t = (window.__LAST_GATE?.detail?.tests) || {};
                                            const mSnap = {
                                                releaseAboveShoulder: (typeof t.wristAboveShoulder === 'boolean') ? t.wristAboveShoulder : null,
                                                elbowExtDeg: Number.isFinite(t.elbowAngleDeg) ? Math.round(t.elbowAngleDeg) : null,
                                                armVerticalityDeg: Number.isFinite(t.dx) && Number.isFinite(t.dy)
                                                    ? Math.round(Math.abs(90 - (Math.atan2(Math.abs(t.dy), Math.abs(t.dx)) * 180 / Math.PI)))
                                                    : null,
                                                stanceRatio: null,
                                                feetToHoopDeg: null,
                                                torsoLeanAngle: null,
                                                footLiftPx: null,
                                                frameOffsetX: null,
                                            };
                                            const hasAny = Object.values(mSnap).some(v => v !== null);
                                            if (hasAny) {
                                                if (window.DOACH_RELEASE_TRACE === true) console.log('[coach:tip:minimal]', { via, snap: mSnap, gate: t });
                                                speakWithAIOrRules(mSnap, via);
                                            } else {
                                                // No measurable cues at all - log + prompt only (no static speech)
                                                const msg = 'Release pose not detected clearly - keep your upper body and shooting arm fully in frame, and check lighting.';
                                                window.showPromptMessage?.(msg, 3000);
                                                try { if (window.DOACH_RELEASE_TRACE === true) console.warn('[coach:tip:no-snapshot]'); } catch { }
                                            }
                                        } catch { }
                                        return;
                                    }

                                    const golden2 = window.DOACH_MEM?.get?.()?.golden;
                                    const issues2 = (typeof window.summarizePoseIssues === 'function')
                                        ? (window.summarizePoseIssues({ poseSnapshot: s2 }, golden2) || [])
                                        : [];
                                    // Persist snapshot for history and attach to last pending shot if missing
                                    try {
                                        (window.__poseHistory ||= []).push({ t: Date.now(), snap: s2 });
                                        const lst = window.__shotList; const last = Array.isArray(lst) ? lst.at(-1) : null;
                                        if (last && last.pending && !last.poseSnapshot) last.poseSnapshot = s2;
                                    } catch { }
                                    if (window.DOACH_RELEASE_TRACE === true) console.log('[coach:tip:resample]', { via, snap: s2, issues: issues2, lastGate: window.__LAST_GATE?.detail?.tests || null });
                                    try { showPoseMetricsOverlay?.(s2, Number(window.POSE_METRICS_MS || 1800)); } catch { }

                                    speakWithAIOrRules(s2, via);
                                } catch { }
                            })();
                        }, Math.max(120, Number(window.COACH_TIP_RESAMPLE_MS ?? 350)));
                    }
                } catch { }
                return;
            }
            if (!snap) return;

            const golden = window.DOACH_MEM?.get?.()?.golden;
            const issues = (typeof window.summarizePoseIssues === 'function')
                ? (window.summarizePoseIssues({ poseSnapshot: snap }, golden) || [])
                : [];

            // Categorize and vary the coaching line so it doesn't repeat
            // Persist current snapshot for session-level analysis
            try {
                (window.__poseHistory ||= []).push({ t: Date.now(), snap });
                // also attach to last pending shot if present
                const lst = window.__shotList; const last = Array.isArray(lst) ? lst.at(-1) : null;
                if (last && last.pending && !last.poseSnapshot) last.poseSnapshot = snap;
            } catch { }

            // Overlay: show the metrics we will coach from
            try { showPoseMetricsOverlay?.(snap, Number(window.POSE_METRICS_MS || 1800)); } catch { }
            // Always use AI for release tips; no rule fallback
            speakWithAIOrRules(snap, via);
        } catch { }
    }

    async function speakWithAIOrRules(snap, via) {
        function getShotNumber() {
            // Prefer the canonical id captured from ShotStore
            const id = Number(window.__CURRENT_SHOT_ID);
            if (Number.isFinite(id) && id > 0) return id;

            // Fallback: last row from ShotStore, if available
            try {
                if (typeof getShotRecords === 'function') {
                    const last = getShotRecords().slice(-1)[0];
                    if (last && Number.isFinite(last.idx)) return last.idx;
                }
            } catch { }

            // Legacy fallbacks (kept for safety)
            const vals = [];
            if (Number.isFinite(window.__SHOT_ID)) vals.push(Number(window.__SHOT_ID));
            if (Number.isFinite(window.__SCORE_SHOT_COUNT)) vals.push(Number(window.__SCORE_SHOT_COUNT));
            if (Array.isArray(window.shotLog)) vals.push(window.shotLog.length);
            if (Number.isFinite(window.__HUD_SHOT_COUNT)) vals.push(Number(window.__HUD_SHOT_COUNT));
            if (Number.isFinite(window.shotTaken)) vals.push(Number(window.shotTaken));
            const n = vals.filter(v => v > 0).reduce((m, v) => Math.max(m, v), 0);
            return n > 0 ? n : 1;
        }

        function withShotPrefix(text) {
            const n = getShotNumber();
            return (Number.isFinite(n) && n > 0) ? `Shot ${n}, ${text}` : String(text || '');
        }
        // Always use AI for pose assessment. If unavailable, show connection error - no rule fallback.
        function postDisconnected() {
            try {
                const msg = 'Doach is not connected. Please restart the session and check your internet connection.';
                window.showPromptMessage?.(msg, 2000);
                console.warn('[coach:ai:error] not connected');
            } catch { }
        }

        const llmMode = (window.DOACH && window.DOACH.llmMode) || 'off';

        const inferShotIdx0 = () => {
            const cur = Number(window.__CURRENT_SHOT_ID);
            if (Number.isFinite(cur) && cur > 0) return cur - 1;
            try { if (Number.isFinite(Number(shot?.coachIdx))) return Number(shot.coachIdx); } catch { }
            try { if (Number.isFinite(Number(shot?.idx))) return Number(shot.idx); } catch { }
            try { if (Number.isFinite(Number(shot?.__idx))) return Number(shot.__idx) - 1; } catch { }
            try { if (Number.isFinite(Number(window.__SHOT_IDX))) return Number(window.__SHOT_IDX); } catch { }
            try {
                const n = getShotNumber?.(); // 1-based if available
                if (Number.isFinite(n) && n > 0) return n - 1;
            } catch { }
            try {
                const len = (window.__shotList?.length || 0);
                if (len > 0) return Math.max(0, len - 1);
            } catch { }
            return 0;
        };

        // If AI is explicitly off, fall back to local rule-based line immediately
        if (llmMode === 'off') {
            try {
                const local = composePoseFeedback(snap);
                if (local) {
                    const out = withShotPrefix(local);
                    window.__lastCoachText = out;
                    try { if (window.DOACH_RELEASE_TRACE === true) console.log('[coach:speak:off]', { via, out }); } catch { }
                    try { setCoachNotesContent(out); } catch { }
                } else { postDisconnected(); }
            } catch { postDisconnected(); }
            return;
        }
        try {
            const ctrl = new AbortController();
            const ms = Math.max(1200, Number(window.COACH_AI_TIMEOUT_MS || 2500));
            const t = setTimeout(() => { try { ctrl.abort(); } catch { } }, ms);
            const body = {
                prompt: `You are a concise basketball shooting coach. Using only these metrics, give 1 or 2 short specific release cues. Metrics: ${JSON.stringify(snap)}`,
                model: (window.DOACH && window.DOACH.model) || 'gpt-4o-mini',
                lang: 'en-US',
                shot: snap,
                profile: (localStorage.getItem('doachProfile') || ''),
                sid: (window.__SESSION_ID || null),
                shotId: inferShotIdx0(),
            };
            if (window.DOACH_RELEASE_TRACE === true) console.log('[coach:ai:req]', { via, ms, body });
            const r = await fetch('/api/coach', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal, credentials: 'include' });
            clearTimeout(t);
            if (!r.ok) throw new Error('coach_api_' + r.status);
            const j = await r.json();
            const text = String(j?.text || '').trim();
            if (window.DOACH_RELEASE_TRACE === true) console.log('[coach:ai:res]', { via, textLen: text.length, text });
            if (text) {
                try {
                    const out = withShotPrefix(text);
                    window.__lastCoachText = out;
                    try { setCoachNotesContent(out); } catch { }
                } catch { }
                return;
            }
            // No text returned -> treat as unavailable; fall back to local
            try {
                const local = composePoseFeedback(snap);
                if (local) {
                    const out = withShotPrefix(local);
                    window.__lastCoachText = out;
                    try { if (window.DOACH_RELEASE_TRACE === true) console.log('[coach:speak:fallback-local]', { via, out }); } catch { }
                    try { setCoachNotesContent(out); } catch { }
                    return;
                }
            } catch { }
            postDisconnected();
        } catch (e) {
            if (window.DOACH_RELEASE_TRACE === true) console.warn('[coach:ai:error]', e?.message || e);
            // Fallback to local rule-based line on any error
            try {
                const local = composePoseFeedback(snap);
                if (local) {
                    const out = withShotPrefix(local);
                    window.__lastCoachText = out;
                    try { if (window.DOACH_RELEASE_TRACE === true) console.log('[coach:speak:error-local]', { via, out }); } catch { }
                    try { setCoachNotesContent(out); } catch { }
                    return;
                }
            } catch { }
            postDisconnected();
        }
    }

    // ---- Fine-grained feedback composer (snapshot -> specific line) ----
    function composePoseFeedback(snap) {
        try {
            const prev = Array.isArray(window.__poseHistory) && window.__poseHistory.length
                ? window.__poseHistory.map(e => e.snap).filter(Boolean) : [];
            const avg = (arr) => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null;
            const pAvg = {
                stanceRatio: avg(prev.map(p => p.stanceRatio).filter(Number.isFinite)),
                elbowExtDeg: avg(prev.map(p => p.elbowExtDeg).filter(Number.isFinite)),
                armVertDeg: avg(prev.map(p => p.armVerticalityDeg).filter(Number.isFinite)),
                torsoLean: avg(prev.map(p => p.torsoLeanAngle).filter(Number.isFinite)),
                feetToHoop: avg(prev.map(p => p.feetToHoopDeg).filter(Number.isFinite)),
                kneeFlex: avg(prev.map(p => p.kneeFlex).filter(Number.isFinite)),
                feetAngle: avg(prev.map(p => p.feetAngleDiff).filter(Number.isFinite)),
                footStag: avg(prev.map(p => p.footStagger).filter(Number.isFinite)),
            };
            const choose = (arr) => arr[Math.floor(Math.random() * arr.length)];

            // Also draw from the unified gate tests when present
            const t = (window.__LAST_GATE && window.__LAST_GATE.detail && window.__LAST_GATE.detail.tests) ? window.__LAST_GATE.detail.tests : {};

            // Rank likely issues by severity so we pick the most actionable first
            const cand = [];
            const push = (sev, lines) => { if (sev > 0 && lines && lines.length) cand.push({ sev, lines }); };

            // Release height
            if (snap.releaseAboveShoulder === false || t.wristAboveShoulder === false) {
                push(10, ['Raise the release above your shoulder line.', 'Get the wrist above the shoulder at release.']);
            }
            // Elbow extension (target ~150+)
            if (Number.isFinite(snap.elbowExtDeg)) push(Math.max(0, 150 - snap.elbowExtDeg), ['Finish with stronger arm extension.', 'Straighten the elbow through the snap.']);
            else if (Number.isFinite(t.elbowAngleDeg)) push(Math.max(0, 150 - t.elbowAngleDeg), ['Finish with stronger arm extension.']);
            // Arm verticality (target ~<=12 off vertical)
            if (Number.isFinite(snap.armVerticalityDeg)) push(Math.max(0, snap.armVerticalityDeg - 12), ['Get the forearm more vertical at release.', 'Reach up for a taller finish.']);
            else if (Number.isFinite(t.dx)) push(Math.max(0, t.dx - (Number(window.REL_DX_MAX || 60) - 4)), ['Get the forearm more vertical at release.']);
            // Dy upward drive (target >= REL_DY_MIN)
            if (Number.isFinite(t.dy)) push(Math.max(0, (Number(window.REL_DY_MIN || 18) - t.dy)), ['Drive up more through the release.']);
            if (t.wristUpTrend === false) push(6, ['Snap up through the ball, not forward.']);
            // Stance width (target ~1.0-1.5)
            if (Number.isFinite(snap.stanceRatio)) {
                const dist = (snap.stanceRatio < 1.0) ? (1.0 - snap.stanceRatio) : (snap.stanceRatio - 1.5);
                if (dist > 0) {
                    push(6 + dist * 10, snap.stanceRatio < 1.0 ? ['Wider base; feet shoulder-width apart.', 'Open to shoulder width.'] : ['Narrow your stance slightly for balance.']);
                }
            }
            // Feet to rim (target <=22 deg)
            if (Number.isFinite(snap.feetToHoopDeg)) push(Math.max(0, snap.feetToHoopDeg - 22), ['Square your feet a bit more to the rim.']);
            // Feet angle diff (target small, <=8-10 deg)
            if (Number.isFinite(snap.feetAngleDiff)) push(Math.max(0, snap.feetAngleDiff - 10), ['Make your toes more parallel.']);
            // Foot stagger (target small)
            if (Number.isFinite(snap.footStagger)) push(Math.max(0, snap.footStagger - 6), ['Even out your stance front-to-back.']);
            // Toe-to-hoop alignment (target <= 22 deg)
            if (Number.isFinite(snap.toeToHoopDeg)) push(Math.max(0, snap.toeToHoopDeg - 22), ['Point your toes a touch more toward the basket.']);
            // Knee flex (target around 28+ deg flex for power)
            if (Number.isFinite(snap.kneeFlex)) push(Math.max(0, 28 - snap.kneeFlex), ['Add a bit more knee bend on your lift.']);
            // Fingers down (index below wrist)
            if (snap.fingersDown === false) push(8, ['Snap the wrist - fingers down on the finish.']);
            // Follow-through hold (target >= 2-3 frames)
            if (Number.isFinite(snap.followThroughHoldFrames) && snap.followThroughHoldFrames < 2) push(6, ['Hold the follow‑through for a brief pause.']);
            // Head direction (target <= 25 deg off hoop)
            if (Number.isFinite(snap.headToHoopDeg) && snap.headToHoopDeg > 25) push(5, ['Eyes on the rim through the release.']);
            // Torso lean (target <=12 abs)
            if (Number.isFinite(snap.torsoLeanAngle)) push(Math.max(0, Math.abs(snap.torsoLeanAngle) - 12), ['Stay taller through your lift.', 'Keep your torso stacked over your hips.']);
            // Foot pop (target >=2 px)
            if (Number.isFinite(snap.footLiftPx)) push(Math.max(0, 2 - snap.footLiftPx), ['Add a little upward pop as you snap.']);
            // Centering (target |offset| <= 90 px)
            if (Number.isFinite(snap.frameOffsetX)) push(Math.max(0, Math.abs(snap.frameOffsetX) - 90), ['Center your body line with the rim before you shoot.']);

            if (cand.length) {
                cand.sort((a, b) => b.sev - a.sev);
                return choose(cand[0].lines);
            }

            // Prioritized corrections
            if (snap.releaseAboveShoulder === false)
                return choose([
                    'Raise the release above your shoulder line.',
                    'Get the wrist above the shoulder at release.',
                    'Finish higher - above the shoulder line.'
                ]);

            if (Number.isFinite(snap.elbowExtDeg) && snap.elbowExtDeg < 145)
                return choose([
                    'Finish with stronger arm extension.',
                    'Straighten the elbow through the snap.',
                    'Drive the elbow to a straighter finish.'
                ]);

            if (Number.isFinite(snap.armVerticalityDeg) && snap.armVerticalityDeg > 14)
                return choose([
                    'Get the forearm more vertical at release.',
                    'Reach up - taller arm on the finish.',
                    'Lift the forearm closer to vertical.'
                ]);

            if (Number.isFinite(snap.stanceRatio) && (snap.stanceRatio < 0.95 || snap.stanceRatio > 1.55))
                return snap.stanceRatio < 1 ?
                    choose(['Wider base; feet shoulder‑width apart.', 'Open your stance to shoulder‑width.']) :
                    choose(['Narrow your stance slightly for balance.', 'Bring feet in a touch toward shoulder‑width.']);

            if (Number.isFinite(snap.feetToHoopDeg) && snap.feetToHoopDeg > 24)
                return choose(['Square your feet a bit more to the rim.', 'Point your toes a touch more toward the basket.']);

            if (Number.isFinite(snap.torsoLeanAngle) && Math.abs(snap.torsoLeanAngle) > 14)
                return choose(['Stay taller through your lift.', 'Keep your torso stacked over your hips.']);

            if (Number.isFinite(snap.footLiftPx) && snap.footLiftPx < 2)
                return choose(['Add a little upward pop as you snap.', 'Extend through the ankles for a light lift.']);

            if (Number.isFinite(snap.frameOffsetX) && Math.abs(snap.frameOffsetX) > 90)
                return choose(['Center your body line with the rim before you shoot.', 'Square your chest to the rim before lifting.']);

            // Positive reinforcement when improvements vs average are detected
            try {
                if (Number.isFinite(pAvg.armVertDeg) && Number.isFinite(snap.armVerticalityDeg) && snap.armVerticalityDeg < pAvg.armVertDeg - 4)
                    return choose(['Better arm verticality - keep that feel.', 'Nice tall finish - keep reaching up.']);
                if (Number.isFinite(pAvg.elbowExtDeg) && Number.isFinite(snap.elbowExtDeg) && snap.elbowExtDeg > pAvg.elbowExtDeg + 4)
                    return choose(['Stronger extension - good snap.', 'Great elbow finish - keep extending.']);
                if (Number.isFinite(pAvg.stanceRatio) && Number.isFinite(snap.stanceRatio) && Math.abs(snap.stanceRatio - 1.2) < Math.abs(pAvg.stanceRatio - 1.2) - 0.1)
                    return choose(['More stable base - nice adjustment.', 'Better stance width - keep that.']);
            } catch { }

            return choose(['Good release - hold your follow‑through.', 'Solid form - keep that finish high.']);
        } catch { return 'Good release - hold your follow‑through.'; }
    }

    // ---- Developer helper: inspect live pose + last snapshot/gate ----
    try {
        if (typeof window.dumpPoseData !== 'function') {
            window.dumpPoseData = function dumpPoseData() {
                try {
                    const now = Date.now();
                    const ps = window.playerState || {};
                    const keypoints = Array.isArray(ps.keypoints) ? ps.keypoints : [];
                    const lastTs = Number(window.__lastPoseTS || 0);
                    const lastGate = window.__LAST_GATE?.detail?.tests || null;
                    const lastShot = (Array.isArray(window.__shotList) && window.__shotList.length) ? window.__shotList.at(-1) : null;
                    const lastHist = (Array.isArray(window.__poseHistory) && window.__poseHistory.length) ? window.__poseHistory.at(-1).snap : null;
                    const hoop = window.getLockedHoopBox?.() || null;
                    const snap = (function () { try { return __getPoseSnapshot(); } catch { return null; } })();
                    const data = {
                        poseDetectorReady: !!window.poseDetector,
                        keypointCount: keypoints.length,
                        lastPoseAgeMs: lastTs ? (now - lastTs) : null,
                        frameHistoryLen: Array.isArray(ps.frameHistory) ? ps.frameHistory.length : 0,
                        hoopLocked: !!hoop,
                        lastGate,
                        snapshot: snap,
                        lastShotPoseSnapshot: lastShot?.poseSnapshot || null,
                        lastHistorySnapshot: lastHist || null,
                    };
                    console.log('[pose:dump]', data);
                    return data;
                } catch (e) { console.warn('[pose:dump:error]', e); return null; }
            };
        }
    } catch { }

    // ---- Visual overlay: show release pose metrics for quick validation ----
    function showPoseMetricsOverlay(snap, ms = 1800) {
        try {
            const root = (typeof window.ensureHudRoot === 'function') ? window.ensureHudRoot() : (document.getElementById('hudRoot') || (function () { const d = document.createElement('div'); d.id = 'hudRoot'; Object.assign(d.style, { position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: 10000 }); document.body.appendChild(d); return d; })());
            let box = document.getElementById('poseMetricsHUD');
            if (!box) {
                box = document.createElement('div'); box.id = 'poseMetricsHUD';
                Object.assign(box.style, {
                    position: 'absolute', left: '50%', top: '14%', transform: 'translateX(-50%)',
                    background: 'rgba(0,0,0,0.78)', color: '#fff', padding: '10px 12px',
                    border: '1px solid rgba(255,255,255,0.15)', borderRadius: '10px',
                    font: '600 12px system-ui, -apple-system, Segoe UI, Arial',
                    pointerEvents: 'none', zIndex: 10030, minWidth: '240px', textAlign: 'center',
                    boxShadow: '0 10px 30px rgba(0,0,0,.35)'
                });
                root.appendChild(box);
            }
            const f = (n, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : '-');
            const yesNo = (v) => (v === true ? 'Yes' : (v === false ? 'No' : '-'));
            const html = `
        <div style="font-weight:700; margin-bottom:6px;">Release Pose</div>
        <div style="display:grid; grid-template-columns:auto auto; gap:4px 10px; text-align:left;">
          <div>Arm verticality</div><div>${f(snap.armVerticalityDeg, 0)}°</div>
          <div>Elbow extension</div><div>${f(snap.elbowExtDeg, 0)}°</div>
          <div>Release > shoulder</div><div>${yesNo(snap.releaseAboveShoulder)}</div>
          <div>Stance ratio</div><div>${f(snap.stanceRatio, 2)}×</div>
          <div>Feet -> rim</div><div>${f(snap.feetToHoopDeg, 0)}°</div>
          <div>Torso lean</div><div>${f(snap.torsoLeanAngle, 0)}°</div>
          <div>Foot pop</div><div>${f(snap.footLiftPx, 0)} px</div>
          <div>Center offset X</div><div>${f(snap.frameOffsetX, 0)} px</div>
        </div>`;
            box.innerHTML = html;
            box.style.opacity = '1'; box.style.display = 'block';
            if (box.__t) clearTimeout(box.__t);
            box.__t = setTimeout(() => { try { box.style.opacity = '0'; box.style.display = 'none'; } catch { } }, ms);
        } catch { }
    }

    try {
        if (!window.__coachReleaseWired) {
            window.__coachReleaseWired = true;
            // Fire on strict shot release events (mark seen + reset cooldown first)
            window.addEventListener('shot:release', () => { try { if (window.DOACH_RELEASE_TRACE === true) console.log('[coach:evt] shot:release'); } catch { } try { window.__COACH_HAS_RELEASE = true; window.__COACH_TIP_LAST_AT = 0; } catch { } try { if (window.DOACH_RELEASE_TRACE === true) console.log('[coach:evt] shot:release'); } catch { } assessPoseAndSpeak('shot:release'); });
            // Fallback: if HUD increments shot counter but release speak didn't happen (timing), speak once
            window.addEventListener('hud:shot-taken', () => {
                try {
                    if (window.__shotTrackingArmed !== true || window.__hoopConfirmed !== true) return;
                    const now = performance.now();
                    const last = Number(window.__COACH_LAST_REL_SPEAK || 0);
                    if (window.DOACH_RELEASE_TRACE === true) { try { console.log('[coach:evt] hud:shot-taken', { now, last }); } catch { } }
                    if (now - last < 500) return; // release path already spoke
                    assessPoseAndSpeak('shot:release');
                } catch { }
            });
            // Additional fallback: when HUD score trips but no release event yet, provide a quick tip
            window.addEventListener('hud:score-trip', async () => {
                try {
                    if (window.__shotTrackingArmed !== true || window.__hoopConfirmed !== true) return;
                    const now = performance.now(); if (window.DOACH_RELEASE_TRACE === true) { try { console.log('[coach:evt] hud:score-trip'); } catch { } }
                    const last = Number(window.__COACH_LAST_REL_SPEAK || 0);
                    if (now - last < 700) return;
                    let s = __getPoseSnapshot();
                    if (!s && typeof __samplePoseSnapshotNow === 'function') { try { s = await __samplePoseSnapshotNow(); } catch { } }
                    if (s) {
                        try { showPoseMetricsOverlay?.(s, Number(window.POSE_METRICS_MS || 1800)); } catch { }
                        speakWithAIOrRules(s, 'hud:score-trip');
                        try { window.__COACH_LAST_REL_SPEAK = now; } catch { }
                    }
                } catch { }
            });
            // Also fire when the HUD/score trip increments (our unified gate for visuals)
            // (No voice on these any more; UI only)
            // window.addEventListener('hud:score-trip', () => assessPoseAndSpeak('hud:score-trip'));
            // window.addEventListener('hud:shot-taken', () => assessPoseAndSpeak('hud:shot-taken'));
            // Add a secondary chance to speak on final summary (per shot)
            // window.addEventListener('shot:summary', () => assessPoseAndSpeak('shot:summary'));
            // Removed pose:release voice; rely strictly on shot:release + summary to avoid pre-shot chatter
            // Per-shot reset so the next summary/tip is not suppressed
            window.addEventListener('shot:release', () => { try { if (window.DOACH_RELEASE_TRACE === true) console.log('[coach:evt] shot:release'); } catch { } try { __lastSpokenKey = null; window.__COACH_TIP_LAST_AT = 0; } catch { } });
            window.addEventListener('hud:shot-taken', () => { try { __lastSpokenKey = null; window.__COACH_TIP_LAST_AT = 0; } catch { } });
        }
    } catch { }


    // Get the display name for addressing the user
    function getDisplayName() {
        try {
            return window.__USER_NAME || localStorage.getItem('firstname') || 'Player';
        } catch {
            return window.__USER_NAME || 'Player';
        }
    }

    const name = getDisplayName();


    // ---- Session end summary (aggregate pose notes + per‑metric trends) ----
    function summarizeSessionPose() {
        try {
            const list = Array.isArray(window.__shotList) ? window.__shotList : [];
            if (!list.length) return;

            // Helper: safe average over numeric values
            const avg = (arr) => {
                const a = arr.filter(Number.isFinite);
                return a.length ? (a.reduce((s, v) => s + v, 0) / a.length) : null;
            };
            const round = (n, p = 0) => Number.isFinite(n) ? Number(n.toFixed(p)) : null;

            // Collect snapshots with indices
            const snaps = list.map((s, i) => ({ i: i + 1, snap: s.poseSnapshot || null })).filter(x => !!x.snap);
            if (!snaps.length) return;

            // Split into early / late halves to detect trends
            const mid = Math.max(1, Math.floor(snaps.length / 2));
            const early = snaps.slice(0, mid).map(x => x.snap);
            const late = snaps.slice(mid).map(x => x.snap);

            const pick = (arr, key) => avg(arr.map(s => s?.[key]).filter(Number.isFinite));
            const pickBoolPct = (arr, key) => {
                const vals = arr.map(s => (typeof s?.[key] === 'boolean') ? (s[key] ? 1 : 0) : null).filter(v => v != null);
                return vals.length ? (100 * vals.reduce((a, b) => a + b, 0) / vals.length) : null;
            };

            const E = {
                kneeFlex: pick(early, 'kneeFlex'), armVert: pick(early, 'armVerticalityDeg'), elbow: pick(early, 'elbowExtDeg'),
                toes: pick(early, 'toeToHoopDeg'), feetDiff: pick(early, 'feetAngleDiff'), stagger: pick(early, 'footStagger'),
                hold: pick(early, 'followThroughHoldFrames'), head: pick(early, 'headToHoopDeg'), fingers: pickBoolPct(early, 'fingersDown')
            };
            const L = {
                kneeFlex: pick(late, 'kneeFlex'), armVert: pick(late, 'armVerticalityDeg'), elbow: pick(late, 'elbowExtDeg'),
                toes: pick(late, 'toeToHoopDeg'), feetDiff: pick(late, 'feetAngleDiff'), stagger: pick(late, 'footStagger'),
                hold: pick(late, 'followThroughHoldFrames'), head: pick(late, 'headToHoopDeg'), fingers: pickBoolPct(late, 'fingersDown')
            };

            const trends = [];
            // Improvements: knee flex (higher better)
            if (Number.isFinite(E.kneeFlex) && Number.isFinite(L.kneeFlex) && (L.kneeFlex - E.kneeFlex) >= 6)
                trends.push(`Knee flex improved late (${round(L.kneeFlex)}° vs ${round(E.kneeFlex)}°).`);
            // Arm verticality (lower is better)
            if (Number.isFinite(E.armVert) && Number.isFinite(L.armVert) && (E.armVert - L.armVert) >= 4)
                trends.push(`Arm finished taller (vertical) late (${round(L.armVert)}° vs ${round(E.armVert)}°).`);
            // Elbow extension (higher better)
            if (Number.isFinite(E.elbow) && Number.isFinite(L.elbow) && (L.elbow - E.elbow) >= 5)
                trends.push(`Elbow extension strengthened (${round(L.elbow)}° vs ${round(E.elbow)}°).`);
            // Toes -> hoop (lower better)
            if (Number.isFinite(E.toes) && Number.isFinite(L.toes) && (E.toes - L.toes) >= 5)
                trends.push(`Feet more square to rim (${round(L.toes)}° vs ${round(E.toes)}°).`);
            // Feet angle diff (lower better)
            if (Number.isFinite(E.feetDiff) && Number.isFinite(L.feetDiff) && (E.feetDiff - L.feetDiff) >= 5)
                trends.push(`Toe angles more parallel (${round(L.feetDiff)}° vs ${round(E.feetDiff)}°).`);
            // Foot stagger (lower better)
            if (Number.isFinite(E.stagger) && Number.isFinite(L.stagger) && (E.stagger - L.stagger) >= 6)
                trends.push(`Stance stagger reduced (${round(L.stagger)}px vs ${round(E.stagger)}px).`);
            // Follow-through hold (higher better)
            if (Number.isFinite(E.hold) && Number.isFinite(L.hold) && (L.hold - E.hold) >= 1)
                trends.push(`Better follow‑through hold late (${round(L.hold)} vs ${round(E.hold)} frames).`);
            // Head on rim (lower better)
            if (Number.isFinite(E.head) && Number.isFinite(L.head) && (E.head - L.head) >= 6)
                trends.push(`Gaze held on rim more consistently (${round(L.head)}° vs ${round(E.head)}°).`);
            // Fingers down (higher % better)
            if (Number.isFinite(E.fingers) && Number.isFinite(L.fingers) && (L.fingers - E.fingers) >= 20)
                trends.push(`Wrist snap improved - fingers down more often (${round(L.fingers)}% vs ${round(E.fingers)}%).`);

            // Most limiting metrics vs simple targets across whole session
            const all = snaps.map(x => x.snap);
            const A = (key) => avg(all.map(s => s?.[key]).filter(Number.isFinite));
            const P = (key) => pickBoolPct(all, key);
            const lim = [];
            const armVert = A('armVerticalityDeg'); if (Number.isFinite(armVert) && armVert > 14) lim.push('Get the forearm more vertical on finish.');
            const elbow = A('elbowExtDeg'); if (Number.isFinite(elbow) && elbow < 150) lim.push('Finish with stronger elbow extension.');
            const knee = A('kneeFlex'); if (Number.isFinite(knee) && knee < 28) lim.push('Add a bit more knee bend for power.');
            const toes = A('toeToHoopDeg'); if (Number.isFinite(toes) && toes > 22) lim.push('Square toes a touch more to the rim.');
            const fDiff = A('feetAngleDiff'); if (Number.isFinite(fDiff) && fDiff > 12) lim.push('Make your toes more parallel.');
            const holdF = A('followThroughHoldFrames'); if (Number.isFinite(holdF) && holdF < 2) lim.push('Hold the follow‑through briefly.');
            const gaze = A('headToHoopDeg'); if (Number.isFinite(gaze) && gaze > 25) lim.push('Keep eyes on the rim through release.');
            const above = P('releaseAboveShoulder'); if (Number.isFinite(above) && above < 70) lim.push('Release above the shoulder line.');

            const lines = [];
            if (trends.length) lines.push('Improvements: ' + trends.slice(0, 3).join(' '));
            if (lim.length) lines.push('Focus next: ' + lim.slice(0, 3).join(' '));
            if (!lines.length) lines.push(`${name} 'your form is consistent - keep the rhythm and balance.'`);

            // Shot-specific groups (enumerate where key cues were off)
            try {
                const list = Array.isArray(window.__shotList) ? window.__shotList : [];
                const shots = list.map((s, i) => ({ idx: i + 1, p: (s && s.poseSnapshot) || null })).filter(x => !!x.p);
                if (shots.length) {
                    const g = (window.DOACH_MEM?.get?.()?.golden) || { stanceWidthFeet: 120, kneeFlex: 28, toeToHoopDeg: 18, feetAngleDiff: 8, feetStagger: 6, shoulderToWristAngle: 55, releaseAboveShoulder: true };
                    const pickIdx = (pred) => shots.filter(({ p }) => pred(p)).map(({ idx }) => idx);
                    const fmt = (arr) => arr.slice(0, 6).join(', ');
                    const followShort = pickIdx(p => Number.isFinite(p.followThroughHoldFrames) && p.followThroughHoldFrames < 2);
                    const feetNarrow = pickIdx(p => Number.isFinite(p.stanceWidthFeet) && g.stanceWidthFeet && (p.stanceWidthFeet < g.stanceWidthFeet - 20));
                    const feetWide = pickIdx(p => Number.isFinite(p.stanceWidthFeet) && g.stanceWidthFeet && (p.stanceWidthFeet > g.stanceWidthFeet + 20));
                    const toesOff = pickIdx(p => (Number.isFinite(p.toeToHoopDeg) && p.toeToHoopDeg > 22) || (Number.isFinite(p.feetAngleDiff) && p.feetAngleDiff > (g.feetAngleDiff || 8) + 6));
                    const staggerHi = pickIdx(p => Number.isFinite(p.footStagger) && p.footStagger > (g.feetStagger || 6) + 10);
                    const armLow = pickIdx(p => (Number.isFinite(p.shoulderToWristAngle) && p.shoulderToWristAngle < (g.shoulderToWristAngle || 55) - 8) || (Number.isFinite(p.armVerticalityDeg) && p.armVerticalityDeg > 14));
                    const elbowLow = pickIdx(p => Number.isFinite(p.elbowExtDeg) && p.elbowExtDeg < 150);
                    const belowSh = pickIdx(p => (g.releaseAboveShoulder ?? true) && p.releaseAboveShoulder === false);
                    const kneeLow = pickIdx(p => Number.isFinite(p.kneeFlex) && p.kneeFlex < (g.kneeFlex || 28) * 0.75);
                    const gazeOff = pickIdx(p => Number.isFinite(p.headToHoopDeg) && p.headToHoopDeg > 25);

                    const bullets = [];
                    if (followShort.length) bullets.push(`Follow‑through short on shots ${fmt(followShort)} - hold 1-2 beats longer.`);
                    if (feetNarrow.length) bullets.push(`Base narrow on shots ${fmt(feetNarrow)} - widen a touch.`);
                    if (feetWide.length) bullets.push(`Base wide on shots ${fmt(feetWide)} - narrow slightly.`);
                    if (toesOff.length) bullets.push(`Toes off-square on shots ${fmt(toesOff)} - align feet to rim.`);
                    if (staggerHi.length) bullets.push(`Feet staggered on shots ${fmt(staggerHi)} - level your base.`);
                    if (armLow.length) bullets.push(`Arm line low on shots ${fmt(armLow)} - finish taller.`);
                    if (elbowLow.length) bullets.push(`Elbow not fully extended on shots ${fmt(elbowLow)} - lock out at finish.`);
                    if (belowSh.length) bullets.push(`Release below shoulder on shots ${fmt(belowSh)} - finish above shoulder.`);
                    if (kneeLow.length) bullets.push(`Limited knee bend on shots ${fmt(kneeLow)} - add a bit more power.`);
                    if (gazeOff.length) bullets.push(`Gaze off rim on shots ${fmt(gazeOff)} - keep eyes on rim through release.`);

                    if (bullets.length) {
                        lines.push('Notable patterns: ' + bullets.slice(0, 3).join(' '));
                    }
                }
            } catch { }

            // Always deliver the session review regardless of DOACH_ONLY_REALTIME.
            const out = `Session review. ${lines.join(' ')}`;
            try { window.__lastCoachText = out; } catch { }
            try { setCoachNotesContent(out, { zIndex: 10070, force: true }); } catch { }
            try {
                window.dispatchEvent(new CustomEvent('doach:session-review', {
                    detail: { summary: out, lines, trends, limiting: lim }
                }));
            } catch { }
            try {
                (window.doachSpeak || window.coachSpeak)?.(out);
                window.__SESSION_REVIEW_SPOKEN = true;
            } catch { }
            try {
                if (!window.__NEW_SESSION_PROMPTED) {
                    window.__NEW_SESSION_PROMPTED = true;
                    window.requestNewSessionPrompt?.();
                }
            } catch { }
        } catch { }
    }

    // Auto speak summary when HUD ends a session
    try {
        window.addEventListener('hud:end-session', () => {
            // Allow a moment so the last summary + snapshots settle and audio finish
            setTimeout(() => { try { summarizeSessionPose(); } catch { } }, 1200);
            // Failsafe: if nothing spoke yet, try again a bit later
            setTimeout(() => { try { if (!window.__SESSION_REVIEW_SPOKEN) summarizeSessionPose(); } catch { } }, 2500);
        });
        // Enable live tips when armed (force on, every shot)
        window.addEventListener('hud:armed', () => {
            try { window.PREF_LIVE_TIPS = true; } catch { }
            try { window.COACH_TIP_EVERY_N = 1; } catch { }
            try { window.COACH_TIP_PROB = 1.0; } catch { }
            try { window.COACH_TIP_MIN_MS = 200; } catch { }
        });
        // Reset tip cooldown per shot so every shot can speak
        window.addEventListener('hud:shot-taken', () => { try { window.__COACH_TIP_LAST_AT = 0; } catch { } });
        window.addEventListener('shot:summary', () => { try { window.__COACH_TIP_LAST_AT = 0; } catch { } });
        // Optional kickoff line on countdown (disabled by default)
        window.addEventListener('hud:arm-countdown', () => { try { if (window.PREF_COACH_INTRO === true) coachSpeak("Let's get started. Get into position and shoot when ready."); } catch { } });
    } catch { }

    // ---- Pref bridges (new) ----
    // Read new UI prefs if present; fall back to older doachPrefs values.
    function isAudioOn() {
        if (typeof window.PREF_AUDIO_ENABLED !== 'undefined') return !!window.PREF_AUDIO_ENABLED;
        const p = doachGetPrefs();                 // legacy store
        return (p.audioOn !== false);              // default true
    }
    function isMicAllowed() {
        if (typeof window.PREF_ALLOW_MIC !== 'undefined') return !!window.PREF_ALLOW_MIC;
        const p = doachGetPrefs();
        return (p.allowMic !== false);             // default true
    }


    // ---------- Prefs + Presets ----------
    const LS_KEY = 'doachPrefs';

    const getAC = () => (window.__doachAC ||= new (window.AudioContext || window.webkitAudioContext)());


    function doachGetPrefs() {
        try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; }
        catch { return {}; }
    }

    function doachSetPrefs(p) {
        const v = p || {};
        localStorage.setItem(LS_KEY, JSON.stringify(v));
        window.__doachPrefs = v;
        return v;
    }

    //  Doach Memory   ------------------------------------- //
    const MEM_KEY = 'doachMemoryV1';

    function memLoad() {
        try { return JSON.parse(localStorage.getItem(MEM_KEY)) || { made: [], miss: [], golden: null, lastShot: null }; }
        catch { return { made: [], miss: [], golden: null, lastShot: null }; }
    }
    function memSave(m) { localStorage.setItem(MEM_KEY, JSON.stringify(m)); return m; }
    function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }
    function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

    function computeGolden(made) {
        if (!made.length) return null;
        const take = made.slice(-30); // last N made shots
        const pick = k => take.map(s => s.poseSnapshot?.[k]).filter(v => Number.isFinite(v));
        const g = {
            stanceWidth: mean(pick('stanceWidth')),
            stanceWidthFeet: mean(pick('stanceWidthFeet')),
            kneeFlex: mean(pick('kneeFlex')),
            torsoLeanAngle: mean(pick('torsoLeanAngle')),
            shoulderToWristAngle: mean(pick('shoulderToWristAngle')),
            feetAngleDiff: mean(pick('feetAngleDiff')),
            feetStagger: mean(pick('feetStagger')),
            releaseAboveShoulder: take.filter(s => s.poseSnapshot?.releaseAboveShoulder).length / take.length >= 0.6,
            entryAngle: mean(take.map(s => s.entryAngle).filter(Number.isFinite)),
            arcHeight: mean(take.map(s => s.arcHeight).filter(Number.isFinite)),
            arcHeightNorm: mean(take.map(s => s.arcHeightNorm).filter(Number.isFinite)),
            apexRiseFromRelease: mean(take.map(s => s.apexRiseFromRelease).filter(Number.isFinite)),
            apexRiseFromReleaseNorm: mean(take.map(s => s.apexRiseFromReleaseNorm).filter(Number.isFinite)),
            count: take.length
        };
        return g;
    }

    function addShotToMemory(shot) {
        shot.ts = shot.ts || Date.now();
        const m = memLoad();
        m.lastShot = shot;
        if (shot.made) m.made.push(shot);
        else m.miss.push(shot);
        // trim
        if (m.made.length > 200) m.made = m.made.slice(-200);
        if (m.miss.length > 200) m.miss = m.miss.slice(-200);
        m.golden = computeGolden(m.made) || m.golden;
        memSave(m);
        return m;
    }

    window.DOACH_MEM = {
        get: memLoad,
        addShot: addShotToMemory,
        golden: () => memLoad().golden,
        reset: () => memSave({ made: [], miss: [], golden: null, lastShot: null }),
        lastShot: () => memLoad().lastShot,
        recent: (n = 10) => {
            const m = memLoad();
            const all = [...m.made, ...m.miss].filter(Boolean).sort((a, b) => (a.ts || 0) - (b.ts || 0));
            return all.slice(-n);
        },
        reset: () => memSave({ made: [], miss: [], golden: null, lastShot: null })
    };

    // Receives native transcripts (from the iOS wrapper)
    window.handleVoiceTranscript = async (text) => {
        const lower = (text || '').toLowerCase();
        // Reuse your wake-word/capture logic, or just route to your Q&A:
        try {
            if (/\b(end (the )?session|i'?m done|finish session)\b/.test(lower)) {
                window.dispatchEvent(new CustomEvent('hud:end-session'));
                return;
            }
            if (/\b(start (a )?new session|new session|begin session|start session)\b/.test(lower)) {
                if (typeof window.beginLiveSession === 'function') {
                    window.beginLiveSession({ via: 'voice-transcript' });
                } else {
                    window.dispatchEvent(new CustomEvent('hud:start-session'));
                }
                return;
            }
            const awaiting = (() => { try { return window.__AWAITING_NEW_SESSION_CONFIRM === true; } catch { return false; } })();
            const startOverlayVisible = (() => {
                try {
                    const el = document.getElementById('startSessionOverlay');
                    if (!el) return false;
                    if (el.hidden === true) return false;
                    const style = window.getComputedStyle ? window.getComputedStyle(el) : el.style;
                    if (!style) return true;
                    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
                } catch { return false; }
            })();
            const affirmative = /\b(yes|yeah|yep|sure|let('?|’)s go|let us go|go ahead|absolutely|yup)\b/;
            const wantsStart = lower.includes('start session') || lower.includes('start a new session') || lower.includes('new session');
            if ((awaiting || startOverlayVisible) && (affirmative.test(lower) || wantsStart)) {
                if (typeof window.beginLiveSession === 'function') {
                    window.beginLiveSession({ via: 'voice-affirm' });
                } else {
                    window.dispatchEvent(new CustomEvent('hud:start-session'));
                }
                return;
            }
        } catch { }
        if (doachSpeak) coachSpeak(`You said: ${text}`);
        // window.webkit?.messageHandlers?.doach?.postMessage({action: 'startVoice'})
    };

    // Export on window
    window.doachGetPrefs = doachGetPrefs;
    window.doachSetPrefs = doachSetPrefs;

    function getPrefs() { try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch { return {}; } }
    function setPrefs(p) { localStorage.setItem(LS_KEY, JSON.stringify(p)); window.__doachPrefs = p; return p; }

    async function loadPresets() {
        try { const r = await fetch('/api/voice_presets'); if (!r.ok) throw 0; const j = await r.json(); return Array.isArray(j.presets) ? j.presets : []; }
        catch { try { return JSON.parse(localStorage.getItem(LS_PRESETS)) || []; } catch { return []; } }
    }
    async function savePreset(preset) {
        try { const r = await fetch('/api/voice_presets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ preset }) }); if (!r.ok) throw 0; return true; }
        catch { const a = await loadPresets(); const i = a.findIndex(x => x.name === preset.name); if (i >= 0) a[i] = preset; else a.push(preset); localStorage.setItem(LS_PRESETS, JSON.stringify(a)); return true; }
    }
    async function deletePreset(name) {
        try { const r = await fetch('/api/voice_presets/' + encodeURIComponent(name), { method: 'DELETE' }); if (!r.ok) throw 0; return true; }
        catch { const a = await loadPresets(); localStorage.setItem(LS_PRESETS, JSON.stringify(a.filter(x => x.name !== name))); return true; }
    }
    window.doachLoadPresets = loadPresets; window.doachSavePreset = savePreset; window.doachDeletePreset = deletePreset;


    // a better robot ----------------------------------------- //
    // --- Natural coaching line generator (varied, metric-aware)
    function seededRandom(seed) { const x = Math.sin(seed * 9301 + 49297) * 233280; return x - Math.floor(x); }
    function pick(arr, seed) { return arr[Math.floor(seededRandom(seed) * arr.length)] || arr[0]; }

    function craftPoseLine(shot, golden, opts = {}) {
        const issues = buildIssues(shot, golden);
        const chosen = chooseCue(issues);
        const base = chosen ? chosen.msg : 'Pose metrics captured. Focus on a tall, balanced release.';
        if (opts.bumpSeed) {
            return base;
        }
        return base;
    }

    function craftCoachingLine(shot, golden, opts = {}) {
        return craftPoseLine(shot, golden, opts);
    }

    function craftMissLine(shot, golden, opts = {}) {
        return craftPoseLine(shot, golden, opts);
    }

    // ---- Issue builder with severity + category (new)
    function buildIssues(shot, golden) {
        const p = shot?.poseSnapshot || {};
        const g = golden || {
            stanceWidthFeet: 120, kneeFlex: 28, torsoLeanAngle: 0, shoulderToWristAngle: 55,
            feetAngleDiff: 8, feetStagger: 6, releaseAboveShoulder: true, entryAngle: 48, arcHeight: 120
        };

        const issues = [];
        const push = (cat, severity, msg) => { if (severity > 0) issues.push({ cat, severity, msg }); };

        // Feet width
        if (Number.isFinite(p.stanceWidthFeet) && g.stanceWidthFeet) {
            const d = (p.stanceWidthFeet - g.stanceWidthFeet);
            const ad = Math.abs(d);
            if (ad > 35) push('feetWidth', 9, d < 0 ? 'Feet too narrow - widen ~2-3".' : 'Feet too wide - bring them in slightly.');
            else if (ad > 20) push('feetWidth', 6, d < 0 ? 'Open your base a touch for balance.' : 'Narrow your base slightly to stay stacked.');
        }

        // Feet alignment / stagger
        if (Number.isFinite(p.feetAngleDiff)) {
            const over = p.feetAngleDiff - (g.feetAngleDiff || 8);
            if (over > 10) push('feetAngle', 7, 'Square both toes to the rim.');
            else if (over > 5) push('feetAngle', 5, 'Make your toes more parallel.');
        }
        if (Number.isFinite(p.feetStagger)) {
            const over = p.feetStagger - (g.feetStagger || 6);
            if (over > 16) push('feetStagger', 6, 'Level your feet - reduce the front/back stagger.');
            else if (over > 10) push('feetStagger', 4, 'Even out your stance front-to-back.');
        }

        // Lower-body power
        if (Number.isFinite(p.kneeFlex)) {
            const ratio = p.kneeFlex / (g.kneeFlex || 28);
            if (ratio < 0.6) push('power', 10, 'Add more knee bend to generate power.');
            else if (ratio < 0.8) push('power', 7, 'Dip a touch more with the knees.');
        }

        // Torso lean
        if (Number.isFinite(p.torsoLeanAngle)) {
            const a = Math.abs(p.torsoLeanAngle);
            if (a > 22) push('torso', 6, 'Stay taller through the lift.');
            else if (a > 18) push('torso', 4, 'Slightly more upright through the shot.');
        }

        // Arm / release
        if (Number.isFinite(p.shoulderToWristAngle)) {
            const d = (g.shoulderToWristAngle || 55) - p.shoulderToWristAngle;
            if (d > 12) push('releaseArm', 8, 'Get the shooting arm more vertical on release.');
            else if (d > 6) push('releaseArm', 5, 'Finish with a taller arm line.');
        }
        if ((g.releaseAboveShoulder ?? true) && !p.releaseAboveShoulder) {
            push('releaseHeight', 7, 'Release above your shoulder line.');
        }
        if (p.wristY != null && p.elbowY != null && p.wristY > p.elbowY + 10) {
            push('wristFinish', 6, 'Snap the wrist high - finish above the elbow.');
        }

        // Ball metrics
        if (Number.isFinite(shot.entryAngle) && g.entryAngle) {
            const d = shot.entryAngle - g.entryAngle;
            if (d < -6) push('entryFlat', 9, 'Entry angle is flat - add arc.');
            else if (d > 6) push('entrySteep', 7, 'Entry angle is steep - soften the arc.');
        } else if (Number.isFinite(shot.entryAngle)) {
            if (shot.entryAngle < 44) push('entryFlat', 8, 'A bit flat - add arc.');
            else if (shot.entryAngle > 54) push('entrySteep', 6, 'A tad steep - soften the arc.');
        }

        // arc height vs golden
        if (Number.isFinite(shot.arcHeight) && g.arcHeight) {
            const d = shot.arcHeight - g.arcHeight;
            if (d < -20) push('arcLow', 6, 'Lift the arc slightly (more upward energy).');
            else if (d > 30) push('arcHigh', 4, 'Flatten the arc a touch (drive forward).');
        }

        // apex rise vs golden (power on release)
        if (Number.isFinite(shot.apexRiseFromRelease) && g.apexRiseFromRelease) {
            const d = shot.apexRiseFromRelease - g.apexRiseFromRelease;
            if (d < -18) push('powerLow', 9, 'Add power on release - drive up through the ball.');
            else if (d < -10) push('powerLow', 6, 'A touch more upward energy on release.');
        }
        if (Number.isFinite(shot.apexRiseFromReleaseNorm) && g.apexRiseFromReleaseNorm) {
            const d = shot.apexRiseFromReleaseNorm - g.apexRiseFromReleaseNorm;
            if (d < -0.15) push('powerLow', 9, 'Increase lift - get more rise before the apex.');
        }

        // Sort by severity descending
        issues.sort((a, b) => b.severity - a.severity);
        return issues;
    }

    // Pick a cue with variety (avoid repeating same category)
    function chooseCue(issues) {
        if (!issues.length) return null;
        const hist = (window.__coachCueHistory ||= []);
        const lastCat = hist[hist.length - 1];
        let pick = issues[0];

        // If top issue repeats last category and we have alternatives, pick next best
        if (issues.length > 1 && pick.cat === lastCat) pick = issues[1];

        // Track history (cap)
        hist.push(pick.cat);
        if (hist.length > 6) window.__coachCueHistory = hist.slice(-6);

        return pick;
    }

    // Light variety wrappers
    // keep a tiny history so we don't repeat exact lines back-to-back
    window.__coachLineHistory = [];
    function avoidRepeat(text, shot, golden, made) {
        const recent = window.__coachLineHistory.slice(-4);
        if (recent.includes(text)) {
            return (made ? craftCoachingLine : craftMissLine)(shot, golden, { bumpSeed: true });
        }
        return text;
    }

    // ---------- Web Speech voices ----------
    let webVoices = [];
    function refreshVoices() { webVoices = window.speechSynthesis?.getVoices?.() || []; return webVoices; }
    if ('speechSynthesis' in window) { speechSynthesis.onvoiceschanged = refreshVoices; refreshVoices(); }
    window.doachListWebVoices = (lang = '') => {
        const v = refreshVoices();
        return lang ? v.filter(x => (x.lang || '').toLowerCase().startsWith(lang.toLowerCase())) : v;
    };

    // ---------- OpenAI TTS + WebAudio EQ ----------
    async function ttsFetchBlob(text, voice) {
        const res = await fetch(DOACH.ttsEndpoint, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, voice: voice || 'alloy' }),
            credentials: 'include'
        });
        if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`TTS failed: ${res.status} ${t}`.trim()); }
        return await res.blob();
    }
    async function playWithEQ(blob, p) {
        const ctx = getAC();
        const arr = await blob.arrayBuffer();
        const buf = await ctx.decodeAudioData(arr);
        const src = ctx.createBufferSource(); src.buffer = buf;

        const bass = ctx.createBiquadFilter(); bass.type = 'lowshelf'; bass.frequency.value = 180; bass.gain.value = p?.bassDb ?? 0;
        const tre = ctx.createBiquadFilter(); tre.type = 'highshelf'; tre.frequency.value = 3000; tre.gain.value = p?.trebleDb ?? 0;
        const gain = ctx.createGain(); gain.gain.value = p?.volume ?? 1;

        src.playbackRate.value = p?.speed ?? 1;
        src.connect(bass); bass.connect(tre); tre.connect(gain); gain.connect(ctx.destination);
        src.start(0);
        return new Promise(r => src.onended = r);
    }

    // ---------- Web Speech playback ----------
    async function speakWeb(text, p) {
        if (!('speechSynthesis' in window)) throw new Error('Web Speech not supported');
        const u = new SpeechSynthesisUtterance(text);
        u.lang = p?.lang || 'en-US';
        u.rate = p?.speed ?? 1;
        u.pitch = p?.pitch ?? 1;
        u.volume = p?.volume ?? 1;
        if (p?.webVoiceName) {
            const v = webVoices.find(v => v.name === p.webVoiceName && (!p.lang || v.lang.startsWith(p.lang)));
            if (v) u.voice = v;
        }
        return new Promise((res, rej) => { u.onend = res; u.onerror = e => rej(e.error || e); speechSynthesis.speak(u); });
    }

    // ---------- Auto-translate for OpenAI TTS (text drives language) ----------
    async function translateIfNeeded(text, lang) {
        if (!lang || lang.startsWith('en')) return text;
        try {
            const r = await fetch(DOACH.chatEndpoint, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: `Translate to ${lang}. Keep coaching tone. Only output the sentence:\n\n${text}`, model: DOACH.model })
            });
            if (!r.ok) return text; const j = await r.json(); return (j.text || text).trim();
        } catch { return text; }
    }


    // ---------- wraps extractPoseSnapshot for analysis ----------
    window.capturePoseSnapshot = function capturePoseSnapshot(playerState, hoopBox) {
        const state = playerState || window.playerState || null;
        if (!state) return null;
        try {
            const kp = state?.keypoints;
            if (Array.isArray(kp) && kp.length >= 33 && typeof window.extractPoseSnapshot === 'function') {
                return window.extractPoseSnapshot(kp, hoopBox ?? window.getLockedHoopBox?.());
            }
        } catch { }
        return null;
    };



    //LLM helper
    function composeLLMPrompt(shot, golden, draftLine, made, personality) {
        const ctx = {
            metrics: {
                arcHeight: Math.round(shot.arcHeight || 0),
                entryAngle: shot.entryAngle ?? null,
                releaseAngle: shot.releaseAngle ?? null
            },
            pose: shot.poseSnapshot || null,
            golden: golden || null,
            lastCategories: (window.__coachCueHistory || []).slice(-3)
        };

        return `
  You are Doach, a ${personality} shooting coach.

  Write a single pose-focused coaching cue (one short sentence).
  - Base the cue entirely on pose metrics; ignore shot outcome or make/miss info.
  - Highlight the most important mechanical adjustment.
  - Use whole-number metrics when helpful.
  - Avoid repeating any of: ${JSON.stringify(ctx.lastCategories)} if another issue is equally important.
  - Keep it concrete and actionable.
  - No emojis. No bullet points.

  Context (JSON):
  ${JSON.stringify(ctx)}
  ${draftLine ? `
Draft to refine (optional): '${draftLine}'` : ''}

  Return only the final coaching line.
  `.trim();
    }


    // analyze shot pose
    window.doachOnShot = async function (shot) {
        try {
            if (!shot.poseSnapshot && window.playerState) {
                shot.poseSnapshot = window.capturePoseSnapshot(window.playerState, window.getLockedHoopBox?.());
            }
            shot.ts = shot.ts || Date.now();

            const mem = window.DOACH_MEM.get();
            const golden = mem.golden;
            const made = !!shot.made;
            const poseOnly = DOACH.poseOnly === true;

            // Local draft (pose-only taps pose heuristics; otherwise keep legacy flow)
            let localText = '';
            try {
                const poseSnap = shot?.poseSnapshot || getPoseSnapshotFrom(shot);
                if (poseSnap && typeof window.composePoseFeedback === 'function') {
                    localText = String(window.composePoseFeedback(poseSnap) || '').trim();
                }
            } catch { }

            // Fallback to the old local composer if the engine didn’t return anything
            if (!localText) {
                localText = poseOnly
                    ? craftPoseLine(shot, golden, { bumpSeed: true })
                    : (made ? craftCoachingLine(shot, golden) : craftMissLine(shot, golden));
            }


            // Choose how to use the LLM
            const mode = (window.DOACH?.llmMode || 'polish').toLowerCase();
            let text = localText;
            const inferShotIdx0 = () => {
                try { if (Number.isFinite(Number(shot?.coachIdx))) return Number(shot.coachIdx); } catch { }
                try { if (Number.isFinite(Number(shot?.idx))) return Number(shot.idx); } catch { }
                try { if (Number.isFinite(Number(shot?.__idx))) return Number(shot.__idx) - 1; } catch { }
                try { if (Number.isFinite(Number(window.__SHOT_IDX))) return Number(window.__SHOT_IDX); } catch { }
                try {
                    const n = getShotNumber?.(); // 1-based if available
                    if (Number.isFinite(n) && n > 0) return n - 1;
                } catch { }
                try {
                    const len = (window.__shotList?.length || 0);
                    if (len > 0) return Math.max(0, len - 1);
                } catch { }
                return 0;
            };

            if (!poseOnly && mode !== 'off' && window.DOACH?.chatEndpoint) {
                try {
                    const prompt = composeLLMPrompt(
                        shot, golden,
                        mode === 'polish' ? localText : '', // primary: no draft; polish: send draft
                        made,
                        window.DOACH?.personality || 'positive, concise'
                    );
                    const r = await fetch(window.DOACH.chatEndpoint, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ prompt, model: window.DOACH.model, temperature: 0.8 })
                    });
                    const j = await r.json();
                    const llm = (j?.text || '').trim();
                    if (llm) text = llm;
                } catch (e) {
                    // silent fallback to local
                }
            }

            // Final de-dup + remember line
            text = avoidRepeat(text, shot, golden, made);
            window.__coachLineHistory.push(text);
            if (window.__coachLineHistory.length > 12) window.__coachLineHistory = window.__coachLineHistory.slice(-12);

            // Persist to last shot (for table) and update modal cell if present
            window.__lastCoachText = text;
            try {
                const list = window.__shotList || [];
                const last = list[list.length - 1];
                if (last) {
                    last.doach = text;
                    const idx = last.__idx ?? list.length;
                    const modal = document.getElementById('fullShotModal');
                    if (modal) {
                        const cell =
                            modal.querySelector(`tbody tr[data-shot-idx="${idx}"] td.coach`) ||
                            modal.querySelector('tbody tr:last-child td.coach');
                        if (cell) { cell.textContent = text; cell.title = text; }
                    }
                }
            } catch (e) { console.warn('[doach] coach text UI update failed:', e); }

            setCoachNotesContent(text);
            const now = Date.now();
            if (text === __lastSpeak.text && (now - __lastSpeak.at) < SPEAK_DEDUP_MS) {
                return; // skip duplicate speak
            }
            __lastSpeak = { text, at: now };
            // Realtime-only: do not speak table/summary lines; leave UI text only
            // voice is owned by the global shot:summary handler
            //  if (!window.DOACH_ONLY_REALTIME) {
            //      queueMicrotask(() => doachSpeak?.(text));
            // }

        } catch (e) { console.warn('[doachOnShot]', e); }
    };


    //  Pass analysis to memory  ------------------------------- //
    window.updateCoachNotes = function updateCoachNotes(shot) {
        if (!shot) return;

        const mem = window.DOACH_MEM.get();
        const golden = mem.golden;
        const tips = window.summarizePoseIssues?.(shot, golden) || [];
        const rating = window.computeShotRating?.(shot.poseSnapshot, golden) ?? 50;

        let html = `
      <strong> Doach Feedback</strong><br>
      <div style="font-size: 18px; margin-bottom: 6px;">
        🏅 Shot Rating: <strong style="color:${rating >= 80 ? 'lightgreen' : rating >= 50 ? 'orange' : 'red'}">${rating}/100</strong>
        ${golden ? `<span style="opacity:.7;">(vs ${golden.count} reference shots)</span>` : ``}
      </div>
      ${tips.length ? `<ul>${tips.map(t => `<li>${t}</li>`).join('')}</ul>`
                : `<span style="color:lightgreen;">✅ No major pose issues detected.</span>`}
    `;
        if (shot.discarded) {
            html = `<div style="color: orange; font-weight: bold; margin-bottom: 6px;">
        ⚠️ Shot was discarded: ${shot.missReason || 'No reason provided'}
      </div>` + html;
        }

        const container = setCoachNotesContent(html, { html: true });
        if (!container) return;
        container.style.backgroundColor = 'rgba(0,0,0,0.9)';
        container.style.border = '1px solid lime';
    };

    window.computeShotRating = function computeShotRating(pose, golden) {
        const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
        if (!pose) return 50;
        // If we have a golden pose, score vs golden; else use sensible defaults
        const g = golden || {
            stanceWidthFeet: 120, kneeFlex: 28, torsoLeanAngle: 0, shoulderToWristAngle: 55,
            feetAngleDiff: 8, feetStagger: 6, releaseAboveShoulder: true
        };

        let score = 100;
        const penal = (amt) => { score -= amt; };

        // Feet: width, alignment, stagger
        if (g.stanceWidthFeet) {
            const d = Math.abs((pose.stanceWidthFeet || g.stanceWidthFeet) - g.stanceWidthFeet);
            if (d > 35) penal(10); else if (d > 20) penal(5);
        }
        if (Number.isFinite(pose.feetAngleDiff)) {
            if (pose.feetAngleDiff > (g.feetAngleDiff || 8) + 8) penal(8);
            else if (pose.feetAngleDiff > (g.feetAngleDiff || 8) + 4) penal(4);
        }
        if (Number.isFinite(pose.feetStagger) && pose.feetStagger > (g.feetStagger || 6) + 10) penal(6);

        // Lower body power
        if (Number.isFinite(pose.kneeFlex)) {
            if (pose.kneeFlex < (g.kneeFlex || 28) * 0.6) penal(12);
            else if (pose.kneeFlex < (g.kneeFlex || 28) * 0.8) penal(6);
        }

        // Torso
        if (Number.isFinite(pose.torsoLeanAngle) && Math.abs(pose.torsoLeanAngle) > 18) penal(8);

        // Arm / release
        if (Number.isFinite(pose.shoulderToWristAngle)) {
            if (pose.shoulderToWristAngle < (g.shoulderToWristAngle || 55) - 12) penal(10);
            else if (pose.shoulderToWristAngle < (g.shoulderToWristAngle || 55) - 6) penal(5);
        }
        if (pose.wristY != null && pose.elbowY != null && pose.wristY > pose.elbowY + 10) penal(6);
        if (g.releaseAboveShoulder && !pose.releaseAboveShoulder) penal(8);

        return clamp(Math.round(score), 0, 100);
    };



    // -----------------------------------------------
    // Hands-Free Doach (standalone, no global collisions)
    // Exposes: window.doachHandsFree.start(), .stop(), .toggle(), .isActive()
    // -----------------------------------------------
    (() => {
        if (window.__doachHFInit) return;          // prevent duplicate init
        window.__doachHFInit = true;

        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SR) {
            console.warn('[Doach HF] Web Speech API not available');
            window.doachHandsFree = { start() { }, stop() { }, toggle() { }, isActive: () => false };
            return;
        }

        // --- light metrics -> answer helper (kept local to avoid globals)
        function answerFromMetrics(q, last, golden) {
            if (!last?.poseSnapshot) return "I need a shot first to analyze.";
            const p = last.poseSnapshot;
            const g = golden || {};
            q = (q || '').toLowerCase();
            const say = (s) => s.replace(/\s+/g, ' ').trim();

            if (/foot|feet|base|stance/.test(q)) {
                const w = Math.round(p.stanceWidthFeet || p.stanceWidth || 0);
                const tgt = g.stanceWidthFeet ? `, target ${Math.round(g.stanceWidthFeet)}px (Δ${w - Math.round(g.stanceWidthFeet)})` : '';
                const angle = Math.round(p.feetAngleDiff || 0);
                const stag = Math.round(p.feetStagger || 0);
                return say(`Feet width ${w}px${tgt}. Toe alignment off by ${angle}°. ${stag > 10 ? 'Feet staggered; level your base.' : 'Base is level.'}`);
            }
            if (/release|follow/.test(q)) {
                const ang = Math.round(p.shoulderToWristAngle ?? 0);
                const high = p.releaseAboveShoulder ? "above" : "below";
                const wristVsElbow = (p.wristY != null && p.elbowY != null && p.wristY > p.elbowY + 10) ? "low" : "high";
                return say(`Arm angle ${ang}°. Release is ${high} shoulder. Wrist finished ${wristVsElbow}. Aim for a higher vertical finish.`);
            }
            if (/power|leg|knee/.test(q)) {
                const k = Math.round(p.kneeFlex || 0);
                const tgt = g.kneeFlex ? `; target ~${Math.round(g.kneeFlex)}` : '';
                return say(`Knee bend ${k}px${tgt}. ${k < (g.kneeFlex || 28) * 0.75 ? 'Add more bend for power.' : 'Power from legs looked solid.'}`);
            }
            if (/arc|entry/.test(q)) {
                const ea = Math.round(last.entryAngle ?? 0);
                const ga = g.entryAngle ? Math.round(g.entryAngle) : 50;
                return say(`Entry angle ${ea}°. ${Math.abs(ea - ga) <= 5 ? 'On target.' : ea < ga ? 'A bit flat - add arc.' : 'A tad steep - soften the arc.'}`);
            }
            if (/(accur|make|made)/.test(q)) {
                return say('Pose-only mode: accuracy tracking is disabled. Focus on repeating the pose cues.');
            }
            return "Ask about feet, release, power, arc, or pose adjustments.";
        }

        // --- private state for this module (distinct names)
        let hfRec = null;
        let hfActive = false;
        let hfStarting = false;
        let hfRestartTimer = null;

        function tryRestart() {
            if (!hfRec || document.hidden || hfStarting || hfActive) return;
            hfStarting = true;
            try { hfRec.start(); }
            catch { hfStarting = false; setTimeout(() => { try { hfRec.start(); hfStarting = true; } catch { } }, 400); }
        }

        async function start() {
            if (hfActive || hfStarting) return;
            // permission prime (helps UX)
            if (!window.__doachMicPrimed) {
                try {
                    await navigator.mediaDevices.getUserMedia({ audio: true });
                    window.__doachMicPrimed = true;
                } catch (err) {
                    try { console.warn('[Doach HandsFree] mic prime rejected', err); } catch { }
                    return;
                }
            }

            hfRec = new SR();
            hfRec.lang = 'en-US';
            hfRec.continuous = true;       // hands-free mode
            hfRec.interimResults = false;

            hfRec.onstart = () => { hfStarting = false; hfActive = true; };

            hfRec.onresult = (e) => {
                const transcript = Array.from(e.results).map(r => r[0].transcript).join(' ');
                const mem = window.DOACH_MEM?.get?.() || {};
                const reply = answerFromMetrics(transcript, mem.lastShot, mem.golden);
                doachSpeak?.(reply);

                setCoachNotesContent(
                    `<strong>🎙 You:</strong> ${transcript}<br><strong>🤖 Doach:</strong> ${reply}`,
                    { html: true }
                );
            };

            hfRec.onerror = (ev) => {
                const err = ev?.error || String(ev);
                if (err === 'no-speech') return; // harmless; keep listening
                if (['aborted', 'not-allowed', 'service-not-allowed', 'audio-capture'].includes(err)) {
                    stop(); return;                 // needs user action
                }
                // soft backoff restart
                clearTimeout(hfRestartTimer);
                hfRestartTimer = setTimeout(tryRestart, 800);
            };

            hfRec.onend = () => {
                hfActive = false;
                if (!document.hidden) {
                    clearTimeout(hfRestartTimer);
                    hfRestartTimer = setTimeout(tryRestart, 300);
                }
            };

            hfStarting = true;
            try { hfRec.start(); }
            catch { hfStarting = false; setTimeout(() => { try { hfRec.start(); hfStarting = true; } catch { } }, 400); }

            doachSpeak?.("Listening. Ask about feet, release, power, arc, or pose adjustments.");
        }

        function stop() {
            clearTimeout(hfRestartTimer);
            hfRestartTimer = null;
            hfStarting = false;
            hfActive = false;
            try { hfRec?.stop(); } catch { }
            hfRec = null;
        }

        document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });

        // public API
        window.doachHandsFree = {
            start, stop,
            toggle() { (hfActive || hfStarting) ? stop() : start(); },
            isActive: () => hfActive
        };
    })();


    let __processedShotKeys = new Set();
    const __processedExpireMs = 4_000;  // 4s is plenty for microclip repeats
    let __processedTimestamps = [];

    function makeShotKey(s) {
        // Build a stable signature from fields that don't change across re-emits
        const idLike = s.shotId ?? s.id ?? s.__idx ?? '';
        const start = s.startFrame ?? s.start ?? '';
        const end = s.endFrame ?? s.end ?? '';
        const video = s.videoId ?? s.src ?? '';
        return [idLike, start, end, video].join('|');
    }

    function rememberKey(key) {
        const now = Date.now();
        __processedShotKeys.add(key);
        __processedTimestamps.push([key, now]);
        // GC old keys
        while (__processedTimestamps.length &&
            (now - __processedTimestamps[0][1]) > __processedExpireMs) {
            const [oldKey] = __processedTimestamps.shift();
            __processedShotKeys.delete(oldKey);
        }
    }

    // ---------- Pose snapshot chooser: prefer fresh-enough cache, else re-sample ----------
    (function () {
        if (typeof window.SUMMARY_STALE_FRAMES === 'undefined') window.SUMMARY_STALE_FRAMES = 5; // ~5 frames tolerance
        const STORE_KEY = '__poseStore';

        window.choosePoseSnapshotForSummary = function choosePoseSnapshotForSummary(shot) {
            try {
                const store = (window[STORE_KEY] ||= {});
                const sid = Number(shot?.shotId ?? shot?.id ?? 0);
                const cached = store[sid];            // { frame, ts, snapshot }
                const sFrame = Number(shot?.frame);   // summary frame if provided
                const tol = Number(window.SUMMARY_STALE_FRAMES || 5);

                const cachedFrame = Number(cached?.frame);
                const hasFreshCache = cached?.snapshot && Number.isFinite(cachedFrame) && Number.isFinite(sFrame)
                    ? Math.abs(sFrame - cachedFrame) <= tol
                    : !!cached?.snapshot && !Number.isFinite(sFrame); // no frame to compare, accept cache

                if (hasFreshCache) {
                    console.info('[pose:summary]', { shotId: sid, source: 'store', frame: sFrame, cachedFrame });
                    return cached.snapshot;
                }

                // Try a targeted re-sample near the summary frame, else fall back to a live capture
                let fresh = window.samplePoseNearFrame?.(sFrame, window.getLockedHoopBox?.());
                if (fresh?.snapshot) fresh = fresh.snapshot;
                if (!fresh && window.capturePoseSnapshot && window.playerState) {
                    fresh = window.capturePoseSnapshot(window.playerState, window.getLockedHoopBox?.());
                }

                if (fresh) {
                    console.info('[pose:summary]', { shotId: sid, source: 'fresh', frame: sFrame, cachedFrame });
                    // Don’t clobber release cache if you keep that elsewhere; only seed if empty
                    if (!cached) store[sid] = { frame: sFrame, ts: performance.now(), snapshot: fresh };
                    return fresh;
                }

                // Nothing fresh? use whatever we had
                console.info('[pose:summary]', { shotId: sid, source: 'fallback-cache', frame: sFrame, cachedFrame });
                return cached?.snapshot || null;
            } catch (e) {
                console.warn('[pose:summary] choosePoseSnapshot error', e);
                return null;
            }
        };
    })();

    // ---------- Global shot:summary handler (single, hardened instance) ----------
    // Listens for 'shot:summary' events and processes them once each
    // Expects event.detail to be the shot object
    // Adds poseSnapshot if missing, then calls DOACH_MEM.addShot() and updateCoachNotes()
    window.addEventListener('shot:summary', (e) => {
        // If we've already handled THIS object, bail (covers re-dispatch)
        if (e.detail && e.detail.__doachHandled) return;

        const shot = e.detail;
        const key = makeShotKey(shot || {});
        if (key && __processedShotKeys.has(key)) return; // already handled a twin

        // Mark original payload so a re-dispatch of the same object won't run again
        if (shot) shot.__doachHandled = true;
        rememberKey(key);

        console.log('[Doach] shot:summary handled key=', key, shot);

        // proceed with your existing logic
        const cloned = { ...shot };
        if (!cloned.poseSnapshot) {
            cloned.poseSnapshot =
                window.choosePoseSnapshotForSummary?.(shot) ||
                (window.playerState ? window.capturePoseSnapshot?.(window.playerState, window.getLockedHoopBox?.()) : null);
        }
        window.DOACH_MEM.addShot(cloned);
        window.updateCoachNotes?.(cloned);
        // Attach per-shot coach line for the table; respect voice preference inside doachOnShot
        window.doachOnShot?.(cloned);
    });



    // ───────────────────────────────────────────────
    // DOACH Voice Q&A (single, hardened instance)
    // ───────────────────────────────────────────────
    (function () {
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SR) { console.warn('[Doach Voice] SpeechRecognition not supported'); return; }

        // Wake words (loose match)
        const DOACH = (window.DOACH ||= {});
        DOACH.WAKE_WORDS ||= ['hey doach', 'my coach', 'coach', 'douch'];

        const prefs = (window.doachGetPrefs?.() || {});

        const IS_IOS = (() => {
            try {
                const nav = (typeof navigator !== 'undefined') ? navigator : null;
                if (!nav) return false;
                const ua = String(nav.userAgent || nav.vendor || '').toLowerCase();
                return /iphone|ipad|ipod/.test(ua);
            } catch {
                return false;
            }
        })();

        // --- recognizer + state (define all the vars used below!)
        const recog = new SR();
        recog.lang = prefs.lang || 'en-US';
        recog.interimResults = true;
        recog.continuous = false;     // more reliable cross-browser than true

        let listening = false;
        let starting = false;        // start() in-flight gate
        let armed = false;        // user armed (allowed auto-restart)
        let restartTimer = null;

        let captureMode = false;    // true after wake-word; captures the question
        let captureTimer = null;

        const norm = (s) => String(s || '')
            .toLowerCase()
            .replace(/[^\p{L}\p{N}\s]/gu, '')
            .replace(/\s+/g, ' ')
            .trim();

        const hasWake = (t) => {
            const n = norm(t);
            return DOACH.WAKE_WORDS.some(w => n.includes(norm(w)));
        };

        function lastShot() { return window.DOACH_MEM?.lastShot?.() || null; }

        function answerLocal(q) {
            const L = lastShot();
            if (!L) return "I don't have a shot yet. Take one and ask again.";
            const p = L.poseSnapshot || {};
            const parts = [];
            const n = norm(q);

            // Feet / stance
            if (/(foot|feet|stance)/.test(n)) {
                const w = p.stanceWidth;
                parts.push(w == null
                    ? "I couldn't see your feet clearly."
                    : `Stance width was ${Math.round(w)}px - ${w < 100 ? 'a bit narrow' : 'solid'}. Aim for about shoulder width plus a bit.`);
            }
            // Release / wrist / elbow
            if (/(release|wrist|elbow|follow)/.test(n)) {
                const ang = p.shoulderToWristAngle;
                parts.push(ang == null
                    ? "I couldn't read your arm angle."
                    : `Release angle was ~${Math.round(ang)}°. Try finishing near 50-60° with a full follow-through.`);
            }
            // Power / knee bend
            if (/(power|legs|knee|dip|bend)/.test(n)) {
                const k = p.kneeFlex;
                parts.push(k == null
                    ? "I couldn't estimate knee bend."
                    : `Knee bend was ~${Math.round(k)}px. Add a bit more load if the shot felt short.`);
            }
            // Arc / entry
            if (/(arc|entry|angle)/.test(n)) {
                const arc = Math.round(L.arcHeight || 0);
                const entry = L.entryAngle ?? '-';
                parts.push(`Arc ~${arc}px, entry ${entry}°. Target mid-40s to low-50s.`);
            }
            // Accuracy (pose-only mode disabled tracking)
            if (/(make|accuracy|percent|score)/.test(n)) {
                parts.push('Pose-only mode: accuracy tracking is disabled. Focus on repeating the pose cues.');
            }

            if (!parts.length) {
                const issues = window.summarizePoseIssues?.(L) || [];
                parts.push(`Pose snapshot: arc ${Math.round(L.arcHeight || 0)}px, entry ${L.entryAngle ?? '-'}°, release ${L.releaseAngle ?? '-'}°. Focus on smooth, tall mechanics.`);
                if (issues[0]) parts.push(issues[0]);
            }
            return parts.join(' ');
        }

        function showDot(on) {
            const root = document.getElementById('hudRoot') || document.body || document.documentElement;
            if (!root) return;
            let dot = document.getElementById('doachVoiceDot');
            if (!dot) {
                dot = document.createElement('div');
                dot.id = 'doachVoiceDot';
                Object.assign(dot.style, {
                    position: 'absolute', right: '12px', top: '12px',
                    width: '10px', height: '10px', borderRadius: '50%',
                    background: 'red', opacity: '0.5', zIndex: 10050, pointerEvents: 'none'
                });
                root.appendChild(dot);
            }
            dot.style.opacity = on ? '1' : '0.35';
            dot.style.background = captureMode ? 'lime' : 'red';
        }

        // --- robust start/stop with gates
        function tryStartRecog() {
            if (document.hidden || starting || listening) return;
            starting = true;
            try { recog.start(); }
            catch { starting = false; setTimeout(() => { try { recog.start(); starting = true; } catch { } }, 400); }
        }

        let allowIOSWake = !IS_IOS || !!window.__doachMicPrimed || isMicAllowed();
        let pendingIOSWake = false;

        async function start(force = false) {
            const micAllowed = isMicAllowed();
            if (!micAllowed && !force) {
                console.warn('[Doach HF] mic disabled by preferences');
                return;
            }
            if (force && !micAllowed) {
                try { doachSetPrefs({ ...doachGetPrefs(), allowMic: true }); } catch { }
            }

            if (force) {
                allowIOSWake = true;
                pendingIOSWake = false;
            }
            if (!allowIOSWake) {
                pendingIOSWake = true;
                return;
            }

            if (listening || starting) return;
            // mic prime improves UX/permissions
            if ((!window.__doachMicPrimed) && navigator.mediaDevices?.getUserMedia) {
                try {
                    await navigator.mediaDevices.getUserMedia({ audio: true });
                    window.__doachMicPrimed = true;
                    try { doachSetPrefs({ ...doachGetPrefs(), allowMic: true }); } catch { }
                } catch (err) {
                    try { console.warn('[Doach Voice] mic prime rejected', err); } catch { }
                    if (IS_IOS && !force) {
                        allowIOSWake = false;
                        pendingIOSWake = true;
                    }
                    return;
                }
            }
            armed = true;
            tryStartRecog();
            showDot(true);
        }

        function stop() {
            armed = false;
            listening = false;
            starting = false;
            clearTimeout(restartTimer);
            clearTimeout(captureTimer);
            captureMode = false;
            try { recog.stop(); } catch { }
            showDot(false);
        }

        // --- handlers
        recog.onstart = () => { starting = false; listening = true; showDot(true); };

        recog.onresult = async (ev) => {
            let finalText = '';
            for (let i = ev.resultIndex; i < ev.results.length; i++) {
                if (ev.results[i].isFinal) finalText += ev.results[i][0].transcript + ' ';
            }
            finalText = finalText.trim();
            if (!finalText) return;

            const lower = norm(finalText);

            // Step 1: detect wake word
            if (!captureMode && hasWake(lower)) {
                captureMode = true;
                showDot(true);
                clearTimeout(captureTimer);
                captureTimer = setTimeout(() => { captureMode = false; showDot(true); }, 5000);
                doachSpeak?.("Yes?");
                return;
            }

            // Step 2: capture the follow-up question
            if (captureMode) {
                clearTimeout(captureTimer);
                captureTimer = setTimeout(() => { captureMode = false; showDot(true); }, 1500);

                // strip wake words if included together
                const wakeRe = new RegExp(DOACH.WAKE_WORDS.map(w => norm(w)).join('|'), 'g');
                const q = lower.replace(wakeRe, '').trim();

                let reply = answerLocal(q);

                // Fallback to model for anything not covered by our quick rules
                if (!/(feet|stance|release|wrist|elbow|power|knee|arc|entry|angle|make|accuracy)/.test(q) && DOACH.chatEndpoint) {
                    try {
                        const ctx = { lastShot: lastShot(), recent: window.DOACH_MEM?.recent?.(5) };
                        const r = await fetch(DOACH.chatEndpoint, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                prompt: `You are Doach. User asked: "${finalText}". Use this context JSON:\n${JSON.stringify(ctx)}\nGive a specific, actionable answer in 1-2 short sentences.`,
                                model: DOACH.model
                            })
                        });
                        const j = await r.json();
                        if (j?.text) reply = j.text.trim();
                    } catch { }
                }

                doachSpeak?.(reply);
            }
        };

        recog.onerror = (e) => {
            const err = e?.error || String(e);

            // Common & harmless - ignore (optional soft retry)
            if (err === 'no-speech') {
                if (armed && !document.hidden) {
                    clearTimeout(restartTimer);
                    restartTimer = setTimeout(tryStartRecog, 600);
                }
                return;
            }

            starting = false;
            listening = false;

            // Require a new user gesture for these - do not auto-restart
            if (['aborted', 'not-allowed', 'service-not-allowed', 'audio-capture'].includes(err)) {
                armed = false;
                clearTimeout(restartTimer);
                restartTimer = null;
                showDot(false);
                return;
            }

            // Backoff restart only if the user armed and tab visible
            if (armed && !document.hidden) {
                clearTimeout(restartTimer);
                restartTimer = setTimeout(tryStartRecog, 800);
            }
        };

        recog.onend = () => {
            starting = false;
            listening = false;
            if (armed && !document.hidden) {
                clearTimeout(restartTimer);
                restartTimer = setTimeout(tryStartRecog, 300);
            } else {
                showDot(false);
            }
        };

        // Pause on hidden tab; require re-arming on return
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) stop();
        });

        // Public controls
        window.doachVoice = {
            on: () => start(true),
            off: stop,
            toggle: () => (listening || starting ? stop() : start(true)),
            isOn: () => listening
        };

        // Auto-start unless user disabled it in prefs
        const queueAutoStart = () => {
            if (!isMicAllowed()) return;
            if (IS_IOS && !window.__doachMicPrimed) {
                pendingIOSWake = true;
                return;
            }
            start();
        };
        if (prefs.voiceWake !== false) {
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', queueAutoStart, { once: true });
            } else {
                queueAutoStart();
            }
        }

        if (IS_IOS) {
            const enableFromGesture = () => {
                allowIOSWake = true;
                pendingIOSWake = false;
                start(true);
            };
            window.addEventListener('coach:voice-rec-start', enableFromGesture);
            try { window.__enableCoachVoiceWake = enableFromGesture; } catch { }
        }
    })();

})();

