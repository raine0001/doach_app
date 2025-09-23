/* doach admin one-page debug (refactored) */
(function onePageDebug(){
  if (window.__opgInstalled) return;
  window.__opgInstalled = true;

  const MAX_ROWS = 800;
  const ledger = new Map();
  let paused = false;
  let events = 0;

  const tiles = {};
  document.querySelectorAll('#opg-tiles .tile').forEach((tile) => {
    tiles[tile.dataset.k] = tile.querySelector('b');
  });
  if (tiles.dedupe) tiles.dedupe.textContent = String(window.__gateDedupeCount || 0);
  if (tiles.clip) tiles.clip.textContent = '—';
  const tBody = document.getElementById('opg-tbody');
  const stats = document.getElementById('opg-stats');
  const chkAuto = document.getElementById('opg-autoscroll');
  const candidatesEl = document.getElementById('opg-candidates');
  const configEl = document.getElementById('opg-config');
  const clipsEl = document.getElementById('opg-clips');
  const candidateHist = [];
  const clipHist = [];
  let lastConfig = null;

  const sink = window.__DBG || (window.__DBG = {
    buf: [],
    push(kind, data) {
      this.buf.push({ t: Date.now(), kind, data });
      if (this.buf.length > 5000) this.buf.shift();
    }
  });
  function push(kind, data){ try { sink.push(kind, data); } catch {} }

  if (typeof window.__dbgLine === 'function') {
    const prev = window.__dbgLine;
    window.__dbgLine = (text) => { push('line', { t: text }); prev(text); };
  } else {
    window.__dbgLine = (text) => push('line', { t: text });
  }

  const btnPause = document.getElementById('opg-pause');
  const btnClear = document.getElementById('opg-clear');
  const btnDown  = document.getElementById('opg-download');
  btnPause.onclick = () => {
    paused = !paused;
    btnPause.textContent = paused ? '▶ resume' : '⏸ pause';
  };
  btnClear.onclick = () => {
    ledger.clear();
    tBody.innerHTML = '';
    events = 0;
    stats.textContent = 'frames: 0 • events: 0';
    candidateHist.length = 0;
    clipHist.length = 0;
    updateCandidateView();
    updateClipView();
    if (tiles.clip) tiles.clip.textContent = '—';
  };
  btnDown.onclick = () => {
    const blob = new Blob([JSON.stringify({ records: sink.buf, frames: [...ledger.values()] }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `doach-onepage-debug-${Date.now()}.json`;
    a.click();
  };

  function F(){ return Number(window.__AN_IDX) || 0; }
  function rowFor(frame){
    let row = ledger.get(frame);
    if (!row) {
      row = {
        frame,
        tMs: Date.now(),
        detN: 0,
        ball: '—',
        trail: '—',
        trailRel: '—',
        freshTrail: '—',
        trailAge: '—',
        arc: '—',
        prox: '—',
        gate: '—',
        candidate: '—',
        clip: '—',
        clipLink: null,
        release: '—',
        summary: '—',
        top: '—'
      };
      ledger.set(frame, row);
      if (ledger.size > MAX_ROWS) {
        const firstKey = ledger.keys().next().value;
        ledger.delete(firstKey);
        const firstTr = tBody.querySelector('tr');
        if (firstTr) firstTr.remove();
      }
    }
    return row;
  }
  function top3(dets){
    return (dets || []).slice(0, 3).map((d) => `${d.label || d.class || d.type}:${(d.score ?? d.confidence ?? 0).toFixed(2)}`).join(', ');
  }
  function updateCandidateView(){
    if (!candidatesEl) return;
    if (!candidateHist.length) {
      candidatesEl.textContent = '(none)';
      return;
    }
    const keys = ['dx','dy','dSE','dSW','elbowAngleDeg','elbowExtended','wristUpTrend','alignOK'];
    candidatesEl.textContent = candidateHist.map((entry) => {
      const score = Number.isFinite(entry.score) ? entry.score.toFixed(3) : '—';
      const tests = entry.tests || {};
      const testsLine = keys.map((k) => {
        const v = tests[k];
        if (typeof v === 'boolean') return `${k}:${v ? 'Y' : 'N'}`;
        const num = Number(v);
        if (Number.isFinite(num)) return `${k}:${num}`;
        return `${k}:${v ?? '—'}`;
      }).join(' ');
      const pose = entry.poseStreak != null ? ` streak:${entry.poseStreak}` : '';
      return `${entry.frame ?? '—'} ${entry.side ?? '?'} ${score} ${entry.reason ?? 'blocked'}${pose}
  ${testsLine}`;
    }).join('
');
  }
  function updateConfigView(){
    if (!configEl) return;
    if (!lastConfig) {
      configEl.textContent = '(pending)';
      return;
    }
    configEl.textContent = JSON.stringify(lastConfig, null, 2);
  }

  function updateClipView(){
    if (!clipsEl) return;
    if (!clipHist.length) {
      clipsEl.textContent = '(none)';
      return;
    }
    clipsEl.textContent = clipHist.map((entry) => {
      const size = Number.isFinite(Number(entry.size)) ? `${Math.round(Number(entry.size) / 1024)}kB` : '—';
      const path = entry.path ?? (entry.url ? '[blob]' : '—');
      const state = entry.ok === false ? 'err' : (entry.ok ? 'ok' : 'pending');
      const err = entry.error ? ` ${entry.error}` : '';
      return `shot ${entry.shotIdx ?? '?'} frame:${entry.frame ?? '—'} size:${size} ${state} ${path}${err}`;
    }).join('\n');
  }

  window.addEventListener('objects:frame', (e) => {
    const d = e.detail || {};
    const frame = Number.isFinite(d.frame) ? d.frame : F();
    events++;
    const row = rowFor(frame);
    row.tMs = d.tMs || Date.now();
    row.detN = (d.dets || []).length;
    row.top = top3(d.dets);
    push('objects:frame', { frame, detN: row.detN, top: row.top });
  }, { passive: true });

  window.addEventListener('pose:state', (e) => {
    const d = e.detail || {};
    events++;
    push('pose:state', d);
    try {
      const streak = Number.isFinite(Number(d.streak)) ? Number(d.streak) : 0;
      const need = Number.isFinite(Number(d.need)) ? Number(d.need) : '?';
      const warmMark = d.warm ? '✓' : '';
      tiles.pose.textContent = `${streak}/${need}${warmMark}`;
    } catch {}
  }, { passive: true });

  window.addEventListener('ball:point', (e) => {
    const d = e.detail || {};
    const frame = Number.isFinite(d.frame) ? d.frame : F();
    events++;
    const row = rowFor(frame);
    if (Number.isFinite(d.x) && Number.isFinite(d.y)) {
      const conf = Number.isFinite(Number(d.conf)) ? Number(d.conf).toFixed(2) : '—';
      const via = d.via || '—';
      row.ball = `${Math.round(d.x)},${Math.round(d.y)} (${conf}|${via})`;
    }
    push('ball:point', { frame, x: d.x, y: d.y, conf: d.conf, via: d.via, top: d.top, roi: d.roi });
  }, { passive: true });

  window.addEventListener('ball:trail-step', (e) => {
    const d = e.detail || {};
    const frame = Number.isFinite(d.frame) ? d.frame : F();
    events++;
    const row = rowFor(frame);
    row.trail = d.len | 0;
    push('ball:trail-step', { frame, len: d.len });
    try {
      const bs = window.ballState || {};
      const trailLen = Array.isArray(bs.trail) ? bs.trail.length : 0;
      tiles.trail.textContent = trailLen;
      const arc = window.ballArc || {};
      const pts = Array.isArray(arc.refinedTrail) ? arc.refinedTrail.length : (Array.isArray(arc.trail) ? arc.trail.length : 0);
      if (!tiles.arc.textContent || tiles.arc.textContent === '—') tiles.arc.textContent = pts;
    } catch {}
  }, { passive: true });

  window.addEventListener('release:context', (e) => {
    const d = e.detail || {};
    const frame = Number.isFinite(d.frame) ? d.frame : F();
    events++;
    const row = rowFor(frame);
    row.trailRel = Number.isFinite(Number(d.trailLen)) ? Number(d.trailLen) : '—';
    row.freshTrail = typeof d.freshTrail === 'boolean' ? (d.freshTrail ? 'Y' : 'N') : '—';
    row.trailAge = Number.isFinite(Number(d.lastTrailAgeMs)) ? Math.round(Number(d.lastTrailAgeMs)) : '—';
    push('release:context', { frame, ...d });
  }, { passive: true });

  window.addEventListener('prox:state', (e) => {
    const d = e.detail || {};
    const frame = Number.isFinite(d.frame) ? d.frame : F();
    events++;
    const text = `${d.latched ? 'Y' : 'N'} ${d.enterF ?? '—'}→${d.exitF ?? '—'}`;
    rowFor(frame).prox = text;
    try { tiles.prox.textContent = text; } catch {}
    push('prox:state', { frame, ...d });
  }, { passive: true });

  window.addEventListener('shot:release', (e) => {
    const d = e.detail || {};
    const frame = Number.isFinite(d.frame) ? d.frame : F();
    events++;
    rowFor(frame).release = d.via || 'gate';
    push('shot:release', { frame, via: d.via });
  }, { passive: true });

  window.addEventListener('shot:summary', (e) => {
    const s = e.detail || {};
    const frame = Number.isFinite(s.frame) ? s.frame : F();
    events++;
    rowFor(frame).summary = `made:${s.made} arcH:${s.arcHeight} rel:${s.releaseAngle} entry:${s.entryAngle}`;
    push('shot:summary', { frame, ...s });
  }, { passive: true });

  window.addEventListener('gate:block', (e) => {
    const d = e.detail || {};
    const frame = F();
    events++;
    rowFor(frame).gate = `block:${d.reason}`;
    try { tiles.gate.textContent = `block:${d.reason}`; } catch {}
    push('gate:block', { frame, reason: d.reason, extra: d.extra });
  }, { passive: true });

  window.addEventListener('gate:released', (e) => {
    const d = e.detail || {};
    const frame = Number.isFinite(d.frame) ? d.frame : F();
    events++;
    rowFor(frame).gate = 'released';
    try { tiles.gate.textContent = 'released'; } catch {}
    push('gate:released', { frame });
  }, { passive: true });

  window.addEventListener('gate:candidate', (e) => {
    const d = e.detail || {};
    const frame = Number.isFinite(d.frame) ? d.frame : F();
    events++;
    const scoreVal = Number(d.score);
    const score = Number.isFinite(scoreVal) ? scoreVal.toFixed(3) : '—';
    const reason = d.reason ?? (d.strictOK ? 'strict' : 'blocked');
    rowFor(frame).candidate = `${d.side ?? '?'} ${score} ${reason}`;
    push('gate:candidate', { frame, detail: d });
    candidateHist.unshift({
      frame,
      side: d.side ?? null,
      score: Number.isFinite(scoreVal) ? scoreVal : null,
      reason,
      tests: d.tests || {},
      poseStreak: d.poseStreak ?? null
    });
    if (candidateHist.length > 5) candidateHist.pop();
    updateCandidateView();
  }, { passive: true });

  window.addEventListener('gate:dedupe', (e) => {
    const d = e.detail || {};
    events++;
    try { tiles.dedupe.textContent = String(d.count ?? '?'); } catch {}
    push('gate:dedupe', d);
  }, { passive: true });

  window.addEventListener('microclip:started', (e) => {
    const d = e.detail || {};
    events++;
    push('microclip:started', d);
    if (tiles.clip) tiles.clip.textContent = d.shotIdx != null ? `rec ${d.shotIdx}` : 'rec';
  }, { passive: true });

  window.addEventListener('microclip:done', (e) => {
    const d = e.detail || {};
    const frame = Number.isFinite(d.frame) ? Number(d.frame) : F();
    events++;
    push('microclip:done', d);
    const link = d.url ? `<a href="${d.url}" target="_blank" rel="noopener">shot ${d.shotIdx ?? '?'}</a>` : `shot ${d.shotIdx ?? '?'}`;
    const row = rowFor(frame);
    row.clipLink = link;
    row.clip = link;
    clipHist.unshift({ shotIdx: d.shotIdx ?? null, frame, url: d.url || null, size: d.size ?? null, type: d.type ?? null, ok: null, path: null, error: null });
    if (clipHist.length > 6) clipHist.pop();
    updateClipView();
    if (tiles.clip) tiles.clip.textContent = d.shotIdx != null ? `done ${d.shotIdx}` : 'done';
  }, { passive: true });

  window.addEventListener('microclip:saved', (e) => {
    const d = e.detail || {};
    const frame = Number.isFinite(d.frame) ? Number(d.frame) : F();
    events++;
    push('microclip:saved', d);
    const row = rowFor(frame);
    let base = row.clipLink || row.clip || `shot ${d.shotIdx ?? '?'}`;
    const mark = d.ok ? '[ok]' : '[err]';
    if (d.ok && d.path) {
      const href = d.path.startsWith('/') ? d.path : `/${d.path}`;
      base = `<a href="${href}" target="_blank" rel="noopener">shot ${d.shotIdx ?? '?'}</a>`;
      row.clipLink = base;
    }
    row.clip = `${base} ${mark}`;
    const entry = clipHist.find((item) => item.shotIdx === (d.shotIdx ?? null));
    if (entry) {
      entry.ok = d.ok;
      entry.path = d.path ?? null;
      entry.error = d.error ?? null;
      if (d.ok && d.path) {
        entry.url = d.path.startsWith('/') ? d.path : `/${d.path}`;
      }
    }
    updateClipView();
    if (tiles.clip) tiles.clip.textContent = d.ok ? 'saved' : 'save err';
  }, { passive: true });

  window.addEventListener('microclip:error', (e) => {
    const d = e.detail || {};
    const frame = Number.isFinite(d.frame) ? Number(d.frame) : F();
    events++;
    push('microclip:error', d);
    const row = rowFor(frame);
    const base = row.clipLink || row.clip || `shot ${d.shotIdx ?? '?'}`;
    row.clip = `${base} [err]`;
    const key = d.shotIdx ?? null;
    let entry = clipHist.find((item) => item.shotIdx === key);
    if (!entry) {
      entry = { shotIdx: key, frame, url: null, size: null, type: null, ok: false, path: null, error: d.msg ?? d.error ?? null };
      clipHist.unshift(entry);
      if (clipHist.length > 6) clipHist.pop();
    } else {
      entry.ok = false;
      entry.error = d.msg ?? d.error ?? null;
    }
    updateClipView();
    if (tiles.clip) tiles.clip.textContent = 'error';
  }, { passive: true });

  window.addEventListener('microclip:analyze', (e) => {
    const d = e.detail || {};
    events++;
    push('microclip:analyze', d);
  }, { passive: true });

  window.addEventListener('arc:fit', (e) => {
    const d = e.detail || {};
    const frame = Number.isFinite(d.tStart) ? Math.round(d.tStart) : F();
    events++;
    const pts = Number.isFinite(Number(d.points)) ? Number(d.points) : 0;
    const cont = Number.isFinite(Number(d.continuity)) ? Number(d.continuity) : 0;
    const rms = Number.isFinite(Number(d.rms)) ? Number(d.rms) : 0;
    const fit = `${pts}|${cont.toFixed(2)}|${rms.toFixed(2)}`;
    rowFor(frame).arc = fit;
    try { tiles.arc.textContent = fit; } catch {}
    push('arc:fit', { frame, ...d });
  }, { passive: true });

  window.addEventListener('session:config', (e) => {
    lastConfig = e.detail || {};
    push('session:config', lastConfig);
    updateConfigView();
  }, { passive: true });

  window.addEventListener('hoop:locked', (e) => {
    const box = e?.detail?.box || window.getCanonicalHoopBox?.() || window.getLockedHoopBox?.() || {};
    try { tiles.hoop.textContent = Number.isFinite(box.x) ? 'true' : 'false'; } catch {}
    push('hoop:locked', { box });
  }, { passive: true });

  setInterval(() => {
    try {
      const bs = window.ballState || {};
      const arc = window.ballArc || {};
      const trailLen = Array.isArray(bs.trail) ? bs.trail.length : 0;
      tiles.detect.textContent = window.__DETECT_SOURCE || 'unknown';
      tiles.armed.textContent = window.__shotTrackingArmed ? 'true' : 'false';
      tiles.trail.textContent = trailLen;
      tiles.frame.textContent = Number(window.__AN_IDX) || 0;
      if (!candidateHist.length) tiles.dedupe.textContent = String(window.__gateDedupeCount || 0);
      if (!tiles.arc.textContent || tiles.arc.textContent === '—') {
        const pts = Array.isArray(arc.refinedTrail) ? arc.refinedTrail.length : (Array.isArray(arc.trail) ? arc.trail.length : 0);
        tiles.arc.textContent = pts;
      }
      stats.textContent = `frames: ${ledger.size} • events: ${events}`;
    } catch {}
  }, 400);

  function render(){
    if (!paused) {
      const rows = [...ledger.values()].sort((a, b) => a.frame - b.frame).slice(-300);
      const safe = (v) => (v === undefined || v === null || v === '' ? '—' : v);
      const html = rows.map((row) => (
        `<tr>
            <td style="padding:4px 6px;border-top:1px solid #163;">${safe(row.frame)}</td>
            <td style="padding:4px 6px;border-top:1px solid #163;">${safe(row.tMs)}</td>
            <td style="padding:4px 6px;border-top:1px solid #163;">${safe(row.detN)}</td>
            <td style="padding:4px 6px;border-top:1px solid #163;">${safe(row.ball)}</td>
            <td style="padding:4px 6px;border-top:1px solid #163;">${safe(row.trail)}</td>
            <td style="padding:4px 6px;border-top:1px solid #163;">${safe(row.trailRel)}</td>
            <td style="padding:4px 6px;border-top:1px solid #163;">${safe(row.freshTrail)}</td>
            <td style="padding:4px 6px;border-top:1px solid #163;">${safe(row.trailAge)}</td>
            <td style="padding:4px 6px;border-top:1px solid #163;">${safe(row.arc)}</td>
            <td style="padding:4px 6px;border-top:1px solid #163;">${safe(row.prox)}</td>
            <td style="padding:4px 6px;border-top:1px solid #163;">${safe(row.gate)}</td>
            <td style="padding:4px 6px;border-top:1px solid #163;">${safe(row.candidate)}</td>
            <td style="padding:4px 6px;border-top:1px solid #163;">${safe(row.clip)}</td>
            <td style="padding:4px 6px;border-top:1px solid #163;">${safe(row.release)}</td>
            <td style="padding:4px 6px;border-top:1px solid #163;">${safe(row.summary)}</td>
            <td style="padding:4px 6px;border-top:1px solid #163;">${safe(row.top)}</td>
          </tr>`
      )).join('');
      tBody.innerHTML = html;
      if (chkAuto?.checked) {
        const parent = tBody.parentElement;
        if (parent) parent.scrollTop = parent.scrollHeight;
      }
    }
    requestAnimationFrame(render);
  }

  updateCandidateView();
  updateConfigView();
  updateClipView();
  render();
  console.log('[One-Page Debug] ready');
})();
