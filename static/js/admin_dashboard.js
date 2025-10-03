(() => {
  const sessionsList = document.getElementById('sessionsList');
  if (!sessionsList) return;

  const filterInput = document.getElementById('filterTxt');
  const btnRefresh = document.getElementById('btnRefresh');
  const dbgJson = document.getElementById('dbg-json');
  const sessionLabel = document.getElementById('dbg-session-label');
  const shotsWrap = document.getElementById('shotsTableWrap');
  const shotsMeta = document.getElementById('shotsMeta');
  const btnObserve = document.getElementById('dbg-open-observe');
  const btnOpenJson = document.getElementById('dbg-open-json');
  const btnDownload = document.getElementById('adm-dbg-download');
  const btnCopy = document.getElementById('dbg-copy');

  let sessions = [];
  let activeSid = null;
  let cachedDebug = null;
  let clipTimer = null;
  let debugTimer = null;

  const escapeHtmlMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>\"']/g, (ch) => escapeHtmlMap[ch] || ch);

  const fmtDate = (value) => {
    if (!value) return '';
    try {
      if (typeof value === 'number') return new Date(value).toLocaleString();
      if (/^\d+$/.test(String(value))) return new Date(Number(value)).toLocaleString();
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString();
    } catch { return String(value); }
  };

  const fmtTime = (value) => {
    if (!value) return '--';
    try {
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return '--';
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch { return '--'; }
  };

  const fmtSize = (bytes) => {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n <= 0) return '--';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = n;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    const digits = unit === 0 ? 0 : 1;
    return `${value.toFixed(digits)} ${units[unit]}`;
  };


  const buildPoseSummary = (metrics) => {
    if (!metrics || typeof metrics !== 'object') return '';
    const parts = [];
    const width = Number(metrics.stanceWidthFeet ?? metrics.stanceWidth);
    if (Number.isFinite(width)) parts.push(`stance ${width.toFixed(2)}ft`);
    const elbow = Number(metrics.elbowExtDeg ?? metrics.elbowAngleDeg);
    if (Number.isFinite(elbow)) parts.push(`elbow ${elbow.toFixed(1)} deg`);
    const arm = Number(metrics.armVerticalityDeg);
    if (Number.isFinite(arm)) parts.push(`arm ${arm.toFixed(1)} deg`);
    const hold = Number(metrics.followThroughHoldFrames ?? metrics.followHoldFrames);
    if (Number.isFinite(hold)) parts.push(`hold ${hold.toFixed(0)} f`);
    const head = Number(metrics.headToHoopDeg ?? metrics.headAngleDeg);
    if (Number.isFinite(head)) parts.push(`head ${head.toFixed(1)} deg`);
    const torso = Number(metrics.torsoLeanAngle);
    if (Number.isFinite(torso)) parts.push(`torso ${torso.toFixed(1)} deg`);
    const knee = Number(metrics.kneeFlex);
    if (Number.isFinite(knee)) parts.push(`knee ${knee.toFixed(1)} deg`);
    const feetDiff = Number(metrics.feetAngleDiff ?? metrics.feetStagger);
    if (Number.isFinite(feetDiff)) parts.push(`feet ${feetDiff.toFixed(1)} deg`);
    return parts.join(' | ');
  };



  const resultPill = (result) => {
    let cls = 'pending';
    let text = 'pending';
    if (result === true || result === 'made' || result === 'make') { cls = 'make'; text = 'make'; }
    else if (result === false || result === 'miss') { cls = 'miss'; text = 'miss'; }
    return `<span class="shots-pill ${cls}">${text}</span>`;
  };

  const setButtonsEnabled = (enabled) => {
    [btnObserve, btnOpenJson, btnDownload, btnCopy].forEach((btn) => { if (btn) btn.disabled = !enabled; });
  };

  const clearTimers = () => {
    if (clipTimer) clearTimeout(clipTimer);
    if (debugTimer) clearTimeout(debugTimer);
    clipTimer = null;
    debugTimer = null;
  };

  const scheduleClipRefresh = (sid, delay = 6000) => {
    if (!sid || sid !== activeSid) return;
    if (clipTimer) clearTimeout(clipTimer);
    clipTimer = window.setTimeout(() => loadClips(sid, { silent: true }), delay);
  };

  const scheduleDebugRefresh = (sid, delay = 7000) => {
    if (!sid || sid !== activeSid) return;
    if (debugTimer) clearTimeout(debugTimer);
    debugTimer = window.setTimeout(() => loadDebug(sid, { silent: true }), delay);
  };

  const renderSessions = () => {
    sessionsList.innerHTML = '';
    const filter = (filterInput?.value || '').trim().toLowerCase();
    const frag = document.createDocumentFragment();
    let count = 0;

    sessions.forEach((session) => {
      const sid = String(session.sid || '');
      if (filter && !sid.toLowerCase().includes(filter)) return;

      const row = document.createElement('div');
      row.className = 'row';
      row.dataset.sid = sid;
      if (sid === activeSid) row.classList.add('active');
      if (session.live) row.classList.add('row-live');

      const created = session.created_display || fmtDate(session.created_at);
      const shots = Number.isFinite(session.shots) ? session.shots : (session.totals?.attempts ?? '');
      const makes = Number.isFinite(session.makes) ? session.makes : (session.totals?.made ?? '');
      const accuracy = Number.isFinite(session.accuracy) ? `${session.accuracy}%` : '';
      const user = session.user ? escapeHtml(session.user.name || session.user.email || session.user.user_id) : '';
      const liveBadge = session.live ? '<span class="pill pill-live">LIVE</span>' : '';

      row.innerHTML = `
        <div class="session-main">
          <div><strong>${escapeHtml(sid)}</strong> ${liveBadge}</div>
          <div class="muted info-line">${created || ''}${user ? ' - ' + user : ''}</div>
        </div>
        <div class="session-meta">
          <div>${shots ?? ''} shots</div>
          <div class="muted">${makes ?? ''} makes${accuracy ? ' - ' + accuracy : ''}</div>
        </div>`;

      row.addEventListener('click', () => selectSession(sid));
      frag.appendChild(row);
      count += 1;
    });

    if (!count) {
      const empty = document.createElement('div');
      empty.className = 'muted';
      empty.style.padding = '12px';
      empty.textContent = sessions.length ? 'No sessions match filter.' : 'No sessions found.';
      sessionsList.appendChild(empty);
    } else {
      sessionsList.appendChild(frag);
    }
  };

  const setActiveRow = (sid) => {
    sessionsList.querySelectorAll('.row').forEach((row) => {
      row.classList.toggle('active', row.dataset.sid === sid);
    });
  };

  const loadSessions = async (force = false) => {
    try {
      if (!force && sessions.length) { renderSessions(); return; }
      sessionsList.innerHTML = '<div class="muted" style="padding:12px;">Loading sessions...</div>';
      const res = await fetch('/admin/sessions');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      sessions = Array.isArray(data.sessions) ? data.sessions : [];
      renderSessions();
    } catch (err) {
      sessionsList.innerHTML = `<div class="muted" style="padding:12px;">Failed to load sessions: ${escapeHtml(err.message || err)}</div>`;
    }
  };

  const updateSessionLabel = (summary) => {
    if (!sessionLabel) return;
    if (!summary) { sessionLabel.textContent = 'No session selected.'; return; }
    const { sid, shots, makes, accuracy, live, created_display } = summary;
    const bits = [];
    if (shots != null) bits.push(`${shots} shots`);
    if (makes != null) bits.push(`${makes} makes`);
    if (accuracy != null) bits.push(`${accuracy}%`);
    if (live) bits.unshift('LIVE');
    sessionLabel.textContent = `${sid}${bits.length ? ' - ' + bits.join(' - ') : ''}`;
  };

  const renderShots = (payload) => {

    if (!shotsWrap) return;

    if (!payload || !Array.isArray(payload.clips) || !payload.clips.length) {

      shotsWrap.className = 'shots-empty';

      shotsWrap.textContent = activeSid ? 'Waiting for clips...' : 'No clips yet.';

      if (shotsMeta) shotsMeta.textContent = '0';

      return;

    }



    const rows = payload.clips.map((clip, index) => {

      const displayIdx = clip.displayIdx != null ? clip.displayIdx : (clip.idx != null ? clip.idx + 1 : index + 1);

      const pillHtml = resultPill(clip.result);

      const summaryLine = clip.poseSummary || buildPoseSummary(clip.poseMetrics || clip.pose);

      const summaryHtml = summaryLine ? escapeHtml(summaryLine) : '';

      const sourceHtml = clip.poseSource ? ` <span class="pose-source">[${escapeHtml(clip.poseSource)}]</span>` : '';

      const textHtml = clip.poseText ? `<div class="pose-text">${escapeHtml(clip.poseText)}</div>` : '';

      const poseCell = summaryHtml ? `${summaryHtml}${sourceHtml}${textHtml}` : (textHtml || '--');

      const saved = fmtTime(clip.created);

      const size = fmtSize(clip.size);

      const linkText = clip.label || clip.name || `shot-${displayIdx}`;

      const hasUrl = Boolean(clip.url || clip.href);

      const linkUrl = clip.url || clip.href || '#';

      const linkHtml = hasUrl

        ? `<a class="clip-link" href="${linkUrl}" target="_blank" rel="noopener">${escapeHtml(linkText)}</a>`

        : `<span class="clip-link clip-link-disabled">${escapeHtml(linkText)}</span>`;

      return `

        <tr>

          <td>${displayIdx}</td>

          <td>${pillHtml}</td>

          <td>${linkHtml}</td>

          <td>${poseCell}</td>

          <td>${saved}</td>

          <td>${size}</td>

        </tr>`;

    }).join('');



    shotsWrap.className = '';

    shotsWrap.innerHTML = `

      <table class='shots-table'>

        <thead><tr><th>#</th><th>Result</th><th>Clip</th><th>Pose Highlights</th><th>Saved</th><th>Size</th></tr></thead>

        <tbody>${rows}</tbody>

      </table>`;

    if (shotsMeta) {

      const totals = payload.totals || {};

      const attempts = Number.isFinite(totals.attempts) && totals.attempts > 0 ? totals.attempts : payload.clips.length;

      const made = Number.isFinite(totals.made) ? totals.made : payload.clips.filter((clip) => clip.result === true || clip.result === 'made').length;

      shotsMeta.textContent = `${made} of ${attempts} made`;

    }

  };



  const loadClips = async (sid, { silent = false } = {}) => {
    if (!sid || sid !== activeSid) return;
    if (!silent && shotsWrap) {
      shotsWrap.className = 'shots-empty';
      shotsWrap.textContent = 'Loading clips...';
      if (shotsMeta) shotsMeta.textContent = '--';
    }
    try {
      const res = await fetch(`/admin/session/${encodeURIComponent(sid)}/clips?ts=${Date.now()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (sid !== activeSid) return;
      renderShots(data);
    } catch (err) {
      if (!silent && shotsWrap) {
        shotsWrap.className = 'shots-empty';
        shotsWrap.textContent = `Clip load failed: ${err.message || err}`;
      }
    } finally {
      scheduleClipRefresh(sid);
    }
  };

  const loadDebug = async (sid, { silent = false } = {}) => {
    if (!sid || sid !== activeSid) return;
    if (!silent && dbgJson) dbgJson.textContent = 'Loading...';
    try {
      const res = await fetch(`/admin/session/${encodeURIComponent(sid)}/debug?ts=${Date.now()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (sid !== activeSid) return;
      cachedDebug = data;
      if (dbgJson) dbgJson.textContent = JSON.stringify(data, null, 2);
      const stats = {
        sid,
        shots: data.sessionFile?.shots?.length ?? data.shotsDB?.length ?? null,
        makes: data.sessionFile?.totals?.made ?? null,
        accuracy: data.sessionFile?.totals?.accuracy ?? null,
        live: sessions.find((s) => s.sid === sid)?.live ?? null
      };
      updateSessionLabel(stats);
    } catch (err) {
      if (!silent && dbgJson) dbgJson.textContent = `Failed to load debug: ${err.message || err}`;
      const sessionInfo = sessions.find((s) => s.sid === sid) || {};
    updateSessionLabel({ sid, live: sessionInfo.live, created_display: sessionInfo.created_display || null });
    } finally {
      scheduleDebugRefresh(sid);
    }
  };

  const selectSession = async (sid) => {
    if (!sid || sid === activeSid) return;
    activeSid = sid;
    setActiveRow(sid);
    setButtonsEnabled(true);
    cachedDebug = null;
    clearTimers();
    if (dbgJson) dbgJson.textContent = '(loading...)';
    const sessionInfo = sessions.find((s) => s.sid === sid) || {};
    updateSessionLabel({ sid, live: sessionInfo.live, created_display: sessionInfo.created_display || null });
    await Promise.all([loadDebug(sid), loadClips(sid)]);
  };

  if (btnObserve) btnObserve.addEventListener('click', () => activeSid && window.open(`/admin/observe/${encodeURIComponent(activeSid)}`, '_blank'));
  if (btnOpenJson) btnOpenJson.addEventListener('click', () => activeSid && window.open(`/admin/session/${encodeURIComponent(activeSid)}/debug`, '_blank'));
  if (btnDownload) btnDownload.addEventListener('click', () => {
    if (!activeSid || !cachedDebug) return;
    const blob = new Blob([JSON.stringify(cachedDebug, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `session-${activeSid}-debug.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });
  if (btnCopy) btnCopy.addEventListener('click', async () => {
    if (!cachedDebug) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(cachedDebug, null, 2));
      btnCopy.textContent = 'Copied';
      setTimeout(() => { btnCopy.textContent = 'Copy'; }, 1200);
    } catch (err) {
      alert('Copy failed: ' + (err.message || err));
    }
  });

  if (filterInput) filterInput.addEventListener('input', () => renderSessions());
  if (btnRefresh) btnRefresh.addEventListener('click', () => loadSessions(true));

  setButtonsEnabled(false);
  loadSessions();
})();

