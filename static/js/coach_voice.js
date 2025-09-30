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
        audio.onended = () => { try { URL.revokeObjectURL(url); } catch {} };
        await audio.play().catch(()=>{});
        return;
      }
    }
  } catch {}
  // Fallback to web TTS
  speak(text);
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

