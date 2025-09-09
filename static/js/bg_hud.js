// bg_hud.js — small development HUD for the background FBF plane
// Shows: current frame, release frame, prox enter/exit frames, arc points, exit-y check

(function installBGHud(){
  if (window.__BG_HUD_INSTALLED) return; window.__BG_HUD_INSTALLED = true;

  function $(sel){ return document.querySelector(sel); }

  const hud = document.createElement('div');
  hud.id = 'bgHud';
  Object.assign(hud.style, {
    position: 'fixed', right: '12px', top: '12px', zIndex: 10060,
    background: 'rgba(0,0,0,0.70)', color: '#fff',
    font: '600 12px system-ui, sans-serif', padding: '8px 10px',
    borderRadius: '8px', pointerEvents: 'none', minWidth: '180px'
  });
  hud.innerHTML = [
    '<div>BG Plane</div>',
    '<div id="bg_f">f: -</div>',
    '<div id="bg_rel">release: -</div>',
    '<div id="bg_enter">enter: -</div>',
    '<div id="bg_exit">exit: -</div>',
    '<div id="bg_arc">arc pts: 0</div>',
    '<div id="bg_below">below ok: -</div>'
  ].join('');
  document.body.appendChild(hud);

  function canonHoopLocal(H){
    try { if (typeof window.canonHoop === 'function') return window.canonHoop(H); } catch {}
    if (!H) return null;
    const w = Math.max(1, H.w ?? H.width ?? ((H.x2??0)-(H.x1??0)));
    const h = Math.max(1, H.h ?? H.height ?? ((H.y2??0)-(H.y1??0)));
    const cx = Number.isFinite(H.cx) ? H.cx : (Number.isFinite(H.x) ? H.x + w/2 : 0);
    const cy = Number.isFinite(H.cy) ? H.cy : (Number.isFinite(H.y) ? H.y + h/2 : 0);
    return { cx, cy, w, h, rimTop: cy - h/2 };
  }

  function nowArcPoints(){
    try {
      const t = (window.ballArc && Array.isArray(window.ballArc.trail)) ? window.ballArc.trail : [];
      return t.length || 0;
    } catch { return 0; }
  }

  function exitBelowCheck(){
    try {
      const H = (window.getLockedHoopBox?.()) || null; if (!H) return '-';
      const C = canonHoopLocal(H); if (!C) return '-';
      const rimBottom = C.rimTop + C.h;
      const margin = Number(window.EXIT_BELOW_MARGIN || 12);
      const pts = (window.ballArc && Array.isArray(window.ballArc.trail)) ? window.ballArc.trail : [];
      if (!pts.length) return '-';
      const last = pts[pts.length - 1];
      const ok = (last && Number.isFinite(last.y)) ? (last.y > (rimBottom + margin)) : false;
      return ok ? 'yes' : 'no';
    } catch { return '-'; }
  }

  function text(id, v){ const el = document.getElementById(id); if (el) el.textContent = v; }

  function tick(){
    try {
      const f = (window.lastDetectedFrame && Number.isFinite(window.lastDetectedFrame.__frameIdx)) ? window.lastDetectedFrame.__frameIdx : '-';
      const bs = (window.ballState || {});
      text('bg_f',     `f: ${f}`);
      text('bg_rel',   `release: ${bs.releaseFrame ?? '-'}`);
      text('bg_enter', `enter: ${bs.proxEnterFrame ?? '-'}`);
      text('bg_exit',  `exit: ${bs.proxExitFrame ?? '-'}`);
      text('bg_arc',   `arc pts: ${nowArcPoints()}`);
      text('bg_below', `below ok: ${exitBelowCheck()}`);
    } catch {}
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
})();

