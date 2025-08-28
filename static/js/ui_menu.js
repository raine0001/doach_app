// /static/js/ui_menu.js
// Hamburger menu + slideouts + floating MyDoach button
// DOES NOT TOUCH VIDEO LOADING. Uses #videoInput and handleVideoUpload in app.js.

(function () {
  // Prevent double init if the script is included twice (or with different query strings)
  if (window.__DOACH_MENU_INIT__) return;
  window.__DOACH_MENU_INIT__ = true;

  // ---------- Styles ----------
  if (!document.getElementById('ui-menu-css')) {
    const css = document.createElement('style');
    css.id = 'ui-menu-css';
    css.textContent = `
      .doach-hamburger {
        position: fixed; top: 12px; left: 12px; z-index: 10050;
        width: 38px; height: 38px; border-radius: 8px;
        display:flex; align-items:center; justify-content:center;
        background: rgba(0,0,0,.75); color:#fff; border:1px solid rgba(255,255,255,.15);
        cursor:pointer; user-select:none;
      }
      .doach-hamburger:hover { background: rgba(0,0,0,.88); }
      .doach-drawer {
        position: fixed; top:0; bottom:0; left:0; width: 300px; z-index:10040;
        background: rgba(12,12,14,.98); color:#fff; border-right:1px solid rgba(255,255,255,.12);
        transform: translateX(-110%); transition: transform .22s ease-out; padding: 12px;
        box-shadow: 0 10px 30px rgba(0,0,0,.35);
      }
      .doach-drawer.open { transform: translateX(0); }
      .doach-drawer h3 { margin: 4px 10px 10px; font: 600 14px/1.2 system-ui; opacity:.9; letter-spacing:.04em; }
      .doach-menu { list-style:none; margin:0; padding:0; }
      .doach-menu > li { margin: 4px 0; }
      .doach-item {
        width:100%; text-align:left; background:transparent; border:0; color:#fff;
        padding:10px 12px; border-radius:8px; cursor:pointer; font:600 14px system-ui;
      }
      .doach-item:hover { background:rgba(255,255,255,.08); }
      .doach-sidepanel {
        position: fixed; top:0; right:0; bottom:0; width:420px; z-index:10045;
        background: rgba(14,14,18,.98); color:#fff; transform: translateX(110%);
        transition: transform .22s ease-out; border-left:1px solid rgba(255,255,255,.12);
        box-shadow: -8px 0 28px rgba(0,0,0,.35);
      }
      .doach-sidepanel.open { transform: translateX(0); }
      .doach-panel-head { display:flex; align-items:center; justify-content:space-between; padding:10px 12px; border-bottom:1px solid rgba(255,255,255,.12); font: 600 14px system-ui; }
      .doach-panel-body { padding:12px; overflow:auto; height: calc(100% - 48px); }
      .doach-field { margin:10px 0; }
      .doach-field label { display:block; font:600 12px system-ui; opacity:.8; margin-bottom:4px; }
      .doach-field input[type="text"], .doach-field input[type="number"], .doach-field select {
        width:100%; padding:8px 10px; border-radius:8px; border:1px solid rgba(255,255,255,.15);
        background:#101015; color:#fff;
      }
      .doach-range { width:100%; }
      .doach-row { display:flex; gap:10px; }
      .doach-row .col { flex:1; }
      .doach-btn { background:#2d6cff; color:#fff; border:0; padding:8px 10px; border-radius:8px; cursor:pointer; font-weight:600; }
      .doach-btn.ghost { background:transparent; border:1px solid rgba(255,255,255,.22); }
      .doach-actions { display:flex; gap:8px; flex-wrap:wrap; }
      .doach-list { border:1px solid rgba(255,255,255,.12); border-radius:8px; overflow:hidden; }
      .doach-list-item { padding:8px 10px; border-bottom:1px solid rgba(255,255,255,.08); display:flex; align-items:center; justify-content:space-between;}
      .doach-list-item:last-child { border-bottom:none; }
      .doach-floating-mydoach {
        position: fixed; right: 16px; bottom: 88px; z-index: 10050;
        background: rgba(0,0,0,.78); color:#fff; border:1px solid rgba(255,255,255,.15);
        padding:10px 12px; border-radius: 999px; cursor:pointer; font:600 13px system-ui;
      }
      .doach-floating-mydoach:hover { background: rgba(0,0,0,.9); }
    `;
    document.head.appendChild(css);
  }

  // ---------- helpers ----------
  const __panels = new Set();

  // ——— Close drawer + any open sidepanels ———
  let __drawer = null;
  function closeAllMenus(reason='') {
    __panels.forEach(p => p.openClose?.());
    if (__drawer) __drawer.classList.remove('open');
  }

  // ——— Auto-close menu when the video becomes ready ———
  let __doachAutoCloseWired = false;
  function wireVideoAutoClose() {
    const video = getVideoEl();
    if (!video) return;

    // don't double-wire
    if (__doachAutoCloseWired) return;
    __doachAutoCloseWired = true;

    const READY = HTMLMediaElement.HAVE_CURRENT_DATA;

    const cleanup = () => {
      ['loadedmetadata','loadeddata','canplay','playing'].forEach(ev => {
        try { video.removeEventListener(ev, onReady, opts); } catch {}
      });
      try { obs.disconnect(); } catch {}
    };

    const closeNow = (reason) => {
      closeAllMenus(reason);
      cleanup();
      __doachAutoCloseWired = false; // allow future re-wire after src change
    };

    const onReady = () => closeNow('video-ready');

    const opts = { once: true };
    ['loadedmetadata','loadeddata','canplay','playing'].forEach(ev => {
      video.addEventListener(ev, onReady, opts);
    });

    // If menu mounted after video was already ready, close immediately.
    if (video.readyState >= READY) {
      Promise.resolve().then(() => closeNow('video-already-ready'));
    }

    // Re-arm on src/srcObject change (file picker, programmatic loads)
    const obs = new MutationObserver(() => {
      cleanup();
      __doachAutoCloseWired = false;
      setTimeout(wireVideoAutoClose, 0); // attach to the next load cycle
    });
    obs.observe(video, { attributes: true, attributeFilter: ['src', 'srcObject'] });
  }

  // ——— Find the video element the app uses ———
  function getVideoEl(){
    return document.getElementById('videoPlayer') || document.querySelector('video');
  }

  function el(tag, attrs={}, ...kids){
    const d = document.createElement(tag);
    Object.entries(attrs||{}).forEach(([k,v])=>{
      if (k==='style' && typeof v==='object') Object.assign(d.style, v);
      else if (k.startsWith('on') && typeof v==='function') d.addEventListener(k.slice(2), v);
      else if (v!=null) d.setAttribute(k, v);
    });
    kids.flat().forEach(k => d.append(k instanceof Node ? k : document.createTextNode(String(k))));
    return d;
  }
  function closeOnEsc(node, closeFn){
    const onKey = (e)=>{ if (e.key==='Escape') closeFn(); };
    node.__esc = onKey; window.addEventListener('keydown', onKey);
    node.__unesc = ()=> window.removeEventListener('keydown', onKey);
  }
  function makeSidePanel(title){
    const panel = el('div', {class:'doach-sidepanel', role:'dialog', 'aria-label':title});
    const head = el('div', {class:'doach-panel-head'},
      el('div', {}, title),
      el('button', {class:'doach-btn ghost', onclick:()=>{ panel.classList.remove('open'); panel.__unesc?.(); }}, 'Close')
    );
    const body = el('div', {class:'doach-panel-body'});
    panel.append(head, body);
    document.body.appendChild(panel);
    panel.open = ()=>{ panel.classList.add('open'); closeOnEsc(panel, panel.openClose); };
    panel.openClose = ()=>{ panel.classList.remove('open'); panel.__unesc?.(); };
    panel.setBody = (n)=>{ body.innerHTML=''; body.append(n); };
    __panels.add(panel);
    return panel;
  }

  // ---------- Panels ----------
async function openContentPanel(){
  const panel = (openContentPanel.panel ||= makeSidePanel('Content'));
  const body  = el('div');

  // Fetch recent list (server first, then local)
  let vidList = [];
  try {
    const r = await fetch('/videos', { cache: 'no-store' });
    if (r.ok) {
      const j = await r.json();
      if (Array.isArray(j.videos)) vidList = j.videos;
    }
  } catch {}
  if (!vidList.length) {
    try {
      const loc = JSON.parse(localStorage.getItem('doachVideos') || '[]');
      if (Array.isArray(loc)) vidList = loc;
    } catch {}
  }

  // helpers
  function triggerFilePicker(){
    const input = document.getElementById('videoInput');
    if (!input) { alert('Upload control not found on this page.'); return; }
    __panels?.forEach?.(p => p.openClose?.());
    input.click();
  }
  function loadViaURL(u){
    if (!u) return alert('No URL for this item.');
    window.dispatchEvent(new CustomEvent('content:url-picked', { detail: { url: u } }));
    __panels?.forEach?.(p => p.openClose?.());
  }

  // render recent list
  const list = el('div', { class:'doach-list' },
    ...(vidList.length ? vidList.map(v =>
      el('div', { class:'doach-list-item' },
        el('div', {}, v.name || v.filename || 'Untitled'),
        el('div', {},
          el('button', { class:'doach-btn ghost', onclick:()=>loadViaURL(v.url||v.path) }, 'Use URL')
        )
      )
    ) : [ el('div', { class:'doach-list-item' }, 'No saved videos yet') ])
  );

  body.append(
    el('div', { class:'doach-field' }, el('label', {}, 'Recent'), list),
    el('div', { style:{ height:'10px' } }),
    el('div', { class:'doach-actions' },
      el('button', { class:'doach-btn', onclick:triggerFilePicker }, 'Upload / Load New')
    )
  );

  // === Source controls: Upload / Camera ===
  const sourceRow = document.createElement('div');
  sourceRow.style.cssText = 'display:flex; gap:8px; align-items:center; margin:10px 0;';
  sourceRow.innerHTML = `
    <button id="contentUseCamBtn" class="doach-btn">Use camera</button>
    <button id="contentStopCamBtn" class="doach-btn">Stop camera</button>
    <span id="contentCamHint" style="margin-left:8px; opacity:.8;"></span>
  `;
  body.append(sourceRow); // ✅ append to body (setBody won't wipe it)

  // wire from the subtree we'll pass to the panel
  const uploadBtn = body.querySelector('#contentUploadBtn');
  const camBtn    = body.querySelector('#contentUseCamBtn');
  const stopBtn   = body.querySelector('#contentStopCamBtn');
  const hintEl    = body.querySelector('#contentCamHint');

  if (uploadBtn) uploadBtn.addEventListener('click', () => {
    const input = document.getElementById('videoInput');
    if (!input) { alert('Upload input not found'); return; }
    input.click();
  });

  if (camBtn || stopBtn) {
    const canCamera = !!(navigator.mediaDevices?.getUserMedia);
    const httpsOk   = (location.protocol === 'https:' ||
                       location.hostname === 'localhost' ||
                       location.hostname === '127.0.0.1');
    const allowPref = () => (window.PREF_ALLOW_CAMERA === true);

    const updateButtons = () => {
      const on = canCamera && httpsOk && allowPref();
      if (camBtn)  camBtn.disabled  = !on;
      if (stopBtn) stopBtn.disabled = !on;
      if (hintEl) {
        if (!canCamera)         hintEl.textContent = 'Camera not supported in this browser.';
        else if (!httpsOk)      hintEl.textContent = 'Camera requires HTTPS (or localhost).';
        else if (!allowPref())  hintEl.textContent = 'Enable “Allow camera access” in Preferences.';
        else                    hintEl.textContent = '';
      }
    };
    updateButtons();

    if (camBtn) camBtn.addEventListener('click', async () => {
      if (!canCamera || !httpsOk || !allowPref()) { updateButtons(); return; }
      if (hintEl) hintEl.textContent = 'Requesting camera…';
      try {
        await window.useCamera?.();
        if (hintEl) hintEl.textContent = 'Camera active.';
        __panels?.forEach?.(p => p.openClose?.()); // close the side panel
      } catch (e) {
        if (hintEl) hintEl.textContent = 'Camera failed: ' + (e?.message || e);
      }
    });


    if (stopBtn) stopBtn.addEventListener('click', () => {
      try { window.stopCamera?.(); if (hintEl) hintEl.textContent = 'Camera stopped.'; }
      catch (e) { if (hintEl) hintEl.textContent = 'Stop failed: ' + (e?.message || e); }
    });

    // reflect "Allow camera" toggle live
    window.addEventListener('change', (e) => {
      if (e.target?.id === 'pf_allow_cam') updateButtons();
    });
  }

  panel.setBody(body);
  panel.open();
}



  function field(label, input){ return el('div', {class:'doach-field'}, el('label', {}, label), input); }
  async function openMyDoachPanel(){
    const panel = (openMyDoachPanel.panel ||= makeSidePanel('My Doach'));
    const prefs = (window.doachGetPrefs?.() || {voice:'alloy', tts:'openai', speed:1, pitch:1, volume:1, bassDb:0, trebleDb:0, lang:'en-US'});
    const body = el('div');

    const ttsSel   = el('select', {}, ...['openai','web'].map(v=> el('option',{value:v, selected:(prefs.tts===v)}, v)));
    const voiceInp = el('input', {type:'text', value:(prefs.voice||'alloy')});
    const speed    = el('input', {type:'range', class:'doach-range', min:'0.5', max:'1.5', step:'0.05', value: prefs.speed??1});
    const pitch    = el('input', {type:'range', class:'doach-range', min:'0.5', max:'2.0', step:'0.05', value: prefs.pitch??1});
    const volume   = el('input', {type:'range', class:'doach-range', min:'0',   max:'1.0', step:'0.05', value: prefs.volume??1});
    const bassDb   = el('input', {type:'number', value: prefs.bassDb??0, step:'1'});
    const trebDb   = el('input', {type:'number', value: prefs.trebleDb??0, step:'1'});
    const langSel  = el('input', {type:'text', value: prefs.lang || 'en-US'});

    const presetSel = el('select');
    const nameInp   = el('input', {type:'text', placeholder:'Preset name'});
    async function refreshPresets(){
      presetSel.innerHTML = '';
      const presets = (await window.doachLoadPresets?.()) || [];
      presetSel.append(...[el('option',{value:''}, '— Select preset —'), ...presets.map(p => el('option', {value:p.name}, p.name))]);
    }
    await refreshPresets();

    presetSel.addEventListener('change', async ()=>{
      if (!presetSel.value) return;
      const presets = (await window.doachLoadPresets?.()) || [];
      const p = presets.find(x=>x.name===presetSel.value);
      if (!p) return;
      ttsSel.value = p.tts || prefs.tts;
      voiceInp.value = p.voice || prefs.voice;
      speed.value = p.speed ?? 1;
      pitch.value = p.pitch ?? 1;
      volume.value = p.volume ?? 1;
      bassDb.value = p.bassDb ?? 0;
      trebDb.value = p.trebleDb ?? 0;
      langSel.value = p.lang || 'en-US';
    });

    const rowEq = el('div', {class:'doach-row'},
      el('div', {class:'col'}, field('Bass dB', bassDb)),
      el('div', {class:'col'}, field('Treble dB', trebDb))
    );

    const actions = el('div', {class:'doach-actions'},
      el('button', {class:'doach-btn', onclick:applyNow}, 'Apply to Session'),
      el('button', {class:'doach-btn ghost', onclick:testVoice}, 'Test Voice'),
      el('button', {class:'doach-btn', onclick:savePreset}, 'Save as Preset'),
      el('button', {class:'doach-btn ghost', onclick:refreshPresets}, 'Reload Presets')
    );

    body.append(
      field('TTS Engine', ttsSel),
      field('Voice', voiceInp),
      field('Language', langSel),
      field('Speed', speed),
      field('Pitch (Web TTS only)', pitch),
      field('Volume', volume),
      rowEq,
      el('div', {class:'doach-field'}, el('label', {}, 'Presets'), el('div', {class:'doach-row'},
        el('div', {class:'col'}, presetSel),
        el('div', {class:'col'}, nameInp)
      )),
      actions
    );

    panel.setBody(body); panel.open();

    function readUI(){
      return {
        tts: ttsSel.value,
        voice: voiceInp.value.trim() || 'alloy',
        speed: Number(speed.value),
        pitch: Number(pitch.value),
        volume: Number(volume.value),
        bassDb: Number(bassDb.value),
        trebleDb: Number(trebDb.value),
        lang: (langSel.value||'en-US').trim()
      };
    }
    function applyNow(){ const p = readUI(); window.doachSetPrefs?.(p); window.doachSpeak?.('Voice settings applied.'); }
    function testVoice(){ const p = readUI(); window.doachSetPrefs?.(p); window.doachSpeak?.('This is your Doach voice.'); }
    async function savePreset(){
      const name = (nameInp.value||'').trim();
      if (!name) { alert('Enter a preset name'); return; }
      const ok = await window.doachSavePreset?.({ name, ...readUI() });
      if (ok) { nameInp.value=''; await refreshPresets(); alert('Preset saved.'); }
    }
  }

// ---------- Mount Menu ----------
function mountHamburgerMenu(){
  if (document.getElementById('doach-menu-mounted')) return;
  const marker = document.createElement('meta');
  marker.id = 'doach-menu-mounted';
  document.head.appendChild(marker);

  const drawer = el('div', {class:'doach-drawer'},
    el('h3', {}, 'Menu'),
    el('ul', {class:'doach-menu'},
      el('li', {}, el('button', {class:'doach-item', onclick:openContentPanel}, 'Content')),
      el('li', {}, el('button', {class:'doach-item', onclick:openMyDoachPanel}, 'My Doach')),
      // ✅ one Preferences item only
      el('li', {}, el('button', {
        class:'doach-item',
        onclick: () => window.openPreferencesPanel?.()
      }, 'Preferences'))
    )
  );
  document.body.appendChild(drawer);
  __drawer = drawer;

  const btn = el('div', {class:'doach-hamburger', title:'Menu (M)', onclick:toggle}, '☰');
  document.body.appendChild(btn);
  window.addEventListener('keydown', (e)=>{ if ((e.key||'').toLowerCase()==='m') toggle(); });
  function toggle(){ drawer.classList.toggle('open'); }

  const floater = el('button', {class:'doach-floating-mydoach', onclick:openMyDoachPanel}, 'MyDoach ⚙️');
  document.body.appendChild(floater);

  wireVideoAutoClose();
}

  // Expose for non-module usage and export for module usage
  window.mountHamburgerMenu = mountHamburgerMenu;
  try { if (typeof module !== 'undefined') module.exports = { mountHamburgerMenu }; } catch {}
  // Auto-mount after DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => mountHamburgerMenu());
  } else {
    mountHamburgerMenu();
  }
})();


// ---------- Preferences (pop-out) ----------
function loadDoachPrefs() {
  try { return JSON.parse(localStorage.getItem('doach_prefs')) || {}; } catch { return {}; }
}
function saveDoachPrefs(p) {
  localStorage.setItem('doach_prefs', JSON.stringify(p||{}));
}
function getDefaults() {
  return {
    // playback
    slowmoFps: Number(window.FRAMEbyFRAME_RATE ?? 3.0),

    // proximity
    proxX:      (window.PREF_PROX?.x ?? 200),
    proxYAbove: (window.PREF_PROX?.yAbove ?? 170),
    proxYBelow: (window.PREF_PROX?.yBelow ?? 100),

    // scoring
    scorerMode: (window.SHOT_SCORER_MODE || 'weighted'),
    weightedThresh: Number(window.WEIGHTED_THRESH ?? 0.75),

    // overlay visibility
    show: {
      ball: (window.PREF_SHOW?.ball ?? true),
      trails: (window.PREF_SHOW?.trails ?? true),
      player: (window.PREF_SHOW?.player ?? true),
      hoop: (window.PREF_SHOW?.hoop ?? true),
      backboard: (window.PREF_SHOW?.backboard ?? false),
      net: (window.PREF_SHOW?.net ?? false),
    },

    // audio/permissions
    audioOn: (window.PREF_AUDIO_ENABLED !== false),
    allowMic: (window.PREF_ALLOW_MIC !== false),
    allowCamera: !!window.PREF_ALLOW_CAMERA,

    // advanced weights/tunables (optional)
    weights: {
      hoop:       (window.PREF_WEIGHTS?.hoop ?? 0.15),
      net:        (window.PREF_WEIGHTS?.net ?? 0.20),
      tubeHit:    (window.PREF_WEIGHTS?.tubeHit ?? 0.30),
      netMoved:   (window.PREF_WEIGHTS?.netMoved ?? 0.40),
      trailCenter:(window.PREF_WEIGHTS?.trailCenter ?? 0.25),
    },
    tunables: {
      TAIL: (window.PREF_TUNABLES?.TAIL ?? 28),
      ELLIPSE_X: (window.PREF_TUNABLES?.ELLIPSE_X ?? 0.45),
      ELLIPSE_Y: (window.PREF_TUNABLES?.ELLIPSE_Y ?? 0.45),
      NET_PAD: (window.PREF_TUNABLES?.NET_PAD ?? 10),
      LINE_XTOL_MULT: (window.PREF_TUNABLES?.LINE_XTOL_MULT ?? 1.1),
      NETLINE_POS: (window.PREF_TUNABLES?.NETLINE_POS ?? 0.92),
      DEPTH_POS: (window.PREF_TUNABLES?.DEPTH_POS ?? 1.22),
      TUBE_WIDTH_RATIO: (window.PREF_TUNABLES?.TUBE_WIDTH_RATIO ?? 0.55),
      TUBE_MIN_CONSEC: (window.PREF_TUNABLES?.TUBE_MIN_CONSEC ?? 3),
      TUBE_ALLOW_GAPS: (window.PREF_TUNABLES?.TUBE_ALLOW_GAPS ?? 2),
      SMALL_UP_TOL: (window.PREF_TUNABLES?.SMALL_UP_TOL ?? 1.5),
      TRAIL_RADIUS: (window.PREF_TUNABLES?.TRAIL_RADIUS ?? 15),
      CENTER_LANE_MIN: (window.PREF_TUNABLES?.CENTER_LANE_MIN ?? 18),
    }
  };
}
function applyPrefs(p) {
  // playback
  window.FRAMEbyFRAME_RATE = Number(p.slowmoFps) || 1.0;

  // proximity (shot_logger + overlay will read these)
  window.PREF_PROX = {
    x: Number(p.proxX) || 200,
    yAbove: Number(p.proxYAbove) || 170,
    yBelow: Number(p.proxYBelow) || 100
  };

  // scoring
  window.SHOT_SCORER_MODE = String(p.scorerMode || 'weighted').toLowerCase();
  window.WEIGHTED_THRESH  = Math.max(0.5, Math.min(0.95, Number(p.weightedThresh)||0.75));

  // visibility
  window.PREF_SHOW = {
    ball: !!p.show.ball, trails: !!p.show.trails, player: !!p.show.player,
    hoop: !!p.show.hoop, backboard: !!p.show.backboard, net: !!p.show.net
  };

  // audio / mic / camera
  window.PREF_AUDIO_ENABLED = !!p.audioOn;
  window.PREF_ALLOW_MIC     = !!p.allowMic;
  window.PREF_ALLOW_CAMERA  = !!p.allowCamera;

  // advanced (used by scorer if you wire the optional patch below)
  window.PREF_WEIGHTS  = {...p.weights};
  window.PREF_TUNABLES = {...p.tunables};

  saveDoachPrefs(p);
  console.log('[prefs] applied', p);
}

function numInput(v, opts={min:0,max:999,step:1}) {
  const i=document.createElement('input'); i.type='number';
  i.min=opts.min; i.max=opts.max; i.step=opts.step; i.value=v; return i;
}
function rng(id, label, min, max, step, val, hint='') {
  const row=document.createElement('div'); row.className='doach-field';
  const lab=document.createElement('label'); lab.textContent=label;
  if (hint) lab.title = hint;
  const r=document.createElement('input'); r.type='range'; r.className='doach-range';
  r.min=min; r.max=max; r.step=step; r.value=val;
  const out=document.createElement('output'); out.value=val;
  r.oninput=()=> out.value=r.value;
  row.append(lab, r, out); r.id=id; return row;
}
function chk(id, label, checked) {
  const row=document.createElement('div'); row.className='doach-field';
  const lab=document.createElement('label'); lab.textContent=label;
  const c=document.createElement('input'); c.type='checkbox'; c.checked=!!checked; c.id=id;
  row.append(lab, c); return row;
}
function sel(id, label, options, value) {
  const row=document.createElement('div'); row.className='doach-field';
  const lab=document.createElement('label'); lab.textContent=label;
  const s=document.createElement('select'); s.id=id;
  options.forEach(([v,t])=>{ const o=document.createElement('option'); o.value=v; o.textContent=t; o.selected=(v===value); s.appendChild(o); });
  row.append(lab, s); return row;
}
function twoCols(a,b){ const row=document.createElement('div'); row.className='doach-row'; const c1=document.createElement('div'); c1.className='col'; const c2=document.createElement('div'); c2.className='col'; c1.append(a); c2.append(b); row.append(c1,c2); return row;}

// Global side-panel helper (define once)
if (!window.__makeSidePanel) {
  window.__makeSidePanel = function makeSidePanel(title) {
    const panel = document.createElement('div');
    panel.className = 'doach-sidepanel';
    panel.setAttribute('role','dialog');
    panel.setAttribute('aria-label', title);

    // start hidden (off-screen)
    panel.style.transform = 'translateX(110%)';

    const head = document.createElement('div');
    head.className = 'doach-panel-head';
    const ttl = document.createElement('div'); ttl.textContent = title;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'doach-btn ghost';
    closeBtn.textContent = 'Close';
    closeBtn.onclick = () => panel.openClose?.();
    head.append(ttl, closeBtn);

    const body = document.createElement('div');
    body.className = 'doach-panel-body';

    panel.append(head, body);
    document.body.appendChild(panel);

    function onEsc(e){ if (e.key === 'Escape') panel.openClose(); }

    // ✅ force transform inline so it shows even if CSS didn’t win specificity
    panel.open = () => {
      panel.classList.add('open');
      panel.style.transform = 'translateX(0)';
      window.addEventListener('keydown', onEsc);
    };
    panel.openClose = () => {
      panel.classList.remove('open');
      panel.style.transform = 'translateX(110%)';
      window.removeEventListener('keydown', onEsc);
    };
    panel.setBody = (node) => { body.innerHTML = ''; body.append(node); };

    return panel;
  };
}


// Open / display preferences panel
async function openPreferencesPanel() {
  console.log('[menu] openPreferencesPanel');
  const panel = (openPreferencesPanel.panel ||= window.__makeSidePanel('Preferences'));
  const body  = document.createElement('div');
  const defs  = getDefaults();
  const saved = loadDoachPrefs();
  const prefs = {...defs, ...saved,
    show: {...defs.show, ...(saved.show||{})},
    weights: {...defs.weights, ...(saved.weights||{})},
    tunables:{...defs.tunables, ...(saved.tunables||{})},
  };

  // Playback
  body.append(
    rng('pf_slowmo','Slow-mo frame rate (fps)', 0.25, 6, 0.05, prefs.slowmoFps, 'Frame-by-frame replay speed.')
  );

  // Proximity
  body.append(twoCols(
    (()=>{ const f=document.createElement('div'); f.className='doach-field'; f.append(
      (()=>{ const l=document.createElement('label'); l.textContent='Proximity ±X (px)'; return l;})(),
      (()=>{ const i=numInput(prefs.proxX,{min:50,max:500,step:5}); i.id='pf_proxX'; return i;})()
    ); return f; })(),
    (()=>{ const f=document.createElement('div'); f.className='doach-field'; f.append(
      (()=>{ const l=document.createElement('label'); l.textContent='Above rim (px)'; return l;})(),
      (()=>{ const i=numInput(prefs.proxYAbove,{min:20,max:300,step:5}); i.id='pf_proxUp'; return i;})()
    ); return f; })()
  ));
  body.append(
    (()=>{ const f=document.createElement('div'); f.className='doach-field'; f.append(
      (()=>{ const l=document.createElement('label'); l.textContent='Below rim (px)'; return l;})(),
      (()=>{ const i=numInput(prefs.proxYBelow,{min:20,max:300,step:5}); i.id='pf_proxDn'; return i;})()
    ); return f; })()
  );

  // Scoring
  body.append(
    sel('pf_mode', 'Shot scorer mode', [['weighted','Weighted (trail only)'],['hybrid','Hybrid (region OR trail)']], (prefs.scorerMode||'weighted'))
  );
  body.append(
    rng('pf_thresh','Make threshold', 0.5, 0.95, 0.01, prefs.weightedThresh, 'Trail score required for a make.')
  );

  // Visibility
  body.append(chk('pf_show_ball','Show ball', prefs.show.ball));
  body.append(chk('pf_show_trails','Show ball trail', prefs.show.trails));
  body.append(chk('pf_show_player','Show players', prefs.show.player));
  body.append(chk('pf_show_hoop','Show hoop', prefs.show.hoop));
  body.append(chk('pf_show_bb','Show backboard', prefs.show.backboard));
  body.append(chk('pf_show_net','Show net', prefs.show.net));

  // Audio / permissions
  body.append(chk('pf_audio_on','Audio on (TTS)', prefs.audioOn));
  body.append(chk('pf_allow_mic','Allow microphone', prefs.allowMic));
  body.append(chk('pf_allow_cam','Allow camera', prefs.allowCamera));

  // Advanced (collapsed summary)
  const advBtn = document.createElement('button');
  advBtn.className='doach-btn ghost';
  advBtn.textContent='Advanced: weights & tunables';
  const advWrap = document.createElement('div');
  advWrap.style.display='none';
  advBtn.onclick = () => advWrap.style.display = advWrap.style.display==='none' ? 'block' : 'none';

  // weights
  advWrap.append(
    rng('pf_w_hoop','Weight: hoop ellipse', 0, 0.6, 0.01, prefs.weights.hoop),
    rng('pf_w_net','Weight: net region', 0, 0.6, 0.01, prefs.weights.net),
    rng('pf_w_tube','Weight: tube run', 0, 0.7, 0.01, prefs.weights.tubeHit),
    rng('pf_w_netMoved','Weight: net moved', 0, 0.7, 0.01, prefs.weights.netMoved),
    rng('pf_w_trail','Weight: center stripe', 0, 0.6, 0.01, prefs.weights.trailCenter)
  );

  // a couple key tunables (you can add the whole set if you want)
  advWrap.append(
    rng('pf_t_tail','Trail tail length', 6, 60, 1, prefs.tunables.TAIL),
    rng('pf_t_tubeW','Tube width ratio', 0.3, 1.2, 0.01, prefs.tunables.TUBE_WIDTH_RATIO),
    rng('pf_t_lineTol','Center x-tolerance', 0.5, 2.0, 0.05, prefs.tunables.LINE_XTOL_MULT)
  );

  body.append(advBtn, advWrap);

  // Actions
  const actions = document.createElement('div'); actions.className='doach-actions';
  const applyBtn = document.createElement('button'); applyBtn.className='doach-btn'; applyBtn.textContent='Apply';
  const resetBtn = document.createElement('button'); resetBtn.className='doach-btn ghost'; resetBtn.textContent='Reset defaults';
  actions.append(applyBtn, resetBtn);
  body.append(actions);

  // read + apply
  function readPrefsFromUI() {
    return {
      slowmoFps: Number(body.querySelector('#pf_slowmo').value),

      proxX:      Number(body.querySelector('#pf_proxX').value),
      proxYAbove: Number(body.querySelector('#pf_proxUp').value),
      proxYBelow: Number(body.querySelector('#pf_proxDn').value),

      scorerMode: (body.querySelector('#pf_mode')?.value || 'weighted'),
      weightedThresh: Number(body.querySelector('#pf_thresh').value),

      show: {
        ball:   body.querySelector('#pf_show_ball').checked,
        trails: body.querySelector('#pf_show_trails').checked,
        player: body.querySelector('#pf_show_player').checked,
        hoop:   body.querySelector('#pf_show_hoop').checked,
        backboard: body.querySelector('#pf_show_bb').checked,
        net:    body.querySelector('#pf_show_net').checked,
      },

      audioOn:    body.querySelector('#pf_audio_on').checked,
      allowMic:   body.querySelector('#pf_allow_mic').checked,
      allowCamera:body.querySelector('#pf_allow_cam').checked,

      weights: {
        hoop: Number(body.querySelector('#pf_w_hoop').value),
        net: Number(body.querySelector('#pf_w_net').value),
        tubeHit: Number(body.querySelector('#pf_w_tube').value),
        netMoved: Number(body.querySelector('#pf_w_netMoved').value),
        trailCenter: Number(body.querySelector('#pf_w_trail').value)
      },
      tunables: {
        TAIL: Number(body.querySelector('#pf_t_tail').value),
        TUBE_WIDTH_RATIO: Number(body.querySelector('#pf_t_tubeW').value),
        LINE_XTOL_MULT: Number(body.querySelector('#pf_t_lineTol').value),
        // keep other tunables as previous value to avoid losing them
        ...prefs.tunables
      }
    };
  }

  applyBtn.onclick = () => { applyPrefs(readPrefsFromUI()); closeAllMenus('apply-prefs'); };
  resetBtn.onclick = () => { const d=getDefaults(); saveDoachPrefs(d); applyPrefs(d); panel.openClose(); };

  panel.setBody(body);
  panel.open();
}

