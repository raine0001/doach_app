// coach_voice.js — simple speech synthesis + optional voice command

let __preferredWebVoice = null;

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
  } catch {}
}

try {
  if (typeof window !== 'undefined' && window.speechSynthesis) {
    window.speechSynthesis.addEventListener?.('voiceschanged', selectPreferredVoice);
    selectPreferredVoice();
  }
} catch {}

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
      synth.speak(utter);
    } catch (err) {
      try { console.warn('[coach] speakWeb failed', err); } catch {}
      resolve(false);
    }
  });
}

export function speak(text) {
  speakWeb(text);
}


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
const FORCE_SERVER_TTS_KEY = 'doach_tts_force_server';
const MAX_SPEECH_QUEUE = 6;
const SERVER_TTS_TIMEOUT_MS = 1600;

let __speechQueue = [];
let __speechBusy = false;

function getNow() {
  try {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return performance.now();
    }
  } catch {}
  return Date.now();
}

export function doachSpeak(text, opts = {}) {
  if (!text) return Promise.resolve(false);
  try { if (window.__coachMuted) return Promise.resolve(false); } catch {}

  const job = { text: String(text), opts, resolve: null, attempts: 0 };
  const result = new Promise((resolve) => { job.resolve = resolve; });

  __speechQueue.push(job);
  if (__speechQueue.length > MAX_SPEECH_QUEUE) {
    const dropped = __speechQueue.splice(0, __speechQueue.length - MAX_SPEECH_QUEUE);
    dropped.forEach((j) => { try { j.resolve?.(false); } catch {} });
    try { console.debug('[coach] speech queue trimmed', { dropped: dropped.length }); } catch {}
  }

  runSpeechQueue();
  return result;
}

async function runSpeechQueue() {
  if (__speechBusy) return;
  const job = __speechQueue.shift();
  if (!job) return;
  __speechBusy = true;
  job.attempts = (job.attempts || 0) + 1;
  const startTime = getNow();
  let ok = false;
  try {
    ok = await playSpeechJob(job.text, job.opts);
  } catch (err) {
    try { console.warn('[coach] speech error', err); } catch {}
  }

  const finish = getNow();
  try { console.debug('[coach] speech', { ok, ms: Math.round(finish - startTime), text: job.text?.slice?.(0, 80), attempts: job.attempts }); } catch {}

  if (!ok && IS_MOBILE_SPEECH_ENV && (job.attempts || 0) < 3) {
    __speechBusy = false;
    setTimeout(() => {
      try { __speechQueue.unshift(job); } catch {}
      runSpeechQueue();
    }, 140);
    return;
  }

  __speechBusy = false;
  try { job.resolve?.(ok); } catch {}
  runSpeechQueue();
}

async function playSpeechJob(text, opts = {}) {
  try { if (window.__coachMuted) return false; } catch {}
  if (!text) return false;

  if (IS_MOBILE_SPEECH_ENV) {
    try {
      if (window.__iosAudioUnlocked !== true) {
        const unlock = (typeof window.unlockIOSAudio === 'function') ? window.unlockIOSAudio : window.primeCoachAudio;
        if (typeof unlock === 'function') {
          const maybe = unlock();
          if (maybe && typeof maybe.then === 'function') {
            await maybe.catch(() => {});
          }
        }
      }
    } catch {}
  }

  const prefs = (() => {
    try { return JSON.parse(localStorage.getItem('doach_tts') || '{}'); }
    catch { return {}; }
  })();

  const rawProvider = String(opts.provider || prefs.provider || localStorage.getItem('doach_voice_provider') || 'server').toLowerCase();
  const forceServer = opts.forceServer === true
    || prefs.forceServer === true
    || localStorage.getItem(FORCE_SERVER_TTS_KEY) === 'true';
  let provider = rawProvider;

  if (provider === 'openai' || provider === 'gpt' || provider === 'ai') provider = 'server';
  if (!forceServer) {
    provider = 'web';
    try { localStorage.setItem('doach_tts', JSON.stringify({ ...prefs, provider: 'web' })); } catch {}
  }

  const voice = opts.voice
    || prefs.voice
    || localStorage.getItem('doach_voice')
    || (window.DOACH && window.DOACH.voice)
    || 'alloy';

  try { console.debug('[coach] speak provider', provider); } catch {}

  if (provider === 'server') {
    try { if (!__coachAudioPrimed) await primeCoachAudio?.(); } catch {}
    const ok = await playViaServerTTS(text, voice, opts.timeoutMs);
    if (ok) return true;
    try { console.warn('[coach] server TTS fallback to web'); } catch {}
  } else if (provider === 'web-server') {
    // compatibility alias; treat as server then fallback
    try { if (!__coachAudioPrimed) await primeCoachAudio?.(); } catch {}
    const ok = await playViaServerTTS(text, voice, opts.timeoutMs);
    if (ok) return true;
  }

  speak(text);
  return true;
}

async function playViaServerTTS(text, voice, timeoutOverride) {
  const timeoutMs = Number.isFinite(Number(timeoutOverride)) ? Number(timeoutOverride) : SERVER_TTS_TIMEOUT_MS;
  const fetchOpts = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice })
  };

  let controller = null;
  let fetchTimer = null;
  if (typeof AbortController !== 'undefined') {
    controller = new AbortController();
    fetchOpts.signal = controller.signal;
    fetchTimer = setTimeout(() => {
      try { controller.abort(); } catch {}
    }, timeoutMs);
  }

  let response;
  try {
    response = await fetch('/api/tts', fetchOpts);
  } catch (err) {
    try { console.warn('[coach] server TTS fetch error', err); } catch {}
    return false;
  } finally {
    if (fetchTimer) clearTimeout(fetchTimer);
  }

  if (!response?.ok) return false;
  const blob = await response.blob().catch(() => null);
  if (!blob) return false;

  const audio = ensureCoachAudioElement();
  if (!audio) {
    try { console.warn('[coach] audio element unavailable for TTS'); } catch {}
    return false;
  }

  const url = URL.createObjectURL(blob);

  try {
    try { audio.pause?.(); } catch {}
    try { audio.currentTime = 0; } catch {}
    try { audio.muted = false; audio.volume = 1; } catch {}
    try { audio.setAttribute('playsinline', ''); audio.playsInline = true; } catch {}

    const playbackOk = await new Promise((resolve) => {
      let started = false;
      let settled = false;
      let timerId = null;

      const settle = (ok) => {
        if (settled) return;
        settled = true;
        if (timerId) clearTimeout(timerId);
        audio.removeEventListener('playing', onPlaying);
        audio.removeEventListener('ended', onEnded);
        audio.removeEventListener('error', onError);
        resolve(ok && started);
      };

      const onPlaying = () => { started = true; };
      const onEnded = () => settle(true);
      const onError = () => settle(false);

      timerId = setTimeout(() => settle(false), Math.max(timeoutMs, 1200) * 2);

      audio.addEventListener('playing', onPlaying);
      audio.addEventListener('ended', onEnded, { once: true });
      audio.addEventListener('error', onError, { once: true });

      audio.src = url;
      try { audio.load?.(); } catch {}

      try {
        const playPromise = audio.play();
        if (playPromise && typeof playPromise.then === 'function') {
          playPromise.catch(() => onError());
        }
      } catch (err) {
        onError(err);
      }
    });

    try { audio.pause?.(); } catch {}
    try { audio.currentTime = 0; } catch {}
    try { audio.removeAttribute('src'); audio.load?.(); } catch {}

    return playbackOk;
  } finally {
    try { URL.revokeObjectURL(url); } catch {}
  }
}

const SILENT_PRIME_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=';
let __coachAudioPrimed = false;
let __coachAudioPriming = null;

function resetPrime(reason = 'manual') {
  try {
    __coachAudioPrimed = false;
    try { console.debug('[coach] prime reset', reason); } catch {}
  } catch {}
}

let __coachAudioEl = null;

function ensureCoachAudioElement() {
  if (__coachAudioEl && typeof __coachAudioEl.play === 'function') return __coachAudioEl;
  let el = null;
  try { el = new Audio(); }
  catch {
    try {
      if (typeof document !== 'undefined' && document.createElement) {
        el = document.createElement('audio');
      }
    } catch { el = null; }
  }
  if (!el) return null;
  try { el.preload = 'auto'; } catch {}
  try { el.setAttribute('playsinline', ''); } catch {}
  try { el.playsInline = true; } catch {}
  try { el.controls = false; } catch {}
  try { el.muted = false; el.volume = 1; } catch {}
  try {
    if (typeof document !== 'undefined' && document.body && !el.parentElement) {
      el.style.position = 'absolute';
      el.style.width = '0';
      el.style.height = '0';
      el.style.opacity = '0';
      el.style.pointerEvents = 'none';
      document.body.appendChild(el);
    }
  } catch {}
  try { window.__coachAudioEl = el; } catch {}
  __coachAudioEl = el;
  return el;
}

// --- iOS unlock: resume AudioContext + play a real <audio> once ---
export async function unlockIOSAudio() {
  try { await primeCoachAudio?.(); } catch {}

  // 1) Web Audio path (some Safari builds only unlock via AudioContext.resume)
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) {
      const ctx = window.__coachPrimeCtx || (window.__coachPrimeCtx = new Ctx());
      if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
        await ctx.resume();
      }
      // Play a 1-sample silent buffer through a zero gain node
      const src = ctx.createBufferSource();
      src.buffer = ctx.createBuffer(1, 1, 22050);
      const gain = ctx.createGain(); gain.gain.value = 0;
      src.connect(gain); gain.connect(ctx.destination);
      try { src.start(0); src.stop(0); } catch {}
    }
  } catch {}

  // 2) <audio> element path (some Safari builds only unlock via HTMLMediaElement.play())
  try {
    const el = (window.__coachAudioEl) || (typeof ensureCoachAudioElement === 'function' ? ensureCoachAudioElement() : null);
    if (el) {
      el.muted = false; el.volume = 1;
      el.setAttribute?.('playsinline','');
      el.playsInline = true;
      el.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA='; // silent blip
      try {
        const p = el.play?.();
        if (p && p.catch) await p.catch(()=>{});
      } catch {}
      try { el.pause?.(); el.currentTime = 0; el.removeAttribute('src'); el.load?.(); } catch {}
    }
  } catch {}

  return true;
}

// Make it globally callable from UI modules
try { window.unlockIOSAudio = unlockIOSAudio; } catch {}


export async function primeCoachAudio() {
  if (__coachAudioPrimed) return true;
  if (__coachAudioPriming) return __coachAudioPriming;

  __coachAudioPriming = (async () => {
    let unlocked = false;
    const el = ensureCoachAudioElement();
    if (el) {
      try {
        el.muted = false;
        el.volume = 0.0001;
        el.src = SILENT_PRIME_WAV;
        try { el.load?.(); } catch {}
        const play = el.play && el.play();
        if (play && typeof play.then === 'function') {
          await play;
          unlocked = true;
        } else if (play === undefined) {
          // Older iOS returns void but still primes
          unlocked = true;
        }
      } catch {}
      try { el.pause?.(); } catch {}
      try { el.currentTime = 0; } catch {}
      try { el.volume = 1; } catch {}
      try { el.removeAttribute('src'); el.load?.(); } catch {}
      try { el.muted = false; } catch {}
    }

    if (!unlocked) {
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (Ctx) {
          const ctx = window.__coachPrimeCtx || (window.__coachPrimeCtx = new Ctx());
          if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
            try { await ctx.resume(); } catch {}
          }
          const src = ctx.createBufferSource();
          src.buffer = ctx.createBuffer(1, 1, 22050);
          const gain = ctx.createGain();
          gain.gain.value = 0;
          src.connect(gain);
          gain.connect(ctx.destination);
          try { src.start(0); src.stop(0); } catch {}
          unlocked = true;
        }
      } catch {}
    }

    if (unlocked) __coachAudioPrimed = true;
    return unlocked;
  })();

  try {
    return await __coachAudioPriming;
  } finally {
    __coachAudioPriming = null;
  }
}

export function listenForEndSession(wakePhrase = 'hey doach, end the session', onEnd) {
  try {
    const SR = (window.SpeechRecognition || window.webkitSpeechRecognition);
    if (!SR) return () => {};
    const rec = new SR(); rec.continuous = true; rec.lang = 'en-US';
    rec.onresult = (e) => {
      try {
        const i = e.resultIndex; const t = (e.results[i][0].transcript||'').toLowerCase().trim();
        if (t.includes('hey doach') && t.includes('end') && t.includes('session')) { try { onEnd?.(); } catch {} }
      } catch {}
    };
    rec.start();
    return () => { try { rec.stop(); } catch {} };
  } catch { return () => {} }
}


// Simple speak wrapper: use your existing doachSpeak if present, fallback to Web Speech
function coachSpeak(text) {
  if (window.__coachMuted) return;
  if (!text) return;
  try {
    const now = Date.now();
    const last = window.__lastSpeak || { text:'', at:0 };
    const dedupMs = (typeof window.SPEAK_DEDUP_MS === 'number') ? window.SPEAK_DEDUP_MS : 1200;
    if (now - (last.at||0) < dedupMs) return;
    window.__lastSpeak = { text: String(text), at: now };
  } catch {}

  if (typeof doachSpeak === 'function') {
    try { doachSpeak(text); return; } catch (e) { console.warn('[coach] doachSpeak fail, fallback TTS', e); }
  }

  // Fallback browser TTS
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.0; u.pitch = 1.0;
    window.speechSynthesis?.speak(u);
  } catch {}
}

try { window.doachSpeak = doachSpeak; } catch {}
try { window.coachSpeak = doachSpeak; } catch {}
try { window.primeCoachAudio = primeCoachAudio; } catch {}

