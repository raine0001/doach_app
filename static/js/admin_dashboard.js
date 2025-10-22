(() => {



  const sessionsList = document.getElementById('sessionsList');



  if (!sessionsList) return;







  const filterInput = document.getElementById('filterTxt');



  const btnRefresh = document.getElementById('btnRefresh');



  const dbgJson = document.getElementById('dbg-json');



  const sessionLabel = document.getElementById('dbg-session-label');



  const shotsWrap = document.querySelector('.shots-wrap');



  const shotsTableWrap = document.getElementById('shotsTableWrap');



  const shotsMeta = document.getElementById('shotsMeta');



  const btnObserve = document.getElementById('dbg-open-observe');



  const btnOpenJson = document.getElementById('dbg-open-json');



  const btnDownload = document.getElementById('adm-dbg-download');



  const btnCopy = document.getElementById('dbg-copy');



  const supportThreadBox = document.getElementById('supportThreadBox');



  const supportStatusLabel = document.getElementById('supportStatusLabel');



  const supportTicketTags = document.getElementById('supportTicketTags');



  const supportReplyInput = document.getElementById('supportReplyInput');



  const supportReplySend = document.getElementById('supportReplySend');

  const supportResolveBtn = document.getElementById('supportResolveBtn');

  const supportRefreshBtn = document.getElementById('supportRefreshBtn');

  const challengeListEl = document.getElementById('challengeList');

  const challengeForm = document.getElementById('challengeForm');

  const challengeStatusEl = document.getElementById('challengeStatus');

  const challengeSaveBtn = document.getElementById('challengeSaveBtn');

  const challengeDeleteBtn = document.getElementById('challengeDeleteBtn');

  const challengeNewBtn = document.getElementById('challengeNewBtn');

  const challengeInputs = challengeForm ? {

    slug: document.getElementById('challengeSlug'),

    name: document.getElementById('challengeName'),

    start: document.getElementById('challengeStart'),

    end: document.getElementById('challengeEnd'),

    daily: document.getElementById('challengeDailyLimit'),

    minimum: document.getElementById('challengeMinShots'),

    tz: document.getElementById('challengeTz'),

  } : null;










  let sessions = [];



  let activeSid = null;



  let cachedDebug = null;



  let clipTimer = null;



  let debugTimer = null;



  let lastClipsPayload = null;



  let supportTickets = [];



  let supportInteractions = [];



  let supportMap = new Map();



  let supportLoading = false;
  let challenges = [];



  let activeChallengeId = null;










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







  const ARCMM_STATUS_LABELS = {



    complete: 'Complete',



    processing: 'Processing',



    queued: 'Queued',



    waiting_clip: 'Waiting Clip',



    missing_clip: 'Missing Clip',



    error: 'Error',



    skipped: 'Skipped',



  };







  const arcmmClassForStatus = (status) => {



    switch (status) {



      case 'complete': return 'ok';



      case 'processing':



      case 'queued':



      case 'waiting_clip':



        return 'pending';



      case 'missing_clip':



      case 'error':



        return 'bad';



      case 'skipped':



        return 'muted';



      default:



        return 'pending';



    }



  };







  const OPEN_TICKET_STATUSES = new Set(['open', 'in_progress', 'waiting_user']);



  const CLOSED_TICKET_STATUSES = new Set(['resolved', 'closed']);



  const PENDING_INTERACTION_STATUSES = new Set(['pending_user', 'needs_ticket', 'failed', 'in_progress']);







  const normalizeStatus = (value) => String(value || '').toLowerCase();







  const ensureSupportEntry = (sid) => {



    if (!sid) return null;



    const key = String(sid);



    if (!supportMap.has(key)) {



      supportMap.set(key, {



        sid: key,



        tickets: [],



        interactions: [],



        openTicket: null,



        hasPending: false,



      });



    }



    return supportMap.get(key);



  };







  const getSupportEntry = (sid) => {



    if (!sid) return null;



    return supportMap.get(String(sid)) || null;



  };







  const buildSupportIndicator = (sid) => {



    const entry = getSupportEntry(sid);



    if (!entry) return '';



    if (entry.openTicket) return '<span class="support-flag support-flag-ticket" title="Open support ticket"></span>';



    if (entry.hasPending) return '<span class="support-flag support-flag-pending" title="Pending support follow-up"></span>';



    return '';



  };







  const renderArcmmStatusCell = (arcmmRaw, meta = {}, clip = {}) => {



    const arcmm = (arcmmRaw && typeof arcmmRaw === 'object') ? arcmmRaw : {};



    let status = typeof arcmm.status === 'string' ? arcmm.status.toLowerCase() : '';



    if (!status) {



      if (clip?.processedUrl || arcmm?.processed_clip) status = 'complete';



      else if (arcmm?.summary || meta?.arcmmSummary) status = 'complete';



    }



    const label = ARCMM_STATUS_LABELS[status] || (status ? status.replace(/_/g, ' ') : 'Pending');



    const pillClass = `arcmm-pill ${arcmmClassForStatus(status)}`;







    const sections = [];



    sections.push(`<div class="arcmm-line arcmm-status-line"><span class="${pillClass}">${escapeHtml(label)}</span></div>`);







    const summary =



      (arcmm.summary && typeof arcmm.summary === 'object' ? arcmm.summary : null)



      || (clip.summary && typeof clip.summary === 'object' ? clip.summary : null)



      || (meta.arcmmSummary && typeof meta.arcmmSummary === 'object' ? meta.arcmmSummary : null);







    const madeVal = summary && typeof summary.made === 'boolean'



      ? summary.made



      : (typeof arcmm.made === 'boolean' ? arcmm.made : (typeof meta.result === 'boolean' ? meta.result : null));







    const metricsParts = [];



    if (typeof madeVal === 'boolean') metricsParts.push(madeVal ? 'MAKE' : 'MISS');







    const releaseAngle = summary?.releaseAngle ?? arcmm.releaseAngle ?? meta?.releaseAngle;



    if (Number.isFinite(releaseAngle)) metricsParts.push(`Release ${Math.round(releaseAngle)} deg`);







    const entryAngle = summary?.entryAngle ?? arcmm.entryAngle ?? meta?.entryAngle;



    if (Number.isFinite(entryAngle)) metricsParts.push(`Entry ${Math.round(entryAngle)} deg`);







    const arcHeight = summary?.arcHeight ?? arcmm.arcHeight ?? meta?.arcHeight;



    if (Number.isFinite(arcHeight)) metricsParts.push(`Arc ${Math.round(arcHeight)} in`);







    if (summary?.apexHeight != null && Number.isFinite(summary.apexHeight)) {



      metricsParts.push(`Apex ${Math.round(summary.apexHeight)} in`);



    }







    if (metricsParts.length) {



      sections.push(`<div class="arcmm-line arcmm-metrics">${metricsParts.map((v) => escapeHtml(v)).join(' | ')}</div>`);



    }







    const processedUrl = clip?.processedUrl || arcmm.processed_clip;



    if (processedUrl) {



      sections.push(`<div class="arcmm-line"><a class="arcmm-overlay-link" href="${processedUrl}" target="_blank" rel="noopener">Processed overlay</a></div>`);



    }







    const messageRaw = arcmm.message || meta.arcmmMessage || clip.arcmmMessage;



    if (messageRaw) {



      const lines = String(messageRaw).split(/\r?\n/).map((ln) => ln.trim()).filter(Boolean);



      const snippet = lines.slice(0, 2).join(' ');



      const text = snippet || String(messageRaw).trim();



      const truncated = text.length > 220 ? `${text.slice(0, 217)}…` : text;



      sections.push(`<div class="arcmm-line arcmm-message">${escapeHtml(truncated)}</div>`);



    }







    const updated = arcmm.updated_at;



    const updatedDisplay = updated ? fmtTime(updated) : null;



    if (updatedDisplay && updatedDisplay !== '--') {



      sections.push(`<div class="arcmm-line arcmm-updated">Updated ${escapeHtml(updatedDisplay)}</div>`);



    }







    if (sections.length === 0) {



      return '<div class="arcmm-status muted">Awaiting processing</div>';



    }







    return `<div class="arcmm-status">${sections.join('')}</div>`;



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















  const resultPill = (result, overrideInfo = null) => {



    let cls = 'pending';



    let text = 'pending';



    if (isMadeResult(result)) { cls = 'make'; text = 'make'; }



    else if (result === false || result === 'miss') { cls = 'miss'; text = 'miss'; }



    let titleAttr = '';



    if (overrideInfo && typeof overrideInfo === 'object') {



      cls += ' manual';



      text = `${text}*`;



      const parts = [];



      if (overrideInfo.by) parts.push(`by ${overrideInfo.by}`);



      if (overrideInfo.updated_at) {



        const when = fmtDate(overrideInfo.updated_at);



        if (when) parts.push(when);



      }



      if (overrideInfo.reason) parts.push(`reason: ${overrideInfo.reason}`);



      if (parts.length) titleAttr = ` title="${escapeHtml(parts.join(' | '))}"`;



    }



    return `<span class="shots-pill ${cls}"${titleAttr}>${text}</span>`;



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







  const loadSupportMetadata = async (force = false) => {



    if (supportLoading) return;



    if (!force && supportMap.size) return;



    supportLoading = true;



    try {



      const [ticketsRes, historyRes] = await Promise.all([



        fetch('/api/support/tickets?scope=all', { credentials: 'include' }),



        fetch('/api/support/history?scope=all&limit=600', { credentials: 'include' }),



      ]);







      if (!ticketsRes.ok) throw new Error(`tickets ${ticketsRes.status}`);



      if (!historyRes.ok) throw new Error(`history ${historyRes.status}`);







      const ticketsPayload = await ticketsRes.json();



      const historyPayload = await historyRes.json();



      supportTickets = Array.isArray(ticketsPayload?.tickets) ? ticketsPayload.tickets : [];



      supportInteractions = Array.isArray(historyPayload?.interactions) ? historyPayload.interactions : [];







      supportMap = new Map();







      supportTickets.forEach((ticket) => {



        const sid = ticket?.session_id || ticket?.meta?.session_id || ticket?.meta?.sessionId;



        if (!sid) return;



        const entry = ensureSupportEntry(sid);



        entry.tickets.push(ticket);



        const status = normalizeStatus(ticket.status);



        if (OPEN_TICKET_STATUSES.has(status) && !entry.openTicket) {



          entry.openTicket = ticket;



        }



      });







      supportInteractions.forEach((interaction) => {



        const sid = interaction?.session_id || interaction?.meta?.session_id || interaction?.meta?.sessionId;



        if (!sid) return;



        const entry = ensureSupportEntry(sid);



        entry.interactions.push(interaction);



        const status = normalizeStatus(interaction.result_status);



        if (interaction.role !== 'doach' && interaction.role !== 'admin' && status && PENDING_INTERACTION_STATUSES.has(status)) {



          entry.hasPending = true;



        }



      });







      supportMap.forEach((entry) => {



        entry.interactions.sort((a, b) => {



          const ta = parseTimestampValue(a?.created_at || a?.time || 0);



          const tb = parseTimestampValue(b?.created_at || b?.time || 0);



          return ta - tb;



        });



      });







      renderSessions();



      if (activeSid) renderSupportThreadForSession(activeSid);



    } catch (err) {



      console.error('[admin] support metadata load failed', err);



    } finally {



      supportLoading = false;



      updateSupportControls(getSupportEntry(activeSid));



    }



  };







  const updateSupportControls = (entry) => {



    if (!supportReplyInput || !supportReplySend || !supportResolveBtn) return;



    const hasSession = !!activeSid;



    supportReplyInput.disabled = !hasSession;



    const value = (supportReplyInput.value || '').trim();



    supportReplySend.disabled = !hasSession || !value;



    supportResolveBtn.disabled = !hasSession || !(entry && entry.openTicket);



  };







  const renderSupportThreadForSession = (sid) => {



    if (!supportThreadBox || !supportStatusLabel || !supportTicketTags) return;



    supportThreadBox.innerHTML = '';



    supportTicketTags.innerHTML = '';







    if (!sid) {



      supportThreadBox.innerHTML = '<div class="support-empty">No session selected.</div>';



      supportStatusLabel.textContent = 'Select a session to view support history.';



      updateSupportControls(null);



      return;



    }







    const entry = getSupportEntry(sid);



    if (supportReplyInput) supportReplyInput.value = '';







    if (!entry) {



      supportThreadBox.innerHTML = '<div class="support-empty">No support history for this session yet.</div>';



      supportStatusLabel.textContent = 'No pending support items.';



      updateSupportControls(null);



      return;



    }







    if (entry.tickets.length) {



      entry.tickets.forEach((ticket) => {



        const tag = document.createElement('span');



        tag.className = 'support-tag';



        tag.textContent = `Ticket #${ticket.id} · ${ticket.status}`;



        supportTicketTags.appendChild(tag);



      });



    }







    if (!entry.interactions.length) {



      supportThreadBox.innerHTML = '<div class="support-empty">No support history for this session yet.</div>';



    } else {



      const frag = document.createDocumentFragment();



      entry.interactions.forEach((msg) => {



        const bubble = document.createElement('div');



        const role = String(msg.role || '').toLowerCase();



        bubble.className = `support-msg ${role}`;



        bubble.innerHTML = `${escapeHtml(msg.message || '')}`;



        const metaParts = [];



        if (msg.created_at) metaParts.push(fmtDate(msg.created_at));



        if (msg.role) metaParts.push(role);



        if (msg.result_status && msg.result_status !== 'resolved') metaParts.push(msg.result_status);



        if (msg.related_ticket_id) metaParts.push(`ticket #${msg.related_ticket_id}`);



        if (metaParts.length) {



          const meta = document.createElement('span');



          meta.className = 'meta';



          meta.textContent = metaParts.join(' · ');



          bubble.appendChild(meta);



        }



        frag.appendChild(bubble);



      });



      supportThreadBox.appendChild(frag);



      supportThreadBox.scrollTop = supportThreadBox.scrollHeight;



    }







    if (entry.openTicket) {



      supportStatusLabel.textContent = `Open ticket #${entry.openTicket.id} (${entry.openTicket.status})`;



    } else if (entry.hasPending) {



      supportStatusLabel.textContent = 'Pending support items awaiting follow-up.';



    } else {



      supportStatusLabel.textContent = 'No pending support items.';



    }







    updateSupportControls(entry);



  };







  const sendSupportReply = async () => {



    if (!supportReplyInput || !supportReplySend || !activeSid) return;



    const message = (supportReplyInput.value || '').trim();



    if (!message) return;



    const entry = getSupportEntry(activeSid);



    try {



      supportReplySend.disabled = true;



      const payload = {



        message,



        role: 'admin',



        session_id: activeSid,



      };



      if (entry?.openTicket) payload.related_ticket_id = entry.openTicket.id;







      const res = await fetch('/api/support/ingest', {



        method: 'POST',



        headers: { 'Content-Type': 'application/json' },



        credentials: 'include',



        body: JSON.stringify(payload),



      });



      if (!res.ok) throw new Error(`HTTP ${res.status}`);



      supportReplyInput.value = '';



      await loadSupportMetadata(true);



      renderSupportThreadForSession(activeSid);



    } catch (err) {



      console.error('[admin] support reply failed', err);



      supportStatusLabel.textContent = `Reply failed: ${err.message || err}`;



    } finally {



      updateSupportControls(getSupportEntry(activeSid));



    }



  };







  const resolveSupportTicket = async () => {



    const entry = getSupportEntry(activeSid);



    if (!entry || !entry.openTicket) return;



    const ticketId = entry.openTicket.id;



    try {



      supportResolveBtn.disabled = true;



      const res = await fetch(`/api/support/tickets/${encodeURIComponent(ticketId)}`, {



        method: 'PATCH',



        headers: { 'Content-Type': 'application/json' },



        credentials: 'include',



        body: JSON.stringify({ status: 'resolved' }),



      });



      if (!res.ok) throw new Error(`HTTP ${res.status}`);



      await loadSupportMetadata(true);



      renderSupportThreadForSession(activeSid);



    } catch (err) {



      console.error('[admin] resolve ticket failed', err);



      supportStatusLabel.textContent = `Resolve failed: ${err.message || err}`;



    } finally {



      updateSupportControls(getSupportEntry(activeSid));



    }



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



      const supportEntry = getSupportEntry(sid);



      if (supportEntry?.openTicket) row.classList.add('row-support-open');



      else if (supportEntry?.hasPending) row.classList.add('row-support-pending');







      const liveBadge = session.live ? '<span class="pill pill-live">LIVE</span>' : '';



      const supportBadge = buildSupportIndicator(sid);



      const statusBadges = [supportBadge, liveBadge].filter(Boolean).join(' ');







      row.innerHTML = `



        <div class="session-main">



          <div><strong>${escapeHtml(sid)}</strong> ${statusBadges}</div>



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



        if (!entry.adminOverride && shot?.adminOverride) entry.adminOverride = shot.adminOverride;



        if (shot?.arcmm && typeof shot.arcmm === 'object') {



          entry.arcmm = { ...(entry.arcmm || {}), ...shot.arcmm };



          if (shot.arcmm.summary && typeof shot.arcmm.summary === 'object') {



            entry.arcmmSummary = shot.arcmm.summary;



            if (typeof shot.arcmm.summary.made === 'boolean') entry.result = shot.arcmm.summary.made;



            if (Number.isFinite(shot.arcmm.summary.arcHeight) && entry.arcHeight == null) entry.arcHeight = shot.arcmm.summary.arcHeight;



            if (Number.isFinite(shot.arcmm.summary.entryAngle) && entry.entryAngle == null) entry.entryAngle = shot.arcmm.summary.entryAngle;



            if (Number.isFinite(shot.arcmm.summary.releaseAngle) && entry.releaseAngle == null) entry.releaseAngle = shot.arcmm.summary.releaseAngle;



          }



          if (shot.arcmm.status && !entry.arcmmStatus) entry.arcmmStatus = shot.arcmm.status;



          if (shot.arcmm.message && !entry.arcmmMessage) entry.arcmmMessage = shot.arcmm.message;



        }



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



        if (!entry.adminOverride && shot.adminOverride) entry.adminOverride = shot.adminOverride;



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







  async function handleShotToggleClick(event) {



    event.preventDefault();



    const btn = event.currentTarget;



    if (!btn || !activeSid) return;



    const idx = Number(btn.dataset.idx);



    if (!Number.isFinite(idx) || idx <= 0) return;



    const current = btn.dataset.current === 'true';



    const next = current ? false : true;



    let reason;



    if (!next) {



      const input = window.prompt('Reason for marking as miss? (optional)', '');



      if (input != null) {



        const trimmed = input.trim();



        if (trimmed) reason = trimmed;



      }



    }



    clearTimers();



    const originalText = btn.textContent;



    let success = false;



    btn.disabled = true;



    btn.textContent = 'Saving...';



    try {



      const body = reason ? { made: next, reason } : { made: next };



      const res = await fetch(`/admin/session/${encodeURIComponent(activeSid)}/shot/${idx}/result`, {



        method: 'POST',



        headers: { 'Content-Type': 'application/json' },



        body: JSON.stringify(body)



      });



      if (!res.ok) throw new Error(`HTTP ${res.status}`);



      const resJson = await res.json().catch(() => null);



      if (resJson?.totals && shotsMeta) {



        const attempts = Number(resJson.totals.attempts);



        const made = Number(resJson.totals.made);



        if (Number.isFinite(attempts) && Number.isFinite(made)) {



          shotsMeta.textContent = `${made} of ${attempts} made`;



        }



      }



      await loadClips(activeSid, { silent: false });



      await loadDebug(activeSid, { silent: true });



      success = true;



    } catch (err) {



      console.error('[admin] shot override failed', err);



      alert(`Failed to update shot ${idx}: ${err.message || err}`);



    } finally {



      if (!success && btn.isConnected) {



        btn.disabled = false;



        btn.textContent = originalText;



      }



    }



  }







  const renderShots = (payload) => {



    if (!shotsWrap || !shotsTableWrap) return;







    lastClipsPayload = payload;







    const showMessage = (message) => {



      shotsWrap.className = 'shots-wrap';



      shotsTableWrap.className = 'shots-table-wrap shots-empty';



      shotsTableWrap.textContent = message;



    };







    if (!payload || !Array.isArray(payload.clips) || !payload.clips.length) {



      showMessage(activeSid ? 'Waiting for clips...' : 'No clips yet.');



      if (shotsMeta) shotsMeta.textContent = '0 of 0 made';



      return;



    }







    shotsWrap.className = 'shots-wrap';



    shotsTableWrap.className = 'shots-table-wrap';







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







      if (!meta.adminOverride && clip.adminOverride) meta.adminOverride = clip.adminOverride;







      const arcmmData = {



        ...(meta.arcmm || {}),



        ...(clip.arcmm && typeof clip.arcmm === 'object' ? clip.arcmm : {}),



      };



      if (!arcmmData.summary && meta.arcmmSummary && typeof meta.arcmmSummary === 'object') {



        arcmmData.summary = meta.arcmmSummary;



      }



      if (!arcmmData.summary && clip.summary && typeof clip.summary === 'object') {



        arcmmData.summary = clip.summary;



      }



      if (!arcmmData.processed_clip && clip.processedUrl) {



        arcmmData.processed_clip = clip.processedUrl;



      }



      if (!arcmmData.adminOverride && meta.adminOverride) {



        arcmmData.adminOverride = meta.adminOverride;



      }







      let resultValue = meta.result ?? clip.result;



      if (arcmmData.summary && typeof arcmmData.summary.made === 'boolean') {



        resultValue = arcmmData.summary.made;



      } else if (typeof arcmmData.made === 'boolean') {



        resultValue = arcmmData.made;



      }



      const overrideInfo = meta.adminOverride || clip.adminOverride || arcmmData.adminOverride || null;



      if (overrideInfo && typeof overrideInfo.made === 'boolean') {



        resultValue = overrideInfo.made;



      }







      shotResults.push({ idx: shotIdx, result: resultValue });



      meta.result = resultValue;



      const pillHtml = resultPill(resultValue, overrideInfo);







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







      const arcmmCell = renderArcmmStatusCell(arcmmData, meta, clip);



      const currentMade = isMadeResult(resultValue);



      const nextMade = currentMade ? false : true;



      const actionLabel = nextMade ? 'Mark Make' : 'Mark Miss';



      const overrideTimeRaw = overrideInfo?.updated_at;



      let overrideTime = '';



      if (overrideTimeRaw) {



        const timeCandidate = fmtTime(overrideTimeRaw);



        overrideTime = timeCandidate !== '--' ? timeCandidate : fmtDate(overrideTimeRaw);



      }



      const overrideNote = overrideInfo



        ? `<div class="override-note">Override ${escapeHtml(overrideInfo.by || 'admin')} &rarr; ${overrideInfo.made ? 'MAKE' : 'MISS'}${overrideTime ? ` @ ${escapeHtml(overrideTime)}` : ''}${overrideInfo.reason ? ` (${escapeHtml(overrideInfo.reason)})` : ''}</div>`



        : '';



      const actionsCell = `



        <div>



          <button class="shot-action-btn" data-idx="${shotIdx}" data-current="${currentMade ? 'true' : 'false'}">${escapeHtml(actionLabel)}</button>



          ${overrideNote}



        </div>`;







      shotRows.push(`



        <tr>



          <td>${shotIdx}</td>



          <td>${pillHtml}</td>



          <td>${linkHtml}</td>



          <td class="arcmm-cell">${arcmmCell}</td>



          <td>${poseCell}</td>



          <td>${saved}</td>



          <td>${size}</td>



          <td class="actions-cell">${actionsCell}</td>



        </tr>`);



    });







    shotsTableWrap.innerHTML = `



      <table class='shots-table'>



        <thead><tr><th>#</th><th>Result</th><th>Clip</th><th>ArcMM</th><th>Pose Highlights</th><th>Saved</th><th>Size</th><th>Actions</th></tr></thead>



        <tbody>${shotRows.join('')}</tbody>



      </table>`;







    shotsTableWrap.querySelectorAll('.shot-action-btn').forEach((btn) => {



      btn.addEventListener('click', handleShotToggleClick);



    });







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



    if (!silent && shotsWrap && shotsTableWrap) {



      shotsWrap.className = 'shots-wrap';



      shotsTableWrap.className = 'shots-table-wrap shots-empty';



      shotsTableWrap.textContent = 'Loading clips...';



      if (shotsMeta) shotsMeta.textContent = '--';



    }



    try {



      const res = await fetch(`/admin/session/${encodeURIComponent(sid)}/clips?ts=${Date.now()}`);



      if (!res.ok) throw new Error(`HTTP ${res.status}`);



      const data = await res.json();



      if (sid !== activeSid) return;



      renderShots(data);



    } catch (err) {



      if (!silent && shotsWrap && shotsTableWrap) {



        shotsWrap.className = 'shots-wrap';



        shotsTableWrap.className = 'shots-table-wrap shots-empty';



        shotsTableWrap.textContent = `Clip load failed: ${err.message || err}`;



        if (shotsMeta) shotsMeta.textContent = '--';



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



    renderSupportThreadForSession(sid);



  };







  const setChallengeStatus = (msg = '', isError = false) => {



    if (!challengeStatusEl) return;



    challengeStatusEl.textContent = msg || '';



    challengeStatusEl.style.color = isError ? '#f87171' : '#94a3b8';



  };



  const updateChallengeButtons = () => {



    if (!challengeSaveBtn) return;



    const slugVal = challengeInputs?.slug?.value?.trim() || '';



    const nameVal = challengeInputs?.name?.value?.trim() || '';



    challengeSaveBtn.disabled = !(slugVal && nameVal);



    if (challengeDeleteBtn) challengeDeleteBtn.disabled = !activeChallengeId;



  };



  const renderChallenges = () => {



    if (!challengeListEl) return;



    challengeListEl.innerHTML = '';



    if (!challenges.length) {



      challengeListEl.innerHTML = '<div class="muted" style="padding:8px;">No challenges defined.</div>';



      return;



    }



    const frag = document.createDocumentFragment();



    challenges.forEach((item) => {



      const row = document.createElement('div');



      row.className = 'challenge-row' + (item.id === activeChallengeId ? ' active' : '');



      const name = document.createElement('div');



      name.className = 'challenge-name';



      name.textContent = item.name || item.slug;



      const dates = document.createElement('div');



      dates.className = 'challenge-dates';



      const start = item.start_date || '';



      const end = item.end_date || '';



      if (start && end) dates.textContent = start + ' to ' + end;



      else dates.textContent = start || end || 'No dates';



      row.appendChild(name);



      row.appendChild(dates);



      row.addEventListener('click', () => setActiveChallenge(item.id));



      frag.appendChild(row);



    });



    challengeListEl.appendChild(frag);



  };



  const clearChallengeForm = () => {



    if (!challengeInputs) return;



    challengeInputs.slug.value = '';



    challengeInputs.name.value = '';



    challengeInputs.start.value = '';



    challengeInputs.end.value = '';



    challengeInputs.daily.value = '';



    challengeInputs.minimum.value = '';



    challengeInputs.tz.value = '';



    activeChallengeId = null;



    updateChallengeButtons();



    setChallengeStatus('');



    renderChallenges();



  };



  const setActiveChallenge = (id) => {



    if (!challengeInputs) return;



    const found = challenges.find((c) => c.id === id);



    if (!found) {



      clearChallengeForm();



      return;



    }



    activeChallengeId = found.id;



    challengeInputs.slug.value = found.slug || '';



    challengeInputs.name.value = found.name || '';



    challengeInputs.start.value = (found.start_date || '').slice(0, 10);



    challengeInputs.end.value = (found.end_date || '').slice(0, 10);



    challengeInputs.daily.value = found.daily_limit != null ? found.daily_limit : '';



    challengeInputs.minimum.value = found.min_shots != null ? found.min_shots : '';



    challengeInputs.tz.value = found.tz || '';



    updateChallengeButtons();



    setChallengeStatus('');



    renderChallenges();



  };



  const gatherChallengePayload = () => {



    if (!challengeInputs) return null;



    return {



      slug: (challengeInputs.slug.value || '').trim(),



      name: (challengeInputs.name.value || '').trim(),



      start_date: challengeInputs.start.value || null,



      end_date: challengeInputs.end.value || null,



      daily_limit: challengeInputs.daily.value !== '' ? Number(challengeInputs.daily.value) : null,



      min_shots: challengeInputs.minimum.value !== '' ? Number(challengeInputs.minimum.value) : null,



      tz: (challengeInputs.tz.value || '').trim(),



    };



  };



  const loadChallenges = async (force = false) => {

    if (!challengeListEl) return;

    if (!force && challenges.length) {

      renderChallenges();

      updateChallengeButtons();

      return;

    }

    challengeListEl.innerHTML = '<div class="muted" style="padding:8px;">Loading...</div>';

    try {

      const res = await fetch('/admin/events', { credentials: 'include' });

      if (!res.ok) throw new Error('http ' + res.status);

      const data = await res.json();

      challenges = Array.isArray(data?.events) ? data.events : [];

      if (activeChallengeId && !challenges.find((c) => c.id === activeChallengeId)) {

        activeChallengeId = null;

      }

      renderChallenges();

      if (activeChallengeId) setActiveChallenge(activeChallengeId);

      updateChallengeButtons();

      setChallengeStatus('');

    } catch (err) {

      setChallengeStatus('Failed to load challenges: ' + (err.message || err), true);

      challenges = [];

      renderChallenges();

    }

  };

  const saveChallenge = async () => {

    const payload = gatherChallengePayload();

    if (!payload) return;

    if (!payload.slug || !payload.name) {

      setChallengeStatus('Slug and name are required.', true);

      return;

    }

    const method = activeChallengeId ? 'PATCH' : 'POST';

    const url = activeChallengeId ? (`/admin/events/${activeChallengeId}`) : '/admin/events';

    try {

      const res = await fetch(url, {

        method,

        headers: { 'Content-Type': 'application/json' },

        credentials: 'include',

        body: JSON.stringify(payload),

      });

      if (!res.ok) {

        const msg = await res.text();

        throw new Error(msg || res.statusText);

      }

      const data = await res.json();

      if (data?.event?.id) activeChallengeId = data.event.id;

      setChallengeStatus('Challenge saved.');

      await loadChallenges(true);

      if (activeChallengeId) setActiveChallenge(activeChallengeId);

    } catch (err) {

      setChallengeStatus('Save failed: ' + (err.message || err), true);

    }

  };

  const deleteChallenge = async () => {

    if (!activeChallengeId) return;

    if (!confirm('Delete this challenge?')) return;

    try {

      const res = await fetch(`/admin/events/${activeChallengeId}`, {

        method: 'DELETE',

        credentials: 'include',

      });

      if (!res.ok) throw new Error('http ' + res.status);

      setChallengeStatus('Challenge deleted.');

      activeChallengeId = null;

      clearChallengeForm();

      await loadChallenges(true);

    } catch (err) {

      setChallengeStatus('Delete failed: ' + (err.message || err), true);

    }

  };

  if (challengeNewBtn) challengeNewBtn.addEventListener('click', () => {

    clearChallengeForm();

  });

  if (challengeSaveBtn) challengeSaveBtn.addEventListener('click', saveChallenge);

  if (challengeDeleteBtn) challengeDeleteBtn.addEventListener('click', deleteChallenge);

  if (challengeForm) challengeForm.addEventListener('input', updateChallengeButtons);

  updateChallengeButtons();

  if (challengeListEl) loadChallenges();

  if (supportReplyInput) supportReplyInput.addEventListener('input', () => updateSupportControls(getSupportEntry(activeSid)));



  if (supportReplySend) supportReplySend.addEventListener('click', sendSupportReply);



  if (supportResolveBtn) supportResolveBtn.addEventListener('click', resolveSupportTicket);



  if (supportRefreshBtn) supportRefreshBtn.addEventListener('click', () => loadSupportMetadata(true));







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



  if (btnRefresh) btnRefresh.addEventListener('click', () => { loadSessions(true); loadSupportMetadata(true); loadChallenges(true); });







  setButtonsEnabled(false);



  loadSessions();



  loadSupportMetadata();



  loadChallenges();



})();







