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
    if (provider === 'server') {
      const r = await fetch('/api/tts', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ text, voice }) });
      if (r.ok) {
        const blob = await r.blob();
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audio.preload = 'auto';
        try { audio.playsInline = true; } catch {}
        audio.onended = () => { try { URL.revokeObjectURL(url); } catch {} };

        const cleanup = () => {
          try { audio.pause(); } catch {}
          try { audio.removeAttribute('src'); audio.load?.(); } catch {}
          try { URL.revokeObjectURL(url); } catch {}
        };

        let playbackOk = false;
        const waitForPlayback = new Promise((resolve, reject) => {
          let done = false;
          const finish = (ok, err) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (ok) {
              playbackOk = true;
              resolve(true);
            } else {
              reject(err || new Error('audio playback failed'));
            }
          };
          const timer = setTimeout(() => finish(false, new Error('audio playback timeout')), 1800);
          const onSuccess = () => finish(true);
          const onError = (e) => finish(false, e?.error || e);
          audio.addEventListener('playing', onSuccess, { once: true });
          audio.addEventListener('ended', onSuccess, { once: true });
          audio.addEventListener('error', onError, { once: true });
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

export async function primeCoachAudio() {
  if (__coachAudioPrimed) return true;
  if (__coachAudioPriming) return __coachAudioPriming;

  __coachAudioPriming = (async () => {
    let unlocked = false;
    try {
      const el = new Audio();
      el.src = SILENT_PRIME_WAV;
      el.preload = 'auto';
      el.muted = true;
      el.volume = 0;
      try { window.__coachPrimeAudioEl = el; } catch {}
      const play = el.play && el.play();
      if (play && typeof play.then === 'function') {
        await play;
        unlocked = true;
      } else if (play === undefined) {
        // Older iOS returns void but still primes
        unlocked = true;
      }
      if (el.pause) el.pause();
      el.src = '';
    } catch {} finally {
      try { window.__coachPrimeAudioEl = null; } catch {}
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

