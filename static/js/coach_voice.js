// coach_voice.js — simple speech synthesis + optional voice command

export function speak(text) {
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.0; u.pitch = 1.0; u.lang = 'en-US';
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  } catch {}
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

try { window.coachSpeak = speak; } catch {}
