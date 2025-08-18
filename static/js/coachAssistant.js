// /static/coachAssistant.js

(function(){
  // ---------- Config ----------
  const DOACH = window.DOACH || {
    chatEndpoint: '/api/coach',  // POST {prompt, model}
    ttsEndpoint:  '/api/tts',    // POST {text, voice}
    model:        'gpt-4o-mini',
    tts:          'openai',      // 'openai' or 'web'
    voice:        'alloy',
    personality:  'positive, concise, basketball fundamentals-first',
    llmMode:      'primary',   // 'primary' | 'polish' | 'off'
  };
  window.DOACH = DOACH;
  console.log('[Doach] coachAssistant loaded');

  // Prevent double-initialization if the script is included twice
  if (window.__DOACH_INIT__) return;
  window.__DOACH_INIT__ = true;

  const SPEAK_DEDUP_MS = 1200;
  let __lastSpeak = { text: '', at: 0 };

  // ---------- Prefs + Presets ----------
  const LS_KEY = 'doachPrefs';

  const getAC = () => (window.__doachAC ||= new (window.AudioContext||window.webkitAudioContext)());


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

  function memLoad(){
    try { return JSON.parse(localStorage.getItem(MEM_KEY)) || { made:[], miss:[], golden:null, lastShot:null }; }
    catch { return { made:[], miss:[], golden:null, lastShot:null }; }
  }
  function memSave(m){ localStorage.setItem(MEM_KEY, JSON.stringify(m)); return m; }
  function mean(arr){ return arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : null; }
  function clamp(n,a,b){ return Math.max(a, Math.min(b,n)); }

  function computeGolden(made){
    if (!made.length) return null;
    const take = made.slice(-30); // last N made shots
    const pick = k => take.map(s => s.poseSnapshot?.[k]).filter(v => Number.isFinite(v));
    const g = {
      stanceWidth      : mean(pick('stanceWidth')),
      stanceWidthFeet  : mean(pick('stanceWidthFeet')),
      kneeFlex         : mean(pick('kneeFlex')),
      torsoLeanAngle   : mean(pick('torsoLeanAngle')),
      shoulderToWristAngle: mean(pick('shoulderToWristAngle')),
      feetAngleDiff    : mean(pick('feetAngleDiff')),
      feetStagger      : mean(pick('feetStagger')),
      releaseAboveShoulder: take.filter(s => s.poseSnapshot?.releaseAboveShoulder).length / take.length >= 0.6,
      entryAngle       : mean(take.map(s => s.entryAngle).filter(Number.isFinite)),
      arcHeight        : mean(take.map(s => s.arcHeight).filter(Number.isFinite)),
      count: take.length
    };
    return g;
  }

  function addShotToMemory(shot){
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
    reset: () => memSave({made:[],miss:[],golden:null,lastShot:null}),
    lastShot: () => memLoad().lastShot,
    recent: (n=10) => {
      const m = memLoad();
      const all = [...m.made, ...m.miss].filter(Boolean).sort((a,b)=> (a.ts||0)-(b.ts||0));
      return all.slice(-n);
    },
    reset: () => memSave({made:[],miss:[],golden:null,lastShot:null})
    };


  // Export on window
  window.doachGetPrefs = doachGetPrefs;
  window.doachSetPrefs = doachSetPrefs;

  function getPrefs(){ try{ return JSON.parse(localStorage.getItem(LS_KEY))||{}; }catch{ return {}; } }
  function setPrefs(p){ localStorage.setItem(LS_KEY, JSON.stringify(p)); window.__doachPrefs=p; return p; }

  async function loadPresets(){
    try{ const r=await fetch('/api/voice_presets'); if(!r.ok) throw 0; const j=await r.json(); return Array.isArray(j.presets)?j.presets:[]; }
    catch{ try{ return JSON.parse(localStorage.getItem(LS_PRESETS))||[]; }catch{ return []; } }
  }
  async function savePreset(preset){
    try{ const r=await fetch('/api/voice_presets',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({preset})}); if(!r.ok) throw 0; return true; }
    catch{ const a=await loadPresets(); const i=a.findIndex(x=>x.name===preset.name); if(i>=0)a[i]=preset; else a.push(preset); localStorage.setItem(LS_PRESETS,JSON.stringify(a)); return true; }
  }
  async function deletePreset(name){
    try{ const r=await fetch('/api/voice_presets/'+encodeURIComponent(name),{method:'DELETE'}); if(!r.ok) throw 0; return true; }
    catch{ const a=await loadPresets(); localStorage.setItem(LS_PRESETS, JSON.stringify(a.filter(x=>x.name!==name))); return true; }
  }
  window.doachLoadPresets=loadPresets; window.doachSavePreset=savePreset; window.doachDeletePreset=deletePreset;


  // a better robot ----------------------------------------- //
  // --- Natural coaching line generator (varied, metric-aware)
  function seededRandom(seed){ const x = Math.sin(seed*9301+49297)*233280; return x - Math.floor(x); }
  function pick(arr, seed){ return arr[Math.floor(seededRandom(seed)*arr.length)] || arr[0]; }

  function craftCoachingLine(shot, golden, opts={}) {
    const p = shot.poseSnapshot || {};
    const seed = (shot.ts || Date.now()) + (opts.bumpSeed ? 101 : 0);

    // strengths for positive first sentence
    const strengths = [];
    if (p.releaseAboveShoulder) strengths.push('high release');
    if (Number.isFinite(p.shoulderToWristAngle) && p.shoulderToWristAngle >= 50) strengths.push('vertical arm');
    if (Number.isFinite(p.kneeFlex) && p.kneeFlex >= (golden?.kneeFlex || 28) * 0.8) strengths.push('good knee load');
    if (Number.isFinite(p.stanceWidthFeet) && golden?.stanceWidthFeet &&
        Math.abs(p.stanceWidthFeet - golden.stanceWidthFeet) <= 15) strengths.push('balanced base');
    if (Number.isFinite(shot.entryAngle) && golden?.entryAngle &&
        Math.abs(shot.entryAngle - golden.entryAngle) <= 4) strengths.push('target entry angle');

    const first = phrasePraise(strengths, seed);

    // pick best cue with variety
    const issues = buildIssues(shot, golden);
    const chosen = chooseCue(issues);
    const cueTxt = chosen ? chosen.msg : 'Hold your follow-through for a count.';
    const bridges = ['Quick cue:', 'Small tweak:', 'Next rep,', 'Dial this in:'];
    const bridge = bridges[ seed % bridges.length ];

    return `${first} ${bridge} ${cueTxt}`;
  }

  function craftMissLine(shot, golden, opts={}) {
    const seed = (shot.ts || Date.now()) + (opts.bumpSeed ? 303 : 0);
    const openers = ['Good look.', 'Right idea.', 'Close.', 'Almost.', 'Not far off.'];
    const opener = openers[ seed % openers.length ];

    const issues = buildIssues(shot, golden);
    const chosen = chooseCue(issues);
    const cueTxt = chosen ? chosen.msg : 'Load a touch more with your knees and finish high.';
    const bridges = ['Fix this next:', 'Quick cue:', 'Small tweak:', 'Next rep,'];
    const bridge = bridges[(seed+1) % bridges.length];

    return `${opener} ${bridge} ${cueTxt}`;
  }

  // ---- Issue builder with severity + category (new)
  function buildIssues(shot, golden) {
    const p = shot?.poseSnapshot || {};
    const g = golden || {
      stanceWidthFeet: 120, kneeFlex: 28, torsoLeanAngle: 0, shoulderToWristAngle: 55,
      feetAngleDiff: 8, feetStagger: 6, releaseAboveShoulder: true, entryAngle: 48, arcHeight: 120
    };

    const issues = [];
    const push = (cat, severity, msg) => { if (severity > 0) issues.push({cat, severity, msg}); };

    // Feet width
    if (Number.isFinite(p.stanceWidthFeet) && g.stanceWidthFeet) {
      const d = (p.stanceWidthFeet - g.stanceWidthFeet);
      const ad = Math.abs(d);
      if (ad > 35) push('feetWidth', 9, d < 0 ? 'Feet too narrow — widen ~2–3".' : 'Feet too wide — bring them in slightly.');
      else if (ad > 20) push('feetWidth', 6, d < 0 ? 'Open your base a touch for balance.' : 'Narrow your base slightly to stay stacked.');
    }

    // Feet alignment / stagger
    if (Number.isFinite(p.feetAngleDiff)) {
      const over = p.feetAngleDiff - (g.feetAngleDiff||8);
      if (over > 10) push('feetAngle', 7, 'Square both toes to the rim.');
      else if (over > 5) push('feetAngle', 5, 'Make your toes more parallel.');
    }
    if (Number.isFinite(p.feetStagger)) {
      const over = p.feetStagger - (g.feetStagger||6);
      if (over > 16) push('feetStagger', 6, 'Level your feet — reduce the front/back stagger.');
      else if (over > 10) push('feetStagger', 4, 'Even out your stance front-to-back.');
    }

    // Lower-body power
    if (Number.isFinite(p.kneeFlex)) {
      const ratio = p.kneeFlex / (g.kneeFlex||28);
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
      const d = (g.shoulderToWristAngle||55) - p.shoulderToWristAngle;
      if (d > 12) push('releaseArm', 8, 'Get the shooting arm more vertical on release.');
      else if (d > 6) push('releaseArm', 5, 'Finish with a taller arm line.');
    }
    if ((g.releaseAboveShoulder ?? true) && !p.releaseAboveShoulder) {
      push('releaseHeight', 7, 'Release above your shoulder line.');
    }
    if (p.wristY!=null && p.elbowY!=null && p.wristY > p.elbowY + 10) {
      push('wristFinish', 6, 'Snap the wrist high — finish above the elbow.');
    }

    // Ball metrics
    if (Number.isFinite(shot.entryAngle) && g.entryAngle) {
      const d = shot.entryAngle - g.entryAngle;
      if (d < -6) push('entryFlat', 9, 'Entry angle is flat — add arc.');
      else if (d > 6) push('entrySteep', 7, 'Entry angle is steep — soften the arc.');
    } else if (Number.isFinite(shot.entryAngle)) {
      if (shot.entryAngle < 44) push('entryFlat', 8, 'A bit flat — add arc.');
      else if (shot.entryAngle > 54) push('entrySteep', 6, 'A tad steep — soften the arc.');
    }

    // arcHeight if you compute it
    if (Number.isFinite(shot.arcHeight) && g.arcHeight) {
      const d = shot.arcHeight - g.arcHeight;
      if (d < -20) push('arcLow', 6, 'Lift the arc slightly (more upward energy).');
      else if (d > 30) push('arcHigh', 4, 'Flatten the arc a touch (drive forward).');
    }

    // Sort by severity descending
    issues.sort((a,b)=> b.severity - a.severity);
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
  function phrasePraise(strengths, seed) {
    const opens = ['Money.', 'Buckets.', 'Splash.', 'Nice make.', 'There it is.', 'Cash.'];
    const connectors = ['Lock that in.', 'That’s repeatable.', 'Keep that feel.', 'Love that tempo.'];
    const r = (n)=> Math.floor((Math.sin((seed+n)*9301+49297)*233280)%opens.length + opens.length) % opens.length;
    const r2= (n)=> Math.floor((Math.sin((seed+n)*7411+19333)*233280)%connectors.length + connectors.length) % connectors.length;
    const opener = opens[r(1)];
    const praise = strengths?.length ? `Nice ${strengths[r2(2)%strengths.length]}.` : connectors[r2(3)];
    return `${opener} ${praise}`;
  }

  // keep a tiny history so we don’t repeat exact lines back-to-back
  window.__coachLineHistory = [];
  function avoidRepeat(text, shot, golden, made) {
    const recent = window.__coachLineHistory.slice(-4);
    if (recent.includes(text)) {
      return (made ? craftCoachingLine : craftMissLine)(shot, golden, { bumpSeed: true });
    }
    return text;
  }

  // ---------- Web Speech voices ----------
  let webVoices=[];
  function refreshVoices(){ webVoices = window.speechSynthesis?.getVoices?.()||[]; return webVoices; }
  if('speechSynthesis' in window){ speechSynthesis.onvoiceschanged = refreshVoices; refreshVoices(); }
  window.doachListWebVoices = (lang='') => {
    const v=refreshVoices();
    return lang ? v.filter(x => (x.lang||'').toLowerCase().startsWith(lang.toLowerCase())) : v;
  };

  // ---------- OpenAI TTS + WebAudio EQ ----------
  async function ttsFetchBlob(text, voice){
    const res = await fetch(DOACH.ttsEndpoint,{
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ text, voice: voice||'alloy' })
    });
    if(!res.ok){ const t=await res.text().catch(()=> ''); throw new Error(`TTS failed: ${res.status} ${t}`.trim()); }
    return await res.blob();
  }
  async function playWithEQ(blob, p){
    const ctx = getAC();
    const arr = await blob.arrayBuffer();
    const buf = await ctx.decodeAudioData(arr);
    const src = ctx.createBufferSource(); src.buffer = buf;

    const bass = ctx.createBiquadFilter(); bass.type='lowshelf';  bass.frequency.value=180;  bass.gain.value = p?.bassDb ?? 0;
    const tre  = ctx.createBiquadFilter(); tre.type='highshelf'; tre.frequency.value=3000; tre.gain.value  = p?.trebleDb ?? 0;
    const gain = ctx.createGain();         gain.gain.value = p?.volume ?? 1;

    src.playbackRate.value = p?.speed ?? 1;
    src.connect(bass); bass.connect(tre); tre.connect(gain); gain.connect(ctx.destination);
    src.start(0);
    return new Promise(r => src.onended = r);
  }

  // ---------- Web Speech playback ----------
  async function speakWeb(text, p){
    if(!('speechSynthesis' in window)) throw new Error('Web Speech not supported');
    const u = new SpeechSynthesisUtterance(text);
    u.lang   = p?.lang   || 'en-US';
    u.rate   = p?.speed  ?? 1;
    u.pitch  = p?.pitch  ?? 1;
    u.volume = p?.volume ?? 1;
    if(p?.webVoiceName){
      const v = webVoices.find(v => v.name===p.webVoiceName && (!p.lang || v.lang.startsWith(p.lang)));
      if(v) u.voice = v;
    }
    return new Promise((res,rej)=>{ u.onend=res; u.onerror=e=>rej(e.error||e); speechSynthesis.speak(u); });
  }

  // ---------- Auto-translate for OpenAI TTS (text drives language) ----------
  async function translateIfNeeded(text, lang){
    if(!lang || lang.startsWith('en')) return text;
    try{
      const r = await fetch(DOACH.chatEndpoint, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ prompt:`Translate to ${lang}. Keep coaching tone. Only output the sentence:\n\n${text}`, model: DOACH.model })
      });
      if(!r.ok) return text; const j=await r.json(); return (j.text||text).trim();
    }catch{ return text; }
  }

  // ---------- Public: speak ----------
  window.doachSpeak = async function(input){
    const p = {...{voice:DOACH.voice, tts:DOACH.tts, speed:1, volume:1, bassDb:0, trebleDb:0}, ...getPrefs()};
    const text = typeof input==='string' ? input : (input?.text || '');
    if(!text) return;

    if(p.tts==='web'){ await speakWeb(text, p); return; }

    const speakText = (p.lang && !p.lang.startsWith('en')) ? await translateIfNeeded(text, p.lang) : text;
    const blob = await ttsFetchBlob(speakText, p.voice || 'alloy');
    await playWithEQ(blob, p);
  };

  // ---------- Capture pose content for analysis ----------
  window.capturePoseSnapshot = function(playerState, hoopBox){
    try{
      const kp = playerState?.keypoints||[];
      // BlazePose indices
      const NOSE=0, L_SHOULDER=11,R_SHOULDER=12,L_ELBOW=13,R_ELBOW=14,L_WRIST=15,R_WRIST=16;
      const L_HIP=23,R_HIP=24,L_KNEE=25,R_KNEE=26,L_ANK=27,R_ANK=28,L_HEEL=29,R_HEEL=30,L_TOE=31,R_TOE=32;

      const need = [L_SHOULDER,R_SHOULDER,L_ELBOW,R_ELBOW,L_WRIST,R_WRIST,L_HIP,R_HIP,L_KNEE,R_KNEE,L_ANK,R_ANK,L_TOE,R_TOE]
        .every(i => kp[i]?.x!=null && kp[i]?.y!=null);
      if(!need) return null;

      const avg = (a,b)=>({x:(a.x+b.x)/2,y:(a.y+b.y)/2});
      const shoulder=avg(kp[L_SHOULDER],kp[R_SHOULDER]);
      const elbow   = avg(kp[L_ELBOW],kp[R_ELBOW]);
      const wrist   = avg(kp[L_WRIST],kp[R_WRIST]);
      const hip     = avg(kp[L_HIP],kp[R_HIP]);
      const knee    = avg(kp[L_KNEE],kp[R_KNEE]);
      const ank     = avg(kp[L_ANK],kp[R_ANK]);

      const deg = r => Math.round(r*180/Math.PI);
      const angleDeg=(a,b)=>deg(Math.atan2(a.y-b.y, b.x-a.x));   // vertical-ish measure
      const signed  =(a,b)=>deg(Math.atan2(b.y-a.y, b.x-a.x));   // signed around body

      // Feet angles (ankle → toe) and differences / stagger
      const footAngle = (ankle, toe) => deg(Math.atan2(toe.y-ankle.y, toe.x-ankle.x));
      const leftFootAngle  = footAngle(kp[L_ANK], kp[L_TOE]);
      const rightFootAngle = footAngle(kp[R_ANK], kp[R_TOE]);
      const feetAngleDiff  = Math.abs(leftFootAngle - rightFootAngle);
      const feetStagger    = Math.abs(kp[L_ANK].y - kp[R_ANK].y);

      // Useful metrics
      const stanceWidthFeet = Math.abs(kp[L_ANK].x - kp[R_ANK].x);
      const stanceWidthHip  = Math.abs(kp[L_HIP].x - kp[R_HIP].x); // keep your legacy
      const kneeFlex        = Math.max(0, (knee.y - hip.y));       // px: bigger = more bend
      const torsoLeanAngle  = signed(hip, shoulder);               // + forward, - backward
      const shoulderToWristAngle = angleDeg(shoulder, wrist);      // higher = more vertical arm
      const releaseAboveShoulder = (wrist.y + elbow.y)/2 < shoulder.y; // y-up is negative screen

      const wristToHoop = hoopBox
        ? Math.hypot((hoopBox.x + (hoopBox.w||0)/2) - wrist.x, (hoopBox.y + (hoopBox.h||0)/2) - wrist.y)
        : null;

      return {
        // keep old names so your code keeps working
        stanceWidth: stanceWidthHip,
        kneeFlex,
        torsoLeanAngle,
        shoulderToWristAngle,
        wristToHoop,

        // NEW: explicit heights for your rating rules
        wristY: wrist.y, elbowY: elbow.y, shoulderY: shoulder.y,
        releaseAboveShoulder,

        // NEW: feet metrics
        stanceWidthFeet,
        leftFootAngle, rightFootAngle, feetAngleDiff, feetStagger
      };
    }catch{ return null; }
  };

  //LLM helper
  function composeLLMPrompt(shot, golden, draftLine, made, personality) {
    // Tight JSON context = less waffle, more specific coaching
    const ctx = {
      made,
      metrics: {
        arcHeight: Math.round(shot.arcHeight || 0),
        entryAngle: shot.entryAngle ?? null,
        releaseAngle: shot.releaseAngle ?? null
      },
      pose: shot.poseSnapshot || null,
      golden: golden || null,
      lastCategories: (window.__coachCueHistory || []).slice(-3)
    };

    // Hard constraints make responses consistent + short
    return `
  You are Doach, a ${personality} shooting coach.

  Write a single coaching line (1–2 short sentences) for this shot.
  - If "made" is true: start with quick positive reinforcement, then one specific cue.
  - If "made" is false: empathetic opener, then one specific fix.
  - Use the numeric metrics when helpful (round to whole numbers).
  - Prefer the HIGHEST-SEVERITY issue (feet width/angle/stagger, power/knees, torso lean, release height/arm vertical, wrist finish, entry angle/arc).
  - Avoid repeating the same category as any of: ${JSON.stringify(ctx.lastCategories)} if a similarly severe alternative exists.
  - Keep it concrete: e.g., "add ~2–3 inches", "taller arm line", "release above shoulder", "add arc", etc.
  - No emojis. No bullet points.

  Context (JSON):
  ${JSON.stringify(ctx)}
  ${draftLine ? `\nDraft to improve (optional): "${draftLine}"` : ''}

  Return only the final coaching line.
  `.trim();
  }


  // analyze shot pose
  window.doachOnShot = async function(shot){
  try{
    if (!shot.poseSnapshot && window.playerState) {
      shot.poseSnapshot = window.capturePoseSnapshot(window.playerState, window.getLockedHoopBox?.());
    }
    shot.ts = shot.ts || Date.now();

    const mem    = window.DOACH_MEM.get();
    const golden = mem.golden;
    const made   = !!shot.made;

    // Local draft (always compute; used for polish or fallback)
    let localText = made ? craftCoachingLine(shot, golden) : craftMissLine(shot, golden);
    localText = avoidRepeat(localText, shot, golden, made);

    // Choose how to use the LLM
    const mode = (window.DOACH?.llmMode || 'polish').toLowerCase();
    let text = localText;

    if (mode !== 'off' && window.DOACH?.chatEndpoint) {
      try {
        const prompt = composeLLMPrompt(
          shot, golden,
          mode === 'polish' ? localText : '', // primary: no draft; polish: send draft
          made,
          window.DOACH?.personality || 'positive, concise'
        );
        const r = await fetch(window.DOACH.chatEndpoint, {
          method:'POST',
          headers:{'Content-Type':'application/json'},
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

    const el = document.getElementById('coachNotes');
    if (el) { el.style.display='block'; el.textContent = text; }
    const now = Date.now();
      if (text === __lastSpeak.text && (now - __lastSpeak.at) < SPEAK_DEDUP_MS) {
        return; // skip duplicate speak
      }
      __lastSpeak = { text, at: now };
    // await window.doachSpeak?.(text);
    queueMicrotask(() => window.doachSpeak?.(text));   // que the response to prevent video walkover

  }catch(e){ console.warn('[doachOnShot]', e); }
};


  //  Pass analysis to memory  ------------------------------- //
  window.updateCoachNotes = function updateCoachNotes(shot) {
    const container = document.getElementById('coachNotes');
    if (!container || !shot) return;

    const mem = window.DOACH_MEM.get();
    const golden = mem.golden;
    const tips = window.summarizePoseIssues?.(shot, golden) || [];
    const rating = window.computeShotRating?.(shot.poseSnapshot, golden) ?? 50;

    let html = `
      <strong>🤖 Coach Feedback</strong><br>
      <div style="font-size: 18px; margin-bottom: 6px;">
        🏅 Shot Rating: <strong style="color:${rating >= 80 ? 'lightgreen' : rating >= 50 ? 'orange' : 'red'}">${rating}/100</strong>
        ${golden ? `<span style="opacity:.7;">(vs ${golden.count} made)</span>` : ``}
      </div>
      ${tips.length ? `<ul>${tips.map(t => `<li>${t}</li>`).join('')}</ul>`
                    : `<span style="color:lightgreen;">✅ No major pose issues detected.</span>`}
    `;
    if (shot.discarded) {
      html = `<div style="color: orange; font-weight: bold; margin-bottom: 6px;">
        ⚠️ Shot was discarded: ${shot.missReason || 'No reason provided'}
      </div>` + html;
    }

    container.style.display = 'block';
    container.innerHTML = html;
    container.style.backgroundColor = 'rgba(0,0,0,0.9)';
    container.style.border = '1px solid lime';
    };

  window.computeShotRating = function computeShotRating(pose, golden){
    const clamp = (n,a,b) => Math.max(a, Math.min(b, n));
    if (!pose) return 50;
    // If we have a golden pose, score vs golden; else use sensible defaults
    const g = golden || {
      stanceWidthFeet: 120, kneeFlex: 28, torsoLeanAngle: 0, shoulderToWristAngle: 55,
      feetAngleDiff: 8, feetStagger: 6, releaseAboveShoulder: true
    };

    let score = 100;
    const penal = (amt) => { score -= amt; };

    // Feet: width, alignment, stagger
    if (g.stanceWidthFeet){
      const d = Math.abs((pose.stanceWidthFeet||g.stanceWidthFeet) - g.stanceWidthFeet);
      if (d > 35) penal(10); else if (d > 20) penal(5);
    }
    if (Number.isFinite(pose.feetAngleDiff)){
      if (pose.feetAngleDiff > (g.feetAngleDiff||8) + 8) penal(8);
      else if (pose.feetAngleDiff > (g.feetAngleDiff||8) + 4) penal(4);
    }
    if (Number.isFinite(pose.feetStagger) && pose.feetStagger > (g.feetStagger||6) + 10) penal(6);

    // Lower body power
    if (Number.isFinite(pose.kneeFlex)){
      if (pose.kneeFlex < (g.kneeFlex||28) * 0.6) penal(12);
      else if (pose.kneeFlex < (g.kneeFlex||28) * 0.8) penal(6);
    }

    // Torso
    if (Number.isFinite(pose.torsoLeanAngle) && Math.abs(pose.torsoLeanAngle) > 18) penal(8);

    // Arm / release
    if (Number.isFinite(pose.shoulderToWristAngle)){
      if (pose.shoulderToWristAngle < (g.shoulderToWristAngle||55) - 12) penal(10);
      else if (pose.shoulderToWristAngle < (g.shoulderToWristAngle||55) - 6) penal(5);
    }
    if (pose.wristY!=null && pose.elbowY!=null && pose.wristY > pose.elbowY + 10) penal(6);
    if (g.releaseAboveShoulder && !pose.releaseAboveShoulder) penal(8);

    return clamp(Math.round(score), 0, 100);
    };

  window.summarizePoseIssues = function summarizePoseIssues(shot, golden){
    const issues = [];
    const p = shot?.poseSnapshot; if (!p) return issues;
    const g = golden || {};

  // Feet
  if (Number.isFinite(p.stanceWidthFeet) && g.stanceWidthFeet){
    const d = p.stanceWidthFeet - g.stanceWidthFeet;
    if (d < -20) issues.push("Feet too narrow — widen ~2–3\".");
    else if (d > 20) issues.push("Feet too wide — narrow slightly.");
  }
  if (Number.isFinite(p.feetAngleDiff) && p.feetAngleDiff > (g.feetAngleDiff||8) + 6){
    issues.push("Feet not parallel — square both toes to the rim.");
  }
  if (Number.isFinite(p.feetStagger) && p.feetStagger > (g.feetStagger||6) + 10){
    issues.push("Feet staggered — level your base.");
  }

  // Power / lower body
  if (Number.isFinite(p.kneeFlex) && (p.kneeFlex < (g.kneeFlex||28) * 0.75)){
    issues.push("Add more knee bend to generate power.");
  }

  // Torso
  if (Number.isFinite(p.torsoLeanAngle) && Math.abs(p.torsoLeanAngle) > 18){
    issues.push("Stay more upright through the lift.");
  }

  // Arm / release
  if (Number.isFinite(p.shoulderToWristAngle) && p.shoulderToWristAngle < (g.shoulderToWristAngle||55) - 8){
    issues.push("Get your shooting arm more vertical on release.");
  }
  if (p.wristY!=null && p.elbowY!=null && p.wristY > p.elbowY + 10){
    issues.push("Finish higher — snap the wrist above the elbow.");
  }
  if ((g.releaseAboveShoulder ?? true) && !p.releaseAboveShoulder){
    issues.push("Release above your shoulder line.");
  }

  // Ball metrics if present
  if (Number.isFinite(shot.entryAngle) && g.entryAngle){
    if (shot.entryAngle < g.entryAngle - 5) issues.push("Entry angle a bit flat — add arc.");
    else if (shot.entryAngle > g.entryAngle + 5) issues.push("Entry angle steep — soften the arc.");
  }

  return issues;
  };


//  hands free Doach integration
(function(){
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  function answerFromMetrics(q, last, golden){
    if (!last?.poseSnapshot) return "I need a shot first to analyze.";
    const p = last.poseSnapshot;
    const g = golden || {};
    q = (q||'').toLowerCase();

    const say = (s) => s.replace(/\s+/g,' ').trim();

    if (q.match(/foot|feet|base|stance/)) {
      const w = Math.round(p.stanceWidthFeet||p.stanceWidth||0);
      const diff = (g.stanceWidthFeet? w - Math.round(g.stanceWidthFeet) : 0);
      const angle = Math.round(p.feetAngleDiff||0);
      const stag  = Math.round(p.feetStagger||0);
      return say(`Feet width ${w}px${g.stanceWidthFeet?`, target ${Math.round(g.stanceWidthFeet)}px (Δ${diff})`:''}. 
                  Toe alignment off by ${angle}°. ${stag>10?'Feet staggered; level your base.':'Base is level.'}`);
    }

    if (q.match(/release|follow/)) {
      const ang = p.shoulderToWristAngle ?? 0;
      const high = p.releaseAboveShoulder ? "above" : "below";
      const wristVsElbow = (p.wristY!=null && p.elbowY!=null && p.wristY > p.elbowY + 10) ? "low" : "high";
      return say(`Arm angle ${ang}°. Release is ${high} shoulder. Wrist finished ${wristVsElbow}. Aim for a higher vertical finish.`);
    }

    if (q.match(/power|leg|knee/)) {
      const k = Math.round(p.kneeFlex||0);
      const tgt = g.kneeFlex ? `; target ~${Math.round(g.kneeFlex)}` : '';
      return say(`Knee bend ${k}px${tgt}. ${k < (g.kneeFlex||28)*0.75 ? 'Add more bend for power.' : 'Power from legs looked solid.'}`);
    }

    if (q.match(/arc|entry/)) {
      const ea = Math.round(last.entryAngle ?? 0);
      const ga = golden?.entryAngle ? Math.round(golden.entryAngle) : 50;
      return say(`Entry angle ${ea}°. ${Math.abs(ea-ga)<=5?'On target.': ea<ga?'A bit flat — add arc.':'A tad steep — soften the arc.'}`);
    }

    if (q.match(/accur|make|made/)) {
      const m = (window.DOACH_MEM.get().made||[]).length;
      const total = (window.DOACH_MEM.get().made||[]).length + (window.DOACH_MEM.get().miss||[]).length;
      const acc = total? Math.round(100*m/total):0;
      return say(`Session accuracy ${acc}% (${m}/${total}).`);
    }

    return "Ask about feet, release, power, arc, or accuracy.";
  }

  let rec=null, listening=false;
  window.startDoachListener = function(){
    if (!SR) { window.doachSpeak?.("Voice input not supported on this browser."); return; }
    if (listening) return;
    rec = new SR(); rec.lang='en-US'; rec.continuous=true; rec.interimResults=false;
    rec.onresult = (e)=>{
      const transcript = Array.from(e.results).map(r=>r[0].transcript).join(' ');
      const mem = window.DOACH_MEM.get();
      const reply = answerFromMetrics(transcript, mem.lastShot, mem.golden);
      window.doachSpeak?.(reply);
      const box = document.getElementById('coachNotes');
      if (box) box.innerHTML = `<strong>🎙 You:</strong> ${transcript}<br><strong>🤖 Doach:</strong> ${reply}`;
    };
    rec.onerror = ()=>{};
    rec.onend = ()=>{ listening=false; };
    rec.start(); listening=true;
    window.doachSpeak?.("Listening. Ask about feet, release, power, arc, or accuracy.");
  };
  window.stopDoachListener = function(){ try{ rec?.stop(); }catch{} listening=false; };
  })();

  let __lastShotEventAt = 0;
  let __lastShotSig = '';

  function shotSig(s) {
    // build a stable signature using fields that don't change
    return [
      s.__idx ?? '',
      s.id ?? '',
      s.startFrame ?? '',
      s.ts ?? '',
      s.entryAngle ?? '',
      s.releaseAngle ?? '',
      s.made ? 1 : 0
    ].join('|');
  }

  let __processedShotKeys = new Set();
  const __processedExpireMs = 10_000; // keep keys ~10s then GC
  let __processedTimestamps = [];

  function makeShotKey(s) {
    // Build a stable signature from fields that don't change across re-emits
    const idLike = s.id ?? s.__idx ?? '';
    const start = s.startFrame ?? s.start ?? '';
    const end   = s.endFrame ?? s.end ?? '';
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

  window.addEventListener('shot:summary', (e) => {
    // If we’ve already handled THIS object, bail (covers re-dispatch)
    if (e.detail && e.detail.__doachHandled) return;

    const shot = e.detail;
    const key = makeShotKey(shot || {});
    if (key && __processedShotKeys.has(key)) return; // already handled a twin

    // Mark original payload so a re-dispatch of the same object won’t run again
    if (shot) shot.__doachHandled = true;
    rememberKey(key);

    console.log('[Doach] shot:summary handled key=', key, shot);

    // proceed with your existing logic
    const cloned = { ...shot };
    if (!cloned.poseSnapshot && window.playerState) {
      cloned.poseSnapshot = window.capturePoseSnapshot(window.playerState, window.getLockedHoopBox?.());
    }
    window.DOACH_MEM.addShot(cloned);
    window.updateCoachNotes?.(cloned);
    //window.doachOnShot?.(cloned);   // speak + one-liner
  });


  // ───────────────────────────────────────────────
  // Voice Q&A: wake-word → capture → answer
  // ───────────────────────────────────────────────
  (function () {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { console.warn('[Doach Voice] SpeechRecognition not supported'); return; }

    // Wake words (loose match)
    const DOACH = window.DOACH || (window.DOACH = {});
    DOACH.WAKE_WORDS = DOACH.WAKE_WORDS || ['hey doach', 'my coach', 'coach', 'douch'];

    const prefs = (window.doachGetPrefs?.() || {});
    const recog = new SR();
    recog.lang = prefs.lang || 'en-US';
    recog.continuous = true;
    recog.interimResults = true;

    let listening = false;
    let captureMode = false;          // true after wake-word; captures the question
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

    function lastShot() {
      return window.DOACH_MEM?.lastShot?.() || null;
    }

    function answerLocal(q) {
      const L = lastShot();
      if (!L) return "I don't have a shot yet. Take one and ask again.";
      const p = L.poseSnapshot || {};
      const parts = [];
      const n = norm(q);

      // Feet / stance
      if (/(foot|feet|stance)/.test(n)) {
        const w = p.stanceWidth;
        if (w == null) parts.push("I couldn't see your feet clearly.");
        else parts.push(`Stance width was ${Math.round(w)}px — ${w < 100 ? 'a bit narrow' : 'solid'}. Aim for about shoulder width plus a bit.`);
      }

      // Release / wrist / elbow
      if (/(release|wrist|elbow|follow)/.test(n)) {
        const ang = p.shoulderToWristAngle;
        if (ang == null) parts.push("I couldn't read your arm angle.");
        else parts.push(`Release angle was ~${Math.round(ang)}°. Try finishing near 50–60° with a full follow-through.`);
      }

      // Power / knee bend
      if (/(power|legs|knee|dip|bend)/.test(n)) {
        const k = p.kneeFlex;
        if (k == null) parts.push("I couldn't estimate knee bend.");
        else parts.push(`Knee bend was ~${Math.round(k)}px. Add a bit more load if the shot felt short.`);
      }

      // Arc / entry
      if (/(arc|entry|angle)/.test(n)) {
        const arc = Math.round(L.arcHeight || 0);
        const entry = L.entryAngle ?? '–';
        parts.push(`Arc ~${arc}px, entry ${entry}°. Target a consistent entry around mid-40s to low-50s.`);
      }

      // Makes / accuracy
      if (/(make|accuracy|percent|score)/.test(n)) {
        const recent = window.DOACH_MEM?.recent?.(10) || [];
        const made = recent.filter(s => s.made).length;
        parts.push(`Last ${recent.length} shots: ${made} made (${recent.length ? Math.round(made / recent.length * 100) : 0}%).`);
      }

      if (!parts.length) {
        const issues = window.summarizePoseIssues?.(L) || [];
        parts.push(`Last shot was ${L.made ? 'made' : 'missed'} — arc ${Math.round(L.arcHeight || 0)}px, entry ${L.entryAngle ?? '–'}°, release ${L.releaseAngle ?? '–'}°.`);
        if (issues[0]) parts.push(issues[0]);
      }
      return parts.join(' ');
    }

    function showDot(on) {
      const root = document.getElementById('hudRoot') || document.body || document.documentElement;
      if (!root) return; // DOM not ready yet
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

    function start() { if (listening) return; listening = true; try { recog.start(); } catch {} showDot(true); }
    function stop()  { listening = false; try { recog.stop(); } catch {} clearTimeout(captureTimer); captureMode = false; showDot(false); }

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
        window.doachSpeak?.("Yes?");
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
        if (!/(feet|stance|release|wrist|elbow|power|knee|arc|entry|angle|make|accuracy)/.test(q)) {
          try {
            const ctx = { lastShot: lastShot(), recent: window.DOACH_MEM?.recent?.(5) };
            const r = await fetch(DOACH.chatEndpoint, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                prompt: `You are Doach. User asked: "${finalText}". Use this context JSON:\n${JSON.stringify(ctx)}\nGive a specific, actionable answer in 1–2 short sentences.`,
                model: DOACH.model
              })
            });
            const j = await r.json();
            if (j?.text) reply = j.text.trim();
          } catch (e) { /* keep local reply */ }
        }

        window.doachSpeak?.(reply);
      }
    };

    recog.onend = () => { if (listening) { try { recog.start(); } catch {} } };
    recog.onerror = (e) => { console.warn('[Doach Voice] error', e?.error || e); };

    // Public controls
    window.doachVoice = {
      on: start,
      off: stop,
      toggle: () => (listening ? stop() : start()),
      isOn: () => listening
    };

    // Auto-start unless user disabled it in prefs
    if (prefs.voiceWake !== false) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => start());
    } else {
      start();
    }
  }
  })();
  })();
