// coach_voice.js — simple speech synthesis + optional voice command

let __preferredWebVoice = null;

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
    if (IS_IOS) return false;
    speakWeb(text);
    return true;
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
const SERVER_TTS_TIMEOUT_MS = 5000;
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
            this.q.push({ src, label });
            this._drain();
            return true;
        },

        async _drain() {
            if (this.playing) return;
            this.playing = true;
            const el = this.getEl();
            while (this.q.length) {
                const { src, label } = this.q.shift();
                try {
                    await this._playOnce(el, src, label);
                } catch (err) {
                    try { console.warn('[CoachAudio] playback failed', err); } catch { }
                }
            }
            this.playing = false;
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
    } catch { }
    try {
        const stored = localStorage.getItem('doach_voice');
        if (stored) return stored;
    } catch { }
    return (window.DOACH && window.DOACH.voice) || 'alloy';
}

function getTtsEngine() {
    try {
        let engine = window.TTS_ENGINE || localStorage.getItem('tts_engine') || 'openai';
        if (!engine) engine = 'openai';
        if (engine === 'web') engine = 'webspeech';
        // iOS does not support Web Speech playback reliably; force server TTS
        if (IS_IOS && engine !== 'openai') engine = 'openai';
        window.TTS_ENGINE = engine;
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
    const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : SERVER_TTS_TIMEOUT_MS;

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
    if (!text) return false;
    if (IS_IOS) return false;
    if (!('speechSynthesis' in window)) return false;

    try {
        speakWeb(text);
        return true;
    } catch (err) {
        try { console.warn('[coach] web speech failed', err); } catch { }
        return false;
    }
}

export async function doachSpeak(text, opts = {}) {
    if (!text) return false;
    try { if (window.__coachMuted) return false; } catch { }

    // 1) iOS demands the ritual. Do this before choosing engines.
    try { await window.CoachAudio?.unlock(); } catch { }

    // 2) Decide engine (force OpenAI on iOS if someone saved nonsense)
    let engine = (opts.engine || getTtsEngine() || '').toLowerCase();
    if (!engine) engine = 'openai';
    if (engine === 'web') engine = 'webspeech';
    if (IS_IOS && engine !== 'openai') engine = 'openai';

    // 3) Try the chosen path
    try {
        if (engine === 'openai') {
            const ok = await speakViaOpenAI(text, opts);
            if (ok) return true;
        } else if (engine === 'webspeech') {
            // Web Speech is pointless on iOS; route through server there
            const ok = IS_IOS ? await speakViaOpenAI(text, opts) : await speakViaWebSpeech(text);
            if (ok) return true;
        }
    } catch (err) {
        try { console.warn('[coach] doachSpeak engine error', err); } catch { }
    }

    // 4) Last resort: desktop-only Web Speech fallback
    if (!IS_IOS) {
        return speakViaWebSpeech(text);
    }

    // iOS: no-op rather than throwing more spaghetti
    return false;
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
        const SR = (window.SpeechRecognition || window.webkitSpeechRecognition);
        if (!SR) return () => { };
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
                const hasWake = t.includes('hey doach');
                const awaiting = (() => { try { return window.__AWAITING_NEW_SESSION_CONFIRM === true; } catch { return false; } })();
                const speakYes = /\b(yes|yeah|yep|sure|let('?|’)?s go|go ahead|absolutely|yup)\b/;
                const wantsStart = (t.includes('start') && t.includes('session')) || t.includes('new session');
                const startOverlayVisible = isStartSessionOverlayVisible();

                if ((awaiting || startOverlayVisible) && (speakYes.test(t) || wantsStart)) {
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

                if (hasWake && wantsStart) {
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
    try {
        const u = new SpeechSynthesisUtterance(text);
        u.rate = 1.0; u.pitch = 1.0;
        window.speechSynthesis?.speak(u);
    } catch { }
}

try { window.doachSpeak = doachSpeak; } catch { }
try { window.coachSpeak = doachSpeak; } catch { }
try { window.primeCoachAudio = primeCoachAudio; } catch { }


