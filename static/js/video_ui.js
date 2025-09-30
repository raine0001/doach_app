// static/js/arc_mm.js
// Orchestrates per-clip FBF analysis using existing analyzer + trackers,
// composites overlay on top of the video frame-by-frame, and records a final clip.

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

  // Ensure CORS-safe drawing if media is same-origin or CORS-enabled
  try { ui.video.crossOrigin = 'anonymous'; } catch {}

  // ---------- helpers ----------
  function waitFor(el, evt) {
    return new Promise(res => el.addEventListener(evt, res, { once: true }));
  }

  async function waitForVideoMeta(v) {
    if (v.readyState >= 1 && v.videoWidth && v.videoHeight) return;
    await waitFor(v, 'loadedmetadata');
  }

  function syncSizes() {
    const vw = ui.video.videoWidth || 0;
    const vh = ui.video.videoHeight || 0;
    if (!vw || !vh) return;
    [ui.overlay, ui.exportCan].forEach(c => {
      if (c.width !== vw || c.height !== vh) {
        c.width = vw; c.height = vh;
      }
      // Keep CSS sized to video element box if you’re showing canvases
      if (c.style) c.style.objectFit = 'contain';
    });
  }

  function compositeFrame() {
    try {
      const ctx = ui.exportCan.getContext('2d');
      ctx.clearRect(0, 0, ui.exportCan.width, ui.exportCan.height);
      ctx.drawImage(ui.video, 0, 0, ui.exportCan.width, ui.exportCan.height);
      ctx.drawImage(ui.overlay, 0, 0, ui.exportCan.width, ui.exportCan.height);
    } catch {}
  }

  function pickMime() {
    const prefs = [
      'video/webm;codecs=vp8', // best cross-platform in browsers; Windows player tolerates it more than VP9
      'video/webm'
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
        const blob = new Blob(chunks, { type: mime || 'video/webm' });
        console.log('[arc_mm] recorded bytes:', chunks.reduce((n, c) => n + c.size, 0));
        resolve(blob);
      };
    });
    rec.start(100); // collect chunks every 100ms
    return { rec, done };
  }

  function setRowStatus(id, text) {
    const row = document.querySelector(`[data-shot="${id}"] .status`);
    if (row) row.textContent = text;
  }

  // ---------- core ----------
  async function processClip({ id, url }) {
    // Reset globals the same way the main app does
    try { window.stopFrameAnalysis?.(); } catch {}
    try { window.resetAll?.(); } catch {}
    try { window.shotArc?.resetShotFSM?.(); } catch {}

    setRowStatus(id, 'prepping…');

    // Prime media
    ui.video.srcObject = null;
    ui.video.removeAttribute('src'); // avoid stale state in some browsers
    ui.video.src = url;
    await waitForVideoMeta(ui.video);
    syncSizes();
    compositeFrame(); // paint once so the canvas isn’t empty
    ui.video.pause(); // we analyze FBF; no autoplay needed

    // Auto-lock hoop once if not already locked
    if (!getLockedHoopBox?.()) {
      try {
        const lf = window.lastDetectedFrame || { objects: [] };
        autoDetectHoop(lf.objects, ui.overlay, true);
      } catch {}
    }

    // Start recording
    const { rec, done } = startRecorder();

    // Composite each analyzer frame into export canvas
    const onAnalyzerFrame = () => compositeFrame();
    window.addEventListener('analyzer:frame-done', onAnalyzerFrame);

    // Finish handler
    const result = { made: null, summary: null, arc: null, blob: null };
    let finished = false;

    const finishNow = async why => {
      if (finished) return;
      finished = true;
      try { rec.requestData?.(); rec.stop(); } catch {}
      window.removeEventListener('analyzer:frame-done', onAnalyzerFrame);
      result.blob = await done;

      // Pull metrics consistent with existing app
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

      // Debug: downloadable file for manual inspection
      try {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(result.blob);
        a.download = `shot_${id}_overlay.webm`;
        a.textContent = 'Download result';
        const rowEl = document.querySelector(`[data-shot="${id}"]`);
        rowEl?.appendChild(document.createTextNode(' · '));
        rowEl?.appendChild(a);
      } catch {}

      // Update UI status
      setRowStatus(id, `✓ ${result.made === true ? 'MAKE' : result.made === false ? 'MISS' : '—'}`);

      // Notify outer pages (e.g., My Sessions) if they care
      try { window.dispatchEvent(new CustomEvent('arcmm:done', { detail: { shotId: id, result } })); } catch {}

      // TODO: POST to backend if desired:
      // await uploadFinal({ id, blob: result.blob, metrics: { made: result.made, summary: result.summary, arc: result.arc } });
    };

    // Hooks from analyzer/scorer
    window.addEventListener('shot:summary', () => finishNow('summary'), { once: true });
    window.addEventListener('shot:end', () => finishNow('end'), { once: true });

    // Kick FBF analysis: analyzer handles stepping and events until end/summary
    try {
      analyzeVideoFrameByFrame(ui.video, ui.overlay);
      await runShotFBF();
    } catch (e) {
      console.warn('[arc_mm] analyzer error', e);
      await finishNow('error');
    }
  }

  async function boot() {
    const shots = window.__DEMO_SHOTS || []; // [{id, url}, ...]
    ui.list.innerHTML = shots.map(s => `
      <div class="shot" data-shot="${s.id}">
        <button class="go" data-id="${s.id}">Process</button>
        <span class="status">waiting…</span>
        <span class="name">${(s.url || '').split('/').pop()}</span>
      </div>
    `).join('');

    ui.list.addEventListener('click', async e => {
      const b = e.target.closest('button.go'); if (!b) return;
      const id = b.dataset.id;
      const shot = shots.find(x => String(x.id) === String(id));
      b.disabled = true;
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
