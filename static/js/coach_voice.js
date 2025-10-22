// coach_voice.js — simple speech synthesis + optional voice command

let __preferredWebVoice = null;

let __coachSpeechTail = Promise.resolve(false);
let __coachSpeechActive = false;

function webTtsAllowed() {
    try { return window.DOACH_ALLOW_WEB_TTS === true; }
    catch { return false; }
}

function setCoachSpeechActive(active) {
    if (__coachSpeechActive === active) return;
    __coachSpeechActive = active;
    try { window.__COACH_SPEAKING = active; } catch { }
    try {
        if (active) window.__COACH_LAST_SPEECH_STARTED_AT = Date.now();
        else window.__COACH_LAST_SPEECH_ENDED_AT = Date.now();
    } catch { }
    try {
        window.dispatchEvent(new CustomEvent(active ? 'coach:speech-start' : 'coach:speech-end'));
    } catch { }
}

function queueCoachSpeech(task) {
    const run = async () => {
        setCoachSpeechActive(true);
        try {
            return await task();
        } catch (err) {
            try { console.warn('[coach] speech task failed', err); } catch { }
            return false;
        } finally {
            setCoachSpeechActive(false);
        }
    };
    __coachSpeechTail = __coachSpeechTail.then(run, run);
    return __coachSpeechTail;
}

export function waitForCoachSpeech() {
    return __coachSpeechTail.then(() => undefined);
}

export function isCoachSpeaking() {
    return __coachSpeechActive;
}

try { window.waitForCoachSpeech = waitForCoachSpeech; } catch { }
try { window.isCoachSpeaking = isCoachSpeaking; } catch { }

// Who owns the intro line? 'session_manager' (default) or 'coach_voice'
try { if (typeof window.PREF_GREETER_SOURCE === 'undefined') window.PREF_GREETER_SOURCE = 'session_manager'; } catch {}


function isOverlayVisible(el) {
    if (!el) return false;
    if (el.hidden === true) return false;
    const style = window.getComputedStyle ? window.getComputedStyle(el) : el.style;
    if (!style) return true;
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    return true;
}

function isStartSessionOverlayVisible() {
    try {
        const el = document.getElementById('startSessionOverlay');
        return isOverlayVisible(el);
    } catch {
        return false;
    }
}

function selectPreferredVoice() {
    try {
        const synth = window.speechSynthesis;
        if (!synth || !synth.getVoices) return;
        const voices = synth.getVoices();
        if (!voices || !voices.length) return;
        const preferredNames = [
            'Samantha',
            'com.apple.ttsbundle.Samantha-compact',
            'Google US English Female',
            'English (US) Female',
            'Microsoft Aria Online (Natural) - English (United States)',
            'en-US-Wavenet-F'
        ];
        for (const name of preferredNames) {
            const match = voices.find(v => v.name === name || v.voiceURI === name);
            if (match) { __preferredWebVoice = match; return; }
        }
        const female = voices.find(v => /female/i.test(v.name || '') && (v.lang || '').toLowerCase().startsWith('en'));
        if (female) { __preferredWebVoice = female; return; }
        const english = voices.find(v => (v.lang || '').toLowerCase().startsWith('en'));
        __preferredWebVoice = english || voices[0];
    } catch { }
}

try {
    if (typeof window !== 'undefined' && window.speechSynthesis) {
        window.speechSynthesis.addEventListener?.('voiceschanged', selectPreferredVoice);
        selectPreferredVoice();
    }
} catch { }

function speakWeb(text) {
    return new Promise((resolve) => {
        try {
            if (!text) { resolve(false); return; }
            const synth = window.speechSynthesis;
            if (!synth) { resolve(false); return; }
            const utter = new SpeechSynthesisUtterance(String(text));
            utter.rate = 0.98;
            utter.pitch = 1.05;
            utter.lang = 'en-US';
            if (__preferredWebVoice) utter.voice = __preferredWebVoice;
            utter.onend = () => resolve(true);
            utter.onerror = () => resolve(false);
            synth.cancel();
            try { synth.resume?.(); } catch { }
            synth.speak(utter);
        } catch (err) {
            try { console.warn('[coach] speakWeb failed', err); } catch { }
            resolve(false);
        }
    });
}

export function speak(text) {
    if (IS_IOS) return Promise.resolve(false);
    return speakWeb(text);
}

function sanitizeName(n) {
  return String(n ?? '')
    .replace(/^[\s"'`]+|[\s"'`]+$/g, '')   // strip quotes and extra spaces
    .trim();
}

// Display name for voice (fallbacks)
function getDisplayName() {
  try {
    const raw = window.__USER_NAME || localStorage.getItem('firstname') || 'Player';
    return sanitizeName(raw);
  } catch {
    return sanitizeName(window.__USER_NAME || 'Player');
  }
}
const name = getDisplayName();

// ===== Shared one-time greeter (iOS-safe) =====
(function initCoachGreeter(){
  if (window.coachGreetingOnce) return;

  let greeted = false;

  function isIOS(){ return /iphone|ipad|ipod/i.test(navigator.userAgent||''); }

  // If session_manager finishes its own greeting, consider ours "done"
  try {
    window.addEventListener('coach:greeting-finished', () => { greeted = true; }, { passive: true });
  } catch {}

  window.resetCoachGreeting = function resetCoachGreeting(){
    try { greeted = false; } catch {}
  };

  window.coachGreetingOnce = async function coachGreetingOnce(text = `Hi ${name}, I'm listening and ready.`) {
    if (greeted) return false;
    if (window.__coachMuted) return false;

    try { await window.CoachAudio?.unlock(); } catch {}

    const ok = await (window.doachSpeak?.(text, { engine: isIOS() ? 'openai' : undefined }) || Promise.resolve(false));
    if (ok !== false) {
      greeted = true;
      return true;
    }
    return false;
  };

  // Only auto-poke this greeter if coach_voice is the chosen source
  if (window.PREF_GREETER_SOURCE === 'coach_voice') {
    // If user unmutes later, gently try once
    window.addEventListener('hud:mute-toggle', (e) => {
      if (e?.detail?.muted === false) {
        setTimeout(() => { try { window.coachGreetingOnce(); } catch {} }, 150);
      }
    });

    // Wake hooks help after bfcache/visibility
    window.addEventListener('pageshow', () => {
      if (!greeted) setTimeout(() => { try { window.coachGreetingOnce(); } catch {} }, 120);
    }, { passive: true });
  }

  ['hud:end-session','session:reset','hud:arm-reset'].forEach(evt => {
    window.addEventListener(evt, () => { try { greeted = false; } catch {} });
  });
})();




const IS_MOBILE_SPEECH_ENV = (() => {
    try {
        const nav = (typeof navigator !== 'undefined') ? navigator : null;
        if (!nav) return false;
        const ua = String(nav.userAgent || nav.vendor || '').toLowerCase();
        return /iphone|ipad|ipod|android/.test(ua);
    } catch {
        return false;
    }
})();
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
const SERVER_TTS_TIMEOUT_MS = 12000;
const SILENT_PRIME_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=';

// === iOS wake + re-unlock hooks ===
(function installIOSWakeHooks() {
    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent || '');
    if (!isIOS) return;

    // Wake function: resume context + silent play to satisfy gesture state if possible
    async function wakeAudio() {
        try { await window.CoachAudio?.unlock(); } catch { }
    }

    // a) When page returns from background or bfcache
    window.addEventListener('pageshow', async () => { await wakeAudio(); }, { passive: true });

    // b) When tab becomes visible again
    document.addEventListener('visibilitychange', async () => {
        if (document.visibilityState === 'visible') await wakeAudio();
    }, { passive: true });

    // c) If AudioContext gets suspended/interrupted mid-session, try to bounce it
    try {
        const ctx = window.CoachAudio?.getCtx?.();
        if (ctx) {
            ctx.onstatechange = async () => {
                if (ctx.state !== 'running') await wakeAudio();
            };
        }
    } catch { }
})();



(function initCoachAudio() {
    if (typeof window === 'undefined' || window.CoachAudio) return;

    const CoachAudio = {
        ctx: null,
        el: null,
        unlocked: false,
        playing: false,
        q: [],

        getCtx() {
            const C = window.AudioContext || window.webkitAudioContext;
            if (!C) return null;
            if (!this.ctx) {
                try { this.ctx = new C(); }
                catch { this.ctx = null; }
            }
            return this.ctx;
        },

        getEl() {
            if (this.el && document.body && document.body.contains(this.el)) return this.el;
            const a = document.createElement('audio');
            a.style.display = 'none';
            a.setAttribute('playsinline', ''); a.playsInline = true;
            a.preload = 'auto';
            a.muted = false; a.volume = 1;
            document.body?.appendChild(a);
            this.el = a;
            return a;
        },

        async unlock() {
            if (this.unlocked) return true;
            try {
                const ctx = this.getCtx();
                if (ctx && ctx.state === 'suspended' && typeof ctx.resume === 'function') {
                    await ctx.resume();
                }
                if (ctx) {
                    const src = ctx.createBufferSource();
                    src.buffer = ctx.createBuffer(1, 1, 22050);
                    const gain = ctx.createGain(); gain.gain.value = 0;
                    src.connect(gain); gain.connect(ctx.destination);
                    try { src.start(0); src.stop(0); } catch { }
                }
            } catch { }

            try {
                const el = this.getEl();
                el.src = SILENT_PRIME_WAV;
                await el.play().catch(() => { });
                try { el.pause(); } catch { }
                try { el.removeAttribute('src'); el.load?.(); } catch { }
            } catch { }

            this.unlocked = true;
            try { window.__iosAudioUnlocked = true; } catch { }
            return true;
        },

        async enqueue(src, label = 'tts') {
            await this.unlock();
            return new Promise((resolve, reject) => {
                this.q.push({ src, label, resolve, reject });
                this._drain();
            });
        },

        async _drain() {
            if (this.playing) return;
            this.playing = true;
            const el = this.getEl();
            while (this.q.length) {
                const { src, label, resolve, reject } = this.q.shift();
                try {
                    await this._playOnce(el, src, label);
                    resolve?.(true);
                } catch (err) {
                    try { console.warn('[CoachAudio] playback failed', err); } catch { }
                    reject?.(err);
                }
            }
            this.playing = false;
            if (this.q.length) this._drain();
        },

        async _playOnce(el, src, label) {
            try {
                const ctx = this.getCtx();
                if (ctx && ctx.state === 'suspended' && typeof ctx.resume === 'function') {
                    await ctx.resume();
                }
            } catch { }

            let url = null;
            try {
                if (src instanceof Blob) {
                    url = URL.createObjectURL(src);
                    el.src = url;
                } else if (src instanceof ArrayBuffer) {
                    url = URL.createObjectURL(new Blob([src], { type: 'audio/mpeg' }));
                    el.src = url;
                } else {
                    el.src = String(src);
                }
            } catch (err) {
                try { console.warn('[CoachAudio] failed to set source', err, { label }); } catch { }
                return;
            }

            await new Promise((resolve) => {
                let settled = false;
                const cleanup = () => {
                    el.removeEventListener('canplay', onReady);
                    el.removeEventListener('canplaythrough', onReady);
                    el.removeEventListener('loadeddata', onReady);
                };
                const onReady = () => {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    resolve();
                };
                el.addEventListener('canplay', onReady, { once: true });
                el.addEventListener('canplaythrough', onReady, { once: true });
                el.addEventListener('loadeddata', onReady, { once: true });
                setTimeout(() => {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    resolve();
                }, 800);
            });

            try { await el.play(); } catch { }

            await new Promise((resolve) => {
                let done = false;
                const finish = () => {
                    if (done) return;
                    done = true;
                    cleanup();
                    resolve();
                };
                const cleanup = () => {
                    el.removeEventListener('ended', finish);
                    el.removeEventListener('error', finish);
                    el.removeEventListener('abort', finish);
                };
                el.addEventListener('ended', finish, { once: true });
                el.addEventListener('error', finish, { once: true });
                el.addEventListener('abort', finish, { once: true });
                setTimeout(finish, 12000);
            });

            try { el.pause(); } catch { }
            try {
                if (url) URL.revokeObjectURL(url);
            } catch { }
            try { el.removeAttribute('src'); el.load?.(); } catch { }
        }
    };

    window.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            CoachAudio.unlock().catch(() => { });
        }
    }, { passive: true });
    window.addEventListener('touchstart', () => {
        CoachAudio.unlock().catch(() => { });
    }, { once: true, passive: true });
    window.addEventListener('pointerdown', () => {
        CoachAudio.unlock().catch(() => { });
    }, { once: true, passive: true });

    window.CoachAudio = CoachAudio;
})();

function getPreferredVoice() {
    try {
        const prefs = JSON.parse(localStorage.getItem('doach_tts') || '{}');
        if (prefs.voice) return prefs.voice;
        if (prefs.provider && prefs.provider !== 'server' && !webTtsAllowed()) {
            const voice = prefs.voice || (window.DOACH && window.DOACH.voice) || 'alloy';
            const next = { provider: 'server', voice };
            localStorage.setItem('doach_tts', JSON.stringify(next));
            return next.voice;
        }
    } catch { }
    try {
        const stored = localStorage.getItem('doach_voice');
        if (stored) return stored;
    } catch { }
    return (window.DOACH && window.DOACH.voice) || 'alloy';
}

function getTtsEngine() {
    try {
        if (window.DOACH_FORCE_WEB_TTS === true && webTtsAllowed()) {
            window.TTS_ENGINE = 'webspeech';
            return 'webspeech';
        }
        let engine = window.TTS_ENGINE || localStorage.getItem('tts_engine') || 'openai';
        if (!engine) engine = 'openai';
        if (engine === 'web') engine = 'webspeech';
        if (!webTtsAllowed()) {
            engine = 'openai';
            try { localStorage.setItem('tts_engine', 'openai'); } catch { }
        }
        // iOS does not support Web Speech playback reliably; force server TTS
        if (IS_IOS && engine !== 'openai') engine = 'openai';
        window.TTS_ENGINE = engine;
        if (engine === 'openai') {
            try { localStorage.setItem('tts_engine', 'openai'); } catch { }
        }
        return engine;
    } catch {
        return 'openai';
    }
}

async function speakViaOpenAI(text, opts = {}) {
    if (!text) return false;
    const coachAudio = window.CoachAudio;
    if (!coachAudio) return false;

    try {
        await coachAudio.unlock();
        window.__iosAudioUnlocked = true;
    } catch { }

    const voice = opts.voice || getPreferredVoice();
    let timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : NaN;
    if (!Number.isFinite(timeoutMs)) {
        try {
            const userTimeout = Number(window.COACH_TTS_TIMEOUT_MS);
            if (Number.isFinite(userTimeout)) timeoutMs = userTimeout;
        } catch { timeoutMs = NaN; }
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) timeoutMs = SERVER_TTS_TIMEOUT_MS;

    let controller = null;
    let timer = null;

    try {
        if (typeof AbortController !== 'undefined') {
            controller = new AbortController();
            timer = setTimeout(() => {
                try { controller.abort(); } catch { }
            }, timeoutMs);
        }

        const response = await fetch('/api/tts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, voice, engine: 'openai' }),
            signal: controller?.signal
        });

        if (!response?.ok) return false;

        const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase();
        const okType = /audio\/(mpeg|mp3|wav)/.test(contentType) || contentType === 'application/octet-stream';
        if (!okType) {
            try { console.warn('[coach] unsupported TTS content-type', contentType); } catch { }
            return false;
        }

        const blob = await response.blob().catch(() => null);
        if (!blob) return false;

        await coachAudio.enqueue(blob, opts.label || 'tts');
        return true;
    } catch (err) {
        try { console.warn('[coach] openai tts error', err); } catch { }
        return false;
    } finally {
        if (timer) clearTimeout(timer);
    }
}

async function speakViaWebSpeech(text) {
    if (!webTtsAllowed()) return false;
    if (!text) return false;
    if (IS_IOS) return false;
    if (!('speechSynthesis' in window)) return false;

    try {
        return await speakWeb(text);
    } catch (err) {
        try { console.warn('[coach] web speech failed', err); } catch { }
        return false;
    }
}

async function doachSpeakOnce(text, opts = {}) {
    // 1) iOS demands the ritual. Do this before choosing engines.
    try { await window.CoachAudio?.unlock(); } catch { }

    const spoken = String(text);

    // 2) Decide engine (force OpenAI on iOS if someone saved nonsense)
    let engine = (opts.engine || getTtsEngine() || '').toLowerCase();
    if (!engine) engine = 'openai';
    if (engine === 'web') engine = 'webspeech';
    if (IS_IOS && engine !== 'openai') engine = 'openai';

    const tryOpenAI = async () => {
        try {
            try { window.speechSynthesis?.cancel?.(); } catch { }
            const ok = await speakViaOpenAI(spoken, opts);
            if (ok) return true;
        } catch (err) {
            try { console.warn('[coach] doachSpeak openai failed', err); } catch { }
        }
        return false;
    };

    const tryWebSpeech = async () => {
        try {
            const ok = await speakViaWebSpeech(spoken);
            if (ok) return true;
        } catch (err) {
            try { console.warn('[coach] doachSpeak webspeech failed', err); } catch { }
        }
        return false;
    };

    // 3) Try the chosen path with graceful fallback
    try {
        if (engine === 'openai') {
            if (await tryOpenAI()) return true;
            if (await tryWebSpeech()) return true;
        } else if (engine === 'webspeech') {
            // Web Speech is pointless on iOS; route through server there
            if (!IS_IOS) {
                if (await tryWebSpeech()) return true;
                if (await tryOpenAI()) return true;
            } else {
                if (await tryOpenAI()) return true;
            }
        }
    } catch (err) {
        try { console.warn('[coach] doachSpeak engine error', err); } catch { }
    }

    // Final cross-check: if preferred engine failed, attempt the other one once.
    if (engine !== 'openai' && await tryOpenAI()) return true;
    if (engine !== 'webspeech' && await tryWebSpeech()) return true;

    return false;
}

function logDoachSpeakEvent(event, payload) {
    try {
        if (window.reportClientEvent) {
            window.reportClientEvent(`tts:${event}`, payload);
        } else {
            console.debug(`[tts:${event}]`, payload);
        }
    } catch {}
}

export function doachSpeak(text, opts = {}) {
    if (!text) {
        logDoachSpeakEvent('skip-empty', {});
        return Promise.resolve(false);
    }
    try {
        if (window.__coachMuted) {
            logDoachSpeakEvent('skip-muted', { text });
            return Promise.resolve(false);
        }
    } catch { }
    logDoachSpeakEvent('queue', { text, engine: opts.engine || getTtsEngine(), label: opts.label });
    return queueCoachSpeech(() => doachSpeakOnce(text, opts)
        .then((result) => {
            logDoachSpeakEvent(result ? 'success' : 'fallback', { text, engine: getTtsEngine(), label: opts.label });
            return result;
        })
        .catch((err) => {
            logDoachSpeakEvent('error', { text, message: err?.message || String(err) });
            return false;
        }));
}

let __coachAudioPrimed = false;
let __coachAudioPriming = null;

export async function unlockIOSAudio() {
    const ok = await primeCoachAudio().catch(() => false);
    return ok;
}

// Make it globally callable from UI modules
try { window.unlockIOSAudio = unlockIOSAudio; } catch { }


export async function primeCoachAudio() {
    if (__coachAudioPrimed) return true;
    if (__coachAudioPriming) return __coachAudioPriming;

    __coachAudioPriming = (async () => {
        try {
            if (!window.CoachAudio) return false;
            await window.CoachAudio.unlock();
            __coachAudioPrimed = true;
            try { window.__iosAudioUnlocked = true; } catch { }
            return true;
        } catch (err) {
            __coachAudioPrimed = false;
            try { console.warn('[coach] primeCoachAudio failed', err); } catch { }
            return false;
        }
    })();

    try {
        return await __coachAudioPriming;
    } finally {
        __coachAudioPriming = null;
    }
}

let __micPrimed = false;
let __micPriming = null;

export async function ensureMicPrimed(constraints = { audio: true }) {
    if (!__micPrimed) {
        try { __micPrimed = localStorage.getItem('doach_voice_mic_allowed') === '1'; } catch { }
    }
    if (__micPrimed) return true;
    if (__micPriming) return __micPriming;

    const ua = (navigator.userAgent || '').toLowerCase();
    if (/android/.test(ua) && window.DOACH_ENABLE_ANDROID_SR !== true) {
        return false;
    }

    __micPriming = (async () => {
        if (!navigator.mediaDevices?.getUserMedia) return false;
        try {
            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            try { stream.getTracks().forEach((t) => t.stop()); } catch { }
            __micPrimed = true;
            try { localStorage.setItem('doach_voice_mic_allowed', '1'); } catch { }
            try { window.__doachMicPrimed = true; } catch { }
            return true;
        } catch (err) {
            __micPrimed = false;
            try { localStorage.removeItem('doach_voice_mic_allowed'); } catch { }
            try { window.__doachMicPrimed = false; } catch { }
            try { console.warn('[coach] mic prime failed', err); } catch { }
            return false;
        }
    })();

    try {
        return await __micPriming;
    } finally {
        __micPriming = null;
    }
}

try { window.ensureMicPrimed = ensureMicPrimed; } catch { }

export function listenForEndSession(wakePhrase = 'hey doach, end the session', onEnd) {
    try {
        const ua = (navigator.userAgent || '').toLowerCase();
        if (/android/.test(ua) && window.DOACH_ENABLE_ANDROID_SR !== true) {
            try { window.__startCoachVoiceRecognition = () => false; } catch { }
            return () => { };
        }
        const SR = (window.SpeechRecognition || window.webkitSpeechRecognition);
        if (!SR) return () => { };

        const matchesPhrase = (value, phrases) => {
            try {
                const haystack = (value || '').toLowerCase();
                return phrases.some((phrase) => {
                    if (!phrase) return false;
                    const target = phrase.toLowerCase();
                    if (target.includes(' ')) {
                        return haystack.includes(target);
                    }
                    const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    return new RegExp(`\\b${escaped}\\b`).test(haystack);
                });
            } catch { return false; }
        };
        const affirmativePhrases = [
            'yes',
            'yeah',
            'yep',
            'yup',
            'sure',
            'absolutely',
            'of course',
            'affirmative',
            'definitely',
            'for sure',
            'sounds good',
            'yes please',
            'please do',
            "let's go",
            'lets go',
            'let us go',
            "let's do it",
            'lets do it',
            'do it',
            'go ahead',
            'go for it',
            'make it happen',
            'run it back',
            'another one',
            'one more',
            'hit me',
            'start it',
            'yessir',
            'bet',
        ];
        const startSessionPhrases = [
            'start session',
            'start the session',
            'start a new session',
            'new session',
            'start another session',
            'another session',
            'start another one',
            'another one',
            'start a new one',
            'start the next session',
            'next session',
            'begin session',
            'begin the session',
            'begin a new session',
            'begin another session',
            'begin another one',
            'restart session',
            'restart the session',
            'start over',
            'start again',
            'restart',
            'run it back',
            'kick it off',
            'let us start',
            "let's start",
            'start recording',
            'start another set',
            'start another drill',
            'start the next one',
            'one more session',
            'one more',
            'new one',
            'start fresh',
            'fresh session',
        ];

        const rec = new SR(); rec.continuous = true; rec.lang = 'en-US';
        let started = false;
        let stopped = false;
        let denied = false;
        let visibilityRetryDone = false;

        const startRec = (force = false) => {
            if (stopped) return false;
            if (started) return true;
            if (denied && !force) return false;
            try {
                rec.start();
                started = true;
                denied = false;
                return true;
            } catch (err) {
                const code = String(err?.error || err?.name || err?.message || '').toLowerCase();
                if (code.includes('not-allowed') || code.includes('denied')) {
                    denied = true;
                }
                try { console.warn('[coach] speech recognition start failed', err); } catch { }
                return false;
            }
        };
        const forceStart = () => {
            visibilityRetryDone = false;
            return startRec(true);
        };
        const stopRec = () => {
            stopped = true;
            try { rec.stop(); } catch { }
            started = false;
        };

        rec.onstart = () => {
            started = true;
            denied = false;
        };
        rec.onresult = (e) => {
            try {
                const i = e.resultIndex;
                const raw = (e.results[i][0].transcript || '').toLowerCase();
                const t = raw.replace(/\s+/g, ' ').trim();
                const wakePhrases = ['hey doach', 'hey coach'];
                const hasWake = wakePhrases.some((phrase) => t.includes(phrase));
                const awaiting = (() => { try { return window.__AWAITING_NEW_SESSION_CONFIRM === true; } catch { return false; } })();
                const isAffirmative = matchesPhrase(t, affirmativePhrases);
                const wantsStart = matchesPhrase(t, startSessionPhrases);
                const startOverlayVisible = isStartSessionOverlayVisible();

                if ((awaiting || startOverlayVisible) && (isAffirmative || wantsStart)) {
                    if (typeof window.beginLiveSession === 'function') {
                        window.beginLiveSession({ via: 'voice-affirm' });
                    } else {
                        window.dispatchEvent(new CustomEvent('hud:start-session'));
                    }
                    return;
                }

                if (hasWake && t.includes('end') && t.includes('session')) {
                    try { onEnd?.(); } catch { }
                    return;
                }

                if (hasWake && (wantsStart || isAffirmative)) {
                    if (typeof window.beginLiveSession === 'function') {
                        window.beginLiveSession({ via: 'voice-command' });
                    } else {
                        window.dispatchEvent(new CustomEvent('hud:start-session'));
                    }
                    return;
                }
            } catch { }
        };

        let visibilityHandler = null;
        let triggerHandler = null;

        if (IS_IOS) {
            triggerHandler = () => { forceStart(); };
            visibilityHandler = () => {
                if (document.hidden) return;
                if (started || stopped) return;
                if (visibilityRetryDone) return;
                visibilityRetryDone = true;
                forceStart();
            };
            window.addEventListener('coach:voice-rec-start', triggerHandler);
            document.addEventListener('visibilitychange', visibilityHandler, { passive: true });
            try { window.__startCoachVoiceRecognition = forceStart; } catch { }
        } else {
            startRec();
        }

        return () => {
            stopRec();
            if (IS_IOS) {
                if (triggerHandler) window.removeEventListener('coach:voice-rec-start', triggerHandler);
                if (visibilityHandler) document.removeEventListener('visibilitychange', visibilityHandler);
                try {
                    if (window.__startCoachVoiceRecognition === forceStart) {
                        delete window.__startCoachVoiceRecognition;
                    }
                } catch { }
            }
        };
    } catch { return () => { } }
}


// Simple speak wrapper: use your existing doachSpeak if present, fallback to Web Speech
function coachSpeak(text) {
    if (window.__coachMuted) return;
    if (!text) return;
    try {
        const now = Date.now();
        const last = window.__lastSpeak || { text: '', at: 0 };
        const dedupMs = (typeof window.SPEAK_DEDUP_MS === 'number') ? window.SPEAK_DEDUP_MS : 1200;
        if (now - (last.at || 0) < dedupMs) return;
        window.__lastSpeak = { text: String(text), at: now };
    } catch { }

    if (typeof doachSpeak === 'function') {
        try { doachSpeak(text); return; } catch (e) { console.warn('[coach] doachSpeak fail, fallback TTS', e); }
    }

    // Fallback browser TTS
    if (!webTtsAllowed()) return;
    try {
        const u = new SpeechSynthesisUtterance(text);
        u.rate = 1.0; u.pitch = 1.0;
        window.speechSynthesis?.speak(u);
    } catch { }
}

try { window.doachSpeak = doachSpeak; } catch { }
try { window.coachSpeak = doachSpeak; } catch { }
try { window.primeCoachAudio = primeCoachAudio; } catch { }
