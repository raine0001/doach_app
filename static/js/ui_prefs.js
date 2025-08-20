// ui_prefs.js — Pop-out Preferences (ES module)
// Mount with:  import { mountPrefs } from './ui_prefs.js';  mountPrefs(document.querySelector('.video-frame'));

const DEFAULTS = {
  slowmoFps:      Number(window.FRAMEbyFRAME_RATE ?? 3.0),

  proxX:          200,
  proxYAbove:     170,
  proxYBelow:     100,

  scorerMode:     (window.SHOT_SCORER_MODE || 'weighted'),
  weightedThresh: Number(window.WEIGHTED_THRESH ?? 0.75),

  weights: {      // trail-only scorer feature weights
    hoop: 0.15, net: 0.20, tubeHit: 0.30, netMoved: 0.40, trailCenter: 0.25
  },

  tunables: {
    TAIL: 28, ELLIPSE_X: 0.45, ELLIPSE_Y: 0.45, NET_PAD: 10,
    LINE_XTOL_MULT: 1.1, NETLINE_POS: 0.92, DEPTH_POS: 1.22,
    TUBE_WIDTH_RATIO: 0.55, TUBE_MIN_CONSEC: 3, TUBE_ALLOW_GAPS: 2,
    SMALL_UP_TOL: 1.5, TRAIL_RADIUS: 15, CENTER_LANE_MIN: 18
  },

  show: {   // overlay visibility
    player: true, ball: true, trails: true, hoop: true, backboard: false, net: false
  },

  allowCamera: false,
  allowMic:    false,
  audioOn:     true
};

function loadPrefs() {
  try {
    const raw = localStorage.getItem('doach_prefs');
    return raw ? { ...DEFAULTS, ...JSON.parse(raw),
      weights: { ...DEFAULTS.weights, ...(JSON.parse(raw).weights || {}) },
      tunables:{ ...DEFAULTS.tunables, ...(JSON.parse(raw).tunables||{}) },
      show:    { ...DEFAULTS.show,    ...(JSON.parse(raw).show    || {}) }
    } : { ...DEFAULTS };
  } catch { return { ...DEFAULTS }; }
}
function savePrefs(p) { localStorage.setItem('doach_prefs', JSON.stringify(p)); }

function applyPrefs(p) {
  // ===== Runtime knobs =====
  window.FRAMEbyFRAME_RATE = Number(p.slowmoFps) || 1.0;

  window.PREF_PROX = { x: Number(p.proxX), yAbove: Number(p.proxYAbove), yBelow: Number(p.proxYBelow) };

  window.SHOT_SCORER_MODE = String(p.scorerMode || 'weighted').toLowerCase();
  window.WEIGHTED_THRESH  = Math.max(0.5, Math.min(0.95, Number(p.weightedThresh) || 0.75));

  window.PREF_WEIGHTS  = { ...DEFAULTS.weights,  ...p.weights };
  window.PREF_TUNABLES = { ...DEFAULTS.tunables, ...p.tunables };

  window.PREF_SHOW = { ...DEFAULTS.show, ...p.show };

  window.PREF_ALLOW_CAMERA = !!p.allowCamera;
  window.PREF_ALLOW_MIC    = !!p.allowMic;
  window.PREF_AUDIO_ENABLED= !!p.audioOn;

  // optional: log
  console.log('[prefs] applied', p);
}

// ---------- UI ----------
function makeNumber(id, label, min, max, step, value, hint) {
  const wrap = document.createElement('label');
  wrap.className = 'pref-row';
  wrap.innerHTML = `
    <div class="pref-label">
      ${label} <span class="pref-hint">${hint||''}</span>
    </div>
    <input id="${id}" type="number" min="${min}" max="${max}" step="${step}" value="${value}">
  `;
  return wrap;
}
function makeRange(id, label, min, max, step, value, hint) {
  const wrap = document.createElement('label');
  wrap.className = 'pref-row';
  wrap.innerHTML = `
    <div class="pref-label">
      ${label} <span class="pref-hint">${hint||''}</span>
    </div>
    <div class="pref-range">
      <input id="${id}" type="range" min="${min}" max="${max}" step="${step}" value="${value}">
      <output for="${id}">${value}</output>
    </div>
  `;
  return wrap;
}
function makeToggle(id, label, checked, hint) {
  const wrap = document.createElement('label');
  wrap.className = 'pref-row';
  wrap.innerHTML = `
    <div class="pref-label">
      ${label} <span class="pref-hint">${hint||''}</span>
    </div>
    <input id="${id}" type="checkbox" ${checked ? 'checked' : ''}>
  `;
  return wrap;
}
function makeRadioGroup(name, label, options, value, hint) {
  const wrap = document.createElement('div');
  wrap.className = 'pref-row';
  wrap.innerHTML = `
    <div class="pref-label">
      ${label} <span class="pref-hint">${hint||''}</span>
    </div>
    <div class="pref-radios"></div>
  `;
  const r = wrap.querySelector('.pref-radios');
  options.forEach(([val, text]) => {
    const id = `${name}_${val}`;
    const el = document.createElement('label');
    el.innerHTML = `<input type="radio" name="${name}" id="${id}" value="${val}" ${val===value?'checked':''}> ${text}`;
    r.appendChild(el);
  });
  return wrap;
}

function styleOnce() {
  if (document.getElementById('prefs-style')) return;
  const css = document.createElement('style');
  css.id = 'prefs-style';
  css.textContent = `
    .prefs-gear {
      position:absolute; top:10px; right:10px; z-index:9999;
      width:36px; height:36px; border-radius:50%; border:none;
      background:rgba(0,0,0,.5); color:#fff; cursor:pointer;
      display:flex; align-items:center; justify-content:center; font-size:18px;
    }
    .prefs-panel {
      position:absolute; top:56px; right:10px; z-index:9999;
      width:340px; max-height:70vh; overflow:auto; padding:12px 12px 8px;
      background:#111; color:#ddd; border:1px solid #333; border-radius:12px;
      box-shadow:0 8px 20px rgba(0,0,0,.4);
    }
    .prefs-panel h3 { margin:6px 0 10px; font-size:16px; }
    .pref-row { display:flex; align-items:center; justify-content:space-between; gap:10px; margin:8px 0; }
    .pref-label { font-size:13px; max-width:60%; line-height:1.2; }
    .pref-hint { display:block; opacity:.6; font-size:11px; }
    .pref-range { display:flex; align-items:center; gap:8px; width:40%; }
    .pref-range input[type="range"] { width:100%; }
    .prefs-buttons { display:flex; gap:8px; justify-content:flex-end; margin-top:10px; }
    .prefs-buttons button { padding:6px 10px; background:#222; color:#ddd; border:1px solid #444; border-radius:8px; cursor:pointer; }
    .prefs-section { border-top:1px solid #222; margin-top:8px; padding-top:8px; }
  `;
  document.head.appendChild(css);
}

export function mountPrefs(hostEl) {
  styleOnce();
  const host = hostEl || document.body;

  const gear = document.createElement('button');
  gear.className = 'prefs-gear';
  gear.title = 'Preferences';
  gear.innerHTML = '⚙️';

  const panel = document.createElement('div');
  panel.className = 'prefs-panel';
  panel.style.display = 'none';

  const prefs = loadPrefs();

  // --- Build UI ---
  panel.innerHTML = `<h3>Preferences</h3>`;

  // Playback / Slow-mo
  panel.appendChild(makeRange('pf_slowmo', 'Slow-mo frame rate', 0.25, 6, 0.05, prefs.slowmoFps,
    'Affects frame-by-frame replay speed (fps).'));

  // Proximity
  panel.appendChild(makeNumber('pf_proxX', 'Proximity width (±X)', 50, 500, 5, prefs.proxX,
    'Horizontal half-width around rim.'));
  panel.appendChild(makeNumber('pf_proxUp', 'Proximity above rim', 20, 300, 5, prefs.proxYAbove,
    'How high above the rim counts as “in proximity”.'));
  panel.appendChild(makeNumber('pf_proxDn', 'Proximity below rim', 20, 300, 5, prefs.proxYBelow,
    'How far below the rim counts as “in proximity”.'));

  // Scorer
  panel.appendChild(makeRadioGroup('pf_mode', 'Shot scorer mode',
    [['weighted','Weighted (trail-only)'],['hybrid','Hybrid (region OR trail)']],
    prefs.scorerMode, 'Weighted = most robust; Hybrid = a bit looser.'));
  panel.appendChild(makeRange('pf_thresh', 'Make threshold', 0.5, 0.95, 0.01, prefs.weightedThresh,
    'Trail score required to count as a make.'));

  // Weights (advanced)
  panel.appendChild(sectionTitle('Scorer weights (advanced)'));
  panel.appendChild(makeRange('pf_w_hoop',       'Hoop ellipse',      0, 0.6, 0.01, prefs.weights.hoop));
  panel.appendChild(makeRange('pf_w_net',        'Net region',        0, 0.6, 0.01, prefs.weights.net));
  panel.appendChild(makeRange('pf_w_tube',       'Tube run',          0, 0.7, 0.01, prefs.weights.tubeHit));
  panel.appendChild(makeRange('pf_w_netMoved',   'Net moved',         0, 0.7, 0.01, prefs.weights.netMoved));
  panel.appendChild(makeRange('pf_w_trail',      'Center stripe',     0, 0.6, 0.01, prefs.weights.trailCenter));

  // Tunables (advanced)
  panel.appendChild(sectionTitle('Scorer tunables (advanced)'));
  const T = prefs.tunables;
  panel.appendChild(makeNumber('pf_t_tail',    'Trail tail length', 6, 60, 1, T.TAIL, 'Last N points used.'));
  panel.appendChild(makeRange('pf_t_ellipseX','Hoop ellipse X', 0.2, 1.0, 0.01, T.ELLIPSE_X));
  panel.appendChild(makeRange('pf_t_ellipseY','Hoop ellipse Y', 0.2, 1.0, 0.01, T.ELLIPSE_Y));
  panel.appendChild(makeNumber('pf_t_netPad',  'Net pad (px)', 0, 30, 1, T.NET_PAD));
  panel.appendChild(makeRange('pf_t_lineTol',  'Center x-tolerance', 0.5, 2.0, 0.05, T.LINE_XTOL_MULT));
  panel.appendChild(makeRange('pf_t_netLine',  'Net line (depth)', 0.7, 1.5, 0.01, T.NETLINE_POS));
  panel.appendChild(makeRange('pf_t_depth',    'Tube depth factor', 0.8, 2.0, 0.01, T.DEPTH_POS));
  panel.appendChild(makeRange('pf_t_tubeW',    'Tube width ratio', 0.3, 1.2, 0.01, T.TUBE_WIDTH_RATIO));
  panel.appendChild(makeNumber('pf_t_tubeMin', 'Tube min frames', 1, 8, 1, T.TUBE_MIN_CONSEC));
  panel.appendChild(makeNumber('pf_t_tubeGap', 'Tube allow gaps', 0, 5, 1, T.TUBE_ALLOW_GAPS));
  panel.appendChild(makeRange('pf_t_smallUp',  'Allow small up-ticks', 0, 3, 0.1, T.SMALL_UP_TOL));
  panel.appendChild(makeNumber('pf_t_trailR',  'Trail radius (px)', 5, 40, 1, T.TRAIL_RADIUS));
  panel.appendChild(makeNumber('pf_t_laneMin', 'Center lane min (px)', 8, 40, 1, T.CENTER_LANE_MIN));

  // Visibility
  panel.appendChild(sectionTitle('Overlay visibility'));
  panel.appendChild(makeToggle('pf_show_ball',   'Show ball',     !!prefs.show.ball));
  panel.appendChild(makeToggle('pf_show_trails', 'Show ball trail',!!prefs.show.trails));
  panel.appendChild(makeToggle('pf_show_player', 'Show players',  !!prefs.show.player));
  panel.appendChild(makeToggle('pf_show_hoop',   'Show hoop',     !!prefs.show.hoop));
  panel.appendChild(makeToggle('pf_show_bb',     'Show backboard',!!prefs.show.backboard));
  panel.appendChild(makeToggle('pf_show_net',    'Show net',      !!prefs.show.net));

  // Permissions / Audio
  panel.appendChild(sectionTitle('Permissions & audio'));
  panel.appendChild(makeToggle('pf_allow_cam', 'Allow camera access', !!prefs.allowCamera, 'Enable live camera when requested.'));
  panel.appendChild(makeToggle('pf_allow_mic', 'Allow microphone',   !!prefs.allowMic,    'Enable voice features when requested.'));
  panel.appendChild(makeToggle('pf_audio_on',  'Audio on (TTS)',     !!prefs.audioOn,     'Enable/disable coach audio.'));

  // Buttons
  const btns = document.createElement('div');
  btns.className = 'prefs-buttons';
  btns.innerHTML = `<button id="pf_reset">Reset</button><button id="pf_close">Close</button>`;
  panel.appendChild(btns);

  // --- wire values <-> prefs ---
  const $ = (id)=> panel.querySelector('#'+id);
  const syncOutput = (id)=> { const o = panel.querySelector(`output[for="${id}"]`); if (o) o.value = $(id).value; };

  panel.addEventListener('input', (e) => {
    // Ranges update inline output bubbles
    if (e.target.matches('input[type="range"]')) {
      syncOutput(e.target.id);
    }
  });

  function readAndApply() {
    const p = { ...prefs };

    p.slowmoFps      = Number($('pf_slowmo').value);

    p.proxX          = Number($('pf_proxX').value);
    p.proxYAbove     = Number($('pf_proxUp').value);
    p.proxYBelow     = Number($('pf_proxDn').value);

    const modeEl = panel.querySelector('input[name="pf_mode"]:checked');
    p.scorerMode     = modeEl ? modeEl.value : 'weighted';
    p.weightedThresh = Number($('pf_thresh').value);

    p.weights = {
      hoop:       Number($('pf_w_hoop').value),
      net:        Number($('pf_w_net').value),
      tubeHit:    Number($('pf_w_tube').value),
      netMoved:   Number($('pf_w_netMoved').value),
      trailCenter:Number($('pf_w_trail').value)
    };

    p.tunables = {
      TAIL: Number($('pf_t_tail').value),
      ELLIPSE_X: Number($('pf_t_ellipseX').value),
      ELLIPSE_Y: Number($('pf_t_ellipseY').value),
      NET_PAD: Number($('pf_t_netPad').value),
      LINE_XTOL_MULT: Number($('pf_t_lineTol').value),
      NETLINE_POS: Number($('pf_t_netLine').value),
      DEPTH_POS: Number($('pf_t_depth').value),
      TUBE_WIDTH_RATIO: Number($('pf_t_tubeW').value),
      TUBE_MIN_CONSEC: Number($('pf_t_tubeMin').value),
      TUBE_ALLOW_GAPS: Number($('pf_t_tubeGap').value),
      SMALL_UP_TOL: Number($('pf_t_smallUp').value),
      TRAIL_RADIUS: Number($('pf_t_trailR').value),
      CENTER_LANE_MIN: Number($('pf_t_laneMin').value),
    };

    p.show = {
      ball:   $('pf_show_ball').checked,
      trails: $('pf_show_trails').checked,
      player: $('pf_show_player').checked,
      hoop:   $('pf_show_hoop').checked,
      backboard: $('pf_show_bb').checked,
      net:    $('pf_show_net').checked
    };

    p.allowCamera = $('pf_allow_cam').checked;
    p.allowMic    = $('pf_allow_mic').checked;
    p.audioOn     = $('pf_audio_on').checked;

    savePrefs(p);
    applyPrefs(p);
  }

  panel.addEventListener('change', readAndApply);
  $('pf_close').addEventListener('click', () => panel.style.display='none');
  $('pf_reset').addEventListener('click', () => {
    savePrefs(DEFAULTS);
    applyPrefs({ ...DEFAULTS });
    panel.remove(); gear.remove();
    mountPrefs(host); // rebuild fresh
  });

  // mount
  host.style.position = (getComputedStyle(host).position === 'static') ? 'relative' : getComputedStyle(host).position;
  host.appendChild(gear);
  host.appendChild(panel);

  gear.addEventListener('click', () => {
    panel.style.display = (panel.style.display === 'none') ? 'block':'none';
  });

  // first apply
  applyPrefs(prefs);
  // sync range outputs
  panel.querySelectorAll('input[type="range"]').forEach(r => syncOutput(r.id));

  function sectionTitle(txt) {
    const d = document.createElement('div');
    d.className = 'prefs-section';
    d.innerHTML = `<h3>${txt}</h3>`;
    return d;
  }
}
