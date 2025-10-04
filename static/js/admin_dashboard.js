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
  let lastClipsPayload = null;

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

  const parseTimestampValue = (value) => {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : 0;
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) return 0;
      if (/^\d+$/.test(trimmed)) {
        const num = Number(trimmed);
        if (Number.isFinite(num)) return num;
      }
      const parsed = Date.parse(trimmed);
      if (!Number.isNaN(parsed)) return parsed;
    }
    return 0;
  };

  const timestampFromSid = (sid) => {
    if (!sid) return 0;
    const match = String(sid).match(/^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/);
    if (!match) return 0;
    const [, year, month, day, hour, minute, second] = match;
    const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}Z`;
    const ms = Date.parse(iso);
    return Number.isNaN(ms) ? 0 : ms;
  };


  const getSessionTimestamp = (session) => {
    if (!session || typeof session !== 'object') {
      return timestampFromSid(session?.sid || session);
    }
    const fields = ['last_shot_at','updated_at','last_activity','ended_at','ended','endedAt','created_at','created','started_at','started','start_at','start_ms','created_ms','created_ts','ts','timestamp'];
    for (const key of fields) {
      const ts = parseTimestampValue(session[key]);
      if (ts) return ts;
    }
    const sidTs = timestampFromSid(session.sid);
    if (sidTs) return sidTs;
    return 0;
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

  const getLastActivityTimestamp = (session) => {
    if (!session || typeof session !== 'object') return 0;
    const candidates = ['last_shot_at','updated_at','last_activity','created_at','created'];
    for (const key of candidates) {
      const ts = parseTimestampValue(session[key]);
      if (ts) return ts;
    }
    return timestampFromSid(session.sid);
  };

  const isMadeResult = (value) => value === true || value === 'made' || value === 'make' || value === 1 || value === '1';

  const LIVE_MAX_AGE_MS = 5 * 60 * 1000;

  const isSessionLive = (session) => {
    if (!session || typeof session !== 'object') return false;
    const shots = Number(session.shots ?? session.shot_count ?? session.totals?.attempts);
    if (!Number.isFinite(shots) || shots <= 1 || shots >= 10) return false;
    const ended = session.ended_at || session.ended || session.endedAt || session.done === true;
    if (ended) return false;
    const activityTs = getLastActivityTimestamp(session);
    if (!activityTs) return false;
    const age = Math.abs(Date.now() - activityTs);
    if (age > LIVE_MAX_AGE_MS) return false;
    return true;
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
    setActiveRow(activeSid);
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
      sessions = Array.isArray(data.sessions) ? data.sessions.slice() : [];
      sessions = sessions.map((session) => ({ ...session, live: isSessionLive(session) }));
      sessions.sort((a, b) => getSessionTimestamp(b) - getSessionTimestamp(a));
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

  const collectShotMeta = () => {
    const map = new Map();
    const ensure = (idx) => {
      if (!Number.isFinite(idx) || idx <= 0) return null;
      if (!map.has(idx)) map.set(idx, {});
      return map.get(idx);
    };
    const noteSummary = (entry, summary, source) => {
      if (!entry) return;
      if (typeof summary !== 'string') return;
      const trimmed = summary.trim();
      if (!trimmed) return;
      if (!entry.summary || (source === 'AI' && entry.summarySource !== 'AI')) {
        entry.summary = trimmed;
        entry.summarySource = source;
      }
    };

    const sessionShots = cachedDebug?.sessionFile?.shots;
    if (Array.isArray(sessionShots)) {
      sessionShots.forEach((shot, idxZero) => {
        let idx = Number(shot?.idx ?? shot?.shotId ?? shot?.id);
        if (!Number.isFinite(idx) || idx <= 0) idx = idxZero + 1;
        const entry = ensure(idx);
        if (!entry) return;
        noteSummary(entry, shot?.doach, 'AI');
        noteSummary(entry, shot?.coachLine, 'coach');
        noteSummary(entry, shot?.summary, entry.summarySource || 'summary');
        noteSummary(entry, shot?.coach?.line, 'coach');
        noteSummary(entry, shot?.coach?.summary, 'coach');
        if (shot?.feedback && typeof shot.feedback.text === 'string') noteSummary(entry, shot.feedback.text, 'AI');
        if (shot?.poseSummary) noteSummary(entry, shot.poseSummary, entry.summarySource || 'pose');
        if (shot?.notes && !entry.extraText) entry.extraText = String(shot.notes).trim();
        if (shot?.made !== undefined && entry.result === undefined) entry.result = shot.made;
        if (!entry.pose && shot?.poseSnapshot) entry.pose = shot.poseSnapshot;
        if (!entry.pose && shot?.pose) entry.pose = shot.pose;
        if (!entry.poseMetrics && shot?.poseMetrics) entry.poseMetrics = shot.poseMetrics;
        if (!entry.poseSource && shot?.poseSource) entry.poseSource = shot.poseSource;
      });
    }

    const feedbackList = cachedDebug?.feedback;
    if (Array.isArray(feedbackList)) {
      feedbackList.forEach((fb) => {
        const idx0 = Number(fb?.shot_idx);
        if (!Number.isFinite(idx0)) return;
        const entry = ensure(idx0 + 1);
        noteSummary(entry, fb?.text, 'AI');
      });
    }

    const shotsDB = cachedDebug?.shotsDB;
    if (Array.isArray(shotsDB)) {
      shotsDB.forEach((shot) => {
        const idx = Number(shot?.idx);
        if (!Number.isFinite(idx)) return;
        const entry = ensure(idx);
        if (!entry) return;
        if (shot.made !== undefined) entry.result = shot.made;
        if (shot.arcHeight != null) entry.arcHeight = shot.arcHeight;
        if (shot.entryAngle != null) entry.entryAngle = shot.entryAngle;
        if (shot.releaseAngle != null) entry.releaseAngle = shot.releaseAngle;
      });
    }

    const snapshots = cachedDebug?.snapshots;
    if (Array.isArray(snapshots)) {
      snapshots.forEach((snap) => {
        let idxRaw = snap?.shot_idx;
        if (idxRaw == null) idxRaw = snap?.shotId ?? snap?.shot;
        let idx = Number(idxRaw);
        if (Number.isFinite(idx) && idx <= 0 && snap?.shot_idx === idxRaw) idx = idx + 1;
        if (!Number.isFinite(idx) || idx <= 0) return;
        const entry = ensure(idx);
        if (!entry) return;
        if (!entry.pose && snap?.metrics && typeof snap.metrics === 'object') entry.pose = snap.metrics;
        if (!entry.poseSource && snap?.via) entry.poseSource = snap.via;
      });
    }

    return map;
  };

  const renderShots = (payload) => {
    if (!shotsWrap) return;

    lastClipsPayload = payload;

    if (!payload || !Array.isArray(payload.clips) || !payload.clips.length) {
      shotsWrap.className = 'shots-empty';
      shotsWrap.textContent = activeSid ? 'Waiting for clips...' : 'No clips yet.';
      if (shotsMeta) shotsMeta.textContent = '0';
      return;
    }

    const totals = payload.totals || cachedDebug?.sessionFile?.totals || {};
    const shotMeta = collectShotMeta();
    const shotRows = [];
    const shotResults = [];

    const deriveShotIdx = (clip, fallback) => {
      const candidates = [];
      if (clip.displayIdx != null) candidates.push(clip.displayIdx);
      if (clip.idx != null) {
        const idxNum = Number(clip.idx);
        if (Number.isFinite(idxNum)) candidates.push(idxNum > 0 ? idxNum : idxNum + 1);
      }
      if (clip.id != null) candidates.push(clip.id);
      if (clip.shotIndex != null) candidates.push(clip.shotIndex);
      const label = clip.name || clip.label || clip.url || clip.href || '';
      const match = label.match(/shot[-_]?([0-9]+)/i);
      if (match) candidates.push(Number(match[1]));
      for (const candidate of candidates) {
        const num = Number(candidate);
        if (Number.isFinite(num) && num > 0) return Math.round(num);
      }
      return fallback;
    };

    payload.clips.forEach((clip, index) => {
      const shotIdx = deriveShotIdx(clip, index + 1);
      const meta = shotMeta.get(shotIdx) || {};

      const resultValue = meta.result ?? clip.result;
      shotResults.push({ idx: shotIdx, result: resultValue });
      const pillHtml = resultPill(resultValue);

      const metricsSource = meta.poseMetrics || meta.pose || clip.poseMetrics || clip.pose;
      const summaryLine = meta.summary || clip.poseSummary || '';
      const metricsFallback = !summaryLine ? buildPoseSummary(metricsSource) : '';
      const summaryDisplay = summaryLine || metricsFallback || '';
      const summaryHtml = summaryDisplay ? escapeHtml(summaryDisplay) : '';
      const summaryTitle = summaryDisplay ? escapeHtml(summaryDisplay) : '';
      const sourceLabel = meta.summarySource || meta.poseSource || clip.poseSource || (summaryLine ? 'AI' : '');
      const sourceTextRaw = sourceLabel ? String(sourceLabel).toUpperCase() : '';
      const sourceHtml = sourceTextRaw ? ` <span class="pose-source">[${escapeHtml(sourceTextRaw)}]</span>` : '';
      const extraText = meta.extraText || clip.poseText || '';
      const extraHtml = extraText ? `<div class="pose-text">${escapeHtml(extraText)}</div>` : '';

      const poseCell = summaryHtml
        ? `<div class="pose-line" title="${summaryTitle}">${summaryHtml}</div>${sourceHtml}${extraHtml}`
        : (extraHtml || '--');

      const saved = fmtTime(clip.created);
      const size = fmtSize(clip.size);

      const linkText = clip.label || clip.name || `shot-${shotIdx}`;
      const linkUrl = clip.url || clip.href || '#';
      const hasUrl = Boolean(clip.url || clip.href);
      const linkHtml = hasUrl
        ? `<a class="clip-link" href="${linkUrl}" target="_blank" rel="noopener">${escapeHtml(linkText)}</a>`
        : `<span class="clip-link clip-link-disabled">${escapeHtml(linkText)}</span>`;

      shotRows.push(`
        <tr>
          <td>${shotIdx}</td>
          <td>${pillHtml}</td>
          <td>${linkHtml}</td>
          <td>${poseCell}</td>
          <td>${saved}</td>
          <td>${size}</td>
        </tr>`);
    });

    shotsWrap.className = '';
    shotsWrap.innerHTML = `
      <table class='shots-table'>
        <thead><tr><th>#</th><th>Result</th><th>Clip</th><th>Pose Highlights</th><th>Saved</th><th>Size</th></tr></thead>
        <tbody>${shotRows.join('')}</tbody>
      </table>`;

    if (shotsMeta) {
      const attempts = Number.isFinite(totals.attempts) && totals.attempts > 0 ? totals.attempts : shotResults.length;
      const made = Number.isFinite(totals.made)
        ? totals.made
        : shotResults.filter(({ result }) => isMadeResult(result)).length;
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
      if (lastClipsPayload && Array.isArray(lastClipsPayload.clips) && lastClipsPayload.clips.length) {
        renderShots(lastClipsPayload);
      }
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
    lastClipsPayload = null;
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

