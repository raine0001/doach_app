// static/js/arc_mm.js
// FBF analysis -> overlay composite -> recorded clip (VP8) with inline preview

import { analyzeVideoFrameByFrame, runShotFBF } from '/static/js/analyzer.js';
import { getLockedHoopBox, autoDetectHoop } from '/static/js/hoop_tracker.js';

(function ArcMM() {
  const ui = {
    list: document.getElementById('shotList'),
    video: document.getElementById('mmVideo'),
    overlay: document.getElementById('overlay'),
    exportCan: document.getElementById('exportCanvas'),
    processAllBtn: document.getElementById('processAll')
  };

  try { ui.video.crossOrigin = 'anonymous'; } catch {}

  // ---------- helpers ----------
  function waitFor(el, evt) { return new Promise(res => el.addEventListener(evt, res, { once: true })); }

  async function waitForVideoMeta(v) {
    if (v.readyState >= 1 && v.videoWidth && v.videoHeight) return;
    await waitFor(v, 'loadedmetadata');
  }

  function syncSizes() {
    const vw = ui.video.videoWidth || 0;
    const vh = ui.video.videoHeight || 0;
    if (!vw || !vh) return;
    [ui.overlay, ui.exportCan].forEach(c => { c.width = vw; c.height = vh; });
  }

  function compositeFrame() {
    const w = ui.exportCan.width, h = ui.exportCan.height;
    if (!w || !h) return;
    const ctx = ui.exportCan.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(ui.video, 0, 0, w, h);
    ctx.drawImage(ui.overlay, 0, 0, w, h);
  }

  function pickMime() {
    const prefs = [
      'video/webm;codecs=vp8', // safest across browsers
      'video/webm'             // fallback
    ];
    return prefs.find(m => (window.MediaRecorder?.isTypeSupported?.(m))) || '';
  }

  function startRecorder() {
    const fps = Number(window.__videoFPS) || 30;
    const stream = ui.exportCan.captureStream(fps);
    const mime = pickMime();
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 4_000_000 });
    const chunks = [];
    rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    const done = new Promise(resolve => {
      rec.onstop = () => {
        const size = chunks.reduce((n, c) => n + c.size, 0);
        console.log('[arc_mm] recorded bytes:', size);
        resolve(new Blob(chunks, { type: mime || 'video/webm' }));
      };
    });
    rec.start(100); // gather chunks every 100ms
    return { rec, done, chunks };
  }

  function setRowStatus(id, text) {
    const el = document.querySelector(`[data-shot="${id}"] .status`);
    if (el) el.textContent = text;
  }

  function attachPreview(rowEl, blob, id) {
    try {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `shot_${id}_overlay.webm`; a.textContent = 'Download';
      const v = document.createElement('video');
      v.src = url; v.controls = true; v.muted = true; v.style.maxWidth = '420px'; v.style.display = 'block';
      rowEl.appendChild(document.createTextNode(' · '));
      rowEl.appendChild(a);
      rowEl.appendChild(document.createElement('br'));
      rowEl.appendChild(v);
    } catch {}
  }

  // ---------- core ----------
  async function processClip({ id, url }) {
    // Reset state like the main app
    try { window.stopFrameAnalysis?.(); } catch {}
    try { window.resetAll?.(); } catch {}
    try { window.shotArc?.resetShotFSM?.(); } catch {}

    setRowStatus(id, 'prepping…');

    // Load media
    ui.video.srcObject = null;
    ui.video.removeAttribute('src');
    ui.video.src = url;
    await waitForVideoMeta(ui.video);
    syncSizes();
    compositeFrame();
    ui.video.pause();

    // If no hoop, try once
    if (!getLockedHoopBox?.()) {
      try {
        const lf = window.lastDetectedFrame || { objects: [] };
        autoDetectHoop(lf.objects, ui.overlay, true);
      } catch {}
    }

    // Start recorder
    const { rec, done, chunks } = startRecorder();

    // 1) Composite when analyzer finishes a frame
    const onAnalyzerFrame = () => compositeFrame();
    window.addEventListener('analyzer:frame-done', onAnalyzerFrame);

    // 2) Also start a pump so we get frames even if analyzer sprints
    const fps = Number(window.__videoFPS) || 30;
    const pump = setInterval(compositeFrame, Math.max(16, Math.floor(1000 / fps)));

    const result = { made: null, summary: null, arc: null, blob: null };
    let finished = false;
    const startedAt = performance.now();

    async function finishNow(why) {
      if (finished) return;
      finished = true;

      clearInterval(pump);
      window.removeEventListener('analyzer:frame-done', onAnalyzerFrame);

      // Ensure we recorded at least a moment; otherwise some browsers give empty blobs
      const minMs = 300; // ~9 frames at 30fps
      const waitMs = Math.max(0, minMs - (performance.now() - startedAt));
      if (waitMs) await new Promise(r => setTimeout(r, waitMs));

      // Final composite + flush + stop
      compositeFrame();
      try { rec.requestData?.(); } catch {}
      try { rec.stop(); } catch {}

      result.blob = await done;

      // Pull metrics consistent with app
      try {
        result.summary = window.__lastSummary || (window.shotLog?.at?.(-1)) || null;
        result.made = (result.summary && (result.summary.made === true || result.summary.result === 'make')) ? true
                    : (result.summary && (result.summary.made === false || result.summary.result === 'miss')) ? false
                    : null;
      } catch {}
      try {
        const arc = window.ballArc || {};
        result.arc = {
          refinedTrail: arc.refinedTrail || arc.trail || [],
          releasePoint: arc.releasePoint || null,
          apexPoint: arc.apexPoint || null,
          rimCrossingPoint: arc.rimCrossingPoint || null
        };
      } catch {}

      // UI: status + preview + download
      const row = document.querySelector(`[data-shot="${id}"]`);
      setRowStatus(id, `✓ ${result.made === true ? 'MAKE' : result.made === false ? 'MISS' : '—'}`);
      attachPreview(row, result.blob, id);

      // Notify anyone listening (e.g., My Sessions)
      try { window.dispatchEvent(new CustomEvent('arcmm:done', { detail: { shotId: id, result } })); } catch {}

      // TODO: POST to backend if needed
      // await uploadFinal({ id, blob: result.blob, metrics: { made: result.made, summary: result.summary, arc: result.arc } });
    }

    window.addEventListener('shot:summary', () => finishNow('summary'), { once: true });
    window.addEventListener('shot:end', () => finishNow('end'), { once: true });

    try {
      analyzeVideoFrameByFrame(ui.video, ui.overlay);
      await runShotFBF();
    } catch (e) {
      console.warn('[arc_mm] analyzer error', e);
      await finishNow('error');
    }
  }

  async function boot() {
    const shots = window.__DEMO_SHOTS || [];
    ui.list.innerHTML = shots.map(s => `
      <div class="shot" data-shot="${s.id}">
        <button class="go" data-id="${s.id}">Process</button>
        <span class="status">waiting…</span>
        <span class="name">${(s.url || '').split('/').pop()}</span>
      </div>
    `).join('');

    ui.list.addEventListener('click', async e => {
      const b = e.target.closest('button.go'); if (!b) return;
      b.disabled = true;
      const id = b.dataset.id;
      const shot = (window.__DEMO_SHOTS || []).find(x => String(x.id) === String(id));
      await processClip(shot);
    });

    if (ui.processAllBtn) {
      ui.processAllBtn.onclick = async () => {
        for (const b of [...ui.list.querySelectorAll('button.go')]) {
          b.click();
          await new Promise(r => setTimeout(r, 200));
        }
      };
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
