// ui_prefs.js — Demo-lean Preferences (with legacy killer)

// ... keep DEFAULTS/loadPrefs/savePrefs/applyPrefs/styleOnce/makeToggle/makeRange/makeSelect/sectionTitle as in your current file ...

function killLegacyPrefsUI() {
  // remove any previous/legacy panels to avoid mixed UIs
  const suspects = [
    '.prefs-panel', '#prefsPanel', '.preferences', '.preferences-panel',
    '#preferences', '#preferencesPanel'
  ];
  suspects.forEach(sel => document.querySelectorAll(sel).forEach(el => {
    // don't delete our own (we'll add a data-version)
    if (el.dataset?.version === 'demo-lean') return;
    try { el.remove(); } catch {}
  }));
  // murder any stray “Advanced: weights & tunables” or slow-mo widgets
  document.querySelectorAll('button, .pref-row, label, .control, .settings-item')
    .forEach(el => {
      const t = (el.textContent || '').toLowerCase();
      if (/slow-?mo|frame rate|weights|tunables/.test(t)) {
        try { el.remove(); } catch {}
      }
    });
}

export function mountPrefs(hostEl) {
  // stop double mounts
  if (window.__demoLeanPrefsMounted) return;
  window.__demoLeanPrefsMounted = true;

  styleOnce();
  killLegacyPrefsUI();

  const host = hostEl || document.body;
  const gear = document.createElement('button');
  gear.className = 'prefs-gear';
  gear.title = 'Preferences';
  gear.innerHTML = '⚙️';

  const panel = document.createElement('div');
  panel.className = 'prefs-panel';
  panel.dataset.version = 'demo-lean';   // fingerprint so we don't delete ourselves
  panel.style.display = 'none';

  const prefs = loadPrefs();

  // Build UI
  panel.innerHTML = `<h3>Preferences</h3>`;

  // DISPLAY
  panel.appendChild(sectionTitle('Display'));
  panel.appendChild(makeToggle('pf_show_poseLines', 'Show pose lines',
    !!prefs.show.poseLines, 'Hide the horizontal pose markers.'));
  panel.appendChild(makeToggle('pf_show_releaseGate', 'Show release gate HUD',
    !!prefs.show.releaseGate, 'Hide the debug “Release Gate” box.'));
  panel.appendChild(makeToggle('pf_show_player', 'Show players', !!prefs.show.player));
  panel.appendChild(makeToggle('pf_show_ball',   'Show ball',    !!prefs.show.ball));
  panel.appendChild(makeToggle('pf_show_trails', 'Show ball trail', !!prefs.show.trails));
  panel.appendChild(makeToggle('pf_show_hoop',   'Show hoop',    !!prefs.show.hoop));
  panel.appendChild(makeToggle('pf_show_bb',     'Show backboard', !!prefs.show.backboard));
  panel.appendChild(makeToggle('pf_show_net',    'Show net',     !!prefs.show.net));

  // SCORER BASICS (kept minimal)
  panel.appendChild(sectionTitle('Scorer'));
  panel.appendChild(makeSelect('pf_mode', 'Mode',
    [['weighted','Weighted'],['hybrid','Hybrid']], (prefs.scorerMode||'weighted'),
    'Weighted = robust; Hybrid = looser'));
  panel.appendChild(makeRange('pf_thresh', 'Make threshold', 0.5, 0.95, 0.01,
    Number(prefs.weightedThresh ?? 0.75)));

  // PERMS / AUDIO
  panel.appendChild(sectionTitle('Permissions & Audio'));
  panel.appendChild(makeToggle('pf_allow_cam', 'Allow camera access', !!prefs.allowCamera));
  panel.appendChild(makeToggle('pf_allow_mic', 'Allow microphone',    !!prefs.allowMic));
  panel.appendChild(makeToggle('pf_audio_on',  'Audio on (TTS)',      !!prefs.audioOn));

  // Buttons
  const btns = document.createElement('div');
  btns.className = 'prefs-buttons';
  btns.innerHTML = `<button id="pf_reset">Reset</button><button id="pf_close">Close</button>`;
  panel.appendChild(btns);

  // Wiring
  const $ = (id)=> panel.querySelector('#'+id);

  function readAndApply() {
    const p = { ...prefs };
    p.scorerMode     = $('pf_mode').value;
    p.weightedThresh = Number($('pf_thresh').value);
    p.show = {
      ...p.show,
      poseLines:   $('pf_show_poseLines').checked,
      releaseGate: $('pf_show_releaseGate').checked,
      player:      $('pf_show_player').checked,
      ball:        $('pf_show_ball').checked,
      trails:      $('pf_show_trails').checked,
      hoop:        $('pf_show_hoop').checked,
      backboard:   $('pf_show_bb').checked,
      net:         $('pf_show_net').checked
    };
    p.allowCamera = $('pf_allow_cam').checked;
    p.allowMic    = $('pf_allow_mic').checked;
    p.audioOn     = $('pf_audio_on').checked;

    savePrefs(p);
    applyPrefs(p);
  }

  panel.addEventListener('change', readAndApply);
  panel.querySelector('#pf_close')?.addEventListener('click', () => panel.style.display='none');
  panel.querySelector('#pf_reset')?.addEventListener('click', () => {
    savePrefs(DEFAULTS);
    applyPrefs({ ...DEFAULTS });
    panel.remove(); gear.remove();
    window.__demoLeanPrefsMounted = false;
    mountPrefs(host); // rebuild fresh
  });

  // Mount
  const stylePos = getComputedStyle(host).position;
  host.style.position = (stylePos === 'static') ? 'relative' : stylePos;
  host.appendChild(gear);
  host.appendChild(panel);

  gear.addEventListener('click', () => {
    panel.style.display = (panel.style.display === 'none') ? 'block' : 'none';
  });

  // First apply immediately so overlay hides debug elements
  applyPrefs(prefs);
}
