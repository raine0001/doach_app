// coach_voice.js — simple speech synthesis + optional voice command

export function speak(text) {
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.0; u.pitch = 1.0; u.lang = 'en-US';
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  } catch {}
}


export async function doachSpeak(text) {
  try { if (window.__coachMuted) return; } catch {}
  try {
    const prefs = (() => {
      try { return JSON.parse(localStorage.getItem('doach_tts')||'{}'); } catch { return {}; }
    })();
    const provider = (prefs.provider || localStorage.getItem('doach_voice_provider') || 'server').toLowerCase();
    const voice = prefs.voice || localStorage.getItem('doach_voice') || (window.DOACH && window.DOACH.voice) || 'alloy';
    try { if (!__coachAudioPrimed) await primeCoachAudio?.(); } catch {}
    if (provider === 'server') {
      const r = await fetch('/api/tts', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ text, voice }) });
      if (r.ok) {
        const blob = await r.blob();
        const url = URL.createObjectURL(blob);
        const audio = ensureCoachAudioElement();
        if (!audio) {
          try { URL.revokeObjectURL(url); } catch {}
          throw new Error('audio element unavailable');
        }

        try { audio.pause?.(); } catch {}
        try { audio.currentTime = 0; } catch {}
        try { audio.muted = false; audio.volume = 1; } catch {}
        try { audio.setAttribute('playsinline', ''); } catch {}
        try { audio.playsInline = true; } catch {}

        const cleanup = () => {
          try { audio.pause?.(); } catch {}
          try { audio.currentTime = 0; } catch {}
          try { audio.src = ''; } catch {}
          try { audio.removeAttribute('src'); audio.load?.(); } catch {}
          try { URL.revokeObjectURL(url); } catch {}
        };

        let playbackOk = false;
        let endedHandler = null;
        const waitForPlayback = new Promise((resolve, reject) => {
          const timerMs = 2200;
          let done = false;

          const finish = (ok, err) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            audio.removeEventListener('playing', onPlaying);
            audio.removeEventListener('error', onError);
            if (endedHandler) {
              audio.removeEventListener('ended', endedHandler);
              endedHandler = null;
            }
            if (ok) {
              playbackOk = true;
              resolve(true);
            } else {
              reject(err || new Error('audio playback failed'));
            }
          };

          const onPlaying = () => finish(true);
          const onError = (e) => finish(false, e?.error || e);
          const onEndedDetection = () => finish(true);
          endedHandler = onEndedDetection;

          const timer = setTimeout(() => finish(false, new Error('audio playback timeout')), timerMs);

          audio.addEventListener('playing', onPlaying, { once: true });
          audio.addEventListener('error', onError, { once: true });
          audio.addEventListener('ended', onEndedDetection, { once: true });

          audio.src = url;
          try { audio.load?.(); } catch {}

          try {
            const playPromise = audio.play();
            if (playPromise && typeof playPromise.then === 'function') {
              playPromise.catch(onError);
            }
          } catch (err) {
            onError(err);
          }
        });

        try {
          await waitForPlayback;
          if (playbackOk) return;
        } catch (err) {
          cleanup();
          try { console.warn('[coach] server TTS playback failed; falling back', err); } catch {}
          resetPrime('server playback failure');
        }
      }
    }
  } catch {}
  // Fallback to web TTS
  speak(text);
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

